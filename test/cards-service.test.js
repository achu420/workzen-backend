// Card service (cards.js): discovery, listing/paging/search, create (idempotent), update, move,
// archive/restore. JSON storage, real Yjs documents, real store acceptance; assertions read the
// persisted collab documents. Postgres is NOT covered here (see docs/LIGHT_MCP_ARCHITECTURE_REPORT.md).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { CardError, createCardService } from '../cards.js';
import { rowDocumentIdFromRowId } from '../page-document.js';
import {
  KITCHEN, account, addBoardView, applyDiff, createKitchenSink, createTemplateDatabase, humanEditDatabase, humanEditRow, id, rawRow, recorder,
  readDatabaseDoc, rowOrdersOf, setBoardGroupField, startCardsEnv,
} from './helpers/cards-env.js';

let env;
let rec;
let cards;

before(async () => {
  env = await startCardsEnv();
  rec = recorder();
  cards = createCardService({ store: env.store, broadcast: rec.broadcast });
});
after(async () => { await env.stop(); });

async function rejects(promise, code, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CardError, `expected a CardError, got ${error?.stack ?? error}`);
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected CardError ${code}`);
  return null;
}

const args = (acct, extra = {}) => ({ workspaceId: acct.workspaceId, userId: acct.userId, ...extra });
const columnCounts = (board) => Object.fromEntries(board.columns.map((column) => [column.name, column.card_count]));

// ------------------------------------------------------------------ discovery
test('listDatabases and getDatabase describe databases, fields, options with colours and Board columns', async () => {
  const acct = await account(env, 'cards-discovery');
  const opp = await createTemplateDatabase(env, acct, 'opportunities');
  const list = await cards.listDatabases({ workspaceId: acct.workspaceId });

  assert.deepEqual(list.map((entry) => [entry.database_id, entry.name, entry.has_board]), [[opp.databaseId, 'Opportunities', true]]);
  assert.deepEqual(list[0].views.map((view) => [view.name, view.layout]), [['By Score', 0], ['By Stage', 1]]);
  assert.equal(list[0].workspace_id, acct.workspaceId);

  const db = await cards.getDatabase({ workspaceId: acct.workspaceId, databaseId: opp.databaseId });

  assert.deepEqual(db.title_field, { id: '_l_VbU', name: 'Opportunity ID' });
  const stage = db.fields.find((field) => field.name === 'Stage');

  assert.equal(stage.type, 'single_select');
  assert.deepEqual(stage.options.map((option) => option.name), ['Prioritized', 'Validated', 'Researching']);
  assert.ok(stage.options.every((option) => typeof option.color === 'string' && option.color));
  assert.equal(db.fields.find((field) => field.name === 'Impact').type, 'number');
  assert.equal(db.fields.find((field) => field.is_primary).name, 'Opportunity ID');

  assert.equal(db.boards.length, 1);
  assert.equal(db.boards[0].name, 'By Stage');
  assert.deepEqual(db.boards[0].group_field, { id: 'DQQEP0', name: 'Stage', type: 'single_select' });
  assert.deepEqual(columnCounts(db.boards[0]), { 'No status': 0, Prioritized: 3, Validated: 2, Researching: 1 });
  assert.equal(db.boards[0].has_no_status_column, true);
  assert.equal(db.boards[0].columns[0].id, null);
});

test('only readable databases of the right workspace are visible; trashed and unreadable ones are not', async () => {
  const owner = await account(env, 'cards-scope-owner');
  const outsider = await account(env, 'cards-scope-outsider');
  const mine = await createTemplateDatabase(env, owner, 'projects');
  const theirs = await createTemplateDatabase(env, outsider, 'epics');
  const ownerCards = (await cards.listCards({ workspaceId: owner.workspaceId, databaseId: mine.databaseId })).cards;

  assert.deepEqual((await cards.listDatabases({ workspaceId: owner.workspaceId })).map((entry) => entry.database_id), [mine.databaseId]);
  await rejects(cards.getDatabase({ workspaceId: owner.workspaceId, databaseId: theirs.databaseId }), 'NOT_FOUND');
  await rejects(cards.listCards({ workspaceId: owner.workspaceId, databaseId: theirs.databaseId }), 'NOT_FOUND');
  await rejects(cards.getCard({ workspaceId: outsider.workspaceId, cardId: ownerCards[0].id }), 'NOT_FOUND');
  await rejects(cards.getCard({ workspaceId: owner.workspaceId, cardId: id() }), 'NOT_FOUND');
  await rejects(cards.updateCard({ ...args(outsider, { cardId: ownerCards[0].id, title: 'x' }) }), 'NOT_FOUND');
  await rejects(cards.archiveCard({ ...args(outsider, { cardId: ownerCards[0].id, confirm: true }) }), 'NOT_FOUND');

  const unreadable = createCardService({ store: env.store, isReadableSpace: () => false });

  assert.deepEqual(await unreadable.listDatabases({ workspaceId: owner.workspaceId }), []);
  await rejects(unreadable.getCard({ workspaceId: owner.workspaceId, cardId: ownerCards[0].id }), 'NOT_FOUND');

  const trashed = await env.api('POST', `/api/workspace/${owner.workspaceId}/page-view/${mine.containerId}/move-to-trash`, undefined, owner.token);

  assert.equal(trashed.status, 200);
  assert.deepEqual(await cards.listDatabases({ workspaceId: owner.workspaceId }), []);
  await rejects(cards.getCard({ workspaceId: owner.workspaceId, cardId: ownerCards[0].id }), 'NOT_FOUND');
});

// ------------------------------------------------------------------ listing
test('listCards pages through a view with an opaque cursor in view order, without duplicates or gaps', async () => {
  const acct = await account(env, 'cards-paging');
  const tasks = await createTemplateDatabase(env, acct, 'tasks');
  const gridOrder = (await rowOrdersOf(env, acct.workspaceId, tasks.databaseId, tasks.viewIds[0])).map((entry) => entry.id);
  const seen = [];
  let cursor = null;
  let pages = 0;

  do {
    const page = await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 10, cursor });

    assert.ok(page.cards.length <= 10);
    seen.push(...page.cards.map((card) => card.id));
    cursor = page.next_cursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, gridOrder, 'every card once, in the view\'s own order');

  const all = await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 1000 });

  assert.equal(all.cards.length, 28, 'limit is clamped to 100 and the database has 28 cards');
  assert.equal(all.next_cursor, null);
  assert.equal((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 0 })).cards.length, 1);
  assert.equal((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId })).cards.length, 25, 'default page size');
});

test('cursors are validated and survive the last card being archived between pages (documented behaviour)', async () => {
  const acct = await account(env, 'cards-cursor');
  const tasks = await createTemplateDatabase(env, acct, 'tasks');
  const first = await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 5 });

  await rejects(cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 5, cursor: 'garbage' }), 'INVALID_INPUT');
  await rejects(cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 5, cursor: first.next_cursor, query: 'other' }), 'INVALID_INPUT', /cursor/);
  const other = await createTemplateDatabase(env, acct, 'projects');

  await rejects(cards.listCards({ workspaceId: acct.workspaceId, databaseId: other.databaseId, limit: 5, cursor: first.next_cursor }), 'INVALID_INPUT', /cursor/);

  // The card the cursor points at disappears: paging resumes at its old position instead of failing or restarting.
  const last = first.cards[first.cards.length - 1];

  await cards.archiveCard({ ...args(acct, { cardId: last.id, confirm: true }) });
  const second = await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 5, cursor: first.next_cursor });
  const remaining = (await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 100 })).cards.map((card) => card.id);

  assert.deepEqual(second.cards.map((card) => card.id), remaining.slice(4, 9), 'no card skipped or repeated after the archive');
});

test('column filter, text query, candidate verification and view rules', async () => {
  const acct = await account(env, 'cards-filters');
  const tasks = await createTemplateDatabase(env, acct, 'tasks');
  const other = await createTemplateDatabase(env, acct, 'epics');
  const boardId = await addBoardView(env, acct, { databaseId: tasks.databaseId, containerId: tasks.containerId, name: 'Status board' });
  const db = await cards.getDatabase({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId });
  const counts = columnCounts(db.boards[0]);

  assert.equal(db.boards[0].view_id, boardId);
  assert.ok(counts['In progress'] > 0);
  const inProgress = await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, column: 'in PROGRESS', limit: 100 });

  assert.equal(inProgress.cards.length, counts['In progress']);
  assert.ok(inProgress.cards.every((card) => card.column === 'In progress'));
  const viaBoard = await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, viewId: boardId, column: 'In progress', limit: 100 });

  assert.deepEqual(viaBoard.cards.map((card) => card.id).sort(), inProgress.cards.map((card) => card.id).sort());
  const error = await rejects(cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, column: 'Nope' }), 'INVALID_INPUT', /Valid|Columns/);

  assert.match(error.message, /No status/);
  const epics = await cards.listCards({ workspaceId: acct.workspaceId, databaseId: other.databaseId, column: 'x' }).catch((e) => e);

  assert.equal(epics.code, 'INVALID_INPUT', 'a database without a Board has no columns');
  await rejects(cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, viewId: tasks.viewIds[0], column: 'To do' }), 'INVALID_INPUT', /not a Board/);

  const one = await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, query: 'TSK-001' });

  assert.equal(one.cards.length, 1);
  assert.equal(one.cards[0].title, 'TSK-001');
  assert.equal((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, query: 'tsk-001 definitely-not-there' })).cards.length, 0, 'every term must match');

  // A candidate provider (the search index) can narrow the scan, but ids outside this database or workspace never leak in.
  const foreign = (await cards.listCards({ workspaceId: acct.workspaceId, databaseId: other.databaseId, limit: 1 })).cards[0].id;
  const candidateService = createCardService({ store: env.store, searchRows: async () => [foreign, one.cards[0].id, id()] });
  const verified = await candidateService.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, query: 'TSK-001' });

  assert.deepEqual(verified.cards.map((card) => card.id), [one.cards[0].id]);
  const unavailable = createCardService({ store: env.store, searchRows: async () => null });

  assert.equal((await unavailable.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, query: 'TSK-001' })).cards.length, 1, 'falls back to scanning');
  await rejects(cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, viewId: id() }), 'NOT_FOUND');
  await rejects(cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, archived: 'maybe' }), 'INVALID_INPUT');
});

test('getCard reads typed values: numbers, dates, option names, checkbox, multi-select', async () => {
  const acct = await account(env, 'cards-read');
  const tasks = await createTemplateDatabase(env, acct, 'tasks');
  const first = (await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 1 })).cards[0];
  const card = await cards.getCard({ workspaceId: acct.workspaceId, cardId: first.id });

  assert.equal(card.id, first.id);
  assert.equal(card.database_name, 'Tasks');
  assert.equal(typeof card.fields.Estimate, 'number');
  assert.match(card.fields['Due Date'], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof card.fields.Status, 'string');
  assert.equal(card.archived, false);
  assert.match(card.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(card.column, null, 'a database without a Board view has no columns');
  assert.equal(card.column_id, null);

  const opp = await createTemplateDatabase(env, acct, 'opportunities');
  const boardCard = (await cards.listCards({ workspaceId: acct.workspaceId, databaseId: opp.databaseId, limit: 1 })).cards[0];

  assert.equal(boardCard.column, boardCard.fields.Stage, 'the Board column is the grouping field value');
  assert.equal(boardCard.column_id, 'G0ZZ');
});

// ------------------------------------------------------------------ create
test('createCard writes web-shaped cells and puts the row in every view (Grid and Board)', async () => {
  const acct = await account(env, 'cards-create');
  const kitchen = await createKitchenSink(env, acct);
  const created = await cards.createCard({
    ...args(acct), databaseId: kitchen.databaseId, title: 'Ship it', column: 'doing', idempotencyKey: 'create-1',
    fields: { Points: 3, Labels: ['bug', 'UI'], Reviewed: true, Due: '2026-03-02', Link: 'https://example.test/a', Notes: 'remember', Priority: 'High' },
  });
  const card = created.card;

  assert.equal(created.replayed, false);
  assert.equal(card.title, 'Ship it');
  assert.equal(card.column, 'Doing');
  assert.deepEqual(card.fields, { Status: 'Doing', Priority: 'High', Labels: ['Bug', 'UI'], Reviewed: true, Link: 'https://example.test/a', Due: '2026-03-02', Points: 3, Notes: 'remember' });

  const row = await rawRow(env, acct.workspaceId, card.id);
  const cell = (fieldId) => row.cells[fieldId];

  assert.equal(row.created_by, acct.uid, 'created by the calling user');
  assert.equal(row.last_edited_by, acct.uid);
  assert.equal(row.database_id, kitchen.databaseId);
  assert.equal(row.visibility, true);
  assert.deepEqual([cell(KITCHEN.status).data, cell(KITCHEN.status).field_type], ['o_doing', 3]);
  assert.deepEqual([cell(KITCHEN.labels).data, cell(KITCHEN.labels).field_type], ['l_bug,l_ui', 4]);
  assert.deepEqual([cell(KITCHEN.reviewed).data, cell(KITCHEN.reviewed).field_type], ['Yes', 5]);
  assert.deepEqual([cell(KITCHEN.points).data, cell(KITCHEN.points).field_type], ['3', 1]);
  assert.deepEqual([cell(KITCHEN.link).data, cell(KITCHEN.link).field_type], ['https://example.test/a', 6]);
  assert.deepEqual([cell(KITCHEN.notes).data, cell(KITCHEN.notes).field_type], ['remember', 0]);
  assert.equal(cell(KITCHEN.due).data, String(Date.UTC(2026, 2, 2) / 1000), 'date-only values are midnight in the service time zone (UTC)');
  assert.equal(cell(KITCHEN.due).include_time, false);
  assert.equal(cell(KITCHEN.due).is_range, false);
  assert.equal(cell(KITCHEN.due).field_type, 2);
  assert.equal(cell(KITCHEN.status).created_at, cell(KITCHEN.status).last_modified);
  assert.match(cell(KITCHEN.status).created_at, /^\d{10}$/, 'unix seconds as a string, like the web');

  for (const viewId of [kitchen.gridViewId, kitchen.boardViewId]) {
    const orders = await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, viewId);

    assert.deepEqual(orders.map((entry) => entry.id), [card.id], `row is in view ${viewId}`);
    assert.ok(!orders[0].is_deleted);
  }
  assert.deepEqual(rec.events.filter((event) => event.objectId === kitchen.databaseId).map((event) => event.collabType), [1]);
});

test('createCard without a column leaves the Board cell empty ("No status"), still visible in Grid and Board', async () => {
  const acct = await account(env, 'cards-nostatus');
  const kitchen = await createKitchenSink(env, acct);
  const { card } = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'Loose', idempotencyKey: 'ns-1' });

  assert.equal(card.column, 'No status');
  assert.equal(card.column_id, null);
  const row = await rawRow(env, acct.workspaceId, card.id);

  assert.equal(row.cells[KITCHEN.status], undefined, 'no grouping cell is written');
  assert.ok((await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, kitchen.gridViewId)).some((entry) => entry.id === card.id));
  const board = (await cards.getDatabase({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId })).boards[0];

  assert.equal(columnCounts(board)['No status'], 1);
  assert.equal((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, column: 'no status' })).cards[0].id, card.id);
  const explicit = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'Explicit none', column: 'No status', idempotencyKey: 'ns-2' });

  assert.equal(explicit.card.column, 'No status');
  assert.equal((await rawRow(env, acct.workspaceId, explicit.card.id)).cells[KITCHEN.status], undefined);
});

test('createCard validation: title, idempotency key, columns, fields, ambiguity', async () => {
  const acct = await account(env, 'cards-create-invalid');
  const kitchen = await createKitchenSink(env, acct);
  const base = { ...args(acct), databaseId: kitchen.databaseId, idempotencyKey: 'v' };

  await rejects(cards.createCard({ ...base, title: '' }), 'INVALID_INPUT', /title/);
  await rejects(cards.createCard({ ...base, title: 'x', idempotencyKey: undefined }), 'INVALID_INPUT', /idempotency_key/);
  await rejects(cards.createCard({ ...base, title: 'x', column: 'Blocked' }), 'INVALID_INPUT', /Valid|Columns/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Nope: 1 } }), 'INVALID_INPUT', /Unknown field/);
  // Relation values are writable since the schema tools; a relation field that points at no database still refuses them.
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Related: 'a' } }), 'UNSUPPORTED', /not linked to a database/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Related: [7] } }), 'INVALID_INPUT', /card ids/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Points: 'many' } }), 'INVALID_INPUT', /number/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Reviewed: 'yes' } }), 'INVALID_INPUT', /true or false/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Priority: 'Urgent' } }), 'INVALID_INPUT', /Valid options/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Labels: ['Bug', 'Nope'] } }), 'INVALID_INPUT', /Valid options/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Link: 'javascript:alert(1)' } }), 'INVALID_INPUT', /scheme/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Name: 'dup' } }), 'INVALID_INPUT', /title/);
  await rejects(cards.createCard({ ...base, title: 'x', column: 'Done', fields: { Status: 'Todo' } }), 'INVALID_INPUT', /Board column/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Due: '2026-02-30' } }), 'INVALID_INPUT', /real calendar date/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Due: 'tomorrow' } }), 'INVALID_INPUT', /supported date/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { Due: { start: '2026-01-01', end: '2026-01-02' } } }), 'UNSUPPORTED', /ranges/);
  await rejects(cards.createCard({ ...base, title: 'x', databaseId: id() }), 'NOT_FOUND');
  assert.equal((await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, kitchen.gridViewId)).length, 0, 'nothing was created by the failed requests');

  // Duplicate option names and duplicate field names are ambiguous, never guessed.
  await humanEditDatabase(env, acct.workspaceId, kitchen.databaseId, (database) => {
    const status = database.get('fields').get(KITCHEN.status);
    const config = status.get('type_option').get('3');
    const content = JSON.parse(config.get('content'));

    content.options.push({ id: 'o_doing2', name: 'doing', color: 'Red' });
    config.set('content', JSON.stringify(content));
    database.get('fields').get(KITCHEN.priority).set('name', 'status');
  });
  await rejects(cards.createCard({ ...base, title: 'x', column: 'Doing' }), 'AMBIGUOUS', /Several columns/);
  await rejects(cards.createCard({ ...base, title: 'x', fields: { status: 'Todo' } }), 'AMBIGUOUS', /Several fields/);
  const byId = await cards.createCard({ ...base, title: 'by id', fields: { [KITCHEN.priority]: 'High' }, idempotencyKey: 'by-id' });

  assert.equal(byId.card.fields['status [f_priority]'], 'High', 'duplicate field names are disambiguated with their id');
});

test('createCard is idempotent: replay, payload mismatch, per-principal scope and restart', async () => {
  const acct = await account(env, 'cards-idempotent');
  const kitchen = await createKitchenSink(env, acct);
  const request = { ...args(acct), databaseId: kitchen.databaseId, title: 'Once', column: 'Todo', fields: { Points: 1 }, idempotencyKey: 'same-key' };
  const first = await cards.createCard(request);
  const eventsAfterFirst = rec.events.length;
  const again = await cards.createCard(request);

  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(again.card.id, first.card.id);
  assert.equal(rec.events.length, eventsAfterFirst, 'a replay broadcasts nothing');
  const conflict = await rejects(cards.createCard({ ...request, title: 'Different' }), 'CONFLICT', /different/);

  assert.ok(conflict);
  await rejects(cards.createCard({ ...request, fields: { Points: 2 } }), 'CONFLICT');
  const orders = await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, kitchen.gridViewId);

  assert.equal(orders.filter((entry) => entry.id === first.card.id).length, 1, 'exactly one row exists');
  assert.equal(orders.length, 1);

  // The same key from another principal is an independent request.
  const other = await cards.createCard({ ...request, tokenId: 'token-b' });

  assert.notEqual(other.card.id, first.card.id);
  assert.equal(other.replayed, false);
  const sameToken = await cards.createCard({ ...request, tokenId: 'token-b' });

  assert.equal(sameToken.card.id, other.card.id);

  // The ledger is persisted: a fresh store loaded from the saved file replays too.
  const reopened = await env.reopenStore('restart-copy');
  const restarted = createCardService({ store: reopened });
  const replayAfterRestart = await restarted.createCard(request);

  assert.equal(replayAfterRestart.replayed, true);
  assert.equal(replayAfterRestart.card.id, first.card.id);
  await rejects(restarted.createCard({ ...request, title: 'Different' }), 'CONFLICT');
});

// ------------------------------------------------------------------ update
test('updateCard changes only the requested cells and keeps the rest and the row metadata conventions', async () => {
  const acct = await account(env, 'cards-update');
  const kitchen = await createKitchenSink(env, acct);
  const { card } = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'Draft', column: 'Todo', fields: { Points: 2, Notes: 'keep me', Labels: ['Bug'] }, idempotencyKey: 'u-1' });
  const before = await rawRow(env, acct.workspaceId, card.id);

  rec.events.length = 0;
  const updated = await cards.updateCard({ ...args(acct), cardId: card.id, title: 'Final', fields: { Points: 5, Priority: 'low', Reviewed: false, Labels: ['ui', 'Ops'], Due: '2026-03-02T10:30:00Z', Link: 'http://a.test' } });

  assert.equal(updated.title, 'Final');
  assert.deepEqual(updated.fields, { Status: 'Todo', Priority: 'Low', Labels: ['UI', 'Ops'], Reviewed: false, Link: 'http://a.test', Due: '2026-03-02T10:30:00Z', Points: 5, Notes: 'keep me' });
  const row = await rawRow(env, acct.workspaceId, card.id);

  assert.equal(row.cells[KITCHEN.notes].data, 'keep me', 'untouched cell is unchanged');
  assert.equal(row.cells[KITCHEN.notes].last_modified, before.cells[KITCHEN.notes].last_modified);
  assert.equal(row.cells[KITCHEN.status].data, 'o_todo');
  assert.equal(row.cells[KITCHEN.points].data, '5');
  assert.equal(row.cells[KITCHEN.points].created_at, before.cells[KITCHEN.points].created_at, 'existing cell keeps created_at');
  assert.deepEqual([row.cells[KITCHEN.priority].data, row.cells[KITCHEN.priority].field_type], ['p_low', 3], 'a new cell gets the web shape');
  assert.equal(row.cells[KITCHEN.reviewed].data, 'No');
  assert.deepEqual([row.cells[KITCHEN.due].include_time, row.cells[KITCHEN.due].data], [true, String(Date.UTC(2026, 2, 2, 10, 30) / 1000)]);
  assert.equal(row.created_by, acct.uid);
  assert.equal(row.last_edited_by, acct.uid);
  assert.ok(Number(row.last_modified) >= Number(before.last_modified));

  assert.deepEqual(rec.events.map((event) => [event.collabType, event.objectId]), [[4, card.id]], 'one DatabaseRow diff was broadcast after persistence');
  const peer = applyDiff((await env.store.getDatabaseRowCollab(acct.workspaceId, card.id)).doc_state, rec.events[0].update);

  try {
    assert.equal(peer.getMap('data').get('data').get('cells').get(KITCHEN.notes).get('data'), 'keep me');
  } finally {
    peer.destroy();
  }

  // Clearing and no-op updates.
  rec.events.length = 0;
  const cleared = await cards.updateCard({ ...args(acct), cardId: card.id, fields: { Notes: null, Labels: null, Priority: null, Due: null, Points: null } });

  assert.deepEqual(cleared.fields, { Status: 'Todo', Reviewed: false, Link: 'http://a.test' });
  rec.events.length = 0;
  const same = await cards.updateCard({ ...args(acct), cardId: card.id, title: 'Final', fields: { Reviewed: false } });

  assert.equal(same.title, 'Final');
  assert.equal(rec.events.length, 0, 'an update that changes nothing persists and broadcasts nothing');
});

test('updateCard validation and rich-text safety', async () => {
  const acct = await account(env, 'cards-update-invalid');
  const kitchen = await createKitchenSink(env, acct);
  const { card } = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'T', fields: { Notes: 'plain' }, idempotencyKey: 'ui-1' });
  const base = { ...args(acct), cardId: card.id };

  await rejects(cards.updateCard({ ...base }), 'INVALID_INPUT', /title/);
  await rejects(cards.updateCard({ ...base, fields: {} }), 'INVALID_INPUT');
  await rejects(cards.updateCard({ ...base, title: 'x', fields: { Name: 'y' } }), 'INVALID_INPUT', /title/);
  await rejects(cards.updateCard({ ...base, fields: { Related: 'y' } }), 'UNSUPPORTED');
  await rejects(cards.updateCard({ ...base, fields: 'nope' }), 'INVALID_INPUT');
  await rejects(cards.updateCard({ ...base, title: 'x'.repeat(1001) }), 'INVALID_INPUT');
  await rejects(cards.updateCard({ ...base, fields: { Notes: 'x'.repeat(10_001) } }), 'INVALID_INPUT');
  await rejects(cards.updateCard({ ...base, cardId: id(), title: 'x' }), 'NOT_FOUND');
  assert.equal((await cards.getCard({ workspaceId: acct.workspaceId, cardId: card.id })).title, 'T');

  // Formatting from the web editor is dropped when plain text replaces its text, like the web does...
  await humanEditRow(env, acct.workspaceId, card.id, (row) => {
    row.get('cells').get(KITCHEN.notes).set('rich_text', JSON.stringify({ v: 1, text: 'plain', delta: [{ insert: 'plain', attributes: { bold: true } }] }));
  });
  await cards.updateCard({ ...base, fields: { Notes: 'replaced' } });
  assert.equal((await rawRow(env, acct.workspaceId, card.id)).cells[KITCHEN.notes].rich_text, undefined);

  // ...but a cell whose formatting needs a newer client is never changed.
  await humanEditRow(env, acct.workspaceId, card.id, (row) => {
    row.get('cells').get(KITCHEN.notes).set('rich_text', JSON.stringify({ v: 3, min_v: 2, text: 'replaced', delta: [{ insert: 'replaced' }] }));
  });
  await rejects(cards.updateCard({ ...base, fields: { Notes: 'overwrite' } }), 'UNSUPPORTED', /newer/);
  assert.equal((await rawRow(env, acct.workspaceId, card.id)).cells[KITCHEN.notes].data, 'replaced');
});

test('date values: date-only is pinned to the service time zone and round-trips; ranges stay read-only', async () => {
  const acct = await account(env, 'cards-dates');
  const kitchen = await createKitchenSink(env, acct);
  const la = createCardService({ store: env.store, timeZone: 'America/Los_Angeles' });
  const create = (title, due, key) => la.createCard({ ...args(acct), databaseId: kitchen.databaseId, title, fields: { Due: due }, idempotencyKey: key });
  const winter = await create('winter', '2026-03-02', 'd1');
  const springForwardDay = await create('dst day', '2026-03-08', 'd2');
  const summer = await create('summer', '2026-07-01', 'd3');
  const local = await create('local time', '2026-07-01T09:00', 'd4');
  const offset = await create('offset', '2026-07-01T09:00:00+02:00', 'd5');
  const data = async (card) => (await rawRow(env, acct.workspaceId, card.card.id)).cells[KITCHEN.due];

  assert.equal((await data(winter)).data, String(Date.UTC(2026, 2, 2, 8) / 1000), 'PST midnight is 08:00Z');
  assert.equal((await data(springForwardDay)).data, String(Date.UTC(2026, 2, 8, 8) / 1000), 'midnight before the 02:00 jump is still PST');
  assert.equal((await data(summer)).data, String(Date.UTC(2026, 6, 1, 7) / 1000), 'PDT midnight is 07:00Z');
  assert.equal((await data(local)).data, String(Date.UTC(2026, 6, 1, 16) / 1000), 'a zone-less date-time is read in the service zone');
  assert.equal((await data(offset)).data, String(Date.UTC(2026, 6, 1, 7) / 1000), 'an explicit offset wins');
  assert.equal(winter.card.fields.Due, '2026-03-02', 'read back in the same zone');
  assert.equal(summer.card.fields.Due, '2026-07-01');
  assert.equal(local.card.fields.Due, '2026-07-01T16:00:00Z', 'date-times are reported in UTC');
  assert.equal((await data(winter)).include_time, false);
  assert.equal((await data(local)).include_time, true);

  // A range written by the web is shown as {start,end}, can be replaced by a single date, never partially edited.
  await humanEditRow(env, acct.workspaceId, winter.card.id, (row) => {
    const cell = row.get('cells').get(KITCHEN.due);

    cell.set('is_range', true);
    cell.set('end_timestamp', String(Date.UTC(2026, 2, 5, 8) / 1000));
  });
  assert.deepEqual((await la.getCard({ workspaceId: acct.workspaceId, cardId: winter.card.id })).fields.Due, { start: '2026-03-02', end: '2026-03-05' });
  const replaced = await la.updateCard({ ...args(acct), cardId: winter.card.id, fields: { Due: '2026-03-09' } });

  assert.equal(replaced.fields.Due, '2026-03-09');
  assert.deepEqual([(await data(winter)).is_range, (await data(winter)).end_timestamp], [false, '']);
});

// ------------------------------------------------------------------ move
test('moveCard writes only the grouping cell, reorders only the chosen Board view, and validates the target', async () => {
  const acct = await account(env, 'cards-move');
  const tasks = await createTemplateDatabase(env, acct, 'tasks');
  const boardId = await addBoardView(env, acct, { databaseId: tasks.databaseId, containerId: tasks.containerId, name: 'Status board' });
  const listed = (await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, limit: 100 })).cards;
  const todo = listed.filter((card) => card.column === 'To do');
  const [mover, anchor] = [listed.find((card) => card.column === 'Backlog'), todo[todo.length - 1]];
  const gridBefore = (await rowOrdersOf(env, acct.workspaceId, tasks.databaseId, tasks.viewIds[0])).map((entry) => entry.id);

  rec.events.length = 0;
  const plain = await cards.moveCard({ ...args(acct), cardId: mover.id, column: 'in progress' });

  assert.equal(plain.card.column, 'In progress');
  assert.equal(plain.order_changed, false);
  assert.equal(plain.column_changed, true);
  const afterPlain = await rawRow(env, acct.workspaceId, mover.id);

  assert.equal(afterPlain.cells['0d0St2'].data, (await cards.getDatabase({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId })).boards[0].columns.find((column) => column.name === 'In progress').id);
  assert.equal(afterPlain.cells['0d0St2'].field_type, 3);
  assert.deepEqual(rec.events.map((event) => event.collabType), [4], 'only the row changed, the Board order was not touched');
  assert.deepEqual((await rowOrdersOf(env, acct.workspaceId, tasks.databaseId, boardId)).map((entry) => entry.id), gridBefore);

  // Move before a card of the destination column, in one view only.
  rec.events.length = 0;
  const placed = await cards.moveCard({ ...args(acct), cardId: mover.id, column: 'To do', viewId: boardId, beforeCardId: anchor.id });

  assert.equal(placed.card.column, 'To do');
  assert.equal(placed.order_changed, true);
  assert.deepEqual(rec.events.map((event) => event.collabType), [4, 1], 'row first, then the Database row order');
  const board = (await rowOrdersOf(env, acct.workspaceId, tasks.databaseId, boardId)).map((entry) => entry.id);

  assert.equal(board[board.indexOf(anchor.id) - 1], mover.id, 'immediately before the anchor card');
  assert.equal(board.length, 28);
  assert.deepEqual((await rowOrdersOf(env, acct.workspaceId, tasks.databaseId, tasks.viewIds[0])).map((entry) => entry.id), gridBefore, 'the Grid order is untouched');

  // Repeating the same move is idempotent.
  rec.events.length = 0;
  const repeat = await cards.moveCard({ ...args(acct), cardId: mover.id, column: 'To do', viewId: boardId, beforeCardId: anchor.id });

  assert.equal(repeat.order_changed, false);
  assert.equal(repeat.column_changed, false);
  assert.equal(rec.events.length, 0);

  // Validation.
  const other = (await cards.listCards({ workspaceId: acct.workspaceId, databaseId: tasks.databaseId, column: 'Done', limit: 1 })).cards[0];

  await rejects(cards.moveCard({ ...args(acct), cardId: mover.id, column: 'To do', viewId: boardId, beforeCardId: other.id }), 'INVALID_INPUT', /destination column/);
  await rejects(cards.moveCard({ ...args(acct), cardId: mover.id, column: 'To do', viewId: boardId, beforeCardId: mover.id }), 'INVALID_INPUT', /itself|being moved/);
  await rejects(cards.moveCard({ ...args(acct), cardId: mover.id, column: 'To do', viewId: boardId, beforeCardId: id() }), 'INVALID_INPUT', /not a card/);
  await rejects(cards.moveCard({ ...args(acct), cardId: mover.id, column: 'Nowhere', viewId: boardId }), 'INVALID_INPUT', /Columns/);
  await rejects(cards.moveCard({ ...args(acct), cardId: mover.id, column: 'To do', viewId: tasks.viewIds[0] }), 'INVALID_INPUT', /not a Board/);
  await rejects(cards.moveCard({ ...args(acct), cardId: mover.id, column: '' }), 'INVALID_INPUT');
  const projects = await createTemplateDatabase(env, acct, 'projects');
  const foreignCard = (await cards.listCards({ workspaceId: acct.workspaceId, databaseId: projects.databaseId, limit: 1 })).cards[0];

  await rejects(cards.moveCard({ ...args(acct), cardId: foreignCard.id, column: 'To do' }), 'INVALID_INPUT', /no Board/);
  await rejects(cards.moveCard({ ...args(acct), cardId: mover.id, column: 'To do', viewId: boardId, beforeCardId: foreignCard.id }), 'INVALID_INPUT', /not a card of this database/);
});

test('moving into and out of "No status" writes an empty cell; both representations of the ungrouped column read as No status', async () => {
  const acct = await account(env, 'cards-ungrouped');
  const kitchen = await createKitchenSink(env, acct);
  const { card } = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'Mover', column: 'Doing', idempotencyKey: 'ng-1' });

  const toNone = await cards.moveCard({ ...args(acct), cardId: card.id, column: 'no STATUS' });

  assert.equal(toNone.card.column, 'No status');
  assert.equal((await rawRow(env, acct.workspaceId, card.id)).cells[KITCHEN.status].data, '', 'the cell is emptied, not removed or set to a field id');
  const back = await cards.moveCard({ ...args(acct), cardId: card.id, column: 'Done' });

  assert.equal(back.card.column, 'Done');
  assert.equal(back.card.column_id, 'o_done');

  // The web can write the grouping field id (its "No status" column id) or an unknown value; both read as No status.
  for (const stored of [KITCHEN.status, 'removed-option-id', '']) {
    await humanEditRow(env, acct.workspaceId, card.id, (row) => row.get('cells').get(KITCHEN.status).set('data', stored));
    const read = await cards.getCard({ workspaceId: acct.workspaceId, cardId: card.id });

    assert.equal(read.column, 'No status', `stored "${stored}"`);
    assert.equal(read.column_id, null);
  }
  // A move into the column the card already shows is a no-op even though the stored value differs.
  await humanEditRow(env, acct.workspaceId, card.id, (row) => row.get('cells').get(KITCHEN.status).set('data', KITCHEN.status));
  rec.events.length = 0;
  await cards.moveCard({ ...args(acct), cardId: card.id, column: 'No status' });
  assert.equal(rec.events.length, 0);

  // Same card, seen as Grid data and as Board data after a restart of the store.
  const restarted = createCardService({ store: await env.reopenStore('ungrouped-copy') });
  const viaBoard = await restarted.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, viewId: kitchen.boardViewId, column: 'No status' });
  const viaGrid = await restarted.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, viewId: kitchen.gridViewId });

  assert.deepEqual(viaBoard.cards.map((entry) => entry.id), [card.id]);
  assert.deepEqual(viaGrid.cards.map((entry) => entry.id), [card.id]);
});

test('moveCard needs view_id when several Boards group differently or when ordering; each Board moves its own field', async () => {
  const acct = await account(env, 'cards-multiboard');
  const kitchen = await createKitchenSink(env, acct);
  const second = await addBoardView(env, acct, { databaseId: kitchen.databaseId, containerId: kitchen.containerId, name: 'By priority' });

  await setBoardGroupField(env, acct.workspaceId, kitchen.databaseId, second, KITCHEN.priority);
  const { card } = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'Two boards', column: 'Todo', viewId: kitchen.boardViewId, idempotencyKey: 'mb-1' });
  const db = await cards.getDatabase({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId });

  assert.deepEqual(db.boards.map((board) => board.group_field.name).sort(), ['Priority', 'Status']);
  assert.deepEqual(columnCounts(db.boards.find((board) => board.group_field.name === 'Priority')), { 'No status': 1, High: 0, Low: 0 });
  assert.deepEqual(columnCounts(db.boards.find((board) => board.group_field.name === 'Status')), { 'No status': 0, Todo: 1, Doing: 0, Done: 0 });

  await rejects(cards.moveCard({ ...args(acct), cardId: card.id, column: 'Done' }), 'AMBIGUOUS', /view_id/);
  await rejects(cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'x', column: 'Done', idempotencyKey: 'mb-2' }), 'AMBIGUOUS', /view_id/);
  await rejects(cards.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, column: 'Done' }), 'AMBIGUOUS');

  const viaPriority = await cards.moveCard({ ...args(acct), cardId: card.id, column: 'High', viewId: second });

  assert.equal(viaPriority.card.fields.Priority, 'High');
  assert.equal(viaPriority.card.fields.Status, 'Todo', 'the other Board\'s field is untouched');
  assert.equal((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, viewId: second, column: 'High' })).cards[0].id, card.id);
  assert.equal((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, viewId: kitchen.boardViewId, column: 'Todo' })).cards[0].id, card.id);

  // Two Boards on the same field are not ambiguous for column moves, only for ordering.
  const third = await addBoardView(env, acct, { databaseId: kitchen.databaseId, containerId: kitchen.containerId, name: 'Status again' });

  await setBoardGroupField(env, acct.workspaceId, kitchen.databaseId, third, KITCHEN.status);
  await cards.moveCard({ ...args(acct), cardId: card.id, column: 'Doing', viewId: kitchen.boardViewId });
  await rejects(cards.moveCard({ ...args(acct), cardId: card.id, column: 'Doing', viewId: null, beforeCardId: id() }), 'AMBIGUOUS');
});

test('boards grouped by something other than a single-select are refused clearly', async () => {
  const acct = await account(env, 'cards-badgroup');
  const kitchen = await createKitchenSink(env, acct);
  const { card } = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'x', idempotencyKey: 'bg-1' });

  for (const [fieldId, label] of [[KITCHEN.labels, /multi_select/], [KITCHEN.reviewed, /checkbox/], [KITCHEN.notes, /text/]]) {
    const view = await addBoardView(env, acct, { databaseId: kitchen.databaseId, containerId: kitchen.containerId, name: `by ${fieldId}` });

    await setBoardGroupField(env, acct.workspaceId, kitchen.databaseId, view, fieldId);
    await rejects(cards.moveCard({ ...args(acct), cardId: card.id, column: 'x', viewId: view }), 'UNSUPPORTED', label);
    await rejects(cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'x', column: 'x', viewId: view, idempotencyKey: `bg-${fieldId}` }), 'UNSUPPORTED', label);
  }
});

test('a failure between the two move mutations is reported as PARTIAL_FAILURE and a retry completes it', async () => {
  const acct = await account(env, 'cards-partial');
  const kitchen = await createKitchenSink(env, acct);
  const make = (title, column) => cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title, column, idempotencyKey: `p-${title}` }).then((result) => result.card);
  const anchor = await make('anchor', 'Done');
  const mover = await make('mover', 'Todo');
  const original = env.store.acceptDatabaseCollabUpdate;

  env.store.acceptDatabaseCollabUpdate = async () => { throw new Error('disk full'); };
  let failure;

  try {
    await cards.moveCard({ ...args(acct), cardId: mover.id, column: 'Done', viewId: kitchen.boardViewId, beforeCardId: anchor.id });
  } catch (error) {
    failure = error;
  } finally {
    env.store.acceptDatabaseCollabUpdate = original;
  }
  assert.ok(failure instanceof CardError);
  assert.equal(failure.code, 'PARTIAL_FAILURE');
  assert.equal(failure.details.column_changed, true);
  assert.equal(failure.details.order_changed, false);
  assert.equal(failure.details.card.column, 'Done', 'the column change is real and reported');
  assert.match(failure.message, /Retry move_card/);
  const order = (await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, kitchen.boardViewId)).map((entry) => entry.id);

  assert.deepEqual(order, [anchor.id, mover.id], 'the failed reorder changed nothing: the card kept its old position');

  const retry = await cards.moveCard({ ...args(acct), cardId: mover.id, column: 'Done', viewId: kitchen.boardViewId, beforeCardId: anchor.id });

  assert.equal(retry.column_changed, false, 'the first half was already applied');
  assert.equal(retry.card.column, 'Done');
  const after = (await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, kitchen.boardViewId)).map((entry) => entry.id);

  assert.deepEqual(after, [mover.id, anchor.id], 'the retry finished the reorder');

  // A failure of the FIRST step changes nothing and is a plain error.
  const originalRow = env.store.acceptDatabaseRowCollabUpdate;

  env.store.acceptDatabaseRowCollabUpdate = async () => { throw new Error('row write failed'); };
  try {
    await assert.rejects(cards.moveCard({ ...args(acct), cardId: mover.id, column: 'Todo' }), /row write failed/);
  } finally {
    env.store.acceptDatabaseRowCollabUpdate = originalRow;
  }
  assert.equal((await cards.getCard({ workspaceId: acct.workspaceId, cardId: mover.id })).column, 'Done');
});

// ------------------------------------------------------------------ archive / restore
test('archive tombstones the row in every view in place, hides it, and restore brings the same card back', async () => {
  const acct = await account(env, 'cards-archive');
  const kitchen = await createKitchenSink(env, acct);
  const make = (title) => cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title, column: 'Todo', idempotencyKey: `a-${title}` }).then((result) => result.card);
  const [one, two, three] = [await make('one'), await make('two'), await make('three')];
  const positions = async (viewId) => (await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, viewId)).map((entry) => entry.id);
  const gridBefore = await positions(kitchen.gridViewId);

  await rejects(cards.archiveCard({ ...args(acct), cardId: two.id }), 'INVALID_INPUT', /confirm/);
  await rejects(cards.archiveCard({ ...args(acct), cardId: two.id, confirm: 'yes' }), 'INVALID_INPUT', /confirm/);
  rec.events.length = 0;
  const archived = await cards.archiveCard({ ...args(acct), cardId: two.id, confirm: true });

  assert.equal(archived.archived, true);
  assert.deepEqual(rec.events.map((event) => event.collabType), [1]);
  for (const viewId of [kitchen.gridViewId, kitchen.boardViewId]) {
    const orders = await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, viewId);

    assert.deepEqual(orders.map((entry) => entry.id), gridBefore, 'position preserved');
    assert.equal(orders.find((entry) => entry.id === two.id).is_deleted, true);
    assert.ok(!orders.find((entry) => entry.id === one.id).is_deleted);
    assert.ok(orders.find((entry) => entry.id === two.id).height, 'the entry keeps its height');
  }
  const content = await rawRow(env, acct.workspaceId, two.id);

  assert.equal(content.cells[KITCHEN.status].data, 'o_todo', 'row content is untouched (never hard-deleted)');
  assert.deepEqual((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, limit: 100 })).cards.map((card) => card.id), [one.id, three.id]);
  assert.deepEqual((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, archived: 'only' })).cards.map((card) => card.id), [two.id]);
  assert.equal((await cards.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, archived: 'include' })).cards.length, 3);
  assert.equal(columnCounts((await cards.getDatabase({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId })).boards[0]).Todo, 2);
  assert.equal((await cards.getCard({ workspaceId: acct.workspaceId, cardId: two.id })).archived, true, 'an archived card can still be read (to find its id)');
  await rejects(cards.updateCard({ ...args(acct), cardId: two.id, title: 'edit' }), 'INVALID_INPUT', /archived/);
  await rejects(cards.moveCard({ ...args(acct), cardId: two.id, column: 'Done' }), 'INVALID_INPUT', /archived/);

  rec.events.length = 0;
  assert.equal((await cards.archiveCard({ ...args(acct), cardId: two.id, confirm: true })).archived, true, 'archiving twice is harmless');
  assert.equal(rec.events.length, 0);

  await rejects(cards.restoreCard({ ...args(acct), cardId: two.id }), 'INVALID_INPUT', /confirm/);
  const restored = await cards.restoreCard({ ...args(acct), cardId: two.id, confirm: true });

  assert.equal(restored.id, two.id, 'the same card, not a copy');
  assert.equal(restored.archived, false);
  for (const viewId of [kitchen.gridViewId, kitchen.boardViewId]) {
    const orders = await rowOrdersOf(env, acct.workspaceId, kitchen.databaseId, viewId);

    assert.deepEqual(orders.map((entry) => entry.id), gridBefore);
    assert.ok(orders.every((entry) => !entry.is_deleted));
  }
  assert.equal((await cards.restoreCard({ ...args(acct), cardId: two.id, confirm: true })).archived, false, 'restoring twice is harmless');
  await cards.updateCard({ ...args(acct), cardId: two.id, title: 'edited after restore' });
});

test('archive and restore also move the row\'s detail page to and from the trash when one exists', async () => {
  const acct = await account(env, 'cards-archive-page');
  const kitchen = await createKitchenSink(env, acct);
  const { card } = await cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'With page', idempotencyKey: 'ap-1' });
  const documentId = rowDocumentIdFromRowId(card.id);
  const timestamp = new Date().toISOString();

  await env.store.createPage({
    id: documentId, workspace_id: acct.workspaceId, parent_view_id: null, title: 'With page', icon: null,
    extra: { row_document: { source: { database_id: kitchen.databaseId, database_view_id: kitchen.gridViewId, row_id: card.id } } },
    is_favorite: false, document: {}, schema_version: 'appflowy-document-v1', creator_id: acct.userId, version: 1, created_at: timestamp, updated_at: timestamp, position: { kind: 'start' },
  });
  await cards.archiveCard({ ...args(acct), cardId: card.id, confirm: true });
  assert.equal((await env.store.getPage(documentId)).is_trashed, true);
  await cards.restoreCard({ ...args(acct), cardId: card.id, confirm: true });
  assert.equal(Boolean((await env.store.getPage(documentId)).is_trashed), false);

  // Page trash failing after the row was archived is reported, not hidden.
  const original = env.store.setPageTrashed;

  env.store.setPageTrashed = async () => { throw new Error('page store down'); };
  const failure = await cards.archiveCard({ ...args(acct), cardId: card.id, confirm: true }).catch((error) => error);

  env.store.setPageTrashed = original;
  assert.equal(failure.code, 'PARTIAL_FAILURE');
  assert.equal(failure.details.card_changed, true);
  assert.equal((await cards.getCard({ workspaceId: acct.workspaceId, cardId: card.id })).archived, true);
  const retry = await cards.archiveCard({ ...args(acct), cardId: card.id, confirm: true });

  assert.equal(retry.archived, true);
  assert.equal((await env.store.getPage(documentId)).is_trashed, true, 'the retry finished the page trash');
});

// ------------------------------------------------------------------ broadcast and persistence
test('a failing broadcast never fails a persisted change; broadcast diffs apply to the stored state', async () => {
  const acct = await account(env, 'cards-broadcast');
  const kitchen = await createKitchenSink(env, acct);
  const failing = recorder({ failing: true });
  const logged = [];
  const resilient = createCardService({ store: env.store, broadcast: failing.broadcast, log: (...parts) => logged.push(parts.join(' ')) });
  const { card } = await resilient.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'Resilient', column: 'Todo', idempotencyKey: 'br-1' });

  await resilient.updateCard({ ...args(acct), cardId: card.id, title: 'Still saved' });
  await resilient.moveCard({ ...args(acct), cardId: card.id, column: 'Done' });
  assert.equal((await resilient.getCard({ workspaceId: acct.workspaceId, cardId: card.id })).title, 'Still saved');
  assert.equal((await resilient.getCard({ workspaceId: acct.workspaceId, cardId: card.id })).column, 'Done');
  assert.equal(failing.events.length, 3, 'a broadcast was attempted for create, update and move');
  assert.ok(logged.length >= 3 && logged.every((line) => /broadcast failed/.test(line)));

  const accepted = failing.events[1].accepted;

  assert.equal(accepted.status, 'applied');
  const peer = applyDiff(null, failing.events[2].update);

  assert.ok(peer, 'every broadcast update decodes');
  peer.destroy();
  const database = await readDatabaseDoc(env, acct.workspaceId, kitchen.databaseId);

  try {
    assert.equal(database.database.get('views').size, 2);
  } finally {
    database.doc.destroy();
  }
});

test('everything persists across a restart of the store (cards, order, archive state, ledger)', async () => {
  const acct = await account(env, 'cards-restart');
  const kitchen = await createKitchenSink(env, acct);
  const make = (title, column) => cards.createCard({ ...args(acct), databaseId: kitchen.databaseId, title, column, fields: { Points: 7 }, idempotencyKey: `r-${title}` }).then((result) => result.card);
  const [a, b, c] = [await make('a', 'Todo'), await make('b', 'Todo'), await make('c', 'Todo')];

  await cards.moveCard({ ...args(acct), cardId: c.id, column: 'Done' });
  await cards.moveCard({ ...args(acct), cardId: b.id, column: 'Todo', viewId: kitchen.boardViewId, beforeCardId: a.id });
  await cards.archiveCard({ ...args(acct), cardId: a.id, confirm: true });
  await cards.updateCard({ ...args(acct), cardId: c.id, title: 'c!', fields: { Notes: 'n' } });

  const restarted = createCardService({ store: await env.reopenStore('full-restart-copy') });
  const live = await restarted.listCards({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId, viewId: kitchen.boardViewId });

  assert.deepEqual(live.cards.map((card) => [card.title, card.column]), [['b', 'Todo'], ['c!', 'Done']]);
  assert.equal(live.cards[1].fields.Notes, 'n');
  assert.equal((await restarted.getCard({ workspaceId: acct.workspaceId, cardId: a.id })).archived, true);
  assert.deepEqual(columnCounts((await restarted.getDatabase({ workspaceId: acct.workspaceId, databaseId: kitchen.databaseId })).boards[0]), { 'No status': 0, Todo: 1, Doing: 0, Done: 1 });
  assert.equal((await restarted.createCard({ ...args(acct), databaseId: kitchen.databaseId, title: 'a', column: 'Todo', fields: { Points: 7 }, idempotencyKey: 'r-a' })).replayed, true);
  assert.equal((await restarted.listDatabases({ workspaceId: acct.workspaceId }))[0].name, 'Kitchen');
});
