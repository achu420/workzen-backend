// Task 63: PostgreSQL storage parity for the Database (Task 61) and
// DatabaseRow (Task 62) collaboration objects, plus the atomic row-creation
// transaction's concurrency/rollback correctness. Mirrors the direct-store
// call style of test/postgres-collab.test.js (Task 18) rather than going
// through HTTP, so the exact transactional semantics (idempotency, RID
// allocation, rollback) can be asserted precisely against real Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import * as Y from 'yjs';
import { openPostgresStore, postgresAtomicRowCreationTestHooks } from '../postgres-storage.js';
import { createInitialDatabaseCollab } from '../database-document.js';
import { createInitialDatabaseRowCollab } from '../database-row-document.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;

async function context(store) {
  const now = new Date();
  const user = { id: randomUUID(), uid: randomInt(1, 2 ** 48), email: `dbcollab-${randomUUID()}@example.test`, password_hash: 'synthetic', created_at: now };
  await store.saveUser(user);
  const workspaceId = randomUUID();
  const workspace = { id: workspaceId, name: 'task63-database-test', icon: '', database_storage_id: workspaceId, owner_id: user.id, created_at: now };
  await store.createWorkspace(workspace, { workspace_id: workspace.id, user_id: user.id, role: 'owner', created_at: now });
  const space = { id: randomUUID(), workspace_id: workspace.id, name: 'Shared', space_icon: '', space_icon_color: '', permission: { permission_type: 0 }, creator_id: user.id, created_at: now };
  await store.createSpace(space);
  return { user, workspace, space, now };
}

function makeDatabaseRequest({ workspaceId, spaceId, creatorId, now }) {
  const containerId = randomUUID();
  const databaseId = randomUUID();
  const viewId = randomUUID();
  const primaryFieldId = randomUUID();
  const timestamp = now.toISOString();
  const collab = createInitialDatabaseCollab({ databaseId, viewId, name: 'Grid', primaryFieldId, timestamp });
  const containerPage = {
    id: containerId, workspace_id: workspaceId, parent_view_id: spaceId, title: 'Grid',
    icon: null, extra: { is_database_container: true, database_id: databaseId }, layout: 1,
    is_favorite: false, creator_id: creatorId, version: 1, created_at: timestamp, updated_at: timestamp,
    position: { kind: 'start' },
  };
  const primaryViewPage = {
    id: viewId, workspace_id: workspaceId, parent_view_id: containerId, title: 'Grid',
    icon: null, extra: { database_id: databaseId }, layout: 1,
    is_favorite: false, creator_id: creatorId, version: 1, created_at: timestamp, updated_at: timestamp,
    position: { kind: 'start' },
  };
  return { containerPage, primaryViewPage, databaseId, viewId, collab, primaryFieldId };
}

async function createDatabase(store, ctx) {
  const built = makeDatabaseRequest({ workspaceId: ctx.workspace.id, spaceId: ctx.space.id, creatorId: ctx.user.id, now: ctx.now });
  const requestId = randomUUID();
  const digest = createHash('sha256').update(`body-${requestId}`).digest('hex');
  const result = await store.createAtomicDatabasePage(built.containerPage, built.primaryViewPage, built.databaseId, built.collab, { request_id: requestId, request_digest: digest });
  return { ...built, requestId, digest, result };
}

async function createRow(store, ctx, databaseId, viewId, { requestId, digest, rowId, position = { kind: 'end' }, cells = {} } = {}) {
  const rid = rowId || randomUUID();
  const timestamp = new Date().toISOString();
  const rowCollab = createInitialDatabaseRowCollab({ rowId: rid, databaseId, cells, height: 36, visibility: true, timestamp, actorUid: ctx.user.uid });
  const reqId = requestId || randomUUID();
  const reqDigest = digest || createHash('sha256').update(`row-body-${reqId}`).digest('hex');
  const updateBatchId = randomUUID();
  const result = await store.createAtomicDatabaseRow({
    workspaceId: ctx.workspace.id, databaseId, rowId: rid, sourceViewId: viewId, position, rowCollab,
    request: { request_id: reqId, request_digest: reqDigest, height: 36, timestamp, update_batch_id: updateBatchId },
  });
  return { rowId: rid, requestId: reqId, digest: reqDigest, updateBatchId, result, rowCollab };
}

function rowOrderIds(documentState, databaseId, viewId) {
  const doc = new Y.Doc({ guid: databaseId });
  try {
    Y.applyUpdate(doc, documentState);
    const view = doc.getMap('data').get('database').get('views').get(viewId);
    return view.get('row_orders').toArray().map((o) => o.id);
  } finally { doc.destroy(); }
}

test('Database (PostgreSQL): atomic creation, retrieval, update, idempotency, cross-workspace isolation, restart reconstruction', { skip: !configured }, async () => {
  let store = await openPostgresStore(process.env.DATABASE_URL);
  try {
    const ctx = await context(store);
    const created = await createDatabase(store, ctx);
    assert.equal(created.result.outcome, 'applied');
    assert.equal(created.result.result.database_id, created.databaseId);

    // Duplicate-request_id + identical payload replay: same outcome, no new object.
    const replay = await store.createAtomicDatabasePage(created.containerPage, created.primaryViewPage, created.databaseId, created.collab, { request_id: created.requestId, request_digest: created.digest });
    assert.equal(replay.outcome, 'already_applied');
    assert.equal(replay.result.database_id, created.databaseId);

    // Same request_id, different digest -> rejected, no mutation.
    await assert.rejects(
      store.createAtomicDatabasePage(created.containerPage, created.primaryViewPage, created.databaseId, created.collab, { request_id: created.requestId, request_digest: 'different-digest' }),
      (e) => e.code === 'REQUEST_ID_REUSED'
    );

    const collab = await store.getDatabaseCollab(ctx.workspace.id, created.databaseId);
    assert.ok(collab);
    assert.equal(collab.collab_version, 'appflowy-database-v1');
    const doc = new Y.Doc({ guid: created.databaseId });
    Y.applyUpdate(doc, collab.doc_state);
    assert.equal(doc.getMap('data').get('database').get('id'), created.databaseId);
    doc.destroy();

    // Cross-workspace rejection.
    assert.equal(await store.getDatabaseCollab(randomUUID(), created.databaseId), null);

    // Ordinary Database Yjs update (e.g. field rename) through the generic
    // acceptDatabaseCollabUpdate path, reusing preparePageCollabUpdate.
    const client = new Y.Doc({ guid: created.databaseId });
    Y.applyUpdate(client, collab.doc_state);
    client.getMap('data').get('database').get('fields').get(created.primaryFieldId).set('name', 'Title');
    const update = Y.encodeStateAsUpdate(client, collab.state_vector);
    const accepted = await store.acceptDatabaseCollabUpdate({ workspaceId: ctx.workspace.id, databaseId: created.databaseId, flags: 0, payload: update, beforeStateVector: collab.state_vector, collabVersion: 'appflowy-database-v1', restoreId: null, messageKey: 'task63-field-rename' });
    assert.equal(accepted.status, 'applied');
    assert.ok(accepted.messageId.timestamp > 0);
    const duplicate = await store.acceptDatabaseCollabUpdate({ workspaceId: ctx.workspace.id, databaseId: created.databaseId, flags: 0, payload: update, beforeStateVector: collab.state_vector, collabVersion: 'appflowy-database-v1', restoreId: null, messageKey: 'task63-field-rename' });
    assert.equal(duplicate.status, 'duplicate');
    assert.deepEqual(duplicate.messageId, accepted.messageId);

    await store.close();
    store = await openPostgresStore(process.env.DATABASE_URL);
    const reloaded = await store.getDatabaseCollab(ctx.workspace.id, created.databaseId);
    const restartDoc = new Y.Doc({ guid: created.databaseId });
    Y.applyUpdate(restartDoc, reloaded.doc_state);
    assert.equal(restartDoc.getMap('data').get('database').get('fields').get(created.primaryFieldId).get('name'), 'Title');
    restartDoc.destroy();
  } finally { await store.close(); }
});

test('DatabaseRow (PostgreSQL): atomic creation mutates parent row_orders, is independently retrievable with collab_version null, restarts reconstruct correctly, cross-workspace rejected', { skip: !configured }, async () => {
  let store = await openPostgresStore(process.env.DATABASE_URL);
  try {
    const ctx = await context(store);
    const db = await createDatabase(store, ctx);

    const row1 = await createRow(store, ctx, db.databaseId, db.viewId, { cells: { [db.primaryFieldId]: { data: 'first row' } } });
    assert.equal(row1.result.outcome, 'applied');
    assert.ok(row1.result.database_update instanceof Uint8Array);
    assert.equal(row1.result.update_batch_id, row1.updateBatchId);

    const rowCollab = await store.getDatabaseRowCollab(ctx.workspace.id, row1.rowId);
    assert.ok(rowCollab);
    assert.equal(rowCollab.collab_version, null, 'DatabaseRow reads must report collab_version: null');
    const rowDoc = new Y.Doc({ guid: row1.rowId });
    Y.applyUpdate(rowDoc, rowCollab.doc_state);
    const rowData = rowDoc.getMap('data').get('data');
    assert.equal(rowData.get('id'), row1.rowId);
    assert.equal(rowData.get('database_id'), db.databaseId);
    assert.equal(rowData.get('cells').get(db.primaryFieldId).get('data'), 'first row');
    rowDoc.destroy();

    const parentAfter = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    assert.deepEqual(rowOrderIds(parentAfter.doc_state, db.databaseId, db.viewId), [row1.rowId]);

    // Second row at the end, then a third inserted at the start.
    const row2 = await createRow(store, ctx, db.databaseId, db.viewId, { position: { kind: 'end' }, cells: { [db.primaryFieldId]: { data: 'second row' } } });
    const row3 = await createRow(store, ctx, db.databaseId, db.viewId, { position: { kind: 'start' }, cells: { [db.primaryFieldId]: { data: 'third row (start)' } } });
    let parent = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    assert.deepEqual(rowOrderIds(parent.doc_state, db.databaseId, db.viewId), [row3.rowId, row1.rowId, row2.rowId]);

    // Position relative to an anchor ("after" row1).
    const row4 = await createRow(store, ctx, db.databaseId, db.viewId, { position: { kind: 'after', row_id: row1.rowId }, cells: {} });
    parent = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    assert.deepEqual(rowOrderIds(parent.doc_state, db.databaseId, db.viewId), [row3.rowId, row1.rowId, row4.rowId, row2.rowId]);

    // Invalid position anchor (nonexistent row_id) falls back to end, same as JSON mode.
    const row5 = await createRow(store, ctx, db.databaseId, db.viewId, { position: { kind: 'after', row_id: randomUUID() }, cells: {} });
    parent = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    assert.deepEqual(rowOrderIds(parent.doc_state, db.databaseId, db.viewId), [row3.rowId, row1.rowId, row4.rowId, row2.rowId, row5.rowId]);

    // Generic Yjs cell update on an existing DatabaseRow.
    const before = await store.getDatabaseRowCollab(ctx.workspace.id, row1.rowId);
    const editDoc = new Y.Doc({ guid: row1.rowId }); Y.applyUpdate(editDoc, before.doc_state);
    editDoc.getMap('data').get('data').get('cells').get(db.primaryFieldId).set('data', 'edited first row');
    const cellUpdate = Y.encodeStateAsUpdate(editDoc, before.state_vector);
    const acceptedCell = await store.acceptDatabaseRowCollabUpdate({ workspaceId: ctx.workspace.id, rowId: row1.rowId, flags: 0, payload: cellUpdate, beforeStateVector: before.state_vector, collabVersion: null, restoreId: null, messageKey: 'task63-cell-edit' });
    assert.equal(acceptedCell.status, 'applied');
    const dupCell = await store.acceptDatabaseRowCollabUpdate({ workspaceId: ctx.workspace.id, rowId: row1.rowId, flags: 0, payload: cellUpdate, beforeStateVector: before.state_vector, collabVersion: null, restoreId: null, messageKey: 'task63-cell-edit' });
    assert.equal(dupCell.status, 'duplicate');
    assert.deepEqual(dupCell.messageId, acceptedCell.messageId);

    // Cross-workspace rejection.
    assert.equal(await store.getDatabaseRowCollab(randomUUID(), row1.rowId), null);

    await store.close();
    store = await openPostgresStore(process.env.DATABASE_URL);
    const reloadedRow = await store.getDatabaseRowCollab(ctx.workspace.id, row1.rowId);
    assert.equal(reloadedRow.collab_version, null);
    const reloadedDoc = new Y.Doc({ guid: row1.rowId }); Y.applyUpdate(reloadedDoc, reloadedRow.doc_state);
    assert.equal(reloadedDoc.getMap('data').get('data').get('cells').get(db.primaryFieldId).get('data'), 'edited first row');
    reloadedDoc.destroy();
    const reloadedParent = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    assert.deepEqual(rowOrderIds(reloadedParent.doc_state, db.databaseId, db.viewId), [row3.rowId, row1.rowId, row4.rowId, row2.rowId, row5.rowId]);
  } finally { await store.close(); }
});

test('Atomic row creation (PostgreSQL): idempotent replay has a stable update_batch_id, request_id reuse with a different payload is rejected, unknown database/view are rejected', { skip: !configured }, async () => {
  const store = await openPostgresStore(process.env.DATABASE_URL);
  try {
    const ctx = await context(store);
    const db = await createDatabase(store, ctx);
    const row = await createRow(store, ctx, db.databaseId, db.viewId);
    assert.equal(row.result.outcome, 'applied');

    // Sequential identical replay (SAME request params) -> same update_batch_id and row_id, no new row.
    const replayResult = await (async () => {
      const rowCollab = createInitialDatabaseRowCollab({ rowId: row.rowId, databaseId: db.databaseId, cells: {}, height: 36, visibility: true, timestamp: new Date().toISOString(), actorUid: ctx.user.uid });
      return store.createAtomicDatabaseRow({
        workspaceId: ctx.workspace.id, databaseId: db.databaseId, rowId: row.rowId, sourceViewId: db.viewId, position: { kind: 'end' }, rowCollab,
        request: { request_id: row.requestId, request_digest: row.digest, height: 36, timestamp: new Date().toISOString(), update_batch_id: randomUUID() },
      });
    })();
    assert.equal(replayResult.outcome, 'already_applied');
    assert.equal(replayResult.row_id, row.rowId);
    assert.equal(replayResult.update_batch_id, row.updateBatchId, 'replay must return the ORIGINAL update_batch_id, not a new one');

    // Same request_id, different digest -> rejected.
    await assert.rejects(
      store.createAtomicDatabaseRow({
        workspaceId: ctx.workspace.id, databaseId: db.databaseId, rowId: row.rowId, sourceViewId: db.viewId, position: { kind: 'end' },
        rowCollab: createInitialDatabaseRowCollab({ rowId: row.rowId, databaseId: db.databaseId, cells: {}, height: 36, visibility: true, timestamp: new Date().toISOString() }),
        request: { request_id: row.requestId, request_digest: 'a-different-digest', height: 36, timestamp: new Date().toISOString(), update_batch_id: randomUUID() },
      }),
      (e) => e.code === 'REQUEST_ID_REUSED'
    );

    // Unknown parent database.
    await assert.rejects(
      createRow(store, ctx, randomUUID(), db.viewId),
      (e) => e.code === 'DATABASE_NOT_FOUND'
    );

    // Unknown source view on a real database.
    await assert.rejects(
      createRow(store, ctx, db.databaseId, randomUUID()),
      (e) => e.code === 'VIEW_NOT_FOUND'
    );

    // Row-id collision (genuinely different request_id/digest using an
    // already-used row_id) is rejected and leaves no partial state.
    await assert.rejects(
      createRow(store, ctx, db.databaseId, db.viewId, { rowId: row.rowId }),
      (e) => e.code === 'ROW_EXISTS'
    );
    const parentAfterCollision = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    assert.deepEqual(rowOrderIds(parentAfterCollision.doc_state, db.databaseId, db.viewId), [row.rowId], 'a rejected row_id collision must not have mutated row_orders');
  } finally { await store.close(); }
});

test('Atomic row creation (PostgreSQL): transaction rollback via fault injection leaves no partial state at every checkpoint, and a subsequent retry succeeds', { skip: !configured }, async () => {
  const store = await openPostgresStore(process.env.DATABASE_URL);
  try {
    const ctx = await context(store);
    const db = await createDatabase(store, ctx);
    const checkpoints = ['after_claim', 'after_parent_loaded', 'after_row_order_mutation', 'after_row_doc_inserted', 'before_receipt_insert', 'before_commit'];
    for (const checkpoint of checkpoints) {
      postgresAtomicRowCreationTestHooks.throwAt = checkpoint;
      const rowId = randomUUID();
      const requestId = randomUUID();
      const digest = createHash('sha256').update(`fault-${checkpoint}`).digest('hex');
      await assert.rejects(
        createRow(store, ctx, db.databaseId, db.viewId, { rowId, requestId, digest }),
        (e) => e.message.includes(checkpoint) || e.code === 'TEST_INJECTED_FAULT',
        `checkpoint ${checkpoint} should have thrown`
      );
      postgresAtomicRowCreationTestHooks.throwAt = null;

      // No partial row document.
      assert.equal(await store.getDatabaseRowCollab(ctx.workspace.id, rowId), null, `checkpoint ${checkpoint}: row document must not exist after rollback`);
      // No partial row_orders mutation.
      const parent = await store.getDatabaseCollab(ctx.workspace.id, db.databaseId);
      assert.ok(!rowOrderIds(parent.doc_state, db.databaseId, db.viewId).includes(rowId), `checkpoint ${checkpoint}: row_orders must not contain the rolled-back row`);
      // No success-indicating idempotency receipt.
      const receipt = await store.pool.query('SELECT database_update FROM atomic_row_creation_requests WHERE request_id=$1', [requestId]);
      assert.equal(receipt.rowCount, 0, `checkpoint ${checkpoint}: no idempotency receipt row of any kind must survive the rollback`);

      // A fresh retry with the SAME request (no fault this time) succeeds.
      const retry = await createRow(store, ctx, db.databaseId, db.viewId, { rowId, requestId, digest });
      assert.equal(retry.result.outcome, 'applied', `checkpoint ${checkpoint}: retry after rollback must succeed`);
      assert.ok(await store.getDatabaseRowCollab(ctx.workspace.id, rowId));
    }
  } finally {
    postgresAtomicRowCreationTestHooks.throwAt = null;
    await store.close();
  }
});

test('Atomic row creation (PostgreSQL): true concurrency -- independent rows, same-request-id races, and conflicting request_ids', { skip: !configured }, async () => {
  const storeA = await openPostgresStore(process.env.DATABASE_URL);
  const storeB = await openPostgresStore(process.env.DATABASE_URL);
  try {
    const ctx = await context(storeA);
    const db = await createDatabase(storeA, ctx);

    // (a) Two different rows concurrently at the end, from two independent
    // connections -- no lost row-order entries, deterministic valid result.
    const rowIdX = randomUUID(); const rowIdY = randomUUID();
    const [resX, resY] = await Promise.all([
      createRow(storeA, ctx, db.databaseId, db.viewId, { rowId: rowIdX, position: { kind: 'end' } }),
      createRow(storeB, ctx, db.databaseId, db.viewId, { rowId: rowIdY, position: { kind: 'end' } }),
    ]);
    assert.equal(resX.result.outcome, 'applied'); assert.equal(resY.result.outcome, 'applied');
    let parent = await storeA.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    let orders = rowOrderIds(parent.doc_state, db.databaseId, db.viewId);
    assert.equal(orders.length, 2);
    assert.ok(orders.includes(rowIdX) && orders.includes(rowIdY), 'both concurrently created rows must be present, in some valid order');

    // (b) Multiple rows inserted at the START concurrently -- all land, none lost.
    const startIds = [randomUUID(), randomUUID(), randomUUID()];
    await Promise.all(startIds.map((id) => createRow(storeA, ctx, db.databaseId, db.viewId, { rowId: id, position: { kind: 'start' } })));
    parent = await storeA.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    orders = rowOrderIds(parent.doc_state, db.databaseId, db.viewId);
    assert.equal(orders.length, 5);
    for (const id of startIds) assert.ok(orders.includes(id));

    // (c) Two concurrent IDENTICAL requests (same request_id, same payload)
    // from two independent connections -- exactly one logical creation, both
    // callers get the same committed receipt and update_batch_id.
    const sameRowId = randomUUID(); const sameRequestId = randomUUID(); const sameDigest = createHash('sha256').update('identical-concurrent').digest('hex');
    const identicalResults = await Promise.allSettled([
      createRow(storeA, ctx, db.databaseId, db.viewId, { rowId: sameRowId, requestId: sameRequestId, digest: sameDigest, position: { kind: 'end' } }),
      createRow(storeB, ctx, db.databaseId, db.viewId, { rowId: sameRowId, requestId: sameRequestId, digest: sameDigest, position: { kind: 'end' } }),
    ]);
    assert.ok(identicalResults.every((r) => r.status === 'fulfilled'), 'both identical concurrent callers must receive a successful result, not an error');
    const batchIds = identicalResults.map((r) => r.value.result.update_batch_id);
    assert.equal(batchIds[0], batchIds[1], 'both callers must observe the SAME stable update_batch_id');
    const outcomes = identicalResults.map((r) => r.value.result.outcome).sort();
    assert.deepEqual(outcomes, ['already_applied', 'applied'], 'exactly one of the two concurrent identical callers performed the real creation');
    parent = await storeA.getDatabaseCollab(ctx.workspace.id, db.databaseId);
    orders = rowOrderIds(parent.doc_state, db.databaseId, db.viewId);
    assert.equal(orders.filter((id) => id === sameRowId).length, 1, 'the row must appear exactly once in row_orders, never duplicated');

    // (d) Two concurrent requests with the SAME request_id but DIFFERENT
    // payloads -- exactly one succeeds (whichever claims the request_id
    // first), the other is rejected as REQUEST_ID_REUSED, never silently
    // accepted as a different row.
    const conflictRequestId = randomUUID();
    const conflictResults = await Promise.allSettled([
      createRow(storeA, ctx, db.databaseId, db.viewId, { requestId: conflictRequestId, digest: createHash('sha256').update('conflict-a').digest('hex'), position: { kind: 'end' } }),
      createRow(storeB, ctx, db.databaseId, db.viewId, { requestId: conflictRequestId, digest: createHash('sha256').update('conflict-b').digest('hex'), position: { kind: 'end' } }),
    ]);
    const fulfilled = conflictResults.filter((r) => r.status === 'fulfilled');
    const rejected = conflictResults.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one conflicting-payload request sharing a request_id must succeed');
    assert.equal(rejected.length, 1, 'exactly one must be rejected');
    assert.equal(rejected[0].reason.code, 'REQUEST_ID_REUSED');
  } finally { await storeA.close(); await storeB.close(); }
});
