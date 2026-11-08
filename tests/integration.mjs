import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { db, delay, disconnect, login, rejected, staff, state, student } from './db.mjs';

const a = 'UJI A';
const b = 'UJI B';
const question = (subject, number) => ({
  subject_id: subject, prompt: `Soal uji ${number}?`, grade_scope: '10',
  options: { A: 'Uji satu', B: 'Uji dua', C: 'Uji tiga', D: 'Uji empat' },
  correct_option: 'A', review_status: 'approved', weight: 1
});
const time = seconds => new Date(Date.now() + seconds * 1000).toISOString();
const answer = (option, flagged, revision) => ({ option, flagged, revision });

async function user(label) {
  const email = `${label}@example.invalid`;
  const { rows: [{ id }] } = await db('INSERT INTO auth.users(email) VALUES ($1) RETURNING id', [email]);
  const { rows: [{ id: session_id }] } = await db('INSERT INTO auth.sessions(user_id) VALUES ($1) RETURNING id', [id]);
  return { id, email, session_id };
}

async function assertPrivileges() {
  const { rows } = await db(`
    SELECT r.rolname, c.relname, c.relrowsecurity,
      has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE') AS permitted
    FROM pg_class c CROSS JOIN pg_roles r
    WHERE c.relnamespace IN ('public'::regnamespace, 'cbt_private'::regnamespace)
      AND c.relkind = 'r' AND r.rolname IN ('anon', 'authenticated')`);
  assert.ok(rows.length >= 6);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true, `missing RLS for ${row.relname}`);
    assert.equal(row.permitted, false, `unexpected ${row.rolname} table privileges on ${row.relname}`);
  }
  const { rows: [acl] } = await db(`
    SELECT has_function_privilege('anon','public.cbt_staff(text,jsonb)','execute') staff,
      has_function_privilege('anon','public.cbt_student(text,text,jsonb)','execute') student`);
  assert.equal(acl.staff, false);
  assert.equal(acl.student, true);
}

async function run() {
  await assertPrivileges();
  const [admin, teacher, unlisted] = await Promise.all(['admin', 'teacher', 'unlisted'].map(user));
  await db("INSERT INTO cbt_private.staff(user_id,display_name,role,classes,is_active) VALUES ($1,'Admin Uji','admin','{}',true)", [admin.id]);
  await db(`
    INSERT INTO public.cbt_students(nis,full_name,class_code,grade_level) VALUES
      ('710001','Uji Alfa',$1,10), ('710002','Uji Beta',$1,10), ('710003','Uji Gamma',$2,10)`, [a, b]);
  const { rows: [{ id: subject }] } = await db("INSERT INTO public.cbt_subjects(slug,name) VALUES ('mapel-uji','Mapel Uji') RETURNING id");
  await rejected(() => staff(null, 'dashboard'));
  await rejected(() => staff(unlisted, 'dashboard'));
  await staff(admin, 'staff_save', {
    email: teacher.email, display_name: 'Guru Uji', role: 'teacher', classes: [a], is_active: true
  });
  const dashboard = await staff(teacher, 'dashboard');
  assert.equal(dashboard.profile.role, 'teacher');
  assert.deepEqual(dashboard.classes.map(c => c.class_code), [a]);
  assert.deepEqual(dashboard.slots.map(slot => [slot.start_time, slot.end_time]),
    [['07:30:00','09:00:00'], ['09:30:00','11:00:00'], ['11:30:00','13:00:00']]);
  await rejected(() => staff(teacher, 'staff_save', {
    email: unlisted.email, display_name: 'Uji', role: 'admin', classes: [], is_active: true
  }));
  const slot = { id: 1, label: 'Sesi Uji', start_time: '00:00', end_time: '23:59', is_active: true };
  await rejected(() => staff(teacher, 'slot_save', slot));
  await staff(admin, 'slot_save', { id: 2, label: 'Sesi 2 Uji', start_time: '09:30', end_time: '11:00', is_active: false });
  await staff(admin, 'slot_save', { id: 3, label: 'Sesi 3 Uji', start_time: '11:30', end_time: '13:00', is_active: false });
  await staff(admin, 'slot_save', slot);
  await rejected(() => staff(admin, 'slot_save', { ...slot, id: 2 }));
  console.log('PASS staff authorization, role scopes, slot overlap, table and RPC privileges');

  const q1 = (await staff(teacher, 'question_save', question(subject, 1))).id;
  const q2 = (await staff(teacher, 'question_save', question(subject, 2))).id;
  const q3 = (await staff(teacher, 'question_save', { ...question(subject, 3), review_status: 'draft' })).id;
  const bank = await staff(teacher, 'bank', { subject_id: subject });
  assert.equal(bank.find(q => q.id === q1).correct_option, 'A');
  const draft = { subject_id: subject, title: 'Ujian sintetis', grade_level: 10,
    classes: [a], opens_at: time(3), closes_at: time(180), duration_minutes: 1, slot_id: 1, question_count: 1 };
  await rejected(() => staff(teacher, 'exam_save', { ...draft, classes: [b] }));
  const { id: exam } = await staff(teacher, 'exam_save', draft);
  await rejected(() => staff(teacher, 'publish', { exam_id: exam, question_ids: [q3] }));
  await staff(teacher, 'publish', { exam_id: exam, question_ids: [q1] });
  const { id: overlapping } = await staff(teacher, 'exam_save', { ...draft, title: 'Jadwal bertabrakan' });
  await rejected(() => staff(teacher, 'publish', { exam_id: overlapping, question_ids: [q2] }));
  await staff(teacher, 'question_save', { ...question(subject, 1), id: q1, correct_option: 'D' });
  const { participants } = await staff(teacher, 'exam_detail', { exam_id: exam });
  assert.equal(participants.length, 2);
  assert.ok(participants.every(p => p.class_code === a));
  const [first, second] = [...participants].sort((x, y) => x.nis.localeCompare(y.nis));
  const [tokenOne, tokenTwo] = await staff(teacher, 'tokens', {
    exam_id: exam, right_ids: [first.right_id, second.right_id], mode: 'issue'
  });
  const byStudent = new Map([tokenOne, tokenTwo].map(item => [item.nis, item.token]));
  const token = byStudent.get(first.nis);
  const otherToken = byStudent.get(second.nis);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.match(otherToken, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(token, otherToken);
  const { rows: [{ verifier }] } = await db("SELECT encode(token_hash, 'hex') AS verifier FROM cbt_private.rights WHERE id=$1", [first.right_id]);
  assert.equal(verifier, createHash('sha256').update(token).digest('hex'));
  assert.deepEqual(await staff(teacher, 'tokens', { exam_id: exam, right_ids: [first.right_id], mode: 'issue' }), []);
  assert.equal(JSON.stringify(await staff(teacher, 'exam_detail', { exam_id: exam })).includes(token), false);
  console.log('PASS question review, immutable publication, scoped participants, one-time token display');

  const device = randomUUID();
  const wrong = await login(first.nis, otherToken, device);
  assert.equal(wrong.ok, false);
  assert.deepEqual(await login('719999', token, device), wrong);
  await delay(Math.max(0, Date.parse(draft.opens_at) - Date.now() + 50));
  const firstLogin = state(await login(first.nis, token, device), 'ready');
  const session = firstLogin.session;
  assert.equal(firstLogin.questions?.length ?? 0, 0);
  assert.equal(firstLogin.score, null);
  const [started, simultaneousStart] = (await Promise.all([
    student(session, 'start', { device }), student(session, 'start', { device })
  ])).map(result => state(result, 'active'));
  assert.equal(started.deadline, simultaneousStart.deadline);
  assert.equal(started.write_epoch, simultaneousStart.write_epoch);
  assert.equal(started.questions.length, 1);
  assert.equal(started.write_epoch >= 1, true);
  const originalSave = { device, epoch: started.write_epoch, answers: { 1: answer('A', true, 1) } };
  const saved = state(await student(session, 'save', originalSave));
  const repeated = state(await student(session, 'save', originalSave));
  assert.equal(repeated.revision, saved.revision);
  const refreshed = state(await student(session, 'state', { device }), 'active');
  assert.equal(refreshed.answers[1].option, 'A');
  assert.equal(refreshed.answers[1].flagged, true);
  const saveRevision = (option, revision) => student(session, 'save', {
    ...originalSave, answers: { 1: answer(option, true, revision) }
  });
  await Promise.all([saveRevision('B', 2), saveRevision('A', 3), saveRevision('B', 2)]);
  const latest = state(await student(session, 'state', { device }), 'active');
  assert.deepEqual(latest.answers[1], answer('A', true, 3));
  await rejected(() => student(session, 'save', { ...originalSave, answers: { 1: answer('E', false, 2) } }));

  const secondDevice = randomUUID();
  const secondSession = state(await login(first.full_name, token, secondDevice), 'active');
  assert.equal(secondSession.writable, false);
  assert.equal(secondSession.questions?.length ?? 0, 0);
  assert.equal(Object.hasOwn(secondSession, 'answers'), false);
  const other = state(await login(second.nis, otherToken, randomUUID()), 'ready');
  assert.equal(other.right_id, second.right_id);
  assert.equal(other.questions?.length ?? 0, 0);
  const cross = state(await student(session, 'state', { device, right_id: second.right_id }), 'active');
  assert.equal(cross.right_id, first.right_id);
  const claimed = state(await student(secondSession.session, 'claim', { device: secondDevice, epoch: secondSession.write_epoch }), 'active');
  assert.ok(claimed.write_epoch > started.write_epoch);
  await rejected(() => student(session, 'save', { ...originalSave, answers: { 1: answer('B', false, 2) } }));
  assert.equal(claimed.answers[1].option, 'A');
  const [rotated] = await staff(teacher, 'tokens', { exam_id: exam, right_ids: [first.right_id], mode: 'rotate' });
  await rejected(() => student(secondSession.session, 'state', { device: secondDevice }));
  assert.deepEqual(await login(first.nis, token, device), wrong);
  const relog = state(await login(first.nis, rotated.token, device), 'active');
  const newLease = relog.writable ? relog : state(await student(relog.session, 'claim', { device, epoch: relog.write_epoch }), 'active');
  assert.equal(newLease.answers[1].option, 'A');
  const submitData = { device, epoch: newLease.write_epoch, answers: {} };
  const [final, retried] = (await Promise.all([
    student(relog.session, 'submit', submitData), student(relog.session, 'submit', submitData)
  ])).map(result => state(result, 'final'));
  assert.equal(final.receipt, retried.receipt);
  assert.ok(final.receipt);
  assert.equal(final.score, null);
  const reentry = state(await login(first.nis, rotated.token, device), 'final');
  assert.equal(reentry.receipt, final.receipt);
  assert.equal(reentry.questions?.length ?? 0, 0);
  console.log('PASS generic denial, session isolation, refresh, idempotent saves, write takeover, rotation, duplicate submit, hidden key and score');

  const timerDevice = randomUUID();
  const timerSession = state(await login(second.nis, otherToken, timerDevice), 'ready').session;
  const timerStart = state(await student(timerSession, 'start', { device: timerDevice }), 'active');
  await student(timerSession, 'save', { device: timerDevice, epoch: timerStart.write_epoch, answers: { 1: answer('A', false, 1) } });
  // Advance only the isolated fixture's deadline; the RPC still checks the real database clock.
  await db("UPDATE cbt_private.attempts SET started_at = clock_timestamp() - interval '2 seconds', deadline = clock_timestamp() - interval '1 second' WHERE right_id = $1", [second.right_id]);
  const late = await student(timerSession, 'save', { device: timerDevice, epoch: timerStart.write_epoch, answers: { 1: answer('B', false, 2) } });
  assert.ok(late.ok === false || late.status === 'final');
  const timerFinal = state(await student(timerSession, 'state', { device: timerDevice }), 'final');
  assert.ok(timerFinal.receipt);
  assert.equal((await db("SELECT answers->'1'->>'option' AS option FROM cbt_private.attempts WHERE right_id=$1", [second.right_id])).rows[0].option, 'A');
  await staff(teacher, 'close', { exam_id: exam });
  const corrected = await staff(teacher, 'correct', {
    exam_id: exam, position: 1, correct_option: 'B', reason: 'Koreksi sintetis', expected_version: 1
  });
  const retryCorrection = await staff(teacher, 'correct', {
    exam_id: exam, position: 1, correct_option: 'B', reason: 'Koreksi sintetis', expected_version: 1
  });
  assert.equal(corrected.version, 2);
  assert.equal(retryCorrection.version, corrected.version);
  const { rows: versions } = await db('SELECT version, score FROM cbt_private.results WHERE right_id=$1 ORDER BY version', [first.right_id]);
  assert.deepEqual(versions.map(row => [row.version, Number(row.score)]), [[1, 100], [2, 0]]);
  assert.equal(state(await student(reentry.session, 'state', { device }), 'final').score, null);
  console.log('PASS timer prevents late writes, grades immutable attempt snapshot and preserves correction history');

  const makeTimes = { opens_at: time(4), closes_at: time(175), duration_minutes: 1 };
  const { id: makeup } = await staff(teacher, 'exam_save', {
    ...draft, ...makeTimes, title: 'Susulan sintetis', makeup_only: true
  });
  await staff(teacher, 'publish', { exam_id: makeup, question_ids: [q2] });
  assert.equal((await staff(teacher, 'exam_detail', { exam_id: makeup })).participants.length, 0);
  const make = { regular_id: first.right_id, exam_id: makeup, ...makeTimes, reason: 'Alasan sintetis' };
  const assigned = await staff(teacher, 'makeup', make);
  assert.ok(assigned.token);
  const duplicateMakeup = await staff(teacher, 'makeup', make);
  assert.deepEqual(duplicateMakeup, { right_id: assigned.right_id, token: null });
  await rejected(() => staff(teacher, 'makeup', { ...make, reason: 'Permintaan kedua yang berbeda' }));
  await rejected(() => staff(teacher, 'release', { exam_id: exam }));
  await delay(Math.max(0, Date.parse(makeTimes.opens_at) - Date.now() + 50));
  const makeupDevice = randomUUID();
  const makeupSession = state(await login(first.nis, assigned.token, makeupDevice), 'ready').session;
  const makeupActive = state(await student(makeupSession, 'start', { device: makeupDevice }), 'active');
  assert.notEqual(makeupActive.questions[0].prompt, started.questions[0].prompt);
  const makeupFinal = state(await student(makeupSession, 'submit', { device: makeupDevice, epoch: makeupActive.write_epoch, answers: {} }), 'final');
  assert.notEqual(makeupFinal.receipt, final.receipt);
  const unchanged = state(await student(reentry.session, 'state', { device }), 'final');
  assert.equal(unchanged.receipt, final.receipt);
  assert.equal((await staff(teacher, 'exam_detail', { exam_id: makeup })).audit.some(entry => JSON.stringify(entry).includes(make.reason)), true);
  await staff(teacher, 'close', { exam_id: makeup });
  await staff(teacher, 'release', { exam_id: exam });
  const released = state(await student(reentry.session, 'state', { device }), 'final');
  assert.equal(Number(released.score), 0);
  assert.equal(released.receipt, final.receipt);
  for (let i = 0; i < 10; i += 1) assert.deepEqual(await login(first.nis, otherToken, device), wrong);
  assert.deepEqual(await login(first.nis, rotated.token, device), wrong);
  assert.equal(state(await login(second.nis, otherToken, randomUUID()), 'final').right_id, second.right_id);
  console.log('PASS per-identity throttling permits another participant in the same class');
  console.log('PASS makeup unique right, separate questions/token, audit, regular receipt retained, release blocked until makeup ends');

  // Supabase may still present an unexpired JWT after an administrator revokes the session.
  await db("UPDATE auth.users SET banned_until=clock_timestamp()+interval '1 hour' WHERE id=$1", [teacher.id]);
  await rejected(() => staff(teacher, 'dashboard'));
  await db('UPDATE auth.users SET banned_until=NULL WHERE id=$1', [teacher.id]);
  assert.equal((await staff(teacher, 'dashboard')).profile.role, 'teacher');
  await rejected(() => staff({ ...teacher, session_id: admin.session_id }, 'dashboard'));
  await db("UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 minute' WHERE id=$1", [teacher.session_id]);
  await rejected(() => staff(teacher, 'dashboard'));
  await db('UPDATE auth.sessions SET not_after=NULL WHERE id=$1', [teacher.session_id]);
  await db('DELETE FROM auth.sessions WHERE id=$1', [teacher.session_id]);
  await rejected(() => staff(teacher, 'dashboard'));
  console.log('PASS banned staff, cross-user JWT session claim, expired and revoked Auth session');
}

try {
  await run();
} catch (error) {
  console.error(error.code ?? 'TEST_FAILURE', error.message);
  if (error.where) console.error(error.where);
  else console.error(error.stack?.split('\n').filter(line => line.includes('/tests/')).slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  await disconnect();
}
