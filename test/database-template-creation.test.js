// Notion-style database templates: GET /api/template-catalog/database and
// POST /api/workspace/{id}/v2/page-view/database/from-template. A template is
// instantiated as a brand-new, fully populated database (fields, views and
// sample rows) inside the caller's own workspace.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-db-template-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function setup(label) {
  const email = `${label}@example.test`;
  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  const spaceId = crypto.randomUUID();
  const created = await api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: 'Space', view_id: spaceId,
    permission: {
      visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
      invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
      security: { disable_guests: false, disable_public_links: false, disable_export: false },
    },
  }, token);
  assert.equal(created.status, 200);
  return { token, workspaceId, spaceId };
}

const request = (spaceId, overrides = {}) => ({
  schema_version: 'v1', request_id: crypto.randomUUID(), template_id: 'tasks', parent_view_id: spaceId, position: { kind: 'end' }, ...overrides,
});
const createUrl = (workspaceId) => `/api/workspace/${workspaceId}/v2/page-view/database/from-template`;

test('catalog lists the library templates (the four built-in ones and the imported AppFlowy ones) and requires authentication', async () => {
  const { token } = await setup('catalog');
  assert.equal((await api('GET', '/api/template-catalog/database')).status, 401);
  const response = await api('GET', '/api/template-catalog/database', undefined, token);
  assert.equal(response.status, 200);
  const byId = Object.fromEntries(response.body.data.templates.map((t) => [t.template_id, t]));
  for (const id of ['epics', 'opportunities', 'projects', 'tasks']) assert.ok(byId[id], `${id} is in the catalog`);
  assert.equal(byId.tasks.name, 'Tasks');
  assert.equal(byId.tasks.field_count, 11);
  assert.equal(byId.tasks.row_count, 28);
  assert.equal(byId.opportunities.view_count, 2);
});

test('creating from a template yields a populated database visible in the catalog', async () => {
  const { token, workspaceId, spaceId } = await setup('create');
  const body = request(spaceId);
  const response = await api('POST', createUrl(workspaceId), body, token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { view_id: containerId, database_id: databaseId, view_ids: viewIds, row_ids: rowIds } = response.body.data.result;
  assert.equal(viewIds.length, 1);
  assert.equal(rowIds.length, 28);

  const store = running.app.store;
  const container = store.state.pages[containerId];
  assert.equal(container.title, 'Tasks');
  assert.equal(container.parent_view_id, spaceId);
  assert.deepEqual(container.extra, { is_database_container: true, database_id: databaseId });
  assert.equal(store.state.pages[viewIds[0]].parent_view_id, containerId);

  const stored = store.state.databaseCollabDocuments[databaseId];
  assert.equal(stored.workspace_id, workspaceId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(stored.document_state));
  const database = doc.getMap('data').get('database');
  assert.equal(database.get('fields').size, 11);
  const view = database.get('views').get(viewIds[0]);
  const orderedRows = view.get('row_orders').toArray().map((o) => o.id);
  assert.equal(orderedRows.length, 28);
  assert.deepEqual([...orderedRows].sort(), [...rowIds].sort());
  for (const rowId of rowIds) {
    const row = store.state.databaseRowCollabDocuments[rowId];
    assert.equal(row.workspace_id, workspaceId);
    assert.equal(row.database_id, databaseId);
  }

  const catalog = await api('GET', `/api/workspace/${workspaceId}/database`, undefined, token);
  assert.equal(catalog.body.data.databases.length, 1);
  assert.equal(catalog.body.data.databases[0].database_id, databaseId);
});

test('a database container page reports permissions so sidebar actions (delete, rename) are offered', async () => {
  const { token, workspaceId, spaceId } = await setup('container-permission');
  const created = await api('POST', createUrl(workspaceId), request(spaceId), token);
  const { view_id: containerId, view_ids: viewIds } = created.body.data.result;

  const container = await api('GET', `/api/workspace/${workspaceId}/collab/${containerId}/permission?collab_type=0`, undefined, token);
  assert.equal(container.status, 200);
  assert.equal(container.body.data.can_read, true);
  assert.equal(container.body.data.can_share, true);
  assert.equal(container.body.data.governing_view_id, spaceId);

  const missing = await api('GET', `/api/workspace/${workspaceId}/collab/${crypto.randomUUID()}/permission?collab_type=0`, undefined, token);
  assert.equal(missing.status, 404);

  const trashed = await api('POST', `/api/workspace/${workspaceId}/page-view/${containerId}/move-to-trash`, undefined, token);
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  assert.ok(viewIds.length > 0);
});

test('a multi-view template keeps its view order and distinct ids per instantiation', async () => {
  const { token, workspaceId, spaceId } = await setup('multi');
  const first = await api('POST', createUrl(workspaceId), request(spaceId, { template_id: 'opportunities' }), token);
  const second = await api('POST', createUrl(workspaceId), request(spaceId, { template_id: 'opportunities', name: 'Pipeline' }), token);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.data.result.view_ids.length, 2);
  assert.equal(second.body.data.result.view_ids.length, 2);
  assert.notEqual(first.body.data.result.database_id, second.body.data.result.database_id);
  assert.equal(running.app.store.state.pages[second.body.data.result.view_id].title, 'Pipeline');
  const [gridId, boardId] = first.body.data.result.view_ids;
  const pages = running.app.store.state.pages;
  assert.ok(pages[gridId].created_at < pages[boardId].created_at);
});

test('replaying the same request_id is idempotent and returns the same ids', async () => {
  const { token, workspaceId, spaceId } = await setup('replay');
  const body = request(spaceId);
  const first = await api('POST', createUrl(workspaceId), body, token);
  const replay = await api('POST', createUrl(workspaceId), body, token);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.data.result.row_ids, first.body.data.result.row_ids);
  assert.equal(replay.body.data.result.database_id, first.body.data.result.database_id);
  const catalog = await api('GET', `/api/workspace/${workspaceId}/database`, undefined, token);
  assert.equal(catalog.body.data.databases.length, 1);

  const reused = await api('POST', createUrl(workspaceId), { ...body, template_id: 'epics' }, token);
  assert.equal(reused.status, 409);
});

test('invalid requests are rejected', async () => {
  const { token, workspaceId, spaceId } = await setup('invalid');
  assert.equal((await api('POST', createUrl(workspaceId), request(spaceId, { template_id: 'nope' }), token)).status, 404);
  assert.equal((await api('POST', createUrl(workspaceId), request(spaceId, { extra_field: 1 }), token)).status, 400);
  assert.equal((await api('POST', createUrl(workspaceId), request(spaceId, { schema_version: 'v2' }), token)).status, 400);
  assert.equal((await api('POST', createUrl(workspaceId), request(crypto.randomUUID()), token)).status, 403);
  assert.equal((await api('POST', createUrl(workspaceId), request(spaceId), undefined)).status, 401);
});

test('another workspace cannot instantiate into this workspace', async () => {
  const owner = await setup('owner');
  const outsider = await setup('outsider');
  const before = Object.keys(running.app.store.state.databaseCollabDocuments).length;
  const response = await api('POST', createUrl(owner.workspaceId), request(owner.spaceId), outsider.token);
  assert.equal(response.status, 403);
  assert.equal(Object.keys(running.app.store.state.databaseCollabDocuments).length, before);
});

// Regression: adding a view leaves tombstones in the Database collab. The web
// client answers every server manifest with encodeStateAsUpdate(doc, serverVector),
// which always carries the whole delete set, so the reply is never "empty".
// The server used to answer that duplicate reply with another manifest, which the
// client answered again, forever -- and a fresh load of the database never settled.
test('a Database with tombstones settles instead of looping manifest/update frames', async () => {
  const { default: WebSocket } = await import('ws');
  const { encodeMessage, decodeMessage } = await import('../collab-protocol.js');
  const { token, workspaceId, spaceId } = await setup('tombstone-loop');
  const created = await api('POST', createUrl(workspaceId), request(spaceId, { template_id: 'opportunities' }), token);
  const { database_id: databaseId } = created.body.data.result;

  // Give the stored Database collab a delete set, exactly like a view creation or edit does.
  const store = running.app.store;
  const record = store.state.databaseCollabDocuments[databaseId];
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(record.document_state));
  const views = doc.getMap('data').get('database').get('views');
  const firstViewId = [...views.keys()][0];
  views.get(firstViewId).set('name', 'Renamed');
  views.get(firstViewId).delete('layout_settings');
  record.document_state = Array.from(Y.encodeStateAsUpdate(doc));
  record.state_vector = Array.from(Y.encodeStateVector(doc));

  const client = new Y.Doc();
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/v2/${workspaceId}/?clientId=77&deviceId=tombstone&token=${token}&cv=0.10.0&cp=web`);
  let frames = 0;
  socket.on('message', (data) => {
    const message = decodeMessage(new Uint8Array(data)).collabMessage;
    if (!message) return;
    frames += 1;
    if (message.update) Y.applyUpdate(client, message.update.payload);
    else if (message.syncRequest) {
      const serverVector = message.syncRequest.stateVector;
      socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: {
        flags: 0, payload: Y.encodeStateAsUpdate(client, serverVector), beforeStateVector: serverVector, version: message.syncRequest.version,
      } } }), { binary: true });
    }
  });
  await new Promise((resolve) => socket.on('open', resolve));
  socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: {
    lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(client),
  } } }), { binary: true });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  socket.close();
  assert.ok(frames > 0 && frames <= 8, `expected the exchange to settle, saw ${frames} frames in 1.5s`);
});

// The web client builds a database's view tabs from its container's children,
// and the sidebar from the workspace outline. Both used to drop everything but
// the first level (outline) or the on-path child (navigation).
test('outline nests pages under spaces and navigation keeps every view of a database container', async () => {
  const { token, workspaceId, spaceId } = await setup('tree-shape');
  const created = await api('POST', createUrl(workspaceId), request(spaceId, { template_id: 'opportunities' }), token);
  const { view_id: containerId, view_ids: viewIds } = created.body.data.result;

  const outline = await api('GET', `/api/workspace/${workspaceId}/view/${workspaceId}?depth=6`, undefined, token);
  const space = outline.body.data.children.find((node) => node.view_id === spaceId);
  const container = space.children.find((node) => node.view_id === containerId);
  assert.equal(container.has_children, true, 'a database container reports its views');
  assert.deepEqual(container.children.map((node) => node.view_id), viewIds);

  const shallow = await api('GET', `/api/workspace/${workspaceId}/view/${workspaceId}?depth=2`, undefined, token);
  const shallowContainer = shallow.body.data.children.find((node) => node.view_id === spaceId).children.find((node) => node.view_id === containerId);
  assert.deepEqual(shallowContainer.children, [], 'depth bounds how far children are inlined');
  assert.equal(shallowContainer.has_children, true);

  const navigation = await api('GET', `/api/workspace/${workspaceId}/view/${viewIds[0]}/navigation?depth=0`, undefined, token);
  const navContainer = navigation.body.data.children[0].children[0];
  assert.equal(navContainer.view_id, containerId);
  assert.deepEqual(navContainer.children.map((node) => node.view_id), viewIds, 'navigation lists every view of the container');
});
