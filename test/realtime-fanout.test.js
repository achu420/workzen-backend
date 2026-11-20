// Task 66: automated coverage for the peer-fanout extension described in
// docs/TASK65_REALTIME_COLLABORATION_ARCHITECTURE_DECISION.md (approved
// Option B) and implemented in server.js. Extends the pre-existing
// websocketPeers/awarenessUpdate relay pattern to accepted content `Update`
// frames for Document (collabType=0), Database (collabType=1), and
// DatabaseRow (collabType=4), reusing the exact ack frame bytes.
//
// This file covers the JSON-storage half of the required 6-combo matrix
// (Document/Database/DatabaseRow x JSON/Postgres) plus the negative/
// isolation/failure-handling cases. The PostgreSQL half of the matrix is
// covered by test/postgres-realtime-fanout-document.test.js (Document) and
// the Task 66-updated test/postgres-database-multiclient.test.js
// (Database, DatabaseRow).
//
// Conventions mirror test/database-row-collab.test.js and
// test/postgres-database-multiclient.test.js: same `api()` HTTP helper
// shape, same WebSocket connect helper, and a frame reader that resolves
// `null` on timeout (rather than rejecting) so "peer received NOTHING" can
// be asserted directly as a real outcome, not an exception.
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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-realtime-fanout-'));
  dataFile = path.join(dir, 'state.json');
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: dataFile, devKey: 'task66-key', environment: 'test' });
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
    (await api('POST', `/api/workspaces/${workspaceId}/test-members`, { email: memberEmail, role: 'member' }, ownerToken, { 'x-development-key': 'task66-key' })).status,
    201
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

function connectSocket(workspaceId, token, clientId) {
  const wsBase = base.replace(/^http/, 'ws');
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${wsBase}/ws/v2/${workspaceId}/?${query}`);
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

// Resolves `null` on timeout instead of rejecting, so "peer received
// NOTHING" is a real, assertable outcome rather than an exception.
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
// the caller's claimed state vector is behind the server's current stored
// state (e.g. an empty vector on reconnect, or a socket reused after other
// updates have landed on the same object), the server first sends a
// missing-diff `update` frame, THEN the manifest. Reading only one frame in
// that case grabs the diff instead of the manifest. This drains any number
// of leading `update` frames and returns the manifest.
async function readManifest(next) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const frame = await next();
    if (!frame || frame.syncRequest) return frame;
  }
  return null;
}

// An accepted `update` always produces TWO frames to the sender: the ack
// (`update`) and the accompanying manifest (`syncRequest`) immediately
// after it. Reading only the ack and leaving the manifest unread corrupts
// any LATER read on the same (reused) socket, which would then consume
// that stale leftover instead of its own real response. This reads the ack
// and always drains the manifest that follows it before returning.
async function readAckThenDrainManifest(next) {
  const ack = await next();
  if (ack && ack.update) await next();
  return ack;
}

async function syncBoth(objectId, collabType, ownerSocket, ownerNext, peerSocket, peerNext, baseDocState) {
  const baseVector = new Y.Doc({ guid: objectId });
  Y.applyUpdate(baseVector, baseDocState);
  const sv = Y.encodeStateVector(baseVector);
  const ownerManifestP = readManifest(ownerNext);
  ownerSocket.send(encodeMessage({ collabMessage: { objectId, collabType, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv } } }));
  const ownerManifest = await ownerManifestP;
  assert.ok(ownerManifest && ownerManifest.syncRequest, 'owner side of syncBoth must receive a manifest frame');
  const peerManifestP = readManifest(peerNext);
  peerSocket.send(encodeMessage({ collabMessage: { objectId, collabType, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv } } }));
  const peerManifest = await peerManifestP;
  assert.ok(peerManifest && peerManifest.syncRequest, 'peer side of syncBoth must receive a manifest frame');
  baseVector.destroy();
  return sv;
}

// ---------------------------------------------------------------------
// Positive delivery: Document / Database / DatabaseRow (JSON storage)
// ---------------------------------------------------------------------

test('Task 66 fan-out (JSON, Document): an already-connected second client receives an accepted Document update live, without sending a new SyncRequest, and content converges', async () => {
  const owner = await registerAndLogin('fanout-doc-owner');
  const peer = await registerAndLogin('fanout-doc-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'doc-fanout');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'doc-fanout');
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

  const ownerSocket = await connectSocket(owner.workspaceId, owner.token, 9001);
  const peerSocket = await connectSocket(owner.workspaceId, peer.token, 9002);
  try {
    const ownerNext = frameReader(ownerSocket);
    const peerNext = frameReader(peerSocket);
    const beforeSv = await syncBoth(pageId, 0, ownerSocket, ownerNext, peerSocket, peerNext, new Uint8Array(initial.doc_state));

    const editDoc = new Y.Doc({ guid: pageId });
    Y.applyUpdate(editDoc, new Uint8Array(initial.doc_state));
    const text = [...editDoc.getMap('data').get('document').get('meta').get('text_map').values()].find((v) => v instanceof Y.Text);
    const marker = `task66-doc-${id()}`;
    text.insert(text.length, marker);
    const payload = Y.encodeStateAsUpdate(editDoc, beforeSv);

    const peerLiveWatch = peerNext(3000);
    const ownerAckP = ownerNext();
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: beforeSv } } }));
    const ownerAck = await ownerAckP;
    assert.ok(ownerAck.update, 'sender must still receive its own ack, unchanged');

    const peerLive = await peerLiveWatch;
    assert.ok(peerLive, 'an already-connected peer must receive the accepted Document update live');
    assert.ok(peerLive.update, 'the live delivery must be an `update` frame');
    assert.equal(peerLive.objectId, pageId);
    assert.equal(peerLive.collabType, 0);
    assert.deepEqual(peerLive.update.messageId, ownerAck.update.messageId, 'peer must receive the exact same server-assigned messageId as the sender\'s own ack');

    const peerDoc = new Y.Doc({ guid: pageId });
    Y.applyUpdate(peerDoc, new Uint8Array(initial.doc_state));
    Y.applyUpdate(peerDoc, peerLive.update.payload);
    const peerTexts = [...peerDoc.getMap('data').get('document').get('meta').get('text_map').values()].filter((v) => v instanceof Y.Text);
    assert.ok(peerTexts.some((v) => v.toString().includes(marker)), 'peer\'s own Yjs doc must converge with the sender\'s edit after applying the live frame');
    peerDoc.destroy();
    editDoc.destroy();

    // Persisted state remains correct after a fresh reconnect/SyncRequest.
    const reconnected = await connectSocket(owner.workspaceId, peer.token, 9003);
    try {
      const reconnectedNext = frameReader(reconnected);
      // An empty state vector is always stale relative to the server's
      // real stored content, so this deliberately triggers the two-frame
      // (missing-diff `update`, then manifest `syncRequest`) response --
      // readManifest drains the diff frame and returns the manifest.
      const manifestP = readManifest(reconnectedNext);
      reconnected.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }));
      const manifest = await manifestP;
      assert.ok(manifest && manifest.syncRequest);
      const readBack = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
      const persisted = new Y.Doc({ guid: pageId });
      Y.applyUpdate(persisted, new Uint8Array(readBack.body.data.doc_state));
      const persistedTexts = [...persisted.getMap('data').get('document').get('meta').get('text_map').values()].filter((v) => v instanceof Y.Text);
      assert.ok(persistedTexts.some((v) => v.toString().includes(marker)), 'edit must be durably persisted and readable after reconnect');
      persisted.destroy();
    } finally {
      reconnected.terminate();
    }
  } finally {
    ownerSocket.terminate();
    peerSocket.terminate();
  }
});

test('Task 66 fan-out (JSON, Database): an already-connected second client receives an accepted Database field update live', async () => {
  const owner = await registerAndLogin('fanout-db-owner');
  const peer = await registerAndLogin('fanout-db-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'db-fanout');
  const { databaseId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${databaseId}?collab_type=1`, undefined, owner.token)).body.data;

  const ownerSocket = await connectSocket(owner.workspaceId, owner.token, 9011);
  const peerSocket = await connectSocket(owner.workspaceId, peer.token, 9012);
  try {
    const ownerNext = frameReader(ownerSocket);
    const peerNext = frameReader(peerSocket);
    const beforeSv = await syncBoth(databaseId, 1, ownerSocket, ownerNext, peerSocket, peerNext, new Uint8Array(initial.doc_state));

    const editDoc = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(editDoc, new Uint8Array(initial.doc_state));
    const field = [...editDoc.getMap('data').get('database').get('fields').values()][0];
    const marker = `task66-db-${id()}`;
    field.set('name', marker);
    const payload = Y.encodeStateAsUpdate(editDoc, beforeSv);

    const peerLiveWatch = peerNext(3000);
    const ownerAckP = ownerNext();
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload, beforeStateVector: beforeSv } } }));
    const ownerAck = await ownerAckP;
    assert.ok(ownerAck.update);

    const peerLive = await peerLiveWatch;
    assert.ok(peerLive, 'peer must receive the accepted Database update live');
    assert.equal(peerLive.objectId, databaseId);
    assert.equal(peerLive.collabType, 1);
    assert.deepEqual(peerLive.update.messageId, ownerAck.update.messageId);

    const peerDoc = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(peerDoc, new Uint8Array(initial.doc_state));
    Y.applyUpdate(peerDoc, peerLive.update.payload);
    const names = [...peerDoc.getMap('data').get('database').get('fields').values()].map((v) => v.get('name'));
    assert.ok(names.includes(marker), 'peer must see the renamed field after applying the live frame');
    peerDoc.destroy();
    editDoc.destroy();
  } finally {
    ownerSocket.terminate();
    peerSocket.terminate();
  }
});

test('Task 66 fan-out (JSON, DatabaseRow): an already-connected second client receives an accepted cell update live', async () => {
  const owner = await registerAndLogin('fanout-row-owner');
  const peer = await registerAndLogin('fanout-row-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'row-fanout');
  const { databaseId, viewId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  const rowId = await createRow(owner.token, owner.workspaceId, databaseId, viewId);
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${rowId}?collab_type=4`, undefined, owner.token)).body.data;

  const ownerSocket = await connectSocket(owner.workspaceId, owner.token, 9021);
  const peerSocket = await connectSocket(owner.workspaceId, peer.token, 9022);
  try {
    const ownerNext = frameReader(ownerSocket);
    const peerNext = frameReader(peerSocket);
    const beforeSv = await syncBoth(rowId, 4, ownerSocket, ownerNext, peerSocket, peerNext, new Uint8Array(initial.doc_state));

    const editDoc = new Y.Doc({ guid: rowId });
    Y.applyUpdate(editDoc, new Uint8Array(initial.doc_state));
    const marker = `task66-row-${id()}`;
    editDoc.getMap('data').get('data').set('multiclient_marker', marker);
    const payload = Y.encodeStateAsUpdate(editDoc, beforeSv);

    const peerLiveWatch = peerNext(3000);
    const ownerAckP = ownerNext();
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, update: { flags: 0, payload, beforeStateVector: beforeSv } } }));
    const ownerAck = await ownerAckP;
    assert.ok(ownerAck.update);

    const peerLive = await peerLiveWatch;
    assert.ok(peerLive, 'peer must receive the accepted DatabaseRow cell update live');
    assert.equal(peerLive.objectId, rowId);
    assert.equal(peerLive.collabType, 4);
    assert.deepEqual(peerLive.update.messageId, ownerAck.update.messageId);

    const peerDoc = new Y.Doc({ guid: rowId });
    Y.applyUpdate(peerDoc, new Uint8Array(initial.doc_state));
    Y.applyUpdate(peerDoc, peerLive.update.payload);
    assert.equal(peerDoc.getMap('data').get('data').get('multiclient_marker'), marker);
    peerDoc.destroy();
    editDoc.destroy();
  } finally {
    ownerSocket.terminate();
    peerSocket.terminate();
  }
});

// ---------------------------------------------------------------------
// Negative / isolation / failure-handling cases (Document, representative
// -- the fan-out code path is textually identical across all three collab
// types, reusing the exact same websocketPeers registry/filter, so these
// are not repeated per-type).
// ---------------------------------------------------------------------

test('Task 66 fan-out negative cases (Document, JSON storage): sender no-dup, cross-workspace isolation, cross-object isolation, disconnected peer, validation-rejected, storage-rejected, one failed peer does not block another', async () => {
  const owner = await registerAndLogin('fanout-neg-owner');
  const peerSameObject = await registerAndLogin('fanout-neg-peer-same');
  const peerAnotherObject = await registerAndLogin('fanout-neg-peer-other-obj');
  await addMember(owner.token, owner.workspaceId, peerSameObject.email);
  await addMember(owner.token, owner.workspaceId, peerAnotherObject.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'neg-fanout');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'neg-fanout');
  const otherPageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'neg-fanout-other');
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;
  const otherInitial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${otherPageId}?collab_type=0`, undefined, owner.token)).body.data;

  // A fully separate workspace/user, for the cross-workspace isolation case.
  const otherWorkspaceOwner = await registerAndLogin('fanout-neg-other-ws-owner');
  const otherWorkspaceSpaceId = await createPublicSpace(otherWorkspaceOwner.token, otherWorkspaceOwner.workspaceId, 'other-ws');
  const otherWorkspacePageId = await createDocumentPage(otherWorkspaceOwner.token, otherWorkspaceOwner.workspaceId, otherWorkspaceSpaceId, 'other-ws');
  const otherWorkspaceInitial = (await api('GET', `/api/workspace/v1/${otherWorkspaceOwner.workspaceId}/collab/${otherWorkspacePageId}?collab_type=0`, undefined, otherWorkspaceOwner.token)).body.data;

  const ownerSocket = await connectSocket(owner.workspaceId, owner.token, 9101);
  const sameObjectPeerSocket = await connectSocket(owner.workspaceId, peerSameObject.token, 9102);
  const differentObjectPeerSocket = await connectSocket(owner.workspaceId, peerAnotherObject.token, 9103);
  const differentWorkspaceSocket = await connectSocket(otherWorkspaceOwner.workspaceId, otherWorkspaceOwner.token, 9104);
  try {
    const ownerNext = frameReader(ownerSocket);
    const sameObjectPeerNext = frameReader(sameObjectPeerSocket);
    const differentObjectPeerNext = frameReader(differentObjectPeerSocket);
    const differentWorkspaceNext = frameReader(differentWorkspaceSocket);

    const beforeSv = await syncBoth(pageId, 0, ownerSocket, ownerNext, sameObjectPeerSocket, sameObjectPeerNext, new Uint8Array(initial.doc_state));
    // differentObjectPeerSocket subscribes to a DIFFERENT object in the SAME
    // workspace -- isolate the object_id filter from the workspace filter.
    {
      const otherBase = new Y.Doc({ guid: otherPageId });
      Y.applyUpdate(otherBase, new Uint8Array(otherInitial.doc_state));
      const manifestP = differentObjectPeerNext();
      differentObjectPeerSocket.send(encodeMessage({ collabMessage: { objectId: otherPageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(otherBase) } } }));
      assert.ok((await manifestP).syncRequest);
      otherBase.destroy();
    }
    // differentWorkspaceSocket subscribes to its OWN unrelated object in a
    // completely separate workspace -- isolate the workspace_id filter.
    {
      const otherWsBase = new Y.Doc({ guid: otherWorkspacePageId });
      Y.applyUpdate(otherWsBase, new Uint8Array(otherWorkspaceInitial.doc_state));
      const manifestP = differentWorkspaceNext();
      differentWorkspaceSocket.send(encodeMessage({ collabMessage: { objectId: otherWorkspacePageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(otherWsBase) } } }));
      assert.ok((await manifestP).syncRequest);
      otherWsBase.destroy();
    }

    // A disconnected peer: connect, sync, then close before the edit.
    const disconnectingPeer = await registerAndLogin('fanout-neg-disconnecting');
    await addMember(owner.token, owner.workspaceId, disconnectingPeer.email);
    const disconnectingSocket = await connectSocket(owner.workspaceId, disconnectingPeer.token, 9105);
    const disconnectingNext = frameReader(disconnectingSocket);
    await syncBoth(pageId, 0, ownerSocket, ownerNext, disconnectingSocket, disconnectingNext, new Uint8Array(initial.doc_state));
    const closed = new Promise((resolve) => disconnectingSocket.once('close', resolve));
    disconnectingSocket.close();
    await closed;
    // Give the server's 'close' handler a tick to remove it from
    // websocketPeers (same existing close/error lifecycle convention the
    // awareness relay already depends on).
    await new Promise((resolve) => setTimeout(resolve, 50));

    function makeEdit(marker) {
      const doc = new Y.Doc({ guid: pageId });
      Y.applyUpdate(doc, new Uint8Array(initial.doc_state));
      const text = [...doc.getMap('data').get('document').get('meta').get('text_map').values()].find((v) => v instanceof Y.Text);
      text.insert(text.length, marker);
      const payload = Y.encodeStateAsUpdate(doc, beforeSv);
      doc.destroy();
      return payload;
    }

    // --- Case: sender gets no duplicate peer-delivery frame; cross-workspace
    // and cross-object peers receive nothing; a disconnected peer receives
    // nothing. All checked from ONE real accepted update, since all of
    // these negative claims are about the SAME broadcast event. ---
    {
      const marker = `task66-neg-${id()}`;
      const payload = makeEdit(marker);
      const sameObjectPeerLiveWatch = sameObjectPeerNext(3000);
      const differentObjectWatch = differentObjectPeerNext(1500);
      const differentWorkspaceWatch = differentWorkspaceNext(1500);
      const ownerAckP = ownerNext();
      const ownerManifestP = ownerNext();
      const ownerExtraWatch = ownerNext(1200);
      ownerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: beforeSv } } }));
      const ownerAck = await ownerAckP;
      assert.ok(ownerAck.update, 'sender must get its own ack');
      assert.ok((await ownerManifestP).syncRequest, 'sender must get its own manifest');

      const sameObjectPeerLive = await sameObjectPeerLiveWatch;
      assert.ok(sameObjectPeerLive && sameObjectPeerLive.update, 'the eligible same-workspace, same-object peer must receive the live broadcast');
      assert.deepEqual(sameObjectPeerLive.update.messageId, ownerAck.update.messageId);

      const ownerExtra = await ownerExtraWatch;
      assert.equal(ownerExtra, null, 'the sender must not receive a duplicate copy of its own update as a peer-delivery frame');

      const differentObjectResult = await differentObjectWatch;
      assert.equal(differentObjectResult, null, 'a peer subscribed to a DIFFERENT object in the same workspace must receive nothing');

      const differentWorkspaceResult = await differentWorkspaceWatch;
      assert.equal(differentWorkspaceResult, null, 'a peer in a completely different workspace must receive nothing');
    }

    // --- Case: a disconnected peer receives nothing (it was removed from
    // websocketPeers on close, same as the pre-existing awareness relay). ---
    {
      const marker = `task66-neg-disconnected-${id()}`;
      const payload = makeEdit(marker);
      const ownerAckP = readAckThenDrainManifest(ownerNext);
      ownerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: beforeSv } } }));
      const ownerAck = await ownerAckP;
      assert.ok(ownerAck && ownerAck.update);
      // No way to "read" from a closed socket; the proof is structural --
      // disconnectingSocket is closed and absent from websocketPeers, and
      // the update above succeeded without throwing despite that peer no
      // longer being connected, which would not be possible if the server
      // still tried to address it directly rather than iterating the live
      // registry.
      assert.equal(disconnectingSocket.readyState, WebSocket.CLOSED);
    }

    // --- Case: a validation-rejected update is never delivered to the peer
    // (malformed Yjs payload -> MALFORMED_YJS_UPDATE -> socket closed 1008,
    // no persistence, no broadcast). ---
    {
      const rejectRecipientSocket = await connectSocket(owner.workspaceId, peerSameObject.token, 9106);
      const rejectRecipientNext = frameReader(rejectRecipientSocket);
      try {
        const rejectBeforeSv = await syncBoth(pageId, 0, ownerSocket, ownerNext, rejectRecipientSocket, rejectRecipientNext, new Uint8Array(initial.doc_state));
        const peerWatch = rejectRecipientNext(2000);
        const closePromise = new Promise((resolve) => ownerSocket.once('close', (code) => resolve(code)));
        const malformedPayload = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]); // not a valid Yjs update
        const rejectSocket = await connectSocket(owner.workspaceId, owner.token, 9107);
        const rejectNext = frameReader(rejectSocket);
        const rejectManifestP = readManifest(rejectNext);
        rejectSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: rejectBeforeSv } } }));
        const rejectManifest = await rejectManifestP;
        assert.ok(rejectManifest && rejectManifest.syncRequest);
        const rejectClosePromise = new Promise((resolve) => rejectSocket.once('close', (code) => resolve(code)));
        rejectSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: malformedPayload, beforeStateVector: rejectBeforeSv } } }));
        const closeCode = await rejectClosePromise;
        assert.ok([1002, 1008, 1011].includes(closeCode), `malformed update must be rejected (got close code ${closeCode})`);
        const peerResult = await peerWatch;
        assert.equal(peerResult, null, 'a validation-rejected update must never be delivered to any peer');
        rejectSocket.terminate();
      } finally {
        rejectRecipientSocket.terminate();
      }
    }

    // --- Case: a storage-rejected update (persistence failure) is never
    // delivered to the peer, via Task 44's pre-existing store.persist
    // fault-injection hook. ---
    {
      const store = running.app.store;
      const originalPersist = store.persist;
      const failRecipientSocket = await connectSocket(owner.workspaceId, peerSameObject.token, 9108);
      const failRecipientNext = frameReader(failRecipientSocket);
      try {
        const failBeforeSv = await syncBoth(pageId, 0, ownerSocket, ownerNext, failRecipientSocket, failRecipientNext, new Uint8Array(initial.doc_state));
        const failSocket = await connectSocket(owner.workspaceId, owner.token, 9109);
        const failNext = frameReader(failSocket);
        const failManifestP = readManifest(failNext);
        failSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: failBeforeSv } } }));
        const failManifest = await failManifestP;
        assert.ok(failManifest && failManifest.syncRequest);

        const failDoc = new Y.Doc({ guid: pageId });
        Y.applyUpdate(failDoc, new Uint8Array(initial.doc_state));
        const failText = [...failDoc.getMap('data').get('document').get('meta').get('text_map').values()].find((v) => v instanceof Y.Text);
        failText.insert(failText.length, `task66-neg-storage-fail-${id()}`);
        const failPayload = Y.encodeStateAsUpdate(failDoc, failBeforeSv);
        failDoc.destroy();

        store.persist = async () => { throw new Error('task66 injected persistence failure'); };
        const peerWatch = failRecipientNext(2000);
        const closePromise = new Promise((resolve) => failSocket.once('close', (code) => resolve(code)));
        failSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: failPayload, beforeStateVector: failBeforeSv } } }));
        assert.equal(await closePromise, 1011, 'a genuine persistence failure must close the sender with 1011, unchanged by Task 66');
        const peerResult = await peerWatch;
        assert.equal(peerResult, null, 'an update that failed to persist must never be delivered to any peer');
        failSocket.terminate();
      } finally {
        store.persist = originalPersist;
        failRecipientSocket.terminate();
      }
    }

    // --- Case: one peer's failed send() must not block delivery to another
    // eligible peer, and must not be mistaken for a sender admission
    // failure. Monkey-patching the CLIENT-side socket's send() would not
    // exercise the real failure point -- the fan-out loop calls `.send()`
    // on the SERVER's own WebSocket instance for that connection, a
    // separate object this test does not otherwise have a handle to. The
    // `ws` library's WebSocketServer exposes exactly this via `.clients`
    // (returned from createApp as `running.app.websocketServer`), so the
    // real server-side peer object is located by diffing `.clients`
    // before/after the flaky client connects, and ITS `.send` is made to
    // throw -- the same fault-injection style already used for
    // `store.persist` (Task 44).
    {
      const beforeClients = new Set(running.app.websocketServer.clients);
      const flakySocket = await connectSocket(owner.workspaceId, peerAnotherObject.token, 9110);
      const healthySocket = await connectSocket(owner.workspaceId, peerSameObject.token, 9111);
      const flakyNext = frameReader(flakySocket);
      const healthyNext = frameReader(healthySocket);
      try {
        const flakyBeforeSv = await syncBoth(pageId, 0, ownerSocket, ownerNext, flakySocket, flakyNext, new Uint8Array(initial.doc_state));
        const healthyManifestP = readManifest(healthyNext);
        healthySocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: flakyBeforeSv } } }));
        const healthyManifest = await healthyManifestP;
        assert.ok(healthyManifest && healthyManifest.syncRequest);

        const serverSideFlakyPeer = [...running.app.websocketServer.clients].find((client) => !beforeClients.has(client) && client !== healthySocket);
        assert.ok(serverSideFlakyPeer, 'must locate the real server-side peer object for the flaky connection');
        const originalSend = serverSideFlakyPeer.send.bind(serverSideFlakyPeer);
        serverSideFlakyPeer.send = () => { throw new Error('task66 simulated flaky peer send failure'); };

        const healthyWatch = healthyNext(3000);
        const ownerAckP = readAckThenDrainManifest(ownerNext);
        const marker = `task66-neg-oneflaky-${id()}`;
        const payload = makeEdit(marker);
        ownerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: beforeSv } } }));
        const ownerAck = await ownerAckP;
        assert.ok(ownerAck && ownerAck.update, 'the sender must still receive its own ack even though one peer\'s send() threw');

        const healthyResult = await healthyWatch;
        assert.ok(healthyResult && healthyResult.update, 'a second, healthy peer must still receive the live broadcast even though another peer\'s send() failed');

        serverSideFlakyPeer.send = originalSend;
      } finally {
        flakySocket.terminate();
        healthySocket.terminate();
      }
    }
  } finally {
    ownerSocket.terminate();
    sameObjectPeerSocket.terminate();
    differentObjectPeerSocket.terminate();
    differentWorkspaceSocket.terminate();
  }
});
