// GoTrue-compatible account routes the web client calls directly: /settings, /signup, /user, /user/change-password,
// plus the sign-up policy (disabled, or limited to company e-mail domains).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

const servers = [];
let dir;

async function boot(extra = {}) {
  const running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, `${servers.length}.json`), devKey: 'test-key', ...extra });

  servers.push(running);
  const base = `http://127.0.0.1:${running.address.port}`;
  const call = async (method, route, payload, token) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  return { call, running };
}

before(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-gotrue-')); });
after(async () => {
  for (const running of servers) {
    running.server.closeAllConnections?.();
    await new Promise((resolve) => running.server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
});

const PASSWORD = 'Correct horse 456';
const login = (call, email, password) => call('POST', '/token?grant_type=password', { email, password });

test('settings advertise e-mail sign-in and open sign-up by default', async () => {
  const { call } = await boot();
  const settings = (await call('GET', '/settings')).body;

  assert.equal(settings.disable_signup, false);
  assert.equal(settings.mailer_autoconfirm, true);
  assert.equal(settings.external.email, true);
  assert.equal(settings.external.google, false);
});

test('sign-up creates the account and workspace and signs the person in; an existing e-mail is not revealed', async () => {
  const { call } = await boot();
  const created = await call('POST', '/signup', { email: ' New.Person@Example.test ', password: PASSWORD });

  assert.equal(created.status, 200);
  assert.ok(created.body.access_token && created.body.refresh_token);
  assert.equal(created.body.user.email, 'new.person@example.test');
  const workspaces = await call('GET', '/api/user/workspace', undefined, created.body.access_token);

  assert.equal(workspaces.status, 200);
  assert.ok(workspaces.body.data.visiting_workspace.workspace_id);
  assert.equal((await login(call, 'new.person@example.test', PASSWORD)).status, 200);
  const again = await call('POST', '/signup', { email: 'new.person@example.test', password: 'Another pass 789' });

  assert.equal(again.status, 200);
  assert.deepEqual(again.body.identities, []);
  assert.equal(again.body.access_token, undefined);
  assert.equal((await login(call, 'new.person@example.test', 'Another pass 789')).status, 400, 'the existing password is untouched');
  for (const bad of [{}, { email: 'nope', password: PASSWORD }, { email: 'a@b.test', password: 'short' }, { email: 'a@b.test' }]) {
    assert.equal((await call('POST', '/signup', bad)).status, 422, JSON.stringify(bad));
  }
});

test('sign-up can be switched off, or limited to company domains, on both sign-up routes', async () => {
  const closed = await boot({ signupEnabled: false });

  assert.equal((await closed.call('GET', '/settings')).body.disable_signup, true);
  assert.equal((await closed.call('POST', '/signup', { email: 'x@example.test', password: PASSWORD })).status, 403);
  assert.equal((await closed.call('POST', '/api/auth/register', { email: 'x@example.test', password: PASSWORD })).status, 403);

  const limited = await boot({ signupAllowedDomains: ['@Company.test', 'corp.test'] });

  assert.equal((await limited.call('POST', '/signup', { email: 'a@gmail.test', password: PASSWORD })).status, 403);
  assert.equal((await limited.call('POST', '/api/auth/register', { email: 'a@gmail.test', password: PASSWORD })).status, 403);
  assert.equal((await limited.call('POST', '/signup', { email: 'a@company.test', password: PASSWORD })).status, 200);
  assert.equal((await limited.call('POST', '/api/auth/register', { email: 'b@corp.test', password: PASSWORD })).status, 201);
  assert.equal((await limited.call('POST', '/signup', { email: 'a@company.test.evil.test', password: PASSWORD })).status, 403, 'a suffix match is not a domain match');
});

test('change-password needs the current password, then signs every other device out', async () => {
  const { call } = await boot();
  const first = (await call('POST', '/signup', { email: 'pw@example.test', password: PASSWORD })).body;
  const second = (await login(call, 'pw@example.test', PASSWORD)).body;

  assert.equal((await call('POST', '/user/change-password', { password: 'New password 123', current_password: PASSWORD })).status, 401, 'signed in is required');
  assert.equal((await call('POST', '/user/change-password', { password: 'New password 123', current_password: 'wrong' }, first.access_token)).status, 400);
  assert.equal((await call('POST', '/user/change-password', { password: 'New password 123' }, first.access_token)).status, 400, 'the current password is required');
  assert.equal((await call('POST', '/user/change-password', { password: 'short', current_password: PASSWORD }, first.access_token)).status, 422);
  assert.equal((await call('POST', '/user/change-password', { password: 'New password 123', current_password: PASSWORD }, first.access_token)).status, 200);
  assert.equal((await login(call, 'pw@example.test', PASSWORD)).status, 400, 'the old password stops working');
  assert.equal((await login(call, 'pw@example.test', 'New password 123')).status, 200);
  assert.equal((await call('GET', '/user', undefined, first.access_token)).status, 200, 'the session that changed it stays');
  assert.equal((await call('GET', '/user', undefined, second.access_token)).status, 401, 'other sessions are signed out');
});

test('GET /user/auth-info reports a chosen password for signed-in people only', async () => {
  const { call } = await boot();
  const session = (await call('POST', '/signup', { email: 'info@example.test', password: PASSWORD })).body;

  assert.deepEqual((await call('GET', '/user/auth-info', undefined, session.access_token)).body, { has_password: true, is_sso_user: false, is_non_default_password: true });
  assert.equal((await call('GET', '/user/auth-info')).status, 401);
});

test('GET and PUT /user: identity, and setting a password from a recovery session', async () => {
  const { call } = await boot();
  const session = (await call('POST', '/signup', { email: 'me@example.test', password: PASSWORD })).body;
  const me = await call('GET', '/user', undefined, session.access_token);

  assert.equal(me.body.email, 'me@example.test');
  assert.equal((await call('GET', '/user')).status, 401);
  assert.equal((await call('PUT', '/user', { password: 'x' }, session.access_token)).status, 422);
  assert.equal((await call('PUT', '/user', { password: 'Brand new pass 1' }, session.access_token)).status, 200);
  assert.equal((await login(call, 'me@example.test', 'Brand new pass 1')).status, 200);
});
