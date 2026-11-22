// Light MCP end to end: real HTTP server, real agent-token store, real cards.js, real Yjs/storage. Covers both
// protocol profiles, all nine tools on a template-created database with a Board, scope and token lifecycle,
// Origin/CORS behaviour, the agent-token boundary, the audit log and restart persistence. Runs for the JSON store
// and, when RUN_POSTGRES_TESTS=1 + DATABASE_URL are set, for a real PostgreSQL.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const logDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-e2e-log-'));
const logFile = path.join(logDir, 'api.log');

process.env.API_LOG_FILE = logFile; // read by server.js at import time, so the helpers are imported after this
const { account, createTemplateDatabase, startCardsEnv } = await import('./helpers/cards-env.js');
const { eachStorageMode, mcpOk, mcpTool, mcpUrl, mintToken } = await import('./helpers/mcp-live-env.js');
const { callModern, legacy, post } = await import('./helpers/mcp-test-kit.js');

const TOOLS = ['add_comment', 'append_to_card_body', 'append_to_page', 'archive_card', 'create_card', 'create_database', 'create_page', 'get_card', 'get_database', 'list_cards', 'list_comments', 'list_databases', 'list_pages', 'move_card', 'read_page', 'resolve_comment', 'restore_card', 'search', 'update_card', 'update_database'];

process.on('exit', () => { try { rm(logDir, { recursive: true, force: true }); } catch { /* best effort */ } });

eachStorageMode('MCP e2e', (mode) => {
  let env, owner, outsider, adminUser, db, write, read, boardViewId, titleFieldId;

  const text = (response) => response.result?.content?.[0]?.text ?? '';
  const waitFor = async (probe, timeoutMs = 5000) => {
    const started = Date.now();

    for (;;) {
      const value = await probe();

      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const devPost = (route, payload, token) => fetch(`${env.base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-development-key': 'test-key' }, body: JSON.stringify(payload) });
  const expireToken = async (tokenId) => {
    if (mode === 'postgres') await env.store.pool.query("UPDATE agent_tokens SET expires_at = now() - interval '1 minute' WHERE id=$1", [tokenId]);
    else env.store.state.agentTokens[tokenId].expires_at = new Date(Date.now() - 60_000).toISOString();
  };

  before(async () => {
    env = await startCardsEnv({ storage: mode, serverOptions: { searchIndexDelayMs: 0 } });
    owner = await account(env, `e2e-owner-${mode}`);
    outsider = await account(env, `e2e-outsider-${mode}`);
    adminUser = await account(env, `e2e-admin-${mode}`);
    db = await createTemplateDatabase(env, owner, 'opportunities', 'E2E DB');
    write = await mintToken(env, owner, { scope: 'write', name: 'writer' });
    read = await mintToken(env, owner, { scope: 'read', name: 'reader' });
    const detail = (await mcpOk(env, write.token, 'get_database', { database_id: db.databaseId })).database;

    boardViewId = detail.boards[0].view_id;
    titleFieldId = detail.title_field.id;
  });
  after(async () => { await env?.stop(); });

  test('modern stateless profile: discover, list the twenty tools, call a tool', async () => {
    const discover = await callModern(mcpUrl(env), 'server/discover', {}, { token: write.token });

    assert.equal(discover.status, 200, discover.text);
    assert.ok(discover.json.result.supportedVersions.includes('2026-07-28'));
    assert.ok(discover.json.result.capabilities.tools);
    const listed = await callModern(mcpUrl(env), 'tools/list', {}, { token: write.token });

    assert.deepEqual(listed.json.result.tools.map((tool) => tool.name).sort(), TOOLS);
    const called = await mcpTool(env, write.token, 'list_databases', {}, { profile: 'modern' });

    assert.equal(called.status, 200);
    assert.ok(called.result.structuredContent.databases.some((database) => database.database_id === db.databaseId && database.has_board));
  });

  test('legacy profile: initialize, initialized notification, tools/list, tools/call', async () => {
    const init = await post(mcpUrl(env), legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }, 1), { token: write.token });

    assert.equal(init.status, 200, init.text);
    assert.equal(init.json.result.protocolVersion, '2025-06-18');
    assert.ok(init.json.result.capabilities.tools);
    const notified = await post(mcpUrl(env), { jsonrpc: '2.0', method: 'notifications/initialized' }, { token: write.token });

    assert.equal(notified.status, 202);
    const listed = await post(mcpUrl(env), legacy('tools/list', {}, 2), { token: write.token });

    assert.deepEqual(listed.json.result.tools.map((tool) => tool.name).sort(), TOOLS);
    const called = await mcpTool(env, write.token, 'get_database', { database_id: db.databaseId }, { profile: 'legacy' });

    assert.equal(called.status, 200);
    assert.equal(called.result.structuredContent.database.database_id, db.databaseId);
  });

  test('read tools: database detail with Board columns, paging cursors, column filter, text query, get_card', async () => {
    const detail = (await mcpOk(env, read.token, 'get_database', { database_id: db.databaseId })).database;
    const columns = detail.boards[0].columns.map((column) => column.name);

    assert.ok(columns.includes('No status'));
    for (const name of ['Prioritized', 'Validated', 'Researching']) assert.ok(columns.includes(name), `column ${name}`);

    const all = (await mcpOk(env, read.token, 'list_cards', { database_id: db.databaseId, view_id: boardViewId, limit: 100 })).cards;

    assert.equal(all.length, db.rowIds.length);
    const paged = [];
    let cursor;

    for (let pages = 0; pages < 10; pages += 1) {
      const page = await mcpOk(env, read.token, 'list_cards', { database_id: db.databaseId, view_id: boardViewId, limit: 2, ...(cursor ? { cursor } : {}) });

      paged.push(...page.cards.map((card) => card.id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    assert.deepEqual(paged, all.map((card) => card.id), 'cursor paging returns every card once, in order');

    const prioritized = (await mcpOk(env, read.token, 'list_cards', { database_id: db.databaseId, view_id: boardViewId, column: 'Prioritized', limit: 100 })).cards;

    assert.ok(prioritized.length > 0 && prioritized.every((card) => card.column === 'Prioritized'));
    const found = await waitFor(async () => {
      const result = await mcpOk(env, read.token, 'list_cards', { database_id: db.databaseId, query: 'Enterprise', limit: 10 });

      return result.cards.length ? result.cards : null;
    });

    assert.ok(found.every((card) => Object.values(card.fields).some((value) => String(value).toLowerCase().includes('enterprise'))));
    const card = (await mcpOk(env, read.token, 'get_card', { card_id: all[0].id })).card;

    assert.equal(card.id, all[0].id);
    assert.equal(typeof card.title, 'string');
  });

  test('create_card: column + fields, idempotent replay, conflicting reuse, invalid column', async () => {
    const args = { database_id: db.databaseId, title: 'E2E created card', column: 'Validated', fields: { Owner: 'Agent Smith', Impact: 4 }, idempotency_key: `e2e-create-${mode}-0001` };
    const created = await mcpOk(env, write.token, 'create_card', args);

    assert.equal(created.replayed, false);
    assert.equal(created.card.title, 'E2E created card');
    assert.equal(created.card.column, 'Validated');
    assert.equal(created.card.fields.Owner, 'Agent Smith');
    const replay = await mcpOk(env, write.token, 'create_card', args);

    assert.equal(replay.replayed, true);
    assert.equal(replay.card.id, created.card.id, 'a retry returns the original card');
    const conflict = await mcpTool(env, write.token, 'create_card', { ...args, title: 'A different request' });

    assert.equal(conflict.result.isError, true);
    assert.match(text(conflict), /CONFLICT/);
    const bad = await mcpTool(env, write.token, 'create_card', { ...args, idempotency_key: `e2e-create-${mode}-0002`, column: 'Nope' });

    assert.equal(bad.result.isError, true);
    assert.match(text(bad), /Unknown column "Nope"/);
    assert.match(text(bad), /Prioritized/, 'the error lists the valid columns');
    assert.doesNotMatch(text(bad), /Details: null/);
    const all = (await mcpOk(env, write.token, 'list_cards', { database_id: db.databaseId, limit: 100 })).cards;

    assert.equal(all.filter((card) => card.title === 'E2E created card').length, 1, 'exactly one card was created');
  });

  test('update_card, move_card (+reorder), archive_card and restore_card', async () => {
    const cards = (await mcpOk(env, write.token, 'list_cards', { database_id: db.databaseId, view_id: boardViewId, limit: 100 })).cards;
    const target = cards[0];
    const updated = (await mcpOk(env, write.token, 'update_card', { card_id: target.id, title: 'E2E renamed', fields: { Owner: 'Updated Owner' } })).card;

    assert.equal(updated.title, 'E2E renamed');
    assert.equal(updated.fields.Owner, 'Updated Owner');
    assert.equal((await mcpOk(env, write.token, 'get_card', { card_id: target.id })).card.title, 'E2E renamed');
    const persisted = await env.store.getDatabaseRowCollab(owner.workspaceId, target.id);

    assert.ok(persisted, 'the row is stored');
    assert.equal((await mcpTool(env, write.token, 'update_card', { card_id: target.id })).result?.isError ?? true, true, 'an update with nothing to change is refused');

    const researching = (await mcpOk(env, write.token, 'list_cards', { database_id: db.databaseId, view_id: boardViewId, column: 'Researching', limit: 100 })).cards;
    const anchor = researching[0] ?? (await mcpOk(env, write.token, 'move_card', { card_id: cards[1].id, column: 'Researching', view_id: boardViewId })).card;
    const mover = cards.find((card) => card.id !== anchor.id && card.id !== target.id && card.column !== 'Researching') ?? cards.find((card) => card.id !== anchor.id);
    const moved = await mcpOk(env, write.token, 'move_card', { card_id: mover.id, column: 'Researching', view_id: boardViewId, before_card_id: anchor.id });

    assert.equal(moved.card.column, 'Researching');
    const order = (await mcpOk(env, write.token, 'list_cards', { database_id: db.databaseId, view_id: boardViewId, limit: 100 })).cards.map((card) => card.id);

    assert.equal(order.indexOf(mover.id), order.indexOf(anchor.id) - 1, 'the card sits right before its anchor');
    const wrongColumn = await mcpTool(env, write.token, 'move_card', { card_id: mover.id, column: 'Prioritized', view_id: boardViewId, before_card_id: anchor.id });

    assert.equal(wrongColumn.result.isError, true, 'an anchor from another column is rejected');

    const missingConfirm = await mcpTool(env, write.token, 'archive_card', { card_id: target.id });

    assert.ok(missingConfirm.error || missingConfirm.result?.isError, 'archive needs confirm');
    await mcpOk(env, write.token, 'archive_card', { card_id: target.id, confirm: true });
    assert.equal((await mcpOk(env, write.token, 'list_cards', { database_id: db.databaseId, view_id: boardViewId, limit: 100 })).cards.some((card) => card.id === target.id), false);
    assert.equal((await mcpOk(env, write.token, 'list_cards', { database_id: db.databaseId, view_id: boardViewId, limit: 100, include_archived: true })).cards.find((card) => card.id === target.id)?.archived, true);
    await mcpOk(env, write.token, 'restore_card', { card_id: target.id, confirm: true });
    assert.equal((await mcpOk(env, write.token, 'get_card', { card_id: target.id })).card.archived, false);
    assert.equal(persisted.doc_state.length > 0, true);
    assert.ok(titleFieldId);
  });

  test('a read-only token can read but every write tool is refused and changes nothing', async () => {
    const before = (await mcpOk(env, read.token, 'list_cards', { database_id: db.databaseId, limit: 100 })).cards;
    const attempts = [
      ['create_card', { database_id: db.databaseId, title: 'nope', idempotency_key: `ro-attempt-${mode}-1` }],
      ['update_card', { card_id: before[0].id, title: 'nope' }],
      ['move_card', { card_id: before[0].id, column: 'Validated' }],
      ['archive_card', { card_id: before[0].id, confirm: true }],
      ['restore_card', { card_id: before[0].id, confirm: true }],
    ];

    for (const [tool, args] of attempts) {
      const response = await mcpTool(env, read.token, tool, args);

      assert.equal(response.status, 200);
      assert.equal(response.result.isError, true, `${tool} must be refused for a read token`);
      assert.match(text(response), /read-only|write/i);
    }
    const after = (await mcpOk(env, read.token, 'list_cards', { database_id: db.databaseId, limit: 100 })).cards;

    assert.deepEqual(after.map((card) => [card.id, card.title, card.archived]), before.map((card) => [card.id, card.title, card.archived]));
  });

  test('token lifecycle: unknown, revoked, expired, membership removed (and restored), cross-workspace', async () => {
    const ping = (token) => post(mcpUrl(env), legacy('tools/list', {}, 1), { token });

    assert.equal((await ping(undefined)).status, 401);
    assert.equal((await ping('afmcp_nope_nope')).status, 401);
    assert.equal((await ping(write.token.replace(/.$/, (character) => (character === 'a' ? 'b' : 'a')))).status, 401, 'a wrong secret is refused');

    const revoked = await mintToken(env, owner, { name: 'to revoke' });

    assert.equal((await ping(revoked.token)).status, 200);
    assert.equal((await env.api('DELETE', `/api/workspace/${owner.workspaceId}/agent-tokens/${revoked.id}`, undefined, owner.token)).status, 200);
    assert.equal((await ping(revoked.token)).status, 401);

    const expiring = await mintToken(env, owner, { name: 'to expire', expires_in_days: 1 });

    assert.equal((await ping(expiring.token)).status, 200);
    await expireToken(expiring.id);
    assert.equal((await ping(expiring.token)).status, 401);

    assert.equal((await devPost(`/api/workspaces/${owner.workspaceId}/test-members`, { email: adminUser.email, role: 'admin' }, owner.token)).status, 201);
    const adminToken = await mintToken(env, { workspaceId: owner.workspaceId, token: adminUser.token }, { name: 'admin agent' });

    assert.equal((await ping(adminToken.token)).status, 200, 'an admin can mint a token for the workspace');
    assert.equal((await fetch(`${env.base}/api/workspaces/${owner.workspaceId}/test-members?email=${encodeURIComponent(adminUser.email)}`, { method: 'DELETE', headers: { authorization: `Bearer ${owner.token}`, 'x-development-key': 'test-key' } })).status, 200);
    assert.equal((await ping(adminToken.token)).status, 403, 'removing the member disables their token immediately');
    assert.equal((await devPost(`/api/workspaces/${owner.workspaceId}/test-members`, { email: adminUser.email, role: 'admin' }, owner.token)).status, 201);
    assert.equal((await ping(adminToken.token)).status, 200, 'an untouched token works again once the member is back');

    const foreign = await mintToken(env, outsider, { name: 'other workspace' });
    const card = (await mcpOk(env, write.token, 'list_cards', { database_id: db.databaseId, limit: 1 })).cards[0];
    const crossDatabase = await mcpTool(env, foreign.token, 'get_database', { database_id: db.databaseId });
    const crossCard = await mcpTool(env, foreign.token, 'get_card', { card_id: card.id });
    const crossMutation = await mcpTool(env, foreign.token, 'update_card', { card_id: card.id, title: 'hijack' });

    for (const response of [crossDatabase, crossCard, crossMutation]) {
      assert.equal(response.result.isError, true);
      assert.match(text(response), /NOT_FOUND/);
    }
    assert.notEqual((await mcpOk(env, write.token, 'get_card', { card_id: card.id })).card.title, 'hijack');
    assert.equal((await mcpOk(env, foreign.token, 'list_databases', {})).databases.some((database) => database.database_id === db.databaseId), false, 'another workspace sees none of these databases');
  });

  test('Origin and browser access: a foreign Origin is refused, no CORS headers, preflight is not granted', async () => {
    const evil = await post(mcpUrl(env), legacy('tools/list', {}, 1), { token: write.token, headers: { origin: 'https://evil.example' } });

    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const loopback = await post(mcpUrl(env), legacy('tools/list', {}, 1), { token: write.token, headers: { origin: 'http://127.0.0.1:3000' } });

    assert.equal(loopback.status, 200, 'a loopback origin is allowed for a loopback-bound server');
    const preflight = await fetch(mcpUrl(env), { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });

    assert.ok([403, 405].includes(preflight.status), `a foreign-origin preflight is refused (got ${preflight.status})`);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    assert.equal(preflight.headers.get('access-control-allow-headers'), null);
    const bare = await fetch(mcpUrl(env), { method: 'OPTIONS' });

    assert.equal(bare.status, 405, 'without an Origin, OPTIONS is simply not supported');
    assert.equal(bare.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(mcpUrl(env), { method: 'GET', headers: { authorization: `Bearer ${write.token}` } })).status, 405);
  });

  test('agent tokens are refused by ordinary REST routes and the WebSocket handshake', async () => {
    for (const route of [`/api/user/workspace`, `/api/workspace/${owner.workspaceId}/agent-tokens`, `/api/workspace/${owner.workspaceId}/database`]) {
      const response = await fetch(`${env.base}${route}`, { headers: { authorization: `Bearer ${write.token}` } });

      assert.equal(response.status, 401, `${route} must not accept an agent token`);
    }
    const query = new URLSearchParams({ clientId: '9001', deviceId: '00000000-0000-4000-8000-000000009001', token: write.token, cv: '0.10.0', cp: 'web' });
    const outcome = await new Promise((resolve) => {
      const socket = new WebSocket(`${env.base.replace(/^http/, 'ws')}/ws/v2/${owner.workspaceId}/?${query}`);

      socket.once('open', () => { socket.terminate(); resolve('open'); });
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      socket.once('error', () => resolve('error'));
    });

    assert.notEqual(outcome, 'open', 'the WebSocket handshake rejects an agent token');
    const noToken = await fetch(`${env.base}/api/user/workspace`, { headers: { authorization: `Bearer ${owner.token}` } });

    assert.equal(noToken.status, 200, 'a normal session still works');
    assert.equal((await post(mcpUrl(env), legacy('tools/list', {}, 1), { token: owner.token })).status, 401, 'a session token is refused by /mcp');
  });

  test('every tool call writes one audit record without secrets or card content', async () => {
    const marker = `Audit marker ${mode} ${Math.random().toString(36).slice(2)}`;
    const created = await mcpOk(env, write.token, 'create_card', { database_id: db.databaseId, title: marker, idempotency_key: `e2e-audit-${mode}-0001` });

    await mcpTool(env, read.token, 'update_card', { card_id: created.card.id, title: 'refused' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const lines = (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const audits = lines.filter((line) => line.kind === 'mcp_call');
    const mine = audits.filter((line) => line.target === created.card.id || line.target === db.databaseId);

    assert.ok(audits.length >= 10, 'audit records exist');
    const createRecord = mine.find((line) => line.tool === 'create_card' && line.ok);
    const refused = mine.find((line) => line.tool === 'update_card' && line.ok === false);

    assert.ok(createRecord, 'the create call was audited');
    assert.equal(createRecord.token_id, write.id);
    assert.equal(createRecord.workspace_id, owner.workspaceId);
    assert.equal(createRecord.user_id, owner.userId);
    assert.equal(typeof createRecord.duration_ms, 'number');
    assert.ok(refused, 'the refused write was audited');
    assert.equal(refused.token_id, read.id);
    const raw = await readFile(logFile, 'utf8');

    assert.ok(!raw.includes(write.token.split('_').slice(2).join('_')), 'a token secret never reaches the log');
    assert.ok(!raw.includes(read.token.split('_').slice(2).join('_')), 'a token secret never reaches the log');
    assert.ok(!raw.includes(marker), 'card content never reaches the log');
  });

  test('data and tokens persist across a backend restart', async () => {
    const before = (await mcpOk(env, write.token, 'list_cards', { database_id: db.databaseId, limit: 100 })).cards.map((card) => [card.id, card.title, card.column]);

    await env.restart();
    const after = (await mcpOk(env, write.token, 'list_cards', { database_id: db.databaseId, limit: 100 })).cards.map((card) => [card.id, card.title, card.column]);

    assert.deepEqual(after, before, 'cards survive a restart');
    assert.equal((await post(mcpUrl(env), legacy('tools/list', {}, 1), { token: read.token })).status, 200, 'tokens survive a restart');
    const replay = await mcpOk(env, write.token, 'create_card', { database_id: db.databaseId, title: 'E2E created card', column: 'Validated', fields: { Owner: 'Agent Smith', Impact: 4 }, idempotency_key: `e2e-create-${mode}-0001` });

    assert.equal(replay.replayed, true, 'the idempotency ledger survives a restart');
  });
});
