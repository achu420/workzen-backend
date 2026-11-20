// Task 64: PostgreSQL-storage-mode HTTP integration coverage for the real
// workspace Database catalog (`GET /api/workspace/{workspaceId}/database`),
// mirroring test/database-catalog.test.js's JSON-mode scenarios exactly
// (same assertions, same helper conventions as
// test/postgres-database-http-integration.test.js: a real HTTP server
// backed by the real disposable PostgreSQL test database, not a mocked
// store) so the two storage modes are provably equivalent, not just
// independently plausible.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { id } from '../auth.js';
import { startServer } from '../server.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;
let running, base;

before(async () => {
  if (!configured) return;
  running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey: 'task64-key', environment: 'test' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  if (!configured || !running) return;
  await running.app.store.close();
  await new Promise((resolve) => running.server.close(resolve));
});

async function api(method, route, payload, token, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const PUBLIC_SPACE_PERMISSION = {
  visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
  invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
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
  assert.equal((await api('POST', `/api/workspace/${workspaceId}/spaces`, { name: `${label} space`, view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, token)).status, 200);
  return spaceId;
}

function defaultDatabaseRequest({ parentViewId, name = 'Grid' }) {
  return {
    schema_version: 'v1', request_id: id(), parent_view_id: parentViewId, name, position: { kind: 'start' }, container_id: id(),
    database: { database_id: id(), view_id: id(), name, layout: 0, embedded: false, responses_view_id: null, initial_row_ids: [], timezone_id: null },
  };
}

async function createGridDatabase(token, workspaceId, spaceId, overrides = {}) {
  const { name, ...rest } = overrides;
  const request = { ...defaultDatabaseRequest({ parentViewId: spaceId, ...(name !== undefined ? { name } : {}) }), ...rest };
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  assert.equal(response.status, 200, `database creation failed: ${JSON.stringify(response.body)}`);
  return { request, response };
}

async function getCatalog(token, workspaceId, query = '') {
  return api('GET', `/api/workspace/${workspaceId}/database${query}`, undefined, token);
}

test('PostgreSQL mode: empty workspace reports an empty, non-error catalog', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-empty');
  const r = await getCatalog(token, workspaceId);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { databases: [], has_more: false });
});

test('PostgreSQL mode: one Database is discoverable with correct container+primary-view association', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-one-db');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-one-db');
  const { request } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Tasks' });

  const r = await getCatalog(token, workspaceId);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.databases.length, 1);
  assert.equal(r.body.data.has_more, false);

  const entry = r.body.data.databases[0];
  assert.equal(entry.database_id, request.database.database_id);
  assert.equal(entry.views.length, 2);

  const container = entry.views.find((v) => v.is_container);
  const primary = entry.views.find((v) => !v.is_container);
  assert.ok(container && primary);
  assert.equal(container.view_id, request.container_id);
  assert.equal(primary.view_id, request.database.view_id);
  assert.notEqual(container.view_id, primary.view_id);
  assert.equal(container.layout, 1);
  assert.equal(primary.layout, 1);
  assert.equal(container.embedded, false);
  assert.equal(primary.embedded, false);
  assert.equal(container.name, 'Tasks');
  assert.equal(primary.name, 'Tasks');
  assert.equal(primary.parent_view_id, container.view_id);
});

test('PostgreSQL mode: multiple Databases in the same workspace are all discoverable', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-multi-db');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-multi-db');
  const { request: req1 } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Alpha' });
  const { request: req2 } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Beta' });
  const { request: req3 } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Gamma' });

  const r = await getCatalog(token, workspaceId);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.databases.length, 3);
  const ids = r.body.data.databases.map((entry) => entry.database_id).sort();
  const expected = [req1, req2, req3].map((r2) => r2.database.database_id).sort();
  assert.deepEqual(ids, expected);
});

test('PostgreSQL mode: a Database created in one session is discoverable by a completely separate second session (the fresh-session gap Task 63 found)', { skip: !configured }, async () => {
  const creator = await registerAndLogin('pg-fresh-creator');
  const spaceId = await createPublicSpace(creator.token, creator.workspaceId, 'pg-fresh');
  const { request } = await createGridDatabase(creator.token, creator.workspaceId, spaceId, { name: 'Shared Grid' });

  const secondMember = await registerAndLogin('pg-fresh-member');
  const secondMemberEmail = (await api('GET', '/api/auth/me', undefined, secondMember.token)).body.user.email;
  const addMember = await api('POST', `/api/workspaces/${creator.workspaceId}/test-members`, { email: secondMemberEmail, role: 'member' }, creator.token, { 'x-development-key': 'task64-key' });
  assert.equal(addMember.status, 201, JSON.stringify(addMember.body));

  const r = await getCatalog(secondMember.token, creator.workspaceId);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.databases.length, 1);
  assert.equal(r.body.data.databases[0].database_id, request.database.database_id);
});

test('PostgreSQL mode: cross-workspace isolation and unauthorized access', { skip: !configured }, async () => {
  const ownerA = await registerAndLogin('pg-iso-a');
  const spaceA = await createPublicSpace(ownerA.token, ownerA.workspaceId, 'pg-iso-a');
  await createGridDatabase(ownerA.token, ownerA.workspaceId, spaceA, { name: 'A-only' });

  const ownerB = await registerAndLogin('pg-iso-b');
  const rB = await getCatalog(ownerB.token, ownerB.workspaceId);
  assert.equal(rB.status, 200);
  assert.deepEqual(rB.body.data, { databases: [], has_more: false });

  const rBReadsA = await getCatalog(ownerB.token, ownerA.workspaceId);
  assert.equal(rBReadsA.status, 403);

  const noToken = await getCatalog(undefined, ownerA.workspaceId);
  assert.equal(noToken.status, 401);
});

test('PostgreSQL mode: missing workspace id (well-formed UUID, no such workspace) is rejected', { skip: !configured }, async () => {
  const owner = await registerAndLogin('pg-missing-ws');
  const r = await getCatalog(owner.token, id());
  assert.equal(r.status, 403);
});

test('PostgreSQL mode: pagination offset/limit, has_more and stable ordering', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-paginated');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-paginated');
  const created = [];
  for (const name of ['One', 'Two', 'Three']) {
    const { request } = await createGridDatabase(token, workspaceId, spaceId, { name });
    created.push(request.database.database_id);
  }

  const page1 = await getCatalog(token, workspaceId, '?offset=0&limit=2');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.databases.length, 2);
  assert.equal(page1.body.data.has_more, true);

  const page2 = await getCatalog(token, workspaceId, '?offset=2&limit=2');
  assert.equal(page2.status, 200);
  assert.equal(page2.body.data.databases.length, 1);
  assert.equal(page2.body.data.has_more, false);

  const allIds = [...page1.body.data.databases, ...page2.body.data.databases].map((e) => e.database_id);
  assert.deepEqual(allIds.sort(), created.sort());

  const repeat = await getCatalog(token, workspaceId, '?offset=0&limit=2');
  assert.deepEqual(repeat.body.data.databases.map((e) => e.database_id), page1.body.data.databases.map((e) => e.database_id));
});

test('PostgreSQL mode: invalid pagination parameters are rejected', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-bad-pagination');
  assert.equal((await getCatalog(token, workspaceId, '?offset=-1')).status, 400);
  assert.equal((await getCatalog(token, workspaceId, '?limit=0')).status, 400);
  assert.equal((await getCatalog(token, workspaceId, '?limit=100000')).status, 400);
});

test('PostgreSQL mode: malformed container metadata is excluded without hiding other valid Databases', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-malformed');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-malformed');
  const { request: validRequest } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Valid' });

  const now = new Date().toISOString();
  const userId = (await api('GET', '/api/auth/me', undefined, token)).body.user.id;
  await running.app.store.createPage({
    id: id(), workspace_id: workspaceId, parent_view_id: spaceId, title: 'Malformed', icon: null,
    extra: { is_database_container: true, database_id: 'not-a-uuid' }, layout: 1, is_favorite: false,
    document: {}, schema_version: 'appflowy-document-v1', creator_id: userId, version: 1,
    created_at: now, updated_at: now, position: { kind: 'start' },
  });

  const r = await getCatalog(token, workspaceId);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.databases.length, 1);
  assert.equal(r.body.data.databases[0].database_id, validRequest.database.database_id);
});

test('PostgreSQL mode: a container with no matching primary-view page is still included (container-only entry)', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-orphan');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-orphan');
  const orphanDatabaseId = id();
  const now = new Date().toISOString();
  const userId = (await api('GET', '/api/auth/me', undefined, token)).body.user.id;
  await running.app.store.createPage({
    id: id(), workspace_id: workspaceId, parent_view_id: spaceId, title: 'Orphan Grid', icon: null,
    extra: { is_database_container: true, database_id: orphanDatabaseId }, layout: 1, is_favorite: false,
    document: {}, schema_version: 'appflowy-document-v1', creator_id: userId, version: 1,
    created_at: now, updated_at: now, position: { kind: 'start' },
  });

  const r = await getCatalog(token, workspaceId);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.databases.length, 1);
  assert.equal(r.body.data.databases[0].database_id, orphanDatabaseId);
  assert.equal(r.body.data.databases[0].views.length, 1);
  assert.equal(r.body.data.databases[0].views[0].is_container, true);
});

test('PostgreSQL mode: a decoy child page with a mismatched database_id is never selected as the primary view', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-decoy');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-decoy');
  const { request } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Real' });
  const userId = (await api('GET', '/api/auth/me', undefined, token)).body.user.id;
  const now = new Date().toISOString();

  await running.app.store.createPage({
    id: id(), workspace_id: workspaceId, parent_view_id: request.container_id, title: 'Decoy', icon: null,
    extra: { database_id: id() }, layout: 1, is_favorite: false, document: {}, schema_version: 'appflowy-document-v1',
    creator_id: userId, version: 1, created_at: now, updated_at: now, position: { kind: 'start' },
  });

  const r = await getCatalog(token, workspaceId);
  const entry = r.body.data.databases.find((e) => e.database_id === request.database.database_id);
  assert.ok(entry);
  const primary = entry.views.find((v) => !v.is_container);
  assert.ok(primary);
  assert.equal(primary.view_id, request.database.view_id);
});

test('PostgreSQL mode regression: ordinary Document pages and Folder-tree navigation are unaffected', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-regression');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-regression');

  const docPage = { schema_version: 'v1', request_id: id(), view_id: id(), parent_view_id: spaceId, name: 'A Document', position: { kind: 'start' }, icon: null, extra: null, is_favorite: false };
  const createDoc = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/document/default`, docPage, token);
  assert.equal(createDoc.status, 200, JSON.stringify(createDoc.body));
  const docViewId = createDoc.body.data.result.view_id;

  await createGridDatabase(token, workspaceId, spaceId, { name: 'A Database' });

  const catalog = await getCatalog(token, workspaceId);
  const allViewIds = catalog.body.data.databases.flatMap((entry) => entry.views.map((v) => v.view_id));
  assert.ok(!allViewIds.includes(docViewId));

  const view = await api('GET', `/api/workspace/${workspaceId}/view/${spaceId}?depth=1`, undefined, token);
  assert.equal(view.status, 200);
  const childIds = view.body.data.children.map((c) => c.view_id);
  assert.ok(childIds.includes(docViewId));
  assert.equal(view.body.data.children.length, 2);
});

// Task 64 follow-on finding (see test/database-catalog.test.js for the full
// explanation): fixing the catalog alone makes a Database discoverable, but
// a real second-browser-context run showed it still could not be OPENED --
// AppFlowy-Web's view-loader cold-fetches via GET .../page-view/{viewId}
// whenever it has no locally cached Yjs doc, and that route required a
// Document collab object, which a Database container/primary-view page
// never has. PostgreSQL-mode parity for the fix.
test('PostgreSQL mode: GET page-view cold-fetches a Database primary-view page by serving the Database collab', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-page-view-primary');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-page-view-primary');
  const { request } = await createGridDatabase(token, workspaceId, spaceId, { name: 'ColdOpen' });

  const r = await api('GET', `/api/workspace/${workspaceId}/page-view/${request.database.view_id}`, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.view.view_id, request.database.view_id);
  assert.equal(r.body.data.view.layout, 1);

  const doc = new Y.Doc({ guid: request.database.database_id });
  try {
    Y.applyUpdate(doc, new Uint8Array(r.body.data.data.encoded_collab));
    assert.equal(doc.getMap('data').get('database').get('id'), request.database.database_id);
  } finally {
    doc.destroy();
  }
});

test('PostgreSQL mode: GET page-view cold-fetches a Database CONTAINER page by serving the same Database collab', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-page-view-container');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-page-view-container');
  const { request } = await createGridDatabase(token, workspaceId, spaceId, { name: 'ColdOpenContainer' });

  const r = await api('GET', `/api/workspace/${workspaceId}/page-view/${request.container_id}`, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.view.view_id, request.container_id);

  const doc = new Y.Doc({ guid: request.database.database_id });
  try {
    Y.applyUpdate(doc, new Uint8Array(r.body.data.data.encoded_collab));
    assert.equal(doc.getMap('data').get('database').get('id'), request.database.database_id);
  } finally {
    doc.destroy();
  }
});

test('PostgreSQL mode regression: GET page-view for an ordinary Document page is unaffected', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-page-view-doc-regression');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-page-view-doc-regression');
  const docPage = { schema_version: 'v1', request_id: id(), view_id: id(), parent_view_id: spaceId, name: 'Plain Doc', position: { kind: 'start' }, icon: null, extra: null, is_favorite: false };
  const createDoc = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/document/default`, docPage, token);
  assert.equal(createDoc.status, 200);
  const docViewId = createDoc.body.data.result.view_id;

  const r = await api('GET', `/api/workspace/${workspaceId}/page-view/${docViewId}`, undefined, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.view.view_id, docViewId);
  assert.equal(r.body.data.view.layout, 0);
  assert.ok(Array.isArray(r.body.data.data.encoded_collab) && r.body.data.data.encoded_collab.length > 0);
});

test('PostgreSQL mode: GET page-view returns COLLAB_NOT_FOUND when a Database page\'s referenced database collab is genuinely missing', { skip: !configured }, async () => {
  const { token, workspaceId } = await registerAndLogin('pg-page-view-missing-db-collab');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-page-view-missing-db-collab');
  const now = new Date().toISOString();
  const userId = (await api('GET', '/api/auth/me', undefined, token)).body.user.id;
  const orphanPageId = id();
  await running.app.store.createPage({
    id: orphanPageId, workspace_id: workspaceId, parent_view_id: spaceId, title: 'Dangling', icon: null,
    extra: { database_id: id() }, layout: 1, is_favorite: false, document: {}, schema_version: 'appflowy-document-v1',
    creator_id: userId, version: 1, created_at: now, updated_at: now, position: { kind: 'start' },
  });

  const r = await api('GET', `/api/workspace/${workspaceId}/page-view/${orphanPageId}`, undefined, token);
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'COLLAB_NOT_FOUND');
});
