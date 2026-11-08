import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { db, delay, disconnect, login, state, student } from './db.mjs';

const usersPerStage = (process.env.CBT_LOAD_USERS ?? '36,350,700').split(',').map(Number);
const seconds = Number(process.env.CBT_LOAD_SECONDS || 31);
const rounds = Number(process.env.CBT_LOAD_ROUNDS || 1);
const mode = process.env.CBT_LOAD_MODE ?? 'mixed';
assert.ok(['mixed', 'manual', 'timer'].includes(mode));
assert.ok(usersPerStage.every(count => Number.isInteger(count) && count >= 2 && count <= 700));
assert.ok(Number.isInteger(seconds) && seconds >= 30 && seconds <= 10_800);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3);

const percentile = (sorted, value) => Math.round(sorted[Math.ceil(sorted.length * value) - 1] * 10) / 10;
const metrics = new Map();
const retryable = new Set(['40001', '40P01', '08006', '57P01', 'ECONNRESET']);
let jsonBytes = 0;

async function timed(label, action, validate) {
  const metric = metrics.get(label) ?? { latencies: [], errors: 0, attempts: 0, retries: 0, unrecovered: 0, codes: {} };
  metrics.set(label, metric);
  const began = performance.now();
  for (let i = 0; i < 2; i += 1) {
    metric.attempts += 1;
    try {
      const response = await action();
      validate?.(response);
      metric.latencies.push(performance.now() - began);
      jsonBytes += Buffer.byteLength(JSON.stringify(response));
      return response;
    } catch (error) {
      const code = error.code ?? 'assertion';
      metric.errors += 1;
      metric.codes[code] = (metric.codes[code] ?? 0) + 1;
      if (i === 0 && retryable.has(code)) {
        metric.retries += 1;
        await delay(50);
        continue;
      }
      metric.unrecovered += 1;
      throw error;
    }
  }
}

function requireSuccess(result, expected) {
  if (result?.ok !== true) {
    const error = new Error('student RPC rejected an expected valid operation');
    error.code = result?.code ?? 'application_failure';
    throw error;
  }
  return state(result, expected);
}

async function seed(users, label) {
  const { rows: [{ id: subject }] } = await db(
    'INSERT INTO public.cbt_subjects (slug, name) VALUES ($1, $2) RETURNING id', [label, label]
  );
  await db(`
    INSERT INTO public.cbt_question_bank
      (question_code, subject_id, question_number, grade_scope, prompt, options, correct_option, review_status)
    SELECT $2||'-'||n, $1, n, '10-12', 'Soal sintetis nomor '||n, 
      '{"A":"Jawaban sintetis satu","B":"Jawaban sintetis dua","C":"Jawaban sintetis tiga","D":"Jawaban sintetis empat"}',
      'A', 'approved'
    FROM generate_series(1,40) n`, [subject, label]);
  const plans = Array.from({ length: users }, (_, i) => ({
    nis: `${label.replaceAll('-', '')}${String(i + 1).padStart(3, '0')}`,
    class_code: `UJI ${label} ${Math.floor(i / 40) + 1}`,
    grade_level: 10 + Math.floor(i / 280),
    token: randomBytes(24).toString('base64url'),
    device: randomUUID(),
    answers: {},
  }));
  await db(`
    INSERT INTO public.cbt_students (nis,full_name,class_code,grade_level)
    SELECT j.nis, 'Peserta Sintetis '||j.nis, j.class_code, j.grade_level
    FROM jsonb_to_recordset($1::jsonb) j(nis text, class_code text, grade_level smallint)`,
    [JSON.stringify(plans.map(({ nis, class_code, grade_level }) => ({ nis, class_code, grade_level })))]);
  const { rows: exams } = await db(`
    INSERT INTO cbt_private.exams (subject_id,title,grade_level,classes,opens_at,closes_at,duration_minutes,status)
    SELECT $1, 'Ujian sintetis', grade_level, array_agg(DISTINCT class_code),
      clock_timestamp() - interval '1 minute', clock_timestamp() + make_interval(secs => $3 + 240),
      ceil(($3 + 180) / 60.0)::integer, 'published'
    FROM public.cbt_students WHERE nis LIKE $2
    GROUP BY grade_level RETURNING id, grade_level`, [subject, `${label.replaceAll('-', '')}%`, seconds]);
  const examIds = exams.map(({ id }) => id);
  await db(`
    INSERT INTO cbt_private.exam_questions (exam_id,position,question_id,prompt,options,correct_option,weight)
    SELECT e.id, q.question_number, q.id, q.prompt, q.options, q.correct_option, q.weight
    FROM cbt_private.exams e JOIN public.cbt_question_bank q ON q.subject_id=e.subject_id
    WHERE e.id=ANY($1::uuid[])`, [examIds]);
  await db(`
    INSERT INTO cbt_private.grading_keys (exam_id,version,position,correct_option)
    SELECT exam_id,1,position,correct_option FROM cbt_private.exam_questions WHERE exam_id=ANY($1::uuid[])`, [examIds]);
  const { rows: rights } = await db(`
    INSERT INTO cbt_private.rights (exam_id,student_id,token_hash,token_version,token_expires_at)
    SELECT e.id,s.id,extensions.digest(j.token,'sha256'),1,e.closes_at+interval '30 days'
    FROM jsonb_to_recordset($1::jsonb) j(nis text,token text)
    JOIN public.cbt_students s ON s.nis=j.nis
    JOIN cbt_private.exams e ON e.grade_level=s.grade_level AND e.id=ANY($2::uuid[])
    RETURNING id, student_id`, [JSON.stringify(plans.map(({ nis, token }) => ({ nis, token }))), examIds]);
  assert.equal(rights.length, users);
  return { plans, examIds };
}

async function dbStats() {
  const { rows: [stats] } = await db(`
    SELECT pg_database_size(current_database()) AS db_bytes, xact_commit, xact_rollback,
      blks_read, blks_hit, tup_inserted, tup_updated, temp_bytes, deadlocks
    FROM pg_stat_database WHERE datname=current_database()`);
  return Object.fromEntries(Object.entries(stats).map(([name, value]) => [name, Number(value)]));
}

function compareAnswers(actual, expected) {
  assert.equal(Object.keys(actual).length, Object.keys(expected).length);
  for (const [position, answer] of Object.entries(expected)) {
    assert.deepEqual(actual[position], answer, 'a confirmed answer differs from its stored version');
  }
}

async function load(users, round) {
  metrics.clear();
  jsonBytes = 0;
  const label = `71${round}${String(users).padStart(3, '0')}`;
  const { plans, examIds } = await seed(users, label);
  const before = await dbStats();
  const began = performance.now();
  const opening = await Promise.allSettled(plans.map(async plan => {
    const entry = await timed('login', () => login(plan.nis, plan.token, plan.device), result => {
      requireSuccess(result, 'ready');
      assert.equal(result.questions?.length ?? 0, 0);
    });
    plan.session = entry.session;
    plan.right = entry.right_id;
    const attempt = await timed('read_40', () => student(plan.session, 'start', { device: plan.device }), result => {
      requireSuccess(result, 'active');
      assert.equal(result.questions.length, 40);
      assert.equal(result.right_id, plan.right);
    });
    plan.epoch = attempt.write_epoch;
  }));
  assert.equal(new Set(plans.filter(plan => plan.right).map(plan => plan.right)).size, users, 'expected distinct access rights');
  assert.equal(opening.filter(item => item.status === 'rejected').length, 0, 'login or initial read failure');

  const activeUntil = performance.now() + seconds * 1_000;
  const loops = await Promise.allSettled(plans.map(async (plan, index) => {
    let tick = 0;
    while (performance.now() < activeUntil) {
      const wait = Math.min(randomInt(15_000, 30_001), activeUntil - performance.now());
      if (wait < 10) break;
      await delay(wait);
      const position = (index + tick) % 40 + 1;
      const answer = {
        option: ['A', 'B', 'C', 'D'][tick % 4], flagged: tick % 5 === 0, revision: ++tick
      };
      const payload = { device: plan.device, epoch: plan.epoch, answers: { [position]: answer } };
      await timed('autosave', () => student(plan.session, 'save', payload), result => {
        requireSuccess(result, 'active');
        assert.equal(result.right_id, plan.right);
        assert.deepEqual(result.answers[position], answer);
      });
      plan.answers[position] = answer;
      if (tick === 1 && index % 5 === 0) {
        const resumed = await timed('reconnect', () => student(plan.session, 'state', { device: plan.device }), result => {
          requireSuccess(result, 'active');
          assert.equal(result.questions.length, 40);
          assert.equal(result.right_id, plan.right);
          compareAnswers(result.answers, plan.answers);
        });
        assert.equal(resumed.write_epoch, plan.epoch);
      }
      if (tick === 1 && index % 11 === 0) {
        await timed('retry_autosave', () => student(plan.session, 'save', payload), result => {
          requireSuccess(result, 'active');
          compareAnswers(result.answers, plan.answers);
        });
      }
    }
  }));
  assert.equal(loops.filter(item => item.status === 'rejected').length, 0, 'autosave/reconnect failure');

  const manual = plans.filter((_, index) => mode === 'manual' || (mode === 'mixed' && index % 2 === 0));
  const submissions = await Promise.allSettled(manual.map(async plan => {
    const submit = () => student(plan.session, 'submit', { device: plan.device, epoch: plan.epoch, answers: {} });
    const receipt = await timed('submit', submit, result => {
      requireSuccess(result, 'final');
      assert.ok(result.receipt);
    });
    plan.receipt = receipt.receipt;
    await timed('retry_submit', submit, result => {
      requireSuccess(result, 'final');
      assert.equal(result.receipt, plan.receipt);
    });
  }));
  assert.equal(submissions.filter(item => item.status === 'rejected').length, 0, 'submit/retry failure');

  // Simulate a common timer ending now. Use the real finalizer, via pg_cron when installed.
  const { rows: [{ expired_at: expiredAt }] } = await db(`
    WITH expired AS (
      UPDATE cbt_private.attempts a SET deadline=clock_timestamp()
      FROM cbt_private.rights r WHERE a.right_id=r.id AND r.exam_id=ANY($1::uuid[]) AND a.submitted_at IS NULL
      RETURNING a.deadline
    ) SELECT min(deadline) AS expired_at FROM expired`, [examIds]);
  const finalizerBegan = performance.now();
  if (process.env.CBT_TEST_CRON !== '1') {
    const { rows: [{ finished }] } = await db('SELECT cbt_private.finalize_due() AS finished');
    assert.equal(Number(finished), users - manual.length);
  }
  const countPending = () => db(`
    SELECT count(*)::integer AS pending
    FROM cbt_private.attempts a JOIN cbt_private.rights r ON r.id=a.right_id
    WHERE r.exam_id=ANY($1::uuid[]) AND a.submitted_at IS NULL`, [examIds]);
  const cutoff = performance.now() + 180_000;
  while ((await countPending()).rows[0].pending && performance.now() < cutoff) await delay(500);
  const finalizerMilliseconds = Math.round(performance.now() - finalizerBegan);
  const { rows: attempts } = await db(`
    SELECT a.right_id,a.answers,a.receipt,a.submit_reason,a.submitted_at,
      (SELECT count(*)::integer FROM cbt_private.results s WHERE s.right_id=a.right_id) AS result_count
    FROM cbt_private.attempts a JOIN cbt_private.rights r ON r.id=a.right_id
    WHERE r.exam_id=ANY($1::uuid[])`, [examIds]);
  assert.equal(attempts.length, users);
  assert.equal(new Set(attempts.map(attempt => attempt.receipt)).size, users, 'duplicate or missing receipts');
  const byRight = new Map(attempts.map(attempt => [attempt.right_id, attempt]));
  for (const plan of plans) {
    const stored = byRight.get(plan.right);
    assert.ok(stored?.receipt);
    assert.equal(stored.result_count, 1);
    compareAnswers(stored.answers, plan.answers);
    assert.equal(stored.submit_reason, plan.receipt ? 'manual' : 'timeout');
    if (plan.receipt) assert.equal(stored.receipt, plan.receipt);
  }
  assert.ok(finalizerMilliseconds <= 180_000);
  const after = await dbStats();
  const operations = Object.fromEntries([...metrics].map(([label, value]) => {
    const sorted = value.latencies.sort((a, b) => a - b);
    return [label, {
      count: sorted.length, errors: value.errors, attempts: value.attempts,
      retries: value.retries, unrecovered: value.unrecovered, codes: value.codes,
      p50_ms: percentile(sorted, 0.50), p95_ms: percentile(sorted, 0.95), p99_ms: percentile(sorted, 0.99)
    }];
  }));
  const errorRate = [...metrics.values()].reduce((sum, item) => sum + item.errors, 0)
    / [...metrics.values()].reduce((sum, item) => sum + item.attempts, 0);
  console.log(JSON.stringify({
    round, users, mode, autosave_window_s: seconds, elapsed_ms: Math.round(performance.now() - began),
    pool_size: Number(process.env.CBT_POOL_SIZE || 24), ops: operations, error_rate: errorRate,
    response_json_bytes: jsonBytes, finalizer_ms: finalizerMilliseconds,
    finalizer: process.env.CBT_TEST_CRON === '1' ? 'pg_cron' : 'direct',
    timer_deadline_observed: Boolean(expiredAt), pg_delta: Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]])),
    checks: { answers_lost: 0, duplicate_results: 0, cross_right_responses: 0 }
  }));
  assert.ok(errorRate < 0.01, 'operation error rate exceeded 1%');
  assert.ok(operations.autosave.p95_ms <= 2000, 'p95 autosave exceeded 2 seconds');
  if (operations.submit) assert.ok(operations.submit.p95_ms <= 5000, 'p95 receipt exceeded 5 seconds');
}

try {
  for (let round = 1; round <= rounds; round += 1) {
    for (const users of usersPerStage) await load(users, round);
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.code ?? 'TEST_FAILURE', message: error.message,
    counters: Object.fromEntries([...metrics].map(([label, value]) => [
      label, { attempts: value.attempts, errors: value.errors, retries: value.retries, codes: value.codes }
    ])) }));
  process.exitCode = 1;
} finally {
  await disconnect();
}
