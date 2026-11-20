// Outgoing e-mail: the SMTP wrapper, invitations (and joining through them), password recovery and sign-in codes,
// notification e-mails with one-click unsubscribe, and the admin status/test routes. A recording transport stands in
// for SMTP, so nothing leaves the machine.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { createMailer, isDeliverableAddress, mailerSettings } from '../mailer.js';
import { createAuthCodes } from '../auth-codes.js';
import { parseEnv } from '../env-file.js';

let dir;
const servers = [];

before(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-email-')); });
after(async () => {
  for (const running of servers) {
    running.server.closeAllConnections?.();
    await new Promise((resolve) => running.server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
});

const PASSWORD = 'Correct horse 456';
const ENV = { SMTP_HOST: 'smtp.test-host.io', SMTP_PORT: '587', SMTP_USER: 'robot@acme-widgets.io', SMTP_PASS: 'super-secret-pass', EMAIL_FROM: 'tracker@acme-widgets.io' };

function recordingTransport({ fail = false } = {}) {
  const sent = [];

  return { sent, sendMail: async (message) => { if (fail) throw new Error('535 auth failed for super-secret-pass'); sent.push(message); return { messageId: String(sent.length) }; }, verify: async () => true };
}

async function boot(extra = {}) {
  const transport = extra.transport ?? recordingTransport();
  const mailer = extra.mailer ?? createMailer({ env: ENV, transport, logger: { log() {}, warn() {} } });
  const running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, `${servers.length}.json`), devKey: 'email-key', mailer, publicUrl: 'https://tracker.acme-widgets.io', ...extra.options });

  servers.push(running);
  const base = `http://127.0.0.1:${running.address.port}`;
  const call = async (method, route, payload, token) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method === 'POST' || method === 'PUT' ? {} : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
    let parsed = null;

    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed, text };
  };

  return { call, transport, mailer, running, base };
}

async function signup(env, email) {
  const response = await env.call('POST', '/signup', { email, password: PASSWORD });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const token = response.body.access_token;
  const workspaceId = (await env.call('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;

  return { email, token, workspaceId, userId: response.body.user.id };
}

const codeFrom = (message) => /\b(\d{6})\b/.exec(message.text)[1];

test('mailer: settings, aliases, disabled mode, skipped addresses and secret hygiene', async () => {
  assert.deepEqual(mailerSettings({ BROADCAST_SMTP_HOST: 'smtp.alias.io', BROADCAST_SMTP_PORT: '465', BROADCAST_SMTP_USER: 'u@alias.io', BROADCAST_SMTP_PASS: 'p', BROADCAST_EMAIL_FROM: 'from@alias.io' }), { host: 'smtp.alias.io', port: 465, user: 'u@alias.io', pass: 'p', from: 'from@alias.io', fromName: 'Workzen', secure: true });
  assert.equal(mailerSettings({ SMTP_HOST: 'h', SMTP_USER: 'robot@x.io' }).from, 'robot@x.io', 'falls back to the SMTP user');
  const off = createMailer({ env: {} });

  assert.equal(off.enabled, false);
  assert.deepEqual(await off.send({ to: 'a@acme-widgets.io', subject: 's', text: 't' }), { sent: false, reason: 'not_configured' });
  assert.deepEqual(await off.verify(), { ok: false, reason: 'not_configured' });

  const transport = recordingTransport();
  const mailer = createMailer({ env: ENV, transport, logger: { log() {}, warn() {} } });

  assert.equal(JSON.stringify(mailer.describe()).includes('super-secret-pass'), false, 'the password is never described');
  assert.equal(mailer.describe().user, 'r***@acme-widgets.io');
  assert.deepEqual(await mailer.send({ to: 'ann@acme-widgets.io', subject: 'Hello', text: 'Hi' }), { sent: true });
  assert.equal(transport.sent[0].from, '"Workzen" <tracker@acme-widgets.io>');
  for (const address of ['a@example.com', 'a@x.test', 'a@foo.example', 'a@bar.invalid', 'a@localhost', 'a@corp.local', 'not-an-address', '']) {
    assert.equal(isDeliverableAddress(address), false, address);
    assert.equal((await mailer.send({ to: address, subject: 's', text: 't' })).reason, 'undeliverable_address', address);
  }
  assert.equal(isDeliverableAddress('ann@acme-widgets.io'), true);
  assert.equal(transport.sent.length, 1, 'nothing was sent to a skipped address');

  const failing = createMailer({ env: ENV, transport: recordingTransport({ fail: true }), logger: { log() {}, warn() {} } });
  const result = await failing.send({ to: 'ann@acme-widgets.io', subject: 's', text: 't' });

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'smtp_error');
  assert.equal(result.message.includes('super-secret-pass'), false, 'a failure message never carries the password');
});

test('e-mail bodies escape everything interpolated', async () => {
  const { inviteEmail, notificationEmail } = await import('../email-templates.js');
  const invite = inviteEmail({ inviterName: '<img src=x onerror=alert(1)>', workspaceName: 'A & B "team"', signupUrl: 'https://x.io/login?a=1&b=2' });

  // the only <img> allowed is the fixed inline logo; the injected one must be escaped
  assert.deepEqual(invite.html.match(/<img[^>]*>/g), ['<img src="cid:workzen-logo" alt="workzen" width="140" style="display:block;border:0;height:auto">']);
  assert.match(invite.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(invite.html, /A &amp; B &quot;team&quot;/);
  assert.match(invite.html, /a=1&amp;b=2/);
  assert.equal(notificationEmail({ type: 'mention', actorName: '<script>', pageName: '</p><b>', url: 'https://x.io', workspaceName: 'W' }).html.includes('<script>'), false);
});

test('env file parser: comments, quotes and export are handled', () => {
  assert.deepEqual(parseEnv('# c\nA=1\n  B = two words \nexport C="quoted value"\nD=\'single\'\n\nnot a line\n#E=ignored'), { A: '1', B: 'two words', C: 'quoted value', D: 'single' });
});

test('one-time codes: single use, expiry, attempt limit, resend cooldown and hourly cap', () => {
  let clock = 1_000_000;
  const codes = createAuthCodes({ now: () => clock });
  const first = codes.issue('a@x.io', 'recovery');

  assert.match(first.code, /^\d{6}$/);
  assert.equal(codes.verify('a@x.io', 'magiclink', first.code), false, 'a code is bound to its purpose');
  assert.equal(codes.verify('b@x.io', 'recovery', first.code), false, 'and to its address');
  assert.equal(codes.verify('a@x.io', 'recovery', first.code), true);
  assert.equal(codes.verify('a@x.io', 'recovery', first.code), false, 'single use');

  clock += 61_000;
  const second = codes.issue('a@x.io', 'recovery');

  for (let i = 0; i < 5; i += 1) assert.equal(codes.verify('a@x.io', 'recovery', '000000' === second.code ? '111111' : '000000'), false);
  assert.equal(codes.verify('a@x.io', 'recovery', second.code), false, 'five wrong guesses kill the code');

  clock += 61_000;
  const third = codes.issue('a@x.io', 'recovery');

  clock += 10 * 60_000 + 1;
  assert.equal(codes.verify('a@x.io', 'recovery', third.code), false, 'expired');
  assert.equal(codes.issue('c@x.io', 'recovery').code.length, 6);
  assert.equal(codes.issue('c@x.io', 'recovery').limited, true, 'one per minute');
  assert.ok(codes.issue('c@x.io', 'recovery').retryAfterSeconds > 0);
  for (let i = 0; i < 4; i += 1) { clock += 61_000; codes.issue('d@x.io', 'recovery'); }
  clock += 61_000;
  assert.equal(codes.issue('d@x.io', 'recovery').code.length, 6);
  clock += 61_000;
  assert.equal(codes.issue('d@x.io', 'recovery').limited, true, 'five per hour');
});

test('forgotten password: the code arrives by e-mail, resets the password once, and nothing reveals who has an account', async () => {
  const env = await boot();
  const person = await signup(env, 'dana@acme-widgets.io');

  assert.equal((await env.call('POST', '/recover', { email: 'dana@acme-widgets.io' })).status, 200);
  assert.equal(env.transport.sent.length, 1);
  assert.equal(env.transport.sent[0].to, 'dana@acme-widgets.io');
  assert.match(env.transport.sent[0].subject, /password reset code/);
  const code = codeFrom(env.transport.sent[0]);

  assert.equal((await env.call('POST', '/verify', { email: 'dana@acme-widgets.io', token: code === '000000' ? '111111' : '000000', type: 'recovery' })).status, 403);
  assert.equal((await env.call('POST', '/verify', { email: 'dana@acme-widgets.io', token: code, type: 'magiclink' })).status, 403, 'a recovery code cannot sign in as a magic link');
  const session = await env.call('POST', '/verify', { email: 'dana@acme-widgets.io', token: code, type: 'recovery' });

  assert.equal(session.status, 200, JSON.stringify(session.body));
  assert.ok(session.body.access_token && session.body.refresh_token);
  assert.equal((await env.call('POST', '/verify', { email: 'dana@acme-widgets.io', token: code, type: 'recovery' })).status, 403, 'single use');
  assert.equal((await env.call('PUT', '/user', { password: 'Brand new pass 1' }, session.body.access_token)).status, 200);
  assert.equal((await env.call('POST', '/token?grant_type=password', { email: 'dana@acme-widgets.io', password: 'Brand new pass 1' })).status, 200);
  assert.equal((await env.call('POST', '/token?grant_type=password', { email: 'dana@acme-widgets.io', password: PASSWORD })).status, 400, 'the old password stops working');
  assert.ok(person);

  // An unknown address gets the same answer and no e-mail; the cooldown applies to it too.
  const before = env.transport.sent.length;

  assert.equal((await env.call('POST', '/recover', { email: 'ghost@acme-widgets.io' })).status, 200);
  assert.equal(env.transport.sent.length, before);
  assert.equal((await env.call('POST', '/recover', { email: 'ghost@acme-widgets.io' })).status, 429);
  assert.equal((await env.call('POST', '/recover', { email: 'dana@acme-widgets.io' })).status, 429, 'asking again within a minute is refused');
  assert.equal((await env.call('POST', '/recover', { email: 'nope' })).status, 422);
});

test('sign-in by e-mailed code works for existing accounts only', async () => {
  const env = await boot();

  await signup(env, 'eli@acme-widgets.io');
  assert.equal((await env.call('POST', '/magiclink', { email: 'eli@acme-widgets.io' })).status, 200);
  const code = codeFrom(env.transport.sent[0]);

  assert.match(env.transport.sent[0].subject, /sign-in code/);
  const session = await env.call('POST', '/verify', { email: 'eli@acme-widgets.io', token: code, type: 'magiclink' });

  assert.equal(session.status, 200);
  assert.equal((await env.call('GET', '/user', undefined, session.body.access_token)).body.email, 'eli@acme-widgets.io');
  assert.equal((await env.call('POST', '/magiclink', { email: 'stranger@acme-widgets.io' })).status, 200);
  assert.equal(env.transport.sent.length, 1, 'no account, no e-mail');
});

test('wrong codes are throttled per address; without mail settings recovery says so', async () => {
  const env = await boot();

  await signup(env, 'fay@acme-widgets.io');
  await env.call('POST', '/recover', { email: 'fay@acme-widgets.io' });
  let last;

  for (let i = 0; i < 12; i += 1) last = await env.call('POST', '/verify', { email: 'fay@acme-widgets.io', token: '000000', type: 'recovery' });
  assert.equal(last.status, 429, 'guessing is locked out');

  const none = await boot({ mailer: createMailer({ env: {} }) });
  const disabled = await none.call('POST', '/recover', { email: 'fay@acme-widgets.io' });

  assert.equal(disabled.status, 400);
  assert.equal(disabled.body.error_code, 'email_provider_disabled');
});

test('inviting an e-mail with no account saves a pending invitation, e-mails them, and lists them as pending', async () => {
  const open = await boot();
  const owner = await signup(open, 'owner@acme-widgets.io');
  const invite = await open.call('POST', `/api/workspace/${owner.workspaceId}/invite`, [{ email: 'Newbie@acme-widgets.io' }], owner.token);

  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  assert.equal(open.transport.sent.length, 1);
  const mail = open.transport.sent[0];

  assert.equal(mail.to, 'newbie@acme-widgets.io');
  assert.match(mail.subject, /invited you to My Workspace/);
  assert.match(mail.text, /https:\/\/tracker\.acme-widgets\.io\/login\?action=signUpPassword/);
  assert.match(mail.html, /Create your account/);
  const members = (await open.call('GET', `/api/workspace/${owner.workspaceId}/member?include_pending=true`, undefined, owner.token)).body.data;

  assert.deepEqual(members.map((m) => [m.email, m.is_pending_invitation]), [['owner@acme-widgets.io', false], ['newbie@acme-widgets.io', true]]);
  assert.equal(new Set(members.map((m) => m.uid)).size, 2, 'list keys stay unique');
  assert.equal((await open.call('GET', `/api/workspace/${owner.workspaceId}/member`, undefined, owner.token)).body.data.length, 1, 'pending people are listed only when asked');
});

test('invited people can sign up while sign-up is closed, join the workspace, and strangers still cannot', async () => {
  const file = path.join(dir, 'invites.json');
  const transport = recordingTransport();
  const mailer = createMailer({ env: ENV, transport, logger: { log() {}, warn() {} } });
  const first = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file, mailer, publicUrl: 'https://tracker.acme-widgets.io' });
  const call = (running) => async (method, route, payload, token) => {
    const response = await fetch(`http://127.0.0.1:${running.address.port}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  let api = call(first);
  const owner = (await api('POST', '/signup', { email: 'boss@acme-widgets.io', password: PASSWORD })).body;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, owner.access_token)).body.data.visiting_workspace.workspace_id;

  assert.equal((await api('POST', `/api/workspace/${workspaceId}/invite`, [{ email: 'guest@acme-widgets.io' }, { email: 'second@acme-widgets.io' }], owner.access_token)).status, 200);
  assert.equal(transport.sent.length, 2);
  first.server.closeAllConnections?.();
  await new Promise((resolve) => first.server.close(resolve));
  await first.app.store.close?.();
  // Restart on the same file with sign-up closed.
  const second = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file, mailer, signupEnabled: false });

  servers.push(second);
  api = call(second);
  assert.equal((await api('POST', '/signup', { email: 'stranger@acme-widgets.io', password: PASSWORD })).status, 403, 'a stranger is still refused');
  assert.equal((await api('POST', '/api/auth/register', { email: 'stranger@acme-widgets.io', password: PASSWORD })).status, 403);
  const guest = await api('POST', '/signup', { email: 'guest@acme-widgets.io', password: PASSWORD });

  assert.equal(guest.status, 200, JSON.stringify(guest.body));
  const tree = await api('GET', `/api/workspace/${workspaceId}/view/${workspaceId}?depth=1`, undefined, guest.body.access_token);

  assert.equal(tree.status, 200, 'the invited person is a member of the inviting workspace');
  assert.equal((await api('POST', '/api/auth/register', { email: 'second@acme-widgets.io', password: PASSWORD })).status, 201, 'the register route honours invitations too');
  const members = (await api('GET', `/api/workspace/${workspaceId}/member?include_pending=true`, undefined, owner.access_token)).body.data;

  assert.deepEqual(members.map((m) => [m.email, m.is_pending_invitation]), [['boss@acme-widgets.io', false], ['guest@acme-widgets.io', false], ['second@acme-widgets.io', false]]);
  assert.equal((await api('POST', '/signup', { email: 'guest@acme-widgets.io', password: PASSWORD })).status, 403, 'an invitation is used once: signing up again with the same address is refused while sign-up is closed');
});

test('invitation problems are reported plainly: no mail settings, a mailbox that cannot exist, an SMTP failure; removing cancels', async () => {
  const none = await boot({ mailer: createMailer({ env: {} }) });
  const ownerA = await signup(none, 'o1@acme-widgets.io');
  const noMail = await none.call('POST', `/api/workspace/${ownerA.workspaceId}/invite`, [{ email: 'pal@acme-widgets.io' }], ownerA.token);

  assert.equal(noMail.body.error.code, 'EMAIL_NOT_CONFIGURED');
  assert.equal((await none.running.app.store.listWorkspaceInvitations(ownerA.workspaceId)).length, 1, 'the invitation was still saved');

  const env = await boot();
  const owner = await signup(env, 'o2@acme-widgets.io');
  const fake = await env.call('POST', `/api/workspace/${owner.workspaceId}/invite`, [{ email: 'someone@example.com' }], owner.token);

  assert.equal(fake.status, 400);
  assert.equal(fake.body.error.code, 'EMAIL_FAILED');
  assert.match(fake.body.error.message, /someone@example\.com \(not a real mailbox\)/);

  const broken = await boot({ transport: recordingTransport({ fail: true }) });
  const owner3 = await signup(broken, 'o3@acme-widgets.io');
  const failed = await broken.call('POST', `/api/workspace/${owner3.workspaceId}/invite`, [{ email: 'pal@acme-widgets.io' }], owner3.token);

  assert.equal(failed.body.error.code, 'EMAIL_FAILED');
  assert.equal(failed.text.includes('super-secret-pass'), false, 'the SMTP password never reaches the client');

  const list = () => env.running.app.store.listWorkspaceInvitations(owner.workspaceId);

  await env.call('POST', `/api/workspace/${owner.workspaceId}/invite`, [{ email: 'cancel-me@acme-widgets.io' }], owner.token);
  assert.equal((await list()).length, 2);
  assert.equal((await env.call('DELETE', `/api/workspace/${owner.workspaceId}/member`, ['cancel-me@acme-widgets.io'], owner.token)).status, 200);
  assert.deepEqual((await list()).map((invitation) => invitation.email), ['someone@example.com']);
});

test('notification e-mails: sent for mentions when enabled, once per page per 5 minutes, never to oneself, with a working unsubscribe', async () => {
  const env = await boot({ options: { emailNotifications: true } });
  const owner = await signup(env, 'lead@acme-widgets.io');
  const pal = await signup(env, 'pal@acme-widgets.io');
  const invite = (await env.call('POST', `/api/workspace/${owner.workspaceId}/invite-code`, {}, owner.token)).body.data.code;

  assert.equal((await env.call('POST', '/api/workspace/join-by-invite-code', { code: invite }, pal.token)).status, 200);
  const spaceId = crypto.randomUUID();
  const pageId = crypto.randomUUID();

  await env.call('POST', `/api/workspace/${owner.workspaceId}/spaces`, { name: 'S', view_id: spaceId, permission: { visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null, invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false, security: { disable_guests: false, disable_public_links: false, disable_export: false } } }, owner.token);
  await env.call('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, { schema_version: 'v1', request_id: crypto.randomUUID(), view_id: pageId, parent_view_id: spaceId, name: 'Roadmap', position: { kind: 'start' } }, owner.token);
  const route = `/api/workspace/${owner.workspaceId}/document/${pageId}/inline-comment/v2`;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal((await env.call('POST', route, { content: 'ping', block_id: 'b1', mentioned_user_uuids: [pal.userId] }, owner.token)).status, 200);
  await settle();
  assert.equal(env.transport.sent.length, 1);
  const mail = env.transport.sent[0];

  assert.equal(mail.to, 'pal@acme-widgets.io');
  assert.match(mail.subject, /mentioned you in "Roadmap"/);
  assert.match(mail.text, new RegExp(`https://tracker\\.acme-widgets\\.io/app/${owner.workspaceId}/${pageId}`));
  assert.match(mail.text, /\/api\/email\/unsubscribe\?u=/);
  assert.equal((await env.call('POST', route, { content: 'again', block_id: 'b2', mentioned_user_uuids: [pal.userId] }, owner.token)).status, 200);
  await settle();
  assert.equal(env.transport.sent.length, 1, 'a second mention on the same page within 5 minutes is not e-mailed again');
  assert.equal((await env.call('POST', route, { content: 'note to self', block_id: 'b3', mentioned_user_uuids: [owner.userId] }, owner.token)).status, 200);
  await settle();
  assert.equal(env.transport.sent.length, 1, 'never e-mailed about your own comment');

  // The unsubscribe link: bad signature refused, good signature turns it off for good.
  const link = /(https:\/\/tracker\.acme-widgets\.io)(\/api\/email\/unsubscribe\?u=[^\s]+)/.exec(mail.text)[2];
  const bad = await fetch(`${env.base}${link.replace(/s=.{6}/, 's=AAAAAA')}`);

  assert.equal(bad.status, 400);
  const good = await fetch(`${env.base}${link}`);

  assert.equal(good.status, 200);
  assert.match(await good.text(), /unsubscribed/);
  assert.equal(good.headers.get('x-content-type-options'), 'nosniff');
  const page2 = crypto.randomUUID();

  await env.call('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, { schema_version: 'v1', request_id: crypto.randomUUID(), view_id: page2, parent_view_id: spaceId, name: 'Other', position: { kind: 'start' } }, owner.token);
  await env.call('POST', `/api/workspace/${owner.workspaceId}/document/${page2}/inline-comment/v2`, { content: 'ping', block_id: 'b1', mentioned_user_uuids: [pal.userId] }, owner.token);
  await settle();
  assert.equal(env.transport.sent.length, 1, 'after unsubscribing, no more notification e-mails');
  assert.equal((await env.call('GET', `/api/workspace/${owner.workspaceId}/notifications`, undefined, pal.token)).body.data.notifications.length, 3, 'the in-app inbox is unaffected');
});

test('notification e-mails are off unless enabled, and skipped for addresses that cannot receive mail', async () => {
  const off = await boot();
  const owner = await signup(off, 'a1@acme-widgets.io');
  const pal = await signup(off, 'a2@acme-widgets.io');

  await off.call('POST', '/api/workspace/join-by-invite-code', { code: (await off.call('POST', `/api/workspace/${owner.workspaceId}/invite-code`, {}, owner.token)).body.data.code }, pal.token);
  const spaceId = crypto.randomUUID();
  const pageId = crypto.randomUUID();

  await off.call('POST', `/api/workspace/${owner.workspaceId}/spaces`, { name: 'S', view_id: spaceId, permission: { visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null, invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false, security: { disable_guests: false, disable_public_links: false, disable_export: false } } }, owner.token);
  await off.call('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, { schema_version: 'v1', request_id: crypto.randomUUID(), view_id: pageId, parent_view_id: spaceId, name: 'P', position: { kind: 'start' } }, owner.token);
  await off.call('POST', `/api/workspace/${owner.workspaceId}/document/${pageId}/inline-comment/v2`, { content: 'hi', block_id: 'b', mentioned_user_uuids: [pal.userId] }, owner.token);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(off.transport.sent.length, 0, 'EMAIL_NOTIFICATIONS is off by default');
});

test('admin e-mail status and test routes: owners and admins only, no secrets, rate limited', async () => {
  const env = await boot();
  const owner = await signup(env, 'admin1@acme-widgets.io');
  const pal = await signup(env, 'pal9@acme-widgets.io');

  await env.call('POST', '/api/workspace/join-by-invite-code', { code: (await env.call('POST', `/api/workspace/${owner.workspaceId}/invite-code`, {}, owner.token)).body.data.code }, pal.token);
  const status = await env.call('GET', `/api/workspace/${owner.workspaceId}/email-status`, undefined, owner.token);

  assert.equal(status.status, 200);
  assert.deepEqual([status.body.data.enabled, status.body.data.host, status.body.data.from, status.body.data.public_url, status.body.data.connection], [true, 'smtp.test-host.io', 'tracker@acme-widgets.io', 'https://tracker.acme-widgets.io', { ok: true }]);
  assert.equal(status.text.includes('super-secret-pass'), false);
  assert.equal((await env.call('GET', `/api/workspace/${owner.workspaceId}/email-status`, undefined, pal.token)).status, 403);
  assert.equal((await env.call('POST', `/api/workspace/${owner.workspaceId}/email-test`, { to: 'x@acme-widgets.io' }, pal.token)).status, 403);
  const sent = await env.call('POST', `/api/workspace/${owner.workspaceId}/email-test`, { to: 'checker@acme-widgets.io' }, owner.token);

  assert.deepEqual([sent.status, sent.body.data], [200, { sent: true, to: 'checker@acme-widgets.io' }]);
  assert.equal(env.transport.sent.at(-1).subject, 'Test e-mail from Workzen');
  assert.equal((await env.call('POST', `/api/workspace/${owner.workspaceId}/email-test`, { to: 'x@example.com' }, owner.token)).body.error.code, 'UNDELIVERABLE_ADDRESS');
  assert.equal((await env.call('POST', `/api/workspace/${owner.workspaceId}/email-test`, { to: 'not-an-email' }, owner.token)).status, 400);
  for (let i = 0; i < 2; i += 1) await env.call('POST', `/api/workspace/${owner.workspaceId}/email-test`, { to: 'checker@acme-widgets.io' }, owner.token);
  assert.equal((await env.call('POST', `/api/workspace/${owner.workspaceId}/email-test`, { to: 'checker@acme-widgets.io' }, owner.token)).status, 200);
  assert.equal((await env.call('POST', `/api/workspace/${owner.workspaceId}/email-test`, { to: 'checker@acme-widgets.io' }, owner.token)).status, 429);
  const none = await boot({ mailer: createMailer({ env: {} }) });
  const o = await signup(none, 'noemail@acme-widgets.io');

  assert.equal((await none.call('POST', `/api/workspace/${o.workspaceId}/email-test`, {}, o.token)).body.error.code, 'EMAIL_NOT_CONFIGURED');
  assert.equal((await none.call('GET', `/api/workspace/${o.workspaceId}/email-status`, undefined, o.token)).body.data.enabled, false);
});

test('e-mails carry the workzen logo as an inline attachment, only when the html uses it', async () => {
  const { createMailer } = await import('../mailer.js');
  const { testEmail } = await import('../email-templates.js');
  const sent = [];
  const mailer = createMailer({ env: { SMTP_HOST: 'smtp.acme-widgets.io', EMAIL_FROM: 'noreply@acme-widgets.io' }, transport: { sendMail: async (message) => { sent.push(message); } }, logger: { log() {}, warn() {} } });

  await mailer.send({ to: 'person@acme-widgets.io', ...testEmail({ workspaceName: 'W' }) });
  await mailer.send({ to: 'person@acme-widgets.io', subject: 's', text: 't', html: '<p>no logo</p>' });

  assert.equal(sent[0].attachments?.length, 1);
  assert.equal(sent[0].attachments[0].cid, 'workzen-logo');
  assert.equal((await import('node:fs')).existsSync(sent[0].attachments[0].path), true);
  assert.equal(sent[1].attachments, undefined);
});
