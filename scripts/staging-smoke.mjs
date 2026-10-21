import assert from 'node:assert/strict';
const base = new URL(process.env.STAGING_URL ?? 'http://127.0.0.1:3000');
if (base.username || base.password || base.search || base.hash)
  throw new Error('Use a bare origin without secrets');
for (const [path, status] of [
  ['/health/live', 200],
  ['/health/ready', 200],
  ['/openapi.json', 200],
  ['/v1/me', 401],
  ['/v1/admin/analytics', 401],
]) {
  const r = await fetch(new URL(path, base), {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  assert.equal(r.status, status);
}
console.log(
  'Health, contract and protected-route smoke passed; authenticated clinical E2E requires operator fixtures.',
);
