// PATCH /api/workspace/{id}/page-view/{viewId} (updatePage() in page-api.ts).
// This route did not exist at all until Task 79, and PATCH was missing from
// CORS_ALLOWED_METHODS on top of that -- so a real browser's PATCH never
// even reached the server: its preflight silently failed the method check,
// and only the (successful) OPTIONS preflight ever showed up anywhere,
// including the server's own request log. Renaming a page, or a database
// template saving its icon/cover (DatabaseTemplateButton.tsx's
// syncTemplateViewMetadata), were both silently broken as a result.
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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-page-metadata-'));
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

async function setup(label) {
  const token = await registerAndLogin(`${label}@example.test`);
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  const spaceId = crypto.randomUUID();

  assert.equal((await api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: 'Space', view_id: spaceId,
    permission: {
      visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
      invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
      security: { disable_guests: false, disable_public_links: false, disable_export: false },
    },
  }, token)).status, 200);
  const viewId = crypto.randomUUID();

  assert.equal((await api('POST', `/api/workspace/${workspaceId}/v2/page-view/document/default`, {
    schema_version: 'v1', request_id: crypto.randomUUID(), parent_view_id: spaceId, name: 'Original', position: { kind: 'start' }, view_id: viewId,
  }, token)).status, 200);
  return { token, workspaceId, viewId };
}

test('PATCH is advertised in the CORS preflight for page-view -- a real browser silently drops the request otherwise', async () => {
  const response = await fetch(`${base}/api/workspace/w/page-view/v`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'PATCH' },
  });

  assert.ok(response.headers.get('access-control-allow-methods')?.includes('PATCH'));
});

test('PATCH /page-view/{id} renames a page', async () => {
  const { token, workspaceId, viewId } = await setup('patch-rename');
  const patched = await api('PATCH', `/api/workspace/${workspaceId}/page-view/${viewId}`, { name: 'Renamed' }, token);

  assert.equal(patched.status, 200);
  const view = await api('GET', `/api/workspace/${workspaceId}/view/${viewId}?depth=0`, undefined, token);

  assert.equal(view.body.data.name, 'Renamed');
});

test('PATCH /page-view/{id} sets icon and extra together', async () => {
  const { token, workspaceId, viewId } = await setup('patch-icon-extra');
  const patched = await api('PATCH', `/api/workspace/${workspaceId}/page-view/${viewId}`, {
    icon: { ty: 1, value: '🎯' },
    extra: { database_row_template: true, template_id: 'abc' },
  }, token);

  assert.equal(patched.status, 200);
  const view = await api('GET', `/api/workspace/${workspaceId}/view/${viewId}?depth=0`, undefined, token);

  assert.deepEqual(view.body.data.icon, { ty: 1, value: '🎯' });
  assert.deepEqual(view.body.data.extra, { database_row_template: true, template_id: 'abc' });
});

test('PATCH /page-view/{id} with an empty body is a no-op, not an error', async () => {
  const { token, workspaceId, viewId } = await setup('patch-empty');

  assert.equal((await api('PATCH', `/api/workspace/${workspaceId}/page-view/${viewId}`, {}, token)).status, 200);
});

test('PATCH /page-view/{id} rejects an oversized name, a malformed icon, and unsupported fields', async () => {
  const { token, workspaceId, viewId } = await setup('patch-invalid');

  assert.equal((await api('PATCH', `/api/workspace/${workspaceId}/page-view/${viewId}`, { name: 'x'.repeat(201) }, token)).status, 400);
  assert.equal((await api('PATCH', `/api/workspace/${workspaceId}/page-view/${viewId}`, { icon: 'not-an-object' }, token)).status, 400);
  assert.equal((await api('PATCH', `/api/workspace/${workspaceId}/page-view/${viewId}`, { unexpected_field: true }, token)).status, 400);
});

test('PATCH /page-view/{id} is rejected for a page in another workspace', async () => {
  const owner = await setup('patch-owner');
  const outsider = await registerAndLogin('patch-outsider@example.test');
  const r = await api('PATCH', `/api/workspace/${owner.workspaceId}/page-view/${owner.viewId}`, { name: 'Hijacked' }, outsider);

  assert.equal(r.status, 403);
});

test('PATCH /page-view/{id} 404s for a nonexistent page', async () => {
  const { token, workspaceId } = await setup('patch-missing');
  const r = await api('PATCH', `/api/workspace/${workspaceId}/page-view/${crypto.randomUUID()}`, { name: 'Ghost' }, token);

  assert.equal(r.status, 404);
});
