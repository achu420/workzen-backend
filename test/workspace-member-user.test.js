// GET /api/workspace/v1/{ws}/member/user/{uuid}: the display profile the AI chat shows for a message author.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { account, addMember, createApi } from './helpers/ai-test-env.js';

let dir, running, base, api;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-member-user-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key' });
  base = `http://127.0.0.1:${running.address.port}`;
  api = createApi(() => base);
});
after(async () => {
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('a member can read another member\'s display profile, and profile edits show up', async () => {
  const owner = await account(api, 'member-user-owner');
  const member = await account(api, 'member-user-member');

  await addMember(api, owner, member);
  const url = (userId) => `/api/workspace/v1/${owner.workspaceId}/member/user/${userId}`;
  const memberId = (await api('GET', '/api/auth/me', undefined, member.token)).body.user.id;
  const first = await api('GET', url(memberId), undefined, owner.token);

  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data, { name: member.email, email: member.email, avatar_url: '' });

  await api('PUT', `/api/workspace/${owner.workspaceId}/update-member-profile`, { name: 'Maya', avatar_url: 'https://img.test/m.png' }, member.token);
  const second = await api('GET', url(memberId), undefined, owner.token);

  assert.equal(second.body.data.name, 'Maya');
  assert.equal(second.body.data.avatar_url, 'https://img.test/m.png');
});

test('unknown users, non-members and outsiders get 404 or 403', async () => {
  const owner = await account(api, 'member-user-owner2');
  const outsider = await account(api, 'member-user-outsider');
  const outsiderId = (await api('GET', '/api/auth/me', undefined, outsider.token)).body.user.id;
  const ownerId = (await api('GET', '/api/auth/me', undefined, owner.token)).body.user.id;
  const url = (userId) => `/api/workspace/v1/${owner.workspaceId}/member/user/${userId}`;

  assert.equal((await api('GET', url(outsiderId), undefined, owner.token)).status, 404, 'a user who is not in this workspace');
  assert.equal((await api('GET', url('not-a-uuid'), undefined, owner.token)).status, 404);
  assert.equal((await api('GET', url(crypto.randomUUID()), undefined, owner.token)).status, 404);
  assert.equal((await api('GET', url(ownerId), undefined, outsider.token)).status, 403, 'the caller must belong to the workspace');
  assert.equal((await api('GET', url(ownerId))).status, 401);
});
