// Workspace search: GET /api/search/{ws}/page, /api/search/{ws}, POST .../mentions/search, GET .../recent.
// The index is debounced in production; here searchIndexDelayMs is 0 and tests await searchIndex.flush().
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { startServer } from '../server.js';

let dir, running, base, stateFile;

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-search-'));
  stateFile = path.join(dir, 'state.json');
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: stateFile, devKey: 'test-key', searchIndexDelayMs: 0 });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const flush = () => running.app.searchIndex.flush();

async function account(label) {
  const email = `${label}@example.test`;
  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const login = await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' });
  const token = login.body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  const spaceId = randomUUID();
  const created = await api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: 'Space', view_id: spaceId,
    permission: {
      visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
      invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
      security: { disable_guests: false, disable_public_links: false, disable_export: false },
    },
  }, token);

  assert.equal(created.status, 200);
  return { email, token, workspaceId, spaceId, userId: login.body.user.id };
}

// A Document collab whose body is the given lines (one text block each).
function documentState(lines) {
  const doc = new Y.Doc();
  const document = new Y.Map();
  const blocks = new Y.Map();
  const meta = new Y.Map();
  const childrenMap = new Y.Map();
  const textMap = new Y.Map();

  doc.getMap('data').set('document', document);
  document.set('blocks', blocks);
  document.set('meta', meta);
  meta.set('children_map', childrenMap);
  meta.set('text_map', textMap);
  const rootChildren = new Y.Array();

  childrenMap.set('root-children', rootChildren);
  const root = new Y.Map();

  root.set('id', 'root');
  root.set('children', 'root-children');
  blocks.set('root', root);
  document.set('page_id', 'root');
  lines.forEach((line, index) => {
    const block = new Y.Map();
    const text = new Y.Text();

    block.set('id', `b${index}`);
    block.set('children', `c${index}`);
    block.set('external_id', `t${index}`);
    block.set('external_type', 'text');
    blocks.set(`b${index}`, block);
    childrenMap.set(`c${index}`, new Y.Array());
    textMap.set(`t${index}`, text);
    text.insert(0, line);
    rootChildren.push([`b${index}`]);
  });
  return Y.encodeStateAsUpdate(doc);
}

let creationCounter = 0;
async function addPage(owner, { title, lines = [], parent = owner.spaceId, id = randomUUID() }) {
  // Past timestamps: a future updated_at would be clipped, then start decaying mid-test and reorder ties.
  const now = new Date(Date.now() - 60_000 + (creationCounter += 1)).toISOString();
  const state = documentState(lines);

  await running.app.store.createAtomicDocumentPage({
    id, workspace_id: owner.workspaceId, parent_view_id: parent, title, icon: null, extra: null, layout: 0, is_favorite: false,
    creator_id: owner.userId, version: 1, created_at: now, updated_at: now, position: { kind: 'end' },
  }, {
    collabVersion: 'appflowy-page-v1', documentState: state, stateVector: Y.encodeStateVector((() => { const d = new Y.Doc(); Y.applyUpdate(d, state); return d; })()),
  }, { request_id: randomUUID(), request_digest: randomUUID() });
  await flush();
  return id;
}

const search = (owner, query, extra = '') => api('GET', `/api/search/${owner.workspaceId}/page?query=${encodeURIComponent(query)}${extra}`, undefined, owner.token);

test('ranks title matches above body matches and matches by token prefix', async () => {
  const owner = await account('search-rank');
  const budget = await addPage(owner, { title: 'Quarterly Budget', lines: ['headcount forecast and tooling spend'] });
  const notes = await addPage(owner, { title: 'Meeting notes', lines: ['we discussed the budget', 'and the budget again'] });
  const guide = await addPage(owner, { title: 'Budgeting guide', lines: ['how to plan'] });

  const exact = await search(owner, 'budget');
  assert.equal(exact.status, 200);
  const order = exact.body.data.items.map((item) => item.object_id);
  assert.deepEqual(new Set(order.slice(0, 2)), new Set([budget, guide]), 'title hits first');
  assert.equal(order[2], notes, 'body-only hit last');
  assert.deepEqual(Object.keys(exact.body.data).sort(), ['has_more', 'items', 'next_offset']);

  const prefix = await search(owner, 'budg');
  assert.equal(prefix.body.data.items.length, 3);
  assert.equal((await search(owner, 'udget')).body.data.items.length, 0, 'prefix, not substring');

  const body = (await search(owner, 'tooling')).body.data.items;
  assert.equal(body.length, 1);
  assert.equal(body[0].object_id, budget);
  assert.match(body[0].content, /tooling spend/);
  assert.equal(body[0].workspace_id, owner.workspaceId);

  assert.equal((await search(owner, 'headcount spend')).body.data.items.length, 1, 'every term, any order');
  assert.equal((await search(owner, 'headcount nothing')).body.data.items.length, 0);
  assert.deepEqual((await search(owner, '   ')).body.data, { items: [], next_offset: null, has_more: false });
});

test('paging reports has_more and a next_offset that moves forward', async () => {
  const owner = await account('search-paging');

  for (let index = 0; index < 12; index += 1) await addPage(owner, { title: `Shared plan ${index}` });
  const first = (await search(owner, 'shared', '&limit=5&offset=0')).body.data;
  const second = (await search(owner, 'shared', '&limit=5&offset=5')).body.data;
  const third = (await search(owner, 'shared', '&limit=5&offset=10')).body.data;

  assert.equal(first.items.length, 5);
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 5);
  assert.equal(second.next_offset, 10);
  assert.equal(third.items.length, 2);
  assert.equal(third.has_more, false);
  assert.equal(third.next_offset, null);
  const ids = [...first.items, ...second.items, ...third.items].map((item) => item.object_id);
  assert.equal(new Set(ids).size, 12, 'no hit repeats across pages');
  assert.equal((await search(owner, 'shared', '&limit=1000')).body.data.items.length, 12, 'limit is capped, not rejected');
});

test('the plain list route returns the bare item array', async () => {
  const owner = await account('search-list');

  await addPage(owner, { title: 'Roadmap' });
  const list = await api('GET', `/api/search/${owner.workspaceId}?query=road&limit=10`, undefined, owner.token);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.data));
  assert.equal(list.body.data.length, 1);
  assert.deepEqual((await api('POST', `/api/search/${owner.workspaceId}/summary`, { query: 'road', only_context: true }, owner.token)).body.data, { summaries: [] });
});

test('trashed pages, their descendants and private spaces are excluded; restore brings them back', async () => {
  const owner = await account('search-hidden');
  const parent = await addPage(owner, { title: 'Hidden parent' });
  const child = await addPage(owner, { title: 'Hidden child', parent });

  assert.equal((await search(owner, 'hidden')).body.data.items.length, 2);
  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/page-view/${parent}/move-to-trash`, undefined, owner.token)).status, 200);
  await flush();
  assert.equal((await search(owner, 'hidden')).body.data.items.length, 0, 'a trashed page and its child both disappear');
  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/page-view/${parent}/restore-from-trash`, undefined, owner.token)).status, 200);
  assert.deepEqual(new Set((await search(owner, 'hidden')).body.data.items.map((item) => item.object_id)), new Set([parent, child]));

  running.app.store.state.spaces[owner.spaceId].permission.visibility = 'private';
  assert.equal((await search(owner, 'hidden')).body.data.items.length, 0, 'pages in a space that is not a supported public space are not searchable');
  running.app.store.state.spaces[owner.spaceId].permission.visibility = 'public';
});

test('rename, delete and workspace isolation', async () => {
  const owner = await account('search-rename');
  const other = await account('search-other');
  const page = await addPage(owner, { title: 'Alpha launch' });

  await addPage(other, { title: 'Alpha secret', lines: ['alpha'] });
  assert.equal((await search(owner, 'alpha')).body.data.items.length, 1, 'another workspace is never searched');
  assert.equal((await search(owner, 'secret')).body.data.items.length, 0);
  assert.equal((await api('GET', `/api/search/${other.workspaceId}/page?query=alpha`, undefined, owner.token)).status, 403);
  assert.equal((await api('GET', `/api/search/${owner.workspaceId}/page?query=alpha`)).status, 401);

  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/page-view/${page}/update-name`, { name: 'Beta rollout' }, owner.token)).status, 200);
  await flush();
  assert.equal((await search(owner, 'alpha')).body.data.items.length, 0, 'the old title stops matching');
  assert.equal((await search(owner, 'beta')).body.data.items[0].object_id, page);

  assert.equal((await api('PATCH', `/api/workspace/${owner.workspaceId}/page-view/${page}`, { name: 'Gamma review' }, owner.token)).status, 200);
  await flush();
  assert.equal((await search(owner, 'gamma')).body.data.items[0].object_id, page);

  await api('POST', `/api/workspace/${owner.workspaceId}/page-view/${page}/move-to-trash`, undefined, owner.token);
  await running.app.store.deletePagePermanently(page, owner.workspaceId);
  await flush();
  assert.equal((await search(owner, 'gamma')).body.data.items.length, 0);
  assert.equal((await running.app.store.listSearchDocumentRefs(owner.workspaceId, { kind: 'page' })).some((ref) => ref.object_id === page), false, 'the index entry is dropped');
});

async function createTasksDatabase(owner) {
  const created = await api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/database/from-template`, {
    schema_version: 'v1', request_id: randomUUID(), template_id: 'tasks', parent_view_id: owner.spaceId, position: { kind: 'end' },
  }, owner.token);

  assert.equal(created.status, 200, JSON.stringify(created.body));
  await flush();
  return created.body.data.result;
}

test('database rows are searchable and carry the ids the client needs to open them', async () => {
  const owner = await account('search-rows');
  const { view_id: containerId, database_id: databaseId, view_ids: viewIds, row_ids: rowIds } = await createTasksDatabase(owner);
  const doc = new Y.Doc();

  Y.applyUpdate(doc, new Uint8Array(running.app.store.state.databaseRowCollabDocuments[rowIds[0]].document_state));
  const cells = doc.getMap('data').get('data').get('cells');
  const databaseDoc = new Y.Doc();

  Y.applyUpdate(databaseDoc, new Uint8Array(running.app.store.state.databaseCollabDocuments[databaseId].document_state));
  const primaryFieldId = [...databaseDoc.getMap('data').get('database').get('fields').entries()].find(([, field]) => field.get('is_primary'))[0];
  const title = cells.get(primaryFieldId).get('data');

  const hits = (await search(owner, title)).body.data.items;
  const row = hits.find((item) => item.database_row_id === rowIds[0]);

  assert.ok(row, `row "${title}" is found`);
  assert.equal(row.object_id, rowIds[0]);
  assert.equal(row.database_id, databaseId);
  assert.equal(row.database_view_id, viewIds[0], 'points at the database primary view page');
  assert.ok(row.content.length > 0);

  const container = (await search(owner, 'tasks')).body.data.items.find((item) => item.object_id === containerId);
  assert.ok(container, 'the database container page is matched by its title');
  assert.equal(container.database_id, databaseId);

  await api('POST', `/api/workspace/${owner.workspaceId}/page-view/${containerId}/move-to-trash`, undefined, owner.token);
  assert.equal((await search(owner, title)).body.data.items.length, 0, 'rows of a trashed database disappear too');
});

test('mention search returns people, pages, databases, rows and dates in the shapes the panel renders', async () => {
  const owner = await account('search-mention');
  const page = await addPage(owner, { title: 'Budget plan', lines: ['text'] });
  const { view_id: containerId, database_id: databaseId, view_ids: viewIds, row_ids: rowIds } = await createTasksDatabase(owner);
  const call = (payload) => api('POST', `/api/workspace/${owner.workspaceId}/mentions/search`, payload, owner.token);

  const everything = (await call({ query: 'bud', limit: 20 })).body.data;
  const bySection = Object.fromEntries(everything.sections.map((section) => [section.kind, section]));

  assert.ok(everything.sections.every((section) => section.status === 'ready' && section.has_more === false));
  const pageItem = bySection.pages.items.find((item) => item.object_id === page);
  assert.deepEqual(pageItem.mention, { type: 'page', page_id: page });
  assert.equal(pageItem.kind, 'page');
  assert.equal(bySection.people.items.length, 0, 'no member matches "bud"');

  const people = (await call({ query: 'search-mention', include: ['person'], context: { view_id: page } })).body.data.sections[0];
  assert.equal(people.kind, 'people');
  assert.equal(people.items[0].mention.type, 'person');
  assert.equal(people.items[0].mention.person_id, owner.userId);
  assert.equal(people.items[0].mention.page_id, page);
  assert.equal(people.items[0].subtitle, owner.email);

  const databases = (await call({ query: 'tasks', include: ['database'] })).body.data.sections[0];
  assert.equal(databases.kind, 'databases');
  assert.deepEqual(databases.items[0].mention, { type: 'database', database_id: databaseId, database_view_id: viewIds[0] });
  assert.equal(databases.items[0].object_id, containerId);

  const rowDoc = new Y.Doc();
  Y.applyUpdate(rowDoc, new Uint8Array(running.app.store.state.databaseRowCollabDocuments[rowIds[0]].document_state));
  const databaseDoc = new Y.Doc();
  Y.applyUpdate(databaseDoc, new Uint8Array(running.app.store.state.databaseCollabDocuments[databaseId].document_state));
  const primaryFieldId = [...databaseDoc.getMap('data').get('database').get('fields').entries()].find(([, field]) => field.get('is_primary'))[0];
  const title = rowDoc.getMap('data').get('data').get('cells').get(primaryFieldId).get('data');
  const rows = (await call({ query: title, include: ['database_row'], filter: { database_ids: [databaseId] } })).body.data.sections[0];

  assert.equal(rows.kind, 'database_rows');
  assert.deepEqual(rows.items.find((item) => item.object_id === rowIds[0]).mention, {
    type: 'database_row', database_id: databaseId, database_view_id: viewIds[0], row_id: rowIds[0],
  });
  assert.equal((await call({ query: title, include: ['database_row'], filter: { database_ids: [randomUUID()] } })).body.data.sections[0].items.length, 0, 'the database filter applies');

  const dates = (await call({ include: ['date'] })).body.data.sections[0];
  assert.equal(dates.kind, 'dates');
  assert.deepEqual(dates.items.map((item) => item.title), ['Today', 'Tomorrow', 'Yesterday']);
  assert.equal((await call({ query: 'tomo', include: ['date'] })).body.data.sections[0].items.length, 1);

  const recent = (await call({})).body.data.sections.find((section) => section.kind === 'pages');
  assert.ok(recent.items.some((item) => item.object_id === page), 'an empty query lists pages');
  assert.equal((await call({ query: 5 })).status, 400);
  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/mentions/search`, {})).status, 401);
});

test('recent pages come back most recent first, skip trashed and missing pages, and are capped', async () => {
  const owner = await account('search-recent');
  const first = await addPage(owner, { title: 'First visit' });
  const second = await addPage(owner, { title: 'Second visit' });
  const third = await addPage(owner, { title: 'Third visit' });
  const visit = (ids) => api('POST', `/api/workspace/${owner.workspaceId}/add-recent-pages`, { recent_view_ids: ids }, owner.token);
  const recent = async () => (await api('GET', `/api/workspace/${owner.workspaceId}/recent`, undefined, owner.token)).body.data.views.map((view) => view.view_id);

  assert.deepEqual(await recent(), []);
  await visit([first]);
  await visit([second]);
  await visit([third, randomUUID()]);
  assert.deepEqual(await recent(), [third, second, first]);
  await visit([first]);
  assert.deepEqual(await recent(), [first, third, second], 'revisiting moves a page to the front');

  await api('POST', `/api/workspace/${owner.workspaceId}/page-view/${third}/move-to-trash`, undefined, owner.token);
  assert.deepEqual(await recent(), [first, second]);
  const view = (await api('GET', `/api/workspace/${owner.workspaceId}/recent`, undefined, owner.token)).body.data.views[0];
  assert.equal(view.name, 'First visit');
  assert.equal(view.parent_view_id, owner.spaceId);

  await visit(Array.from({ length: 60 }, () => randomUUID()));
  assert.equal((await running.app.store.getRecentPages(owner.workspaceId, owner.userId)).length, 50, 'the stored list is capped');
  assert.equal((await api('GET', `/api/workspace/${owner.workspaceId}/recent`)).status, 401);
});

test('startup backfill makes content that already existed searchable', async () => {
  const owner = await account('search-backfill');
  const page = await addPage(owner, { title: 'Preexisting', lines: ['archived rollout notes'] });
  const { database_id: databaseId, row_ids: rowIds } = await createTasksDatabase(owner);

  assert.ok(rowIds.length > 0 && databaseId);
  const token = owner.token;
  const workspaceId = owner.workspaceId;

  await new Promise((resolve) => running.server.close(resolve));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: stateFile, devKey: 'test-key', searchIndexDelayMs: 0 });
  base = `http://127.0.0.1:${running.address.port}`;

  const hits = await api('GET', `/api/search/${workspaceId}/page?query=rollout`, undefined, token);
  assert.equal(hits.status, 200, JSON.stringify(hits.body));
  assert.equal(hits.body.data.items[0].object_id, page, 'the document body was indexed by the backfill');
  const rows = await api('POST', `/api/workspace/${workspaceId}/mentions/search`, { query: 'tsk', include: ['database_row'] }, token);
  assert.ok(rows.body.data.sections[0].items.length > 0, 'database rows were indexed by the backfill');
});

// The web client sends x-request-time / x-request-stream-id on every search call; if the
// preflight does not allow them the browser blocks the request before it reaches the server.
test('CORS preflight allows the headers the web client sends with search requests', async () => {
  const response = await fetch(`${base}/api/search/anything/page`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:5173',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-request-time,x-request-stream-id,authorization',
    },
  });
  const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();

  assert.equal(response.status, 204);
  assert.ok(allowed.includes('x-request-time') && allowed.includes('x-request-stream-id'), allowed);
});
