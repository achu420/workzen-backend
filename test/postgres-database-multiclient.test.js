// Task 63: multi-client verification for PostgreSQL-backed Database/
// DatabaseRow collaboration, at the real WebSocket PROTOCOL level (two
// independent real WebSocket connections against a real Postgres-backed
// server), rather than two full browser UI contexts.
//
// Why protocol-level rather than two Playwright browser contexts: while
// building the real-browser evidence for this task (see
// docs/task63-evidence/fresh-session-navigation-gap/), a genuine,
// PRE-EXISTING, storage-mode-agnostic defect was discovered and traced to
// its exact cause: `GET /api/workspace/{id}/database` (server.js, the
// workspace-wide Database catalog the frontend uses to discover which
// existing views are Database objects) unconditionally returns
// `{ databases: [], has_more: false }` (server.js ~line 1461) regardless of
// what has actually been created. This is not Postgres-specific code at all
// -- it is a hardcoded stub that never calls into `store`, present
// identically in JSON mode -- but it means ANY browser session that did not
// itself just complete the creation flow (a second real user's first open
// of a shared Database, or the SAME user after a fresh login) cannot
// discover that a given view is a Database and falls through to the
// Document-only page-view route, which then 404s. Fixing that catalog route
// is a separate, cross-cutting Folder/UI feature-completeness gap, not a
// Database/DatabaseRow *storage* parity issue, and is out of this task's
// scope (see the task brief's explicit "no new frontend UI features"
// boundary) -- it is documented here as a discovered limitation with exact
// evidence, not silently worked around.
//
// This test instead exercises the REAL collaboration protocol this backend
// actually implements for cross-client awareness: two independent
// WebSocket connections (modeling two independent AppFlowy-Web clients)
// both synced to the same PostgreSQL-backed Database/DatabaseRow objects.
// It answers the brief's actual question -- "does the existing broadcast
// mechanism carry an atomic REST row creation to other connected peers, and
// does it carry an ordinary Yjs WS update" -- with real evidence, for
// PostgreSQL storage, extending Task 62's JSON-mode finding.
//
// Task 66 update: Task 65 (architecture decision) approved, and Task 66
// implemented, extending the pre-existing awareness-relay fan-out pattern
// (websocketPeers, filtered by workspaceId+objectId) to accepted CONTENT
// `Update` frames for Document/Database/DatabaseRow, reusing the exact ack
// frame bytes. This changes the answer to "does an ordinary Yjs WS update
// broadcast to an already-connected peer" from NO (Task 63's finding, below)
// to YES -- Question 2's assertion is updated accordingly. Question 1's
// finding (the ATOMIC REST row-creation endpoint, Task 62/63/64, does not
// broadcast) is explicitly OUT of Task 66's scope and is confirmed
// unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { id } from '../auth.js';
import { startServer } from '../server.js';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;
let running, base;

async function api(method, route, payload, token, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

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
  return { email, token: login.body.access_token };
}

function connectSocket(workspaceId, token, clientId) {
  const wsBase = base.replace(/^http/, 'ws');
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${wsBase}/ws/v2/${workspaceId}/?${query}`);
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}
function frameReader(socket) {
  const pending = []; const waiters = [];
  socket.on('message', (frame, isBinary) => { const r = waiters.shift(); if (r) r({ frame, isBinary }); else pending.push({ frame, isBinary }); });
  return (timeoutMs = 1500) => new Promise((resolve) => {
    let waiterEntry;
    const timeout = setTimeout(() => {
      // On timeout, remove THIS waiter from the queue so a frame that
      // arrives after the timeout fires does not get swallowed by a stale,
      // already-resolved resolver -- without this, every later await on a
      // fresh frameReader() call for the SAME socket would hang forever,
      // since the real frame would be consumed by this dead waiter instead.
      const index = waiters.indexOf(waiterEntry);
      if (index !== -1) waiters.splice(index, 1);
      resolve(null); // null = no frame arrived (used to prove "no broadcast")
    }, timeoutMs);
    const accept = ({ frame, isBinary }) => { clearTimeout(timeout); resolve(isBinary ? decodeMessage(frame).collabMessage : null); };
    waiterEntry = accept;
    const p = pending.shift(); if (p) accept(p); else waiters.push(waiterEntry);
  });
}

test('PostgreSQL multi-client (WebSocket protocol level): the atomic REST row-creation endpoint now live-broadcasts the database update to a connected peer (a new row appears without a refresh), and so does an ordinary WS cell update (Task 66)', { skip: !configured }, async (t) => {
  running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey: 'task63-key', environment: 'test' });
  base = `http://127.0.0.1:${running.address.port}`;
  const openSockets = [];
  try {
    const owner = await registerAndLogin('pg-mc-owner');
    const ownerWorkspaceId = (await api('GET', '/api/user/workspace', undefined, owner.token)).body.data.visiting_workspace.workspace_id;
    const peer = await registerAndLogin('pg-mc-peer');
    // Add the peer as a real member of the owner's workspace (same dev-only
    // helper test/postgres.test.js already uses for cross-user scenarios).
    assert.equal((await api('POST', `/api/workspaces/${ownerWorkspaceId}/test-members`, { email: peer.email, role: 'member' }, owner.token, { 'x-development-key': 'task63-key' })).status, 201);

    const spaceId = id();
    assert.equal((await api('POST', `/api/workspace/${ownerWorkspaceId}/spaces`, { name: 'MC space', view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, owner.token)).status, 200);

    const dbRequest = {
      schema_version: 'v1', request_id: id(), parent_view_id: spaceId, name: '', position: { kind: 'start' }, container_id: id(),
      database: { database_id: id(), view_id: id(), name: 'Grid', layout: 0, embedded: false, responses_view_id: null, initial_row_ids: [], timezone_id: null },
    };
    const dbResponse = await api('POST', `/api/workspace/${ownerWorkspaceId}/v2/page-view/database/default`, dbRequest, owner.token);
    assert.equal(dbResponse.status, 200);
    const databaseId = dbRequest.database.database_id;
    const viewId = dbRequest.database.view_id;

    const ORIGINAL_DATABASE_RESTORE_ID = '00000000-0000-0000-0000-000000000000';
    async function createRow(token, position, cells = {}) {
      const request = { schema_version: 'v1', request_id: id(), row_id: id(), database_restore_id: ORIGINAL_DATABASE_RESTORE_ID, source_view_id: viewId, cells, height: 36, visibility: true, presentation: { icon_url: null, cover: null }, position };
      const response = await api('POST', `/api/workspace/${ownerWorkspaceId}/v2/database/${databaseId}/row/default`, request, token);
      return { request, response };
    }
    const row1 = await createRow(owner.token, { kind: 'end' });
    assert.equal(row1.response.status, 200);

    // Both clients connect and sync to the current Database state.
    const dbStateResp = await api('GET', `/api/workspace/v1/${ownerWorkspaceId}/collab/${databaseId}?collab_type=1`, undefined, owner.token);
    const baseVector = new Y.Doc({ guid: databaseId });
    const baseVectorState = new Uint8Array(dbStateResp.body.data.doc_state);
    Y.applyUpdate(baseVector, baseVectorState);

    const ownerSocket = await connectSocket(ownerWorkspaceId, owner.token, 9300);
    const peerSocket = await connectSocket(ownerWorkspaceId, peer.token, 9301);
    openSockets.push(ownerSocket, peerSocket);
    const ownerNext = frameReader(ownerSocket);
    const peerNext = frameReader(peerSocket);

    const ownerManifestP = ownerNext();
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(baseVector) } } }));
    assert.ok((await ownerManifestP).syncRequest);
    const peerManifestP = peerNext();
    peerSocket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(baseVector) } } }));
    assert.ok((await peerManifestP).syncRequest);

    // --- Question 1: does the atomic REST row-creation endpoint broadcast
    // to the peer's already-open WS connection? ---
    const peerIdleWatch = peerNext(2500); // races against row2 creation below
    const row2 = await createRow(owner.token, { kind: 'end' });
    assert.equal(row2.response.status, 200);
    const unsolicitedFrame = await peerIdleWatch;
    t.diagnostic(`REST row creation broadcast check: peer received ${unsolicitedFrame ? JSON.stringify(unsolicitedFrame) : 'NOTHING (no unsolicited frame within 2.5s)'}`);
    // Changed from "never broadcasts": a row added by one person must show up for everyone else who has the database
    // open, without a refresh. The peer receives the database update that inserts the row.
    assert.ok(unsolicitedFrame?.update, 'the atomic REST row-creation endpoint pushes the database update to connected WS peers');
    assert.equal(unsolicitedFrame.objectId, databaseId);
    assert.equal(unsolicitedFrame.collabType, 1);
    const pushed = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(pushed, new Uint8Array(baseVectorState));
    Y.applyUpdate(pushed, new Uint8Array(unsolicitedFrame.update.payload));
    const pushedOrders = pushed.getMap('data').get('database').get('views').get(viewId).get('row_orders').toArray().map((order) => order.id);
    assert.ok(pushedOrders.includes(row2.request.row_id), 'the pushed update contains the new row');
    // Anything else the server pushed alongside (it may also send a manifest) must not leak into the later checks.
    while (await peerNext(400)) { /* drain */ }
    while (await ownerNext(400)) { /* the creator's own open socket gets the same push */ }

    // The peer DOES see it once it issues a fresh SyncRequest (proving the
    // row is genuinely persisted and reachable, just not pushed
    // proactively). The peer's local baseVector is stale (still missing
    // row2), so the server's first response frame is an `update` carrying
    // the missing diff, followed by a `syncRequest` manifest echo (same
    // two-frame shape the WS handler always uses for a stale resync) --
    // read whichever one or two frames arrive and apply them.
    const resyncedDoc = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(resyncedDoc, Y.encodeStateAsUpdate(baseVector));
    peerSocket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(baseVector) } } }));
    const firstResyncFrame = await peerNext();
    assert.ok(firstResyncFrame && (firstResyncFrame.update || firstResyncFrame.syncRequest), `expected an update or syncRequest frame, got ${JSON.stringify(firstResyncFrame)}`);
    if (firstResyncFrame.update) Y.applyUpdate(resyncedDoc, firstResyncFrame.update.payload);
    // Drain a possible trailing manifest frame (non-fatal if none arrives).
    const maybeSecond = await peerNext(1000);
    if (maybeSecond && maybeSecond.update) Y.applyUpdate(resyncedDoc, maybeSecond.update.payload);
    const view = resyncedDoc.getMap('data').get('database').get('views').get(viewId);
    const orderIds = view.get('row_orders').toArray().map((o) => o.id);
    assert.deepEqual(orderIds, [row1.request.row_id, row2.request.row_id], 'a fresh SyncRequest must show BOTH rows -- the second row is durably persisted, just not proactively broadcast');
    resyncedDoc.destroy();

    // --- Question 2: does an ORDINARY Yjs WS update (e.g. a DatabaseRow
    // cell edit) reach the peer's already-open connection without it
    // asking again? As of Task 66, YES for the three WebSocket
    // Update-admission paths (Document/Database/DatabaseRow): after
    // storage durably accepts the update, server.js now fans the exact
    // same accepted-update frame bytes (already used as the sender's own
    // ack) out to every OTHER connected peer on the same
    // workspaceId+objectId, reusing the pre-existing websocketPeers
    // registry/filter the awarenessUpdate relay already used (same
    // predicate: `peer !== websocket`, `peer.readyState === 1`, same
    // workspaceId, same objectId). This is distinct from, and does not
    // change, the atomic REST row-creation endpoint tested in Question 1
    // above, which remains intentionally out of this fan-out (Task 66
    // explicitly excluded the REST-created-row path from scope).---
    const row1CollabResp = await api('GET', `/api/workspace/v1/${ownerWorkspaceId}/collab/${row1.request.row_id}?collab_type=4`, undefined, owner.token);
    const rowStateVector = (() => { const d = new Y.Doc({ guid: row1.request.row_id }); Y.applyUpdate(d, new Uint8Array(row1CollabResp.body.data.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();

    const ownerRowManifestP = ownerNext();
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: row1.request.row_id, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: rowStateVector } } }));
    assert.ok((await ownerRowManifestP).syncRequest);
    const peerRowManifestP = peerNext();
    peerSocket.send(encodeMessage({ collabMessage: { objectId: row1.request.row_id, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: rowStateVector } } }));
    assert.ok((await peerRowManifestP).syncRequest);

    const editDoc = new Y.Doc({ guid: row1.request.row_id });
    Y.applyUpdate(editDoc, new Uint8Array(row1CollabResp.body.data.doc_state));
    editDoc.getMap('data').get('data').set('multiclient_marker', 'edited-by-owner');
    const editPayload = Y.encodeStateAsUpdate(editDoc, rowStateVector);

    // Waiters are FIFO per socket, so register them in the order frames are
    // actually expected to arrive: the sender's own ack, then its own
    // manifest, then (if anything else ever arrived) an extra/duplicate
    // frame the sender must never receive (no duplicate self-delivery of
    // the fan-out).
    const peerBroadcastWatch = peerNext(3000);
    const ownerAckP = ownerNext();
    const ownerManifestAfterUpdateP = ownerNext();
    const ownerExtraFrameWatch = ownerNext(1500);
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: row1.request.row_id, collabType: 4, update: { flags: 0, payload: editPayload, beforeStateVector: rowStateVector } } }));
    const ownerAck = await ownerAckP;
    assert.ok(ownerAck.update, 'owner must receive its own ack');
    assert.ok((await ownerManifestAfterUpdateP).syncRequest, 'owner must still receive its own manifest frame, unchanged by Task 66');

    // Task 66: the peer's already-open connection must receive the accepted
    // update LIVE -- without sending any new SyncRequest -- carrying the
    // correct object ID and a decodable payload that converges with the
    // owner's edit.
    const peerBroadcast = await peerBroadcastWatch;
    t.diagnostic(`Ordinary WS cell-update broadcast check (Task 66): peer received ${peerBroadcast ? JSON.stringify({ objectId: peerBroadcast.objectId, collabType: peerBroadcast.collabType, messageId: peerBroadcast.update?.messageId }) : 'NOTHING'}`);
    assert.ok(peerBroadcast, 'Task 66: an ordinary Yjs WS update must now live-broadcast to another already-connected peer on the same object (no new SyncRequest needed)');
    assert.ok(peerBroadcast.update, 'the live broadcast must be an `update` frame, reusing the same shape as the sender\'s own ack');
    assert.equal(peerBroadcast.objectId, row1.request.row_id, 'the broadcast must carry the correct DatabaseRow object ID');
    assert.equal(peerBroadcast.collabType, 4, 'the broadcast must carry the correct collabType (DatabaseRow = 4)');
    assert.ok(peerBroadcast.update.messageId && Number(peerBroadcast.update.messageId.timestamp) > 0, 'the broadcast must carry a real server-assigned messageId, not a client-side placeholder');
    assert.deepEqual(peerBroadcast.update.messageId, ownerAck.update.messageId, 'the live broadcast must carry the exact same server-assigned messageId as the sender\'s own ack (byte-identical accepted-update reuse)');

    // Apply the LIVE broadcast (not a resync) to the peer's own local Yjs
    // doc and verify it converges with the owner's edit -- this is the
    // proof that a second already-connected client observes the change
    // live, not merely that a frame was sent.
    const peerLiveDoc = new Y.Doc({ guid: row1.request.row_id });
    Y.applyUpdate(peerLiveDoc, new Uint8Array(row1CollabResp.body.data.doc_state));
    Y.applyUpdate(peerLiveDoc, peerBroadcast.update.payload);
    assert.equal(peerLiveDoc.getMap('data').get('data').get('multiclient_marker'), 'edited-by-owner', 'the peer must see the cell edit immediately via the live broadcast, with no SyncRequest round trip');
    peerLiveDoc.destroy();

    // The sender itself must not also receive this as an extra/duplicate
    // peer-delivery frame beyond its own ack+manifest pair.
    const ownerExtraFrame = await ownerExtraFrameWatch;
    assert.equal(ownerExtraFrame, null, 'the sender must never receive its own update a second time as a peer-delivery frame');

    // Durability: the edit must also survive a fresh SyncRequest/reconnect,
    // proving the live push and the persisted state agree.
    const peerRowResyncP = peerNext();
    peerSocket.send(encodeMessage({ collabMessage: { objectId: row1.request.row_id, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: rowStateVector } } }));
    const peerRowResync = await peerRowResyncP;
    assert.ok(peerRowResync.update, 'a fresh SyncRequest after a stale state vector must return the missing update');
    const resyncedRowDoc = new Y.Doc({ guid: row1.request.row_id });
    Y.applyUpdate(resyncedRowDoc, new Uint8Array(row1CollabResp.body.data.doc_state));
    Y.applyUpdate(resyncedRowDoc, peerRowResync.update.payload);
    assert.equal(resyncedRowDoc.getMap('data').get('data').get('multiclient_marker'), 'edited-by-owner', 'the persisted state read via a fresh SyncRequest must match what the live broadcast already showed');
    resyncedRowDoc.destroy();
  } finally {
    for (const socket of openSockets) { try { socket.terminate(); } catch { /* ignore */ } }
    await running.app.store.close();
    await new Promise((resolve) => running.server.close(resolve));
  }
});
