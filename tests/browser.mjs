import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium, devices } from 'playwright';
import { db, delay, disconnect, login, staff, student } from './db.mjs';

const origin = new URL(process.env.CBT_TEST_WEB_URL ?? 'http://127.0.0.1:4173/cbt/');
assert.equal(origin.hostname, '127.0.0.1');
assert.equal(origin.pathname, '/cbt/');
const headers = { 'access-control-allow-origin': origin.origin, 'content-type': 'application/json' };
let offline = false;
let browser;

function check(condition, description) {
  assert.ok(condition, description);
}

async function mobile(page, label) {
  const size = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth
  }));
  assert.ok(size.document <= size.viewport + 1, `${label}: page has horizontal overflow (${size.document} > ${size.viewport})`);
}

async function touch(page, labels) {
  for (const label of labels) {
    const element = typeof label === 'string' ? page.getByRole('button', { name: label, exact: true }) : label;
    const box = await element.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, 'visible primary control is smaller than 44 × 44 CSS px');
  }
}

async function until(checkCondition, failure, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await checkCondition()) return;
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error(failure);
}

async function setup() {
  const email = 'guru-uji@example.invalid';
  const password = randomBytes(12).toString('hex');
  const { rows: [{ id }] } = await db('INSERT INTO auth.users(email) VALUES ($1) RETURNING id', [email]);
  const { rows: [{ id: session_id }] } = await db('INSERT INTO auth.sessions(user_id) VALUES ($1) RETURNING id', [id]);
  const user = { id, email, session_id };
  await db("INSERT INTO cbt_private.staff(user_id,display_name,role) VALUES ($1,'Admin Sintetis','admin')", [id]);
  const nis = '710001';
  await db("INSERT INTO public.cbt_students(nis,full_name,class_code,grade_level) VALUES ($1,'Siswa Sintetis','UJI A',10)", [nis]);
  const { rows: [{ id: subject_id }] } = await db("INSERT INTO public.cbt_subjects(slug,name) VALUES ('uji-ui','Mapel Sintetis') RETURNING id");
  const questionIds = [];
  for (const prompt of ['Soal UI sintetis?', 'Soal UI sintetis lanjutan 2?', 'Soal UI sintetis lanjutan 3?']) {
    const { id } = await staff(user, 'question_save', {
      subject_id, prompt, options: { A: 'Pilihan Alfa', B: 'Pilihan Beta', C: 'Pilihan Gamma', D: 'Pilihan Delta' },
      correct_option: 'A', review_status: 'approved', grade_scope: '10'
    });
    questionIds.push(id);
  }
  const { id: exam_id } = await staff(user, 'exam_save', {
    subject_id, title: 'Ujian Sintetis', classes: ['UJI A'], grade_level: 10,
    opens_at: new Date(Date.now() + 3000).toISOString(), closes_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    duration_minutes: 10, question_count: questionIds.length
  });
  await staff(user, 'publish', { exam_id, question_ids: questionIds });
  const { participants: [{ right_id }] } = await staff(user, 'exam_detail', { exam_id });
  const [{ token }] = await staff(user, 'tokens', { exam_id, right_ids: [right_id], mode: 'issue' });
  return { user, password, nis, token, right_id };
}

async function connect(context, fixture) {
  const tokenHeader = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
  const tokenBody = Buffer.from(JSON.stringify({
    sub: fixture.user.id, exp: Math.floor(Date.now() / 1000) + 3600,
    role: 'authenticated', session_id: fixture.user.session_id
  })).toString('base64url');
  const accessToken = `${tokenHeader}.${tokenBody}.localTest`;
  const user = {
    id: fixture.user.id, aud: 'authenticated', role: 'authenticated', email: fixture.user.email,
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString()
  };
  await context.route(/\/rest\/v1\/rpc\/cbt_/, async route => {
    if (offline) return route.abort('internetdisconnected');
    const request = route.request();
    const json = request.postDataJSON();
    const name = new URL(request.url()).pathname.split('/').at(-1);
    try {
      let result;
      if (name === 'cbt_student_login') {
        result = await login(json.p_identity, json.p_token, json.p_device);
      } else if (name === 'cbt_student') {
        result = await student(json.p_session, json.p_action, json.p_data);
      } else if (name === 'cbt_staff') {
        const auth = request.headers().authorization;
        result = await staff(auth === `Bearer ${accessToken}` ? fixture.user : null, json.p_action, json.p_data);
      }
      return route.fulfill({ headers, status: 200, body: JSON.stringify(result) });
    } catch (error) {
      return route.fulfill({ headers, status: 400, body: JSON.stringify({ message: error.message, code: error.code }) });
    }
  });
  await context.route(/\/auth\/v1\/(?:token|logout|user)/, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/logout')) return route.fulfill({ headers, status: 204 });
    if (url.pathname.endsWith('/user')) return route.fulfill({ headers, status: 200, body: JSON.stringify(user) });
    const payload = route.request().postDataJSON();
    if (payload.email !== fixture.user.email || payload.password !== fixture.password) {
      return route.fulfill({ headers, status: 400, body: JSON.stringify({ message: 'Invalid login credentials' }) });
    }
    return route.fulfill({ headers, status: 200, body: JSON.stringify({
      access_token: accessToken, refresh_token: 'test-fixture-refresh', token_type: 'bearer', expires_in: 3600, user
    }) });
  });
}

try {
  const fixture = await setup();
  browser = await chromium.launch({ channel: process.env.CBT_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ ...devices['Galaxy S9+'], viewport: { width: 320, height: 640 } });
  await connect(context, fixture);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.name));
  const response = await page.goto(origin.href, { waitUntil: 'networkidle' });
  assert.equal(response?.status(), 200);
  await page.getByLabel('NIS atau nama lengkap').waitFor();
  await mobile(page, 'student sign-in');
  await touch(page, ['Masuk ke ujian', page.getByRole('link', { name: 'Siswa', exact: true })]);
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    const style = getComputedStyle(el);
    return el.matches(':focus-visible') && (parseFloat(style.outlineWidth) > 0 || style.boxShadow !== 'none');
  });
  check(focus, 'keyboard focus indicator is not visible');
  await page.getByLabel('NIS atau nama lengkap').fill(fixture.nis);
  await page.getByLabel('Token ujian').fill(fixture.token);
  await page.getByRole('button', { name: 'Masuk ke ujian', exact: true }).click();
  await page.getByRole('button', { name: 'Mulai ujian', exact: true }).click();
  await page.getByText('Soal UI sintetis?', { exact: true }).waitFor();
  await mobile(page, 'exam');
  await page.getByRole('timer', { name: 'Sisa waktu' }).waitFor();
  await page.locator('[data-save-status]').waitFor();
  await touch(page, [page.locator('label.choice').first()]);

  const stored = async option => (await db(
    "SELECT answers->'1'->>'option' AS option FROM cbt_private.attempts WHERE right_id=$1", [fixture.right_id]
  )).rows[0]?.option === option;
  await page.getByRole('radio').nth(0).check();
  await until(() => stored('A'), 'autosave never reached database');
  const flag = page.getByRole('button', { name: 'Ragu', exact: true });
  await flag.click();
  assert.equal(await flag.getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Berikutnya', exact: true }).click();
  await page.getByRole('heading', { name: 'Soal UI sintetis lanjutan 2?' }).waitFor();
  check(await page.evaluate(() => document.activeElement?.id === 'question-heading'), 'question navigation did not move keyboard focus');
  await page.getByRole('button', { name: 'Sebelumnya', exact: true }).click();
  check(await page.getByRole('radio').nth(0).isChecked(), 'question navigation removed the selected answer');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Soal UI sintetis?', { exact: true }).waitFor();
  check(await page.getByRole('radio').nth(0).isChecked(), 'confirmed answer lost after refresh');
  const popup = page.waitForEvent('popup');
  await page.evaluate(() => { window.open('#siswa', '_blank'); });
  const duplicate = await popup;
  await duplicate.getByLabel('NIS atau nama lengkap').waitFor();
  assert.equal(await duplicate.getByText('Soal UI sintetis?', { exact: true }).count(), 0);
  await duplicate.close();

  offline = true;
  await context.setOffline(true);
  await page.getByRole('radio').nth(1).check();
  check(await stored('A'), 'offline edit should remain local until it reconnects');
  await page.setViewportSize({ width: 640, height: 320 });
  await mobile(page, 'exam landscape offline');
  check(await page.getByRole('radio').nth(1).isChecked(), 'rotation removed pending offline answer');
  offline = false;
  await context.setOffline(false);
  await until(() => stored('B'), 'offline answer never synced after reconnect');
  await page.setViewportSize({ width: 320, height: 640 });

  await page.evaluate(() => { location.hash = '#guru'; });
  await page.getByRole('heading', { name: 'Masuk sebagai guru' }).waitFor();
  await page.goBack();
  await page.getByText('Soal UI sintetis?', { exact: true }).waitFor();
  check(await page.getByRole('radio').nth(1).isChecked(), 'browser Back removed a saved answer');

  await page.getByRole('button', { name: 'Kirim ujian', exact: true }).click();
  const confirm = page.getByRole('dialog');
  if (await confirm.isVisible()) await confirm.getByRole('button', { name: /kirim/i }).last().click();
  await until(async () => Boolean((await db(
    'SELECT receipt FROM cbt_private.attempts WHERE right_id=$1', [fixture.right_id]
  )).rows[0]?.receipt), 'browser submit did not finalize the exam');
  const { rows: [{ receipt }] } = await db('SELECT receipt FROM cbt_private.attempts WHERE right_id=$1', [fixture.right_id]);
  await page.getByText(receipt, { exact: false }).first().waitFor();
  await mobile(page, 'receipt');

  await page.getByRole('link', { name: 'Guru', exact: true }).click();
  await page.getByLabel('Email akun sekolah').fill(fixture.user.email);
  await page.getByLabel('Kata sandi').fill(fixture.password);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await page.getByRole('heading', { name: 'Ringkasan', exact: true }).waitFor();
  await mobile(page, 'staff dashboard');
  await page.getByRole('button', { name: 'Ujian', exact: true }).click();
  await page.getByRole('button', { name: 'Kelola ujian', exact: true }).click();
  await mobile(page, 'staff result detail');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Ekspor rekap CSV', exact: true }).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), 'rekap-cbt.csv');
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString(), /Siswa Sintetis/);
  assert.deepEqual(pageErrors, []);
  console.log('PASS 320 px student sign-in, focus, touch sizing, student SQL, question navigation, flagged state, autosave, reload, duplicate tab isolation, offline reconnect, rotation, Back, receipt, staff dashboard with Auth adapter, and CSV export');
} catch (error) {
  console.error(error.message);
  console.error(error.stack?.split('\n').filter(line => line.includes('/tests/')).slice(0, 3).join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await disconnect();
}
