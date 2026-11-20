// The two atomic row routes the web client uses when a database TEMPLATE is applied or a card body is first
// written, neither of which had any test in the default suite (both were where the "error when adding a row from a
// template" and "card body never saved" reports came from):
//   POST /v2/database/{id}/row        seeded row (and optional body document) built client side, inserted into views
//   POST /v2/page-view/row-document   a card's first body, creating the hidden row first if it does not exist
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createInitialDatabaseRowCollab } from '../database-row-document.js';
import { createInitialPageCollab, rowDocumentIdFromRowId } from '../page-document.js';
import { readCardBody } from '../card-body.js';
import { account, createTemplateDatabase, id, rowOrdersOf, startCardsEnv } from './helpers/cards-env.js';

const RESTORE = '00000000-0000-0000-0000-000000000000';
let env;

before(async () => { env = await startCardsEnv(); });
after(async () => { await env.stop(); });

// Same layout as the client's encodeCreationCollab: u64le len + state vector, u64le len + update, encoder version 0.
function encodeCreation(vector, state) {
  const bytes = Buffer.alloc(17 + vector.length + state.length);

  bytes.writeBigUInt64LE(BigInt(vector.length), 0);
  Buffer.from(vector).copy(bytes, 8);
  bytes.writeBigUInt64LE(BigInt(state.length), 8 + vector.length);
  Buffer.from(state).copy(bytes, 16 + vector.length);
  return bytes.toString('base64');
}

function rowCollab(rowId, databaseId, actor, overrides = {}) {
  const collab = createInitialDatabaseRowCollab({ rowId, databaseId, cells: {}, height: 60, visibility: true, timestamp: new Date().toISOString(), actorUid: actor.uid, ...overrides });

  return encodeCreation(collab.stateVector, collab.documentState);
}

function documentCollab(rowId) {
  const collab = createInitialPageCollab(rowDocumentIdFromRowId(rowId));

  return encodeCreation(collab.stateVector, collab.documentState);
}

async function setup(label) {
  const acct = await account(env, label);
  const db = await createTemplateDatabase(env, acct, 'tasks');

  return { acct, db };
}

const seededUrl = (acct, databaseId) => `/api/workspace/${acct.workspaceId}/v2/database/${databaseId}/row`;
const seededBody = ({ acct, db }, extra = {}) => {
  const rowId = id();

  return { request_id: id(), database_restore_id: RESTORE, source_view_id: db.viewIds[0], row: { row_id: rowId, collab: rowCollab(rowId, db.databaseId, acct) }, position: { kind: 'start' }, position_view_ids: [db.viewIds[0]], ...extra };
};

test('a seeded row is stored, placed first in every requested view, and found by the card service', async () => {
  const ctx = await setup('seeded-row');
  const { acct, db } = ctx;
  const body = seededBody(ctx);
  const before = await rowOrdersOf(env, acct.workspaceId, db.databaseId, db.viewIds[0]);
  const created = await env.api('POST', seededUrl(acct, db.databaseId), body, acct.token);

  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data.outcome, 'applied');
  assert.equal(created.body.data.result.row_id, body.row.row_id);
  assert.ok(created.body.data.result.database_update_v1.length > 0);
  const orders = await rowOrdersOf(env, acct.workspaceId, db.databaseId, db.viewIds[0]);

  assert.equal(orders.length, before.length + 1);
  assert.equal(orders[0].id, body.row.row_id, 'position start puts it first');
  assert.ok(await env.store.getDatabaseRowCollab(acct.workspaceId, body.row.row_id));
  // after / end positions
  const second = seededBody(ctx, { position: { kind: 'after', row_id: body.row.row_id } });
  const third = seededBody(ctx, { position: { kind: 'end' } });

  assert.equal((await env.api('POST', seededUrl(acct, db.databaseId), second, acct.token)).status, 200);
  assert.equal((await env.api('POST', seededUrl(acct, db.databaseId), third, acct.token)).status, 200);
  const ids = (await rowOrdersOf(env, acct.workspaceId, db.databaseId, db.viewIds[0])).map((order) => order.id);

  assert.equal(ids[0], body.row.row_id);
  assert.equal(ids[1], second.row.row_id);
  assert.equal(ids.at(-1), third.row.row_id);
});

test('a seeded row with a body document creates the hidden row-detail page that the card reader finds', async () => {
  const ctx = await setup('seeded-row-doc');
  const { acct, db } = ctx;
  const rowId = id();
  const body = seededBody(ctx, { row: { row_id: rowId, collab: rowCollab(rowId, db.databaseId, acct), document: documentCollab(rowId) }, document_name: 'Spec' });

  assert.equal((await env.api('POST', seededUrl(acct, db.databaseId), body, acct.token)).status, 200);
  const page = await env.store.getPage(rowDocumentIdFromRowId(rowId));

  assert.equal(page.title, 'Spec');
  assert.ok(page.parent_view_id == null, 'a card document never appears in the sidebar'); // null in JSON mode, undefined in Postgres
  assert.deepEqual(page.extra.row_document.source, { database_id: db.databaseId, database_view_id: db.viewIds[0], row_id: rowId });
  assert.deepEqual(await readCardBody({ store: env.store, workspaceId: acct.workspaceId, databaseId: db.databaseId, rowId }), { text: '', truncated: false, has_document: true, total_chars: 0, next_offset: null });
});

test('seeded row creation is idempotent per request, and refuses reuse, duplicates and foreign ids', async () => {
  const ctx = await setup('seeded-row-rules');
  const { acct, db } = ctx;
  const stranger = await account(env, 'seeded-row-stranger');
  const body = seededBody(ctx);
  const url = seededUrl(acct, db.databaseId);

  assert.equal((await env.api('POST', url, body, acct.token)).body.data.outcome, 'applied');
  const replay = await env.api('POST', url, body, acct.token);

  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.outcome, 'already_applied');
  const count = (await rowOrdersOf(env, acct.workspaceId, db.databaseId, db.viewIds[0])).length;

  assert.equal((await rowOrdersOf(env, acct.workspaceId, db.databaseId, db.viewIds[0])).filter((order) => order.id === body.row.row_id).length, 1, 'the replay did not add a second entry');
  const other = seededBody(ctx);
  const reused = await env.api('POST', url, { ...other, request_id: body.request_id }, acct.token);

  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.code, 'REQUEST_ID_REUSED');
  assert.equal((await env.api('POST', url, { ...body, request_id: id() }, acct.token)).status, 409, 'the row id already exists');
  assert.equal((await rowOrdersOf(env, acct.workspaceId, db.databaseId, db.viewIds[0])).length, count);
  assert.equal((await env.api('POST', url, seededBody(ctx), stranger.token)).status, 403);
  assert.equal((await env.api('POST', seededUrl(acct, id()), seededBody(ctx), acct.token)).status, 404, 'unknown database');
  assert.equal((await env.api('POST', url, seededBody(ctx), undefined)).status, 401);
});

test('seeded row validation: shapes, identities, views, restore id and unknown fields', async () => {
  const ctx = await setup('seeded-row-invalid');
  const { acct, db } = ctx;
  const url = seededUrl(acct, db.databaseId);
  const bad = async (mutate, label) => {
    const body = seededBody(ctx);

    mutate(body);
    const response = await env.api('POST', url, body, acct.token);

    assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error.code, 'INVALID_ATOMIC_REQUEST', label);
  };

  await bad((b) => { b.request_id = 'nope'; }, 'request id');
  await bad((b) => { b.database_restore_id = id(); }, 'restore id');
  await bad((b) => { b.position = { kind: 'middle' }; }, 'position kind');
  await bad((b) => { b.position = { kind: 'after' }; }, 'relative position needs a row');
  await bad((b) => { b.position_view_ids = []; }, 'no views');
  await bad((b) => { b.position_view_ids = [id()]; }, 'view of another database');
  await bad((b) => { b.extra = 1; }, 'unknown field');
  await bad((b) => { b.row.collab = 'not base64!!'; }, 'collab encoding');
  await bad((b) => { b.row.collab = Buffer.from('short').toString('base64'); }, 'truncated collab');
  await bad((b) => { b.row.collab = rowCollab(id(), db.databaseId, acct); }, 'collab for a different row');
  await bad((b) => { b.row.collab = rowCollab(b.row.row_id, id(), acct); }, 'collab for a different database');
  await bad((b) => { b.row.collab = rowCollab(b.row.row_id, db.databaseId, acct, { height: 0 }); }, 'bad height');
  await bad((b) => { b.row.document = documentCollab(id()); }, 'document of a different row');
  await bad((b) => { b.document_name = 'x'.repeat(201); }, 'document name length');
});

const publishBody = ({ acct, db }, rowId, extra = {}) => ({
  request_id: id(), database_id: db.databaseId, database_restore_id: RESTORE, row_id: rowId, source_view_id: db.viewIds[0], name: 'Row page',
  contribution: { kind: 'default_schema', schema_version: 'v1' }, ...extra,
});
const publishUrl = (acct) => `/api/workspace/${acct.workspaceId}/v2/page-view/row-document`;

test('publishing a card body creates its document once, for an existing row or a brand-new hidden one', async () => {
  const ctx = await setup('row-document');
  const { acct, db } = ctx;
  const existing = db.rowIds[0];
  const first = await env.api('POST', publishUrl(acct), publishBody(ctx, existing), acct.token);

  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.outcome, 'applied');
  assert.equal(first.body.data.result.document_id, rowDocumentIdFromRowId(existing));
  assert.equal((await readCardBody({ store: env.store, workspaceId: acct.workspaceId, databaseId: db.databaseId, rowId: existing })).has_document, true);

  const replay = await env.api('POST', publishUrl(acct), { ...publishBody(ctx, existing), request_id: first.body.data.request_id }, acct.token);

  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.outcome, 'already_applied', 'the same request is replayed, not repeated');
  assert.equal((await env.api('POST', publishUrl(acct), publishBody(ctx, existing), acct.token)).status, 409, 'a new request for a row that already has a document is refused');

  const hiddenRow = id();
  const hidden = await env.api('POST', publishUrl(acct), publishBody(ctx, hiddenRow), acct.token);

  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.ok(await env.store.getDatabaseRowCollab(acct.workspaceId, hiddenRow), 'the hidden row was created');
  const visible = (await rowOrdersOf(env, acct.workspaceId, db.databaseId, db.viewIds[0])).map((order) => order.id);

  assert.equal(visible.includes(hiddenRow), false, 'a template row stays out of every view until it is placed');
  const actions = await env.api('POST', publishUrl(acct), publishBody(ctx, id(), { contribution: { kind: 'default_actions', schema_version: 'v1', actions: [] } }), acct.token);

  assert.equal(actions.status, 200, JSON.stringify(actions.body));
});

test('row-document publish rules: validation, membership and workspace scoping', async () => {
  const ctx = await setup('row-document-rules');
  const { acct, db } = ctx;
  const stranger = await account(env, 'row-document-stranger');
  const bad = async (extra, label) => {
    const response = await env.api('POST', publishUrl(acct), publishBody(ctx, id(), extra), acct.token);

    assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
  };

  await bad({ database_restore_id: id() }, 'restore id');
  await bad({ name: 'x'.repeat(201) }, 'name length');
  await bad({ contribution: { kind: 'other', schema_version: 'v1' } }, 'contribution kind');
  await bad({ contribution: { kind: 'default_schema', schema_version: 'v2' } }, 'contribution version');
  await bad({ surprise: true }, 'unknown field');
  assert.equal((await env.api('POST', publishUrl(acct), publishBody(ctx, id(), { database_id: id() }), acct.token)).status, 404, 'unknown database');
  assert.equal((await env.api('POST', publishUrl(acct), publishBody(ctx, id()), stranger.token)).status, 403);
  assert.equal((await env.api('POST', publishUrl(stranger), publishBody(ctx, id()), stranger.token)).status, 404, "another workspace's database is invisible");
  assert.ok(db);
});

test('GET /views returns each requested view with its children, and validates the depth', async () => {
  const { acct } = await setup('views-batch');
  const space2 = id();
  const url = (ids, depth = 1) => `/api/workspace/${acct.workspaceId}/views?view_ids=${ids.join(',')}&depth=${depth}`;
  const created = await env.api('POST', `/api/workspace/${acct.workspaceId}/spaces`, {
    name: 'Second', view_id: space2,
    permission: { visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null, invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false, security: { disable_guests: false, disable_public_links: false, disable_export: false } },
  }, acct.token);

  assert.equal(created.status, 200);
  const response = await env.api('GET', url([acct.spaceId, space2]), undefined, acct.token);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.data.views.map((view) => view.view_id).sort(), [acct.spaceId, space2].sort());
  assert.equal((await env.api('GET', url([acct.spaceId], 99), undefined, acct.token)).status, 400);
  assert.equal((await env.api('GET', url([acct.spaceId]), undefined, undefined)).status, 401);
  assert.ok(Y);
});
