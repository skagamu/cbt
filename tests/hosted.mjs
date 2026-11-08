import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const project = 'https://ynepxhlvpvlfuhcerydu.supabase.co';
const hash = value => createHash('sha256').update(value).digest('hex');

async function prepare(users, activeSeconds) {
  assert.ok([36, 350, 700].includes(users));
  assert.ok(Number.isInteger(activeSeconds) && (activeSeconds === 0 || activeSeconds >= 30) && activeSeconds <= 5400);
  const minutes = activeSeconds ? Math.ceil(activeSeconds / 60) + 1 : 2;
  const directory = await mkdtemp(join(tmpdir(), 'cbt-hosted-smoke.'));
  const prefix = `999${randomInt(100_000_000, 1_000_000_000)}`;
  const subject = randomUUID();
  // MD5 only generates deterministic, fixture-scoped identifiers. Credentials use SHA-256.
  const namespace = `cbt-synthetic-${subject}`;
  const uuidFor = (kind, i) => createHash('md5').update(`${namespace}-${kind}-${i}`).digest('hex')
    .replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
  const rows = Array.from({ length: users }, (_, i) => ({
    right: uuidFor('right', i + 1), identity: `${prefix}${String(i + 1).padStart(3, '0')}`,
    token: randomBytes(24).toString('base64url')
  }));
  const identifiers = `
    md5('${namespace}-student-'||i)::uuid AS student_id, md5('${namespace}-right-'||i)::uuid AS right_id,
    md5('${namespace}-exam-'||(10+(i-1)/280))::uuid AS exam_id,
    '${prefix}'||lpad(i::text,3,'0') AS nis,
    'UJI SINTETIS ${prefix}-'||(1+(i-1)/40) AS class_code, 10+(i-1)/280 AS grade_level
  `;
  const fixture = `SELECT i,${identifiers} FROM generate_series(1,${users}) i`;
  const exams = `SELECT DISTINCT exam_id FROM (${fixture}) f`;
  const setup = `
BEGIN;
SET LOCAL statement_timeout='20s';
INSERT INTO public.cbt_subjects(id,slug,name) VALUES ('${subject}','uji-${prefix}','Mapel sintetis ${prefix}');
INSERT INTO public.cbt_students(id,nis,full_name,class_code,grade_level)
SELECT student_id,nis,'Peserta sintetis '||nis,class_code,grade_level FROM (${fixture}) f;
INSERT INTO public.cbt_question_bank(question_code,subject_id,question_number,grade_scope,prompt,options,correct_option,review_status)
SELECT 'UJI-${prefix}-'||n, '${subject}', n, '10-12', 'Soal sintetis '||n||'?',
  '{"A":"Uji A","B":"Uji B","C":"Uji C","D":"Uji D"}','A','approved'
FROM generate_series(1,40) n;
INSERT INTO cbt_private.exams(id,subject_id,title,grade_level,classes,opens_at,closes_at,duration_minutes,status)
SELECT exam_id,'${subject}','Ujian sintetis ${prefix}',grade_level,array_agg(DISTINCT class_code),
  clock_timestamp()-interval '1 minute',clock_timestamp()+make_interval(mins=>${minutes + 8}),${minutes},'published'
FROM (${fixture}) f GROUP BY exam_id,grade_level;
INSERT INTO cbt_private.exam_questions(exam_id,position,question_id,prompt,options,correct_option)
SELECT e.exam_id, q.question_number,q.id,q.prompt,q.options,q.correct_option
FROM (${exams}) e CROSS JOIN public.cbt_question_bank q WHERE q.subject_id='${subject}';
INSERT INTO cbt_private.grading_keys(exam_id,version,position,correct_option)
SELECT exam_id,1,position,correct_option FROM cbt_private.exam_questions WHERE exam_id IN (${exams});
INSERT INTO cbt_private.rights(id,exam_id,student_id,token_hash,token_version,token_expires_at)
SELECT right_id,exam_id,student_id,substring(digests FROM (i-1)*32+1 FOR 32),1,
  clock_timestamp()+make_interval(mins=>${minutes + 18})
FROM (${fixture}) f CROSS JOIN (
  SELECT decode('${Buffer.from(rows.map(row => hash(row.token)).join(''), 'hex').toString('base64')}','base64') AS digests
) h;
COMMIT;
`;
  const verify = `
SELECT count(*) AS rights,count(a.receipt) AS submitted,count(DISTINCT a.receipt) AS unique_receipts,
  count(s.right_id) AS results,
  count(*) FILTER (WHERE a.answers->'1'->>'option'='A') AS confirmed_first_answers,
  count(*) FILTER (WHERE a.submit_reason='manual') AS manual,
  count(*) FILTER (WHERE a.submit_reason='timeout') AS timeout,
  round(max(extract(epoch FROM s.created_at-a.deadline)) FILTER (WHERE a.submit_reason='timeout'),3) AS max_timer_grade_seconds,
  pg_database_size(current_database()) AS database_bytes,
  (SELECT encode(extensions.digest(coalesce(string_agg(
      a2.right_id::text || ':' || answer.key || ':' || (answer.value->>'option') || ':' ||
      (answer.value->>'flagged') || ':' || (answer.value->>'revision'), '|' ORDER BY a2.right_id,answer.key::integer
    ), ''),'sha256'),'hex')
   FROM cbt_private.attempts a2 JOIN cbt_private.rights r2 ON r2.id=a2.right_id
   CROSS JOIN LATERAL jsonb_each(a2.answers) answer
   WHERE r2.exam_id IN (${exams})) AS final_answers_hash
FROM cbt_private.rights r
LEFT JOIN cbt_private.attempts a ON a.right_id=r.id
LEFT JOIN cbt_private.results s ON s.right_id=r.id AND s.version=1
WHERE r.exam_id IN (${exams});
`;
  const exactRights = `SELECT right_id FROM (${fixture}) f`;
  const exactStudents = `SELECT student_id FROM (${fixture}) f`;
  const cleanup = `
BEGIN;
SET LOCAL statement_timeout='20s';
DELETE FROM cbt_private.student_sessions WHERE right_id IN (${exactRights});
DELETE FROM cbt_private.results WHERE right_id IN (${exactRights});
DELETE FROM cbt_private.attempts WHERE right_id IN (${exactRights});
DELETE FROM cbt_private.rights WHERE id IN (${exactRights}) AND exam_id IN (${exams});
DELETE FROM cbt_private.grading_keys WHERE exam_id IN (${exams});
DELETE FROM cbt_private.exam_questions WHERE exam_id IN (${exams});
DELETE FROM cbt_private.exams WHERE id IN (${exams}) AND subject_id='${subject}';
DELETE FROM public.cbt_question_bank WHERE subject_id='${subject}';
DELETE FROM public.cbt_subjects WHERE id='${subject}' AND slug='uji-${prefix}';
DELETE FROM public.cbt_students WHERE id IN (${exactStudents}) AND class_code LIKE 'UJI SINTETIS ${prefix}-%';
DELETE FROM cbt_private.student_login_limits WHERE bucket IN (
  SELECT encode(extensions.digest(nis,'sha256'),'hex') FROM (${fixture}) f
);
COMMIT;
SELECT (SELECT count(*) FROM public.cbt_students WHERE id IN (${exactStudents})) AS synthetic_students_remaining,
  (SELECT count(*) FROM cbt_private.exams WHERE id IN (${exams})) AS synthetic_exams_remaining;
`;
  for (const [filename, content] of Object.entries({
    'prepare.sql': setup, 'verify.sql': verify, 'cleanup.sql': cleanup, 'manifest.json': JSON.stringify({ project, activeSeconds, rows })
  })) await writeFile(join(directory, filename), content, { mode: 0o600 });
  console.log(directory);
}

async function run(filename) {
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(manifest.project, project);
  const users = manifest.rows.length;
  const activeSeconds = manifest.activeSeconds ?? 0;
  assert.ok(Number.isInteger(activeSeconds) && activeSeconds >= 0 && activeSeconds <= 5400);
  assert.ok([36, 350, 700].includes(users));
  assert.ok(users === 36 || process.env.CBT_ALLOW_LARGER_HOSTED_LOAD === '1', 'Larger stages require coordinated confirmation');
  const socketLimit = Number(process.env.CBT_HOSTED_PARALLEL_REQUESTS ?? 48);
  assert.ok(Number.isInteger(socketLimit) && socketLimit >= 4 && socketLimit <= 100);
  let active = 0;
  const waiters = [];
  async function underLimit(action) {
    if (active >= socketLimit) await new Promise(resolve => waiters.push(resolve));
    else active += 1;
    try { return await action(); }
    finally {
      if (waiters.length) waiters.shift()();
      else active -= 1;
    }
  }
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  assert.ok(key?.startsWith('sb_publishable_'), 'Set a Supabase publishable key only');
  const metrics = new Map();
  let responseBytes = 0;
  let timerStart;
  let timerFinish;
  let finalAnswersHash;
  let terminalFailures = 0;
  const began = performance.now();
  const progress = activeSeconds >= 300 ? setInterval(() => {
    console.log(JSON.stringify({ progress: true, users,
      elapsed_s: Math.round((performance.now() - began) / 1000),
      autosaves: metrics.get('autosave')?.latency.length ?? 0,
      terminal_failures: terminalFailures, response_body_bytes_uncompressed: responseBytes }));
  }, 900_000) : null;
  const retryable = new Set([408, 425, 429, 500, 502, 503, 504, 'network']);
  async function rpc(label, name, params) {
    const record = metrics.get(label) ?? { latency: [], attempts: 0, errors: 0, retries: 0, terminal: 0, codes: {} };
    metrics.set(label, record);
    const started = performance.now();
    for (let n = 0; n < 2; n += 1) {
      record.attempts += 1;
      try {
        const response = await underLimit(() => fetch(`${project}/rest/v1/rpc/${name}`, {
          method: 'POST', headers: { apikey: key, 'content-type': 'application/json' },
          body: JSON.stringify(params), signal: AbortSignal.timeout(10_000), cache: 'no-store'
        }));
        const body = await response.text();
        responseBytes += Buffer.byteLength(body);
        if (!response.ok) throw Object.assign(new Error('RPC HTTP error'), { code: response.status });
        const data = JSON.parse(body);
        if (data?.ok !== true) throw Object.assign(new Error('RPC declined synthetic action'), { code: data?.code ?? 'application' });
        assert.doesNotMatch(body, /"(?:correct_option|correct_count|wrong_count|blank_count|token_hash|question_id)"\s*:/);
        record.latency.push(performance.now() - started);
        return data;
      } catch (error) {
        const code = error.code ?? (error.name === 'AssertionError' ? 'assertion' : 'network');
        record.errors += 1;
        record.codes[code] = (record.codes[code] ?? 0) + 1;
        if (n === 0 && retryable.has(code)) {
          record.retries += 1;
          await delay(100);
        } else {
          record.terminal += 1;
          terminalFailures += 1;
          throw new Error(`Hosted smoke operation failed (${label}, code ${code})`);
        }
      }
    }
  }
  let failure;
  try {
    const cohort = await Promise.allSettled(manifest.rows.map(async (row, i) => {
      assert.match(row.identity, /^999[0-9]{11,12}$/);
      const device = randomUUID();
      const entry = await rpc('login', 'cbt_student_login', { p_identity: row.identity, p_token: row.token, p_device: device });
      assert.equal(entry.right_id, row.right, 'student session resolved to another right');
      const call = (label, action, data) => rpc(label, 'cbt_student', {
        p_session: entry.session, p_action: action, p_data: { device, ...data }
      });
      const start = await call('read_40', 'start');
      assert.equal(start.status, 'active');
      assert.equal(start.questions.length, 40);
      const epoch = start.write_epoch;
      const answers = {};
      const activeUntil = performance.now() + activeSeconds * 1000;
      let revision = 0;
      do {
        const wait = randomInt(15_000, 30_001);
        if (activeSeconds && revision > 0 && performance.now() + wait >= activeUntil) break;
        await delay(wait);
        if (activeSeconds && (terminalFailures >= Math.max(5, users / 100) || responseBytes > 700_000_000)) {
          throw new Error('Hosted soak resource or error safety limit reached');
        }
        const position = revision % 40 + 1;
        const answer = { option: 'A', flagged: (i + revision) % 5 === 0, revision: ++revision };
        const save = await call('autosave', 'save', { epoch, answers: { [position]: answer } });
        assert.deepEqual(save.answers[position], answer);
        answers[position] = answer;
        if (i % 5 === 0 && (revision === 1 || (activeSeconds && revision % 80 === 0))) {
          const reconnect = await call('reconnect', 'state');
          assert.deepEqual(reconnect.answers, answers);
        }
      } while (activeSeconds);
      if (activeSeconds) await delay(Math.max(0, activeUntil - performance.now()));
      return { call, epoch, right: row.right, answers, deadline: new Date(start.deadline).getTime() };
    }));
    assert.equal(cohort.filter(item => item.status === 'rejected').length, 0, 'synthetic login, read or autosave failed');
    const complete = cohort.map(item => item.value);
    finalAnswersHash = hash([...complete].sort((a, b) => a.right < b.right ? -1 : a.right > b.right ? 1 : 0)
      .flatMap(({ right, answers }) => Object.entries(answers).map(([position, { option, flagged, revision }]) =>
        `${right}:${position}:${option}:${flagged}:${revision}`
      )).join('|'));
    const manual = await Promise.allSettled(complete.filter((_, i) => i % 2 === 0).map(async ({ call, epoch }) => {
      const payload = { epoch, answers: {} };
      const result = await call('submit', 'submit', payload);
      const retry = await call('retry_submit', 'submit', payload);
      assert.ok(result.receipt);
      assert.equal(result.receipt, retry.receipt);
      assert.equal(result.score, null);
      return result.receipt;
    }));
    assert.equal(manual.filter(item => item.status === 'rejected').length, 0, 'synthetic submit failed');
    const receipts = new Set(manual.map(item => item.value));
    assert.equal(receipts.size, users / 2);
    timerStart = Math.max(...complete.map(entry => entry.deadline));
    await delay(Math.max(0, timerStart - Date.now() + 70_000));
    const timed = await Promise.allSettled(complete.filter((_, i) => i % 2 === 1).map(async ({ call }) => {
      const result = await call('timer_receipt', 'state');
      assert.equal(result.submit_reason, 'timeout');
      assert.ok(result.receipt);
      assert.equal(receipts.has(result.receipt), false);
      receipts.add(result.receipt);
    }));
    assert.equal(timed.filter(item => item.status === 'rejected').length, 0, 'synthetic timeout verification failed');
    assert.equal(receipts.size, users);
    timerFinish = Date.now();
  } catch (error) {
    failure = error.message;
  } finally {
    clearInterval(progress);
  }
  const ops = Object.fromEntries([...metrics].map(([name, { latency, ...stat }]) => {
    const sorted = latency.sort((a, b) => a - b);
    const p = fraction => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 10) / 10 : null;
    return [name, { ...stat, count: sorted.length, p50_ms: p(.50), p95_ms: p(.95), p99_ms: p(.99) }];
  }));
  console.log(JSON.stringify({
    users, active_window_s: activeSeconds, parallel_request_limit: socketLimit, ops,
    expected_final_answers_hash: finalAnswersHash, response_body_bytes_uncompressed: responseBytes,
    timer_receipt_poll_offset_ms: timerFinish && timerStart ? timerFinish - timerStart : null,
    ...(failure ? { failure } : {})
  }));
  if (failure) process.exitCode = 1;
}

if (process.argv[2] === 'prepare') await prepare(Number(process.argv[3] ?? 36), Number(process.argv[4] ?? 0));
else if (process.argv[2] === 'run' && process.argv[3]) await run(process.argv[3]);
else throw new Error('Use hosted.mjs prepare [36|350|700] [active seconds] or hosted.mjs run <local synthetic manifest>');
