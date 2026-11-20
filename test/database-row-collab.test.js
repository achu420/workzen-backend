// Task 62 (minimum viable DatabaseRow lifecycle, CollabType.DatabaseRow = 4)
// backend test coverage.
//
// Mirrors the conventions already established in test/database-collab.test.js
// (itself mirroring test/backend.test.js) for the Database collab path: same
// `api()` HTTP helper shape, same WebSocket connect/frame-reader helpers,
// same Task 44 fault-injection pattern reused verbatim, applied to the new
// DatabaseRow row-creation/persistence/WS-admission code added for Task 62.
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
import { openStore, persist as persistToDisk } from '../storage.js';

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-database-row-'));
  dataFile = path.join(dir, 'state.json');
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: dataFile, devKey: 'test-key' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const PUBLIC_SPACE_PERMISSION = {
  visibility: 'public',
  owner_access_level: 50,
  member_default_access_level: 30,
  everyone_else_access_level: null,
  invite_policy: 'owners_only',
  sidebar_edit_policy: 'owners_only',
  invite_link_enabled: false,
  security: { disable_guests: false, disable_public_links: false, disable_export: false },
};

async function registerAndLogin(label) {
  const email = `${label}-${id()}@example.test`;
  const password = 'Correct horse 907';
  assert.equal((await api('POST', '/api/auth/register', { email, password })).status, 201);
  const login = await api('POST', '/api/auth/login', { email, password });
  const token = login.body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  return { token, workspaceId };
}

async function createPublicSpace(token, workspaceId, label) {
  const spaceId = id();
  assert.equal((await api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: `${label} space`,
    view_id: spaceId,
    permission: PUBLIC_SPACE_PERMISSION,
  }, token)).status, 200);
  return spaceId;
}

function defaultDatabaseRequest({ parentViewId, name = 'Grid' }) {
  return {
    schema_version: 'v1',
    request_id: id(),
    parent_view_id: parentViewId,
    name: '',
    position: { kind: 'start' },
    container_id: id(),
    database: {
      database_id: id(),
      view_id: id(),
      name,
      layout: 0,
      embedded: false,
      responses_view_id: null,
      initial_row_ids: [id(), id(), id()],
      timezone_id: null,
    },
  };
}

async function createGridDatabase(token, workspaceId, spaceId, overrides = {}) {
  const request = { ...defaultDatabaseRequest({ parentViewId: spaceId }), ...overrides };
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  return { request, response };
}

const ORIGINAL_DATABASE_RESTORE_ID = '00000000-0000-0000-0000-000000000000';

function defaultRowRequest({ sourceViewId, position = { kind: 'end' }, cells = {} }) {
  return {
    schema_version: 'v1',
    request_id: id(),
    row_id: id(),
    database_restore_id: ORIGINAL_DATABASE_RESTORE_ID,
    source_view_id: sourceViewId,
    cells,
    height: 36,
    visibility: true,
    presentation: { icon_url: null, cover: null },
    position,
  };
}

async function setupDatabase(label) {
  const { token, workspaceId } = await registerAndLogin(label);
  const spaceId = await createPublicSpace(token, workspaceId, label);
  const { request, response } = await createGridDatabase(token, workspaceId, spaceId);
  assert.equal(response.status, 200);
  return { token, workspaceId, databaseId: request.database.database_id, viewId: request.database.view_id, request };
}

async function createRow(token, workspaceId, databaseId, overrides = {}) {
  const { sourceViewId, ...rest } = overrides;
  const request = { ...defaultRowRequest({ sourceViewId }), ...rest };
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/database/${databaseId}/row/default`, request, token);
  return { request, response };
}

function openDatabaseDoc(docState, databaseId) {
  const doc = new Y.Doc({ guid: databaseId });
  Y.applyUpdate(doc, docState);
  return doc;
}

function openRowDoc(docState, rowId) {
  const doc = new Y.Doc({ guid: rowId });
  Y.applyUpdate(doc, docState);
  return doc;
}

function connectAckTestSocket(wsBase, workspaceId, token, clientId) {
  const websocketBase = wsBase.replace(/^http/, 'ws');
  const query = new URLSearchParams({
    clientId: String(clientId),
    deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`,
    token,
    cv: '0.10.0',
    cp: 'web',
  });
  const socket = new WebSocket(`${websocketBase}/ws/v2/${workspaceId}/?${query}`);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function ackTestFrameReader(socket) {
  const pendingFrames = [];
  const frameWaiters = [];
  socket.on('message', (frame, isBinary) => {
    const resolve = frameWaiters.shift();
    if (resolve) resolve({ frame, isBinary });
    else pendingFrames.push({ frame, isBinary });
  });
  return (timeoutMs = 2000) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DatabaseRow WebSocket response timed out')), timeoutMs);
    const accept = ({ frame, isBinary }) => {
      clearTimeout(timeout);
      if (!isBinary) return reject(new Error('DatabaseRow WebSocket response was not binary'));
      resolve(decodeMessage(frame).collabMessage);
    };
    const pending = pendingFrames.shift();
    if (pending) accept(pending);
    else frameWaiters.push(accept);
  });
}

async function nextUpdateFrame(nextFrame) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const frame = await nextFrame(5000);
    if (frame.update) return frame;
  }
  throw new Error('No update-ack frame arrived within the expected number of frames');
}

test('DatabaseRow creation: valid request creates the row doc and inserts it into the parent Database row_orders', async () => {
  const { token, workspaceId, databaseId, viewId } = await setupDatabase('row-create');

  // Captured BEFORE the row exists, so the diff-merge assertion below
  // actually proves `database_update_v1` is a valid, causally-consistent
  // Yjs update against the client's pre-creation state -- exactly what
  // createCloudRow() does with it (create-row.ts: `Y.applyUpdate(candidate,
  // Y.encodeStateAsUpdate(databaseDoc)); Y.applyUpdate(candidate, update);`).
  const beforeCreate = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`, undefined, token);
  assert.equal(beforeCreate.status, 200);

  const { request, response } = await createRow(token, workspaceId, databaseId, { sourceViewId: viewId });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.outcome, 'applied');
  assert.equal(response.body.data.result.row_id, request.row_id);
  assert.equal(response.body.data.result.database_id, databaseId);
  assert.equal(response.body.data.result.database_restore_id, ORIGINAL_DATABASE_RESTORE_ID);
  assert.equal(typeof response.body.data.result.database_update_v1, 'string');
  assert.ok(response.body.data.result.update_batch_id);

  // The row doc itself: valid Yjs shape, correct identity, empty cells map.
  const rowRead = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${request.row_id}?collab_type=4`, undefined, token);
  assert.equal(rowRead.status, 200);
  assert.equal(rowRead.body.data.object_id, request.row_id);
  assert.equal(rowRead.body.data.collab_version, null, 'DatabaseRow reads carry no collab_version (AppFlowy-Web\'s own decode() requires it undefined)');
  const rowDoc = openRowDoc(new Uint8Array(rowRead.body.data.doc_state), request.row_id);
  try {
    const row = rowDoc.getMap('data').get('data');
    assert.ok(row instanceof Y.Map, 'the row itself must be a real Y.Map at root.get("data")');
    assert.equal(row.get('id'), request.row_id);
    assert.equal(row.get('database_id'), databaseId);
    assert.equal(row.get('height'), 36);
    assert.equal(row.get('visibility'), true);
    assert.ok(row.get('cells') instanceof Y.Map, 'cells must be a real Y.Map, even when empty');
    assert.equal([...row.get('cells').keys()].length, 0);
    assert.ok(rowDoc.getMap('data').get('meta') instanceof Y.Map, 'meta must be a real (possibly empty) Y.Map');
  } finally {
    rowDoc.destroy();
  }

  // The parent Database's row_orders must now include the new row.
  const databaseRead = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`, undefined, token);
  const databaseDoc = openDatabaseDoc(new Uint8Array(databaseRead.body.data.doc_state), databaseId);
  try {
    const view = databaseDoc.getMap('data').get('database').get('views').get(viewId);
    const orders = view.get('row_orders').toArray();
    assert.deepEqual(orders.map((entry) => entry.id), [request.row_id]);
    assert.equal(orders[0].height, 36);
  } finally {
    databaseDoc.destroy();
  }

  // The creating client's own locally-held Database doc (captured BEFORE
  // the row existed) can merge the returned diff directly (createCloudRow's
  // own activation path) and reach the identical row_orders membership,
  // without a second round trip.
  const localDoc = new Y.Doc({ guid: databaseId });
  try {
    Y.applyUpdate(localDoc, new Uint8Array(beforeCreate.body.data.doc_state));
    Y.applyUpdate(localDoc, Buffer.from(response.body.data.result.database_update_v1, 'base64'));
    const mergedView = localDoc.getMap('data').get('database').get('views').get(viewId);
    assert.ok(mergedView.get('row_orders').toArray().some((entry) => entry.id === request.row_id));
  } finally {
    localDoc.destroy();
  }
});

test('DatabaseRow creation: row ordering respects start/end/after position', async () => {
  const { token, workspaceId, databaseId, viewId } = await setupDatabase('row-order');
  const first = await createRow(token, workspaceId, databaseId, { sourceViewId: viewId, position: { kind: 'end' } });
  const second = await createRow(token, workspaceId, databaseId, { sourceViewId: viewId, position: { kind: 'end' } });
  const start = await createRow(token, workspaceId, databaseId, { sourceViewId: viewId, position: { kind: 'start' } });
  const afterFirst = await createRow(token, workspaceId, databaseId, {
    sourceViewId: viewId,
    position: { kind: 'after', row_id: first.request.row_id },
  });
  for (const r of [first, second, start, afterFirst]) assert.equal(r.response.status, 200);

  const databaseRead = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`, undefined, token);
  const databaseDoc = openDatabaseDoc(new Uint8Array(databaseRead.body.data.doc_state), databaseId);
  try {
    const view = databaseDoc.getMap('data').get('database').get('views').get(viewId);
    const orderedIds = view.get('row_orders').toArray().map((entry) => entry.id);
    assert.deepEqual(orderedIds, [start.request.row_id, first.request.row_id, afterFirst.request.row_id, second.request.row_id]);
  } finally {
    databaseDoc.destroy();
  }
});

test('DatabaseRow creation: duplicate request_id (retry) is idempotent', async () => {
  const { token, workspaceId, databaseId, viewId } = await setupDatabase('row-retry');
  const request = defaultRowRequest({ sourceViewId: viewId });
  const route = `/api/workspace/${workspaceId}/v2/database/${databaseId}/row/default`;

  const first = await api('POST', route, request, token);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.outcome, 'applied');

  const second = await api('POST', route, request, token);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.outcome, 'already_applied');
  assert.deepEqual(second.body.data.result, first.body.data.result);

  const different = await api('POST', route, { ...request, height: 50 }, token);
  assert.equal(different.status, 409);
  assert.equal(different.body.error.code, 'REQUEST_ID_REUSED');

  // The row must not have been duplicated or double-inserted into row_orders.
  const databaseRead = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`, undefined, token);
  const databaseDoc = openDatabaseDoc(new Uint8Array(databaseRead.body.data.doc_state), databaseId);
  try {
    const view = databaseDoc.getMap('data').get('database').get('views').get(viewId);
    const orders = view.get('row_orders').toArray().filter((entry) => entry.id === request.row_id);
    assert.equal(orders.length, 1, 'a replayed creation request must not insert the row twice');
  } finally {
    databaseDoc.destroy();
  }
});

test('DatabaseRow creation: invalid/malformed requests and unauthorized/unknown identities are rejected', async () => {
  const { token, workspaceId, databaseId, viewId } = await setupDatabase('row-invalid');
  const route = `/api/workspace/${workspaceId}/v2/database/${databaseId}/row/default`;

  assert.equal((await api('POST', route, defaultRowRequest({ sourceViewId: viewId }))).status, 401, 'no auth token');
  assert.equal((await api('POST', route, defaultRowRequest({ sourceViewId: viewId }), 'not-a-real-token')).status, 401);

  const badRowId = defaultRowRequest({ sourceViewId: viewId });
  badRowId.row_id = 'not-a-uuid';
  assert.equal((await api('POST', route, badRowId, token)).status, 400, 'malformed row_id');

  const badViewId = defaultRowRequest({ sourceViewId: 'not-a-uuid' });
  assert.equal((await api('POST', route, badViewId, token)).status, 400, 'malformed source_view_id');

  const unknownView = defaultRowRequest({ sourceViewId: id() });
  assert.equal((await api('POST', route, unknownView, token)).status, 400, 'source_view_id must belong to this Database');

  const badRestoreId = defaultRowRequest({ sourceViewId: viewId });
  badRestoreId.database_restore_id = id();
  assert.equal((await api('POST', route, badRestoreId, token)).status, 400, 'restore is out of scope; only the original sentinel is accepted');

  const badHeight = defaultRowRequest({ sourceViewId: viewId });
  badHeight.height = 0;
  assert.equal((await api('POST', route, badHeight, token)).status, 400, 'height must be a positive integer');

  const badVisibility = defaultRowRequest({ sourceViewId: viewId });
  badVisibility.visibility = 'yes';
  assert.equal((await api('POST', route, badVisibility, token)).status, 400, 'visibility must be boolean');

  const badPosition = defaultRowRequest({ sourceViewId: viewId });
  badPosition.position = { kind: 'somewhere' };
  assert.equal((await api('POST', route, badPosition, token)).status, 400, 'position.kind must be a supported value');

  const unknownField = defaultRowRequest({ sourceViewId: viewId, cells: { 'not-a-real-field': { data: 'x' } } });
  assert.equal((await api('POST', route, unknownField, token)).status, 400, 'cells referencing an unknown field are rejected');

  const databaseRead = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`, undefined, token);
  const doc = openDatabaseDoc(new Uint8Array(databaseRead.body.data.doc_state), databaseId);
  const [primaryFieldId] = [...doc.getMap('data').get('database').get('fields').keys()];
  doc.destroy();
  const nestedSafeCell = defaultRowRequest({
    sourceViewId: viewId,
    cells: { [primaryFieldId]: { data: 'x', nested: { tooDeep: [1, 2, { ok: true }] } } },
  });
  assert.equal((await api('POST', route, nestedSafeCell, token)).status, 200, 'a reasonably-nested JSON-safe cell value is accepted');

  const extraField = defaultRowRequest({ sourceViewId: viewId });
  extraField.unexpected_field = true;
  assert.equal((await api('POST', route, extraField, token)).status, 400, 'unsupported top-level fields are rejected');

  const unknownDatabaseRoute = `/api/workspace/${workspaceId}/v2/database/${id()}/row/default`;
  assert.equal((await api('POST', unknownDatabaseRoute, defaultRowRequest({ sourceViewId: viewId }), token)).status, 404, 'an unknown parent Database id is rejected');

  const otherLogin = await registerAndLogin('row-invalid-outsider');
  assert.equal((await api('POST', route, defaultRowRequest({ sourceViewId: viewId }), otherLogin.token)).status, 403, 'a user outside the workspace must be rejected');
});

test('DatabaseRow WebSocket: unsupported collabType values are rejected, not silently admitted', async () => {
  const { token, workspaceId, databaseId, viewId } = await setupDatabase('row-ws-invalid');
  const { request, response } = await createRow(token, workspaceId, databaseId, { sourceViewId: viewId });
  assert.equal(response.status, 200);

  for (const collabType of [2, 3, 99]) {
    const socket = await connectAckTestSocket(base, workspaceId, token, 6000 + collabType);
    const closePromise = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    socket.send(encodeMessage({
      collabMessage: {
        objectId: request.row_id,
        collabType,
        syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) },
      },
    }));
    const outcome = await closePromise;
    assert.equal(outcome.code, 1008, `collabType ${collabType} must be rejected, not admitted`);
  }
});

test('DatabaseRow WebSocket: a row id from another workspace is rejected', async () => {
  const owner = await setupDatabase('row-ws-owner');
  const { request: ownerRow } = await createRow(owner.token, owner.workspaceId, owner.databaseId, { sourceViewId: owner.viewId });

  const outsider = await setupDatabase('row-ws-outsider');
  await createRow(outsider.token, outsider.workspaceId, outsider.databaseId, { sourceViewId: outsider.viewId });

  const socket = await connectAckTestSocket(base, outsider.workspaceId, outsider.token, 6100);
  const closePromise = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  socket.send(encodeMessage({
    collabMessage: {
      objectId: ownerRow.row_id,
      collabType: 4,
      syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) },
    },
  }));
  const outcome = await closePromise;
  assert.equal(outcome.code, 1008);
  assert.equal(outcome.reason, 'DatabaseRow collaboration object is not authorized');
});

async function setupRowForAckTests(label) {
  const { token, workspaceId, databaseId, viewId } = await setupDatabase(label);
  const { request, response } = await createRow(token, workspaceId, databaseId, { sourceViewId: viewId });
  assert.equal(response.status, 200);
  const rowId = request.row_id;
  const collabRoute = `/api/workspace/v1/${workspaceId}/collab/${rowId}?collab_type=4`;
  const initialRead = await api('GET', collabRoute, undefined, token);
  assert.equal(initialRead.status, 200);
  return { token, workspaceId, rowId, collabRoute, initialState: initialRead.body.data };
}

test('DatabaseRow real-time: writing a cell over WebSocket updates (generic Yjs diff admission, same mechanism as Database field edits)', async () => {
  const { token, workspaceId, rowId, collabRoute, initialState } = await setupRowForAckTests('row-cell');

  const client = new Y.Doc({ guid: rowId });
  Y.applyUpdate(client, new Uint8Array(initialState.doc_state));
  let stateVector = Y.encodeStateVector(client);

  const socket = await connectAckTestSocket(base, workspaceId, token, 6200);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({
      collabMessage: { objectId: rowId, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector } },
    }));
    assert.ok((await manifestPromise).syncRequest);

    // Ordinary cell write: exactly the Yjs mutation AppFlowy-Web's
    // writeCellToRow (dispatch/cell.ts) performs -- the backend never
    // inspects cell/field semantics, it only admits the generic Yjs diff.
    const row = client.getMap('data').get('data');
    const cells = row.get('cells');
    const cell = new Y.Map();
    cell.set('data', 'Task 62 row value');
    cell.set('field_type', 0);
    cells.set('name-field', cell);

    const payload = Y.encodeStateAsUpdate(client, stateVector);
    const ackPromise = nextUpdateFrame(nextFrame);
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, update: { flags: 0, payload, beforeStateVector: stateVector } } }));
    const ack = await ackPromise;
    assert.ok(ack.update);
    stateVector = Y.encodeStateVector(client);

    const readBack = await api('GET', collabRoute, undefined, token);
    assert.equal(readBack.status, 200);
    const persisted = openRowDoc(new Uint8Array(readBack.body.data.doc_state), rowId);
    try {
      const persistedCell = persisted.getMap('data').get('data').get('cells').get('name-field');
      assert.ok(persistedCell, 'the cell write must be durably persisted');
      assert.equal(persistedCell.get('data'), 'Task 62 row value');
    } finally {
      persisted.destroy();
    }
  } finally {
    socket.close();
    client.destroy();
  }
});

test('DatabaseRow real-time: duplicate/replayed update is admitted exactly once', async () => {
  const { token, workspaceId, rowId, collabRoute, initialState } = await setupRowForAckTests('row-dup');
  const client = new Y.Doc({ guid: rowId });
  Y.applyUpdate(client, new Uint8Array(initialState.doc_state));
  const stateVector = Y.encodeStateVector(client);

  const socket = await connectAckTestSocket(base, workspaceId, token, 6300);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector } } }));
    assert.ok((await manifestPromise).syncRequest);

    const row = client.getMap('data').get('data');
    row.set('height', 72);
    const payload = Y.encodeStateAsUpdate(client, stateVector);

    const firstAckPromise = nextUpdateFrame(nextFrame);
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, update: { flags: 0, payload, beforeStateVector: stateVector } } }));
    const firstAck = await firstAckPromise;
    const firstMessageId = firstAck.update.messageId;

    const secondAckPromise = nextUpdateFrame(nextFrame);
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, update: { flags: 0, payload, beforeStateVector: stateVector } } }));
    const secondAck = await secondAckPromise;
    assert.equal(String(secondAck.update.messageId.timestamp), String(firstMessageId.timestamp));
    assert.equal(String(secondAck.update.messageId.counter), String(firstMessageId.counter));

    const readBack = await api('GET', collabRoute, undefined, token);
    const persisted = openRowDoc(new Uint8Array(readBack.body.data.doc_state), rowId);
    try {
      assert.equal(persisted.getMap('data').get('data').get('height'), 72, 'the replayed update must not be applied twice (idempotent height change)');
    } finally {
      persisted.destroy();
    }
  } finally {
    socket.close();
    client.destroy();
  }
});

test('DatabaseRow real-time: no ack while persistence is pending, then acks only after durable write completes (delayed-persistence fault injection, Task 44 pattern)', async () => {
  const { token, workspaceId, rowId, collabRoute, initialState } = await setupRowForAckTests('row-ack-delay');
  const store = running.app.store;
  const originalPersist = store.persist;

  const client = new Y.Doc({ guid: rowId });
  Y.applyUpdate(client, new Uint8Array(initialState.doc_state));
  const preUpdateStateVector = Y.encodeStateVector(client);

  const socket = await connectAckTestSocket(base, workspaceId, token, 6400);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: preUpdateStateVector } } }));
    assert.ok((await manifestPromise).syncRequest);

    const row = client.getMap('data').get('data');
    const marker = `task62-delay-${id()}`;
    row.set('last_modified', marker);
    const updatePayload = Y.encodeStateAsUpdate(client, preUpdateStateVector);

    let releasePersist;
    const persistGate = new Promise((resolve) => { releasePersist = resolve; });
    let persistInvoked = false;
    let persistCompleted = false;
    store.persist = async (state) => {
      persistInvoked = true;
      await persistGate;
      await persistToDisk(store.file, state);
      persistCompleted = true;
    };

    const ackPromise = nextFrame(5000);
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, update: { flags: 0, payload: updatePayload, beforeStateVector: preUpdateStateVector } } }));

    const deadline = Date.now() + 2000;
    while (!persistInvoked && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(persistInvoked, 'persistence hook must have been entered before proceeding');

    const graceTimeoutMs = 300;
    const noAckYet = Symbol('no-ack-yet');
    const grace = new Promise((resolve) => setTimeout(() => resolve(noAckYet), graceTimeoutMs));
    const raceResult = await Promise.race([ackPromise.catch(() => noAckYet), grace]);
    assert.equal(raceResult, noAckYet, 'no successful ack must be emitted while persistence is still pending');
    assert.equal(persistCompleted, false);

    releasePersist();
    const ack = await ackPromise;
    assert.equal(persistCompleted, true);
    assert.ok(ack.update);

    const readBack = await api('GET', collabRoute, undefined, token);
    const persisted = openRowDoc(new Uint8Array(readBack.body.data.doc_state), rowId);
    try {
      assert.equal(persisted.getMap('data').get('data').get('last_modified'), marker, 'the update acked after release must be durably persisted on disk');
    } finally {
      persisted.destroy();
    }
  } finally {
    store.persist = originalPersist;
    socket.close();
    client.destroy();
  }
});

test('DatabaseRow real-time: no ack and closes with 1011 when persistence fails; the failed update is not durably admitted (failed-persistence fault injection, Task 44 pattern)', async () => {
  const { token, workspaceId, rowId, collabRoute, initialState } = await setupRowForAckTests('row-ack-fail');
  const store = running.app.store;
  const originalPersist = store.persist;

  const client = new Y.Doc({ guid: rowId });
  Y.applyUpdate(client, new Uint8Array(initialState.doc_state));
  const preUpdateStateVector = Y.encodeStateVector(client);
  const marker = `task62-fail-${id()}`;

  const socket = await connectAckTestSocket(base, workspaceId, token, 6500);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: preUpdateStateVector } } }));
    assert.ok((await manifestPromise).syncRequest);

    const row = client.getMap('data').get('data');
    row.set('last_modified', marker);
    const updatePayload = Y.encodeStateAsUpdate(client, preUpdateStateVector);

    store.persist = async () => { throw new Error('task62 injected persistence failure'); };

    const closePromise = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    const ackOrCloseRace = Promise.race([
      nextFrame(5000).then((frame) => ({ kind: 'frame', frame })),
      closePromise.then((result) => ({ kind: 'close', ...result })),
    ]);
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, update: { flags: 0, payload: updatePayload, beforeStateVector: preUpdateStateVector } } }));
    const outcome = await ackOrCloseRace;
    assert.equal(outcome.kind, 'close', 'a failed persist must never be observed as a successful ack frame');
    assert.equal(outcome.code, 1011);
    assert.equal(outcome.reason, 'DatabaseRow update could not be persisted');
  } finally {
    store.persist = originalPersist;
    try { socket.close(); } catch { /* already closed */ }
    client.destroy();
  }

  const readBack = await api('GET', collabRoute, undefined, token);
  const persisted = openRowDoc(new Uint8Array(readBack.body.data.doc_state), rowId);
  try {
    assert.notEqual(persisted.getMap('data').get('data').get('last_modified'), marker, 'an update whose persistence failed must not appear in durable state');
  } finally {
    persisted.destroy();
  }
});

test('DatabaseRow persistence: JSON store reconstructs the latest accepted state after a simulated backend restart, including row_orders membership', async () => {
  const { token, workspaceId, databaseId, viewId } = await setupDatabase('row-restart');
  const { request } = await createRow(token, workspaceId, databaseId, { sourceViewId: viewId });
  const rowId = request.row_id;

  const collabRoute = `/api/workspace/v1/${workspaceId}/collab/${rowId}?collab_type=4`;
  const before = await api('GET', collabRoute, undefined, token);
  const client = new Y.Doc({ guid: rowId });
  Y.applyUpdate(client, new Uint8Array(before.body.data.doc_state));
  const stateVector = Y.encodeStateVector(client);
  const row = client.getMap('data').get('data');
  row.set('last_modified', 'Survives restart');
  const payload = Y.encodeStateAsUpdate(client, stateVector);

  const socket = await connectAckTestSocket(base, workspaceId, token, 6600);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector } } }));
    assert.ok((await manifestPromise).syncRequest);
    const ackPromise = nextFrame(5000);
    socket.send(encodeMessage({ collabMessage: { objectId: rowId, collabType: 4, update: { flags: 0, payload, beforeStateVector: stateVector } } }));
    assert.ok((await ackPromise).update);
  } finally {
    socket.close();
    client.destroy();
  }

  const reopened = await openStore(dataFile, { storage: 'json' });
  const reopenedRowCollab = await reopened.getDatabaseRowCollab(workspaceId, rowId);
  assert.ok(reopenedRowCollab, 'the DatabaseRow collab object must be reconstructable from disk after a restart');
  const reopenedRowDoc = openRowDoc(reopenedRowCollab.doc_state, rowId);
  try {
    assert.equal(reopenedRowDoc.getMap('data').get('data').get('last_modified'), 'Survives restart');
  } finally {
    reopenedRowDoc.destroy();
  }

  const reopenedDatabaseCollab = await reopened.getDatabaseCollab(workspaceId, databaseId);
  const reopenedDatabaseDoc = openDatabaseDoc(reopenedDatabaseCollab.doc_state, databaseId);
  try {
    const view = reopenedDatabaseDoc.getMap('data').get('database').get('views').get(viewId);
    assert.ok(view.get('row_orders').toArray().some((entry) => entry.id === rowId), 'row_orders membership must also survive a restart');
  } finally {
    reopenedDatabaseDoc.destroy();
  }
});
