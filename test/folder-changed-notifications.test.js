// Clients rebuild their sidebar / database view tabs only when told the Folder tree changed
// (FolderChanged over the realtime socket). Before this, only renames sent it, so a page,
// database or database view created in one tab (or by an agent) did not appear in other tabs,
// and showed up as an unselectable tab in the creating tab, until a manual refresh.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { startServer } from '../server.js';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';
import { rowDocumentIdFromRowId } from '../page-document.js';
import { createFolderNotifier } from '../folder-notifier.js';

let dir, running, base;
const uuid = () => crypto.randomUUID();
const settle = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));
const PUBLIC = { visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null, invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false, security: { disable_guests: false, disable_public_links: false, disable_export: false } };

async function api(method, route, payload, token) {
  const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'folder-changed-'));
  running = await startServer({ host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'k', environment: 'test', folderChangedDelayMs: 120 });
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
  const doc = uuid();

  assert.equal((await api('POST', `/api/workspace/${ws}/v2/page-view/document/default`, { schema_version: 'v1', request_id: uuid(), parent_view_id: space, name: 'Seed', position: { kind: 'end' }, view_id: doc }, token)).status, 200);
  return { token, ws, space, doc };
}

// A socket only receives pushes once it finished a SyncRequest.
function connect(who, clientId) {
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token: who.token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/v2/${who.ws}/?${query}`);
  const state = { socket, folderChanged: 0, other: [] };

  socket.on('message', (frame, isBinary) => {
    if (!isBinary) return;
    const message = decodeMessage(frame);

    if (message.notification?.folderChanged) state.folderChanged += 1;
    else if (message.notification) state.other.push(Object.keys(message.notification).find((key) => message.notification[key]));
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => {
      socket.send(encodeMessage({ collabMessage: { objectId: who.doc, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }), { binary: true });
      setTimeout(() => resolve(state), 300);
    });
  });
}

// Runs `action`, waits for the coalescing window, and returns how many FolderChanged frames arrived.
async function framesAfter(state, action) {
  const before = state.folderChanged;

  await action();
  await settle();
  return state.folderChanged - before;
}

test('every page-tree mutation tells connected clients, other workspaces hear nothing, bursts coalesce', async () => {
  const owner = await account('folder-owner');
  const outsider = await account('folder-outsider');
  await settle(); // let the events from creating the seed pages flush before any socket connects
  const a = await connect(owner, 1);
  const b = await connect(owner, 2);
  const out = await connect(outsider, 3);

  try {
    const route = (suffix) => `/api/workspace/${owner.ws}${suffix}`;
    const ok = (response, message) => assert.ok(response.status >= 200 && response.status < 300, `${message}: ${response.status} ${JSON.stringify(response.body)}`);

    // creation: document, database (template), database view, document tree (template), AI chat, space
    const newDoc = uuid();
    assert.equal(await framesAfter(a, async () => ok(await api('POST', route('/v2/page-view/document/default'), { schema_version: 'v1', request_id: uuid(), parent_view_id: owner.space, name: 'Created', position: { kind: 'end' }, view_id: newDoc }, owner.token), 'document')), 1, 'document created');

    let database;
    assert.equal(await framesAfter(a, async () => { const r = await api('POST', route('/v2/page-view/database/from-template'), { schema_version: 'v1', request_id: uuid(), template_id: 'tasks', parent_view_id: owner.space, position: { kind: 'end' } }, owner.token); ok(r, 'database'); database = r.body.data.result; }), 1, 'database created from a template (container, view and rows are one change)');

    assert.equal(await framesAfter(a, async () => ok(await api('POST', route('/v2/page-view/database-view/default'), { schema_version: 'v1', request_id: uuid(), database_restore_id: '00000000-0000-0000-0000-000000000000', view: { database_id: database.database_id, view_id: uuid(), parent_view_id: database.view_id, source_view_id: null, layout: 1, name: 'Board', embedded: false, responses_view_id: null, timezone_id: null }, position: { kind: 'end' }, icon: null, extra: null }, owner.token), 'database view')), 1, 'database view created');

    let tree;
    assert.equal(await framesAfter(a, async () => { const r = await api('POST', route('/v2/page-view/document/from-template'), { schema_version: 'v1', request_id: uuid(), template_id: 'startup-company-home', parent_view_id: owner.space, position: { kind: 'end' } }, owner.token); ok(r, 'document template'); tree = r.body.data.result; }), 1, 'a whole document tree is one event, not one per page');
    assert.ok(tree.view_ids.length > 3);

    assert.equal(await framesAfter(a, async () => ok(await api('POST', route('/page-view'), { parent_view_id: owner.space, layout: 4, name: 'Chat' }, owner.token), 'ai chat page')), 1, 'AI chat page created');
    assert.equal(await framesAfter(a, async () => ok(await api('POST', route('/spaces'), { name: 'Second space', view_id: uuid(), permission: PUBLIC }, owner.token), 'space')), 1, 'space created');

    // rename (both routes), trash, restore, permanent delete
    assert.equal(await framesAfter(a, async () => ok(await api('POST', route(`/page-view/${newDoc}/update-name`), { name: 'Renamed' }, owner.token), 'update-name')), 1, 'rename');
    assert.equal(await framesAfter(a, async () => ok(await api('PATCH', route(`/page-view/${newDoc}`), { name: 'Renamed again' }, owner.token), 'patch')), 1, 'metadata change');
    assert.equal(await framesAfter(a, async () => ok(await api('POST', route(`/page-view/${newDoc}/move-to-trash`), undefined, owner.token), 'trash')), 1, 'moved to trash');
    assert.equal(await framesAfter(a, async () => ok(await api('POST', route(`/page-view/${newDoc}/restore-from-trash`), undefined, owner.token), 'restore')), 1, 'restored');
    ok(await api('POST', route(`/page-view/${newDoc}/move-to-trash`), undefined, owner.token), 'trash again');
    await settle();
    assert.equal(await framesAfter(a, async () => ok(await api('DELETE', route(`/trash/${newDoc}`), undefined, owner.token), 'delete')), 1, 'permanently deleted');

    // both tabs of the same workspace hear every event, the outsider none
    assert.equal(b.folderChanged, a.folderChanged, 'a second connection gets the same events');
    assert.ok(a.folderChanged >= 10);
    assert.equal(out.folderChanged, 0, 'another workspace receives nothing');

    // a burst of quick changes is one event
    const burstDocs = [];
    for (let i = 0; i < 5; i += 1) burstDocs.push(uuid());
    assert.equal(await framesAfter(a, () => Promise.all(burstDocs.map((id, i) => api('POST', route('/v2/page-view/document/default'), { schema_version: 'v1', request_id: uuid(), parent_view_id: owner.space, name: `Burst ${i}`, position: { kind: 'end' }, view_id: id }, owner.token)))), 1, 'five creations inside the window coalesce into one event');

    // things that are NOT tree changes stay silent: row detail documents, content edits, comments
    const hiddenRowDocument = rowDocumentIdFromRowId(database.row_ids[0]);
    assert.equal(await framesAfter(a, async () => ok(await api('POST', route('/orphaned-view'), { document_id: hiddenRowDocument, row_document_source: { database_id: database.database_id, database_view_id: database.view_ids[0], row_id: database.row_ids[0] } }, owner.token), 'row document')), 0, 'a hidden row-detail document is not a sidebar change');
    assert.equal(await framesAfter(a, async () => ok(await api('POST', route(`/document/${owner.doc}/inline-comment/v2`), { content: 'hello', mentioned_user_uuids: [] }, owner.token), 'comment')), 0, 'comments do not touch the folder tree');
    assert.equal(await framesAfter(a, async () => a.socket.send(encodeMessage({ collabMessage: { objectId: owner.doc, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }), { binary: true })), 0, 'syncing a document is not a tree change');
  } finally {
    for (const state of [a, b, out]) state.socket.close();
  }
});

test('the notifier coalesces per workspace, skips hidden row documents and survives a failing sender', async () => {
  const store = {
    getPage: async (id) => (id === 'hidden' ? { id, parent_view_id: null, extra: { row_document: { source: {} } } } : { id, parent_view_id: 'space', extra: null }),
    createPage: async () => ({}),
    updatePageTitle: async () => true,
    setPageTrashed: async () => ({}),
  };
  const sent = [];
  const errors = [];
  const notifier = createFolderNotifier(store, { send: (ws) => { sent.push(ws); if (ws === 'boom') throw new Error('peer failed'); }, delayMs: 20, onError: (error) => errors.push(error.message) });

  notifier.attach();
  await store.createPage({ id: 'p1', workspace_id: 'w1', parent_view_id: 'space' });
  await store.createPage({ id: 'p2', workspace_id: 'w1', parent_view_id: 'space' });
  await store.createPage({ id: 'p3', workspace_id: 'w2', parent_view_id: 'space' });
  await store.createPage({ id: 'hidden', workspace_id: 'w3', parent_view_id: null, extra: { row_document: { source: {} } } });
  await store.updatePageTitle('hidden', 'w3', 'x');
  await store.updatePageTitle('p1', 'w1', 'x');
  assert.equal(notifier.pendingCount(), 2, 'one pending event per affected workspace, none for the hidden row document');
  await settle(80);
  assert.deepEqual([...sent].sort(), ['w1', 'w2']);

  notifier.notify('boom');
  await settle(80);
  assert.deepEqual(errors, ['peer failed'], 'a throwing sender is reported, not propagated');
  notifier.notify('w9');
  notifier.flush();
  assert.equal(sent.at(-1), 'w9', 'flush sends immediately');
  assert.equal(notifier.pendingCount(), 0);
});
