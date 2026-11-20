// A new database view or card is created on the server inside the Database document. The creating
// tab merges the HTTP receipt, but every OTHER open tab must be pushed the same Yjs update or it
// shows the old view list / row list (and the new view as an unusable tab) until a refresh.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { startServer } from '../server.js';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';

let dir, running, base;
const uuid = () => crypto.randomUUID();
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));
const PUBLIC = { visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null, invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false, security: { disable_guests: false, disable_public_links: false, disable_export: false } };
const ORIGINAL = '00000000-0000-0000-0000-000000000000';

async function api(method, route, payload, token) {
  const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'db-fanout-'));
  running = await startServer({ host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'k', environment: 'test', folderChangedDelayMs: 20 });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  await new Promise((resolve) => { running.server.closeAllConnections?.(); running.server.close(resolve); });
  await rm(dir, { recursive: true, force: true });
});

async function account(label) {
  const email = `${label}@example.test`;

  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
  const ws = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  const space = uuid();

  assert.equal((await api('POST', `/api/workspace/${ws}/spaces`, { name: 'Space', view_id: space, permission: PUBLIC }, token)).status, 200);
  return { token, ws, space };
}

// Subscribes to a Database document like a browser tab: SyncRequest, merge what comes back, keep applying pushes.
function subscribe(who, databaseId, clientId) {
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token: who.token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/v2/${who.ws}/?${query}`);
  const doc = new Y.Doc({ guid: databaseId });
  const state = { socket, doc, updates: 0 };

  socket.on('message', (frame, isBinary) => {
    if (!isBinary) return;
    const message = decodeMessage(frame).collabMessage;

    if (message?.objectId === databaseId && message.update) { Y.applyUpdate(doc, message.update.payload); state.updates += 1; }
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => {
      socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(doc) } } }), { binary: true });
      setTimeout(() => { state.updates = 0; resolve(state); }, 350);
    });
  });
}

const database = (state) => state.doc.getMap('data').get('database');
const viewIds = (state) => [...database(state).get('views').keys()];
const primaryRowOrders = (state) => [...database(state).get('views').values()].map((view) => view.get('row_orders').toArray().map((order) => order.id));

test('other open tabs receive a new database view and a new card as live Yjs updates; other databases and workspaces do not', async () => {
  const owner = await account('db-fanout-owner');
  const stranger = await account('db-fanout-stranger');
  const route = (suffix) => `/api/workspace/${owner.ws}${suffix}`;
  const created = await api('POST', route('/v2/page-view/database/from-template'), { schema_version: 'v1', request_id: uuid(), template_id: 'tasks', parent_view_id: owner.space, position: { kind: 'end' } }, owner.token);
  const db = created.body.data.result;
  const other = await api('POST', route('/v2/page-view/database/from-template'), { schema_version: 'v1', request_id: uuid(), template_id: 'projects', parent_view_id: owner.space, position: { kind: 'end' } }, owner.token);
  const otherDb = other.body.data.result;
  const tabA = await subscribe(owner, db.database_id, 11);
  const tabB = await subscribe(owner, db.database_id, 12);
  const otherDatabaseTab = await subscribe(owner, otherDb.database_id, 13);
  const outsiderTab = await subscribe({ ...stranger, ws: stranger.ws }, db.database_id, 14).catch(() => null);

  try {
    assert.equal(viewIds(tabB).length, 1, 'the second tab starts with the template view');
    const rowsBefore = primaryRowOrders(tabB)[0].length;
    const newViewId = uuid();
    const viewRequest = { schema_version: 'v1', request_id: uuid(), database_restore_id: ORIGINAL, view: { database_id: db.database_id, view_id: newViewId, parent_view_id: db.view_id, source_view_id: null, layout: 1, name: 'Board', embedded: false, responses_view_id: null, timezone_id: null }, position: { kind: 'end' }, icon: null, extra: null };

    assert.equal((await api('POST', route('/v2/page-view/database-view/default'), viewRequest, owner.token)).status, 200);
    await settle();
    for (const tab of [tabA, tabB]) assert.ok(viewIds(tab).includes(newViewId), 'every subscribed tab now has the new view in its Database document');
    assert.equal(otherDatabaseTab.updates, 0, 'another database hears nothing');

    // replaying the same request is not a new change
    const before = tabB.updates;

    assert.equal((await api('POST', route('/v2/page-view/database-view/default'), viewRequest, owner.token)).status, 200);
    await settle();
    assert.equal(tabB.updates, before, 'a replayed creation pushes nothing');

    // a new card (what the web's "New row" posts) appears in the other tab's row order for the target view
    const rowId = uuid();
    const rowRequest = { schema_version: 'v1', request_id: uuid(), row_id: rowId, database_restore_id: ORIGINAL, source_view_id: db.view_ids[0], cells: {}, height: 36, visibility: true, presentation: {}, position: { kind: 'end' } };

    assert.equal((await api('POST', route(`/v2/database/${db.database_id}/row/default`), rowRequest, owner.token)).status, 200);
    await settle();
    const rowsAfter = [...database(tabB).get('views').get(db.view_ids[0]).get('row_orders').toArray()].map((order) => order.id);

    assert.equal(rowsAfter.length, rowsBefore + 1);
    assert.ok(rowsAfter.includes(rowId), 'the other tab sees the new card');
    assert.equal(otherDatabaseTab.updates, 0, 'another database still hears nothing');
    if (outsiderTab) assert.equal(outsiderTab.updates, 0, 'a different workspace never receives it');
  } finally {
    for (const tab of [tabA, tabB, otherDatabaseTab, outsiderTab]) tab?.socket.close();
  }
});
