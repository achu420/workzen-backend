// Multi-workspace support: POST/GET /api/workspace and PUT /api/workspace/{id}/open.
// Prior to this, AppFlowy-Web's "Create workspace" and workspace switcher had
// no matching backend route at all -- every user had exactly the one
// workspace createWorkspaceForUser() seeded at registration, and no way to
// create or switch to a second one.
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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-workspace-mgmt-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function registerAndLogin(email) {
  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const login = await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' });
  return login.body.access_token;
}

test('GET /api/workspace lists exactly the registration-seeded workspace for a brand-new user', async () => {
  const token = await registerAndLogin('workspace-list@example.test');
  const r = await api('GET', '/api/workspace', undefined, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].workspace_name, 'My Workspace');
  assert.equal(r.body.data[0].role, 'owner');
});

test('POST /api/workspace creates a second workspace, owned by the creator, now listed alongside the first', async () => {
  const token = await registerAndLogin('workspace-create@example.test');
  const created = await api('POST', '/api/workspace', { workspace_name: 'My Second Workspace' }, token);
  assert.equal(created.status, 201);
  assert.ok(created.body.data.workspace_id);

  const list = await api('GET', '/api/workspace', undefined, token);
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 2);
  const names = list.body.data.map((w) => w.workspace_name).sort();
  assert.deepEqual(names, ['My Second Workspace', 'My Workspace']);
  const second = list.body.data.find((w) => w.workspace_id === created.body.data.workspace_id);
  assert.equal(second.role, 'owner');
  assert.equal(second.member_count, 1);
});

test('POST /api/workspace rejects an empty or oversized workspace_name', async () => {
  const token = await registerAndLogin('workspace-validate@example.test');
  assert.equal((await api('POST', '/api/workspace', { workspace_name: '' }, token)).status, 400);
  assert.equal((await api('POST', '/api/workspace', { workspace_name: '  ' }, token)).status, 400);
  assert.equal((await api('POST', '/api/workspace', { workspace_name: 'x'.repeat(201) }, token)).status, 400);
});

test('POST /api/workspace requires authentication', async () => {
  assert.equal((await api('POST', '/api/workspace', { workspace_name: 'Nope' }, undefined)).status, 401);
});

test('PUT /api/workspace/{id}/open makes that workspace the visiting_workspace on GET /api/user/workspace', async () => {
  const token = await registerAndLogin('workspace-open@example.test');
  const originalBootstrap = await api('GET', '/api/user/workspace', undefined, token);
  const originalWorkspaceId = originalBootstrap.body.data.visiting_workspace.workspace_id;

  const created = await api('POST', '/api/workspace', { workspace_name: 'Second' }, token);
  const secondWorkspaceId = created.body.data.workspace_id;

  // Before opening it, the original (first-created) workspace is still visiting.
  let bootstrap = await api('GET', '/api/user/workspace', undefined, token);
  assert.equal(bootstrap.body.data.visiting_workspace.workspace_id, originalWorkspaceId);

  const opened = await api('PUT', `/api/workspace/${secondWorkspaceId}/open`, undefined, token);
  assert.equal(opened.status, 200);

  bootstrap = await api('GET', '/api/user/workspace', undefined, token);
  assert.equal(bootstrap.body.data.visiting_workspace.workspace_id, secondWorkspaceId);

  // Switching back works too (tests DESC-by-last-visited ordering, not just "most recent ever").
  const openedOriginal = await api('PUT', `/api/workspace/${originalWorkspaceId}/open`, undefined, token);
  assert.equal(openedOriginal.status, 200);
  bootstrap = await api('GET', '/api/user/workspace', undefined, token);
  assert.equal(bootstrap.body.data.visiting_workspace.workspace_id, originalWorkspaceId);
});

test('PUT /api/workspace/{id}/open is rejected for a workspace the user does not belong to', async () => {
  const tokenA = await registerAndLogin('workspace-open-a@example.test');
  const tokenB = await registerAndLogin('workspace-open-b@example.test');
  const createdByB = await api('POST', '/api/workspace', { workspace_name: 'Bs workspace' }, tokenB);

  const r = await api('PUT', `/api/workspace/${createdByB.body.data.workspace_id}/open`, undefined, tokenA);
  assert.equal(r.status, 403);
});

test('a new workspace created via POST /api/workspace can immediately host a Space and a page (not a dead-end record)', async () => {
  const token = await registerAndLogin('workspace-usable@example.test');
  const created = await api('POST', '/api/workspace', { workspace_name: 'Usable workspace' }, token);
  const workspaceId = created.body.data.workspace_id;

  const space = await api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: 'A space',
    view_id: '11111111-1111-4111-8111-111111111111',
    permission: {
      visibility: 'public', owner_access_level: 50, member_default_access_level: 30,
      everyone_else_access_level: null, invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only',
      invite_link_enabled: false, security: { disable_guests: false, disable_public_links: false, disable_export: false },
    },
  }, token);
  assert.equal(space.status, 200);
});
