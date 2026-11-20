// Task 63: JSON/PostgreSQL behavioral parity harness. Runs the SAME logical
// operation sequence (create workspace -> create Database -> read it ->
// create a row -> read Database + verify row-order membership -> read
// DatabaseRow -> apply cell update -> reopen both stores -> read Database
// again -> read DatabaseRow again -> verify persisted cell values -> replay
// original row-creation request -> verify stable idempotency fields ->
// submit duplicate update -> verify dedup) against a disposable JSON store
// AND a disposable PostgreSQL store, using IDENTICAL client-supplied ids
// (workspace/user/database/row/request ids) on both sides so the resulting
// LOGICAL fingerprints (API-shape, Yjs logical content, row-order
// membership, idempotency behaviour, dedup behaviour, restart reconstruction)
// can be compared directly -- NOT internal byte layout or Postgres-only
// implementation details (e.g. the bigserial `id` column, exact timestamps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as Y from 'yjs';
import { openStore } from '../storage.js';
import { openPostgresStore } from '../postgres-storage.js';
import { createInitialDatabaseCollab } from '../database-document.js';
import { createInitialDatabaseRowCollab } from '../database-row-document.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;

function rowOrderIds(documentState, databaseId, viewId) {
  const doc = new Y.Doc({ guid: databaseId });
  try {
    Y.applyUpdate(doc, documentState);
    const view = doc.getMap('data').get('database').get('views').get(viewId);
    return view.get('row_orders').toArray().map((o) => o.id);
  } finally { doc.destroy(); }
}

function cellValue(documentState, rowId, fieldId) {
  const doc = new Y.Doc({ guid: rowId });
  try {
    Y.applyUpdate(doc, documentState);
    return doc.getMap('data').get('data').get('cells').get(fieldId)?.get('data');
  } finally { doc.destroy(); }
}

// Runs the full fixed sequence against `openFn` (a (fixedIds) => Promise<store>
// factory, so a "reopen" can rebuild the store against the same durable
// backing) and returns a plain-object fingerprint of every logical outcome
// the parity test cares about. `fixedIds` is the SAME object for both the
// JSON and PostgreSQL runs, so every id involved is identical across modes.
async function runSequence(openFn, fixedIds) {
  let store = await openFn();
  const { userId, uid, workspaceId, spaceId, containerId, databaseId, viewId, primaryFieldId, rowId, createRequestId, createRowRequestId, cellRequestId } = fixedIds;
  const now = new Date('2026-01-01T00:00:00.000Z');

  const user = { id: userId, uid, email: `parity-${userId}@example.test`, password_hash: 'synthetic', created_at: now.toISOString() };
  await store.saveUser(user);
  const workspace = { id: workspaceId, name: 'parity-workspace', icon: '', database_storage_id: workspaceId, owner_id: userId, created_at: now.toISOString() };
  await store.createWorkspace(workspace, { workspace_id: workspaceId, user_id: userId, role: 'owner', created_at: now.toISOString() });
  const space = { id: spaceId, workspace_id: workspaceId, name: 'Shared', space_icon: '', space_icon_color: '', permission: { permission_type: 0 }, creator_id: userId, created_at: now.toISOString() };
  await store.createSpace(space);

  const timestamp = now.toISOString();
  const collab = createInitialDatabaseCollab({ databaseId, viewId, name: 'Grid', primaryFieldId, timestamp });
  const containerPage = { id: containerId, workspace_id: workspaceId, parent_view_id: spaceId, title: 'Grid', icon: null, extra: { is_database_container: true, database_id: databaseId }, layout: 1, is_favorite: false, creator_id: userId, version: 1, created_at: timestamp, updated_at: timestamp, position: { kind: 'start' } };
  const primaryViewPage = { id: viewId, workspace_id: workspaceId, parent_view_id: containerId, title: 'Grid', icon: null, extra: { database_id: databaseId }, layout: 1, is_favorite: false, creator_id: userId, version: 1, created_at: timestamp, updated_at: timestamp, position: { kind: 'start' } };
  const createDigest = createHash('sha256').update('create-database-body').digest('hex');
  const createResult = await store.createAtomicDatabasePage(containerPage, primaryViewPage, databaseId, collab, { request_id: createRequestId, request_digest: createDigest });

  const databaseAfterCreate = await store.getDatabaseCollab(workspaceId, databaseId);

  const rowTimestamp = now.toISOString();
  const rowCollab = createInitialDatabaseRowCollab({ rowId, databaseId, cells: { [primaryFieldId]: { data: 'original value' } }, height: 36, visibility: true, timestamp: rowTimestamp, actorUid: uid });
  const createRowDigest = createHash('sha256').update('create-row-body').digest('hex');
  const updateBatchId = fixedIds.updateBatchId;
  const createRowResult = await store.createAtomicDatabaseRow({
    workspaceId, databaseId, rowId, sourceViewId: viewId, position: { kind: 'end' }, rowCollab,
    request: { request_id: createRowRequestId, request_digest: createRowDigest, height: 36, timestamp: rowTimestamp, update_batch_id: updateBatchId },
  });

  const databaseAfterRow = await store.getDatabaseCollab(workspaceId, databaseId);
  const rowOrdersAfterCreate = rowOrderIds(databaseAfterRow.doc_state, databaseId, viewId);
  const rowCollabRead = await store.getDatabaseRowCollab(workspaceId, rowId);

  // Apply a cell update.
  const editDoc = new Y.Doc({ guid: rowId }); Y.applyUpdate(editDoc, rowCollabRead.doc_state);
  editDoc.getMap('data').get('data').get('cells').get(primaryFieldId).set('data', 'edited value');
  const cellUpdatePayload = Y.encodeStateAsUpdate(editDoc, rowCollabRead.state_vector);
  const cellUpdateResult = await store.acceptDatabaseRowCollabUpdate({ workspaceId, rowId, flags: 0, payload: cellUpdatePayload, beforeStateVector: rowCollabRead.state_vector, collabVersion: null, restoreId: null, messageKey: cellRequestId });

  // Reopen (restart simulation). JSON stores have no live connection to
  // close (file-based); only PostgreSQL stores expose close().
  if (store.close) await store.close();
  store = await openFn();

  const databaseAfterReopen = await store.getDatabaseCollab(workspaceId, databaseId);
  const rowAfterReopen = await store.getDatabaseRowCollab(workspaceId, rowId);
  const persistedCellValue = cellValue(rowAfterReopen.doc_state, rowId, primaryFieldId);

  // Replay the original row-creation request (idempotency).
  const replayRowCollab = createInitialDatabaseRowCollab({ rowId, databaseId, cells: {}, height: 36, visibility: true, timestamp: rowTimestamp });
  const replayResult = await store.createAtomicDatabaseRow({
    workspaceId, databaseId, rowId, sourceViewId: viewId, position: { kind: 'end' }, rowCollab: replayRowCollab,
    request: { request_id: createRowRequestId, request_digest: createRowDigest, height: 36, timestamp: rowTimestamp, update_batch_id: randomUUID() },
  });

  // Submit a duplicate update (dedup).
  const duplicateUpdateResult = await store.acceptDatabaseRowCollabUpdate({ workspaceId, rowId, flags: 0, payload: cellUpdatePayload, beforeStateVector: rowCollabRead.state_vector, collabVersion: null, restoreId: null, messageKey: cellRequestId });

  const fingerprint = {
    createOutcome: createResult.outcome,
    createDatabaseId: createResult.result.database_id,
    databaseCollabVersion: databaseAfterCreate.collab_version,
    createRowOutcome: createRowResult.outcome,
    rowOrdersAfterCreate,
    rowCollabVersionIsNull: rowCollabRead.collab_version === null,
    cellUpdateStatus: cellUpdateResult.status,
    rowOrdersAfterReopen: rowOrderIds(databaseAfterReopen.doc_state, databaseId, viewId),
    persistedCellValue,
    replayOutcome: replayResult.outcome,
    replayUpdateBatchId: replayResult.update_batch_id,
    originalUpdateBatchId: createRowResult.update_batch_id,
    duplicateUpdateStatus: duplicateUpdateResult.status,
    duplicateMessageIdMatches: JSON.stringify(duplicateUpdateResult.messageId) === JSON.stringify(cellUpdateResult.messageId),
  };
  if (store.close) await store.close();
  return fingerprint;
}

test('JSON/PostgreSQL parity: identical operation sequence produces identical logical outcomes', { skip: !configured }, async (t) => {
  const fixedIds = {
    userId: randomUUID(), uid: randomInt(1, 2 ** 48), workspaceId: randomUUID(), spaceId: randomUUID(),
    containerId: randomUUID(), databaseId: randomUUID(), viewId: randomUUID(), primaryFieldId: randomUUID(),
    rowId: randomUUID(), createRequestId: randomUUID(), createRowRequestId: randomUUID(), cellRequestId: randomUUID(),
    updateBatchId: randomUUID(),
  };

  const jsonDir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-task63-parity-'));
  const jsonFile = path.join(jsonDir, 'store.json');
  let jsonFingerprint, postgresFingerprint;
  try {
    jsonFingerprint = await runSequence(() => openStore(jsonFile), fixedIds);
    postgresFingerprint = await runSequence(() => openPostgresStore(process.env.DATABASE_URL), fixedIds);
  } finally {
    await rm(jsonDir, { recursive: true, force: true });
  }

  t.diagnostic(`JSON fingerprint: ${JSON.stringify(jsonFingerprint)}`);
  t.diagnostic(`Postgres fingerprint: ${JSON.stringify(postgresFingerprint)}`);

  assert.deepEqual(postgresFingerprint, jsonFingerprint, 'PostgreSQL and JSON storage must produce identical logical outcomes for the same operation sequence');

  // Spell out the individually meaningful assertions too (clearer failure
  // messages than one big deepEqual if something regresses later).
  assert.equal(jsonFingerprint.createOutcome, 'applied');
  assert.equal(jsonFingerprint.createRowOutcome, 'applied');
  assert.deepEqual(jsonFingerprint.rowOrdersAfterCreate, [fixedIds.rowId]);
  assert.deepEqual(jsonFingerprint.rowOrdersAfterReopen, [fixedIds.rowId]);
  assert.equal(jsonFingerprint.rowCollabVersionIsNull, true);
  assert.equal(jsonFingerprint.cellUpdateStatus, 'applied');
  assert.equal(jsonFingerprint.persistedCellValue, 'edited value');
  assert.equal(jsonFingerprint.replayOutcome, 'already_applied');
  assert.equal(jsonFingerprint.replayUpdateBatchId, jsonFingerprint.originalUpdateBatchId);
  assert.equal(jsonFingerprint.duplicateUpdateStatus, 'duplicate');
  assert.equal(jsonFingerprint.duplicateMessageIdMatches, true);
});

// Task 64: JSON/PostgreSQL parity for the workspace Database catalog
// (`store.listWorkspaceDatabaseCatalog`, database-catalog.js). Same
// methodology as the sequence above: identical client-supplied ids run
// against a disposable JSON store AND a disposable PostgreSQL store, and
// the resulting catalogs are compared directly. Covers well-formed
// multi-database listing, cross-workspace isolation, a malformed container
// (invalid database_id, excluded), an orphan container (no primary view,
// included container-only), and a decoy mismatched-database_id child page
// (never selected as a primary view) -- the exact scenarios Task 64's
// dedicated catalog test suites (test/database-catalog.test.js,
// test/postgres-database-catalog.test.js) cover at the HTTP layer, run here
// directly against the storage methods so the comparison is byte-for-byte
// on the derived catalog shape, not just "both happen to pass their own
// assertions".
async function runCatalogSequence(openFn, fixedIds) {
  const store = await openFn();
  const { userId, uid, workspaceIdA, workspaceIdB, spaceId } = fixedIds;
  const now = new Date('2026-03-01T00:00:00.000Z');

  const user = { id: userId, uid, email: `catalog-${userId}@example.test`, password_hash: 'synthetic', created_at: now.toISOString() };
  await store.saveUser(user);
  const workspaceA = { id: workspaceIdA, name: 'catalog-workspace-a', icon: '', database_storage_id: workspaceIdA, owner_id: userId, created_at: now.toISOString() };
  await store.createWorkspace(workspaceA, { workspace_id: workspaceIdA, user_id: userId, role: 'owner', created_at: now.toISOString() });
  const workspaceB = { id: workspaceIdB, name: 'catalog-workspace-b', icon: '', database_storage_id: workspaceIdB, owner_id: userId, created_at: now.toISOString() };
  await store.createWorkspace(workspaceB, { workspace_id: workspaceIdB, user_id: userId, role: 'owner', created_at: now.toISOString() });
  const space = { id: spaceId, workspace_id: workspaceIdA, name: 'Shared', space_icon: '', space_icon_color: '', permission: { permission_type: 0 }, creator_id: userId, created_at: now.toISOString() };
  await store.createSpace(space);

  const emptyCatalog = await store.listWorkspaceDatabaseCatalog(workspaceIdA);

  // Two well-formed databases, deliberately created with the SECOND one
  // timestamped EARLIER than the first -- proves ordering is by the
  // container's (created_at, id), not insertion order.
  const dbDefs = [
    { databaseId: fixedIds.databaseId1, containerId: fixedIds.containerId1, viewId: fixedIds.viewId1, primaryFieldId: fixedIds.primaryFieldId1, name: 'Second-by-time', t: '2026-03-01T00:10:00.000Z' },
    { databaseId: fixedIds.databaseId2, containerId: fixedIds.containerId2, viewId: fixedIds.viewId2, primaryFieldId: fixedIds.primaryFieldId2, name: 'First-by-time', t: '2026-03-01T00:05:00.000Z' },
  ];
  for (const def of dbDefs) {
    const collab = createInitialDatabaseCollab({ databaseId: def.databaseId, viewId: def.viewId, name: def.name, primaryFieldId: def.primaryFieldId, timestamp: def.t });
    const containerPage = { id: def.containerId, workspace_id: workspaceIdA, parent_view_id: spaceId, title: def.name, icon: null, extra: { is_database_container: true, database_id: def.databaseId }, layout: 1, is_favorite: false, creator_id: userId, version: 1, created_at: def.t, updated_at: def.t, position: { kind: 'start' } };
    const primaryViewPage = { id: def.viewId, workspace_id: workspaceIdA, parent_view_id: def.containerId, title: def.name, icon: null, extra: { database_id: def.databaseId }, layout: 1, is_favorite: false, creator_id: userId, version: 1, created_at: def.t, updated_at: def.t, position: { kind: 'start' } };
    const digest = createHash('sha256').update(def.databaseId).digest('hex');
    await store.createAtomicDatabasePage(containerPage, primaryViewPage, def.databaseId, collab, { request_id: randomUUID(), request_digest: digest });
  }

  // Malformed container: `is_database_container: true` but an invalid
  // (non-UUID) database_id -- must be excluded from the catalog.
  const malformedTimestamp = '2026-03-01T00:07:00.000Z';
  await store.createPage({
    id: fixedIds.malformedContainerId, workspace_id: workspaceIdA, parent_view_id: spaceId, title: 'Malformed', icon: null,
    extra: { is_database_container: true, database_id: 'not-a-uuid' }, layout: 1, is_favorite: false, document: {},
    schema_version: 'appflowy-document-v1', creator_id: userId, version: 1, created_at: malformedTimestamp, updated_at: malformedTimestamp, position: { kind: 'start' },
  });

  // Orphan container: well-formed database_id, no matching primary-view
  // child -- must be included with a single (container-only) view.
  const orphanTimestamp = '2026-03-01T00:08:00.000Z';
  await store.createPage({
    id: fixedIds.orphanContainerId, workspace_id: workspaceIdA, parent_view_id: spaceId, title: 'Orphan', icon: null,
    extra: { is_database_container: true, database_id: fixedIds.orphanDatabaseId }, layout: 1, is_favorite: false, document: {},
    schema_version: 'appflowy-document-v1', creator_id: userId, version: 1, created_at: orphanTimestamp, updated_at: orphanTimestamp, position: { kind: 'start' },
  });

  // Decoy child page under db1's container with a MISMATCHED database_id --
  // must never be selected as db1's primary view.
  const decoyTimestamp = '2026-03-01T00:09:00.000Z';
  await store.createPage({
    id: fixedIds.decoyViewId, workspace_id: workspaceIdA, parent_view_id: fixedIds.containerId1, title: 'Decoy', icon: null,
    extra: { database_id: randomUUID() }, layout: 1, is_favorite: false, document: {},
    schema_version: 'appflowy-document-v1', creator_id: userId, version: 1, created_at: decoyTimestamp, updated_at: decoyTimestamp, position: { kind: 'start' },
  });

  const catalogA = await store.listWorkspaceDatabaseCatalog(workspaceIdA);
  const catalogB = await store.listWorkspaceDatabaseCatalog(workspaceIdB);

  if (store.close) await store.close();
  return { emptyCatalog, catalogA, catalogB };
}

test('JSON/PostgreSQL parity: workspace Database catalog derivation produces identical logical results', { skip: !configured }, async (t) => {
  const fixedIds = {
    userId: randomUUID(), uid: randomInt(1, 2 ** 48), workspaceIdA: randomUUID(), workspaceIdB: randomUUID(), spaceId: randomUUID(),
    databaseId1: randomUUID(), containerId1: randomUUID(), viewId1: randomUUID(), primaryFieldId1: randomUUID(),
    databaseId2: randomUUID(), containerId2: randomUUID(), viewId2: randomUUID(), primaryFieldId2: randomUUID(),
    malformedContainerId: randomUUID(), orphanContainerId: randomUUID(), orphanDatabaseId: randomUUID(), decoyViewId: randomUUID(),
  };

  const jsonDir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-task64-catalog-parity-'));
  const jsonFile = path.join(jsonDir, 'store.json');
  let jsonResult, postgresResult;
  try {
    jsonResult = await runCatalogSequence(() => openStore(jsonFile), fixedIds);
    postgresResult = await runCatalogSequence(() => openPostgresStore(process.env.DATABASE_URL), fixedIds);
  } finally {
    await rm(jsonDir, { recursive: true, force: true });
  }

  t.diagnostic(`JSON catalogA: ${JSON.stringify(jsonResult.catalogA)}`);
  t.diagnostic(`Postgres catalogA: ${JSON.stringify(postgresResult.catalogA)}`);

  assert.deepEqual(jsonResult.emptyCatalog, []);
  assert.deepEqual(postgresResult.emptyCatalog, []);
  assert.deepEqual(postgresResult, jsonResult, 'PostgreSQL and JSON storage must derive identical workspace Database catalogs');

  // Spelled-out assertions for clearer failure messages.
  assert.equal(jsonResult.catalogA.length, 3, 'two well-formed + one orphan container; the malformed one is excluded');
  assert.deepEqual(jsonResult.catalogA.map((e) => e.database_id), [fixedIds.databaseId2, fixedIds.orphanDatabaseId, fixedIds.databaseId1], 'ordered by container created_at, not insertion order');
  assert.equal(jsonResult.catalogA.find((e) => e.database_id === fixedIds.orphanDatabaseId).views.length, 1);
  const db1Entry = jsonResult.catalogA.find((e) => e.database_id === fixedIds.databaseId1);
  assert.equal(db1Entry.views.length, 2, 'the decoy child must not add a second (wrong) primary view');
  assert.equal(db1Entry.views.find((v) => !v.is_container).view_id, fixedIds.viewId1);
  assert.deepEqual(jsonResult.catalogB, [], 'workspace B must never see workspace A\'s databases');
});
