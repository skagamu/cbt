import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';

const pages = 'https://skagamu.github.io/cbt/';
const project = 'https://ynepxhlvpvlfuhcerydu.supabase.co';
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
assert.ok(key?.startsWith('sb_publishable_'), 'Set the public Supabase publishable key');

async function deny(path, options = {}) {
  const response = await fetch(project + path, {
    ...options,
    headers: { apikey: key, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok([401, 403, 404].includes(response.status), 'anonymous request was not denied');
  return response.status;
}

const browser = await chromium.launch({ channel: process.env.CBT_BROWSER_CHANNEL || 'chrome', headless: true });
try {
  const context = await browser.newContext({ ...devices['Galaxy S9+'], viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  const responses = [];
  const errors = [];
  page.on('response', response => {
    if (response.url().startsWith(pages)) responses.push(response);
  });
  page.on('pageerror', error => errors.push(error.name));
  const main = await page.goto(pages, { waitUntil: 'networkidle' });
  assert.equal(main?.status(), 200);
  await page.getByLabel('NIS atau nama lengkap').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 321));
  await page.getByRole('link', { name: 'Guru', exact: true }).click();
  await page.getByLabel('Email akun sekolah').waitFor();
  assert.equal(page.url(), pages + '#guru');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('Email akun sekolah').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 321));
  await page.getByRole('link', { name: 'Siswa', exact: true }).click();
  await page.getByLabel('NIS atau nama lengkap').waitFor();
  assert.equal(page.url(), pages + '#siswa');
  assert.deepEqual(errors, []);

  const assetResponses = responses.filter(response => /\.(js|css|svg)(?:[?#]|$)/.test(response.url()));
  assert.ok(assetResponses.some(response => response.url().includes('.js')));
  assert.ok(assetResponses.some(response => response.url().includes('.css')));
  for (const response of assetResponses) {
    assert.equal(response.status(), 200);
    const artifact = await fetch(response.url(), { signal: AbortSignal.timeout(10_000) });
    assert.equal(artifact.status, 200);
    const source = await artifact.text();
    assert.doesNotMatch(source, /\bsb_secret_[A-Za-z0-9_-]{15,}/);
    for (const [, payload] of source.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
      try {
        const jwt = JSON.parse(Buffer.from(payload, 'base64url').toString());
        assert.notEqual(jwt?.role, 'service_role', 'privileged JWT bundled in source');
      } catch (error) {
        if (error.name === 'AssertionError') throw error;
      }
    }
  }
  const [roster, bank, staff] = await Promise.all([
    deny('/rest/v1/cbt_students?select=id&limit=0'),
    deny('/rest/v1/cbt_question_bank?select=correct_option&limit=0'),
    deny('/rest/v1/rpc/cbt_staff', { method: 'POST', body: '{"p_action":"dashboard"}' })
  ]);
  console.log(JSON.stringify({ pages: 200, viewport: '320x640 Android Chrome emulation',
    subpath_assets: [...new Set(assetResponses.map(response => new URL(response.url()).pathname))].length,
    hash_reload: true, browser_errors: errors.length, anonymous_rest: { roster, bank, staff } }));
} finally {
  await browser.close();
}
