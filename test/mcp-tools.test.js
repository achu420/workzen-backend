// Light MCP tools: argument mapping to the card service, result shapes validated against each
// tool's outputSchema by an independent validator, CardError mapping, scope enforcement before
// the card service is touched, argument validation, timeout and internal-error handling.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WRITE_TOKEN, READ_TOKEN, callModern, createFakeCards, legacy, post, startMcp, validateSchema } from './helpers/mcp-test-kit.js';

let mcp;
let toolDefs;

before(async () => {
  mcp = await startMcp();
  toolDefs = Object.fromEntries((await callModern(mcp.url, 'tools/list', {})).json.result.tools.map((tool) => [tool.name, tool]));
});
after(async () => { await mcp.close(); });

const call = (name, args, options = {}) => callModern(mcp.url, 'tools/call', { name, arguments: args }, options);
const lastCall = () => mcp.cards.calls.at(-1);
const KEY = 'key-0123456789';

function assertConforms(name, result) {
  assert.equal(result.isError, false, `${name} succeeded`);
  assert.deepEqual(validateSchema(result.structuredContent, toolDefs[name].outputSchema), [], `${name} structuredContent matches its outputSchema`);
  assert.equal(result.content[0].type, 'text');
  assert.ok(result.content[0].text.length > 0 && result.content[0].text.length <= 6000);
}

test('every tool succeeds and its structuredContent conforms to its outputSchema', async () => {
  const runs = [
    ['list_databases', {}],
    ['get_database', { database_id: 'db-1' }],
    ['list_cards', { database_id: 'db-1' }],
    ['get_card', { card_id: 'c-1' }],
    ['create_card', { database_id: 'db-1', title: 'New one', column: 'Todo', fields: { Priority: 'Low', Done: false, Tags: ['a', 'b'], Points: 3 }, idempotency_key: KEY }],
    ['update_card', { card_id: 'c-1', title: 'Renamed', fields: { Priority: 'Urgent' } }],
    ['move_card', { card_id: 'c-1', column: 'Doing', view_id: 'v-board', before_card_id: 'c-2' }],
    ['archive_card', { card_id: 'c-2', confirm: true }],
    ['restore_card', { card_id: 'c-2', confirm: true }],
  ];

  assert.equal(runs.length, 9);
  for (const [name, args] of runs) {
    const { json } = await call(name, args);

    assert.equal(json.result.resultType, 'complete', name);
    assertConforms(name, json.result);
  }
});

test('legacy tools/call results also conform (same schemas, no resultType)', async () => {
  const { json } = await post(mcp.url, legacy('tools/call', { name: 'list_cards', arguments: { database_id: 'db-1' } }));

  assertConforms('list_cards', json.result);
});

test('list_databases normalises the card service shape', async () => {
  const { json } = await call('list_databases', {});
  const [database] = json.result.structuredContent.databases;

  assert.equal(database.database_id, 'db-1');
  assert.equal(database.workspace_id, 'ws-1');
  assert.equal(database.has_board, true);
  assert.deepEqual(database.views.map((view) => view.view_id), ['v-grid', 'v-board']);
  assert.match(json.result.content[0].text, /1 database/);
  assert.equal(lastCall().args.workspaceId, 'ws-1', 'the workspace always comes from the token, never from arguments');
});

test('get_database passes board and field details through', async () => {
  const { json } = await call('get_database', { database_id: 'db-1' });
  const { database } = json.result.structuredContent;

  assert.equal(database.boards[0].columns[1].name, 'Doing');
  assert.equal(database.fields[1].options[0].name, 'Todo');
  assert.match(json.result.content[0].text, /Board Board/);
  assert.match(json.result.content[0].text, /grouped by Status:/, 'the summary names the real grouping field (cards.js emits group_field)');
  assert.deepEqual(lastCall().args, { workspaceId: 'ws-1', databaseId: 'db-1' });
});

test('list_cards maps arguments, applies the default limit and pages with next_cursor', async () => {
  await call('list_cards', { database_id: 'db-1' });
  assert.equal(lastCall().args.limit, 25);
  assert.equal(lastCall().args.viewId, undefined);

  const first = await call('list_cards', { database_id: 'db-1', view_id: 'v-board', column: 'Todo', query: 'ignore', limit: 1 });

  assert.deepEqual(lastCall().args, { workspaceId: 'ws-1', databaseId: 'db-1', viewId: 'v-board', column: 'Todo', query: 'ignore', limit: 1, cursor: undefined, archived: 'exclude' });

  await call('list_cards', { database_id: 'db-1', include_archived: true });
  assert.equal(lastCall().args.archived, 'include', 'include_archived maps to the service archived mode');
  assert.equal(first.json.result.structuredContent.cards.length, 1);

  const everything = (await call('list_cards', { database_id: 'db-1', limit: 100 })).json.result.structuredContent;

  assert.equal(everything.next_cursor, null);
  const seen = [];
  let cursor;

  for (let pages = 0; pages < 20; pages += 1) {
    const page = await call('list_cards', { database_id: 'db-1', limit: 2, ...(cursor ? { cursor } : {}) });
    const { cards, next_cursor: next } = page.json.result.structuredContent;

    if (cursor) assert.equal(lastCall().args.cursor, cursor, 'the cursor is passed through to the card service');
    assert.ok(cards.length <= 2);
    seen.push(...cards.map((card) => card.id));
    if (!next) break;
    assert.match(page.json.result.content[0].text, /next_cursor/);
    cursor = next;
  }
  assert.deepEqual(seen, everything.cards.map((card) => card.id), 'paging returns every card once, in order');
});

test('create_card maps arguments, is idempotent for a repeated key and conflicts on a different payload', async () => {
  const args = { database_id: 'db-1', title: 'Once only', column: 'Doing', fields: { Priority: 'Low' }, idempotency_key: 'create-once-1' };
  const created = await call('create_card', args);

  assert.deepEqual(lastCall().args, { workspaceId: 'ws-1', userId: 'user-1', tokenId: 'tok-write', databaseId: 'db-1', title: 'Once only', column: 'Doing', fields: { Priority: 'Low' }, idempotencyKey: 'create-once-1' });
  assert.equal(created.json.result.structuredContent.replayed, false);

  const again = await call('create_card', args);

  assert.equal(again.json.result.structuredContent.replayed, true);
  assert.equal(again.json.result.structuredContent.card.id, created.json.result.structuredContent.card.id);
  assert.match(again.json.result.content[0].text, /existing card/);

  const conflict = await call('create_card', { ...args, title: 'Different title' });

  assert.equal(conflict.json.result.isError, true);
  assert.match(conflict.json.result.content[0].text, /CONFLICT/);
});

test('update, move, archive and restore map their arguments', async () => {
  await call('update_card', { card_id: 'c-1', title: 'T', fields: { A: 1 } });
  assert.deepEqual(lastCall().args, { workspaceId: 'ws-1', userId: 'user-1', cardId: 'c-1', title: 'T', fields: { A: 1 } });
  await call('move_card', { card_id: 'c-1', column: 'Todo', view_id: 'v-board', before_card_id: 'c-3' });
  assert.deepEqual(lastCall().args, { workspaceId: 'ws-1', userId: 'user-1', cardId: 'c-1', column: 'Todo', viewId: 'v-board', beforeCardId: 'c-3' });
  const moved = await call('move_card', { card_id: 'c-1', column: 'No status' });

  assert.equal(moved.json.result.structuredContent.order_changed, false);
  assert.equal(moved.json.result.structuredContent.card.column, null);
  assert.match(moved.json.result.content[0].text, /No status/);
  await call('archive_card', { card_id: 'c-1', confirm: true });
  assert.deepEqual(lastCall().args, { workspaceId: 'ws-1', userId: 'user-1', cardId: 'c-1', confirm: true });
  assert.equal(lastCall().method, 'archiveCard');
  await call('restore_card', { card_id: 'c-1', confirm: true });
  assert.equal(lastCall().method, 'restoreCard');
});

test('archive and restore refuse to run without confirm: true', async () => {
  for (const name of ['archive_card', 'restore_card']) {
    const before = mcp.cards.calls.length;

    for (const confirm of [false]) {
      const { json } = await call(name, { card_id: 'c-1', confirm });

      assert.equal(json.result.isError, true);
      assert.match(json.result.content[0].text, /confirm: true/);
    }
    const missing = await call(name, { card_id: 'c-1' });

    assert.equal(missing.json.result.isError, true);
    assert.match(missing.json.result.content[0].text, /confirm is required/);
    assert.equal(mcp.cards.calls.length, before, `${name} never reached the card service`);
  }
});

test('update_card needs a title or fields', async () => {
  const before = mcp.cards.calls.length;
  const { json } = await call('update_card', { card_id: 'c-1' });

  assert.equal(json.result.isError, true);
  assert.match(json.result.content[0].text, /title and\/or fields/);
  assert.equal(mcp.cards.calls.length, before);
});

test('CardError becomes an isError result with the message and details (valid options for ambiguity and bad input)', async () => {
  const ambiguous = await call('list_cards', { database_id: 'db-1', column: 'Dup' });

  assert.equal(ambiguous.status, 200);
  assert.equal(ambiguous.json.result.isError, true);
  assert.match(ambiguous.json.result.content[0].text, /AMBIGUOUS/);
  assert.match(ambiguous.json.result.content[0].text, /"matches":\["Dup","dup"\]/);
  assert.equal(ambiguous.json.result.structuredContent, undefined, 'error results carry no structuredContent (an outputSchema describes successes)');

  const unknownColumn = await call('move_card', { card_id: 'c-1', column: 'Nope' });

  assert.match(unknownColumn.json.result.content[0].text, /INVALID_INPUT/);
  assert.match(unknownColumn.json.result.content[0].text, /valid_columns/);
  assert.match(unknownColumn.json.result.content[0].text, /No status/);
  const partial = await call('move_card', { card_id: 'c-1', column: 'Partial' });

  assert.match(partial.json.result.content[0].text, /PARTIAL_FAILURE/);
  assert.match(partial.json.result.content[0].text, /order_changed/);
  const missing = await call('get_card', { card_id: 'nope' });

  assert.match(missing.json.result.content[0].text, /NOT_FOUND/);
  const unsupported = await call('update_card', { card_id: 'c-1', fields: { Status: 'Bogus' } });

  assert.match(unsupported.json.result.content[0].text, /UNSUPPORTED/);
  assert.match(unsupported.json.result.content[0].text, /valid_options/);
});

test('invalid arguments are tool errors (isError) and never reach the card service', async () => {
  const cases = [
    ['list_databases', { extra: 1 }],
    ['get_database', {}],
    ['get_database', { database_id: 5 }],
    ['get_database', { database_id: '' }],
    ['list_cards', { database_id: 'db-1', limit: 0 }],
    ['list_cards', { database_id: 'db-1', limit: 101 }],
    ['list_cards', { database_id: 'db-1', limit: 1.5 }],
    ['list_cards', { database_id: 'db-1', query: '' }],
    ['list_cards', { database_id: 'db-1', surprise: true }],
    ['get_card', {}],
    ['create_card', { database_id: 'db-1', title: 'x' }],
    ['create_card', { database_id: 'db-1', title: 'x', idempotency_key: 'short' }],
    ['create_card', { database_id: 'db-1', title: 'x', idempotency_key: 'has spaces in it!' }],
    ['create_card', { database_id: 'db-1', title: '', idempotency_key: KEY }],
    ['create_card', { database_id: 'db-1', title: 'x'.repeat(2001), idempotency_key: KEY }],
    ['create_card', { database_id: 'db-1', title: 'x', idempotency_key: KEY, fields: { a: { nested: 1 } } }],
    ['create_card', { database_id: 'db-1', title: 'x', idempotency_key: KEY, fields: { a: 'y'.repeat(10001) } }],
    ['create_card', { database_id: 'db-1', title: 'x', idempotency_key: KEY, fields: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, 1])) }],
    ['update_card', { card_id: 'c-1', title: 5 }],
    ['move_card', { card_id: 'c-1' }],
    ['move_card', { card_id: 'c-1', column: '' }],
    ['archive_card', { card_id: 'c-1', confirm: 'yes' }],
    ['restore_card', { confirm: true }],
  ];

  for (const [name, args] of cases) {
    const before = mcp.cards.calls.length;
    const { status, json } = await call(name, args);
    const label = `${name} ${JSON.stringify(args).slice(0, 80)}`;

    assert.equal(status, 200, label);
    assert.equal(json.result.isError, true, label);
    assert.match(json.result.content[0].text, /INVALID_INPUT/, label);
    assert.equal(mcp.cards.calls.length, before, `${label} never reached the card service`);
  }
});

test('a read-only token is refused for every write tool BEFORE the card service is called, and reads still work', async () => {
  const writes = [
    ['create_card', { database_id: 'db-1', title: 'x', idempotency_key: KEY }],
    ['update_card', { card_id: 'c-1', title: 'x' }],
    ['move_card', { card_id: 'c-1', column: 'Todo' }],
    ['archive_card', { card_id: 'c-1', confirm: true }],
    ['restore_card', { card_id: 'c-1', confirm: true }],
  ];
  const before = mcp.cards.calls.length;
  const auditBefore = mcp.audit.length;

  for (const [name, args] of writes) {
    const { json } = await call(name, args, { token: READ_TOKEN });

    assert.equal(json.result.isError, true, name);
    assert.match(json.result.content[0].text, /read-only/, name);
  }
  assert.equal(mcp.cards.calls.length, before, 'no write reached the card service');
  const records = mcp.audit.slice(auditBefore);

  assert.equal(records.length, writes.length);
  assert.ok(records.every((record) => record.ok === false && record.error_code === 'FORBIDDEN' && record.token_id === 'tok-read'));

  for (const [name, args] of [['list_databases', {}], ['get_database', { database_id: 'db-1' }], ['list_cards', { database_id: 'db-1' }], ['get_card', { card_id: 'c-1' }]]) {
    assert.equal((await call(name, args, { token: READ_TOKEN })).json.result.isError, false, name);
  }
  // Scope is checked before arguments, so a read token learns nothing about write schemas.
  const invalidButForbidden = await call('create_card', {}, { token: READ_TOKEN });

  assert.match(invalidButForbidden.json.result.content[0].text, /read-only/);
});

test('card text is returned as data and never acted on', async () => {
  const { json } = await call('list_cards', { database_id: 'db-1' });
  const poisoned = json.result.structuredContent.cards.find((card) => card.id === 'c-3');

  assert.match(poisoned.title, /Ignore previous instructions/);
  assert.equal(mcp.cards.calls.filter((entry) => entry.method === 'archiveCard' && entry.args.cardId === 'c-3').length, 0);
  assert.match(toolDefs.list_cards.description, /untrusted/);
});

test('an unexpected service failure is a generic JSON-RPC -32603 with no leaked detail', async () => {
  const response = await call('update_card', { card_id: 'c-1', title: 'boom' });

  assert.equal(response.status, 500);
  assert.equal(response.json.error.code, -32603);
  assert.equal(response.json.error.message, 'Internal error');
  assert.ok(!response.text.includes('postgres://') && !response.text.includes('secret'), 'no internal detail in the response');
  assert.ok(mcp.logs.some((line) => line.includes('db exploded')), 'the detail is logged server-side');
  const record = mcp.audit.at(-1);

  assert.equal(record.tool, 'update_card');
  assert.equal(record.ok, false);
  assert.equal(record.error_code, 'INTERNAL');
});

test('a slow operation is cut off by the per-call timeout and reported as a tool error', async () => {
  const slow = await startMcp({ limits: { callTimeoutMs: 50 } });

  try {
    const { status, json } = await callModern(slow.url, 'tools/call', { name: 'update_card', arguments: { card_id: 'c-1', title: 'slow' } });

    assert.equal(status, 200);
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /TIMEOUT/);
    assert.match(json.result.content[0].text, /get_card/);
    assert.equal(slow.audit.at(-1).error_code, 'TIMEOUT');
  } finally {
    await slow.close();
  }
});

test('write tools only use the identity from the token (workspace and user are never taken from arguments)', async () => {
  const cards = createFakeCards();
  const isolated = await startMcp({ cards });

  try {
    await callModern(isolated.url, 'tools/call', { name: 'list_cards', arguments: { database_id: 'db-1' } });
    const { json } = await callModern(isolated.url, 'tools/call', { name: 'list_cards', arguments: { database_id: 'db-1', workspace_id: 'other' } });

    assert.equal(json.result.isError, true, 'workspace_id is not an accepted argument');
    assert.ok(cards.calls.every((entry) => entry.args.workspaceId === 'ws-1'));
  } finally {
    await isolated.close();
  }
});
