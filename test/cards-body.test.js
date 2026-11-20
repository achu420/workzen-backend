// cards.getCard({includeBody}) / MCP get_card: the card body comes from the shared readCardBody. Fixtures are shaped like the
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
import { createCardService } from '../cards.js';

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

test('getCard returns the body only when asked, and says when a card has no body document', async () => {
  const fixture = await workspaceWithCards('card-get-body');
  const cards = createCardService({ store, broadcast: () => {} });
  const [withBody, without] = fixture.rowIds;
  const row = await openRowDocument(fixture, withBody);

  await saveEdits(fixture, row, (doc) => {
    addBlock(doc, rootOf(doc), 'heading', 'Launch plan', { level: 1 });
    addBlock(doc, rootOf(doc), 'paragraph', 'Owner is Priya, codename BLUEBIRD.');
  });

  const plain = await cards.getCard({ workspaceId: fixture.workspaceId, cardId: withBody });
  assert.equal('body' in plain, false, 'other tools keep the old card shape');

  const full = await cards.getCard({ workspaceId: fixture.workspaceId, cardId: withBody, includeBody: true });
  assert.match(full.body, /Launch plan/);
  assert.match(full.body, /BLUEBIRD/);
  assert.equal(full.body_truncated, false);
  assert.equal(full.has_body_document, true);

  const none = await cards.getCard({ workspaceId: fixture.workspaceId, cardId: without, includeBody: true });
  assert.deepEqual([none.body, none.body_truncated, none.has_body_document], ['', false, false]);
});

test('a long body is read in pages with body_offset and nothing is lost', async () => {
  const fixture = await workspaceWithCards('card-body-pages');
  const cards = createCardService({ store, broadcast: () => {} });
  const row = await openRowDocument(fixture, fixture.rowIds[0]);
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'lorem ipsum '.repeat(25)}END${i}`);

  await saveEdits(fixture, row, (doc) => { for (const text of paragraphs) addBlock(doc, rootOf(doc), 'paragraph', text); });
  const joined = paragraphs.join('\n');
  let offset = 0, collected = '', pages = 0;

  for (;;) {
    const card = await cards.getCard({ workspaceId: fixture.workspaceId, cardId: fixture.rowIds[0], includeBody: true, bodyOffset: offset, bodyMaxChars: 4000 });

    assert.equal(card.body_total_chars, joined.length);
    collected += card.body;
    pages += 1;
    if (card.body_next_offset === null) break;
    offset = card.body_next_offset;
  }
  assert.ok(pages > 1);
  assert.equal(collected, joined);
});
