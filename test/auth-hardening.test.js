// Production hardening: sign-in throttling, the development helper's gate, refusing to start a production server with
// development leftovers, and security headers.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { clientAddress, createLoginThrottle } from '../login-throttle.js';
import { checkProductionConfig } from '../production-checks.js';

let dir;
const servers = [];

before(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-hardening-')); });
after(async () => {
  for (const running of servers) {
    running.server.closeAllConnections?.();
    await new Promise((resolve) => running.server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
});

async function boot(options = {}) {
  const running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, `${servers.length}.json`), ...options });

  servers.push(running);
  const base = `http://127.0.0.1:${running.address.port}`;
  const call = async (method, route, payload, token, headers = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };

  return { call, running };
}

const PASSWORD = 'Correct horse 456';

test('throttle: counts failures per key inside a sliding window and unlocks when they age out', () => {
  let clock = 1_000_000;
  const throttle = createLoginThrottle({ maxAttempts: 3, windowMs: 60_000, now: () => clock });
  const keys = ['acct:a@x.test', 'ip:1.1.1.1'];

  assert.equal(throttle.check(keys).allowed, true);
  throttle.fail(keys); clock += 10_000;
  throttle.fail(keys); clock += 10_000;
  assert.equal(throttle.check(keys).allowed, true, 'two failures are still allowed');
  throttle.fail(keys);
  const locked = throttle.check(keys);

  assert.equal(locked.allowed, false);
  assert.equal(locked.retryAfterSeconds, 40, 'unlocks when the oldest failure leaves the window');
  clock += 40_001;
  assert.equal(throttle.check(keys).allowed, true);
  assert.equal(throttle.check(['acct:other@x.test']).allowed, true, 'another account is unaffected');
});

test('throttle: clear() resets an account, address limits are looser, and memory stays bounded', () => {
  const throttle = createLoginThrottle({ maxAttempts: 2, windowMs: 60_000, now: () => 5 });

  throttle.fail(['acct:a']); throttle.fail(['acct:a']);
  assert.equal(throttle.check(['acct:a']).allowed, false);
  throttle.clear(['acct:a']);
  assert.equal(throttle.check(['acct:a']).allowed, true);
  for (let i = 0; i < 9; i += 1) throttle.fail(['ip:9.9.9.9']);
  assert.equal(throttle.check(['ip:9.9.9.9']).allowed, true, 'an address may fail 5x the per-account limit (shared offices)');
  throttle.fail(['ip:9.9.9.9']);
  assert.equal(throttle.check(['ip:9.9.9.9']).allowed, false);

  const small = createLoginThrottle({ maxKeys: 100, now: () => 1 });

  for (let i = 0; i < 1000; i += 1) small.fail([`acct:${i}`]);
  assert.ok(small.size() <= 100, `kept ${small.size()} keys`);
});

test('clientAddress trusts X-Forwarded-For only when told to', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } };

  assert.equal(clientAddress(req, false), '10.0.0.1');
  assert.equal(clientAddress(req, true), '203.0.113.7');
  assert.equal(clientAddress({ headers: {}, socket: {} }, true), 'unknown');
});

test('sign-in lockout: /api/auth/login and /token refuse after repeated failures, even with the right password', async () => {
  let clock = Date.now();
  const { call } = await boot({ loginThrottle: createLoginThrottle({ maxAttempts: 3, windowMs: 60_000, now: () => clock }) });

  await call('POST', '/api/auth/register', { email: 'lock@example.test', password: PASSWORD });
  await call('POST', '/api/auth/register', { email: 'bystander@example.test', password: PASSWORD });
  for (let i = 0; i < 3; i += 1) assert.equal((await call('POST', '/api/auth/login', { email: 'lock@example.test', password: `wrong-${i}` })).status, 401);
  const refused = await call('POST', '/api/auth/login', { email: 'lock@example.test', password: PASSWORD });

  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  const viaToken = await call('POST', '/token?grant_type=password', { email: 'lock@example.test', password: PASSWORD });

  assert.equal(viaToken.status, 429, 'the same lock applies to the GoTrue-style route');
  assert.equal(viaToken.body.error_code, 'over_request_rate_limit');
  assert.equal((await call('POST', '/api/auth/login', { email: 'bystander@example.test', password: PASSWORD })).status, 200, 'other accounts can still sign in');
  clock += 61_000;
  assert.equal((await call('POST', '/api/auth/login', { email: 'lock@example.test', password: PASSWORD })).status, 200, 'the lock expires');
});

test('a successful sign-in clears the account counter, so occasional typos never accumulate', async () => {
  const { call } = await boot({ loginThrottle: createLoginThrottle({ maxAttempts: 3, windowMs: 60_000 }) });

  await call('POST', '/api/auth/register', { email: 'typo@example.test', password: PASSWORD });
  for (let round = 0; round < 4; round += 1) {
    assert.equal((await call('POST', '/api/auth/login', { email: 'typo@example.test', password: 'wrong' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { email: 'typo@example.test', password: 'wrong2' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { email: 'typo@example.test', password: PASSWORD })).status, 200, `round ${round}`);
  }
});

test('guessing the current password through change-password, or invite codes, is throttled too', async () => {
  const { call } = await boot({ loginThrottle: createLoginThrottle({ maxAttempts: 3, windowMs: 60_000 }) });
  const session = (await call('POST', '/signup', { email: 'pwguess@example.test', password: PASSWORD })).body;
  const attempt = (current) => call('POST', '/user/change-password', { password: 'New password 123', current_password: current }, session.access_token);

  for (let i = 0; i < 3; i += 1) assert.equal((await attempt(`wrong-${i}`)).status, 400);
  assert.equal((await attempt(PASSWORD)).status, 429);

  const joiner = (await call('POST', '/signup', { email: 'codeguess@example.test', password: PASSWORD })).body;

  for (let i = 0; i < 3; i += 1) assert.equal((await call('GET', `/api/invite-code-info?code=NOPE${i}`, undefined, joiner.access_token)).status, 400);
  assert.equal((await call('GET', '/api/invite-code-info?code=NOPE9', undefined, joiner.access_token)).status, 429);
  assert.equal((await call('POST', '/api/workspace/join-by-invite-code', { code: 'NOPE' }, joiner.access_token)).status, 429, 'joining shares the same budget');
});

test('the development membership helper does not exist unless a key is configured, and has no default key', async () => {
  const none = await boot();
  const owner = (await none.call('POST', '/signup', { email: 'dev-owner@example.test', password: PASSWORD })).body.access_token;
  const other = await none.call('POST', '/api/auth/register', { email: 'dev-other@example.test', password: PASSWORD });
  const workspaceId = (await none.call('GET', '/api/user/workspace', undefined, owner)).body.data.visiting_workspace.workspace_id;
  const add = (headers) => none.call('POST', `/api/workspaces/${workspaceId}/test-members`, { email: 'dev-other@example.test' }, owner, headers);

  assert.equal(other.status, 201);
  for (const headers of [{}, { 'x-development-key': '' }, { 'x-development-key': 'development-only-key' }]) {
    const denied = await add(headers);

    assert.equal(denied.status, 403, JSON.stringify(headers));
    assert.equal(denied.body.error.code, 'TEST_HELPER_DISABLED');
  }
  const configured = await boot({ devKey: 'secret-dev-key' });
  const owner2 = (await configured.call('POST', '/signup', { email: 'dev-owner2@example.test', password: PASSWORD })).body.access_token;

  await configured.call('POST', '/api/auth/register', { email: 'dev-other2@example.test', password: PASSWORD });
  const ws2 = (await configured.call('GET', '/api/user/workspace', undefined, owner2)).body.data.visiting_workspace.workspace_id;
  const add2 = (headers) => configured.call('POST', `/api/workspaces/${ws2}/test-members`, { email: 'dev-other2@example.test' }, owner2, headers);

  assert.equal((await add2({})).status, 403);
  assert.equal((await add2({ 'x-development-key': 'wrong' })).status, 403);
  assert.equal((await add2({ 'x-development-key': 'secret-dev-key' })).status, 201);
});

test('production refuses development leftovers and warns about the rest', async () => {
  const bad = checkProductionConfig({ env: {}, storage: 'json', devKey: 'k', corsOrigins: ['http://localhost:3000'] });

  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors.join(' '), /DEV_TEST_KEY/);
  assert.match(bad.errors.join(' '), /STORAGE=postgres/);
  assert.equal(bad.warnings.length, 5, bad.warnings.join('\n'));
  const good = checkProductionConfig({ env: { AI_KEY_SECRET: 's', SIGNUP_ENABLED: 'false', TRUST_PROXY: 'true', SMTP_HOST: 'smtp.acme.io' }, storage: 'postgres', devKey: '', corsOrigins: ['https://tracker.example.com'] });

  assert.deepEqual(good, { errors: [], warnings: [] });
  assert.deepEqual(checkProductionConfig({ env: { ALLOW_JSON_STORAGE: 'true' }, storage: 'json', devKey: '' }).errors, []);

  await assert.rejects(boot({ environment: 'production' }), /Refusing to start in production[\s\S]*STORAGE=postgres/);
  await assert.rejects(boot({ environment: 'production', devKey: 'x' }), /DEV_TEST_KEY/);
});

test('API responses carry security headers', async () => {
  const { call } = await boot();
  const response = await call('GET', '/api/server-info');

  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('strict-transport-security'), null, 'HSTS is opt-in (HSTS=true)');
});
