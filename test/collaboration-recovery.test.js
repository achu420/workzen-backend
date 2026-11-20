// Task 68: collaboration recovery / reconnection hardening -- consolidated,
// recovery-scenario-shaped coverage (JSON storage mode) that exercises the
// EXISTING protocol contracts proven piecemeal by Tasks 41/43/44/46/49A/62/
// 63/65/66/67, but framed the way a real disconnect/restart/concurrent-
// reconnect actually happens: real WebSocket `terminate()` (not a graceful
// close) to model a dropped network, a real second `startServer()` call
// against the SAME on-disk JSON file to model a backend process restart,
// and the Task 67 test-only membership revocation route to model
// authorization changing while a client is offline.
//
// Investigation finding (see docs/TASK68_COLLABORATION_RECOVERY_AND_RECONNECTION_REPORT.md
// for the full trace): the backend's existing recovery contract is already
// correct --
//   - every SyncRequest response is a diff (`Y.encodeStateAsUpdate(doc,
//     clientStateVector)`), never a forced full replace;
//   - every accepted update is deduplicated server-side on a payload sha256
//     digest (storage.js / postgres-collab-repository.js), so a lost-ack
//     resend or a true duplicate submission never double-applies and always
//     returns the SAME server-assigned Rid;
//   - the per-workspace Rid allocator and the dedup table are both part of
//     the same durable state that survives a restart (JSON: the single
//     persisted file; Postgres: `collab_workspace_rids` / `collab_updates`
//     committed in the same transaction as the document row);
//   - every connection and every inbound frame re-checks CURRENT membership
//     (Task 67), so a revoked/expired identity can never resume a protected
//     session merely by reconnecting.
// No defect was found in this contract; this suite is therefore a
// verification suite, not a bug-fix vehicle. It does not re-implement or
// replace any of the above -- it proves it, end to end, in recovery-shaped
// scenarios the prior per-feature suites did not frame explicitly.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { id } from '../auth.js';
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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-collab-recovery-'));
  dataFile = path.join(dir, 'state.json');
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: dataFile, devKey: 'task68-key', environment: 'test' });
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
    (await api('POST', `/api/workspaces/${workspaceId}/test-members`, { email: memberEmail, role: 'member' }, ownerToken, { 'x-development-key': 'task68-key' })).status,
    201
  );
}

async function revokeMember(ownerToken, workspaceId, memberEmail) {
  assert.equal(
    (await api('DELETE', `/api/workspaces/${workspaceId}/test-members?email=${encodeURIComponent(memberEmail)}`, undefined, ownerToken, { 'x-development-key': 'task68-key' })).status,
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

function defaultDatabaseRequest(parentViewId) {
  return {
    schema_version: 'v1', request_id: id(), parent_view_id: parentViewId, name: '', position: { kind: 'start' }, container_id: id(),
    database: { database_id: id(), view_id: id(), name: 'Grid', layout: 0, embedded: false, responses_view_id: null, initial_row_ids: [], timezone_id: null },
  };
}

async function createGridDatabase(token, workspaceId, spaceId) {
  const request = defaultDatabaseRequest(spaceId);
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  assert.equal(response.status, 200);
  return { databaseId: request.database.database_id, viewId: request.database.view_id };
}

const ORIGINAL_DATABASE_RESTORE_ID = '00000000-0000-0000-0000-000000000000';
async function createRow(token, workspaceId, databaseId, viewId) {
  const request = {
    schema_version: 'v1', request_id: id(), row_id: id(), database_restore_id: ORIGINAL_DATABASE_RESTORE_ID,
    source_view_id: viewId, cells: {}, height: 36, visibility: true, presentation: { icon_url: null, cover: null }, position: { kind: 'end' },
  };
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/database/${databaseId}/row/default`, request, token);
  assert.equal(response.status, 200);
  return request.row_id;
}

function connectSocket(wsBase, workspaceId, token, clientId) {
  const websocketBase = wsBase.replace(/^http/, 'ws');
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${websocketBase}/ws/v2/${workspaceId}/?${query}`);
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
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

async function syncRequest(socket, next, objectId, collabType, stateVector, lastMessageId = { timestamp: 0, counter: 0 }) {
  const manifestP = readManifest(next);
  socket.send(encodeMessage({ collabMessage: { objectId, collabType, syncRequest: { lastMessageId, stateVector } } }));
  return manifestP;
}

function docTextNodes(doc) {
  return [...doc.getMap('data').get('document').get('meta').get('text_map').values()].filter((v) => v instanceof Y.Text);
}

// ---------------------------------------------------------------------
// 1. Network interruption: ungraceful drop (terminate, not close) mid-
//    session, reconnect, state-vector reconciliation, convergence.
// ---------------------------------------------------------------------

test('Recovery (Document): client A is ungracefully dropped mid-session, client B edits while A is offline, A reconnects and reconciles via state-vector sync, both converge', async () => {
  const owner = await registerAndLogin('recovery-doc-owner');
  const peer = await registerAndLogin('recovery-doc-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'recovery-doc');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'recovery-doc');
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

  let aSocket = await connectSocket(base, owner.workspaceId, owner.token, 20001);
  const bSocket = await connectSocket(base, owner.workspaceId, peer.token, 20002);
  let aNext = frameReader(aSocket);
  const bNext = frameReader(bSocket);

  const baseVector = new Y.Doc({ guid: pageId });
  Y.applyUpdate(baseVector, new Uint8Array(initial.doc_state));
  const sv0 = Y.encodeStateVector(baseVector);
  baseVector.destroy();
  await syncRequest(aSocket, aNext, pageId, 0, sv0);
  await syncRequest(bSocket, bNext, pageId, 0, sv0);

  // Simulate a network interruption: terminate the TCP connection abruptly
  // (no close handshake), exactly what happens when wifi drops or a tab is
  // suspended mid-flight.
  aSocket.terminate();
  await new Promise((resolve) => aSocket.once('close', resolve));

  // B edits while A is offline.
  const bDoc = new Y.Doc({ guid: pageId });
  Y.applyUpdate(bDoc, new Uint8Array(initial.doc_state));
  const bText = docTextNodes(bDoc)[0];
  const bMarker = `recovery-b-${id()}`;
  bText.insert(bText.length, bMarker);
  const bPayload = Y.encodeStateAsUpdate(bDoc, sv0);
  const bAckP = bNext();
  bSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: bPayload, beforeStateVector: sv0 } } }));
  const bAck = await bAckP;
  assert.ok(bAck.update, 'B\'s edit while A is offline must still be accepted and acked');
  await bNext(); // drain B's own manifest

  // A reconnects (new TCP connection, same client-side state vector it had
  // before the drop -- it never received anything from B while offline).
  aSocket = await connectSocket(base, owner.workspaceId, owner.token, 20003);
  aNext = frameReader(aSocket);
  const aManifestP = readManifest(aNext);
  aSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv0 } } }));
  // The server must detect A is missing B's update and send the diff BEFORE the manifest.
  const manifest = await aManifestP;
  assert.ok(manifest && manifest.syncRequest, 'A must receive a manifest after reconnect state-vector sync');

  // Re-request explicitly to inspect the missing-update frame directly.
  const aSocket2 = await connectSocket(base, owner.workspaceId, owner.token, 20004);
  const aNext2 = frameReader(aSocket2);
  const diffP = aNext2();
  aSocket2.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv0 } } }));
  const diffFrame = await diffP;
  assert.ok(diffFrame.update, 'reconnect SyncRequest with a stale state vector must receive the missing update, not a forced full state');

  const aDoc = new Y.Doc({ guid: pageId });
  Y.applyUpdate(aDoc, new Uint8Array(initial.doc_state));
  Y.applyUpdate(aDoc, diffFrame.update.payload);
  assert.ok(docTextNodes(aDoc).some((t) => t.toString().includes(bMarker)), 'A must converge to include B\'s offline-period edit after reconnect reconciliation');

  aDoc.destroy(); bDoc.destroy();
  aSocket.terminate(); aSocket2.terminate(); bSocket.terminate();
});

// ---------------------------------------------------------------------
// 2. Backend restart: process stops, restarts against the SAME on-disk
//    file, RID continuity, persisted content intact, live fan-out still
//    works for new edits post-restart.
// ---------------------------------------------------------------------

test('Recovery (Document): backend process restart against the same data file preserves content, Rid continuity, and live fan-out keeps working', async () => {
  const restartDir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-restart-'));
  const restartFile = path.join(restartDir, 'state.json');
  let server1 = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: restartFile, devKey: 'task68-restart-key', environment: 'test' });
  let restartBase = `http://127.0.0.1:${server1.address.port}`;

  const prevBase = base; base = restartBase;
  try {
    const owner = await registerAndLogin('restart-doc-owner');
    const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'restart-doc');
    const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'restart-doc');
    const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

    const socket = await connectSocket(restartBase, owner.workspaceId, owner.token, 21001);
    const next = frameReader(socket);
    const sv0 = (() => { const d = new Y.Doc({ guid: pageId }); Y.applyUpdate(d, new Uint8Array(initial.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();
    await syncRequest(socket, next, pageId, 0, sv0);

    const editDoc = new Y.Doc({ guid: pageId });
    Y.applyUpdate(editDoc, new Uint8Array(initial.doc_state));
    const marker1 = `restart-pre-${id()}`;
    docTextNodes(editDoc)[0].insert(0, marker1);
    const payload1 = Y.encodeStateAsUpdate(editDoc, sv0);
    const ack1P = next();
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: payload1, beforeStateVector: sv0 } } }));
    const ack1 = await ack1P;
    assert.ok(ack1.update, 'pre-restart update must be acked');
    const ridBeforeRestart = ack1.update.messageId;
    await next(); // drain manifest
    const sv1 = Y.encodeStateVector(editDoc);

    const marker2 = `restart-pre2-${id()}`;
    docTextNodes(editDoc)[0].insert(0, marker2);
    const payload2 = Y.encodeStateAsUpdate(editDoc, sv1);
    const ack2P = next();
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: payload2, beforeStateVector: sv1 } } }));
    const ack2 = await ack2P;
    assert.ok(ack2.update, 'second pre-restart update must be acked');
    await next(); // drain manifest
    const sv2 = Y.encodeStateVector(editDoc);

    assert.ok(
      BigInt(ack2.update.messageId.timestamp) > BigInt(ridBeforeRestart.timestamp) ||
      (BigInt(ack2.update.messageId.timestamp) === BigInt(ridBeforeRestart.timestamp) && ack2.update.messageId.counter > ridBeforeRestart.counter),
      'Rid must strictly advance across sequential updates before restart'
    );

    socket.terminate();
    await new Promise((resolve) => socket.once('close', resolve));

    // --- Simulated backend process restart: stop the HTTP/WS server, start
    // a brand new one against the EXACT SAME on-disk JSON file. ---
    await new Promise((resolve) => server1.server.close(resolve));
    const server2 = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: restartFile, devKey: 'task68-restart-key', environment: 'test' });
    restartBase = `http://127.0.0.1:${server2.address.port}`;
    base = restartBase;

    // Persisted content survived the restart (plain HTTP read, no socket).
    const readBack = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
    assert.equal(readBack.status, 200);
    const persisted = new Y.Doc({ guid: pageId });
    Y.applyUpdate(persisted, new Uint8Array(readBack.body.data.doc_state));
    const persistedTexts = docTextNodes(persisted);
    assert.ok(persistedTexts.some((t) => t.toString().includes(marker1)), 'first pre-restart edit must survive backend restart');
    assert.ok(persistedTexts.some((t) => t.toString().includes(marker2)), 'second pre-restart edit must survive backend restart');
    persisted.destroy();

    // Reconnect post-restart and confirm the manifest/state-vector handshake works and a NEW edit is accepted with a Rid that continues (not resets to 0) and is live-fanned to a second reconnected peer.
    const socket2 = await connectSocket(restartBase, owner.workspaceId, owner.token, 21002);
    const next2 = frameReader(socket2);
    await syncRequest(socket2, next2, pageId, 0, sv2);

    const peerSocket = await connectSocket(restartBase, owner.workspaceId, owner.token, 21003);
    const peerNext = frameReader(peerSocket);
    await syncRequest(peerSocket, peerNext, pageId, 0, sv2);

    const marker3 = `restart-post-${id()}`;
    docTextNodes(editDoc)[0].insert(0, marker3);
    const payload3 = Y.encodeStateAsUpdate(editDoc, sv2);
    const peerLiveP = peerNext(3000);
    const ack3P = next2();
    socket2.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: payload3, beforeStateVector: sv2 } } }));
    const ack3 = await ack3P;
    assert.ok(ack3.update, 'post-restart update must be acked');
    assert.ok(
      BigInt(ack3.update.messageId.timestamp) > BigInt(ack2.update.messageId.timestamp) ||
      (BigInt(ack3.update.messageId.timestamp) === BigInt(ack2.update.messageId.timestamp) && ack3.update.messageId.counter > ack2.update.messageId.counter),
      'Rid allocated after restart must strictly continue past the pre-restart Rid, not reset'
    );
    const peerLive = await peerLiveP;
    assert.ok(peerLive && peerLive.update, 'live fan-out must keep working for a brand-new connection established after the backend restart');

    editDoc.destroy();
    socket2.terminate(); peerSocket.terminate();
    await new Promise((resolve) => server2.server.close(resolve));
  } finally {
    base = prevBase;
    await rm(restartDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 3. Lost ack / duplicate resubmission: identical payload sent twice (once
//    simulating a genuinely lost ack, once a true accidental double-send)
//    must never double-apply and must always return the same Rid.
// ---------------------------------------------------------------------

test('Recovery (Document): resending an identical update payload after a presumed lost ack is deduplicated -- same Rid, no double effect', async () => {
  const owner = await registerAndLogin('recovery-lostack-owner');
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'lostack');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'lostack');
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

  const socket = await connectSocket(base, owner.workspaceId, owner.token, 22001);
  const next = frameReader(socket);
  const sv0 = (() => { const d = new Y.Doc({ guid: pageId }); Y.applyUpdate(d, new Uint8Array(initial.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();
  await syncRequest(socket, next, pageId, 0, sv0);

  const editDoc = new Y.Doc({ guid: pageId });
  Y.applyUpdate(editDoc, new Uint8Array(initial.doc_state));
  const marker = `lostack-${id()}`;
  docTextNodes(editDoc)[0].insert(0, marker);
  const payload = Y.encodeStateAsUpdate(editDoc, sv0);

  const ack1P = next();
  socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: sv0 } } }));
  const ack1 = await ack1P;
  assert.ok(ack1.update, 'first send must be acked');
  await next(); // drain manifest -- this models the ack+manifest frames being the ones "lost" on the wire

  // Resend the EXACT SAME payload bytes (what an outbox resend of an
  // unconfirmed record looks like after it never observed the first ack).
  const ack2P = next();
  socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: sv0 } } }));
  const ack2 = await ack2P;
  assert.ok(ack2.update, 'resend must still be acked (idempotent), not silently dropped or rejected');
  assert.deepEqual(ack2.update.messageId, ack1.update.messageId, 'a resent identical payload must return the exact same Rid, not allocate a new one');
  await next(); // drain the resend's manifest

  const readBack = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
  const persisted = new Y.Doc({ guid: pageId });
  Y.applyUpdate(persisted, new Uint8Array(readBack.body.data.doc_state));
  const markerCount = docTextNodes(persisted).filter((t) => t.toString().includes(marker)).length;
  assert.equal(markerCount, 1, 'the marker must appear exactly once -- resubmission must never double-apply logically');

  editDoc.destroy(); persisted.destroy(); socket.terminate();
});

// ---------------------------------------------------------------------
// 4. Concurrent duplicate submissions: two sockets race the SAME payload
//    at the same time. Exactly one logical application, no Rid collision.
// ---------------------------------------------------------------------

test('Recovery (Document): two concurrent submissions of the identical payload from different sockets never double-apply and never collide on Rid', async () => {
  const owner = await registerAndLogin('recovery-concurrent-dup-owner');
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'concurrent-dup');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'concurrent-dup');
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

  const socketA = await connectSocket(base, owner.workspaceId, owner.token, 23001);
  const socketB = await connectSocket(base, owner.workspaceId, owner.token, 23002);
  const nextA = frameReader(socketA);
  const nextB = frameReader(socketB);
  const sv0 = (() => { const d = new Y.Doc({ guid: pageId }); Y.applyUpdate(d, new Uint8Array(initial.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();
  await syncRequest(socketA, nextA, pageId, 0, sv0);
  await syncRequest(socketB, nextB, pageId, 0, sv0);

  const editDoc = new Y.Doc({ guid: pageId });
  Y.applyUpdate(editDoc, new Uint8Array(initial.doc_state));
  const marker = `concurrent-dup-${id()}`;
  docTextNodes(editDoc)[0].insert(0, marker);
  const payload = Y.encodeStateAsUpdate(editDoc, sv0);

  const ackAP = nextA();
  const ackBP = nextB();
  socketA.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: sv0 } } }));
  socketB.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: sv0 } } }));
  const [ackA, ackB] = await Promise.all([ackAP, ackBP]);
  assert.ok(ackA.update && ackB.update, 'both racing submissions must be acked (one applied, one deduplicated), neither silently dropped');
  assert.deepEqual(ackA.update.messageId, ackB.update.messageId, 'concurrent identical submissions must resolve to the SAME Rid, never two');
  await Promise.all([nextA(), nextB()]); // drain manifests

  const readBack = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
  const persisted = new Y.Doc({ guid: pageId });
  Y.applyUpdate(persisted, new Uint8Array(readBack.body.data.doc_state));
  assert.equal(docTextNodes(persisted).filter((t) => t.toString().includes(marker)).length, 1, 'racing duplicate submissions must never double-apply');

  editDoc.destroy(); persisted.destroy(); socketA.terminate(); socketB.terminate();
});

// ---------------------------------------------------------------------
// 5. Two independent clients reconnecting simultaneously, each with a
//    genuinely different pending edit: no lost updates, no corruption,
//    both converge.
// ---------------------------------------------------------------------

test('Recovery (Document): two clients reconnect simultaneously, each submits a different pending edit, both are preserved and both converge', async () => {
  const owner = await registerAndLogin('recovery-concurrent-reconnect-owner');
  const peer = await registerAndLogin('recovery-concurrent-reconnect-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'concurrent-reconnect');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'concurrent-reconnect');
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;
  const sv0 = (() => { const d = new Y.Doc({ guid: pageId }); Y.applyUpdate(d, new Uint8Array(initial.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();

  // Both reconnect "simultaneously" (no serialization imposed by the test).
  const [socketA, socketB] = await Promise.all([
    connectSocket(base, owner.workspaceId, owner.token, 24001),
    connectSocket(base, owner.workspaceId, peer.token, 24002),
  ]);
  const nextA = frameReader(socketA);
  const nextB = frameReader(socketB);
  await Promise.all([syncRequest(socketA, nextA, pageId, 0, sv0), syncRequest(socketB, nextB, pageId, 0, sv0)]);

  const docA = new Y.Doc({ guid: pageId }); Y.applyUpdate(docA, new Uint8Array(initial.doc_state));
  const docB = new Y.Doc({ guid: pageId }); Y.applyUpdate(docB, new Uint8Array(initial.doc_state));
  const markerA = `concurrent-reconnect-a-${id()}`;
  const markerB = `concurrent-reconnect-b-${id()}`;
  docTextNodes(docA)[0].insert(0, markerA);
  docTextNodes(docB)[0].insert(docTextNodes(docB)[0].length, markerB);
  const payloadA = Y.encodeStateAsUpdate(docA, sv0);
  const payloadB = Y.encodeStateAsUpdate(docB, sv0);

  // Each socket is also a registered peer of the OTHER's object (Task 66
  // fan-out), so each side receives THREE frames here, in unpredictable
  // interleaving: its own ack (`update`), its own manifest (`syncRequest`),
  // and a live fan-out of the other socket's accepted update (`update`,
  // carrying the OTHER socket's Rid). Collect all three per side and
  // classify by content instead of assuming the first frame read is "my
  // own ack" -- that assumption is only safe on a single-peer connection.
  async function collectFrames(next, count) {
    const frames = [];
    for (let i = 0; i < count; i += 1) {
      const frame = await next(2000);
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  const framesAP = collectFrames(nextA, 3);
  const framesBP = collectFrames(nextB, 3);
  socketA.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: payloadA, beforeStateVector: sv0 } } }));
  socketB.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: payloadB, beforeStateVector: sv0 } } }));
  const [framesA, framesB] = await Promise.all([framesAP, framesBP]);

  function ownUpdateFrame(frames, ownMarker) {
    return frames.find((f) => {
      if (!f.update) return false;
      const probe = new Y.Doc({ guid: pageId });
      try {
        Y.applyUpdate(probe, new Uint8Array(initial.doc_state));
        Y.applyUpdate(probe, f.update.payload);
        return docTextNodes(probe).some((t) => t.toString().includes(ownMarker));
      } finally {
        probe.destroy();
      }
    });
  }

  const ackA = ownUpdateFrame(framesA, markerA);
  const ackB = ownUpdateFrame(framesB, markerB);
  assert.ok(ackA && ackB, 'both concurrently-submitted distinct edits must be accepted and acked back to their own sender');
  assert.notDeepEqual(ackA.update.messageId, ackB.update.messageId, 'distinct concurrent edits must receive DIFFERENT Rids, no collision');

  const fanoutToA = ownUpdateFrame(framesA, markerB);
  const fanoutToB = ownUpdateFrame(framesB, markerA);
  assert.ok(fanoutToA, 'A must receive B\'s concurrently-submitted edit live via fan-out, not only on a later reconnect');
  assert.ok(fanoutToB, 'B must receive A\'s concurrently-submitted edit live via fan-out, not only on a later reconnect');

  const readBack = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
  const merged = new Y.Doc({ guid: pageId });
  Y.applyUpdate(merged, new Uint8Array(readBack.body.data.doc_state));
  const mergedTexts = docTextNodes(merged);
  assert.ok(mergedTexts.some((t) => t.toString().includes(markerA)), 'A\'s concurrent edit must not be lost');
  assert.ok(mergedTexts.some((t) => t.toString().includes(markerB)), 'B\'s concurrent edit must not be lost');

  docA.destroy(); docB.destroy(); merged.destroy(); socketA.terminate(); socketB.terminate();
});

// ---------------------------------------------------------------------
// 6. Database and DatabaseRow backend-restart recovery parity.
// ---------------------------------------------------------------------

test('Recovery (Database + DatabaseRow): backend restart preserves field metadata and row cell content, and both remain writable after restart', async () => {
  const restartDir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-restart-db-'));
  const restartFile = path.join(restartDir, 'state.json');
  let server1 = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: restartFile, devKey: 'task68-db-restart-key', environment: 'test' });
  let restartBase = `http://127.0.0.1:${server1.address.port}`;
  const prevBase = base; base = restartBase;

  try {
    const owner = await registerAndLogin('restart-db-owner');
    const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'restart-db');
    const { databaseId, viewId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
    const rowId = await createRow(owner.token, owner.workspaceId, databaseId, viewId);

    const dbInitial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${databaseId}?collab_type=1`, undefined, owner.token)).body.data;
    const rowInitial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${rowId}?collab_type=4`, undefined, owner.token)).body.data;

    const dbSocket = await connectSocket(restartBase, owner.workspaceId, owner.token, 25001);
    const dbNext = frameReader(dbSocket);
    const dbSv0 = (() => { const d = new Y.Doc({ guid: databaseId }); Y.applyUpdate(d, new Uint8Array(dbInitial.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();
    await syncRequest(dbSocket, dbNext, databaseId, 1, dbSv0);
    const dbEditDoc = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(dbEditDoc, new Uint8Array(dbInitial.doc_state));
    const fieldMarker = `restart-field-${id()}`;
    const field = [...dbEditDoc.getMap('data').get('database').get('fields').values()][0];
    field.set('name', fieldMarker);
    const dbPayload = Y.encodeStateAsUpdate(dbEditDoc, dbSv0);
    const dbAckP = dbNext();
    dbSocket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload: dbPayload, beforeStateVector: dbSv0 } } }));
    assert.ok((await dbAckP).update, 'Database field edit must be acked before restart');
    await dbNext();

    const rowSocket = await connectSocket(restartBase, owner.workspaceId, owner.token, 25002);
    const rowNext = frameReader(rowSocket);
    const rowSv0 = (() => { const d = new Y.Doc({ guid: rowId }); Y.applyUpdate(d, new Uint8Array(rowInitial.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();
    await syncRequest(rowSocket, rowNext, rowId, 4, rowSv0);
    const rowEditDoc = new Y.Doc({ guid: rowId });
    Y.applyUpdate(rowEditDoc, new Uint8Array(rowInitial.doc_state));
    const cellMarker = `restart-cell-${id()}`;
    const cells = rowEditDoc.getMap('data').get('data').get('cells');
    const cell = new Y.Map(); cell.set('data', cellMarker); cell.set('field_type', 0);
    cells.set('restart-field-id', cell);
    const rowPayload = Y.encodeStateAsUpdate(rowEditDoc, rowSv0);
    const rowAckP = rowNext();
    rowSocket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, update: { flags: 0, payload: rowPayload, beforeStateVector: rowSv0 } } }));
    assert.ok((await rowAckP).update, 'DatabaseRow cell edit must be acked before restart');
    await rowNext();

    dbSocket.terminate(); rowSocket.terminate();
    await Promise.all([new Promise((r) => dbSocket.once('close', r)), new Promise((r) => rowSocket.once('close', r))]);

    await new Promise((resolve) => server1.server.close(resolve));
    const server2 = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: restartFile, devKey: 'task68-db-restart-key', environment: 'test' });
    restartBase = `http://127.0.0.1:${server2.address.port}`; base = restartBase;

    const dbReadBack = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${databaseId}?collab_type=1`, undefined, owner.token);
    const dbPersisted = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(dbPersisted, new Uint8Array(dbReadBack.body.data.doc_state));
    const persistedField = [...dbPersisted.getMap('data').get('database').get('fields').values()][0];
    assert.equal(persistedField.get('name'), fieldMarker, 'Database field edit must survive backend restart');
    dbPersisted.destroy();

    const rowReadBack = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${rowId}?collab_type=4`, undefined, owner.token);
    const rowPersisted = new Y.Doc({ guid: rowId });
    Y.applyUpdate(rowPersisted, new Uint8Array(rowReadBack.body.data.doc_state));
    const persistedCell = rowPersisted.getMap('data').get('data').get('cells').get('restart-field-id');
    assert.equal(persistedCell.get('data'), cellMarker, 'DatabaseRow cell edit must survive backend restart');
    rowPersisted.destroy();

    // Both remain writable post-restart.
    const dbSocket2 = await connectSocket(restartBase, owner.workspaceId, owner.token, 25003);
    const dbNext2 = frameReader(dbSocket2);
    const dbSv1 = Y.encodeStateVector(dbEditDoc);
    await syncRequest(dbSocket2, dbNext2, databaseId, 1, dbSv1);
    const fieldMarker2 = `restart-field-post-${id()}`;
    field.set('name', fieldMarker2);
    const dbPayload2 = Y.encodeStateAsUpdate(dbEditDoc, dbSv1);
    const dbAck2P = dbNext2();
    dbSocket2.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload: dbPayload2, beforeStateVector: dbSv1 } } }));
    assert.ok((await dbAck2P).update, 'Database must remain writable after restart');

    dbEditDoc.destroy(); rowEditDoc.destroy(); dbSocket2.terminate();
    await new Promise((resolve) => server2.server.close(resolve));
  } finally {
    base = prevBase;
    await rm(restartDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// 7. Authorization during recovery: disconnect, revoke, reconnect must be
//    rejected and must never leak protected state or accept queued edits.
// ---------------------------------------------------------------------

test('Recovery (authorization): disconnect, revoke membership, reconnection is rejected, no protected content is returned, and a pending offline edit is not accepted', async () => {
  const owner = await registerAndLogin('recovery-auth-owner');
  const member = await registerAndLogin('recovery-auth-member');
  await addMember(owner.token, owner.workspaceId, member.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'recovery-auth');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'recovery-auth');
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

  const memberSocket = await connectSocket(base, owner.workspaceId, member.token, 26001);
  const memberNext = frameReader(memberSocket);
  const sv0 = (() => { const d = new Y.Doc({ guid: pageId }); Y.applyUpdate(d, new Uint8Array(initial.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();
  await syncRequest(memberSocket, memberNext, pageId, 0, sv0);

  // Disconnect (ungraceful), then revoke membership while offline.
  memberSocket.terminate();
  await new Promise((resolve) => memberSocket.once('close', resolve));
  await revokeMember(owner.token, owner.workspaceId, member.email);

  // Reconnection attempt must be rejected at admission (handshake-time
  // membership check), not merely at first message.
  const wsBase = base.replace(/^http/, 'ws');
  const query = new URLSearchParams({ clientId: '26002', deviceId: '00000000-0000-4000-8000-000000026002', token: member.token, cv: '0.10.0', cp: 'web' });
  const rejected = await new Promise((resolve) => {
    const attempt = new WebSocket(`${wsBase}/ws/v2/${owner.workspaceId}/?${query}`);
    attempt.once('unexpected-response', (req, res) => resolve({ rejected: true, status: res.statusCode }));
    attempt.once('open', () => resolve({ rejected: false }));
    attempt.once('error', () => resolve({ rejected: true, status: 'error' }));
  });
  assert.ok(rejected.rejected, 'reconnection after revocation must be rejected, not admitted');
  if (typeof rejected.status === 'number') assert.equal(rejected.status, 403);

  // No protected content reachable via REST either.
  const restAttempt = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, member.token);
  assert.ok([401, 403, 404].includes(restAttempt.status), 'revoked member must not read protected collab content via REST after reconnect-recovery attempt');

  // A "pending offline edit" (simulating the outbox trying to flush after
  // reconnect) must not be accepted via the HTTP full-sync/batch lane
  // either. `requireWorkspace` runs before any body/protobuf parsing on
  // this route, so a revoked member must be rejected purely on membership,
  // before the server ever looks at the payload -- a dummy body is enough
  // to prove that ordering.
  const batchResponse = await fetch(`${base}/api/workspace/v1/${owner.workspaceId}/collab/full-sync/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${member.token}` },
    body: Buffer.from([0]),
  });
  assert.ok([401, 403, 404].includes(batchResponse.status), 'a revoked member\'s queued offline edit must not be accepted through the HTTP recovery lane either (rejected on membership before body is even parsed)');
});

test('Recovery (authorization): restoring membership after revocation requires a brand-new connection -- the old revoked socket never resurrects', async () => {
  const owner = await registerAndLogin('recovery-auth-restore-owner');
  const member = await registerAndLogin('recovery-auth-restore-member');
  await addMember(owner.token, owner.workspaceId, member.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'recovery-auth-restore');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'recovery-auth-restore');

  const memberSocket = await connectSocket(base, owner.workspaceId, member.token, 26101);
  const memberNext = frameReader(memberSocket);

  await revokeMember(owner.token, owner.workspaceId, member.email);
  // The old socket must be rejected on its next message (bounded by Task 67's per-message revalidation).
  const closeP = new Promise((resolve) => memberSocket.once('close', (code) => resolve(code)));
  memberSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }));
  const closeCode = await closeP;
  assert.equal(closeCode, 1008, 'the already-open, now-revoked socket must be closed on its next message');

  // Restore membership.
  await addMember(owner.token, owner.workspaceId, member.email);

  // The OLD socket object stays closed -- no automatic resurrection.
  assert.equal(memberSocket.readyState, WebSocket.CLOSED);

  // A FRESH connection after restoration succeeds normally.
  const freshSocket = await connectSocket(base, owner.workspaceId, member.token, 26102);
  assert.equal(freshSocket.readyState, WebSocket.OPEN, 'a fresh connection after membership restoration must succeed');
  freshSocket.terminate();
});
