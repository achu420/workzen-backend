// Generalizes Task 61's top-level "default Database page" creation route
// (POST .../v2/page-view/database/default) from Grid-only to every
// DatabaseViewLayout Task 72 already supports for an ADDITIONAL view
// (Board/Calendar/Chart/List/Gallery/Feed/Timeline), reusing the exact same
// buildView() recipe (database-document.js) for a database's first/primary
// view as for every view after it. Form (layout=7) remains out of scope
// (its companion "Responses" view is a distinct, materially larger
// feature) -- its rejection is covered in database-collab.test.js alongside
// the route's other malformed-request cases.
//
// Mirrors the exact test conventions already established in
// test/database-collab.test.js and test/database-view-collab.test.js (same
// api()/openDatabaseDoc() helper shapes).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { id } from '../auth.js';
import { startServer } from '../server.js';

let dir, running, base, dataFile;

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-database-top-level-views-'));
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

// DatabaseViewLayout (database.type.ts): Grid=0, Board=1, Calendar=2,
// Chart=3, List=4, Gallery=5, Feed=6, Form=7 (excluded), Timeline=8.
// FOLDER_LAYOUTS (database-document.js) maps each to the Folder-side
// ViewLayout: [1, 2, 3, 5, 6, 7, 8, 9, 10].
const FOLDER_LAYOUTS = [1, 2, 3, 5, 6, 7, 8, 9, 10];
// page-default-creation.ts: timezone_id is a real string only for
// Calendar/Timeline; initial_row_ids is always empty for
// Calendar/Timeline/Form (payload.layout withoutInitialRows list).
const TIMEZONE_LAYOUTS = new Set([2, 8]);
const NO_INITIAL_ROWS_LAYOUTS = new Set([2, 7, 8]);

function defaultDatabaseRequest({ parentViewId, layout, name }) {
  return {
    schema_version: 'v1',
    request_id: id(),
    parent_view_id: parentViewId,
    name: '',
    position: { kind: 'start' },
    container_id: id(),
    database: {
      database_id: id(),
      view_id: id(),
      name,
      layout,
      embedded: false,
      responses_view_id: null,
      initial_row_ids: NO_INITIAL_ROWS_LAYOUTS.has(layout) ? [] : [id(), id(), id()],
      timezone_id: TIMEZONE_LAYOUTS.has(layout) ? 'America/New_York' : null,
    },
  };
}

function openDatabaseDoc(docState, databaseId) {
  const doc = new Y.Doc({ guid: databaseId });
  Y.applyUpdate(doc, docState);
  return doc;
}

async function readDatabaseDoc(token, workspaceId, databaseId) {
  const collabRoute = `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`;
  const read = await api('GET', collabRoute, undefined, token);
  assert.equal(read.status, 200);
  return openDatabaseDoc(new Uint8Array(read.body.data.doc_state), databaseId);
}

const LAYOUT_NAMES = { 0: 'Grid', 1: 'Board', 2: 'Calendar', 3: 'Chart', 4: 'List', 5: 'Gallery', 6: 'Feed', 8: 'Timeline' };

for (const layout of [0, 1, 2, 3, 4, 5, 6, 8]) {
  test(`Top-level Database creation (${LAYOUT_NAMES[layout]}, layout=${layout}): creatable as a brand-new page, correct Folder mapping and Yjs view shape`, async () => {
    const { token, workspaceId } = await registerAndLogin(`top-level-${layout}`);
    const spaceId = await createPublicSpace(token, workspaceId, `top-level-${layout}`);
    const request = defaultDatabaseRequest({ parentViewId: spaceId, layout, name: LAYOUT_NAMES[layout] });

    const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
    assert.equal(response.status, 200, `${LAYOUT_NAMES[layout]} creation must be accepted`);
    assert.equal(response.body.data.outcome, 'applied');

    // Folder-tree mapping: both the container (sidebar entry) and the
    // primary-view child page must report FOLDER_LAYOUTS[layout], not the
    // previously-hardcoded Grid value (1) -- this is exactly what made
    // AppFlowy-Web's validateDatabase() (created-page-hydration.ts) reject
    // every non-Grid layout before this change.
    const viewRoute = `/api/workspace/${workspaceId}/view/${request.container_id}`;
    const containerView = await api('GET', viewRoute, undefined, token);
    assert.equal(containerView.status, 200);
    assert.equal(containerView.body.data.layout, FOLDER_LAYOUTS[layout], 'container page Folder layout must match the mapping');

    const primaryViewRoute = `/api/workspace/${workspaceId}/view/${request.database.view_id}`;
    const primaryView = await api('GET', primaryViewRoute, undefined, token);
    assert.equal(primaryView.status, 200);
    assert.equal(primaryView.body.data.layout, FOLDER_LAYOUTS[layout], 'primary-view page Folder layout must match the mapping');

    // The Yjs Database collab's own view must carry the real
    // DatabaseViewLayout value, be the inline/primary view, and never be
    // embedded (embedded is only meaningful for additional views).
    const doc = await readDatabaseDoc(token, workspaceId, request.database.database_id);
    const database = doc.getMap('data').get('database');
    const view = database.get('views').get(request.database.view_id);
    assert.equal(Number(view.get('layout')), layout);
    assert.equal(view.get('is_inline'), true);
    assert.equal(view.get('embedded'), false);
    assert.equal(database.get('metas').get('iid'), request.database.view_id);

    if (layout === 1) {
      // Board default-group fallback (buildDefaultBoardGroup,
      // database-document.js): a brand-new database has no Select/
      // Checkbox field to group by, only its primary RichText field --
      // this must still produce a non-empty group, not an unusable
      // single-column board (see that function's doc comment).
      const groups = view.get('groups');
      assert.equal(groups.length, 1);
      const group = groups.get(0);
      const fields = database.get('fields');
      assert.ok(fields.has(group.get('field_id')), 'board group field_id must reference a real field');
    }

    doc.destroy();
  });
}

test('Top-level Database creation: Form (layout=7) is rejected, matching the additional-view route', async () => {
  const { token, workspaceId } = await registerAndLogin('top-level-form');
  const spaceId = await createPublicSpace(token, workspaceId, 'top-level-form');
  const request = defaultDatabaseRequest({ parentViewId: spaceId, layout: 7, name: 'Form' });
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_ATOMIC_REQUEST');
});

test('Top-level Database creation: a non-string/non-null timezone_id is rejected', async () => {
  const { token, workspaceId } = await registerAndLogin('top-level-tz-invalid');
  const spaceId = await createPublicSpace(token, workspaceId, 'top-level-tz-invalid');
  const request = defaultDatabaseRequest({ parentViewId: spaceId, layout: 2, name: 'Calendar' });
  request.database.timezone_id = 12345;
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  assert.equal(response.status, 400);
});

test('Top-level Database creation: idempotent replay of a non-Grid layout (Board) is stable, not a duplicate', async () => {
  const { token, workspaceId } = await registerAndLogin('top-level-idem');
  const spaceId = await createPublicSpace(token, workspaceId, 'top-level-idem');
  const request = defaultDatabaseRequest({ parentViewId: spaceId, layout: 1, name: 'Board' });

  const first = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.outcome, 'applied');

  const replay = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.outcome, 'already_applied');
  assert.equal(replay.body.data.database_id, first.body.data.database_id);

  const differentBody = { ...request, name: 'A different name' };
  const conflicting = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, differentBody, token);
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.error.code, 'REQUEST_ID_REUSED');
});

test('Top-level Database creation: embedded:true (the real frontend payload shape) is accepted for a non-Grid layout too', async () => {
  const { token, workspaceId } = await registerAndLogin('top-level-embedded');
  const spaceId = await createPublicSpace(token, workspaceId, 'top-level-embedded');
  const request = defaultDatabaseRequest({ parentViewId: spaceId, layout: 4, name: 'List' });
  request.database.embedded = true;
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  assert.equal(response.status, 200);

  const doc = await readDatabaseDoc(token, workspaceId, request.database.database_id);
  const view = doc.getMap('data').get('database').get('views').get(request.database.view_id);
  // Downstream, the primary view's own embedded flag is always false
  // regardless of the request value (see buildView's isInline contract) --
  // confirms the request-level flag genuinely has no stored effect.
  assert.equal(view.get('embedded'), false);
  doc.destroy();
});
