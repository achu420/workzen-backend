// Task 72 (database views) backend test coverage.
//
// Discovery (docs/TASK72_DATABASE_VIEWS_DISCOVERY.md) found exactly ONE
// confirmed backend gap: creating an ADDITIONAL view inside an existing
// Database collab object had no route at all (POST .../v2/page-view/
// database-view/default, confirmed absent both at Task 60's original audit
// and by re-checking current server.js before this task). Everything else
// about view CONFIGURATION (rename, delete, filters/sorts/groups/
// field_settings/field_orders/layout_settings) was already fully handled by
// the generic Database collabType=1 WS admission path Task 61 built (which
// admits ANY Yjs diff against the Database object with zero bespoke
// server-side field/view logic) plus the pre-existing generic page-rename/
// trash routes -- this file's job is therefore (a) to prove the new
// creation route matches the contract AppFlowy-Web's own
// create-default-view.ts/create-default-view.integration.test.ts expect,
// and (b) to prove multi-view independence and live collaboration fan-out
// for VIEW CONFIG changes (as opposed to field changes, already proven by
// database-collab.test.js) generalize correctly across two views of the
// same database.
//
// Mirrors the exact test conventions already established in
// test/database-collab.test.js (same api()/WebSocket helper shapes).
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
import { openStore } from '../storage.js';

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-database-view-'));
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
  return { token, workspaceId, email };
}

async function addMember(ownerToken, workspaceId, memberEmail) {
  assert.equal(
    (await api('POST', `/api/workspaces/${workspaceId}/test-members`, { email: memberEmail, role: 'member' }, ownerToken, { 'x-development-key': 'test-key' })).status,
    201
  );
}

async function createPublicSpace(token, workspaceId, label) {
  const spaceId = id();
  assert.equal((await api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: `${label} space`, view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION,
  }, token)).status, 200);
  return spaceId;
}

function defaultDatabaseRequest({ parentViewId, name = 'Grid' }) {
  return {
    schema_version: 'v1', request_id: id(), parent_view_id: parentViewId, name: '', position: { kind: 'start' },
    container_id: id(),
    database: { database_id: id(), view_id: id(), name, layout: 0, embedded: false, responses_view_id: null, initial_row_ids: [id(), id(), id()], timezone_id: null },
  };
}

async function createGridDatabase(token, workspaceId, spaceId, overrides = {}) {
  const request = { ...defaultDatabaseRequest({ parentViewId: spaceId }), ...overrides };
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  return { request, response };
}

function defaultViewRequest({ databaseId, containerId, sourceViewId = null, layout = 1, name = 'Board', embedded = false }) {
  return {
    schema_version: 'v1', request_id: id(), database_restore_id: '00000000-0000-0000-0000-000000000000',
    view: { database_id: databaseId, view_id: id(), parent_view_id: containerId, source_view_id: sourceViewId, name, layout, embedded, responses_view_id: null, timezone_id: null },
    position: { kind: 'end' }, icon: null, extra: null,
  };
}

async function createAdditionalView(token, workspaceId, overrides) {
  const request = defaultViewRequest(overrides);
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database-view/default`, request, token);
  return { request, response };
}

function connectAckTestSocket(wsBase, workspaceId, token, clientId) {
  const websocketBase = wsBase.replace(/^http/, 'ws');
  const query = new URLSearchParams({
    clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`,
    token, cv: '0.10.0', cp: 'web',
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

function peerFrameReaderOrNull(socket) {
  const pendingFrames = [];
  const frameWaiters = [];
  socket.on('message', (frame, isBinary) => {
    const resolve = frameWaiters.shift();
    if (resolve) resolve({ frame, isBinary });
    else pendingFrames.push({ frame, isBinary });
  });
  return (timeoutMs = 2000) => new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    const accept = ({ frame, isBinary }) => {
      clearTimeout(timeout);
      resolve(isBinary ? decodeMessage(frame).collabMessage : null);
    };
    const pending = pendingFrames.shift();
    if (pending) accept(pending);
    else frameWaiters.push(accept);
  });
}

async function readManifest(next) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const frame = await next();
    if (!frame || frame.syncRequest) return frame;
  }
  return null;
}

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

async function setupDatabase(label) {
  const { token, workspaceId } = await registerAndLogin(label);
  const spaceId = await createPublicSpace(token, workspaceId, label);
  const { request, response } = await createGridDatabase(token, workspaceId, spaceId);
  assert.equal(response.status, 200);
  const databaseId = request.database.database_id;
  const containerId = request.container_id;
  const primaryViewId = request.database.view_id;
  const collabRoute = `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`;
  return { token, workspaceId, spaceId, databaseId, containerId, primaryViewId, collabRoute };
}

async function readDatabaseDoc(token, workspaceId, databaseId, collabRoute) {
  const read = await api('GET', collabRoute, undefined, token);
  assert.equal(read.status, 200);
  return openDatabaseDoc(new Uint8Array(read.body.data.doc_state), databaseId);
}

test('Database view creation: a second (Board) view is added with cloned config, correct Folder mapping, and a non-empty default group', async () => {
  const { token, workspaceId, containerId, databaseId, primaryViewId, collabRoute } = await setupDatabase('view-create');

  // Add a filter to the primary view first (ordinary generic Yjs mutation,
  // same mechanism database-collab.test.js already proves for fields) so
  // we can assert it gets CLONED onto the new view when source_view_id
  // points at the primary view.
  {
    const doc = await readDatabaseDoc(token, workspaceId, databaseId, collabRoute);
    const database = doc.getMap('data').get('database');
    const view = database.get('views').get(primaryViewId);
    const beforeSv = Y.encodeStateVector(doc);
    const filter = new Y.Map();
    filter.set('id', id());
    filter.set('field_id', [...database.get('fields').keys()][0]);
    filter.set('condition', 2);
    filter.set('content', 'seed-filter');
    view.get('filters').push([filter]);
    const payload = Y.encodeStateAsUpdate(doc, beforeSv);
    const socket = await connectAckTestSocket(base, workspaceId, token, 6000);
    const nextFrame = ackTestFrameReader(socket);
    try {
      const manifestPromise = nextFrame();
      socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: beforeSv } } }));
      await manifestPromise;
      const ackPromise = nextUpdateFrame(nextFrame);
      socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload, beforeStateVector: beforeSv } } }));
      await ackPromise;
    } finally {
      socket.close();
      doc.destroy();
    }
  }

  const { request, response } = await createAdditionalView(token, workspaceId, {
    databaseId, containerId, sourceViewId: primaryViewId, layout: 1, name: 'Board',
  });
  assert.equal(response.status, 200);
  // AppFlowy-Web's own atomic-creation journal (validateAtomicCreationReceipt,
  // 'database-view' case) requires this exact receipt shape -- discovered via
  // real-browser verification, not from the HTTP contract alone.
  assert.equal(response.body.data.request_id, request.request_id);
  assert.equal(response.body.data.outcome, 'applied');
  assert.equal(response.body.data.result.view_id, request.view.view_id);
  assert.equal(response.body.data.result.database_id, databaseId);
  assert.equal(response.body.data.result.database_restore_id, '00000000-0000-0000-0000-000000000000');
  assert.deepEqual(response.body.data.result.view_ids, [request.view.view_id]);
  assert.equal(response.body.data.result.database_version, null);
  assert.match(response.body.data.result.update_batch_id, /^[0-9a-f-]{36}$/);
  assert.ok(typeof response.body.data.result.database_update_v1 === 'string' && response.body.data.result.database_update_v1.length > 0);

  const doc = await readDatabaseDoc(token, workspaceId, databaseId, collabRoute);
  try {
    const database = doc.getMap('data').get('database');
    const views = database.get('views');
    assert.equal(views.size, 2, 'the original primary view plus the new Board view, nothing lost or duplicated');
    const boardView = views.get(request.view.view_id);
    assert.ok(boardView, 'the new view must exist under its own id');
    assert.equal(boardView.get('layout'), 1, 'DatabaseViewLayout.Board = 1');
    assert.equal(boardView.get('database_id'), databaseId);
    assert.equal(boardView.get('is_inline'), false, 'only the original/primary view is the inline view');
    assert.equal(boardView.get('embedded'), false);

    // Cloned from the primary view (source_view_id), not left empty.
    assert.equal(boardView.get('filters').length, 1, 'filters are cloned from source_view_id');
    assert.equal(boardView.get('filters').get(0).get('content'), 'seed-filter');
    assert.notEqual(boardView.get('filters'), views.get(primaryViewId).get('filters'), 'cloned, not the SAME Y.Array instance shared across two views');

    // Board default grouping: non-empty, with a real field id -- the one
    // confirmed requirement AppFlowy-Web's own opt-in server-interop test
    // imposes on a new Board view's creation recipe.
    const groups = boardView.get('groups');
    assert.ok(groups.length > 0, 'a new Board view must have a non-empty default group, not an empty placeholder');
    const group = groups.get(0);
    assert.ok(database.get('fields').has(group.get('field_id')), "the default group's field_id must be a real field of this Database");
    assert.ok(group.get('groups').length > 0, 'the default group must have at least one group-column');

    // Independence: mutating the new view's filters must not affect the
    // primary view's filters (same Y.Array clone guarantee, the other
    // direction).
    assert.equal(views.get(primaryViewId).get('filters').length, 1, "the primary view's own filters are untouched by cloning");
  } finally {
    doc.destroy();
  }

  // Folder-tree: the new view must be a real child page of the container,
  // with the correct Folder-side ViewLayout mapping (Board=1 -> ViewLayout
  // Board=2, confirmed from AppFlowy-Web's own interop test).
  const folder = await api('GET', `/api/workspace/${workspaceId}/view/${request.view.view_id}?depth=0`, undefined, token);
  assert.equal(folder.status, 200);
  assert.equal(folder.body.data.parent_view_id, containerId);
  assert.equal(folder.body.data.layout, 2, 'ViewLayout.Board = 2 (Folder-side enum)');
  assert.equal(folder.body.data.extra.database_id, databaseId);

  const containerChildren = await api('GET', `/api/workspace/${workspaceId}/view/${containerId}?depth=1`, undefined, token);
  assert.equal(containerChildren.status, 200);
  const childIds = containerChildren.body.data.children.map((c) => c.view_id).sort();
  assert.deepEqual(childIds, [primaryViewId, request.view.view_id].sort(), 'both views must be listed as Folder children of the same container');

  // The new view's own page-view GET must resolve to the SAME shared
  // Database collab object (AppFlowy-Web reads/writes it this way for any
  // view belonging to the database, not only the primary one).
  const pageView = await api('GET', `/api/workspace/${workspaceId}/page-view/${request.view.view_id}`, undefined, token);
  assert.equal(pageView.status, 200);
  const pageDoc = openDatabaseDoc(new Uint8Array(pageView.body.data.data.encoded_collab), databaseId);
  try {
    assert.equal(pageDoc.getMap('data').get('database').get('id'), databaseId);
  } finally {
    pageDoc.destroy();
  }
});

test('Database view creation: with no source_view_id, the new view defaults to the inline view\'s row membership, not empty', async () => {
  const { token, workspaceId, containerId, databaseId, primaryViewId, collabRoute } = await setupDatabase('view-default-source');
  const { request, response } = await createAdditionalView(token, workspaceId, { databaseId, containerId, sourceViewId: null, layout: 4, name: 'List' });
  assert.equal(response.status, 200);

  const doc = await readDatabaseDoc(token, workspaceId, databaseId, collabRoute);
  try {
    const database = doc.getMap('data').get('database');
    const listView = database.get('views').get(request.view.view_id);
    assert.equal(listView.get('layout'), 4, 'DatabaseViewLayout.List = 4');
    const inlineRowOrders = database.get('views').get(primaryViewId).get('row_orders').toArray();
    assert.deepEqual(listView.get('row_orders').toArray(), inlineRowOrders, 'defaults to the inline view\'s row membership when no source_view_id is given');
    // field_orders: every current field, since the frontend never sends
    // field content for this route (confirmed from create-default-view.ts).
    const fieldIds = [...database.get('fields').keys()];
    assert.deepEqual(listView.get('field_orders').toArray().map((o) => o.id), fieldIds);
  } finally {
    doc.destroy();
  }
});

test('Database view creation: idempotent replay (same request_id) and REQUEST_ID_REUSED on a different body', async () => {
  const { token, workspaceId, containerId, databaseId } = await setupDatabase('view-idempotent');
  const request = defaultViewRequest({ databaseId, containerId, layout: 2, name: 'Calendar' });
  const route = `/api/workspace/${workspaceId}/v2/page-view/database-view/default`;

  const first = await api('POST', route, request, token);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.outcome, 'applied');

  const replay = await api('POST', route, request, token);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.outcome, 'already_applied');
  assert.deepEqual(replay.body.data.result, first.body.data.result);

  const different = await api('POST', route, { ...request, view: { ...request.view, name: 'Different name' } }, token);
  assert.equal(different.status, 409);
  assert.equal(different.body.error.code, 'REQUEST_ID_REUSED');
});

test('Database view creation: invalid/unsupported requests are rejected', async () => {
  const { token, workspaceId, containerId, databaseId } = await setupDatabase('view-invalid');
  const route = `/api/workspace/${workspaceId}/v2/page-view/database-view/default`;

  assert.equal((await api('POST', route, defaultViewRequest({ databaseId, containerId }))).status, 401, 'no auth token');

  const formLayout = defaultViewRequest({ databaseId, containerId, layout: 7, name: 'Form builder' });
  assert.equal((await api('POST', route, formLayout, token)).status, 400, 'Form (layout=7) is deliberately out of scope');

  const badSource = defaultViewRequest({ databaseId, containerId, sourceViewId: id(), layout: 1 });
  assert.equal((await api('POST', route, badSource, token)).status, 400, "an unrelated source_view_id must be rejected, not silently ignored");

  const badParent = defaultViewRequest({ databaseId, containerId: id(), layout: 0 });
  assert.equal((await api('POST', route, badParent, token)).status, 400, 'an unknown parent_view_id must be rejected');

  const badDatabase = defaultViewRequest({ databaseId: id(), containerId, layout: 0 });
  assert.equal((await api('POST', route, badDatabase, token)).status, 404, 'an unknown database_id must be rejected');

  const extraField = defaultViewRequest({ databaseId, containerId, layout: 0 });
  extraField.unexpected = true;
  assert.equal((await api('POST', route, extraField, token)).status, 400, 'unsupported top-level fields are rejected, not silently ignored');

  const outsider = await registerAndLogin('view-invalid-outsider');
  assert.equal((await api('POST', route, defaultViewRequest({ databaseId, containerId, layout: 0 }), outsider.token)).status, 403, 'a user outside the workspace must be rejected');

  // Cross-workspace: a real database id, but addressed from a different
  // workspace than the one that owns it.
  const other = await setupDatabase('view-invalid-other-ws');
  const crossWorkspace = await api('POST', `/api/workspace/${other.workspaceId}/v2/page-view/database-view/default`,
    defaultViewRequest({ databaseId, containerId: other.containerId, layout: 0 }), other.token);
  assert.equal(crossWorkspace.status, 404, "a real database id from ANOTHER workspace must not be creatable-into there");
});

test('Database view creation: multi-view independence survives a config change and a restart', async () => {
  const { token, workspaceId, containerId, databaseId, primaryViewId, collabRoute } = await setupDatabase('view-independence');
  const { request: boardRequest } = await createAdditionalView(token, workspaceId, { databaseId, containerId, sourceViewId: primaryViewId, layout: 1, name: 'Board' });
  const boardViewId = boardRequest.view.view_id;

  // Rename only the Board view's Folder entry via the EXISTING generic
  // page-rename route (no Task 72 code involved) -- the primary view's own
  // Folder name must be completely unaffected.
  const renameRoute = `/api/workspace/${workspaceId}/page-view/${boardViewId}/update-name`;
  assert.equal((await api('POST', renameRoute, { name: 'Renamed Board' }, token)).status, 200);
  const primaryFolder = await api('GET', `/api/workspace/${workspaceId}/view/${primaryViewId}?depth=0`, undefined, token);
  assert.equal(primaryFolder.body.data.name, 'Grid', "renaming the Board view's Folder entry must not rename the primary view's");
  const boardFolder = await api('GET', `/api/workspace/${workspaceId}/view/${boardViewId}?depth=0`, undefined, token);
  assert.equal(boardFolder.body.data.name, 'Renamed Board');

  // Change ONLY the Board view's groups via the generic Database WS
  // admission path (ordinary Yjs mutation) -- the primary view's own
  // groups (and row_orders) must stay exactly as cloned.
  {
    const doc = await readDatabaseDoc(token, workspaceId, databaseId, collabRoute);
    const database = doc.getMap('data').get('database');
    const boardView = database.get('views').get(boardViewId);
    const beforeSv = Y.encodeStateVector(doc);
    const newGroup = new Y.Map();
    newGroup.set('id', 'custom-group');
    newGroup.set('field_id', [...database.get('fields').keys()][0]);
    newGroup.set('content', '{"independence":"proof"}');
    boardView.get('groups').delete(0, boardView.get('groups').length);
    boardView.get('groups').push([newGroup]);
    const payload = Y.encodeStateAsUpdate(doc, beforeSv);
    const socket = await connectAckTestSocket(base, workspaceId, token, 6100);
    const nextFrame = ackTestFrameReader(socket);
    try {
      const manifestPromise = nextFrame();
      socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: beforeSv } } }));
      await manifestPromise;
      const ackPromise = nextUpdateFrame(nextFrame);
      socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload, beforeStateVector: beforeSv } } }));
      await ackPromise;
    } finally {
      socket.close();
      doc.destroy();
    }
  }

  const beforeRestart = await readDatabaseDoc(token, workspaceId, databaseId, collabRoute);
  try {
    const database = beforeRestart.getMap('data').get('database');
    assert.equal(database.get('views').get(boardViewId).get('groups').get(0).get('content'), '{"independence":"proof"}');
    assert.equal(database.get('views').get(primaryViewId).get('groups').length, 0, "the primary (Grid) view's own groups are untouched by the Board view's config change -- it was never grouped and stays that way");
    assert.equal(database.get('views').size, 2);
  } finally {
    beforeRestart.destroy();
  }

  // Restart: reopen the SAME on-disk JSON file in a fresh store (same
  // convention as database-collab.test.js's restart test) and confirm both
  // views, with their independent config, survive.
  const reopened = await openStore(dataFile, {});
  try {
    const row = reopened.state.databaseCollabDocuments[databaseId];
    assert.ok(row, 'the Database collab document must survive a restart');
    const doc = openDatabaseDoc(new Uint8Array(row.document_state), databaseId);
    try {
      const database = doc.getMap('data').get('database');
      const views = database.get('views');
      assert.equal(views.size, 2, 'both views survive a restart');
      assert.equal(views.get(boardViewId).get('groups').get(0).get('content'), '{"independence":"proof"}', "the Board view's config change survives a restart");
      assert.equal(views.get(boardViewId).get('layout'), 1);
      assert.equal(views.get(primaryViewId).get('layout'), 0, "the primary view's layout is unaffected by the Board view's changes");
    } finally {
      doc.destroy();
    }
  } finally {
    // openStore for JSON mode has no explicit close(); nothing to release.
  }
});

test('Database view: a live config change on a NEWLY CREATED view fans out to an already-connected peer (generalizes Task 66/71 beyond field edits)', async () => {
  const owner = await registerAndLogin('view-fanout-owner');
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'view-fanout-owner');
  const { request: dbRequest, response: dbResponse } = await createGridDatabase(owner.token, owner.workspaceId, spaceId);
  assert.equal(dbResponse.status, 200);
  const databaseId = dbRequest.database.database_id;
  const containerId = dbRequest.container_id;
  const primaryViewId = dbRequest.database.view_id;
  const collabRoute = `/api/workspace/v1/${owner.workspaceId}/collab/${databaseId}?collab_type=1`;

  const peer = await registerAndLogin('view-fanout-peer');
  await addMember(owner.token, owner.workspaceId, peer.email);

  const { request: viewRequest, response: viewResponse } = await createAdditionalView(owner.token, owner.workspaceId, {
    databaseId, containerId, sourceViewId: primaryViewId, layout: 1, name: 'Board',
  });
  assert.equal(viewResponse.status, 200);
  const boardViewId = viewRequest.view.view_id;

  // Both the owner and the peer open a live WebSocket watching the SAME
  // Database object (the peer resyncs after the HTTP-originated view
  // creation above, exactly like AppFlowy-Web's own reconnection/refresh
  // path -- HTTP atomic-creation routes in this backend do not themselves
  // push a live WS fan-out frame, the same pre-existing characteristic
  // already true of row creation (Task 62); only WS-originated updates
  // fan out live, proven below).
  const initial = await api('GET', collabRoute, undefined, owner.token);
  const ownerSocket = await connectAckTestSocket(base, owner.workspaceId, owner.token, 6200);
  const peerSocket = await connectAckTestSocket(base, owner.workspaceId, peer.token, 6201);
  const ownerNext = ackTestFrameReader(ownerSocket);
  const peerNext = peerFrameReaderOrNull(peerSocket);
  try {
    const client = new Y.Doc({ guid: databaseId });
    Y.applyUpdate(client, new Uint8Array(initial.body.data.doc_state));
    const stateVector = Y.encodeStateVector(client);

    const ownerManifestP = readManifest(ownerNext);
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector } } }));
    const ownerManifest = await ownerManifestP;
    assert.ok(ownerManifest && ownerManifest.syncRequest, 'owner must receive a manifest frame');
    const peerManifestP = readManifest(peerNext);
    peerSocket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector } } }));
    const peerManifest = await peerManifestP;
    assert.ok(peerManifest && peerManifest.syncRequest, 'peer must be able to sync the Database object (workspace membership, Task 67)');

    // Owner renames the NEWLY CREATED Board view (not the primary view,
    // and not a field) via an ordinary Yjs mutation -- the same generic
    // Database WS admission path proven for fields in
    // database-collab.test.js.
    const database = client.getMap('data').get('database');
    const boardView = database.get('views').get(boardViewId);
    boardView.set('name', 'Live-renamed Board');
    const payload = Y.encodeStateAsUpdate(client, stateVector);

    const peerLiveWatch = peerNext(3000);
    const ownerAckPromise = nextUpdateFrame(ownerNext);
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload, beforeStateVector: stateVector } } }));
    const ownerAck = await ownerAckPromise;
    assert.ok(ownerAck.update);

    const peerLive = await peerLiveWatch;
    assert.ok(peerLive, 'an already-connected peer must receive the view-config change live, without reconnecting or reloading');
    assert.ok(peerLive.update, 'the live delivery must be an `update` frame');
    assert.equal(peerLive.objectId, databaseId);
    assert.equal(peerLive.collabType, 1);
    assert.deepEqual(peerLive.update.messageId, ownerAck.update.messageId, 'peer must receive the exact same server-assigned messageId as the sender\'s own ack');

    const peerDoc = new Y.Doc({ guid: databaseId });
    try {
      Y.applyUpdate(peerDoc, new Uint8Array(initial.body.data.doc_state));
      Y.applyUpdate(peerDoc, peerLive.update.payload);
      assert.equal(peerDoc.getMap('data').get('database').get('views').get(boardViewId).get('name'), 'Live-renamed Board', "peer's own Yjs doc must converge with the owner's live view-rename after applying the fan-out frame");
    } finally {
      peerDoc.destroy();
    }
  } finally {
    ownerSocket.close();
    peerSocket.close();
  }
});
