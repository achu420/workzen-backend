// Pages nested under pages (sub-pages). Creation under a page used to be refused, and the three places that authorise
// a page (permission probe, HTTP full-sync batch, Document WebSocket) only understood a page whose direct parent is
// a Space, so a sub-page could be created but never opened. Authorisation now follows the chain up to the Space.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';
import { account, createTemplateDatabase, id, startCardsEnv } from './helpers/cards-env.js';

let env;

before(async () => { env = await startCardsEnv(); });
after(async () => { await env.stop(); });

const documentUrl = (acct) => `/api/workspace/${acct.workspaceId}/v2/page-view/document/default`;

async function createDocument(acct, parentId, name) {
  const viewId = id();
  const response = await env.api('POST', documentUrl(acct), { schema_version: 'v1', request_id: id(), parent_view_id: parentId, name, position: { kind: 'end' }, view_id: viewId }, acct.token);

  return { viewId, response };
}

function connect(acct) {
  const query = new URLSearchParams({ clientId: '9', deviceId: '00000000-0000-4000-8000-000000000009', token: acct.token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${env.base.replace(/^http/, 'ws')}/ws/v2/${acct.workspaceId}/?${query}`);
  const frames = [];
  const waiters = [];
  const closed = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: String(reason) })));

  socket.on('message', (frame) => {
    const message = decodeMessage(frame).collabMessage;
    const waiter = waiters.shift();

    if (waiter) waiter(message);
    else frames.push(message);
  });
  const open = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const next = () => new Promise((resolve, reject) => {
    if (frames.length) return resolve(frames.shift());
    const timer = setTimeout(() => reject(new Error('no frame in 3s')), 3000);

    return waiters.push((message) => { clearTimeout(timer); resolve(message); });
  });

  return { socket, open, next, closed };
}

test('sub-pages can be created at any depth, and are listed in the tree under their parent', async () => {
  const acct = await account(env, 'nested-create');
  const parent = await createDocument(acct, acct.spaceId, 'Parent');
  const child = await createDocument(acct, parent.viewId, 'Child');
  const grandchild = await createDocument(acct, child.viewId, 'Grandchild');

  for (const created of [parent, child, grandchild]) assert.equal(created.response.status, 200, JSON.stringify(created.response.body));
  const tree = (await env.api('GET', `/api/workspace/${acct.workspaceId}/view/${acct.spaceId}?depth=3`, undefined, acct.token)).body.data;

  assert.deepEqual(tree.children.map((page) => page.name), ['Parent']);
  assert.deepEqual(tree.children[0].children.map((page) => page.name), ['Child']);
  assert.deepEqual(tree.children[0].children[0].children.map((page) => page.name), ['Grandchild']);
});

test('creation is refused under things that cannot hold pages: trashed pages, databases, unknown ids, other workspaces', async () => {
  const acct = await account(env, 'nested-refuse');
  const other = await account(env, 'nested-refuse-other');
  const parent = await createDocument(acct, acct.spaceId, 'Parent');
  const db = await createTemplateDatabase(env, acct, 'tasks');
  const foreign = await createDocument(other, other.spaceId, 'Foreign');

  await env.api('POST', `/api/workspace/${acct.workspaceId}/page-view/${parent.viewId}/move-to-trash`, {}, acct.token);
  for (const [label, parentId] of [['trashed page', parent.viewId], ['database container', db.containerId], ['unknown id', id()], ["another workspace's page", foreign.viewId]]) {
    const refused = await createDocument(acct, parentId, `under ${label}`);

    assert.equal(refused.response.status, 403, label);
    assert.equal(refused.response.body.error.code, 'SPACE_WRITE_FORBIDDEN', label);
  }
});

test('a sub-page is authorised through its Space: permission probe, collab read, and the realtime socket', async () => {
  const acct = await account(env, 'nested-authz');
  const stranger = await account(env, 'nested-authz-stranger');
  const parent = await createDocument(acct, acct.spaceId, 'Parent');
  const child = await createDocument(acct, parent.viewId, 'Child');
  const grandchild = await createDocument(acct, child.viewId, 'Grandchild');

  for (const page of [parent, child, grandchild]) {
    const probe = await env.api('GET', `/api/workspace/${acct.workspaceId}/collab/${page.viewId}/permission?collab_type=0`, undefined, acct.token);

    assert.equal(probe.status, 200, JSON.stringify(probe.body));
    assert.equal(probe.body.data.governing_view_id, acct.spaceId);
    assert.equal(probe.body.data.can_write, true);
  }
  assert.equal((await env.api('GET', `/api/workspace/${acct.workspaceId}/collab/${grandchild.viewId}/permission?collab_type=0`, undefined, stranger.token)).status, 403);
  assert.equal((await env.api('GET', `/api/workspace/${stranger.workspaceId}/collab/${grandchild.viewId}/permission?collab_type=0`, undefined, stranger.token)).status, 404, "another workspace cannot even see that it exists");
  const read = await env.api('GET', `/api/workspace/v1/${acct.workspaceId}/collab/${grandchild.viewId}?collab_type=0`, undefined, acct.token);

  assert.equal(read.status, 200, JSON.stringify(read.body));

  // Realtime: sync, edit, and read the edit back from storage.
  const client = new Y.Doc({ guid: grandchild.viewId });

  Y.applyUpdate(client, new Uint8Array(read.body.data.doc_state));
  const conn = connect(acct);

  await conn.open;
  conn.socket.send(encodeMessage({ collabMessage: { objectId: grandchild.viewId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(client) } } }));
  assert.ok((await conn.next()).syncRequest, 'the socket admitted the sub-page and answered the sync request');
  const texts = client.getMap('data').get('document').get('meta').get('text_map');
  const text = [...texts.values()].find((value) => value instanceof Y.Text);
  const marker = `nested-${id()}`;
  const before = Y.encodeStateVector(client);

  text.insert(text.length, marker);
  conn.socket.send(encodeMessage({ collabMessage: { objectId: grandchild.viewId, collabType: 0, update: { flags: 0, payload: Y.encodeStateAsUpdate(client, before), beforeStateVector: before } } }));
  assert.ok((await conn.next()).update, 'the edit was acknowledged');
  conn.socket.close();
  const stored = new Y.Doc({ guid: grandchild.viewId });

  Y.applyUpdate(stored, new Uint8Array((await env.api('GET', `/api/workspace/v1/${acct.workspaceId}/collab/${grandchild.viewId}?collab_type=0`, undefined, acct.token)).body.data.doc_state));
  assert.match(JSON.stringify([...stored.getMap('data').get('document').get('meta').get('text_map').values()].map((value) => value.toString?.())), new RegExp(marker));
});

test('a sub-page stops being reachable when an ancestor is trashed, and returns on restore', async () => {
  const acct = await account(env, 'nested-trash');
  const parent = await createDocument(acct, acct.spaceId, 'Parent');
  const child = await createDocument(acct, parent.viewId, 'Child');
  const probe = () => env.api('GET', `/api/workspace/${acct.workspaceId}/collab/${child.viewId}/permission?collab_type=0`, undefined, acct.token);

  assert.equal((await probe()).status, 200);
  await env.api('POST', `/api/workspace/${acct.workspaceId}/page-view/${parent.viewId}/move-to-trash`, {}, acct.token);
  assert.equal((await probe()).status, 404);
  await env.api('POST', `/api/workspace/${acct.workspaceId}/page-view/${parent.viewId}/restore-from-trash`, {}, acct.token);
  assert.equal((await probe()).status, 200);
});

test('a database can be created inside a page, and a page moved there keeps working', async () => {
  const acct = await account(env, 'nested-db');
  const parent = await createDocument(acct, acct.spaceId, 'Project');
  const created = await env.api('POST', `/api/workspace/${acct.workspaceId}/v2/page-view/database/from-template`, {
    schema_version: 'v1', request_id: id(), template_id: 'tasks', parent_view_id: parent.viewId, position: { kind: 'end' },
  }, acct.token);

  assert.equal(created.status, 200, JSON.stringify(created.body));
  const databaseId = created.body.data.result.database_id;
  const probe = await env.api('GET', `/api/workspace/${acct.workspaceId}/collab/${databaseId}/permission?collab_type=1`, undefined, acct.token);

  assert.equal(probe.status, 200, JSON.stringify(probe.body));
  assert.ok(await env.store.getDatabaseCollab(acct.workspaceId, databaseId));
  const tree = (await env.api('GET', `/api/workspace/${acct.workspaceId}/view/${parent.viewId}?depth=2`, undefined, acct.token)).body.data;

  assert.equal(tree.children.length, 1, 'the database sits under the page in the sidebar');
});
