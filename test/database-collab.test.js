// Task 61 (Phase 1 Grid database foundation) backend test coverage.
//
// Mirrors the conventions already established in test/backend.test.js for
// the Document collab path (same `api()` HTTP helper shape, same WebSocket
// connect/frame-reader helpers, same Task 44 fault-injection pattern reused
// verbatim for the Database path), applied to the new Database (CollabType
// = 1) admission/persistence/atomic-creation code added for Task 61.
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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-database-'));
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
    const timeout = setTimeout(() => reject(new Error('Database WebSocket response timed out')), timeoutMs);
    const accept = ({ frame, isBinary }) => {
      clearTimeout(timeout);
      if (!isBinary) return reject(new Error('Database WebSocket response was not binary'));
      resolve(decodeMessage(frame).collabMessage);
    };
    const pending = pendingFrames.shift();
    if (pending) accept(pending);
    else frameWaiters.push(accept);
  });
}

// After every accepted update, the server (mirroring the Document path
// exactly) also sends a follow-up sync manifest frame. When a test sends a
// second update right after the first ack, that leftover manifest frame is
// still queued and must be skipped to find the real update-ack frame.
async function nextUpdateFrame(nextFrame) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const frame = await nextFrame(5000);
    if (frame.update) return frame;
  }
  throw new Error('No update-ack frame arrived within the expected number of frames');
}

function openDatabaseDoc(docState, databaseId) {
  const doc = new Y.Doc({ guid: databaseId });
  Y.applyUpdate(doc, docState);
  return doc;
}

test('Database atomic creation: valid request initializes fields, inline Grid view, and metas', async () => {
  const { token, workspaceId } = await registerAndLogin('db-create');
  const spaceId = await createPublicSpace(token, workspaceId, 'db-create');
  const { request, response } = await createGridDatabase(token, workspaceId, spaceId);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, {
    request_id: request.request_id,
    outcome: 'applied',
    result: { view_id: request.container_id, database_id: request.database.database_id },
  });

  const collabRoute = `/api/workspace/v1/${workspaceId}/collab/${request.database.database_id}?collab_type=1`;
  const collabRead = await api('GET', collabRoute, undefined, token);
  assert.equal(collabRead.status, 200);
  assert.equal(collabRead.body.data.object_id, request.database.database_id);
  assert.equal(typeof collabRead.body.data.collab_version, 'string');

  const doc = openDatabaseDoc(new Uint8Array(collabRead.body.data.doc_state), request.database.database_id);
  try {
    const database = doc.getMap('data').get('database');
    assert.equal(database.get('id'), request.database.database_id);

    const fields = database.get('fields');
    const fieldEntries = [...fields.entries()];
    assert.equal(fieldEntries.length, 1, 'a brand-new Grid database seeds exactly one field (the primary/title field)');
    const [primaryFieldId, primaryField] = fieldEntries[0];
    assert.equal(primaryField.get('is_primary'), true);
    assert.equal(primaryField.get('ty'), 0, 'the seeded primary field is FieldType.RichText (0)');
    assert.equal(primaryField.get('name'), 'Name');

    const views = database.get('views');
    const view = views.get(request.database.view_id);
    assert.ok(view, 'the primary/inline view must exist under its own id in the views map');
    assert.equal(view.get('id'), request.database.view_id);
    assert.equal(view.get('database_id'), request.database.database_id);
    assert.equal(view.get('layout'), 0, 'DatabaseViewLayout.Grid = 0');
    assert.ok(view.get('row_orders') instanceof Y.Array, 'row_orders must be a real Y.Array (rows are out of scope for Phase 1, but the type must be correct)');
    assert.equal(view.get('row_orders').length, 0);
    assert.ok(view.get('filters') instanceof Y.Array);
    assert.ok(view.get('sorts') instanceof Y.Array);
    assert.ok(view.get('groups') instanceof Y.Array);
    assert.ok(view.get('calculations') instanceof Y.Array);
    assert.ok(view.get('layout_settings') instanceof Y.Map);
    assert.ok(view.get('field_settings') instanceof Y.Map);
    const fieldOrders = view.get('field_orders');
    assert.ok(fieldOrders instanceof Y.Array);
    assert.deepEqual(fieldOrders.toArray().map((entry) => entry.id), [primaryFieldId]);

    const metas = database.get('metas');
    assert.equal(metas.get('iid'), request.database.view_id);
  } finally {
    doc.destroy();
  }
});

test('Database atomic creation: workspace catalog / Folder-tree discoverability', async () => {
  const { token, workspaceId } = await registerAndLogin('db-discover');
  const spaceId = await createPublicSpace(token, workspaceId, 'db-discover');
  const { request, response } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Sidebar grid name' });
  assert.equal(response.status, 200);

  // The space's own children (what the sidebar renders) must include the
  // new database's container entry, reporting ViewLayout.Grid (1) and the
  // is_database_container/database_id marker.
  const spaceFolder = await api('GET', `/api/workspace/${workspaceId}/view/${spaceId}?depth=1`, undefined, token);
  assert.equal(spaceFolder.status, 200);
  const containerEntry = spaceFolder.body.data.children.find((child) => child.view_id === request.container_id);
  assert.ok(containerEntry, 'the database container must appear as a child of the space it was created in');
  assert.equal(containerEntry.layout, 1, 'ViewLayout.Grid = 1 (Folder-side enum)');
  assert.equal(containerEntry.extra.is_database_container, true);
  assert.equal(containerEntry.extra.database_id, request.database.database_id);
  assert.equal(containerEntry.name, 'Sidebar grid name');

  // The container's own children must include the primary/inline view entry
  // AppFlowy-Web's validateDatabase() requires.
  const containerFolder = await api('GET', `/api/workspace/${workspaceId}/view/${request.container_id}?depth=1`, undefined, token);
  assert.equal(containerFolder.status, 200);
  assert.equal(containerFolder.body.data.extra.is_database_container, true);
  assert.equal(containerFolder.body.data.extra.database_id, request.database.database_id);
  const viewEntry = containerFolder.body.data.children.find((child) => child.view_id === request.database.view_id);
  assert.ok(viewEntry, "the database's own primary view must appear as a Folder child of the container");
  assert.equal(viewEntry.layout, 1);
  assert.equal(viewEntry.extra.database_id, request.database.database_id);

  // restore-state (required by AppFlowy-Web's verifyCreatedPage()) reports a
  // consistent, stable "no restore has happened" shape.
  const restoreState = await api('GET', `/api/workspace/${workspaceId}/database/${request.database.database_id}/restore-state`, undefined, token);
  assert.equal(restoreState.status, 200);
  assert.equal(restoreState.body.data.database_restore_id, null);
  const collabRead = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${request.database.database_id}?collab_type=1`, undefined, token);
  assert.equal(restoreState.body.data.version, collabRead.body.data.collab_version, 'restore-state.version must equal the Database object\'s own collab_version (verifyCreatedPage compares these directly)');
});

test('Database atomic creation: duplicate request_id (retry) is idempotent', async () => {
  const { token, workspaceId } = await registerAndLogin('db-retry');
  const spaceId = await createPublicSpace(token, workspaceId, 'db-retry');
  const request = defaultDatabaseRequest({ parentViewId: spaceId });
  const first = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.outcome, 'applied');

  const second = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.outcome, 'already_applied');
  assert.deepEqual(second.body.data.result, first.body.data.result);

  const different = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, { ...request, name: 'Different request' }, token);
  assert.equal(different.status, 409);
  assert.equal(different.body.error.code, 'REQUEST_ID_REUSED');
});

test('Database atomic creation: invalid/malformed requests are rejected (missing identity, unsupported layout, unauthorized workspace)', async () => {
  const { token, workspaceId } = await registerAndLogin('db-invalid');
  const spaceId = await createPublicSpace(token, workspaceId, 'db-invalid');
  const route = `/api/workspace/${workspaceId}/v2/page-view/database/default`;

  assert.equal((await api('POST', route, defaultDatabaseRequest({ parentViewId: spaceId }))).status, 401, 'no auth token');
  assert.equal((await api('POST', route, defaultDatabaseRequest({ parentViewId: spaceId }), 'not-a-real-token')).status, 401);

  const missingContainerId = defaultDatabaseRequest({ parentViewId: spaceId });
  delete missingContainerId.container_id;
  assert.equal((await api('POST', route, missingContainerId, token)).status, 400, 'missing container_id');

  const badDatabaseId = defaultDatabaseRequest({ parentViewId: spaceId });
  badDatabaseId.database.database_id = 'not-a-uuid';
  assert.equal((await api('POST', route, badDatabaseId, token)).status, 400, 'malformed database_id');

  // Board (1) is a genuinely supported top-level layout now (see
  // test/database-top-level-views.test.js for full per-layout coverage) --
  // only Form (7), which needs a companion "Responses" view this backend
  // doesn't implement, and an out-of-range value remain rejected here.
  const formLayout = defaultDatabaseRequest({ parentViewId: spaceId });
  formLayout.database.layout = 7; // DatabaseViewLayout.Form -- out of scope (companion view unsupported)
  assert.equal((await api('POST', route, formLayout, token)).status, 400, 'Form requires an unimplemented companion Responses view');

  const outOfRangeLayout = defaultDatabaseRequest({ parentViewId: spaceId });
  outOfRangeLayout.database.layout = 99;
  assert.equal((await api('POST', route, outOfRangeLayout, token)).status, 400, 'an out-of-range layout value is rejected');

  // The real frontend derives `embedded` from view/document context and
  // sends `true` for an ordinary new top-level Grid page (see
  // AppFlowy-Web dispatch.ts's isEmbeddedView/isDocumentBlock logic) --
  // this was previously, incorrectly, rejected outright. The value isn't
  // used downstream (createInitialDatabaseCollab always sets the created
  // primary view's own `embedded` flag to false), so only its type is
  // validated now.
  const embeddedTrue = defaultDatabaseRequest({ parentViewId: spaceId });
  embeddedTrue.database.embedded = true;
  assert.equal((await api('POST', route, embeddedTrue, token)).status, 200, 'embedded: true is a real, supported frontend payload shape');

  const nonBooleanEmbedded = defaultDatabaseRequest({ parentViewId: spaceId });
  nonBooleanEmbedded.database.embedded = 'true';
  assert.equal((await api('POST', route, nonBooleanEmbedded, token)).status, 400, 'embedded must still be a boolean');

  const extraField = defaultDatabaseRequest({ parentViewId: spaceId });
  extraField.unexpected_field = true;
  assert.equal((await api('POST', route, extraField, token)).status, 400, 'unsupported top-level fields are rejected, not silently ignored');

  const notASpace = defaultDatabaseRequest({ parentViewId: id() });
  assert.equal((await api('POST', route, notASpace, token)).status, 403, 'parent_view_id must be a real, authorized public space');

  const otherLogin = await registerAndLogin('db-invalid-outsider');
  assert.equal((await api('POST', route, defaultDatabaseRequest({ parentViewId: spaceId }), otherLogin.token)).status, 403, 'a user outside the workspace must be rejected');
});

test('Database WebSocket: unsupported collabType values are rejected, not silently admitted', async () => {
  const { token, workspaceId } = await registerAndLogin('db-ws-invalid');
  const spaceId = await createPublicSpace(token, workspaceId, 'db-ws-invalid');
  const { request, response } = await createGridDatabase(token, workspaceId, spaceId);
  assert.equal(response.status, 200);

  for (const collabType of [3, 4, 99]) {
    const socket = await connectAckTestSocket(base, workspaceId, token, 5000 + collabType);
    const closePromise = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    socket.send(encodeMessage({
      collabMessage: {
        objectId: request.database.database_id,
        collabType,
        syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) },
      },
    }));
    const outcome = await closePromise;
    assert.equal(outcome.code, 1008, `collabType ${collabType} must be rejected, not admitted`);
  }
});

test('Database WebSocket: a database id from another workspace is rejected', async () => {
  const owner = await registerAndLogin('db-ws-owner');
  const ownerSpace = await createPublicSpace(owner.token, owner.workspaceId, 'db-ws-owner');
  const { request: ownerRequest } = await createGridDatabase(owner.token, owner.workspaceId, ownerSpace);

  const outsider = await registerAndLogin('db-ws-outsider');
  const outsiderSpace = await createPublicSpace(outsider.token, outsider.workspaceId, 'db-ws-outsider');
  await createGridDatabase(outsider.token, outsider.workspaceId, outsiderSpace);

  // The outsider is a member of their OWN workspace (so the socket itself
  // connects), but tries to address the owner's database id across
  // workspaces -- this must be rejected the same way an unsupported
  // collabType is, not silently treated as "not found but otherwise fine".
  const socket = await connectAckTestSocket(base, outsider.workspaceId, outsider.token, 5100);
  const closePromise = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  socket.send(encodeMessage({
    collabMessage: {
      objectId: ownerRequest.database.database_id,
      collabType: 1,
      syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) },
    },
  }));
  const outcome = await closePromise;
  assert.equal(outcome.code, 1008);
  assert.equal(outcome.reason, 'Database collaboration object is not authorized');
});

async function setupDatabaseForAckTests(label) {
  const { token, workspaceId } = await registerAndLogin(label);
  const spaceId = await createPublicSpace(token, workspaceId, label);
  const { request, response } = await createGridDatabase(token, workspaceId, spaceId);
  assert.equal(response.status, 200);
  const databaseId = request.database.database_id;
  const collabRoute = `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`;
  const initialRead = await api('GET', collabRoute, undefined, token);
  assert.equal(initialRead.status, 200);
  return { token, workspaceId, databaseId, collabRoute, initialState: initialRead.body.data, request };
}

test('Database real-time: add a field and rename it over WebSocket updates (generic Yjs diff admission, same mechanism as Document edits)', async () => {
  const { token, workspaceId, databaseId, collabRoute, initialState } = await setupDatabaseForAckTests('db-fields');

  const client = new Y.Doc({ guid: databaseId });
  Y.applyUpdate(client, new Uint8Array(initialState.doc_state));
  let stateVector = Y.encodeStateVector(client);

  const socket = await connectAckTestSocket(base, workspaceId, token, 5200);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({
      collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector } },
    }));
    assert.ok((await manifestPromise).syncRequest);

    // Add a field: exactly the Yjs mutation AppFlowy-Web's dispatch.ts
    // performs (database-yjs/dispatch.ts, useAddPropertyRightDispatch) --
    // the backend never inspects field semantics, it only admits the
    // generic Yjs diff, identically to a Document edit.
    const database = client.getMap('data').get('database');
    const fields = database.get('fields');
    const newFieldId = `nf${id().slice(0, 8)}`;
    const newField = new Y.Map();
    newField.set('id', newFieldId);
    newField.set('name', 'New field');
    newField.set('ty', 0);
    newField.set('icon', '');
    newField.set('is_primary', false);
    newField.set('created_at', new Date().toISOString());
    newField.set('last_modified', new Date().toISOString());
    const typeOption = new Y.Map();
    typeOption.set('0', new Y.Map());
    newField.set('type_option', typeOption);
    fields.set(newFieldId, newField);
    const view = [...database.get('views').values()][0];
    view.get('field_orders').push([{ id: newFieldId }]);

    const addPayload = Y.encodeStateAsUpdate(client, stateVector);
    const addAckPromise = nextUpdateFrame(nextFrame);
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload: addPayload, beforeStateVector: stateVector } } }));
    const addAck = await addAckPromise;
    assert.ok(addAck.update);
    stateVector = Y.encodeStateVector(client);

    // Rename the new field: dispatch.ts's useUpdatePropertyNameDispatch
    // mutation shape (field.set('last_modified', ...); field.set('name', ...)).
    newField.set('last_modified', new Date().toISOString());
    newField.set('name', 'Renamed field');
    const renamePayload = Y.encodeStateAsUpdate(client, stateVector);
    const renameAckPromise = nextUpdateFrame(nextFrame);
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload: renamePayload, beforeStateVector: stateVector } } }));
    const renameAck = await renameAckPromise;
    assert.ok(renameAck.update);

    const readBack = await api('GET', collabRoute, undefined, token);
    assert.equal(readBack.status, 200);
    const persisted = openDatabaseDoc(new Uint8Array(readBack.body.data.doc_state), databaseId);
    try {
      const persistedFields = persisted.getMap('data').get('database').get('fields');
      const persistedNewField = persistedFields.get(newFieldId);
      assert.ok(persistedNewField, 'the added field must be durably persisted');
      assert.equal(persistedNewField.get('name'), 'Renamed field', 'the rename must be durably persisted');
      assert.equal([...persistedFields.entries()].length, 2, 'the original primary field plus the added field, nothing lost or duplicated');
    } finally {
      persisted.destroy();
    }
  } finally {
    socket.close();
    client.destroy();
  }
});

test('Database real-time: duplicate/replayed update is admitted exactly once', async () => {
  const { token, workspaceId, databaseId, collabRoute, initialState } = await setupDatabaseForAckTests('db-dup');
  const client = new Y.Doc({ guid: databaseId });
  Y.applyUpdate(client, new Uint8Array(initialState.doc_state));
  const stateVector = Y.encodeStateVector(client);

  const socket = await connectAckTestSocket(base, workspaceId, token, 5300);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector } } }));
    assert.ok((await manifestPromise).syncRequest);

    const field = [...client.getMap('data').get('database').get('fields').values()][0];
    field.set('name', 'Renamed once');
    const payload = Y.encodeStateAsUpdate(client, stateVector);

    const firstAckPromise = nextUpdateFrame(nextFrame);
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload, beforeStateVector: stateVector } } }));
    const firstAck = await firstAckPromise;
    const firstMessageId = firstAck.update.messageId;

    const secondAckPromise = nextUpdateFrame(nextFrame);
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload, beforeStateVector: stateVector } } }));
    const secondAck = await secondAckPromise;
    assert.equal(String(secondAck.update.messageId.timestamp), String(firstMessageId.timestamp));
    assert.equal(String(secondAck.update.messageId.counter), String(firstMessageId.counter));

    const readBack = await api('GET', collabRoute, undefined, token);
    const persisted = openDatabaseDoc(new Uint8Array(readBack.body.data.doc_state), databaseId);
    try {
      const names = [...persisted.getMap('data').get('database').get('fields').values()].map((value) => value.get('name'));
      assert.deepEqual(names, ['Renamed once'], 'the replayed update must not be applied twice');
    } finally {
      persisted.destroy();
    }
  } finally {
    socket.close();
    client.destroy();
  }
});

test('Database real-time: no ack while persistence is pending, then acks only after durable write completes (delayed-persistence fault injection, Task 44 pattern)', async () => {
  const { token, workspaceId, databaseId, collabRoute, initialState } = await setupDatabaseForAckTests('db-ack-delay');
  const store = running.app.store;
  const originalPersist = store.persist;

  const client = new Y.Doc({ guid: databaseId });
  Y.applyUpdate(client, new Uint8Array(initialState.doc_state));
  const preUpdateStateVector = Y.encodeStateVector(client);

  const socket = await connectAckTestSocket(base, workspaceId, token, 5400);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: preUpdateStateVector } } }));
    assert.ok((await manifestPromise).syncRequest);

    const field = [...client.getMap('data').get('database').get('fields').values()][0];
    const marker = `task61-delay-${id()}`;
    field.set('name', marker);
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
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload: updatePayload, beforeStateVector: preUpdateStateVector } } }));

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
    const persisted = openDatabaseDoc(new Uint8Array(readBack.body.data.doc_state), databaseId);
    try {
      const names = [...persisted.getMap('data').get('database').get('fields').values()].map((value) => value.get('name'));
      assert.ok(names.includes(marker), 'the update acked after release must be durably persisted on disk');
    } finally {
      persisted.destroy();
    }
  } finally {
    store.persist = originalPersist;
    socket.close();
    client.destroy();
  }
});

test('Database real-time: no ack and closes with 1011 when persistence fails; the failed update is not durably admitted (failed-persistence fault injection, Task 44 pattern)', async () => {
  const { token, workspaceId, databaseId, collabRoute, initialState } = await setupDatabaseForAckTests('db-ack-fail');
  const store = running.app.store;
  const originalPersist = store.persist;

  const client = new Y.Doc({ guid: databaseId });
  Y.applyUpdate(client, new Uint8Array(initialState.doc_state));
  const preUpdateStateVector = Y.encodeStateVector(client);
  const marker = `task61-fail-${id()}`;

  const socket = await connectAckTestSocket(base, workspaceId, token, 5500);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: preUpdateStateVector } } }));
    assert.ok((await manifestPromise).syncRequest);

    const field = [...client.getMap('data').get('database').get('fields').values()][0];
    field.set('name', marker);
    const updatePayload = Y.encodeStateAsUpdate(client, preUpdateStateVector);

    store.persist = async () => { throw new Error('task61 injected persistence failure'); };

    const closePromise = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    const ackOrCloseRace = Promise.race([
      nextFrame(5000).then((frame) => ({ kind: 'frame', frame })),
      closePromise.then((result) => ({ kind: 'close', ...result })),
    ]);
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload: updatePayload, beforeStateVector: preUpdateStateVector } } }));
    const outcome = await ackOrCloseRace;
    assert.equal(outcome.kind, 'close', 'a failed persist must never be observed as a successful ack frame');
    assert.equal(outcome.code, 1011);
    assert.equal(outcome.reason, 'Database update could not be persisted');
  } finally {
    store.persist = originalPersist;
    try { socket.close(); } catch { /* already closed */ }
    client.destroy();
  }

  const readBack = await api('GET', collabRoute, undefined, token);
  const persisted = openDatabaseDoc(new Uint8Array(readBack.body.data.doc_state), databaseId);
  try {
    const names = [...persisted.getMap('data').get('database').get('fields').values()].map((value) => value.get('name'));
    assert.ok(!names.includes(marker), 'an update whose persistence failed must not appear in durable state');
  } finally {
    persisted.destroy();
  }
});

test('Database persistence: JSON store reconstructs the latest accepted state after a simulated backend restart', async () => {
  const { token, workspaceId, databaseId, request } = await setupDatabaseForAckTests('db-restart');

  // Mutate via WebSocket (rename the primary field), then close the
  // in-process store and re-open a fresh one from the same JSON file --
  // simulating a backend restart -- and confirm the rename, the view, and
  // the Folder-tree discoverability all survive.
  const collabRoute = `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`;
  const before = await api('GET', collabRoute, undefined, token);
  const client = new Y.Doc({ guid: databaseId });
  Y.applyUpdate(client, new Uint8Array(before.body.data.doc_state));
  const stateVector = Y.encodeStateVector(client);
  const field = [...client.getMap('data').get('database').get('fields').values()][0];
  field.set('name', 'Survives restart');
  const payload = Y.encodeStateAsUpdate(client, stateVector);

  const socket = await connectAckTestSocket(base, workspaceId, token, 5600);
  const nextFrame = ackTestFrameReader(socket);
  try {
    const manifestPromise = nextFrame();
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector } } }));
    assert.ok((await manifestPromise).syncRequest);
    const ackPromise = nextFrame(5000);
    socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload, beforeStateVector: stateVector } } }));
    assert.ok((await ackPromise).update);
  } finally {
    socket.close();
    client.destroy();
  }

  // Reopen a brand-new store instance directly from the same durable JSON
  // file (independent of the running HTTP server's in-memory store), the
  // same reconstruction path a real process restart would take.
  const reopened = await openStore(dataFile, { storage: 'json' });
  const reopenedCollab = await reopened.getDatabaseCollab(workspaceId, databaseId);
  assert.ok(reopenedCollab, 'the Database collab object must be reconstructable from disk after a restart');
  const reopenedDoc = openDatabaseDoc(reopenedCollab.doc_state, databaseId);
  try {
    const fields = reopenedDoc.getMap('data').get('database').get('fields');
    assert.equal([...fields.values()][0].get('name'), 'Survives restart');
    const metas = reopenedDoc.getMap('data').get('database').get('metas');
    assert.equal(metas.get('iid'), request.database.view_id);
  } finally {
    reopenedDoc.destroy();
  }

  // The Folder-tree registration (workspace catalog discoverability) must
  // also still be present via the plain HTTP API against the still-running
  // server (which shares the same on-disk file).
  const containerRoute = `/api/workspace/${workspaceId}/view/${request.container_id}?depth=1`;
  const containerAfter = await api('GET', containerRoute, undefined, token);
  assert.equal(containerAfter.status, 200);
  assert.equal(containerAfter.body.data.extra.database_id, databaseId);
});

// Discovered during Task 61's real-browser verification: AppFlowy-Web's own
// permission-probe design (resolvePermissionProbeTarget, permissionProbe.ts)
// treats GET .../collab/{id}/permission?collab_type=0 generically as
// "permission for workspace folder view X", not strictly "permission for a
// Document collab object" -- it is called with a SPACE's own id whenever a
// user hovers a space row, and is the sole gate for the sidebar's inline
// "+" (add-page) button, the only UI entry point for picking a non-Document
// layout such as Grid. Before this fix the endpoint only recognized
// Document page ids, so a space id 404'd, the "+" button silently never
// rendered, and creating a Grid database through the real UI was
// unreachable. This is additive: Document identity/shape/behavior is
// covered by the pre-existing "AppFlowy-Web reads/writes a Document
// collaboration object" tests above and is asserted unchanged there.
test('Space permission probe: GET .../collab/{spaceId}/permission?collab_type=0 resolves for a space (not just a Document page), unblocking the sidebar add-page button', async () => {
  const { token, workspaceId } = await registerAndLogin('db-space-permission');
  const spaceId = await createPublicSpace(token, workspaceId, 'db-space-permission');
  const route = `/api/workspace/${workspaceId}/collab/${spaceId}/permission?collab_type=0`;

  assert.equal((await api('GET', route)).status, 401);

  const outsider = await registerAndLogin('db-space-permission-outsider');
  assert.equal((await api('GET', route, undefined, outsider.token)).status, 403);

  const response = await api('GET', route, undefined, token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, {
    object_id: spaceId,
    collab_type: 0,
    governing_view_id: spaceId,
    access_level: 50,
    can_read: true,
    can_write: true,
    can_comment: true,
    can_share: true,
  });

  // An id that is neither a real Document page nor a real space still 404s
  // -- this is additive recognition of spaces, not a loosened "anything
  // goes" fallback.
  const unknownIdRoute = `/api/workspace/${workspaceId}/collab/${id()}/permission?collab_type=0`;
  assert.equal((await api('GET', unknownIdRoute, undefined, token)).status, 404);
});

// Also discovered during real-browser verification: AppFlowy-Web's Grid
// view resolves its own content permission as {collabObjectId: database_id,
// collabType: Types.Database} (permissionProbe.ts), gating the "add
// property"/field-menu UI actions -- distinct from the space-row probe
// above, which always uses collab_type=0.
test('Database permission probe: GET .../collab/{databaseId}/permission?collab_type=1 resolves for a Database object, unblocking the Grid view\'s field-menu UI actions', async () => {
  const { token, workspaceId } = await registerAndLogin('db-db-permission');
  const spaceId = await createPublicSpace(token, workspaceId, 'db-db-permission');
  const { request, response } = await createGridDatabase(token, workspaceId, spaceId);
  assert.equal(response.status, 200);
  const route = `/api/workspace/${workspaceId}/collab/${request.database.database_id}/permission?collab_type=1`;

  assert.equal((await api('GET', route)).status, 401);
  const outsider = await registerAndLogin('db-db-permission-outsider');
  assert.equal((await api('GET', route, undefined, outsider.token)).status, 403);

  const result = await api('GET', route, undefined, token);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, {
    object_id: request.database.database_id,
    collab_type: 1,
    governing_view_id: request.database.database_id,
    access_level: 50,
    can_read: true,
    can_write: true,
    can_comment: true,
    can_share: true,
  });

  const unknownDatabaseRoute = `/api/workspace/${workspaceId}/collab/${id()}/permission?collab_type=1`;
  assert.equal((await api('GET', unknownDatabaseRoute, undefined, token)).status, 404);

  // Unsupported collab_type values (e.g. Folder=3) are still rejected, not
  // silently accepted now that 0 and 1 are both supported.
  const unsupportedRoute = `/api/workspace/${workspaceId}/collab/${request.database.database_id}/permission?collab_type=3`;
  assert.equal((await api('GET', unsupportedRoute, undefined, token)).status, 400);
});
