// Live collaboration for MCP-originated card changes: real WebSocket clients ("viewers") subscribe to the
// Database and DatabaseRow collab objects, an agent changes cards over real /mcp HTTP with a real token, and
// every received frame is applied to a local Y.Doc whose resulting state is asserted (not just frame arrival).
// Runs for the JSON store, and for a real PostgreSQL when RUN_POSTGRES_TESTS=1 + DATABASE_URL are set.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { account, createTemplateDatabase, startCardsEnv } from './helpers/cards-env.js';
import { COLLAB, eachStorageMode, mcpOk, mcpTool, mintToken, openViewer, rowData, viewRowOrders } from './helpers/mcp-live-env.js';

eachStorageMode('MCP live collab', (mode) => {
  let env, owner, outsider, db1, db2, token, fields, titleFieldId, boardViewId, viewIds, cardIds;
  let viewerA, viewerB, viewerC;
  const persistedAt = [];

  const idFor = (name) => fields.find((field) => field.name === name).id;
  const optionId = (fieldName, optionName) => fields.find((field) => field.name === fieldName).options.find((option) => option.name === optionName).id;
  const readRow = async (rowId) => {
    const collab = await env.store.getDatabaseRowCollab(owner.workspaceId, rowId);
    const doc = new Y.Doc({ guid: rowId });

    Y.applyUpdate(doc, collab.doc_state);
    return rowData(doc);
  };

  before(async () => {
    env = await startCardsEnv({ storage: mode });
    owner = await account(env, `live-owner-${mode}`);
    outsider = await account(env, `live-outsider-${mode}`);
    db1 = await createTemplateDatabase(env, owner, 'opportunities', 'Live DB');
    db2 = await createTemplateDatabase(env, owner, 'tasks', 'Other DB');
    const otherWorkspaceDb = await createTemplateDatabase(env, outsider, 'tasks', 'Outsider DB');

    ({ token } = await mintToken(env, owner, { scope: 'write' }));
    const detail = (await mcpOk(env, token, 'get_database', { database_id: db1.databaseId })).database;

    fields = detail.fields;
    titleFieldId = detail.title_field.id;
    boardViewId = detail.boards[0].view_id;
    viewIds = detail.views.map((view) => view.view_id);
    cardIds = (await mcpOk(env, token, 'list_cards', { database_id: db1.databaseId, view_id: boardViewId, limit: 100 })).cards.map((card) => card.id);

    // Measure when persistence resolves, to prove persist-before-broadcast.
    const original = env.store.acceptDatabaseRowCollabUpdate.bind(env.store);

    env.store.acceptDatabaseRowCollabUpdate = async (args) => {
      const result = await original(args);

      persistedAt.push({ rowId: args.rowId, at: process.hrtime.bigint() });
      return result;
    };

    viewerA = await openViewer(env, owner, [
      { collabType: COLLAB.database, objectId: db1.databaseId },
      { collabType: COLLAB.row, objectId: cardIds[0] },
      { collabType: COLLAB.row, objectId: cardIds[1] },
    ], 7101);
    viewerB = await openViewer(env, outsider, [
      { collabType: COLLAB.database, objectId: otherWorkspaceDb.databaseId },
      { collabType: COLLAB.row, objectId: otherWorkspaceDb.rowIds[0] },
    ], 7102);
    viewerC = await openViewer(env, owner, [
      { collabType: COLLAB.database, objectId: db2.databaseId },
      { collabType: COLLAB.row, objectId: db2.rowIds[0] },
    ], 7103);
  });

  after(async () => {
    for (const viewer of [viewerA, viewerB, viewerC]) viewer?.close();
    await env?.stop();
  });

  test('create_card reaches an already-open Database subscriber in every view, and the new row is readable through the normal collab read path', async () => {
    const created = await mcpOk(env, token, 'create_card', { database_id: db1.databaseId, title: 'Live created card', column: 'Validated', fields: { Owner: 'Agent' }, idempotency_key: `live-create-${mode}-0001` });
    const newId = created.card.id;

    await viewerA.waitUntil(() => viewIds.every((viewId) => viewRowOrders(viewerA.doc(COLLAB.database, db1.databaseId), viewId).some((entry) => entry.id === newId)));
    for (const viewId of viewIds) {
      const entry = viewRowOrders(viewerA.doc(COLLAB.database, db1.databaseId), viewId).find((order) => order.id === newId);

      assert.ok(entry && !entry.is_deleted, `the card is in view ${viewId}`);
    }
    assert.equal(viewerA.framesFor(COLLAB.row, cardIds[0]).length, 0, 'a creation does not touch other rows');

    const read = await env.api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${newId}?collab_type=4`, undefined, owner.token);

    assert.equal(read.status, 200, JSON.stringify(read.body));
    const rowDoc = new Y.Doc();

    Y.applyUpdate(rowDoc, new Uint8Array(read.body.data.doc_state));
    const cells = rowData(rowDoc).cells;

    assert.equal(cells[titleFieldId].data, 'Live created card');
    assert.equal(cells[idFor('Stage')].data, optionId('Stage', 'Validated'));
    assert.equal(cells[idFor('Owner')].data, 'Agent');
    cardIds.push(newId);
  });

  test('update_card (title + property) reaches only the subscribed row, after it was persisted', async () => {
    const before = { r2: viewerA.framesFor(COLLAB.row, cardIds[1]).length, db: viewerA.framesFor(COLLAB.database, db1.databaseId).length };

    await mcpOk(env, token, 'update_card', { card_id: cardIds[0], title: 'Renamed live', fields: { Owner: 'Live Owner', Impact: 3 } });
    await viewerA.waitUntil(() => rowData(viewerA.doc(COLLAB.row, cardIds[0])).cells?.[titleFieldId]?.data === 'Renamed live');
    const cells = rowData(viewerA.doc(COLLAB.row, cardIds[0])).cells;

    assert.equal(cells[idFor('Owner')].data, 'Live Owner');
    assert.equal(cells[idFor('Impact')].data, '3');
    await viewerA.quiet(300);
    assert.equal(viewerA.framesFor(COLLAB.row, cardIds[1]).length, before.r2, 'a subscriber with several objects gets only the right one');
    assert.equal(viewerA.framesFor(COLLAB.database, db1.databaseId).length, before.db, 'a field edit does not send a Database frame');

    const persisted = await readRow(cardIds[0]);

    assert.equal(persisted.cells[titleFieldId].data, 'Renamed live', 'the persisted row matches what the peer saw');
    const firstFrame = viewerA.framesFor(COLLAB.row, cardIds[0]).at(-1);
    const saved = persistedAt.filter((entry) => entry.rowId === cardIds[0]).at(-1);

    assert.ok(saved, 'the persistence hook observed the accept call (cards.js goes through store.acceptDatabaseRowCollabUpdate)');
    assert.ok(saved.at <= firstFrame.at, 'persisted before the peer frame arrived');
  });

  test('move_card changes the grouping cell (row peer) and the order (Database peer)', async () => {
    const researching = (await mcpOk(env, token, 'list_cards', { database_id: db1.databaseId, view_id: boardViewId, column: 'Researching', limit: 10 })).cards;
    const mover = (await mcpOk(env, token, 'list_cards', { database_id: db1.databaseId, view_id: boardViewId, column: 'Prioritized', limit: 10 })).cards[0];

    let target = researching[0];

    if (!target) {
      // No card in Researching yet: move one there first, then reorder a second card next to it.
      await mcpOk(env, token, 'move_card', { card_id: mover.id, column: 'Researching', view_id: boardViewId });
      target = { id: mover.id };
    }
    const second = (await mcpOk(env, token, 'list_cards', { database_id: db1.databaseId, view_id: boardViewId, column: 'Validated', limit: 10 })).cards.find((card) => card.id !== target.id);

    assert.ok(second, 'a second card exists to move');
    const dbFramesBefore = viewerA.framesFor(COLLAB.database, db1.databaseId).length;
    const result = await mcpOk(env, token, 'move_card', { card_id: second.id, column: 'Researching', view_id: boardViewId, before_card_id: target.id });

    assert.equal(result.card.column, 'Researching');
    assert.equal(result.order_changed, true);

    await viewerA.waitUntil(() => {
      const order = viewRowOrders(viewerA.doc(COLLAB.database, db1.databaseId), boardViewId).map((entry) => entry.id);

      return order.indexOf(second.id) !== -1 && order.indexOf(second.id) === order.indexOf(target.id) - 1;
    });
    assert.ok(viewerA.framesFor(COLLAB.database, db1.databaseId).length > dbFramesBefore, 'a Database frame carried the reorder');
    const persisted = await readRow(second.id);

    assert.equal(persisted.cells[idFor('Stage')].data, optionId('Stage', 'Researching'));
    const subscribed = cardIds.slice(0, 2).includes(second.id);

    if (subscribed) await viewerA.waitUntil(() => rowData(viewerA.doc(COLLAB.row, second.id)).cells?.[idFor('Stage')]?.data === optionId('Stage', 'Researching'));
  });

  test('archive and restore reach the Database subscriber in every view', async () => {
    const target = cardIds[0];
    const flags = () => viewIds.map((viewId) => viewRowOrders(viewerA.doc(COLLAB.database, db1.databaseId), viewId).find((entry) => entry.id === target)?.is_deleted === true);

    await mcpOk(env, token, 'archive_card', { card_id: target, confirm: true });
    await viewerA.waitUntil(() => flags().every(Boolean));
    assert.equal((await mcpOk(env, token, 'list_cards', { database_id: db1.databaseId, view_id: boardViewId, limit: 100 })).cards.some((card) => card.id === target), false, 'archived cards are not listed');

    await mcpOk(env, token, 'restore_card', { card_id: target, confirm: true });
    await viewerA.waitUntil(() => flags().every((deleted) => !deleted));
    assert.equal((await mcpOk(env, token, 'list_cards', { database_id: db1.databaseId, view_id: boardViewId, limit: 100 })).cards.some((card) => card.id === target), true, 'restored cards are listed again');
  });

  test('a peer that disappears does not break persistence or the other peers', async () => {
    const dying = await openViewer(env, owner, [{ collabType: COLLAB.row, objectId: cardIds[1] }], 7104);

    dying.close();
    const result = await mcpTool(env, token, 'update_card', { card_id: cardIds[1], title: 'After a peer vanished' });

    assert.equal(result.status, 200);
    assert.notEqual(result.result.isError, true, JSON.stringify(result.result));
    await viewerA.waitUntil(() => rowData(viewerA.doc(COLLAB.row, cardIds[1])).cells?.[titleFieldId]?.data === 'After a peer vanished');
    assert.equal((await readRow(cardIds[1])).cells[titleFieldId].data, 'After a peer vanished', 'the change is persisted');
  });

  test('peers in another workspace or subscribed to another database/row received nothing', async () => {
    await viewerB.quiet(200);
    assert.equal(viewerB.received.length, 0, 'a peer in another workspace receives nothing');
    assert.equal(viewerC.received.length, 0, 'a peer on a different database and row (same workspace) receives nothing');
  });
});
