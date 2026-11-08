import assert from 'node:assert/strict';
import pg from 'pg';

assert.equal(process.env.CBT_TEST_DATABASE, '1', 'Run through tests/with-local-db.sh');
assert.match(process.env.PGHOST ?? '', /^\/tmp\/cbt-test\.[a-zA-Z0-9]+$/);
assert.equal(process.env.PGDATABASE, 'cbt_synthetic');

const pool = new pg.Pool({ max: Number(process.env.CBT_POOL_SIZE || 24) });
export const db = (text, values) => pool.query(text, values);
export const disconnect = () => pool.end();

async function rpc(role, statement, params, user) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(role === 'authenticated' ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE anon');
    if (user) await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: user.id, session_id: user.session_id, role: 'authenticated' })
    ]);
    const { rows: [{ response }] } = await client.query(statement, params);
    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const staff = (user, action, data = {}) => rpc(user ? 'authenticated' : 'anon',
  'SELECT public.cbt_staff($1::text, $2::jsonb) AS response', [action, JSON.stringify(data)], user);

export const login = (identity, token, device) => rpc('anon',
  'SELECT public.cbt_student_login($1::text, $2::text, $3::uuid) AS response', [identity, token, device]);

export const student = (session, action, data = {}) => rpc('anon',
  'SELECT public.cbt_student($1::text, $2::text, $3::jsonb) AS response', [session, action, JSON.stringify(data)]);

export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function state(result, expected) {
  assert.equal(result?.ok, true, `expected success, received ${result?.code ?? result?.status ?? 'error'}`);
  if (expected) assert.equal(result.status, expected);
  assert.doesNotMatch(JSON.stringify(result), /"(?:correct_option|correct_count|wrong_count|blank_count|token_hash|question_id)"\s*:/);
  return result;
}

export async function rejected(action) {
  try {
    const result = await action();
    assert.equal(result?.ok, false, 'unexpected operation success');
  } catch (error) {
    if (!['42501', '22023', 'P0001', '23P01', '23514', '23505'].includes(error.code)) throw error;
  }
}
