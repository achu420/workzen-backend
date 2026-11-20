// readCardBody(): the one shared way to read a card's body (its row-detail document). Fixtures are shaped like the
// documents the web editor stores: Y.Map blocks (id, ty, parent, children, external_id, external_type, data as a JSON
// string), meta.children_map of Y.Arrays and meta.text_map of Y.Text, created through the same orphaned-view route the
// client uses for a card's document.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { startServer } from '../server.js';
import { rowDocumentIdFromRowId } from '../page-document.js';
import { readCardBody } from '../card-body.js';

let dir, running, base, store;

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-card-body-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key' });
  base = `http://127.0.0.1:${running.address.port}`;
  store = running.app.store;
});
after(async () => {
  running.server.closeAllConnections?.();
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function workspaceWithCards(label) {
  const email = `${label}@example.test`;

  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  const spaceId = crypto.randomUUID();

  assert.equal((await api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: 'Space', view_id: spaceId,
    permission: {
      visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
      invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
      security: { disable_guests: false, disable_public_links: false, disable_export: false },
    },
  }, token)).status, 200);
  const created = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/from-template`, {
    schema_version: 'v1', request_id: crypto.randomUUID(), template_id: 'tasks', parent_view_id: spaceId, position: { kind: 'end' },
  }, token);

  assert.equal(created.status, 200);
  const { database_id: databaseId, view_ids: viewIds, row_ids: rowIds } = created.body.data.result;

  return { token, workspaceId, databaseId, viewId: viewIds[0], rowIds };
}

// Creates the card's document the way the web client does and returns its Yjs doc (client side).
async function openRowDocument({ token, workspaceId, databaseId, viewId }, rowId) {
  const documentId = rowDocumentIdFromRowId(rowId);
  const response = await api('POST', `/api/workspace/${workspaceId}/orphaned-view`, {
    document_id: documentId,
    row_document_source: { database_id: databaseId, database_view_id: viewId, row_id: rowId },
  }, token);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const doc = new Y.Doc({ guid: documentId });

  Y.applyUpdate(doc, new Uint8Array(response.body.data));
  return { doc, documentId };
}

let blockSeq = 0;

// Appends a text block exactly like the editor stores one.
function addBlock(doc, parentId, type, text, data = {}, attributes) {
  const document = doc.getMap('data').get('document');
  const blocks = document.get('blocks');
  const meta = document.get('meta');
  const id = `blk${(blockSeq += 1)}`;
  const block = new Y.Map();

  block.set('id', id);
  block.set('ty', type);
  block.set('parent', parentId);
  block.set('children', `${id}-children`);
  block.set('external_id', `${id}-text`);
  block.set('external_type', 'text');
  block.set('data', JSON.stringify(data));
  blocks.set(id, block);
  meta.get('children_map').set(`${id}-children`, new Y.Array());
  const content = new Y.Text();

  meta.get('text_map').set(`${id}-text`, content);
  content.insert(0, text, attributes);
  meta.get('children_map').get(blocks.get(parentId).get('children')).push([id]);
  return id;
}

async function saveEdits(fixture, { doc, documentId }, edit) {
  const before = Y.encodeStateVector(doc);

  edit(doc);
  const accepted = await store.acceptPageCollabUpdate({
    workspaceId: fixture.workspaceId,
    pageId: documentId,
    flags: 0,
    payload: Y.encodeStateAsUpdate(doc, before),
    beforeStateVector: before,
  });

  assert.ok(accepted.status === 'applied' || accepted.durable, 'the edit was stored');
}

const rootOf = (doc) => doc.getMap('data').get('document').get('page_id');

test('reads every kind of text block the editor produces, in document order, including nested and linked text', async () => {
  const fixture = await workspaceWithCards('body-blocks');
  const row = await openRowDocument(fixture, fixture.rowIds[0]);

  await saveEdits(fixture, row, (doc) => {
    const root = rootOf(doc);

    addBlock(doc, root, 'heading', 'Launch plan', { level: 1 });
    addBlock(doc, root, 'paragraph', 'Owner is Priya, codename BLUEBIRD.');
    const list = addBlock(doc, root, 'bulleted_list', 'first bullet alpha-item');

    addBlock(doc, list, 'bulleted_list', 'nested child under alpha');
    addBlock(doc, root, 'todo_list', 'todo item zeta-task', { checked: true });
    addBlock(doc, root, 'quote', 'quoted wisdom omega-quote');
    addBlock(doc, root, 'callout', 'callout note sigma-callout', { icon: 'x' });
    addBlock(doc, root, 'code', 'const token = "code-body-kappa";', { language: 'javascript' });
    addBlock(doc, root, 'paragraph', 'see the docs', {}, { href: 'https://example.test/docs' });
    addBlock(doc, root, 'paragraph', '@', {}, { mention: { type: 'page', page_id: crypto.randomUUID() } });
    addBlock(doc, root, 'paragraph', 'Closing paragraph KESTREL-42');
  });
  const body = await readCardBody({ store, workspaceId: fixture.workspaceId, databaseId: fixture.databaseId, rowId: fixture.rowIds[0] });

  assert.equal(body.has_document, true);
  assert.equal(body.truncated, false);
  const expectedInOrder = ['Launch plan', 'BLUEBIRD', 'alpha-item', 'nested child under alpha', 'zeta-task', 'omega-quote', 'sigma-callout', 'code-body-kappa', 'see the docs', 'KESTREL-42'];
  let cursor = -1;

  for (const needle of expectedInOrder) {
    const at = body.text.indexOf(needle);

    assert.ok(at > cursor, `"${needle}" appears after the previous block (text: ${JSON.stringify(body.text)})`);
    cursor = at;
  }
  assert.ok(body.text.includes('\n'), 'blocks are joined by newlines');
});

test('no row document means no body and nothing is created', async () => {
  const fixture = await workspaceWithCards('body-none');
  const pagesBefore = (await store.listPages(fixture.workspaceId)).length;
  const body = await readCardBody({ store, workspaceId: fixture.workspaceId, databaseId: fixture.databaseId, rowId: fixture.rowIds[1] });

  assert.deepEqual(body, { text: '', truncated: false, has_document: false });
  assert.equal((await store.listPages(fixture.workspaceId)).length, pagesBefore, 'reading never creates the row document');
  assert.equal(await store.getPage(rowDocumentIdFromRowId(fixture.rowIds[1])), null);
});

test('a freshly opened, still empty document has a document but no text', async () => {
  const fixture = await workspaceWithCards('body-empty');

  await openRowDocument(fixture, fixture.rowIds[2]);
  assert.deepEqual(await readCardBody({ store, workspaceId: fixture.workspaceId, databaseId: fixture.databaseId, rowId: fixture.rowIds[2] }), { text: '', truncated: false, has_document: true, total_chars: 0, next_offset: null });
});

test('long bodies are cut to maxChars and flagged', async () => {
  const fixture = await workspaceWithCards('body-truncate');
  const row = await openRowDocument(fixture, fixture.rowIds[0]);

  await saveEdits(fixture, row, (doc) => {
    for (let index = 0; index < 20; index += 1) addBlock(doc, rootOf(doc), 'paragraph', `paragraph number ${index} ${'x'.repeat(40)}`);
  });
  const args = { store, workspaceId: fixture.workspaceId, databaseId: fixture.databaseId, rowId: fixture.rowIds[0] };
  const cut = await readCardBody({ ...args, maxChars: 200 });

  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= 200 && cut.text.startsWith('paragraph number 0'));
  const whole = await readCardBody(args);

  assert.equal(whole.truncated, false);
  assert.ok(whole.text.includes('paragraph number 19'));
  assert.equal((await readCardBody({ ...args, maxChars: 0 })).text, '');
});

test('edits made after the first read are picked up on the next read', async () => {
  const fixture = await workspaceWithCards('body-fresh');
  const row = await openRowDocument(fixture, fixture.rowIds[0]);
  const args = { store, workspaceId: fixture.workspaceId, databaseId: fixture.databaseId, rowId: fixture.rowIds[0] };

  await saveEdits(fixture, row, (doc) => addBlock(doc, rootOf(doc), 'paragraph', 'version one'));
  assert.ok((await readCardBody(args)).text.includes('version one'));
  await saveEdits(fixture, row, (doc) => addBlock(doc, rootOf(doc), 'paragraph', 'version two added later'));
  const text = (await readCardBody(args)).text;

  assert.ok(text.includes('version one') && text.includes('version two added later'));
});

test('a trashed row document, another workspace, or another database yields no body', async () => {
  const fixture = await workspaceWithCards('body-scope');
  const outsider = await workspaceWithCards('body-scope-outsider');
  const row = await openRowDocument(fixture, fixture.rowIds[0]);

  await saveEdits(fixture, row, (doc) => addBlock(doc, rootOf(doc), 'paragraph', 'secret body text'));
  const args = { store, workspaceId: fixture.workspaceId, databaseId: fixture.databaseId, rowId: fixture.rowIds[0] };

  assert.ok((await readCardBody(args)).text.includes('secret body text'));
  assert.deepEqual(await readCardBody({ ...args, workspaceId: outsider.workspaceId }), { text: '', truncated: false, has_document: false }, 'another workspace');
  assert.deepEqual(await readCardBody({ ...args, databaseId: outsider.databaseId }), { text: '', truncated: false, has_document: false }, 'a different database than the document declares');
  assert.equal((await api('POST', `/api/workspace/${fixture.workspaceId}/page-view/${row.documentId}/move-to-trash`, undefined, fixture.token)).status, 200);
  assert.deepEqual(await readCardBody(args), { text: '', truncated: false, has_document: false }, 'trashed');
});

test('missing arguments are handled without throwing', async () => {
  assert.deepEqual(await readCardBody({ store, workspaceId: null, rowId: null }), { text: '', truncated: false, has_document: false });
  assert.deepEqual(await readCardBody({}), { text: '', truncated: false, has_document: false });
});
