// Concurrency of card mutations against browser-style Yjs edits. Everything goes through real Yjs
// documents and the real store acceptance path (JSON storage); the "human" edits are made on a
// document snapshot taken BEFORE the service wrote, exactly like a browser that has not synced yet.
//
// Documented Yjs behaviour these tests pin down:
//  * edits to DIFFERENT cells (or different keys of one cell) always both survive;
//  * concurrent writes to the SAME key resolve deterministically (Yjs orders them by client id), so
//    one of the two values wins identically on every replica and across restarts - no merge, no error.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { CardError, createCardService } from '../cards.js';
import {
  KITCHEN, account, createKitchenSink, createTemplateDatabase, humanEditDatabase, rawRow, recorder, readDatabaseDoc, rowOrdersOf, startCardsEnv,
} from './helpers/cards-env.js';

let env;
let cards;

before(async () => {
  env = await startCardsEnv();
  cards = createCardService({ store: env.store, broadcast: recorder().broadcast });
});
after(async () => { await env.stop(); });

const args = (acct, extra = {}) => ({ workspaceId: acct.workspaceId, userId: acct.userId, ...extra });

/** A browser tab's copy of a collab: a snapshot that later edits are made on, then submitted as a diff. */
async function snapshot(kind, workspaceId, objectId) {
  const collab = await (kind === 'row' ? env.store.getDatabaseRowCollab(workspaceId, objectId) : env.store.getDatabaseCollab(workspaceId, objectId));
  const doc = new Y.Doc({ guid: objectId });

  Y.applyUpdate(doc, collab.doc_state);
  const before = Y.encodeStateVector(doc);

  return {
    doc,
    async submit(mutate) {
      doc.transact(() => mutate(kind === 'row' ? doc.getMap('data').get('data') : doc.getMap('data').get('database')));
      const payload = Y.encodeStateAsUpdate(doc, before);
      const accept = kind === 'row' ? env.store.acceptDatabaseRowCollabUpdate : env.store.acceptDatabaseCollabUpdate;
      const result = await accept({ workspaceId, [kind === 'row' ? 'rowId' : 'databaseId']: objectId, flags: 0, payload, beforeStateVector: before });

      doc.destroy();
      return result;
    },
  };
}

async function seedCard(acct, kitchen, title, extra = {}) {
  const { card } = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title, idempotencyKey: `seed-${title}`, ...extra });

  return card;
}

test('a browser edit made on a stale snapshot and a service update of a different cell both survive', async () => {
  const acct = await account(env, 'conc-different');
  const kitchen = await createKitchenSink(env, acct);
  const card = await seedCard(acct, kitchen, 'shared', { column: 'Todo', fields: { Points: 1, Notes: 'original' } });
  const tab = await snapshot('row', acct.workspaceId, card.id);

  await cards.updateCard({ ...args(acct), cardId: card.id, fields: { Points: 9, Link: 'https://agent.test' } });
  await tab.submit((row) => {
    row.get('cells').get(KITCHEN.notes).set('data', 'edited in browser');
    row.get('cells').get(KITCHEN.notes).set('last_modified', '2000000000');
  });
  const row = await rawRow(env, acct.workspaceId, card.id);

  assert.equal(row.cells[KITCHEN.notes].data, 'edited in browser', 'the browser edit is kept');
  assert.equal(row.cells[KITCHEN.points].data, '9', 'the service edit is kept');
  assert.equal(row.cells[KITCHEN.link].data, 'https://agent.test');
  assert.equal(row.cells[KITCHEN.status].data, 'o_todo', 'unrelated cells are unchanged');
  const read = await cards.getCard({ workspaceId: acct.workspaceId, cardId: card.id });

  assert.deepEqual([read.fields.Notes, read.fields.Points, read.column], ['edited in browser', 9, 'Todo']);
});

test('truly simultaneous browser and service writes to different cells are all applied', async () => {
  const acct = await account(env, 'conc-simultaneous');
  const kitchen = await createKitchenSink(env, acct);
  const card = await seedCard(acct, kitchen, 'race', { fields: { Notes: 'n0' } });

  for (let round = 0; round < 10; round += 1) {
    const tab = await snapshot('row', acct.workspaceId, card.id);

    await Promise.all([
      tab.submit((row) => row.get('cells').get(KITCHEN.notes).set('data', `browser-${round}`)),
      cards.updateCard({ ...args(acct), cardId: card.id, fields: { Points: round } }),
      cards.updateCard({ ...args(acct), cardId: card.id, fields: { Link: `https://r${round}.test` } }),
    ]);
    const row = await rawRow(env, acct.workspaceId, card.id);

    assert.equal(row.cells[KITCHEN.notes].data, `browser-${round}`, `round ${round}: browser edit`);
    assert.equal(row.cells[KITCHEN.points].data, String(round), `round ${round}: points`);
    assert.equal(row.cells[KITCHEN.link].data, `https://r${round}.test`, `round ${round}: link`);
  }
});

test('concurrent writes to the SAME cell resolve to one of the two values, identically on every read', async () => {
  const acct = await account(env, 'conc-same-cell');
  const kitchen = await createKitchenSink(env, acct);
  const card = await seedCard(acct, kitchen, 'contested', { column: 'Todo', fields: { Notes: 'keep' } });
  const tab = await snapshot('row', acct.workspaceId, card.id);

  await cards.moveCard({ ...args(acct), cardId: card.id, column: 'Doing' });
  await tab.submit((row) => row.get('cells').get(KITCHEN.status).set('data', 'o_done'));
  const winner = (await rawRow(env, acct.workspaceId, card.id)).cells[KITCHEN.status].data;

  assert.ok(['o_doing', 'o_done'].includes(winner), `one of the two concurrent values wins, got ${winner}`);
  assert.equal((await rawRow(env, acct.workspaceId, card.id)).cells[KITCHEN.status].data, winner, 'stable across reads');
  assert.equal((await cards.getCard({ workspaceId: acct.workspaceId, cardId: card.id })).column_id, winner);
  assert.equal((await rawRow(env, acct.workspaceId, card.id)).cells[KITCHEN.notes].data, 'keep', 'the unrelated cell is untouched');

  // A replica that applies the same two updates in the opposite order converges to the same value.
  const collab = await env.store.getDatabaseRowCollab(acct.workspaceId, card.id);
  const replica = new Y.Doc();

  Y.applyUpdate(replica, collab.doc_state);
  assert.equal(replica.getMap('data').get('data').get('cells').get(KITCHEN.status).get('data'), winner);
  replica.destroy();
});

test('a browser reorder of the Board and a service archive of another card both persist in the Database row order', async () => {
  const acct = await account(env, 'conc-order');
  const kitchen = await createKitchenSink(env, acct);
  const made = [];

  for (const title of ['a', 'b', 'c', 'd']) made.push(await seedCard(acct, kitchen, title, { column: 'Todo' }));
  const [a, b, c, d] = made;
  const tab = await snapshot('database', acct.workspaceId, kitchen.databaseId);

  await cards.archiveCard({ ...args(acct), cardId: b.id, confirm: true });
  await tab.submit((database) => {
    const orders = database.get('views').get(kitchen.boardViewId).get('row_orders');
    const entries = orders.toArray();
    const index = entries.findIndex((entry) => entry.id === d.id);

    orders.delete(index);
    orders.insert(0, [entries[index]]);
  });
  const board = await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, kitchen.boardViewId);

  assert.equal(board.length, 4, 'no entry lost or duplicated by the merge');
  assert.equal(board[0].id, d.id, 'the browser reorder is kept');
  assert.equal(board.find((entry) => entry.id === b.id).is_deleted, true, 'the service archive is kept');
  assert.ok(board.filter((entry) => entry.id !== b.id).every((entry) => !entry.is_deleted));
  assert.deepEqual((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, viewId: kitchen.boardViewId })).cards.map((card) => card.title), ['d', 'a', 'c']);
  assert.equal(c.title, 'c');
  assert.equal(a.title, 'a');
});

test('creating a card while a browser reorders the same view keeps both', async () => {
  const acct = await account(env, 'conc-create-order');
  const kitchen = await createKitchenSink(env, acct);
  const first = await seedCard(acct, kitchen, 'first');
  const second = await seedCard(acct, kitchen, 'second');
  const tab = await snapshot('database', acct.workspaceId, kitchen.databaseId);
  const created = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'third', idempotencyKey: 'conc-third' });

  await tab.submit((database) => {
    const orders = database.get('views').get(kitchen.gridViewId).get('row_orders');
    const entries = orders.toArray();
    const index = entries.findIndex((entry) => entry.id === second.id);

    orders.delete(index);
    orders.insert(0, [entries[index]]);
  });
  const grid = (await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, kitchen.gridViewId)).map((entry) => entry.id);

  assert.deepEqual(grid, [second.id, first.id, created.card.id]);
});

test('simultaneous service calls: parallel updates, moves, creates and a duplicate create are all consistent', async () => {
  const acct = await account(env, 'conc-parallel');
  const kitchen = await createKitchenSink(env, acct);
  const card = await seedCard(acct, kitchen, 'parallel');

  await Promise.all([
    cards.updateCard({ ...args(acct), cardId: card.id, fields: { Points: 4 } }),
    cards.updateCard({ ...args(acct), cardId: card.id, fields: { Notes: 'n' } }),
    cards.updateCard({ ...args(acct), cardId: card.id, fields: { Link: 'https://p.test' } }),
    cards.updateCard({ ...args(acct), cardId: card.id, fields: { Priority: 'High', Labels: ['Ops'] } }),
    cards.updateCard({ ...args(acct), cardId: card.id, fields: { Reviewed: true, Due: '2026-05-05' } }),
  ]);
  const merged = await cards.getCard({ workspaceId: acct.workspaceId, cardId: card.id });

  assert.deepEqual(merged.fields, { Priority: 'High', Labels: ['Ops'], Reviewed: true, Link: 'https://p.test', Due: '2026-05-05', Points: 4, Notes: 'n' });

  const results = await Promise.all(['x', 'y', 'z'].map((title) => cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title, column: 'Todo', idempotencyKey: `par-${title}` })));
  const ids = results.map((result) => result.card.id);

  assert.equal(new Set(ids).size, 3);
  const duplicates = await Promise.all([0, 1, 2, 3].map(() => cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'same', idempotencyKey: 'par-same' })));

  assert.equal(new Set(duplicates.map((result) => result.card.id)).size, 1, 'one row for four simultaneous identical requests');
  assert.equal(duplicates.filter((result) => !result.replayed).length, 1);
  const grid = (await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, kitchen.gridViewId)).map((entry) => entry.id);

  assert.equal(grid.length, 5, 'parallel + 3 created + 1 deduplicated');
  assert.equal(new Set(grid).size, 5);

  await Promise.all(ids.map((id, index) => cards.moveCard({ ...args(acct), cardId: id, column: ['Doing', 'Done', 'Doing'][index] })));
  const board = (await cards.getDatabase({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId })).boards[0];

  assert.deepEqual(Object.fromEntries(board.columns.map((column) => [column.name, column.card_count])), { 'No status': 2, Todo: 0, Doing: 2, Done: 1 });
});

test('CONCURRENT_UPDATE (Postgres) is retried against a fresh read, never by resubmitting stale state', async () => {
  const acct = await account(env, 'conc-retry');
  const kitchen = await createKitchenSink(env, acct);
  const card = await seedCard(acct, kitchen, 'retry', { fields: { Notes: 'start' } });
  const original = env.store.acceptDatabaseRowCollabUpdate;
  let calls = 0;

  env.store.acceptDatabaseRowCollabUpdate = async (request) => {
    calls += 1;
    if (calls === 1) {
      // Another writer lands between our read and our write, then the store reports the conflict.
      const tab = await snapshot('row', acct.workspaceId, card.id);

      env.store.acceptDatabaseRowCollabUpdate = original;
      await tab.submit((row) => row.get('cells').get(KITCHEN.notes).set('data', 'other writer'));
      env.store.acceptDatabaseRowCollabUpdate = async (retryRequest) => { calls += 1; return original(retryRequest); };
      throw Object.assign(new Error('generation moved'), { code: 'CONCURRENT_UPDATE' });
    }
    return original(request);
  };
  try {
    await cards.updateCard({ ...args(acct), cardId: card.id, fields: { Points: 8 } });
  } finally {
    env.store.acceptDatabaseRowCollabUpdate = original;
  }
  const row = await rawRow(env, acct.workspaceId, card.id);

  assert.equal(calls, 2, 'exactly one retry');
  assert.equal(row.cells[KITCHEN.notes].data, 'other writer', 'the competing write was not overwritten');
  assert.equal(row.cells[KITCHEN.points].data, '8');

  // Persistent conflicts surface after a bounded number of attempts instead of looping.
  let attempts = 0;

  env.store.acceptDatabaseRowCollabUpdate = async () => { attempts += 1; throw Object.assign(new Error('still moving'), { code: 'CONCURRENT_UPDATE' }); };
  try {
    const failure = await cards.updateCard({ ...args(acct), cardId: card.id, fields: { Points: 9 } }).catch((error) => error);

    assert.equal(failure.code, 'CONCURRENT_UPDATE');
    assert.ok(!(failure instanceof CardError));
    assert.equal(attempts, 3);
  } finally {
    env.store.acceptDatabaseRowCollabUpdate = original;
  }
  assert.equal((await rawRow(env, acct.workspaceId, card.id)).cells[KITCHEN.points].data, '8', 'nothing was applied');
});

test('the Board column write and a concurrent browser write to a field of another Board do not interfere', async () => {
  const acct = await account(env, 'conc-two-fields');
  const tasks = await createTemplateDatabase(env, acct, 'tasks');
  const listed = (await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 1 })).cards[0];
  const tab = await snapshot('row', acct.workspaceId, listed.id);

  await humanEditDatabase(env, acct.workspaceId, tasks.databaseId, () => {});
  await cards.updateCard({ ...args(acct), cardId: listed.id, fields: { Status: 'Backlog' } });
  await tab.submit((row) => row.get('cells').get('B4Sgk1').set('data', 'forced-by-browser'));
  const row = await rawRow(env, acct.workspaceId, listed.id);

  assert.equal(row.cells['B4Sgk1'].data, 'forced-by-browser');
  assert.equal((await cards.getCard({ workspaceId: acct.workspaceId, cardId: listed.id })).fields.Status, 'Backlog');
  const database = await readDatabaseDoc(env, acct.workspaceId, tasks.databaseId);

  try {
    assert.ok(database.database.get('views').size >= 1);
  } finally {
    database.doc.destroy();
  }
});
