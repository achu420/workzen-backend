// Task 64: JSON-storage-mode coverage for the real workspace Database
// catalog (`GET /api/workspace/{workspaceId}/database`), which previously
// returned a hardcoded `{ databases: [], has_more: false }` in both storage
// modes -- the confirmed root cause of Task 63's fresh-session navigation
// gap (a user who did not just create a Database in their own browser
// session could never discover it). Mirrors the HTTP helper conventions
// already established in test/database-collab.test.js (same `api()` shape,
// same `registerAndLogin`/`createPublicSpace`/`createGridDatabase` helpers).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { id } from '../auth.js';
import { startServer } from '../server.js';

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-database-catalog-'));
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
    // The container page's title (server.js: `containerPage.title = name`)
    // is set to the SAME display name as the database itself below, so a
    // test-supplied `name` consistently appears on both the container AND
    // the primary-view Folder entries, matching how AppFlowy-Web's real
    // client always sends one coherent name for both.
    name,
    position: { kind: 'start' },
    container_id: id(),
    database: {
      database_id: id(),
      view_id: id(),
      name,
      layout: 0,
      embedded: false,
      responses_view_id: null,
      initial_row_ids: [],
      timezone_id: null,
    },
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

test('empty workspace reports an empty, non-error catalog', async () => {
  const { token, workspaceId } = await registerAndLogin('empty');
  const r = await getCatalog(token, workspaceId);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { databases: [], has_more: false });
});

test('one Database is discoverable with correct container+primary-view association', async () => {
  const { token, workspaceId } = await registerAndLogin('one-db');
  const spaceId = await createPublicSpace(token, workspaceId, 'one-db');
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
  assert.ok(container, 'container view must be present');
  assert.ok(primary, 'primary view must be present');
  // Container and primary-view ids must NOT be interchangeable (Task 61/63
  // finding) -- they are two distinct page ids, and the catalog must report
  // the REAL ones from the actual creation request, not duplicate either.
  assert.equal(container.view_id, request.container_id);
  assert.equal(primary.view_id, request.database.view_id);
  assert.notEqual(container.view_id, primary.view_id);
  assert.equal(container.layout, 1); // Folder ViewLayout.Grid
  assert.equal(primary.layout, 1);
  assert.equal(container.embedded, false);
  assert.equal(primary.embedded, false);
  assert.equal(container.name, 'Tasks');
  assert.equal(primary.name, 'Tasks');
  assert.equal(primary.parent_view_id, container.view_id);
});

test('multiple Databases in the same workspace are all discoverable', async () => {
  const { token, workspaceId } = await registerAndLogin('multi-db');
  const spaceId = await createPublicSpace(token, workspaceId, 'multi-db');
  const { request: req1 } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Alpha' });
  const { request: req2 } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Beta' });
  const { request: req3 } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Gamma' });

  const r = await getCatalog(token, workspaceId);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.databases.length, 3);
  assert.equal(r.body.data.has_more, false);

  const ids = r.body.data.databases.map((entry) => entry.database_id).sort();
  const expected = [req1, req2, req3].map((r2) => r2.database.database_id).sort();
  assert.deepEqual(ids, expected);
});

test('a Database created by a fresh HTTP request is immediately visible to the catalog without any session-local state', async () => {
  // This is the exact gap Task 63 found: the catalog must reflect real
  // storage, not only what the CURRENT session happened to create. Simulate
  // "someone else created it" by using one token to create, and a SEPARATE
  // member (second registered user added to the same workspace) to read
  // the catalog back.
  const creator = await registerAndLogin('fresh-creator');
  const spaceId = await createPublicSpace(creator.token, creator.workspaceId, 'fresh');
  const { request } = await createGridDatabase(creator.token, creator.workspaceId, spaceId, { name: 'Shared Grid' });

  const secondMember = await registerAndLogin('fresh-member');
  const secondMemberEmail = (await api('GET', '/api/auth/me', undefined, secondMember.token)).body.user.email;

  // Add the second user as a real member of the creator's workspace via the
  // supported test-membership helper (same helper Task 61/62/63 used), then
  // confirm they can see the Database purely through the catalog endpoint --
  // never having created it themselves, in a completely separate session.
  const addMember = await api('POST', `/api/workspaces/${creator.workspaceId}/test-members`, {
    email: secondMemberEmail,
    role: 'member',
  }, creator.token, { 'x-development-key': 'test-key' });
  assert.equal(addMember.status, 201, JSON.stringify(addMember.body));

  const r = await getCatalog(secondMember.token, creator.workspaceId);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.databases.length, 1);
  assert.equal(r.body.data.databases[0].database_id, request.database.database_id);
});

test('cross-workspace isolation: a Database never appears in another workspace\'s catalog', async () => {
  const ownerA = await registerAndLogin('iso-a');
  const spaceA = await createPublicSpace(ownerA.token, ownerA.workspaceId, 'iso-a');
  await createGridDatabase(ownerA.token, ownerA.workspaceId, spaceA, { name: 'A-only' });

  const ownerB = await registerAndLogin('iso-b');
  const rB = await getCatalog(ownerB.token, ownerB.workspaceId);
  assert.equal(rB.status, 200);
  assert.deepEqual(rB.body.data, { databases: [], has_more: false });

  // And B must not be able to read A's catalog at all (not a member).
  const rBReadsA = await getCatalog(ownerB.token, ownerA.workspaceId);
  assert.equal(rBReadsA.status, 403);
});

test('unauthorized and unauthenticated access is rejected', async () => {
  const owner = await registerAndLogin('auth-owner');

  const noToken = await getCatalog(undefined, owner.workspaceId);
  assert.equal(noToken.status, 401);

  const stranger = await registerAndLogin('auth-stranger');
  const notAMember = await getCatalog(stranger.token, owner.workspaceId);
  assert.equal(notAMember.status, 403);
});

test('missing/invalid workspace id is rejected without leaking data', async () => {
  const owner = await registerAndLogin('missing-ws');
  const nonexistent = await getCatalog(owner.token, id());
  assert.equal(nonexistent.status, 403); // requireWorkspace's established convention (no distinct 404 for a workspace id)

  const malformed = await getCatalog(owner.token, 'not-a-real-workspace-id');
  assert.equal(malformed.status, 403);
});

test('pagination: offset/limit windows the database list with correct has_more and stable ordering', async () => {
  const { token, workspaceId } = await registerAndLogin('paginated');
  const spaceId = await createPublicSpace(token, workspaceId, 'paginated');
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

  // Repeated identical requests must return a stable order (no reshuffling
  // between calls against unchanged data).
  const repeat1 = await getCatalog(token, workspaceId, '?offset=0&limit=2');
  const repeat2 = await getCatalog(token, workspaceId, '?offset=0&limit=2');
  assert.deepEqual(repeat1.body.data.databases.map((e) => e.database_id), repeat2.body.data.databases.map((e) => e.database_id));
  assert.deepEqual(repeat1.body.data.databases.map((e) => e.database_id), page1.body.data.databases.map((e) => e.database_id));
});

test('invalid pagination parameters are rejected', async () => {
  const { token, workspaceId } = await registerAndLogin('bad-pagination');
  assert.equal((await getCatalog(token, workspaceId, '?offset=-1')).status, 400);
  assert.equal((await getCatalog(token, workspaceId, '?limit=0')).status, 400);
  assert.equal((await getCatalog(token, workspaceId, '?limit=100000')).status, 400);
  assert.equal((await getCatalog(token, workspaceId, '?offset=abc')).status, 400);
});

test('malformed container metadata (invalid database_id) is excluded without hiding other valid Databases', async () => {
  const { token, workspaceId } = await registerAndLogin('malformed');
  const spaceId = await createPublicSpace(token, workspaceId, 'malformed');
  const { request: validRequest } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Valid' });

  // Inject a malformed container page directly into storage -- this can
  // never be produced by the real creation route (it validates database_id
  // as a UUID before writing), but represents corrupted/legacy data the
  // read path must still handle defensively.
  const now = new Date().toISOString();
  await running.app.store.createPage({
    id: id(),
    workspace_id: workspaceId,
    parent_view_id: spaceId,
    title: 'Malformed',
    icon: null,
    extra: { is_database_container: true, database_id: 'not-a-uuid' },
    layout: 1,
    is_favorite: false,
    document: {},
    schema_version: 'appflowy-document-v1',
    creator_id: (await api('GET', '/api/auth/me', undefined, token)).body.user.id,
    version: 1,
    created_at: now,
    updated_at: now,
    position: { kind: 'start' },
  });

  const r = await getCatalog(token, workspaceId);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.databases.length, 1, 'the malformed entry must be excluded, and must not remove the valid one');
  assert.equal(r.body.data.databases[0].database_id, validRequest.database.database_id);
});

test('a container with no matching primary-view page is still included (container-only entry), not silently dropped', async () => {
  const { token, workspaceId } = await registerAndLogin('orphan');
  const spaceId = await createPublicSpace(token, workspaceId, 'orphan');
  const orphanDatabaseId = id();
  const now = new Date().toISOString();
  const userId = (await api('GET', '/api/auth/me', undefined, token)).body.user.id;
  await running.app.store.createPage({
    id: id(),
    workspace_id: workspaceId,
    parent_view_id: spaceId,
    title: 'Orphan Grid',
    icon: null,
    extra: { is_database_container: true, database_id: orphanDatabaseId },
    layout: 1,
    is_favorite: false,
    document: {},
    schema_version: 'appflowy-document-v1',
    creator_id: userId,
    version: 1,
    created_at: now,
    updated_at: now,
    position: { kind: 'start' },
  });

  const r = await getCatalog(token, workspaceId);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.databases.length, 1);
  assert.equal(r.body.data.databases[0].database_id, orphanDatabaseId);
  assert.equal(r.body.data.databases[0].views.length, 1);
  assert.equal(r.body.data.databases[0].views[0].is_container, true);
});

test('a decoy child page with a mismatched database_id is never selected as the primary view (invalid primary-view association)', async () => {
  const { token, workspaceId } = await registerAndLogin('decoy');
  const spaceId = await createPublicSpace(token, workspaceId, 'decoy');
  const { request } = await createGridDatabase(token, workspaceId, spaceId, { name: 'Real' });
  const userId = (await api('GET', '/api/auth/me', undefined, token)).body.user.id;
  const now = new Date().toISOString();

  // A page parented by the SAME container, but carrying a DIFFERENT
  // database_id in `extra` -- must never be mistaken for this database's
  // primary view.
  await running.app.store.createPage({
    id: id(),
    workspace_id: workspaceId,
    parent_view_id: request.container_id,
    title: 'Decoy',
    icon: null,
    extra: { database_id: id() },
    layout: 1,
    is_favorite: false,
    document: {},
    schema_version: 'appflowy-document-v1',
    creator_id: userId,
    version: 1,
    created_at: now,
    updated_at: now,
    position: { kind: 'start' },
  });

  const r = await getCatalog(token, workspaceId);
  const entry = r.body.data.databases.find((e) => e.database_id === request.database.database_id);
  assert.ok(entry, 'the real database must still be present');
  const primary = entry.views.find((v) => !v.is_container);
  assert.ok(primary, 'a real primary view must still be found');
  assert.equal(primary.view_id, request.database.view_id);
  assert.notEqual(primary.view_id, undefined);
});

test('regression: ordinary Document pages and Folder-tree navigation are unaffected by the catalog fix', async () => {
  const { token, workspaceId } = await registerAndLogin('regression');
  const spaceId = await createPublicSpace(token, workspaceId, 'regression');

  const docPage = {
    schema_version: 'v1',
    request_id: id(),
    view_id: id(),
    parent_view_id: spaceId,
    name: 'A Document',
    position: { kind: 'start' },
    icon: null,
    extra: null,
    is_favorite: false,
  };
  const createDoc = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/document/default`, docPage, token);
  assert.equal(createDoc.status, 200, JSON.stringify(createDoc.body));
  const docViewId = createDoc.body.data.result.view_id;

  await createGridDatabase(token, workspaceId, spaceId, { name: 'A Database' });

  // Document page must not appear in the Database catalog.
  const catalog = await getCatalog(token, workspaceId);
  const allViewIds = catalog.body.data.databases.flatMap((entry) => entry.views.map((v) => v.view_id));
  assert.ok(!allViewIds.includes(docViewId), 'a Document page must never appear in the Database catalog');

  // Folder tree must still show both the Document and the Database container.
  const view = await api('GET', `/api/workspace/${workspaceId}/view/${spaceId}?depth=1`, undefined, token);
  assert.equal(view.status, 200);
  const childIds = view.body.data.children.map((c) => c.view_id);
  assert.ok(childIds.includes(docViewId), 'Document page must still be visible in the Folder tree');
  assert.equal(view.body.data.children.length, 2); // the Document + the Database container
});

// Task 64 follow-on finding: fixing the catalog alone (above) makes a
// Database DISCOVERABLE for a fresh session, but a real second-browser-
// context verification (see docs/task64-evidence/) showed it still could
// not be OPENED: AppFlowy-Web's view-loader (view-loader.ts fetchAndApply)
// calls GET /api/workspace/{id}/page-view/{viewId} as the generic cold-load
// path for ANY view layout whenever it has no locally cached Yjs doc for
// that view (useViewOperations.ts only sets the alternate
// `databaseMetadataOnly` fetch path for secondary relation/rollup lookups,
// never for a view's own primary/cold load). Before this fix, that route
// required a Document collab object, which a Database container/primary-
// view page never has -- a 404 the frontend renders as a fatal "Page not
// found", masked in every single-session test because the creating client
// already had the Database cached locally from its own creation response.
test('GET page-view cold-fetches a Database primary-view page by serving the Database collab (no Document collab exists for it)', async () => {
  const { token, workspaceId } = await registerAndLogin('page-view-primary');
  const spaceId = await createPublicSpace(token, workspaceId, 'page-view-primary');
  const { request } = await createGridDatabase(token, workspaceId, spaceId, { name: 'ColdOpen' });

  const r = await api('GET', `/api/workspace/${workspaceId}/page-view/${request.database.view_id}`, undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.view.view_id, request.database.view_id);
  assert.equal(r.body.data.view.layout, 1); // Folder ViewLayout.Grid, not the old hardcoded 0

  const doc = new Y.Doc({ guid: request.database.database_id });
  try {
    Y.applyUpdate(doc, new Uint8Array(r.body.data.data.encoded_collab));
    const database = doc.getMap('data').get('database');
    assert.equal(database.get('id'), request.database.database_id, 'served bytes must decode to the REAL Database object, not an empty/Document payload');
  } finally {
    doc.destroy();
  }
});

test('GET page-view cold-fetches a Database CONTAINER page by serving the same Database collab', async () => {
  const { token, workspaceId } = await registerAndLogin('page-view-container');
  const spaceId = await createPublicSpace(token, workspaceId, 'page-view-container');
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

test('regression: GET page-view for an ordinary Document page is unaffected (still requires/serves the real Document collab)', async () => {
  const { token, workspaceId } = await registerAndLogin('page-view-doc-regression');
  const spaceId = await createPublicSpace(token, workspaceId, 'page-view-doc-regression');
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

test('GET page-view returns COLLAB_NOT_FOUND (not a Document 404) when a Database page\'s referenced database collab is genuinely missing', async () => {
  const { token, workspaceId } = await registerAndLogin('page-view-missing-db-collab');
  const spaceId = await createPublicSpace(token, workspaceId, 'page-view-missing-db-collab');
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
