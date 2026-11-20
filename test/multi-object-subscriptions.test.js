// Task 77.2: regression coverage for per-connection MULTI-OBJECT fan-out
// subscriptions.
//
// Task 77.1 found, with direct backend instrumentation, that Database
// (collabType=1) updates were durably persisted but never fanned out live to
// connected peers in a real browser session. Root cause: `websocket.objectId`
// is a single slot holding the LAST object a connection successfully
// SyncRequested, and the fan-out filter was `peer.objectId === objectId`. A
// real browser viewing a Database multiplexes the Database AND one
// DatabaseRow per row over one connection, so each row's SyncRequest
// overwrote the slot and the Database stopped matching.
//
// Why test/realtime-fanout.test.js (4/4 green) could not catch it: its
// `syncBoth(objectId, collabType, ...)` points BOTH sockets at exactly ONE
// object, so the slot always matched. That is the precise coverage gap Task
// 77.1 §9.5 item 3 identified, and this file closes it: every observer here
// subscribes to SEVERAL objects on ONE connection and then never
// re-SyncRequests, so delivery can only succeed if the server tracks the full
// subscription set rather than the active binding.
//
// Conventions deliberately mirror test/realtime-fanout.test.js (same api()
// helper shape, same connectSocket, same disposable JSON server, same
// fault-injection style) rather than introducing a second harness. The one
// addition is a frame COLLECTOR (instead of that file's sequential
// frameReader), because a multi-object observer receives interleaved frames
// for several objects and a strictly sequential reader cannot express
// "a frame for object X arrived at some point".
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

const DEV_KEY = 'task77-2-key';

// Task 77.2 §5: the subscription registry is ephemeral per-connection state,
// so it needs no schema change -- but it must be proven against BOTH storage
// backends rather than assumed storage-agnostic. The same scenarios therefore
// run unchanged in either mode, selected by TASK77_2_STORAGE, instead of
// maintaining a duplicate Postgres copy of this file.
const POSTGRES_MODE = process.env.TASK77_2_STORAGE === 'postgres';
const POSTGRES_CONFIGURED = !!process.env.DATABASE_URL;
const SKIP_ALL = POSTGRES_MODE && !POSTGRES_CONFIGURED;
const STORAGE_LABEL = POSTGRES_MODE ? 'PostgreSQL' : 'JSON';

let dir, running, base, dataFile;

// Returns the startServer options for the selected storage backend. `file` is
// only meaningful in JSON mode; `storage`/`databaseUrl` only in Postgres mode.
function storageOptions(extra = {}) {
  if (POSTGRES_MODE) {
    return { storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, environment: 'test', folderChangedDelayMs: 600000, ...extra };
  }
  return { host: '127.0.0.1', port: 0, environment: 'test', folderChangedDelayMs: 600000, ...extra };
}

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
  if (SKIP_ALL) {
    console.log('[task77.2] PostgreSQL mode requested but DATABASE_URL is not set -- all scenarios SKIPPED (reported BLOCKED, never substituted with JSON evidence)');
    return;
  }
  console.log(`[task77.2] storage backend under test: ${STORAGE_LABEL}`);
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-multi-object-subs-'));
  dataFile = path.join(dir, 'state.json');
  running = await startServer(storageOptions({ file: dataFile, devKey: DEV_KEY }));
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  if (SKIP_ALL) return;
  // An upgraded WebSocket that a test failed to close keeps
  // `server.close()`'s callback from ever firing, which turns any such test
  // bug into an INFINITE hang of the whole file (node --test runs with
  // --test-timeout=0 by default, so nothing rescues it). Terminating any
  // lingering server-side client first makes that failure mode a visible
  // test failure instead.
  for (const client of running.app.websocketServer.clients) client.terminate();
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const PUBLIC_SPACE_PERMISSION = {
  visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
  invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
  security: { disable_guests: false, disable_public_links: false, disable_export: false },
};

async function registerAndLogin(label, apiFn = api) {
  const email = `${label}-${id()}@example.test`;
  const password = 'Correct horse 907';
  assert.equal((await apiFn('POST', '/api/auth/register', { email, password })).status, 201);
  const login = await apiFn('POST', '/api/auth/login', { email, password });
  const token = login.body.access_token;
  const workspaceId = (await apiFn('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  return { email, token, workspaceId };
}

async function addMember(ownerToken, workspaceId, memberEmail, apiFn = api, devKey = DEV_KEY) {
  assert.equal(
    (await apiFn('POST', `/api/workspaces/${workspaceId}/test-members`, { email: memberEmail, role: 'member' }, ownerToken, { 'x-development-key': devKey })).status,
    201
  );
}

async function revokeMember(ownerToken, workspaceId, memberEmail, apiFn = api, devKey = DEV_KEY) {
  assert.equal(
    (await apiFn('DELETE', `/api/workspaces/${workspaceId}/test-members?email=${encodeURIComponent(memberEmail)}`, undefined, ownerToken, { 'x-development-key': devKey })).status,
    200
  );
}

async function createPublicSpace(token, workspaceId, label, apiFn = api) {
  const spaceId = id();
  assert.equal((await apiFn('POST', `/api/workspace/${workspaceId}/spaces`, { name: `${label} space`, view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, token)).status, 200);
  return spaceId;
}

async function createDocumentPage(token, workspaceId, spaceId, label, pageId = id(), apiFn = api) {
  const response = await apiFn('POST', `/api/workspace/${workspaceId}/v2/page-view/document/default`, {
    schema_version: 'v1', request_id: id(), view_id: pageId, parent_view_id: spaceId, name: `${label} page`, position: { kind: 'start' },
  }, token);
  return { pageId, status: response.status };
}

async function createGridDatabase(token, workspaceId, spaceId, databaseId = id(), apiFn = api) {
  const request = {
    schema_version: 'v1', request_id: id(), parent_view_id: spaceId, name: '', position: { kind: 'start' }, container_id: id(),
    database: { database_id: databaseId, view_id: id(), name: 'Grid', layout: 0, embedded: false, responses_view_id: null, initial_row_ids: [], timezone_id: null },
  };
  const response = await apiFn('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  return { databaseId, viewId: request.database.view_id, status: response.status };
}

const ORIGINAL_DATABASE_RESTORE_ID = '00000000-0000-0000-0000-000000000000';
async function createRow(token, workspaceId, databaseId, viewId, apiFn = api) {
  const request = {
    schema_version: 'v1', request_id: id(), row_id: id(), database_restore_id: ORIGINAL_DATABASE_RESTORE_ID,
    source_view_id: viewId, cells: {}, height: 36, visibility: true, presentation: { icon_url: null, cover: null }, position: { kind: 'end' },
  };
  assert.equal((await apiFn('POST', `/api/workspace/${workspaceId}/v2/database/${databaseId}/row/default`, request, token)).status, 200);
  return request.row_id;
}

function connectSocket(workspaceId, token, clientId, wsBaseOverride) {
  const wsBase = (wsBaseOverride ?? base).replace(/^http/, 'ws');
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${wsBase}/ws/v2/${workspaceId}/?${query}`);
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

// A multi-object observer receives frames for several objects, interleaved.
// This accumulates every decoded frame and lets a test ask "did a frame of
// this kind, for this exact object+type, arrive after this point?" -- which
// is the question multi-object fan-out actually poses. `fromIndex` (via
// mark()) is what makes re-subscribing to an already-seen object testable
// (Scenario C) without matching the earlier manifest.
function frameCollector(socket) {
  const frames = [];
  const listeners = [];
  socket.on('message', (frame, isBinary) => {
    if (!isBinary) return;
    let decoded;
    try { decoded = decodeMessage(frame).collabMessage; } catch { return; }
    if (!decoded) return;
    frames.push(decoded);
    for (const listener of listeners.slice()) listener();
  });
  const kindOf = (frame, kind) => (kind === 'update' ? !!frame.update : kind === 'manifest' ? !!frame.syncRequest : !!frame.awarenessUpdate);
  const matches = (objectId, collabType, kind, fromIndex = 0) => frames
    .slice(fromIndex)
    .filter((frame) => frame.objectId === objectId && frame.collabType === collabType && kindOf(frame, kind));
  return {
    mark: () => frames.length,
    matches,
    all: () => frames,
    waitFor(objectId, collabType, kind, timeoutMs = 4000, fromIndex = 0) {
      const immediate = matches(objectId, collabType, kind, fromIndex);
      if (immediate.length) return Promise.resolve(immediate[0]);
      return new Promise((resolve) => {
        const cleanup = () => {
          clearTimeout(timer);
          const index = listeners.indexOf(check);
          if (index !== -1) listeners.splice(index, 1);
        };
        const check = () => {
          const found = matches(objectId, collabType, kind, fromIndex);
          if (found.length) { cleanup(); resolve(found[0]); }
        };
        const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
        listeners.push(check);
      });
    },
  };
}

async function fetchState(token, workspaceId, objectId, collabType) {
  const response = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${objectId}?collab_type=${collabType}`, undefined, token);
  assert.equal(response.status, 200, `must be able to read collab ${collabType}:${objectId}`);
  return new Uint8Array(response.body.data.doc_state);
}

// The state vector of an empty document -- what a client legitimately sends
// when it has no local state for an object yet. (A synthetic `[0]` byte is
// NOT a valid Yjs update: Y.applyUpdate throws "Unexpected end of array".)
function emptyStateVector() {
  const doc = new Y.Doc();
  const sv = Y.encodeStateVector(doc);
  doc.destroy();
  return sv;
}

function stateVectorOf(objectId, docState) {
  const doc = new Y.Doc({ guid: objectId });
  Y.applyUpdate(doc, docState);
  const sv = Y.encodeStateVector(doc);
  doc.destroy();
  return sv;
}

// Sends a SyncRequest and waits for the manifest. This is the ONLY place a
// subscription is created, mirroring the server: a subscription exists only
// after a SyncRequest has been fully admitted.
async function subscribe(socket, collector, objectId, collabType, docState) {
  const sv = stateVectorOf(objectId, docState);
  const mark = collector.mark();
  socket.send(encodeMessage({ collabMessage: { objectId, collabType, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv } } }));
  const manifest = await collector.waitFor(objectId, collabType, 'manifest', 5000, mark);
  assert.ok(manifest, `subscribe(collabType=${collabType}, ${objectId}) must receive a manifest frame`);
  return sv;
}

const mutateDatabaseField = (marker) => (doc) => {
  const field = [...doc.getMap('data').get('database').get('fields').values()][0];
  field.set('name', marker);
};
const mutateRowCell = (marker) => (doc) => {
  doc.getMap('data').get('data').set('task77_2_marker', marker);
};
const mutateDocumentText = (marker) => (doc) => {
  const text = [...doc.getMap('data').get('document').get('meta').get('text_map').values()].find((value) => value instanceof Y.Text);
  text.insert(text.length, marker);
};

// Subscribes the sender to the object (required by the pre-existing
// single-slot admission check, which this task deliberately leaves intact),
// then sends one update and waits for its own ack.
async function sendUpdate(socket, collector, token, workspaceId, objectId, collabType, mutate) {
  const docState = await fetchState(token, workspaceId, objectId, collabType);
  const sv = await subscribe(socket, collector, objectId, collabType, docState);
  const doc = new Y.Doc({ guid: objectId });
  Y.applyUpdate(doc, docState);
  mutate(doc);
  const payload = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();
  const mark = collector.mark();
  socket.send(encodeMessage({ collabMessage: { objectId, collabType, update: { flags: 0, payload, beforeStateVector: sv } } }));
  const ack = await collector.waitFor(objectId, collabType, 'update', 5000, mark);
  assert.ok(ack && ack.update, `sender must receive its own ack for collabType=${collabType} ${objectId}`);
  return { ack, mark };
}

function closeCodeOf(socket) {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

// ---------------------------------------------------------------------
// Scenario A -- single-object compatibility (the pre-existing behavior)
// ---------------------------------------------------------------------

test('Task 77.2 Scenario A (' + STORAGE_LABEL + '): a connection subscribed to exactly one Database still receives that Database\'s updates, and the sender receives no duplicate of its own update', { skip: SKIP_ALL }, async () => {
  const owner = await registerAndLogin('t772-a-owner');
  const peer = await registerAndLogin('t772-a-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 't772-a');
  const { databaseId, status } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  assert.equal(status, 200);

  const observerSocket = await connectSocket(owner.workspaceId, peer.token, 7201);
  const senderSocket = await connectSocket(owner.workspaceId, owner.token, 7202);
  try {
    const observer = frameCollector(observerSocket);
    const sender = frameCollector(senderSocket);
    await subscribe(observerSocket, observer, databaseId, 1, await fetchState(peer.token, owner.workspaceId, databaseId, 1));

    const observerMark = observer.mark();
    const marker = `t772-a-${id()}`;
    const { mark: senderMark } = await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, databaseId, 1, mutateDatabaseField(marker));

    const live = await observer.waitFor(databaseId, 1, 'update', 4000, observerMark);
    assert.ok(live, 'the single-object subscriber must receive the Database update live');

    const observerDoc = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(observerDoc, await fetchState(peer.token, owner.workspaceId, databaseId, 1));
    const names = [...observerDoc.getMap('data').get('database').get('fields').values()].map((value) => value.get('name'));
    observerDoc.destroy();
    assert.ok(names.includes(marker), 'the renamed field must be persisted');

    // Sender exclusion: exactly ONE update frame (its own ack) after the send.
    assert.equal(sender.matches(databaseId, 1, 'update', senderMark).length, 1,
      'the sender must receive exactly its own ack, never an additional fan-out copy of its own update');
  } finally {
    observerSocket.terminate();
    senderSocket.terminate();
  }
});

// ---------------------------------------------------------------------
// Scenario B -- THE CENTRAL REGRESSION TEST
// ---------------------------------------------------------------------

test('Task 77.2 Scenario B (' + STORAGE_LABEL + ', CENTRAL REGRESSION): one connection subscribed to a Database plus two DatabaseRows receives updates for ALL THREE objects, even though its latest active binding is the last row', { skip: SKIP_ALL }, async () => {
  const owner = await registerAndLogin('t772-b-owner');
  const peer = await registerAndLogin('t772-b-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 't772-b');
  const { databaseId, viewId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  const rowB = await createRow(owner.token, owner.workspaceId, databaseId, viewId);
  const rowC = await createRow(owner.token, owner.workspaceId, databaseId, viewId);

  const observerSocket = await connectSocket(owner.workspaceId, peer.token, 7211);
  const senderSocket = await connectSocket(owner.workspaceId, owner.token, 7212);
  try {
    const observer = frameCollector(observerSocket);
    const sender = frameCollector(senderSocket);

    // Subscribe in the order a real browser does: the Database first, then a
    // DatabaseRow per row. The active binding slot therefore ends on rowC.
    await subscribe(observerSocket, observer, databaseId, 1, await fetchState(peer.token, owner.workspaceId, databaseId, 1));
    await subscribe(observerSocket, observer, rowB, 4, await fetchState(peer.token, owner.workspaceId, rowB, 4));
    await subscribe(observerSocket, observer, rowC, 4, await fetchState(peer.token, owner.workspaceId, rowC, 4));

    // From here the observer NEVER sends another frame. Delivery can only
    // work if the server remembers all three subscriptions.
    const observerMark = observer.mark();

    const databaseMarker = `t772-b-db-${id()}`;
    const rowBMarker = `t772-b-rowB-${id()}`;
    const rowCMarker = `t772-b-rowC-${id()}`;

    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, databaseId, 1, mutateDatabaseField(databaseMarker));
    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, rowB, 4, mutateRowCell(rowBMarker));
    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, rowC, 4, mutateRowCell(rowCMarker));

    const databaseLive = await observer.waitFor(databaseId, 1, 'update', 5000, observerMark);
    const rowBLive = await observer.waitFor(rowB, 4, 'update', 5000, observerMark);
    const rowCLive = await observer.waitFor(rowC, 4, 'update', 5000, observerMark);

    // The row that happens to hold the active binding slot was ALWAYS
    // delivered, even before this fix -- it is the Database and the earlier
    // row that regressed. Assert all three explicitly so a future regression
    // names the object that broke.
    assert.ok(databaseLive, 'Database (collabType=1) update must reach a connection whose active binding has moved to a DatabaseRow -- this is the Task 77.1 defect');
    assert.ok(rowBLive, 'the FIRST DatabaseRow\'s update must reach the connection even though a later row overwrote the active binding');
    assert.ok(rowCLive, 'the last-bound DatabaseRow\'s update must still reach the connection');

    // Content convergence, not just frame arrival.
    const databaseDoc = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(databaseDoc, await fetchState(peer.token, owner.workspaceId, databaseId, 1));
    const names = [...databaseDoc.getMap('data').get('database').get('fields').values()].map((value) => value.get('name'));
    databaseDoc.destroy();
    assert.ok(names.includes(databaseMarker), 'the Database field rename must be persisted');

    for (const [rowId, marker] of [[rowB, rowBMarker], [rowC, rowCMarker]]) {
      const rowDoc = new Y.Doc({ guid: rowId });
      Y.applyUpdate(rowDoc, await fetchState(peer.token, owner.workspaceId, rowId, 4));
      assert.equal(rowDoc.getMap('data').get('data').get('task77_2_marker'), marker, `row ${rowId} cell must be persisted`);
      rowDoc.destroy();
    }

    // No cross-object leakage: the Database frame must not carry a row id.
    assert.equal(databaseLive.objectId, databaseId);
    assert.equal(databaseLive.collabType, 1);
    assert.equal(rowBLive.collabType, 4);
    assert.equal(rowCLive.collabType, 4);
  } finally {
    observerSocket.terminate();
    senderSocket.terminate();
  }
});

// ---------------------------------------------------------------------
// Scenario C -- object switching / re-binding, no duplicate delivery
// ---------------------------------------------------------------------

test('Task 77.2 Scenario C (' + STORAGE_LABEL + '): subscribing Database A, then DatabaseRow B, then Database A again keeps both subscriptions valid and delivers each update exactly once', { skip: SKIP_ALL }, async () => {
  const owner = await registerAndLogin('t772-c-owner');
  const peer = await registerAndLogin('t772-c-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 't772-c');
  const { databaseId, viewId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  const rowB = await createRow(owner.token, owner.workspaceId, databaseId, viewId);

  const observerSocket = await connectSocket(owner.workspaceId, peer.token, 7221);
  const senderSocket = await connectSocket(owner.workspaceId, owner.token, 7222);
  try {
    const observer = frameCollector(observerSocket);
    const sender = frameCollector(senderSocket);

    await subscribe(observerSocket, observer, databaseId, 1, await fetchState(peer.token, owner.workspaceId, databaseId, 1));
    await subscribe(observerSocket, observer, rowB, 4, await fetchState(peer.token, owner.workspaceId, rowB, 4));
    // Re-bind to Database A, which must NOT create a second subscription.
    await subscribe(observerSocket, observer, databaseId, 1, await fetchState(peer.token, owner.workspaceId, databaseId, 1));

    const observerMark = observer.mark();
    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, databaseId, 1, mutateDatabaseField(`t772-c-db-${id()}`));
    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, rowB, 4, mutateRowCell(`t772-c-row-${id()}`));

    assert.ok(await observer.waitFor(databaseId, 1, 'update', 5000, observerMark), 'Database A must still be subscribed after the row switch and the re-bind');
    assert.ok(await observer.waitFor(rowB, 4, 'update', 5000, observerMark), 'DatabaseRow B must still be subscribed after re-binding to Database A');

    // Settle, then assert exactly-once delivery (a Set, not a list).
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(observer.matches(databaseId, 1, 'update', observerMark).length, 1,
      'binding the same object twice must not cause duplicate fan-out delivery');
    assert.equal(observer.matches(rowB, 4, 'update', observerMark).length, 1,
      'DatabaseRow B must receive its update exactly once');
  } finally {
    observerSocket.terminate();
    senderSocket.terminate();
  }
});

// ---------------------------------------------------------------------
// Scenario D -- workspace isolation (with a DELIBERATELY SHARED object id)
// ---------------------------------------------------------------------

test('Task 77.2 Scenario D (' + STORAGE_LABEL + '): an update never crosses a workspace boundary, even when the SAME database id exists in both workspaces', { skip: SKIP_ALL }, async () => {
  const ownerOne = await registerAndLogin('t772-d-ws1');
  const ownerTwo = await registerAndLogin('t772-d-ws2');
  const spaceOne = await createPublicSpace(ownerOne.token, ownerOne.workspaceId, 't772-d-1');
  const spaceTwo = await createPublicSpace(ownerTwo.token, ownerTwo.workspaceId, 't772-d-2');

  // Database ids are client-supplied, so the strongest possible workspace
  // isolation test is to reuse ONE id in two different workspaces. If the
  // store refuses that, fall back to distinct ids and still assert isolation.
  const sharedId = id();
  const first = await createGridDatabase(ownerOne.token, ownerOne.workspaceId, spaceOne, sharedId);
  assert.equal(first.status, 200);
  const secondAttempt = await createGridDatabase(ownerTwo.token, ownerTwo.workspaceId, spaceTwo, sharedId);
  const sharedIdAccepted = secondAttempt.status === 200;
  const second = sharedIdAccepted
    ? secondAttempt
    : await createGridDatabase(ownerTwo.token, ownerTwo.workspaceId, spaceTwo, id());
  if (!sharedIdAccepted) {
    assert.equal(second.status, 200, 'workspace 2 must get a database one way or the other');
  }
  console.log(`[task77.2 Scenario D] same database id reused across workspaces: ${sharedIdAccepted ? 'ACCEPTED by the store (strongest form of this test)' : `REJECTED (status ${secondAttempt.status}); fell back to distinct ids`}`);

  const observerSocket = await connectSocket(ownerTwo.workspaceId, ownerTwo.token, 7231);
  const senderSocket = await connectSocket(ownerOne.workspaceId, ownerOne.token, 7232);
  try {
    const observer = frameCollector(observerSocket);
    const sender = frameCollector(senderSocket);
    await subscribe(observerSocket, observer, second.databaseId, 1, await fetchState(ownerTwo.token, ownerTwo.workspaceId, second.databaseId, 1));

    const observerMark = observer.mark();
    await sendUpdate(senderSocket, sender, ownerOne.token, ownerOne.workspaceId, first.databaseId, 1, mutateDatabaseField(`t772-d-${id()}`));

    const leaked = await observer.waitFor(first.databaseId, 1, 'update', 2500, observerMark);
    assert.equal(leaked, null, 'a workspace-1 Database update must never reach a workspace-2 subscriber');
    assert.equal(observer.matches(second.databaseId, 1, 'update', observerMark).length, 0,
      'the workspace-2 subscriber must receive nothing at all for its own object either');
  } finally {
    observerSocket.terminate();
    senderSocket.terminate();
  }
});

// ---------------------------------------------------------------------
// Scenario E -- collaboration-type isolation (composite identity)
// ---------------------------------------------------------------------

test('Task 77.2 Scenario E (' + STORAGE_LABEL + '): Document, Database and DatabaseRow subscriptions stay distinct, including when a Document and a Database share one object id', { skip: SKIP_ALL }, async () => {
  const owner = await registerAndLogin('t772-e-owner');
  const peer = await registerAndLogin('t772-e-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 't772-e');

  // Both view_id (Document) and database_id (Database) are client-supplied,
  // so attempt the collision case directly: one id, two collab types.
  const sharedId = id();
  const document = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 't772-e', sharedId);
  assert.equal(document.status, 200);
  const collidingDatabase = await createGridDatabase(owner.token, owner.workspaceId, spaceId, sharedId);
  const collisionAccepted = collidingDatabase.status === 200;
  console.log(`[task77.2 Scenario E] same id reused across collab types (Document 0 vs Database 1): ${collisionAccepted ? 'ACCEPTED by the store (strongest form of this test)' : `REJECTED (status ${collidingDatabase.status}); asserting type isolation with distinct ids instead`}`);

  const database = collisionAccepted ? collidingDatabase : await createGridDatabase(owner.token, owner.workspaceId, spaceId, id());
  assert.equal(database.status, 200);
  const rowId = await createRow(owner.token, owner.workspaceId, database.databaseId, database.viewId);

  const observerSocket = await connectSocket(owner.workspaceId, peer.token, 7241);
  const senderSocket = await connectSocket(owner.workspaceId, owner.token, 7242);
  try {
    const observer = frameCollector(observerSocket);
    const sender = frameCollector(senderSocket);

    // Subscribe ONLY to the Document (collabType=0).
    await subscribe(observerSocket, observer, document.pageId, 0, await fetchState(peer.token, owner.workspaceId, document.pageId, 0));
    const observerMark = observer.mark();

    // Update the Database (collabType=1) and the DatabaseRow (collabType=4).
    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, database.databaseId, 1, mutateDatabaseField(`t772-e-db-${id()}`));
    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, rowId, 4, mutateRowCell(`t772-e-row-${id()}`));

    assert.equal(await observer.waitFor(database.databaseId, 1, 'update', 2500, observerMark), null,
      'a Database (collabType=1) update must never reach a Document (collabType=0) subscriber, even on an identical object id');
    assert.equal(await observer.waitFor(rowId, 4, 'update', 2000, observerMark), null,
      'a DatabaseRow (collabType=4) update must never reach a Document (collabType=0) subscriber');
    assert.equal(observer.matches(document.pageId, 0, 'update', observerMark).length, 0,
      'no frame of any kind should have been delivered to the Document subscriber');

    // Positive control: the Document subscription itself still works, so the
    // negative assertions above are not vacuously true.
    const documentMark = observer.mark();
    const documentMarker = `t772-e-doc-${id()}`;
    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, document.pageId, 0, mutateDocumentText(documentMarker));
    assert.ok(await observer.waitFor(document.pageId, 0, 'update', 5000, documentMark),
      'positive control: the Document subscriber MUST receive Document updates (otherwise the isolation assertions prove nothing)');
  } finally {
    observerSocket.terminate();
    senderSocket.terminate();
  }
});

// ---------------------------------------------------------------------
// Scenario F -- a rejected SyncRequest must leave no usable subscription
// ---------------------------------------------------------------------

test('Task 77.2 Scenario F (' + STORAGE_LABEL + '): a rejected SyncRequest registers no subscription, and a rejection does not leave an earlier valid subscription receiving fan-out', { skip: SKIP_ALL }, async () => {
  const owner = await registerAndLogin('t772-f-owner');
  const peer = await registerAndLogin('t772-f-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 't772-f');
  const { databaseId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  const databaseState = await fetchState(owner.token, owner.workspaceId, databaseId, 1);
  // Task 79 relaxed the DatabaseRow WS branch to tolerate a row id that has
  // never existed anywhere yet (a client legitimately subscribing just
  // ahead of its own same-workspace row-document creation -- see that
  // task's report). F2 below needs a row that is still genuinely rejected
  // under that narrower rule: one that exists, but in a different
  // workspace, not a bare `id()` that exists nowhere at all.
  const outsider = await registerAndLogin('t772-f-outsider');
  const outsiderSpace = await createPublicSpace(outsider.token, outsider.workspaceId, 't772-f-outsider');
  const outsiderDb = await createGridDatabase(outsider.token, outsider.workspaceId, outsiderSpace);
  const outsiderRowId = await createRow(outsider.token, outsider.workspaceId, outsiderDb.databaseId, outsiderDb.viewId);

  const senderSocket = await connectSocket(owner.workspaceId, owner.token, 7252);
  const sender = frameCollector(senderSocket);
  try {
    // --- F1: SyncRequest for an object that does not exist is rejected and
    // creates no subscription. ---
    const rejectedSocket = await connectSocket(owner.workspaceId, peer.token, 7251);
    try {
      const rejected = frameCollector(rejectedSocket);
      const unknownDatabaseId = id();
      const closed = closeCodeOf(rejectedSocket);
      rejectedSocket.send(encodeMessage({ collabMessage: { objectId: unknownDatabaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: emptyStateVector() } } }));
      assert.equal(await closed, 1008, 'a SyncRequest for an unauthorized/unknown Database must be rejected with 1008 (pre-existing behavior, unchanged)');
      assert.equal(rejected.matches(unknownDatabaseId, 1, 'manifest').length, 0, 'a rejected SyncRequest must not produce a manifest');
    } finally {
      rejectedSocket.terminate();
    }

    // --- F2: a socket with a VALID subscription that then gets rejected on a
    // different object must not keep receiving fan-out for the valid one. ---
    const mixedSocket = await connectSocket(owner.workspaceId, peer.token, 7253);
    try {
      const mixed = frameCollector(mixedSocket);
      await subscribe(mixedSocket, mixed, databaseId, 1, databaseState);

      const closed = closeCodeOf(mixedSocket);
      mixedSocket.send(encodeMessage({ collabMessage: { objectId: outsiderRowId, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: emptyStateVector() } } }));
      assert.equal(await closed, 1008, 'a SyncRequest for a DatabaseRow that belongs to another workspace must be rejected with 1008');

      const afterRejectionMark = mixed.mark();
      await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, databaseId, 1, mutateDatabaseField(`t772-f-${id()}`));
      assert.equal(await mixed.waitFor(databaseId, 1, 'update', 2500, afterRejectionMark), null,
        'once the connection has been closed by a rejected SyncRequest it must receive no further fan-out for its previously valid subscription');
    } finally {
      mixedSocket.terminate();
    }
  } finally {
    senderSocket.terminate();
  }
});

// ---------------------------------------------------------------------
// Scenario G -- connection cleanup
// ---------------------------------------------------------------------

test('Task 77.2 Scenario G (' + STORAGE_LABEL + '): a closed connection that had several subscriptions receives nothing and leaves no stale subscription behind', { skip: SKIP_ALL }, async () => {
  const owner = await registerAndLogin('t772-g-owner');
  const peer = await registerAndLogin('t772-g-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 't772-g');
  const { databaseId, viewId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  const rowId = await createRow(owner.token, owner.workspaceId, databaseId, viewId);

  const senderSocket = await connectSocket(owner.workspaceId, owner.token, 7262);
  try {
    const sender = frameCollector(senderSocket);
    const closingSocket = await connectSocket(owner.workspaceId, peer.token, 7261);
    const closing = frameCollector(closingSocket);
    await subscribe(closingSocket, closing, databaseId, 1, await fetchState(peer.token, owner.workspaceId, databaseId, 1));
    await subscribe(closingSocket, closing, rowId, 4, await fetchState(peer.token, owner.workspaceId, rowId, 4));

    // Locate the real server-side socket object so cleanup can be asserted
    // on the server's own state, not just inferred from the client side.
    const serverSidePeer = [...running.app.websocketServer.clients].find((client) => client.userId && client.subscriptions && client.subscriptions.size === 2);
    assert.ok(serverSidePeer, 'must locate the server-side socket holding exactly the two subscriptions just created');
    assert.equal(serverSidePeer.subscriptions.size, 2, 'the server must track BOTH subscriptions on one connection');

    const closed = new Promise((resolve) => closingSocket.once('close', resolve));
    closingSocket.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(serverSidePeer.subscriptions.size, 0, 'closing the connection must clear its subscription registry');
    assert.ok(!running.app.websocketServer.clients.has(serverSidePeer), 'the closed socket must be gone from the server client set');

    const afterCloseMark = closing.mark();
    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, databaseId, 1, mutateDatabaseField(`t772-g-db-${id()}`));
    await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, rowId, 4, mutateRowCell(`t772-g-row-${id()}`));
    assert.equal(closing.matches(databaseId, 1, 'update', afterCloseMark).length, 0, 'a closed connection must receive no Database fan-out');
    assert.equal(closing.matches(rowId, 4, 'update', afterCloseMark).length, 0, 'a closed connection must receive no DatabaseRow fan-out');
  } finally {
    senderSocket.terminate();
  }
});

// ---------------------------------------------------------------------
// Scenario H -- authorization revocation removes fan-out eligibility
// ---------------------------------------------------------------------

test('Task 77.2 Scenario H (' + STORAGE_LABEL + '): revoking an idle multi-object subscriber\'s membership closes it and stops all fan-out, while another authorized peer keeps receiving', { skip: SKIP_ALL }, async () => {
  const revocationDir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-multi-object-revoke-'));
  const revocationDevKey = 'task77-2-revoke-key';
  const revocationRunning = await startServer(storageOptions({
    file: path.join(revocationDir, 'state.json'),
    devKey: revocationDevKey, wsRevalidationIntervalMs: 150,
  }));
  const revocationBase = `http://127.0.0.1:${revocationRunning.address.port}`;
  const previousBase = base;
  base = revocationBase; // the shared helpers target `base`
  try {
    const owner = await registerAndLogin('t772-h-owner');
    const victim = await registerAndLogin('t772-h-victim');
    const survivor = await registerAndLogin('t772-h-survivor');
    await addMember(owner.token, owner.workspaceId, victim.email, api, revocationDevKey);
    await addMember(owner.token, owner.workspaceId, survivor.email, api, revocationDevKey);
    const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 't772-h');
    const { databaseId, viewId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
    const rowId = await createRow(owner.token, owner.workspaceId, databaseId, viewId);

    const victimSocket = await connectSocket(owner.workspaceId, victim.token, 7271, revocationBase);
    const survivorSocket = await connectSocket(owner.workspaceId, survivor.token, 7272, revocationBase);
    const senderSocket = await connectSocket(owner.workspaceId, owner.token, 7273, revocationBase);
    try {
      const victimFrames = frameCollector(victimSocket);
      const survivorFrames = frameCollector(survivorSocket);
      const sender = frameCollector(senderSocket);

      const databaseState = await fetchState(owner.token, owner.workspaceId, databaseId, 1);
      const rowState = await fetchState(owner.token, owner.workspaceId, rowId, 4);
      for (const [socket, frames] of [[victimSocket, victimFrames], [survivorSocket, survivorFrames]]) {
        await subscribe(socket, frames, databaseId, 1, databaseState);
        await subscribe(socket, frames, rowId, 4, rowState);
      }

      // Revoke the victim and let the bounded periodic revalidation notice.
      // The victim stays IDLE, so only the timer can detect this.
      const victimClosed = closeCodeOf(victimSocket);
      await revokeMember(owner.token, owner.workspaceId, victim.email, api, revocationDevKey);
      assert.equal(await victimClosed, 1008, 'an idle revoked multi-object subscriber must be closed with 1008 by periodic revalidation');

      const victimMark = victimFrames.mark();
      const survivorMark = survivorFrames.mark();
      await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, databaseId, 1, mutateDatabaseField(`t772-h-db-${id()}`));
      await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, rowId, 4, mutateRowCell(`t772-h-row-${id()}`));

      assert.equal(victimFrames.matches(databaseId, 1, 'update', victimMark).length, 0, 'a revoked peer must receive no Database updates');
      assert.equal(victimFrames.matches(rowId, 4, 'update', victimMark).length, 0, 'a revoked peer must receive no DatabaseRow updates');

      assert.ok(await survivorFrames.waitFor(databaseId, 1, 'update', 5000, survivorMark), 'the still-authorized peer must keep receiving Database updates');
      assert.ok(await survivorFrames.waitFor(rowId, 4, 'update', 5000, survivorMark), 'the still-authorized peer must keep receiving DatabaseRow updates');
    } finally {
      victimSocket.terminate();
      survivorSocket.terminate();
      senderSocket.terminate();
    }
  } finally {
    base = previousBase;
    await new Promise((resolve) => revocationRunning.server.close(resolve));
    await rm(revocationDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Scenario I -- one peer's send failure must not break the others
// ---------------------------------------------------------------------

test('Task 77.2 Scenario I (' + STORAGE_LABEL + '): when one multi-object peer\'s send() throws, the other subscribed peers still receive the update and the sender is still acked', { skip: SKIP_ALL }, async () => {
  const owner = await registerAndLogin('t772-i-owner');
  const flaky = await registerAndLogin('t772-i-flaky');
  const healthy = await registerAndLogin('t772-i-healthy');
  await addMember(owner.token, owner.workspaceId, flaky.email);
  await addMember(owner.token, owner.workspaceId, healthy.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 't772-i');
  const { databaseId, viewId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  const rowId = await createRow(owner.token, owner.workspaceId, databaseId, viewId);

  // Connect the flaky socket alone first and diff the server's client set, so
  // its real server-side object is identified unambiguously before any other
  // socket joins.
  const beforeClients = new Set(running.app.websocketServer.clients);
  const flakySocket = await connectSocket(owner.workspaceId, flaky.token, 7281);
  const addedClients = [...running.app.websocketServer.clients].filter((client) => !beforeClients.has(client));
  assert.equal(addedClients.length, 1, 'exactly one new server-side client must appear for the flaky connection');
  const healthySocket = await connectSocket(owner.workspaceId, healthy.token, 7282);
  const senderSocket = await connectSocket(owner.workspaceId, owner.token, 7283);
  let serverSideFlakyPeer;
  let originalSend;
  try {
    const flakyFrames = frameCollector(flakySocket);
    const healthyFrames = frameCollector(healthySocket);
    const sender = frameCollector(senderSocket);

    const databaseState = await fetchState(owner.token, owner.workspaceId, databaseId, 1);
    const rowState = await fetchState(owner.token, owner.workspaceId, rowId, 4);
    // Both peers subscribe to BOTH objects, so the active binding is the row
    // for both and only the subscription registry can route the Database.
    await subscribe(flakySocket, flakyFrames, databaseId, 1, databaseState);
    await subscribe(flakySocket, flakyFrames, rowId, 4, rowState);
    await subscribe(healthySocket, healthyFrames, databaseId, 1, databaseState);
    await subscribe(healthySocket, healthyFrames, rowId, 4, rowState);

    // The fan-out loop calls .send() on the SERVER's socket object, not the
    // client's, so fault injection must target the object found above.
    [serverSideFlakyPeer] = addedClients;
    assert.equal(serverSideFlakyPeer.subscriptions.size, 2, 'the flaky peer must be tracked with both of its subscriptions');
    originalSend = serverSideFlakyPeer.send.bind(serverSideFlakyPeer);
    serverSideFlakyPeer.send = () => { throw new Error('task77.2 simulated flaky peer send failure'); };

    const healthyMark = healthyFrames.mark();
    const marker = `t772-i-${id()}`;
    const { ack } = await sendUpdate(senderSocket, sender, owner.token, owner.workspaceId, databaseId, 1, mutateDatabaseField(marker));
    assert.ok(ack && ack.update, 'the sender must still be acked even though one peer\'s send() threw');

    const healthyLive = await healthyFrames.waitFor(databaseId, 1, 'update', 5000, healthyMark);
    assert.ok(healthyLive, 'a healthy multi-object peer must still receive the Database update when another peer\'s send() throws');

    const persisted = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(persisted, await fetchState(owner.token, owner.workspaceId, databaseId, 1));
    const names = [...persisted.getMap('data').get('database').get('fields').values()].map((value) => value.get('name'));
    persisted.destroy();
    assert.ok(names.includes(marker), 'the accepted update must remain persisted despite a peer send failure');
  } finally {
    if (serverSideFlakyPeer && originalSend) serverSideFlakyPeer.send = originalSend;
    flakySocket.terminate();
    healthySocket.terminate();
    senderSocket.terminate();
  }
});

// ---------------------------------------------------------------------
// Task 77.3 §9 -- multi-object AWARENESS fan-out regression
// ---------------------------------------------------------------------
// Task 77.2 re-routed the peer-selection half of all 7 fan-out loops (3
// content + 4 awareness) off the same subscription registry, but only the 3
// content loops got direct regression coverage (Scenarios A-I above). This
// closes that gap: one connection subscribes to a Database plus two
// DatabaseRows (active binding ends on the last row, exactly like Scenario
// B), and a peer sends an awareness update for each of the two content
// types -- proving the AWARENESS relay also survives the active binding
// having moved elsewhere, not just content updates.

function awarenessPayloadFor(marker) {
  return new TextEncoder().encode(marker);
}

async function sendAwareness(socket, collector, token, workspaceId, objectId, collabType, marker) {
  // The sender-side admission gate is `websocket.objectId === objectId`
  // (deliberately left unchanged by Task 77.2), so the sender's OWN active
  // binding must be this object when the frame is sent -- a fresh
  // subscribe() immediately before sending guarantees that, mirroring how
  // sendUpdate() re-establishes the binding for content updates.
  const docState = await fetchState(token, workspaceId, objectId, collabType);
  await subscribe(socket, collector, objectId, collabType, docState);
  socket.send(encodeMessage({ collabMessage: { objectId, collabType, awarenessUpdate: { payload: awarenessPayloadFor(marker) } } }));
}

test('Task 77.3 §9 (' + STORAGE_LABEL + '): a connection subscribed to a Database plus two DatabaseRows still receives AWARENESS updates for the Database and a DatabaseRow after its active binding has moved to the last row', { skip: SKIP_ALL }, async () => {
  const owner = await registerAndLogin('t773-aw-owner');
  const peer = await registerAndLogin('t773-aw-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 't773-aw');
  const { databaseId, viewId } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  const rowAId = await createRow(owner.token, owner.workspaceId, databaseId, viewId);
  const rowBId = await createRow(owner.token, owner.workspaceId, databaseId, viewId);

  const observerSocket = await connectSocket(owner.workspaceId, peer.token, 7301);
  const senderSocket = await connectSocket(owner.workspaceId, owner.token, 7302);
  try {
    const observer = frameCollector(observerSocket);
    const sender = frameCollector(senderSocket);

    const databaseState = await fetchState(peer.token, owner.workspaceId, databaseId, 1);
    const rowAState = await fetchState(peer.token, owner.workspaceId, rowAId, 4);
    const rowBState = await fetchState(peer.token, owner.workspaceId, rowBId, 4);
    // Observer subscribes to all three; active binding ends on row B.
    await subscribe(observerSocket, observer, databaseId, 1, databaseState);
    await subscribe(observerSocket, observer, rowAId, 4, rowAState);
    await subscribe(observerSocket, observer, rowBId, 4, rowBState);

    // Database awareness, sent after the sender's OWN active binding is the
    // Database (sendAwareness's internal subscribe() guarantees this).
    const observerMarkDb = observer.mark();
    const dbMarker = `t773-aw-db-${id()}`;
    await sendAwareness(senderSocket, sender, owner.token, owner.workspaceId, databaseId, 1, dbMarker);
    const dbAwareness = await observer.waitFor(databaseId, 1, 'awareness', 5000, observerMarkDb);
    assert.ok(dbAwareness, 'the multi-object observer must receive a Database awareness update even though its active binding has moved to a DatabaseRow');
    assert.equal(new TextDecoder().decode(dbAwareness.awarenessUpdate.payload), dbMarker);

    // Now move the SENDER's own active binding to row A and send row-A
    // awareness -- proves the relay isn't accidentally still keyed off
    // whatever the Database send last left behind.
    const observerMarkRow = observer.mark();
    const rowMarker = `t773-aw-row-${id()}`;
    await sendAwareness(senderSocket, sender, owner.token, owner.workspaceId, rowAId, 4, rowMarker);
    const rowAwareness = await observer.waitFor(rowAId, 4, 'awareness', 5000, observerMarkRow);
    assert.ok(rowAwareness, 'the multi-object observer must receive a DatabaseRow awareness update for a row that is not its own active binding');
    assert.equal(new TextDecoder().decode(rowAwareness.awarenessUpdate.payload), rowMarker);

    // Isolation: row B awareness must NOT have arrived as a side effect of
    // either of the sends above (object-id isolation within the same type).
    assert.equal(observer.matches(rowBId, 4, 'awareness').length, 0,
      'awareness for an unrelated DatabaseRow must never be delivered as a side effect of another object\'s awareness send');

    // Sender-side admission unchanged: sending awareness for an object the
    // sender has NOT bound as its active object must still be rejected
    // (connection closed), exactly as before Task 77.2.
    const strayAwarenessSocket = await connectSocket(owner.workspaceId, owner.token, 7303);
    try {
      const closeCode = closeCodeOf(strayAwarenessSocket);
      strayAwarenessSocket.send(encodeMessage({ collabMessage: { objectId: rowBId, collabType: 4, awarenessUpdate: { payload: awarenessPayloadFor('stray') } } }));
      // Mismatched-binding awareness falls through to the DatabaseRow
      // branch's generic "Unsupported ... collaboration message" close --
      // 1003, not 1008 (1008 is update-admission's code). Verified against
      // the live source (server.js's awarenessUpdate branch for ct=4), not
      // assumed; this is the pre-existing, Task-77.2-unchanged behavior.
      assert.equal(await closeCode, 1003, 'an awareness update sent for an object the sender has not bound as its active object must still be rejected, unchanged from before Task 77.2');
    } finally {
      strayAwarenessSocket.terminate();
    }
  } finally {
    observerSocket.terminate();
    senderSocket.terminate();
  }
});
