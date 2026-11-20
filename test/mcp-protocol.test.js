// Light MCP protocol layer: modern (2026-07-28 stateless) and legacy (initialize) profiles,
// discovery, tool listing, JSON-RPC and header validation. Real HTTP server around the
// handler, fake card service. Evidence class: real HTTP protocol tests, no real client.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertSchemaWellFormed, callModern, legacy, modern, post, startMcp } from './helpers/mcp-test-kit.js';

let mcp;

before(async () => { mcp = await startMcp(); });
after(async () => { await mcp.close(); });

const EXPECTED_TOOLS = ['list_databases', 'get_database', 'list_cards', 'get_card', 'create_card', 'update_card', 'move_card', 'archive_card', 'restore_card', 'search', 'read_page', 'list_pages', 'create_page', 'append_to_page', 'list_comments', 'add_comment', 'resolve_comment', 'append_to_card_body'];

test('modern stateless flow: discover, list tools, call a tool, ping', async () => {
  const discover = await callModern(mcp.url, 'server/discover', {}, { id: 'd1' });

  assert.equal(discover.status, 200);
  assert.equal(discover.json.id, 'd1');
  assert.equal(discover.json.result.resultType, 'complete');

  const list = await callModern(mcp.url, 'tools/list', {}, { id: 2 });

  assert.equal(list.status, 200);
  assert.equal(list.json.result.resultType, 'complete');
  assert.deepEqual(list.json.result.tools.map((tool) => tool.name), EXPECTED_TOOLS);

  const call = await callModern(mcp.url, 'tools/call', { name: 'get_card', arguments: { card_id: 'c-1' } }, { id: 3 });

  assert.equal(call.status, 200);
  assert.equal(call.json.id, 3);
  assert.equal(call.json.result.resultType, 'complete');
  assert.equal(call.json.result.isError, false);
  assert.equal(call.json.result.structuredContent.card.id, 'c-1');

  const ping = await callModern(mcp.url, 'ping', {}, { id: 4 });

  assert.equal(ping.status, 200);
  assert.equal(ping.json.result.resultType, 'complete');
  assert.equal(ping.headers.get('mcp-session-id'), null, 'no protocol session ids are issued');
});

test('server/discover reports versions, capabilities, identity, instructions and caching', async () => {
  const { json } = await callModern(mcp.url, 'server/discover', {});
  const { result } = json;

  assert.deepEqual(result.supportedVersions, ['2026-07-28']);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'appflowy-cards-mcp');
  assert.match(result.instructions, /untrusted/i);
  assert.equal(typeof result.ttlMs, 'number');
  assert.ok(['public', 'private'].includes(result.cacheScope));
});

test('tools/list exposes exactly the eighteen tools with valid schemas and annotations', async () => {
  const { json } = await callModern(mcp.url, 'tools/list', {});
  const tools = json.result.tools;

  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED_TOOLS);
  assert.equal(json.result.nextCursor, undefined, 'a single page: no nextCursor');
  for (const tool of tools) {
    assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/);
    assert.ok(tool.title && tool.description);
    assert.match(tool.description, /untrusted/i, `${tool.name} warns that card content is untrusted`);
    assert.doesNotThrow(() => assertSchemaWellFormed(tool.inputSchema), `${tool.name} inputSchema`);
    assert.doesNotThrow(() => assertSchemaWellFormed(tool.outputSchema), `${tool.name} outputSchema`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.outputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const forbidden of ['anyOf', 'oneOf', 'allOf', 'not']) assert.equal(tool.inputSchema[forbidden], undefined, `${tool.name} has no top-level ${forbidden} (rejected by some clients)`);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  for (const read of ['list_databases', 'get_database', 'list_cards', 'get_card', 'search', 'read_page', 'list_pages', 'list_comments']) assert.equal(byName[read].annotations.readOnlyHint, true, read);
  assert.equal(byName.append_to_page.annotations.readOnlyHint, false);
  assert.equal(byName.append_to_page.annotations.idempotentHint, false, 'appending twice appends twice');
  assert.equal(byName.append_to_page.annotations.destructiveHint, false, 'it never removes anything');
  for (const adds of ['append_to_card_body', 'add_comment']) {
    assert.equal(byName[adds].annotations.idempotentHint, false, `${adds}: doing it twice adds twice`);
    assert.equal(byName[adds].annotations.destructiveHint, false, `${adds} never removes anything`);
  }
  assert.deepEqual(byName.add_comment.inputSchema.required, ['content']);
  assert.deepEqual(byName.append_to_card_body.inputSchema.required.sort(), ['card_id', 'content']);
  for (const write of ['create_card', 'update_card', 'move_card', 'archive_card', 'restore_card', 'create_page']) {
    assert.equal(byName[write].annotations.readOnlyHint, false, write);
    assert.equal(byName[write].annotations.idempotentHint, true, write);
    assert.equal(byName[write].annotations.destructiveHint, write === 'archive_card', `${write} destructiveHint`);
  }
  assert.deepEqual(byName.create_card.inputSchema.required.sort(), ['database_id', 'idempotency_key', 'title']);
  assert.deepEqual(byName.archive_card.inputSchema.required.sort(), ['card_id', 'confirm']);
  assert.deepEqual(byName.restore_card.inputSchema.required.sort(), ['card_id', 'confirm']);
  assert.equal(byName.list_cards.inputSchema.properties.limit.maximum, 100);
  assert.equal(byName.list_cards.inputSchema.properties.limit.default, 25);
  assert.equal(byName.create_card.inputSchema.properties.idempotency_key.pattern, '^[A-Za-z0-9._:-]{8,128}$');
  assert.equal(byName.create_card.inputSchema.properties.fields.maxProperties, 50);
});

test('tools/list is deterministic and tolerates a cursor', async () => {
  const first = await callModern(mcp.url, 'tools/list', {});
  const second = await callModern(mcp.url, 'tools/list', { cursor: 'whatever' });

  assert.deepEqual(first.json.result.tools, second.json.result.tools);
  const bad = await callModern(mcp.url, 'tools/list', { cursor: 5 });

  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, -32602);
});

test('legacy flow: initialize negotiates a version, notifications/initialized is accepted, tools work without resultType', async () => {
  const init = await post(mcp.url, legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } }, 'i1'));

  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-06-18', 'echoes a supported version');
  assert.deepEqual(init.json.result.capabilities.tools, { listChanged: false });
  assert.equal(init.json.result.serverInfo.name, 'appflowy-cards-mcp');
  assert.equal(init.json.result.resultType, undefined);
  assert.equal(init.headers.get('mcp-session-id'), null);

  const newest = await post(mcp.url, legacy('initialize', { protocolVersion: '2025-11-25' }, 2));

  assert.equal(newest.json.result.protocolVersion, '2025-11-25');
  const older = await post(mcp.url, legacy('initialize', { protocolVersion: '2024-11-05' }, 3));

  assert.equal(older.json.result.protocolVersion, '2025-11-25', 'an unsupported older version gets our latest legacy version');

  const initialized = await post(mcp.url, { jsonrpc: '2.0', method: 'notifications/initialized' });

  assert.equal(initialized.status, 202);
  assert.equal(initialized.text, '');

  const headers = { 'mcp-protocol-version': '2025-06-18' };
  const list = await post(mcp.url, legacy('tools/list', undefined, 4), { headers });

  assert.deepEqual(list.json.result.tools.map((tool) => tool.name), EXPECTED_TOOLS);
  assert.equal(list.json.result.resultType, undefined);
  const call = await post(mcp.url, legacy('tools/call', { name: 'get_card', arguments: { card_id: 'c-2' } }, 5), { headers });

  assert.equal(call.json.result.isError, false);
  assert.equal(call.json.result.resultType, undefined);
  assert.equal(call.json.result.structuredContent.card.title, 'Ship it');
  assert.deepEqual((await post(mcp.url, legacy('ping', undefined, 6), { headers })).json.result, {});
});

test('legacy: initialize needs protocolVersion, unknown methods are -32601 over HTTP 200, unsupported header is 400', async () => {
  const bad = await post(mcp.url, legacy('initialize', {}, 1));

  assert.equal(bad.json.error.code, -32602);
  const unknown = await post(mcp.url, legacy('resources/list', undefined, 2));

  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.error.code, -32601);
  const header = await post(mcp.url, legacy('tools/list', undefined, 3), { headers: { 'mcp-protocol-version': '2024-11-05' } });

  assert.equal(header.status, 400);
  assert.equal(header.json.error.code, -32600);
  assert.deepEqual(header.json.error.data.supported, ['2026-07-28', '2025-11-25', '2025-06-18']);
});

test('both profiles run the same tools', async () => {
  const viaModern = await callModern(mcp.url, 'tools/call', { name: 'list_cards', arguments: { database_id: 'db-1', limit: 2 } });
  const viaLegacy = await post(mcp.url, legacy('tools/call', { name: 'list_cards', arguments: { database_id: 'db-1', limit: 2 } }));
  const { resultType, ...modernResult } = viaModern.json.result;

  assert.equal(resultType, 'complete');
  assert.deepEqual(modernResult, viaLegacy.json.result);
});

test('modern requests with missing or mismatching headers are 400 HeaderMismatch (-32020)', async () => {
  const cases = [
    ['missing MCP-Protocol-Version', { 'mcp-protocol-version': undefined }],
    ['missing Mcp-Method', { 'mcp-method': undefined }],
    ['Mcp-Method differs from body', { 'mcp-method': 'tools/list' }],
    ['missing Mcp-Name', { 'mcp-name': undefined }],
    ['Mcp-Name differs from body', { 'mcp-name': 'list_cards' }],
  ];

  for (const [label, override] of cases) {
    const { body, headers } = modern('tools/call', { name: 'get_card', arguments: { card_id: 'c-1' } }, 7);
    const merged = { ...headers, ...override };

    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    const response = await post(mcp.url, body, { headers: merged });

    assert.equal(response.status, 400, label);
    assert.equal(response.json.error.code, -32020, label);
    assert.equal(response.json.id, 7, label);
  }
  const { body, headers } = modern('tools/list', {}, 8);
  const versionMismatch = await post(mcp.url, body, { headers: { ...headers, 'mcp-protocol-version': '2025-11-25' } });

  assert.equal(versionMismatch.status, 400);
  assert.equal(versionMismatch.json.error.code, -32020);
});

test('a base64-encoded Mcp-Name header is decoded before comparison', async () => {
  const encoded = `=?base64?${Buffer.from('get_card', 'utf8').toString('base64')}?=`;
  const { body, headers } = modern('tools/call', { name: 'get_card', arguments: { card_id: 'c-1' } }, 9, { headers: { 'mcp-name': encoded } });
  const response = await post(mcp.url, body, { headers });

  assert.equal(response.status, 200);
  assert.equal(response.json.result.isError, false);
});

test('an unsupported protocol version is 400 -32022 with the supported list', async () => {
  const response = await callModern(mcp.url, 'tools/list', {}, { version: '1900-01-01', id: 11 });

  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, -32022);
  assert.equal(response.json.id, 11);
  assert.deepEqual(response.json.error.data.supported, ['2026-07-28', '2025-11-25', '2025-06-18']);
  assert.equal(response.json.error.data.requested, '1900-01-01');
});

test('unknown modern methods are 404 -32601; initialize is served by the legacy profile even with modern metadata', async () => {
  const unknown = await callModern(mcp.url, 'resources/list', {}, { id: 12 });

  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, -32601);
  const { body } = modern('initialize', { protocolVersion: '2025-06-18' }, 13);
  const init = await post(mcp.url, body);

  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-06-18');
});

test('malformed tools/call parameters are protocol errors (-32602); unknown tools too', async () => {
  const noName = await callModern(mcp.url, 'tools/call', { arguments: {} }, { headers: { 'mcp-name': 'x' } });

  assert.equal(noName.status, 400);
  assert.equal(noName.json.error.code, -32602);
  const badArguments = await callModern(mcp.url, 'tools/call', { name: 'get_card', arguments: [1] });

  assert.equal(badArguments.json.error.code, -32602);
  const unknownTool = await callModern(mcp.url, 'tools/call', { name: 'delete_everything', arguments: {} });

  assert.equal(unknownTool.status, 400);
  assert.equal(unknownTool.json.error.code, -32602);
  assert.match(unknownTool.json.error.message, /Unknown tool/);
  const legacyUnknown = await post(mcp.url, legacy('tools/call', { name: 'nope' }));

  assert.equal(legacyUnknown.status, 200);
  assert.equal(legacyUnknown.json.error.code, -32602);
});

test('invalid JSON-RPC is rejected with the right codes', async () => {
  const notJson = await post(mcp.url, undefined, { raw: '{not json' });

  assert.equal(notJson.status, 400);
  assert.equal(notJson.json.error.code, -32700);
  assert.equal(notJson.json.id, null);

  const batch = await post(mcp.url, [legacy('ping', undefined, 1), legacy('ping', undefined, 2)]);

  assert.equal(batch.status, 400);
  assert.equal(batch.json.error.code, -32600);
  assert.match(batch.json.error.message, /batch/i);

  for (const body of ['"a string"', '42', 'null', '{"id":1,"method":"ping"}', '{"jsonrpc":"1.0","id":1,"method":"ping"}']) {
    const response = await post(mcp.url, undefined, { raw: body });

    assert.equal(response.status, 400, body);
    assert.equal(response.json.error.code, -32600, body);
  }
  for (const id of [null, true, {}, [], 'ok-but-below']) {
    const response = await post(mcp.url, { jsonrpc: '2.0', id, method: 'ping' });

    if (typeof id === 'string') assert.equal(response.status, 200);
    else { assert.equal(response.status, 400, JSON.stringify(id)); assert.equal(response.json.error.code, -32600); }
  }
  const noMethod = await post(mcp.url, { jsonrpc: '2.0', id: 5 });

  assert.equal(noMethod.json.error.code, -32600);
  assert.equal(noMethod.json.id, 5);
  const badParams = await post(mcp.url, { jsonrpc: '2.0', id: 6, method: 'ping', params: [1] });

  assert.equal(badParams.status, 400);
  assert.equal(badParams.json.error.code, -32602);
  const responseFromClient = await post(mcp.url, { jsonrpc: '2.0', id: 7, result: {} });

  assert.equal(responseFromClient.status, 400, 'clients must not send responses');
});

test('notifications are accepted with 202 and no body, whatever the method', async () => {
  for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/unknown']) {
    const response = await post(mcp.url, { jsonrpc: '2.0', method, params: {} });

    assert.equal(response.status, 202, method);
    assert.equal(response.text, '', method);
  }
  const { body, headers } = modern('tools/list', {}, 1);

  delete body.id;
  const idless = await post(mcp.url, body, { headers });

  assert.equal(idless.status, 202, 'a request without an id is a notification and is never executed');
});

test('content negotiation: JSON only, Accept optional but must allow JSON', async () => {
  const wrongType = await post(mcp.url, undefined, { raw: 'ping', headers: { 'content-type': 'text/plain' } });

  assert.equal(wrongType.status, 415);
  const eventStreamOnly = await post(mcp.url, legacy('ping'), { headers: { accept: 'text/event-stream' } });

  assert.equal(eventStreamOnly.status, 406);
  const noAccept = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer afmcp_w_writesecret' }, body: JSON.stringify(legacy('ping')) });

  assert.equal(noAccept.status, 200);
  assert.match(noAccept.headers.get('content-type'), /^application\/json/);
  assert.equal(noAccept.headers.get('cache-control'), 'no-store');
});
