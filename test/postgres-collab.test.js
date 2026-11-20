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

async function context() {
  const store = await openPostgresStore(process.env.DATABASE_URL);
  const now = new Date(); const user = { id: randomUUID(), uid: randomInt(1, 2 ** 48), email: `collab-${randomUUID()}@example.test`, password_hash: 'synthetic', created_at: now };
  await store.saveUser(user);
  const workspaceId = randomUUID();
  const workspace = { id: workspaceId, name: 'durable-collab-test', icon: '', database_storage_id: workspaceId, owner_id: user.id, created_at: now };
  await store.createWorkspace(workspace, { workspace_id: workspace.id, user_id: user.id, role: 'owner', created_at: now });
  const page = { id: randomUUID(), workspace_id: workspace.id, title: 'page', document: {}, schema_version: 'v1', creator_id: user.id, version: 1, created_at: now, updated_at: now };
  await store.createPage(page);
  return { store, workspace, page };
}

function textFor(doc) {
  const data = doc.getMap('data').get('document');
  const textMap = data.get('meta').get('text_map');
  const text = [...textMap.values()].find((value) => value instanceof Y.Text);
  assert.ok(text, 'source fixture should contain an ordinary text block');
  return text;
}

test('durable PostgreSQL collaboration state survives reload, deduplicates, and isolates invalid references', { skip: !configured }, async () => {
  const { store, workspace, page } = await context();
  try {
    const initial = await fixture(); const source = new Y.Doc({ guid: page.id }); Y.applyUpdate(source, initial);
    const persisted = await store.collab.persistInitial({ workspaceId: workspace.id, pageId: page.id, documentState: initial, stateVector: Y.encodeStateVector(source) });
    assert.equal(persisted.generation, 0);
    const client = new Y.Doc({ guid: page.id }); Y.applyUpdate(client, initial); textFor(client).insert(0, 'durable ');
    const update = Y.encodeStateAsUpdate(client, persisted.stateVector);
    const accepted = await store.collab.acceptUpdate({ workspaceId: workspace.id, pageId: page.id, payload: update, messageKey: 'task18-1' });
    assert.equal(accepted.status, 'applied'); assert.equal(accepted.durable, true); assert.equal(accepted.acknowledged, true); assert.equal(accepted.generation, 1);
    assert.ok(accepted.messageId.timestamp > 0);
    const duplicate = await store.collab.acceptUpdate({ workspaceId: workspace.id, pageId: page.id, payload: update, messageKey: 'task18-1' });
    assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.acknowledged, true); assert.deepEqual(duplicate.messageId, accepted.messageId); assert.equal(duplicate.generation, 1);
    const reloaded = await store.collab.load({ workspaceId: workspace.id, pageId: page.id }); assert.equal(reloaded.generation, 1);
    const recovered = new Y.Doc({ guid: page.id }); Y.applyUpdate(recovered, reloaded.documentState); assert.match(textFor(recovered).toString(), /^durable /);
    const rollbackClient = new Y.Doc({ guid: page.id }); Y.applyUpdate(rollbackClient, reloaded.documentState); textFor(rollbackClient).insert(0, 'rollback ');
    await assert.rejects(() => store.collab.acceptUpdate({ workspaceId: workspace.id, pageId: page.id, payload: Y.encodeStateAsUpdate(rollbackClient, reloaded.stateVector), messageKey: 'rollback', createdAt: 'not-a-timestamp' }), (e) => e.code === '22007');
    await assert.rejects(() => store.collab.persistInitial({ workspaceId: randomUUID(), pageId: page.id, documentState: initial, stateVector: Y.encodeStateVector(source) }), (e) => e.code === 'PAGE_NOT_FOUND');
    await assert.rejects(() => store.collab.acceptUpdate({ workspaceId: workspace.id, pageId: page.id, payload: new Uint8Array([255]), messageKey: 'bad' }), (e) => e.code === 'MALFORMED_YJS_UPDATE');
    const afterFailure = await store.collab.load({ workspaceId: workspace.id, pageId: page.id }); assert.equal(afterFailure.generation, 1);
    const count = await store.pool.query('SELECT count(*)::int AS n FROM collab_updates WHERE page_id=$1', [page.id]); assert.equal(count.rows[0].n, 1);
  } finally { await store.close(); }
});

test('independent PostgreSQL repositories serialize concurrent updates without overwrite', { skip: !configured }, async () => {
  const first = await context(); const second = await openPostgresStore(process.env.DATABASE_URL);
  try {
    const initial = await fixture(); const base = new Y.Doc({ guid: first.page.id }); Y.applyUpdate(base, initial);
    await first.store.collab.persistInitial({ workspaceId: first.workspace.id, pageId: first.page.id, documentState: initial, stateVector: Y.encodeStateVector(base) });
    const a = new Y.Doc({ guid: first.page.id }); Y.applyUpdate(a, initial); textFor(a).insert(0, 'A ');
    const b = new Y.Doc({ guid: first.page.id }); Y.applyUpdate(b, initial); textFor(b).insert(0, 'B ');
    const vector = Y.encodeStateVector(base);
    const results = await Promise.all([
      first.store.collab.acceptUpdate({ workspaceId: first.workspace.id, pageId: first.page.id, payload: Y.encodeStateAsUpdate(a, vector), messageKey: 'concurrent-a' }),
      second.collab.acceptUpdate({ workspaceId: first.workspace.id, pageId: first.page.id, payload: Y.encodeStateAsUpdate(b, vector), messageKey: 'concurrent-b' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['applied', 'applied']);
    const final = await second.collab.load({ workspaceId: first.workspace.id, pageId: first.page.id }); assert.equal(final.generation, 2);
    const recovered = new Y.Doc({ guid: first.page.id }); Y.applyUpdate(recovered, final.documentState); const value = textFor(recovered).toString(); assert.match(value, /A/); assert.match(value, /B/);
  } finally { await first.store.close(); await second.close(); }
});
