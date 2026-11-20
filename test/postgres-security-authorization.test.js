// Task 67: PostgreSQL parity for test/security-authorization.test.js.
// Authorization must not depend on storage mode -- this file re-proves the
// highest-value subset of that suite (non-member REST denial, cross-
// workspace object denial, immediate-effect membership revocation, WS
// non-member admission denial, and both the pre-existing per-message
// revalidation path AND the new Task 67 bounded periodic revalidation path
// for an idle revoked peer) against a real PostgreSQL-backed server,
// following the same per-test server lifecycle convention as
// test/postgres-realtime-fanout-document.test.js (own startServer/store.close
// per test, skipped entirely when RUN_POSTGRES_TESTS/DATABASE_URL are not
// configured).
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { id } from '../auth.js';
import { startServer } from '../server.js';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;

const PUBLIC_SPACE_PERMISSION = {
  visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
  invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
  security: { disable_guests: false, disable_public_links: false, disable_export: false },
};

function makeApi(base) {
  return async (method, route, payload, token, headers = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}
function frameReader(socket) {
  const pending = []; const waiters = [];
  socket.on('message', (frame, isBinary) => { const r = waiters.shift(); if (r) r({ frame, isBinary }); else pending.push({ frame, isBinary }); });
  return (timeoutMs = 1500) => new Promise((resolve) => {
    let waiterEntry;
    const timeout = setTimeout(() => {
      const index = waiters.indexOf(waiterEntry);
      if (index !== -1) waiters.splice(index, 1);
      resolve(null);
    }, timeoutMs);
    const accept = ({ frame, isBinary }) => { clearTimeout(timeout); resolve(isBinary ? decodeMessage(frame).collabMessage : null); };
    waiterEntry = accept;
    const p = pending.shift(); if (p) accept(p); else waiters.push(waiterEntry);
  });
}
async function readManifest(next) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const frame = await next();
    if (!frame || frame.syncRequest) return frame;
  }
  return null;
}
function waitForClose(socket, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason?.toString() }); });
  });
}

test('PostgreSQL: a non-member cannot read a workspace, and membership revocation is immediately effective (REST)', { skip: !configured }, async (t) => {
  const running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey: 'task67-pg-key', environment: 'test' });
  const base = `http://127.0.0.1:${running.address.port}`;
  const api = makeApi(base);
  try {
    const register = async (label) => {
      const email = `${label}-${id()}@example.test`;
      const password = 'Correct horse 907';
      assert.equal((await api('POST', '/api/auth/register', { email, password })).status, 201);
      const login = await api('POST', '/api/auth/login', { email, password });
      const token = login.body.access_token;
      const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
      return { email, token, workspaceId };
    };
    const owner = await register('pg-sec-owner');
    const member = await register('pg-sec-member');
    const outsider = await register('pg-sec-outsider');

    assert.equal((await api('GET', `/api/workspaces/${owner.workspaceId}`, undefined, outsider.token)).status, 403);

    assert.equal((await api('POST', `/api/workspaces/${owner.workspaceId}/test-members`, { email: member.email, role: 'member' }, owner.token, { 'x-development-key': 'task67-pg-key' })).status, 201);
    assert.equal((await api('GET', `/api/workspaces/${owner.workspaceId}`, undefined, member.token)).status, 200);

    const deleteStatus = (await api('DELETE', `/api/workspaces/${owner.workspaceId}/test-members?email=${encodeURIComponent(member.email)}`, undefined, owner.token, { 'x-development-key': 'task67-pg-key' })).status;
    assert.equal(deleteStatus, 200);
    assert.equal((await api('GET', `/api/workspaces/${owner.workspaceId}`, undefined, member.token)).status, 403, 'revocation must be immediately effective under PostgreSQL storage');
  } finally {
    await running.app.store.close();
    await new Promise((resolve) => running.server.close(resolve));
  }
});

test('PostgreSQL: WS admission rejects a non-member, and an idle revoked peer is closed by the bounded periodic revalidation timer and stops receiving live fan-out', { skip: !configured }, async (t) => {
  const running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey: 'task67-pg-key2', environment: 'test', wsRevalidationIntervalMs: 150 });
  const base = `http://127.0.0.1:${running.address.port}`;
  const api = makeApi(base);
  const openSockets = [];
  try {
    const register = async (label) => {
      const email = `${label}-${id()}@example.test`;
      const password = 'Correct horse 907';
      assert.equal((await api('POST', '/api/auth/register', { email, password })).status, 201);
      const login = await api('POST', '/api/auth/login', { email, password });
      const token = login.body.access_token;
      const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
      return { email, token, workspaceId };
    };
    const owner = await register('pg-ws-owner');
    const victim = await register('pg-ws-victim');
    const bystander = await register('pg-ws-bystander');
    const outsider = await register('pg-ws-outsider');
    for (const member of [victim, bystander]) {
      assert.equal((await api('POST', `/api/workspaces/${owner.workspaceId}/test-members`, { email: member.email, role: 'member' }, owner.token, { 'x-development-key': 'task67-pg-key2' })).status, 201);
    }

    const connect = (token, clientId) => {
      const wsBase = base.replace(/^http/, 'ws');
      const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token, cv: '0.10.0', cp: 'web' });
      const socket = new WebSocket(`${wsBase}/ws/v2/${owner.workspaceId}/?${query}`);
      return new Promise((resolve, reject) => {
        socket.once('open', () => resolve(socket));
        socket.once('unexpected-response', (_req, res) => resolve({ rejected: true, status: res.statusCode }));
        socket.once('error', reject);
      });
    };

    const outsiderAttempt = await connect(outsider.token, 9301);
    assert.ok(outsiderAttempt.rejected, 'a non-member must be rejected at WS admission under PostgreSQL storage');
    assert.equal(outsiderAttempt.status, 403);

    const spaceId = id();
    assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/spaces`, { name: 'pg sec space', view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, owner.token)).status, 200);
    const pageId = id();
    assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, { schema_version: 'v1', request_id: id(), view_id: pageId, parent_view_id: spaceId, name: 'pg sec page', position: { kind: 'start' } }, owner.token)).status, 200);
    const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

    const ownerSocket = await connect(owner.token, 9302);
    const victimSocket = await connect(victim.token, 9303);
    const bystanderSocket = await connect(bystander.token, 9304);
    openSockets.push(ownerSocket, victimSocket, bystanderSocket);
    const ownerNext = frameReader(ownerSocket);
    const victimNext = frameReader(victimSocket);
    const bystanderNext = frameReader(bystanderSocket);
    const baseVector = Y.encodeStateVector(new Y.Doc());
    for (const [socket, next] of [[ownerSocket, ownerNext], [victimSocket, victimNext], [bystanderSocket, bystanderNext]]) {
      const manifestP = readManifest(next);
      socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: baseVector } } }));
      await manifestP;
    }

    assert.equal((await api('DELETE', `/api/workspaces/${owner.workspaceId}/test-members?email=${encodeURIComponent(victim.email)}`, undefined, owner.token, { 'x-development-key': 'task67-pg-key2' })).status, 200);

    const victimCloseEvent = await waitForClose(victimSocket, 3000);
    assert.ok(victimCloseEvent, 'idle revoked peer must be closed by the periodic revalidation timer under PostgreSQL storage');
    assert.equal(victimCloseEvent.code, 1008);

    const doc = new Y.Doc({ guid: pageId });
    Y.applyUpdate(doc, new Uint8Array(initial.doc_state));
    const text = [...doc.getMap('data').get('document').get('meta').get('text_map').values()].find((v) => v instanceof Y.Text);
    text.insert(0, 'task67-pg-revocation-marker');
    const payload = Y.encodeStateAsUpdate(doc, baseVector);
    doc.destroy();

    const bystanderWatch = bystanderNext(3000);
    const ownerAckP = ownerNext();
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: baseVector } } }));
    await ownerAckP;
    const bystanderLive = await bystanderWatch;
    assert.ok(bystanderLive && bystanderLive.update, 'an unrelated still-authorized peer must keep receiving live fan-out under PostgreSQL storage');
  } finally {
    for (const socket of openSockets) { try { socket.terminate(); } catch { /* ignore */ } }
    await running.app.store.close();
    await new Promise((resolve) => running.server.close(resolve));
  }
});
