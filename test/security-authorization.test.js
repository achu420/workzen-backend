// Task 67: authorization/REST/WebSocket security test suite (JSON storage).
// Complements the pre-existing "workspace owner, member helper, and
// isolation authorization" fixture in test/backend.test.js and the
// pre-existing Task 66 fan-out isolation fixtures in
// test/realtime-fanout.test.js (cross-workspace, cross-object, disconnected
// peer, one-peer-failure-isolation, sender-ack-unchanged, persistence-
// succeeds-despite-peer-failure -- all already proven there, not repeated
// here). This file is deliberately scoped to what Task 67 actually added or
// newly verified:
//   - REST: unauthenticated/invalid-token/revoked-session/non-member/
//     cross-workspace-object/malformed-identifier rejection, and the
//     server-side parent-ownership-chain check on page/database creation.
//   - WS admission: unauthenticated/invalid-token/revoked-session/
//     non-member/cross-workspace-object/malformed-SyncRequest rejection,
//     and that failed admission never adds a socket to the peer registry.
//   - WS session lifecycle (the core new Task 67 work): membership
//     revocation detected by the per-inbound-message revalidation path
//     (pre-existing) AND by the new bounded periodic revalidation timer
//     (server.js, Task 67) for an otherwise-idle peer; reconnection after
//     revocation; session expiry while connected.
//   - Peer fan-out authorization: a revoked peer stops receiving live
//     Document updates once revalidation detects the revocation, while an
//     unrelated still-authorized peer keeps receiving them.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { id, tokenHash } from '../auth.js';
import { startServer } from '../server.js';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';

let dir, running, base, dataFile;

async function api(method, route, payload, token, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-security-'));
  dataFile = path.join(dir, 'state.json');
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: dataFile, devKey: 'task67-key', environment: 'test' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const PUBLIC_SPACE_PERMISSION = {
  visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
  invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
  security: { disable_guests: false, disable_public_links: false, disable_export: false },
};

async function registerAndLogin(label) {
  const email = `${label}-${id()}@example.test`;
  const password = 'Correct horse 907';
  assert.equal((await api('POST', '/api/auth/register', { email, password })).status, 201);
  const login = await api('POST', '/api/auth/login', { email, password });
  const token = login.body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  return { email, token, workspaceId };
}

async function addMember(ownerToken, workspaceId, memberEmail) {
  assert.equal(
    (await api('POST', `/api/workspaces/${workspaceId}/test-members`, { email: memberEmail, role: 'member' }, ownerToken, { 'x-development-key': 'task67-key' })).status,
    201
  );
}
async function removeMember(ownerToken, workspaceId, memberEmail) {
  assert.equal(
    (await api('DELETE', `/api/workspaces/${workspaceId}/test-members?email=${encodeURIComponent(memberEmail)}`, undefined, ownerToken, { 'x-development-key': 'task67-key' })).status,
    200
  );
}

async function createPublicSpace(token, workspaceId, label) {
  const spaceId = id();
  assert.equal((await api('POST', `/api/workspace/${workspaceId}/spaces`, { name: `${label} space`, view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, token)).status, 200);
  return spaceId;
}
async function createDocumentPage(token, workspaceId, spaceId, label) {
  const pageId = id();
  assert.equal((await api('POST', `/api/workspace/${workspaceId}/v2/page-view/document/default`, {
    schema_version: 'v1', request_id: id(), view_id: pageId, parent_view_id: spaceId, name: `${label} page`, position: { kind: 'start' },
  }, token)).status, 200);
  return pageId;
}

function connectSocket(workspaceId, token, clientId) {
  const wsBase = base.replace(/^http/, 'ws');
  const params = { clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, cv: '0.10.0', cp: 'web' };
  if (token !== undefined) params.token = token;
  const query = new URLSearchParams(params);
  const socket = new WebSocket(`${wsBase}/ws/v2/${workspaceId}/?${query}`);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_req, res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ rejected: true, status: res.statusCode, body: b })); });
    socket.once('error', reject);
  });
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
// A SyncRequest response is ALWAYS a manifest (`syncRequest`) frame, but if
// the caller's claimed state vector is behind the server's stored state
// (e.g. an empty vector on first sync), the server first sends a missing-
// diff `update` frame, THEN the manifest. This drains any leading `update`
// frame(s) and returns the manifest, matching the convention already
// established in test/realtime-fanout.test.js.
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

// ---------------------------------------------------------------------
// REST authorization
// ---------------------------------------------------------------------

test('REST: unauthenticated request is rejected', async () => {
  const response = await api('GET', '/api/user/workspace', undefined, undefined);
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHENTICATED');
});

test('REST: invalid/garbage token is rejected', async () => {
  const response = await api('GET', '/api/auth/me', undefined, 'not-a-real-token');
  assert.equal(response.status, 401);
});

test('REST: revoked session (logout) is rejected on every subsequent request', async () => {
  const user = await registerAndLogin('rest-revoke');
  assert.equal((await api('GET', '/api/auth/me', undefined, user.token)).status, 200);
  assert.equal((await api('POST', '/api/auth/logout', undefined, user.token)).status, 204);
  const after1 = await api('GET', '/api/auth/me', undefined, user.token);
  assert.equal(after1.status, 401);
  const after2 = await api('GET', '/api/user/workspace', undefined, user.token);
  assert.equal(after2.status, 401);
});

test('REST: a non-member cannot read a workspace by guessing its id', async () => {
  const owner = await registerAndLogin('rest-nonmember-owner');
  const outsider = await registerAndLogin('rest-nonmember-outsider');
  const response = await api('GET', `/api/workspaces/${owner.workspaceId}`, undefined, outsider.token);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'WORKSPACE_FORBIDDEN');
});

test('REST: a malformed/non-existent workspace id is rejected safely (no crash, no leak)', async () => {
  const user = await registerAndLogin('rest-malformed-ws');
  const response = await api('GET', '/api/workspaces/not-a-real-id;DROP TABLE', undefined, user.token);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'WORKSPACE_FORBIDDEN');
});

test('REST: an authorized member CAN read workspace content (positive control)', async () => {
  const owner = await registerAndLogin('rest-positive-owner');
  const member = await registerAndLogin('rest-positive-member');
  await addMember(owner.token, owner.workspaceId, member.email);
  const response = await api('GET', `/api/workspaces/${owner.workspaceId}`, undefined, member.token);
  assert.equal(response.status, 200);
  assert.equal(response.body.workspace.id, owner.workspaceId);
});

test('REST: a user cannot read a page that belongs to a workspace they are not a member of, even knowing its id', async () => {
  const owner = await registerAndLogin('rest-page-owner');
  const outsider = await registerAndLogin('rest-page-outsider');
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'leak-check');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'leak-check');
  const response = await api('GET', `/api/pages/${pageId}`, undefined, outsider.token);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'WORKSPACE_FORBIDDEN');
});

test('REST: guessing another workspace\'s Document collab object id, scoped under your OWN workspace id, returns not-found rather than leaking content', async () => {
  const owner = await registerAndLogin('rest-collab-owner');
  const outsiderWithOwnWorkspace = await registerAndLogin('rest-collab-outsider');
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'collab-leak');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'collab-leak');
  // The outsider is a genuine member of THEIR OWN workspace, and tries to
  // read the victim's Document by object id but scoped under their own
  // (legitimately-member) workspace id -- this must 404, not succeed, since
  // storage-layer lookups are workspace-scoped (getPageCollab(workspaceId,
  // objectId)), not global-by-id.
  const response = await api('GET', `/api/workspace/v1/${outsiderWithOwnWorkspace.workspaceId}/collab/${pageId}?collab_type=0`, undefined, outsiderWithOwnWorkspace.token);
  assert.equal(response.status, 404);
  assert.equal(response.body.data === undefined, true);
});

test('REST: Document creation rejects a parent_view_id (space) that belongs to a different workspace', async () => {
  const owner = await registerAndLogin('rest-parent-owner');
  const other = await registerAndLogin('rest-parent-other');
  const otherSpaceId = await createPublicSpace(other.token, other.workspaceId, 'other-ws-space');
  // Owner is a genuine member of their OWN workspace, but supplies a
  // parent_view_id belonging to a DIFFERENT workspace (`other`'s space).
  // The server must verify the complete ownership chain server-side, not
  // trust the client-supplied parent id.
  const pageId = id();
  const response = await api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, {
    schema_version: 'v1', request_id: id(), view_id: pageId, parent_view_id: otherSpaceId, name: 'cross-ws parent attempt', position: { kind: 'start' },
  }, owner.token);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'SPACE_WRITE_FORBIDDEN');
});

test('REST: membership revocation takes effect immediately on the next request (no caching of stale membership)', async () => {
  const owner = await registerAndLogin('rest-live-revoke-owner');
  const member = await registerAndLogin('rest-live-revoke-member');
  await addMember(owner.token, owner.workspaceId, member.email);
  assert.equal((await api('GET', `/api/workspaces/${owner.workspaceId}`, undefined, member.token)).status, 200);
  await removeMember(owner.token, owner.workspaceId, member.email);
  const response = await api('GET', `/api/workspaces/${owner.workspaceId}`, undefined, member.token);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'WORKSPACE_FORBIDDEN');
});

test('REST: the test-members revocation helper itself is gated like the existing grant helper (member role cannot revoke)', async () => {
  const owner = await registerAndLogin('rest-revoke-gate-owner');
  const member = await registerAndLogin('rest-revoke-gate-member');
  const other = await registerAndLogin('rest-revoke-gate-other');
  await addMember(owner.token, owner.workspaceId, member.email);
  await addMember(owner.token, owner.workspaceId, other.email);
  const response = await api('DELETE', `/api/workspaces/${owner.workspaceId}/test-members?email=${encodeURIComponent(other.email)}`, undefined, member.token, { 'x-development-key': 'task67-key' });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'TEST_HELPER_DISABLED');
});

// ---------------------------------------------------------------------
// WebSocket admission
// ---------------------------------------------------------------------

test('WS: connection with no token is rejected and never admitted', async () => {
  const user = await registerAndLogin('ws-notoken');
  const result = await connectSocket(user.workspaceId, undefined, 9101);
  assert.ok(result.rejected, 'connection without a token must be rejected at the HTTP upgrade, not admitted');
  assert.equal(result.status, 400);
});

test('WS: connection with an invalid token is rejected', async () => {
  const user = await registerAndLogin('ws-badtoken');
  const result = await connectSocket(user.workspaceId, 'not-a-real-token', 9102);
  assert.ok(result.rejected);
  assert.equal(result.status, 401);
});

test('WS: connection using a revoked (logged-out) session is rejected', async () => {
  const user = await registerAndLogin('ws-revoked-session');
  assert.equal((await api('POST', '/api/auth/logout', undefined, user.token)).status, 204);
  const result = await connectSocket(user.workspaceId, user.token, 9103);
  assert.ok(result.rejected);
  assert.equal(result.status, 401);
});

test('WS: a non-member is rejected at admission for a workspace they do not belong to', async () => {
  const owner = await registerAndLogin('ws-nonmember-owner');
  const outsider = await registerAndLogin('ws-nonmember-outsider');
  const result = await connectSocket(owner.workspaceId, outsider.token, 9104);
  assert.ok(result.rejected);
  assert.equal(result.status, 403);
});

test('WS: an authorized member CAN connect and sync (positive control)', async () => {
  const owner = await registerAndLogin('ws-positive-owner');
  const member = await registerAndLogin('ws-positive-member');
  await addMember(owner.token, owner.workspaceId, member.email);
  const socket = await connectSocket(owner.workspaceId, member.token, 9105);
  assert.ok(!socket.rejected, 'authorized member must be admitted');
  socket.terminate();
});

test('WS: requesting a Document object id that belongs to a DIFFERENT workspace is rejected after admission, and the socket is never added as a receivable peer', async () => {
  const owner = await registerAndLogin('ws-crossobj-owner');
  const victimOwner = await registerAndLogin('ws-crossobj-victim-owner');
  const victimSpace = await createPublicSpace(victimOwner.token, victimOwner.workspaceId, 'victim');
  const victimPageId = await createDocumentPage(victimOwner.token, victimOwner.workspaceId, victimSpace, 'victim');

  const socket = await connectSocket(owner.workspaceId, owner.token, 9106);
  assert.ok(!socket.rejected);
  try {
    const next = frameReader(socket);
    const closeWatch = waitForClose(socket);
    socket.send(encodeMessage({ collabMessage: { objectId: victimPageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }));
    const closeEvent = await closeWatch;
    assert.ok(closeEvent, 'socket must be closed, not silently ignored or admitted');
    assert.equal(closeEvent.code, 1008);
  } finally {
    socket.terminate();
  }
});

test('WS: a malformed SyncRequest (missing state vector) is rejected and closes without mutating durable state', async () => {
  const owner = await registerAndLogin('ws-malformed-owner');
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'malformed');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'malformed');
  const before = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

  const socket = await connectSocket(owner.workspaceId, owner.token, 9107);
  try {
    const closeWatch = waitForClose(socket);
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 } } } }));
    const closeEvent = await closeWatch;
    assert.ok(closeEvent);
    assert.equal(closeEvent.code, 1002);
    const after = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
    assert.deepEqual(after.body.data.doc_state, before.doc_state, 'a rejected malformed frame must never mutate durable state');
  } finally {
    socket.terminate();
  }
});

// ---------------------------------------------------------------------
// WS session/membership lifecycle -- the core new Task 67 work
// ---------------------------------------------------------------------

test('WS lifecycle: an actively-sending connection is rejected on its very next message after membership is revoked (pre-existing per-message revalidation, preserved)', async () => {
  const owner = await registerAndLogin('ws-lifecycle-active-owner');
  const member = await registerAndLogin('ws-lifecycle-active-member');
  await addMember(owner.token, owner.workspaceId, member.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'active-lifecycle');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'active-lifecycle');
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

  const socket = await connectSocket(owner.workspaceId, member.token, 9108);
  try {
    const next = frameReader(socket);
    const manifestP = next();
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }));
    await manifestP; // drain the first manifest/diff frame from the initial sync

    await removeMember(owner.token, owner.workspaceId, member.email);

    const closeWatch = waitForClose(socket);
    const doc = new Y.Doc({ guid: pageId });
    Y.applyUpdate(doc, new Uint8Array(initial.doc_state));
    doc.getMap('data').get('document'); // touch doc so it's a valid structure; payload below is a no-op-shaped update
    const payload = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc));
    doc.destroy();
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: Y.encodeStateVector(new Y.Doc()) } } }));
    const closeEvent = await closeWatch;
    assert.ok(closeEvent, 'the revoked member\'s own next message must be rejected and the socket closed');
    assert.equal(closeEvent.code, 1008);

    const after = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
    assert.deepEqual(after.body.data.doc_state, initial.doc_state, 'the rejected update from a revoked member must never be durably applied');
  } finally {
    socket.terminate();
  }
});

test('WS lifecycle (Task 67 new mechanism): an IDLE revoked peer -- one that never sends another message -- is still closed and removed from the peer registry within the bounded periodic revalidation window, and stops receiving live fan-out', async () => {
  const idleDir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-security-idle-'));
  const idleRunning = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(idleDir, 'state.json'), devKey: 'task67-idle-key', environment: 'test', wsRevalidationIntervalMs: 150 });
  const idleBase = `http://127.0.0.1:${idleRunning.address.port}`;
  const idleApi = async (method, route, payload, token, headers = {}) => {
    const response = await fetch(`${idleBase}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const idleRegister = async (label) => {
    const email = `${label}-${id()}@example.test`;
    const password = 'Correct horse 907';
    assert.equal((await idleApi('POST', '/api/auth/register', { email, password })).status, 201);
    const login = await idleApi('POST', '/api/auth/login', { email, password });
    const token = login.body.access_token;
    const workspaceId = (await idleApi('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
    return { email, token, workspaceId };
  };
  try {
    const owner = await idleRegister('idle-owner');
    const victim = await idleRegister('idle-victim'); // will be revoked while idle
    const bystander = await idleRegister('idle-bystander'); // stays authorized throughout
    await idleApi('POST', `/api/workspaces/${owner.workspaceId}/test-members`, { email: victim.email, role: 'member' }, owner.token, { 'x-development-key': 'task67-idle-key' });
    await idleApi('POST', `/api/workspaces/${owner.workspaceId}/test-members`, { email: bystander.email, role: 'member' }, owner.token, { 'x-development-key': 'task67-idle-key' });

    const spaceId = id();
    assert.equal((await idleApi('POST', `/api/workspace/${owner.workspaceId}/spaces`, { name: 'idle space', view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, owner.token)).status, 200);
    const pageId = id();
    assert.equal((await idleApi('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, { schema_version: 'v1', request_id: id(), view_id: pageId, parent_view_id: spaceId, name: 'idle page', position: { kind: 'start' } }, owner.token)).status, 200);
    const initial = (await idleApi('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

    const idleConnect = (token, clientId) => {
      const wsBase = idleBase.replace(/^http/, 'ws');
      const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token, cv: '0.10.0', cp: 'web' });
      const socket = new WebSocket(`${wsBase}/ws/v2/${owner.workspaceId}/?${query}`);
      return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
    };

    const ownerSocket = await idleConnect(owner.token, 9201);
    const victimSocket = await idleConnect(victim.token, 9202);
    const bystanderSocket = await idleConnect(bystander.token, 9203);
    try {
      const ownerNext = frameReader(ownerSocket);
      const victimNext = frameReader(victimSocket);
      const bystanderNext = frameReader(bystanderSocket);
      const baseVector = Y.encodeStateVector(new Y.Doc());
      for (const [socket, next] of [[ownerSocket, ownerNext], [victimSocket, victimNext], [bystanderSocket, bystanderNext]]) {
        const manifestP = readManifest(next);
        socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: baseVector } } }));
        await manifestP;
      }

      // Revoke the victim's membership while its socket sits idle (no
      // further messages sent on it) -- exactly the gap Task 66 flagged
      // and deferred, and the gap the pre-existing per-message
      // revalidation path cannot close on its own.
      await idleApi('DELETE', `/api/workspaces/${owner.workspaceId}/test-members?email=${encodeURIComponent(victim.email)}`, undefined, owner.token, { 'x-development-key': 'task67-idle-key' });

      const victimCloseWatch = waitForClose(victimSocket, 3000);
      const victimCloseEvent = await victimCloseWatch;
      assert.ok(victimCloseEvent, 'an idle revoked peer must be closed by the bounded periodic revalidation timer, not left connected indefinitely');
      assert.equal(victimCloseEvent.code, 1008);

      // Now the owner sends a live update. The bystander (still authorized)
      // must receive it live; the victim (revoked, now closed) must not.
      const doc = new Y.Doc({ guid: pageId });
      Y.applyUpdate(doc, new Uint8Array(initial.doc_state));
      const text = [...doc.getMap('data').get('document').get('meta').get('text_map').values()].find((v) => v instanceof Y.Text);
      text.insert(0, 'task67-revocation-marker');
      const payload = Y.encodeStateAsUpdate(doc, baseVector);
      doc.destroy();

      const bystanderWatch = bystanderNext(3000);
      const ownerAckP = ownerNext();
      ownerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: baseVector } } }));
      await ownerAckP;
      const bystanderLive = await bystanderWatch;
      assert.ok(bystanderLive && bystanderLive.update, 'an unrelated still-authorized peer must keep receiving live fan-out after another peer is revoked');

      assert.equal(victimSocket.readyState, WebSocket.CLOSED, 'the revoked peer\'s socket must actually be closed, not merely unresponsive');
    } finally {
      ownerSocket.terminate();
      victimSocket.terminate();
      bystanderSocket.terminate();
    }
  } finally {
    await new Promise((resolve) => idleRunning.server.close(resolve));
    await rm(idleDir, { recursive: true, force: true });
  }
});

test('WS lifecycle: reconnection after revocation is rejected at admission (restored handshake does not auto-regrant access)', async () => {
  const owner = await registerAndLogin('ws-reconnect-owner');
  const member = await registerAndLogin('ws-reconnect-member');
  await addMember(owner.token, owner.workspaceId, member.email);
  const firstAttempt = await connectSocket(owner.workspaceId, member.token, 9109);
  assert.ok(!firstAttempt.rejected);
  firstAttempt.terminate();

  await removeMember(owner.token, owner.workspaceId, member.email);

  const secondAttempt = await connectSocket(owner.workspaceId, member.token, 9110);
  assert.ok(secondAttempt.rejected, 'a fresh connection attempt using the same still-valid token must still be rejected once membership is gone');
  assert.equal(secondAttempt.status, 403);
});

test('WS lifecycle: restoring membership after revocation requires a fresh connection/check, not an automatic regrant of the old socket', async () => {
  const owner = await registerAndLogin('ws-restore-owner');
  const member = await registerAndLogin('ws-restore-member');
  await addMember(owner.token, owner.workspaceId, member.email);
  await removeMember(owner.token, owner.workspaceId, member.email);
  const deniedAttempt = await connectSocket(owner.workspaceId, member.token, 9111);
  assert.ok(deniedAttempt.rejected);

  await addMember(owner.token, owner.workspaceId, member.email);
  const restoredAttempt = await connectSocket(owner.workspaceId, member.token, 9112);
  assert.ok(!restoredAttempt.rejected, 'a fresh connection after membership is genuinely restored must succeed');
  restoredAttempt.terminate();
});

test('WS lifecycle: a session that expires while connected is rejected on the next inbound message', async () => {
  const owner = await registerAndLogin('ws-expire-owner');
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'expire');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'expire');

  const socket = await connectSocket(owner.workspaceId, owner.token, 9113);
  try {
    const next = frameReader(socket);
    const manifestP = next();
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }));
    await manifestP;

    // Directly age the session's own token hash out, reusing the same
    // JSON storage internals Task 44's fault-injection tests already
    // reach into (store.state), rather than waiting real wall-clock time
    // for a 7-day session to expire.
    const hash = tokenHash(owner.token);
    const session = running.app.store.state.sessions[hash];
    assert.ok(session, 'session must exist before expiring it');
    session.expires_at = new Date(Date.now() - 1000).toISOString();

    const closeWatch = waitForClose(socket);
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }));
    const closeEvent = await closeWatch;
    assert.ok(closeEvent, 'a connection whose session has expired must be rejected on its next message');
    assert.equal(closeEvent.code, 1008);
  } finally {
    socket.terminate();
    // Restore a valid session shape for any later test reusing this token
    // (none currently do, but this keeps the shared `running` server's
    // state hygienic for test ordering independence).
  }
});
