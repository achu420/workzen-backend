// Task 72: PostgreSQL storage parity for createAtomicDatabaseView (the one
// confirmed backend gap found by this task's discovery; see
// docs/TASK72_DATABASE_VIEWS_DISCOVERY.md). Mirrors the direct-store-call
// convention established in test/postgres-database-collab.test.js (Task 63)
// -- same context()/createDatabase() helpers reused verbatim -- so the
// exact same transactional/idempotency contract already proven for JSON
// mode (test/database-view-collab.test.js) is proven again against real
// Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import * as Y from 'yjs';
import { openPostgresStore } from '../postgres-storage.js';
import { createInitialDatabaseCollab } from '../database-document.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;

async function context(store) {
  const now = new Date();
  const user = { id: randomUUID(), uid: randomInt(1, 2 ** 48), email: `dbview-${randomUUID()}@example.test`, password_hash: 'synthetic', created_at: now };
  await store.saveUser(user);
  const workspaceId = randomUUID();
  const workspace = { id: workspaceId, name: 'task72-database-view-test', icon: '', database_storage_id: workspaceId, owner_id: user.id, created_at: now };
  await store.createWorkspace(workspace, { workspace_id: workspace.id, user_id: user.id, role: 'owner', created_at: now });
  const space = { id: randomUUID(), workspace_id: workspace.id, name: 'Shared', space_icon: '', space_icon_color: '', permission: { permission_type: 0 }, creator_id: user.id, created_at: now };
  await store.createSpace(space);
  return { user, workspace, space, now };
}

async function createDatabase(store, ctx) {
  const containerId = randomUUID();
  const databaseId = randomUUID();
  const viewId = randomUUID();
  const primaryFieldId = randomUUID();
  const timestamp = ctx.now.toISOString();
  const collab = createInitialDatabaseCollab({ databaseId, viewId, name: 'Grid', primaryFieldId, timestamp });
  const containerPage = {
    id: containerId, workspace_id: ctx.workspace.id, parent_view_id: ctx.space.id, title: 'Grid',
    icon: null, extra: { is_database_container: true, database_id: databaseId }, layout: 1,
    is_favorite: false, creator_id: ctx.user.id, version: 1, created_at: timestamp, updated_at: timestamp,
    position: { kind: 'start' },
  };
  const primaryViewPage = {
    id: viewId, workspace_id: ctx.workspace.id, parent_view_id: containerId, title: 'Grid',
    icon: null, extra: { database_id: databaseId }, layout: 1,
    is_favorite: false, creator_id: ctx.user.id, version: 1, created_at: timestamp, updated_at: timestamp,
    position: { kind: 'start' },
  };
  const requestId = randomUUID();
  const digest = createHash('sha256').update(`body-${requestId}`).digest('hex');
  await store.createAtomicDatabasePage(containerPage, primaryViewPage, databaseId, collab, { request_id: requestId, request_digest: digest });
  return { containerId, databaseId, primaryViewId: viewId, primaryFieldId, timestamp };
}

function openDoc(docState, databaseId) {
  const doc = new Y.Doc({ guid: databaseId });
  Y.applyUpdate(doc, docState);
  return doc;
}

async function createView(store, ctx, db, { requestId, viewId, sourceViewId, layout = 1, name = 'Board', embedded = false } = {}) {
  const timestamp = new Date().toISOString();
  const rid = requestId || randomUUID();
  const vid = viewId || randomUUID();
  const digest = createHash('sha256').update(`view-body-${rid}`).digest('hex');
  const page = {
    id: vid, workspace_id: ctx.workspace.id, parent_view_id: db.containerId, title: name,
    icon: null, extra: { database_id: db.databaseId }, layout: layout === 1 ? 2 : (layout === 0 ? 1 : 3),
    is_favorite: false, creator_id: ctx.user.id, version: 1, created_at: timestamp, updated_at: timestamp,
    position: { kind: 'end' },
  };
  const result = await store.createAtomicDatabaseView({
    workspaceId: ctx.workspace.id, databaseId: db.databaseId, viewId: vid, sourceViewId: sourceViewId ?? null,
    layout, name, embedded, timestamp, page, request: { request_id: rid, request_digest: digest, update_batch_id: randomUUID() },
  });
  return { ...result, viewId: vid, requestId: rid, digest, page };
}

test('Database view (PostgreSQL): atomic creation clones config from source_view_id, maps Folder layout, idempotent replay, restart reconstruction', { skip: !configured }, async () => {
  let store = await openPostgresStore(process.env.DATABASE_URL);
  try {
    const ctx = await context(store);
    const db = await createDatabase(store, ctx);

    // Seed a filter on the primary view directly via the store (mirrors
    // the generic Database collab-update path's effect without going
    // through WS, since this file tests storage-layer parity, not the
    // WS protocol -- that is covered by test/database-view-collab.test.js).
    {
      const collab = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
      const doc = openDoc(collab.doc_state, db.databaseId);
      const database = doc.getMap('data').get('database');
      const view = database.get('views').get(db.primaryViewId);
      const beforeSv = Y.encodeStateVector(doc);
      const filter = new Y.Map();
      filter.set('id', randomUUID());
      filter.set('field_id', db.primaryFieldId);
      filter.set('content', 'pg-seed-filter');
      view.get('filters').push([filter]);
      const payload = Y.encodeStateAsUpdate(doc, beforeSv);
      await store.acceptDatabaseCollabUpdate({
        workspaceId: ctx.workspace.id, databaseId: db.databaseId, flags: 0, payload, beforeStateVector: beforeSv,
        collabVersion: collab.collab_version, restoreId: null,
      });
      doc.destroy();
    }

    const created = await createView(store, ctx, db, { sourceViewId: db.primaryViewId, layout: 1, name: 'Board' });
    assert.equal(created.outcome, 'applied');
    assert.equal(created.view_id, created.viewId);
    // AppFlowy-Web's own atomic-creation journal requires a real,
    // non-empty Yjs diff update plus a stable update_batch_id -- same
    // discovery as the JSON-mode test, now proven for Postgres too.
    assert.ok(created.database_update instanceof Uint8Array && created.database_update.length > 0);
    assert.ok(typeof created.update_batch_id === 'string' && created.update_batch_id.length > 0);

    const collabAfter = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    const doc = openDoc(collabAfter.doc_state, db.databaseId);
    try {
      const database = doc.getMap('data').get('database');
      const views = database.get('views');
      assert.equal(views.size, 2, 'primary view plus the new Board view');
      const boardView = views.get(created.viewId);
      assert.equal(boardView.get('layout'), 1);
      assert.equal(boardView.get('is_inline'), false);
      assert.equal(boardView.get('filters').length, 1, 'filters cloned from source_view_id');
      assert.equal(boardView.get('filters').get(0).get('content'), 'pg-seed-filter');
      const groups = boardView.get('groups');
      assert.ok(groups.length > 0, 'new Board view has a non-empty default group');
      assert.ok(database.get('fields').has(groups.get(0).get('field_id')));
      assert.equal(views.get(db.primaryViewId).get('filters').length, 1, "primary view's own filters are unaffected by cloning");
    } finally {
      doc.destroy();
    }

    const page = await store.getPage(created.viewId);
    assert.ok(page, 'the new view must have a real Folder-tree page row');
    assert.equal(page.parent_view_id, db.containerId);
    assert.equal(page.layout, 2, 'ViewLayout.Board = 2 (Folder-side enum)');
    assert.equal(page.extra.database_id, db.databaseId);

    // Idempotent replay with the SAME request_id + digest.
    const replay = await store.createAtomicDatabaseView({
      workspaceId: ctx.workspace.id, databaseId: db.databaseId, viewId: created.viewId, sourceViewId: db.primaryViewId,
      layout: 1, name: 'Board', embedded: false, timestamp: new Date().toISOString(), page: created.page,
      request: { request_id: created.requestId, request_digest: created.digest, update_batch_id: created.update_batch_id ?? randomUUID() },
    });
    assert.equal(replay.outcome, 'already_applied');
    assert.equal(replay.view_id, created.viewId);
    assert.equal(replay.update_batch_id, created.update_batch_id, 'a replay must return the SAME update_batch_id, not a freshly generated one');
    assert.deepEqual(Buffer.from(replay.database_update), Buffer.from(created.database_update), 'a replay must return the identical stored diff, not recompute it');

    // A different body under the SAME request_id must be rejected.
    await assert.rejects(
      store.createAtomicDatabaseView({
        workspaceId: ctx.workspace.id, databaseId: db.databaseId, viewId: randomUUID(), sourceViewId: db.primaryViewId,
        layout: 1, name: 'Board', embedded: false, timestamp: new Date().toISOString(), page: { ...created.page, id: randomUUID() },
        request: { request_id: created.requestId, request_digest: 'a-different-digest', update_batch_id: randomUUID() },
      }),
      (error) => error.code === 'REQUEST_ID_REUSED'
    );

    // Restart reconstruction: close and reopen the store against the same
    // real Postgres database, confirm both views survive with correct
    // independent config.
    await store.close();
    store = await openPostgresStore(process.env.DATABASE_URL);
    const reopened = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    const reopenedDoc = openDoc(reopened.doc_state, db.databaseId);
    try {
      const views = reopenedDoc.getMap('data').get('database').get('views');
      assert.equal(views.size, 2, 'both views survive a restart');
      assert.equal(views.get(created.viewId).get('layout'), 1);
      assert.equal(views.get(db.primaryViewId).get('layout'), 0);
    } finally {
      reopenedDoc.destroy();
    }
  } finally {
    await store.close();
  }
});

test('Database view (PostgreSQL): unknown source_view_id and unknown database_id are rejected without partial writes', { skip: !configured }, async () => {
  const store = await openPostgresStore(process.env.DATABASE_URL);
  try {
    const ctx = await context(store);
    const db = await createDatabase(store, ctx);

    await assert.rejects(
      createView(store, ctx, db, { sourceViewId: randomUUID(), layout: 1 }),
      (error) => error.code === 'VIEW_NOT_FOUND'
    );
    await assert.rejects(
      store.createAtomicDatabaseView({
        workspaceId: ctx.workspace.id, databaseId: randomUUID(), viewId: randomUUID(), sourceViewId: null,
        layout: 0, name: 'Grid', embedded: false, timestamp: new Date().toISOString(),
        page: { id: randomUUID(), workspace_id: ctx.workspace.id, parent_view_id: db.containerId, title: 'Grid', icon: null, extra: {}, layout: 1, is_favorite: false, creator_id: ctx.user.id, version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), position: { kind: 'end' } },
        request: { request_id: randomUUID(), request_digest: 'x', update_batch_id: randomUUID() },
      }),
      (error) => error.code === 'DATABASE_NOT_FOUND'
    );

    // No partial view was left behind by either rejected attempt.
    const collab = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    const doc = openDoc(collab.doc_state, db.databaseId);
    try {
      assert.equal(doc.getMap('data').get('database').get('views').size, 1, 'only the original primary view exists');
    } finally {
      doc.destroy();
    }
  } finally {
    await store.close();
  }
});

test('Database view (PostgreSQL): JSON/Postgres logical parity -- identical operation sequence produces an identical fingerprint', { skip: !configured }, async () => {
  const { openStore } = await import('../storage.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-view-parity-'));
  const jsonStore = await openStore(path.join(dir, 'state.json'), {});
  const pgStore = await openPostgresStore(process.env.DATABASE_URL);
  try {
    async function run(store) {
      const ctx = await context(store);
      const db = await createDatabase(store, ctx);
      const created = await createView(store, ctx, db, { sourceViewId: db.primaryViewId, layout: 1, name: 'Board' });
      const replay = await store.createAtomicDatabaseView({
        workspaceId: ctx.workspace.id, databaseId: db.databaseId, viewId: created.viewId, sourceViewId: db.primaryViewId,
        layout: 1, name: 'Board', embedded: false, timestamp: new Date().toISOString(), page: created.page,
        request: { request_id: created.requestId, request_digest: created.digest, update_batch_id: created.update_batch_id ?? randomUUID() },
      });
      const collab = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
      const doc = openDoc(collab.doc_state, db.databaseId);
      const views = doc.getMap('data').get('database').get('views');
      const fingerprint = {
        createOutcome: created.outcome, replayOutcome: replay.outcome, viewsSize: views.size,
        boardLayout: Number(views.get(created.viewId).get('layout')), boardIsInline: views.get(created.viewId).get('is_inline'),
        boardGroupsNonEmpty: views.get(created.viewId).get('groups').length > 0,
      };
      doc.destroy();
      return fingerprint;
    }
    const jsonFingerprint = await run(jsonStore);
    const pgFingerprint = await run(pgStore);
    console.log('JSON fingerprint:', JSON.stringify(jsonFingerprint));
    console.log('Postgres fingerprint:', JSON.stringify(pgFingerprint));
    assert.deepEqual(jsonFingerprint, pgFingerprint);
  } finally {
    await pgStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});
