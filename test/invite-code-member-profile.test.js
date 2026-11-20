// Workspace invite links (GET/POST/DELETE /invite-code, POST /join-by-invite-code,
// GET /invite-code-info), the members list, and the per-workspace member profile
// (PUT /update-member-profile). All of these 404'd before, which broke the
// Members panel, the /app/invited/:code landing page and profile editing.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

let dir, running, base;

async function api(method, route, payload, token) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-invite-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function account(label) {
  const email = `${label}@example.test`;
  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;

  return { email, token, workspaceId };
}

const inviteUrl = (workspaceId) => `/api/workspace/${workspaceId}/invite-code`;

test('an owner creates, reads, replaces and deletes the invite code', async () => {
  const owner = await account('invite-owner');

  assert.deepEqual((await api('GET', inviteUrl(owner.workspaceId), undefined, owner.token)).body.data, { code: null });
  const created = await api('POST', inviteUrl(owner.workspaceId), { validity_period_hours: null }, owner.token);
  assert.equal(created.status, 200);
  assert.match(created.body.data.code, /^[A-Z2-9]{10}$/);
  assert.equal((await api('GET', inviteUrl(owner.workspaceId), undefined, owner.token)).body.data.code, created.body.data.code);

  const replaced = await api('POST', inviteUrl(owner.workspaceId), { validity_period_hours: 24 }, owner.token);
  assert.notEqual(replaced.body.data.code, created.body.data.code);
  assert.equal((await api('GET', inviteUrl(owner.workspaceId), undefined, owner.token)).body.data.code, replaced.body.data.code);

  assert.equal((await api('DELETE', inviteUrl(owner.workspaceId), undefined, owner.token)).status, 200);
  assert.deepEqual((await api('GET', inviteUrl(owner.workspaceId), undefined, owner.token)).body.data, { code: null });
});

test('invite code validation and access rules', async () => {
  const owner = await account('invite-rules-owner');
  const stranger = await account('invite-rules-stranger');

  for (const bad of [0, -1, 'soon', 24 * 365 + 1]) {
    assert.equal((await api('POST', inviteUrl(owner.workspaceId), { validity_period_hours: bad }, owner.token)).status, 400, String(bad));
  }
  assert.equal((await api('GET', inviteUrl(owner.workspaceId))).status, 401);
  assert.equal((await api('GET', inviteUrl(owner.workspaceId), undefined, stranger.token)).status, 403);
  assert.equal((await api('POST', inviteUrl(owner.workspaceId), {}, stranger.token)).status, 403);
});

test('a code shows workspace info, can be joined once, and lists the new member', async () => {
  const owner = await account('invite-join-owner');
  const joiner = await account('invite-join-joiner');
  const { code } = (await api('POST', inviteUrl(owner.workspaceId), {}, owner.token)).body.data;

  const info = await api('GET', `/api/invite-code-info?code=${code}`, undefined, joiner.token);
  assert.equal(info.status, 200);
  assert.equal(info.body.data.workspace_id, owner.workspaceId);
  assert.equal(info.body.data.is_member, false);
  assert.equal(info.body.data.member_count, 1);
  assert.equal(info.body.data.owner_name, owner.email);

  const joined = await api('POST', '/api/workspace/join-by-invite-code', { code }, joiner.token);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.data.workspace_id, owner.workspaceId);
  assert.equal((await api('POST', '/api/workspace/join-by-invite-code', { code }, joiner.token)).status, 200, 'joining twice is harmless');

  const after = await api('GET', `/api/invite-code-info?code=${code}`, undefined, joiner.token);
  assert.equal(after.body.data.is_member, true);
  assert.equal(after.body.data.member_count, 2);

  const members = await api('GET', `/api/workspace/${owner.workspaceId}/member?include_pending=true`, undefined, joiner.token);
  assert.equal(members.status, 200);
  assert.deepEqual(members.body.data.map((m) => [m.email, m.role]), [[owner.email, 'Owner'], [joiner.email, 'Member']]);
  assert.equal(members.body.data[1].is_pending_invitation, false);

  assert.equal((await api('GET', inviteUrl(owner.workspaceId), undefined, joiner.token)).status, 403, 'members cannot read the owner link');
});

test('unknown, deleted and expired codes report InvalidInvitationCode (1068)', async () => {
  const owner = await account('invite-bad-owner');
  const joiner = await account('invite-bad-joiner');

  for (const route of [['GET', '/api/invite-code-info?code=NOPE'], ['GET', '/api/invite-code-info']]) {
    const response = await api(route[0], route[1], undefined, joiner.token);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 1068);
  }
  const unknownJoin = await api('POST', '/api/workspace/join-by-invite-code', { code: 'NOPE' }, joiner.token);
  assert.equal(unknownJoin.body.code, 1068);
  assert.equal((await api('POST', '/api/workspace/join-by-invite-code', {}, joiner.token)).body.code, 1068);

  const { code } = (await api('POST', inviteUrl(owner.workspaceId), { validity_period_hours: 1 }, owner.token)).body.data;
  running.app.store.state.workspaceInviteCodes[owner.workspaceId].expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await api('GET', `/api/invite-code-info?code=${code}`, undefined, joiner.token)).body.code, 1068);
  assert.equal((await api('POST', '/api/workspace/join-by-invite-code', { code }, joiner.token)).body.code, 1068);
  assert.deepEqual((await api('GET', inviteUrl(owner.workspaceId), undefined, owner.token)).body.data, { code: null }, 'an expired code reads as absent');

  const fresh = (await api('POST', inviteUrl(owner.workspaceId), {}, owner.token)).body.data.code;
  await api('DELETE', inviteUrl(owner.workspaceId), undefined, owner.token);
  assert.equal((await api('GET', `/api/invite-code-info?code=${fresh}`, undefined, joiner.token)).body.code, 1068);
  assert.equal((await api('GET', `/api/invite-code-info?code=${fresh}`)).status, 401);
});

test('a member profile update is per workspace and shows up everywhere the person appears', async () => {
  const owner = await account('profile-owner');
  const url = `/api/workspace/${owner.workspaceId}/update-member-profile`;

  const saved = await api('PUT', url, { name: '  Asha Rao  ', description: 'Platform lead', avatar_url: 'https://img.test/a.png', cover_image_url: 'https://img.test/c.png' }, owner.token);
  assert.equal(saved.status, 200);

  const mine = (await api('GET', `/api/workspace/${owner.workspaceId}/workspace-profile`, undefined, owner.token)).body.data;
  assert.equal(mine.name, 'Asha Rao');
  assert.equal(mine.description, 'Platform lead');
  assert.equal(mine.avatar_url, 'https://img.test/a.png');
  assert.equal(mine.cover_image_url, 'https://img.test/c.png');
  assert.equal(mine.email, owner.email);

  const mentionable = (await api('GET', `/api/workspace/${owner.workspaceId}/mentionable-person`, undefined, owner.token)).body.data.persons;
  assert.equal(mentionable[0].name, 'Asha Rao');
  const members = (await api('GET', `/api/workspace/${owner.workspaceId}/member`, undefined, owner.token)).body.data;
  assert.equal(members[0].name, 'Asha Rao');
  assert.equal(members[0].avatar_url, 'https://img.test/a.png');

  // Omitted fields keep their value; an empty string clears one.
  await api('PUT', url, { name: 'Asha R.', avatar_url: '' }, owner.token);
  const again = (await api('GET', `/api/workspace/${owner.workspaceId}/workspace-profile`, undefined, owner.token)).body.data;
  assert.equal(again.name, 'Asha R.');
  assert.equal(again.description, 'Platform lead');
  assert.equal(again.avatar_url, null);

  // Another workspace the same person belongs to is not affected.
  const other = await account('profile-other');
  const { code } = (await api('POST', inviteUrl(other.workspaceId), {}, other.token)).body.data;
  await api('POST', '/api/workspace/join-by-invite-code', { code }, owner.token);
  const elsewhere = (await api('GET', `/api/workspace/${other.workspaceId}/workspace-profile`, undefined, owner.token)).body.data;
  assert.equal(elsewhere.name, owner.email);
  assert.equal(elsewhere.description, null);
});

test('member profile validation and access', async () => {
  const owner = await account('profile-rules-owner');
  const stranger = await account('profile-rules-stranger');
  const url = `/api/workspace/${owner.workspaceId}/update-member-profile`;

  assert.equal((await api('PUT', url, { name: '' }, owner.token)).status, 400);
  assert.equal((await api('PUT', url, { description: 'no name' }, owner.token)).status, 400);
  assert.equal((await api('PUT', url, { name: 'x'.repeat(201) }, owner.token)).status, 400);
  assert.equal((await api('PUT', url, { name: 'ok', description: 'y'.repeat(1001) }, owner.token)).status, 400);
  assert.equal((await api('PUT', url, { name: 'ok', role: 'Owner' }, owner.token)).status, 400);
  assert.equal((await api('PUT', url, { name: 'ok', avatar_url: 7 }, owner.token)).status, 400);
  assert.equal((await api('PUT', url, { name: 'ok' })).status, 401);
  assert.equal((await api('PUT', url, { name: 'ok' }, stranger.token)).status, 403);
});
