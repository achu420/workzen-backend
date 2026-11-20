// Task 56: committed, repeatable PostgreSQL regression tests for Task 49B's
// document version-history / restore feature (version creation, history
// listing, preview, tombstone-delete, restore). Converts the prior
// uncommitted one-off verification (see docs/APPFLOWY_TASK49B_REPORT.md)
// into permanent automated coverage against a real PostgreSQL database via
// the real `pg` driver, exercising the actual production code paths
// exposed on the store object (listPageCollabVersions, getPageCollabVersion,
// createPageCollabVersion, tombstonePageCollabVersion,
// restorePageCollabVersion) -- the same methods server.js's HTTP routes call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { openPostgresStore } from '../postgres-storage.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;
const fixtureRoot = path.resolve(process.env.APPFLOWY_FIXTURE_ROOT || '/Volumes/work disk/Codes/Tracker/AppFlowy/contracts/mvp/appflowy-golden');
const fixture = () => readFile(path.join(fixtureRoot, 'binary/page-update-v1.bin'));

// Mirrors test/postgres-collab.test.js's context() helper (Task 50's
// corrected, production-compatible fixture conventions: uid/icon/
// database_storage_id populated to satisfy NOT NULL constraints).
async function context() {
  const store = await openPostgresStore(process.env.DATABASE_URL);
  const now = new Date();
  const user = { id: randomUUID(), uid: randomInt(1, 2 ** 48), email: `version-${randomUUID()}@example.test`, password_hash: 'synthetic', created_at: now };
  await store.saveUser(user);
  const workspaceId = randomUUID();
  const workspace = { id: workspaceId, name: 'version-history-test', icon: '', database_storage_id: workspaceId, owner_id: user.id, created_at: now };
  await store.createWorkspace(workspace, { workspace_id: workspace.id, user_id: user.id, role: 'owner', created_at: now });
  const page = { id: randomUUID(), workspace_id: workspace.id, title: 'page', document: {}, schema_version: 'v1', creator_id: user.id, version: 1, created_at: now, updated_at: now };
  await store.createPage(page);
  return { store, workspace, page, user };
}

function textFor(doc) {
  const data = doc.getMap('data').get('document');
  const textMap = data.get('meta').get('text_map');
  const text = [...textMap.values()].find((value) => value instanceof Y.Text);
  assert.ok(text, 'source fixture should contain an ordinary text block');
  return text;
}

async function seedDocument(store, workspace, page) {
  const initial = await fixture();
  const source = new Y.Doc({ guid: page.id });
  Y.applyUpdate(source, initial);
  await store.collab.persistInitial({ workspaceId: workspace.id, pageId: page.id, documentState: initial, stateVector: Y.encodeStateVector(source) });
  return { initial, source };
}

function markerDoc(initial, pageId, marker) {
  const doc = new Y.Doc({ guid: pageId });
  Y.applyUpdate(doc, initial);
  textFor(doc).insert(0, marker);
  return doc;
}

test('version-history (Postgres): named version creation is durably persisted with correct state and metadata', { skip: !configured }, async () => {
  const { store, workspace, page, user } = await context();
  try {
    const { initial } = await seedDocument(store, workspace, page);
    const created = await store.createPageCollabVersion(workspace.id, page.id, { name: 'checkpoint-1', documentState: initial, actorUid: user.uid });
    assert.ok(created, 'createPageCollabVersion should succeed for an existing page');
    assert.equal(created.kind, 'named');
    assert.equal(created.name, 'checkpoint-1');
    assert.equal(created.parent, null);
    assert.equal(created.deleted_at, null);
    assert.deepEqual(new Uint8Array(created.document_state), new Uint8Array(initial));

    // Verify directly against the real table, not just the returned value.
    const row = await store.pool.query('SELECT version,workspace_id,page_id,kind,name,document_state,deleted_at FROM collab_versions WHERE version=$1', [created.version]);
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].workspace_id, workspace.id);
    assert.equal(row.rows[0].page_id, page.id);
    assert.equal(row.rows[0].kind, 'named');
    assert.equal(row.rows[0].name, 'checkpoint-1');
    assert.equal(row.rows[0].deleted_at, null);
    assert.deepEqual(new Uint8Array(row.rows[0].document_state), new Uint8Array(initial));

    const fetched = await store.getPageCollabVersion(workspace.id, page.id, created.version);
    assert.ok(fetched);
    assert.deepEqual(new Uint8Array(fetched.document_state), new Uint8Array(initial));
  } finally { await store.close(); }
});

test('version-history (Postgres): history listing returns correct ordering/metadata and excludes other documents/workspaces', { skip: !configured }, async () => {
  const { store, workspace, page, user } = await context();
  const other = await context();
  try {
    const { initial } = await seedDocument(store, workspace, page);
    await seedDocument(other.store, other.workspace, other.page);

    const v1 = await store.createPageCollabVersion(workspace.id, page.id, { name: 'first', documentState: initial, actorUid: user.uid });
    const client2 = markerDoc(initial, page.id, 'second-content ');
    const state2 = Y.encodeStateAsUpdate(client2);
    const v2 = await store.createPageCollabVersion(workspace.id, page.id, { name: 'second', documentState: state2, actorUid: user.uid });
    await other.store.createPageCollabVersion(other.workspace.id, other.page.id, { name: 'unrelated', documentState: initial, actorUid: other.user.uid });

    const history = await store.listPageCollabVersions(workspace.id, page.id);
    assert.equal(history.length, 2, 'only this page\'s own versions should be listed');
    assert.equal(history[0].version, v1.version);
    assert.equal(history[1].version, v2.version);
    assert.ok(new Date(history[0].created_at).getTime() <= new Date(history[1].created_at).getTime(), 'ascending created_at order');
    assert.equal(history[1].parent, v1.version, 'second version chains to first as parent');

    const otherHistory = await other.store.listPageCollabVersions(other.workspace.id, other.page.id);
    assert.equal(otherHistory.length, 1);
    assert.ok(!history.some((v) => v.version === otherHistory[0].version), 'no cross-document leakage');

    // Wrong workspace id for a real page -> ownership check returns null (404 upstream).
    const wrongWorkspace = await store.listPageCollabVersions(randomUUID(), page.id);
    assert.equal(wrongWorkspace, null);
  } finally { await store.close(); await other.store.close(); }
});

test('version-history (Postgres): restoring an earlier version installs its exact content and persists metadata/restore audit row', { skip: !configured }, async () => {
  const { store, workspace, page, user } = await context();
  try {
    const { initial } = await seedDocument(store, workspace, page);
    const v1 = await store.createPageCollabVersion(workspace.id, page.id, { name: 'v1', documentState: initial, actorUid: user.uid });

    const client2 = markerDoc(initial, page.id, 'edited-after-v1 ');
    const state2 = Y.encodeStateAsUpdate(client2);
    const before = await store.collab.load({ workspaceId: workspace.id, pageId: page.id });
    await store.collab.acceptUpdate({ workspaceId: workspace.id, pageId: page.id, payload: Y.encodeStateAsUpdate(client2, before.stateVector), messageKey: 'edit-after-v1' });

    const preRestore = await store.collab.load({ workspaceId: workspace.id, pageId: page.id });
    assert.match(textFor((() => { const d = new Y.Doc({ guid: page.id }); Y.applyUpdate(d, preRestore.documentState); return d; })()).toString(), /^edited-after-v1 /);

    const restored = await store.restorePageCollabVersion({ workspaceId: workspace.id, pageId: page.id, versionId: v1.version, actorUid: user.uid });
    assert.equal(restored.status, 'applied');
    assert.equal(restored.duplicate, false);
    assert.deepEqual(new Uint8Array(restored.documentState), new Uint8Array(initial), 'restored content matches the selected version exactly');

    const reloaded = await store.collab.load({ workspaceId: workspace.id, pageId: page.id });
    assert.equal(reloaded.generation, before.generation + 2, 'one ordinary update + one restore = +2 generations');
    assert.equal(reloaded.restoreId, restored.restoreId);
    assert.notEqual(reloaded.restoreId, preRestore.restoreId);

    const restoredDoc = new Y.Doc({ guid: page.id });
    Y.applyUpdate(restoredDoc, reloaded.documentState);
    assert.doesNotMatch(textFor(restoredDoc).toString(), /edited-after-v1/, 'post-edit content should be gone after restoring to v1');

    const restoreRow = await store.pool.query('SELECT restored_version_id, before_restore_snapshot_version_id, resulting_restore_id FROM restore_events WHERE workspace_id=$1 AND page_id=$2 ORDER BY created_at DESC LIMIT 1', [workspace.id, page.id]);
    assert.equal(restoreRow.rowCount, 1);
    assert.equal(restoreRow.rows[0].restored_version_id, v1.version);
    assert.equal(restoreRow.rows[0].resulting_restore_id, restored.restoreId);
  } finally { await store.close(); }
});

test('version-history (Postgres): restore preserves prior history (tombstone-not-delete) and a before-restore snapshot is added', { skip: !configured }, async () => {
  const { store, workspace, page, user } = await context();
  try {
    const { initial } = await seedDocument(store, workspace, page);
    const v1 = await store.createPageCollabVersion(workspace.id, page.id, { name: 'v1', documentState: initial, actorUid: user.uid });
    const client2 = markerDoc(initial, page.id, 'v2-content ');
    const v2 = await store.createPageCollabVersion(workspace.id, page.id, { name: 'v2', documentState: Y.encodeStateAsUpdate(client2), actorUid: user.uid });

    // Actually apply the "v2-content" edit to the LIVE document (not just
    // the named snapshot) so the implicit before-restore snapshot -- which
    // captures the live document's current state, not a named version's --
    // is meaningfully distinguishable from v1/v2.
    const before = await store.collab.load({ workspaceId: workspace.id, pageId: page.id });
    await store.collab.acceptUpdate({ workspaceId: workspace.id, pageId: page.id, payload: Y.encodeStateAsUpdate(client2, before.stateVector), messageKey: 'apply-v2-content' });

    const historyBefore = await store.listPageCollabVersions(workspace.id, page.id);
    assert.equal(historyBefore.length, 2);

    const restored = await store.restorePageCollabVersion({ workspaceId: workspace.id, pageId: page.id, versionId: v1.version, actorUid: user.uid });
    assert.equal(restored.status, 'applied');

    const historyAfter = await store.listPageCollabVersions(workspace.id, page.id);
    assert.equal(historyAfter.length, 3, 'v1, v2, and the implicit before-restore snapshot should all remain listed');
    const ids = historyAfter.map((v) => v.version);
    assert.ok(ids.includes(v1.version));
    assert.ok(ids.includes(v2.version));
    const beforeRestoreEntry = historyAfter.find((v) => v.kind === 'before_restore');
    assert.ok(beforeRestoreEntry, 'an implicit before-restore snapshot should appear in history');
    // The before-restore snapshot captured the document state as it was
    // immediately prior to the restore (i.e. v2's content), not v1's.
    const snapDoc = new Y.Doc({ guid: page.id });
    Y.applyUpdate(snapDoc, new Uint8Array(beforeRestoreEntry.document_state));
    assert.match(textFor(snapDoc).toString(), /v2-content/);

    // Explicit tombstone-delete: not physically removed, excluded from listing, still retrievable by id.
    const tombstoneResult = await store.tombstonePageCollabVersion(workspace.id, page.id, v2.version);
    assert.equal(tombstoneResult.status, 'deleted');
    const historyAfterTombstone = await store.listPageCollabVersions(workspace.id, page.id);
    assert.ok(!historyAfterTombstone.some((v) => v.version === v2.version), 'tombstoned version excluded from listing');
    const stillPresent = await store.getPageCollabVersion(workspace.id, page.id, v2.version);
    assert.ok(stillPresent, 'tombstoned version is still physically present (preview by id)');
    assert.ok(stillPresent.deleted_at, 'tombstoned version carries a deleted_at marker rather than being removed');
    const stillInTable = await store.pool.query('SELECT 1 FROM collab_versions WHERE version=$1', [v2.version]);
    assert.equal(stillInTable.rowCount, 1, 'row physically still exists in collab_versions');

    // Idempotent tombstone.
    const secondTombstone = await store.tombstonePageCollabVersion(workspace.id, page.id, v2.version);
    assert.equal(secondTombstone.status, 'already_deleted');

    // Restoring a tombstoned version is rejected.
    await assert.rejects(() => store.restorePageCollabVersion({ workspaceId: workspace.id, pageId: page.id, versionId: v2.version, actorUid: user.uid }), (e) => e.code === 'VERSION_DELETED');
  } finally { await store.close(); }
});

test('version-history (Postgres): failed restore (missing/tombstoned target) rolls back with no partial writes', { skip: !configured }, async () => {
  const { store, workspace, page, user } = await context();
  try {
    const { initial } = await seedDocument(store, workspace, page);
    const v1 = await store.createPageCollabVersion(workspace.id, page.id, { name: 'v1', documentState: initial, actorUid: user.uid });

    const before = await store.collab.load({ workspaceId: workspace.id, pageId: page.id });
    const eventsBefore = await store.pool.query('SELECT count(*)::int AS n FROM restore_events WHERE workspace_id=$1 AND page_id=$2', [workspace.id, page.id]);
    const versionsBefore = await store.pool.query('SELECT count(*)::int AS n FROM collab_versions WHERE workspace_id=$1 AND page_id=$2', [workspace.id, page.id]);

    // A. Nonexistent target version.
    await assert.rejects(() => store.restorePageCollabVersion({ workspaceId: workspace.id, pageId: page.id, versionId: randomUUID(), actorUid: user.uid }), (e) => e.code === 'VERSION_NOT_FOUND');

    const afterFailureA = await store.collab.load({ workspaceId: workspace.id, pageId: page.id });
    assert.equal(afterFailureA.generation, before.generation, 'failed restore must not bump generation');
    assert.equal(afterFailureA.restoreId, before.restoreId, 'failed restore must not install a new restoreId');
    const eventsAfterA = await store.pool.query('SELECT count(*)::int AS n FROM restore_events WHERE workspace_id=$1 AND page_id=$2', [workspace.id, page.id]);
    assert.equal(eventsAfterA.rows[0].n, eventsBefore.rows[0].n, 'no restore_events row should survive the failed transaction');
    const versionsAfterA = await store.pool.query('SELECT count(*)::int AS n FROM collab_versions WHERE workspace_id=$1 AND page_id=$2', [workspace.id, page.id]);
    assert.equal(versionsAfterA.rows[0].n, versionsBefore.rows[0].n, 'no implicit before-restore snapshot should survive the failed transaction');

    // B. Tombstoned target version.
    await store.tombstonePageCollabVersion(workspace.id, page.id, v1.version);
    await assert.rejects(() => store.restorePageCollabVersion({ workspaceId: workspace.id, pageId: page.id, versionId: v1.version, actorUid: user.uid }), (e) => e.code === 'VERSION_DELETED');

    const afterFailureB = await store.collab.load({ workspaceId: workspace.id, pageId: page.id });
    assert.equal(afterFailureB.generation, before.generation, 'failed restore on a tombstoned target must not bump generation either');
    const eventsAfterB = await store.pool.query('SELECT count(*)::int AS n FROM restore_events WHERE workspace_id=$1 AND page_id=$2', [workspace.id, page.id]);
    assert.equal(eventsAfterB.rows[0].n, eventsBefore.rows[0].n, 'still no restore_events row after the second failed transaction');
  } finally { await store.close(); }
});

test('version-history (Postgres): duplicate restore requests are idempotent and concurrent competing restores resolve to exactly one applied result', { skip: !configured }, async () => {
  const { store, workspace, page, user } = await context();
  const second = await openPostgresStore(process.env.DATABASE_URL);
  try {
    const { initial } = await seedDocument(store, workspace, page);
    const v1 = await store.createPageCollabVersion(workspace.id, page.id, { name: 'v1', documentState: initial, actorUid: user.uid });
    const client2 = markerDoc(initial, page.id, 'edit ');
    const before = await store.collab.load({ workspaceId: workspace.id, pageId: page.id });
    await store.collab.acceptUpdate({ workspaceId: workspace.id, pageId: page.id, payload: Y.encodeStateAsUpdate(client2, before.stateVector), messageKey: 'edit' });

    const first = await store.restorePageCollabVersion({ workspaceId: workspace.id, pageId: page.id, versionId: v1.version, actorUid: user.uid });
    assert.equal(first.status, 'applied');
    const duplicate = await store.restorePageCollabVersion({ workspaceId: workspace.id, pageId: page.id, versionId: v1.version, actorUid: user.uid });
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.restoreId, first.restoreId);

    const versionsAfterDup = await store.pool.query("SELECT count(*)::int AS n FROM collab_versions WHERE workspace_id=$1 AND page_id=$2 AND kind='before_restore'", [workspace.id, page.id]);
    assert.equal(versionsAfterDup.rows[0].n, 1, 'a duplicate restore request must not create a second before-restore snapshot');

    // Fresh competing restores to a different target on a second connection, racing concurrently.
    const v2 = await store.createPageCollabVersion(workspace.id, page.id, { name: 'v2', documentState: Y.encodeStateAsUpdate(client2), actorUid: user.uid });
    const results = await Promise.all([
      store.restorePageCollabVersion({ workspaceId: workspace.id, pageId: page.id, versionId: v2.version, actorUid: user.uid }),
      second.restorePageCollabVersion({ workspaceId: workspace.id, pageId: page.id, versionId: v2.version, actorUid: user.uid }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, ['applied', 'duplicate'], 'exactly one of two concurrent competing restores should apply, the other should observe the result as a duplicate');
  } finally { await store.close(); await second.close(); }
});

test('version-history (Postgres): separate documents maintain fully independent version histories', { skip: !configured }, async () => {
  const a = await context();
  const b = await context();
  try {
    const { initial: initialA } = await seedDocument(a.store, a.workspace, a.page);
    const { initial: initialB } = await seedDocument(b.store, b.workspace, b.page);
    const va = await a.store.createPageCollabVersion(a.workspace.id, a.page.id, { name: 'a1', documentState: initialA, actorUid: a.user.uid });
    const vb = await b.store.createPageCollabVersion(b.workspace.id, b.page.id, { name: 'b1', documentState: initialB, actorUid: b.user.uid });

    const restoredA = await a.store.restorePageCollabVersion({ workspaceId: a.workspace.id, pageId: a.page.id, versionId: va.version, actorUid: a.user.uid });
    assert.equal(restoredA.status, 'applied');

    // Restoring document A must not affect document B's history or state at all.
    const historyB = await b.store.listPageCollabVersions(b.workspace.id, b.page.id);
    assert.equal(historyB.length, 1);
    assert.equal(historyB[0].version, vb.version);
    const loadedB = await b.store.collab.load({ workspaceId: b.workspace.id, pageId: b.page.id });
    assert.equal(loadedB.generation, 0, 'document B was never touched');

    // Cross-document access: looking up A's version id scoped to B's page must fail.
    const crossLookup = await b.store.getPageCollabVersion(b.workspace.id, b.page.id, va.version);
    assert.equal(crossLookup, null, 'a version created on another page must not be retrievable scoped to this page');
  } finally { await a.store.close(); await b.store.close(); }
});
