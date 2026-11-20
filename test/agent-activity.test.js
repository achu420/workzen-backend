// "Whose agent did that?": every MCP call lands in a persistent trail with the agent's name and its owner, and every
// recorded write can be undone by any member - as long as nobody changed the card after the agent did.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { account, createTemplateDatabase, startCardsEnv } from './helpers/cards-env.js';
import { eachStorageMode, mcpOk, mcpTool, mintToken } from './helpers/mcp-live-env.js';

eachStorageMode('agent activity trail', (mode) => {
  let env, owner, mia, omar, outsider, db, miaWrite, omarRead;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const trail = async (who, query = '') => (await env.api('GET', `/api/workspace/${owner.workspaceId}/agent-activity${query}`, undefined, who.token)).body.data;
  const member = (user) => ({ ...user, workspaceId: owner.workspaceId });
  const add = async (user) => {
    const response = await fetch(`${env.base}/api/workspaces/${owner.workspaceId}/test-members`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}`, 'x-development-key': 'test-key' }, body: JSON.stringify({ email: user.email, role: 'member' }) });

    assert.equal(response.status, 201);
  };
  const firstCards = async (count = 3) => (await mcpOk(env, miaWrite.token, 'list_cards', { database_id: db.databaseId, limit: count })).cards;

  before(async () => {
    env = await startCardsEnv({ storage: mode, serverOptions: { searchIndexDelayMs: 0 } });
    owner = await account(env, `trail-owner-${mode}`);
    mia = await account(env, `trail-mia-${mode}`);
    omar = await account(env, `trail-omar-${mode}`);
    outsider = await account(env, `trail-outsider-${mode}`);
    await add(mia);
    await add(omar);
    db = await createTemplateDatabase(env, owner, 'opportunities', 'Pipeline');
    miaWrite = await mintToken(env, member(mia), { scope: 'write', name: "Mia's Claude Code" });
    omarRead = await mintToken(env, member(omar), { scope: 'read', name: "Omar's Cursor" });
  });
  after(async () => { await env?.stop(); });

  test('each call is recorded with the agent name, its owner, the tool and a readable summary', async () => {
    const [card] = await firstCards(1);
    const before = card.fields.Owner ?? null;

    await mcpOk(env, miaWrite.token, 'get_card', { card_id: card.id });
    await mcpOk(env, miaWrite.token, 'update_card', { card_id: card.id, fields: { Owner: 'Priya (agent)' } });
    await mcpOk(env, omarRead.token, 'list_cards', { database_id: db.databaseId, limit: 2 });
    const refused = await mcpTool(env, omarRead.token, 'archive_card', { card_id: card.id, confirm: true });

    assert.equal(refused.result.isError, true, 'a read-only token cannot write');
    await settle();
    const { entries } = await trail(owner);
    const byTool = (agent, tool) => entries.find((entry) => entry.agent === agent && entry.tool === tool);
    const update = byTool("Mia's Claude Code", 'update_card');

    assert.deepEqual([update.owner.email, update.owner.name, update.kind, update.ok, update.target_id, update.target_title], [mia.email, mia.email, 'write', true, card.id, card.title]);
    assert.match(update.summary, new RegExp(`^Updated Owner on \\u201c${card.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\u201d$`));
    assert.equal(update.can_undo, true);
    assert.equal(byTool("Mia's Claude Code", 'get_card').kind, 'read');
    assert.match(byTool("Mia's Claude Code", 'get_card').summary, /^Read card/);
    assert.deepEqual([byTool("Omar's Cursor", 'list_cards').kind, byTool("Omar's Cursor", 'list_cards').owner.email], ['read', omar.email]);
    const denied = byTool("Omar's Cursor", 'archive_card');

    assert.deepEqual([denied.ok, denied.error_code, denied.can_undo], [false, 'FORBIDDEN', false]);
    assert.match(denied.summary, /^Failed: archive_card \(FORBIDDEN\)$/);
    assert.ok(before !== 'Priya (agent)');
    assert.equal(JSON.stringify(entries).includes(miaWrite.token.split('_').slice(2).join('_')), false, 'no token secret in the trail');
    assert.equal(JSON.stringify(entries).includes('"undo"'), false, 'the undo recipe stays on the server');
  });

  test('every member can read the trail, and nobody outside the workspace can', async () => {
    for (const who of [owner, mia, omar]) assert.ok((await trail(who)).entries.length > 0);
    assert.equal((await env.api('GET', `/api/workspace/${owner.workspaceId}/agent-activity`, undefined, outsider.token)).status, 403);
    assert.equal((await env.api('GET', `/api/workspace/${owner.workspaceId}/agent-activity`)).status, 401);
    assert.equal((await env.api('GET', `/api/workspace/${owner.workspaceId}/agent-activity?kind=weird`, undefined, owner.token)).status, 400);
    assert.equal((await env.api('GET', `/api/workspace/${owner.workspaceId}/agent-activity?before=nope`, undefined, owner.token)).status, 400);
  });

  test('filters and paging walk the trail without gaps', async () => {
    for (let index = 0; index < 5; index += 1) await mcpOk(env, omarRead.token, 'list_databases', {});
    await settle();
    const all = (await trail(owner, '?limit=100')).entries;
    const mine = (await trail(owner, `?token_id=${omarRead.id}`)).entries;

    assert.ok(mine.length >= 6 && mine.every((entry) => entry.token_id === omarRead.id));
    assert.ok((await trail(owner, `?user_id=${mia.userId}`)).entries.every((entry) => entry.owner.user_id === mia.userId));
    assert.ok((await trail(owner, '?kind=write')).entries.every((entry) => entry.kind === 'write'));
    assert.ok((await trail(owner, '?ok=false')).entries.every((entry) => entry.ok === false));
    const walked = [];
    let page = await trail(owner, '?limit=3');

    walked.push(...page.entries.map((entry) => entry.id));
    while (page.has_more) {
      page = await trail(owner, `?limit=3&before=${encodeURIComponent(page.next_before)}`);
      walked.push(...page.entries.map((entry) => entry.id));
    }
    assert.deepEqual(walked, all.map((entry) => entry.id), 'paging yields the same order, once each');
    assert.ok(all.every((entry, index) => index === 0 || all[index - 1].created_at >= entry.created_at), 'newest first');
  });

  test('undo restores an agent edit, once, as the person who clicked it', async () => {
    const [card] = await firstCards(2);
    const original = (await mcpOk(env, miaWrite.token, 'get_card', { card_id: card.id })).card;

    await mcpOk(env, miaWrite.token, 'update_card', { card_id: card.id, title: 'Renamed by agent', fields: { Owner: 'Agent Owner' } });
    await settle();
    const entry = (await trail(owner, '?kind=write&limit=1')).entries[0];

    assert.match(entry.summary, /^Updated title, Owner on /);
    const undone = await env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${entry.id}/undo`, undefined, omar.token);

    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    const after = (await mcpOk(env, miaWrite.token, 'get_card', { card_id: card.id })).card;

    assert.equal(after.title, original.title);
    assert.deepEqual(after.fields.Owner ?? null, original.fields.Owner ?? null);
    const again = await env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${entry.id}/undo`, undefined, owner.token);

    assert.deepEqual([again.status, again.body.error.code], [409, 'ALREADY_UNDONE']);
    const refreshed = (await trail(owner, '?kind=write&limit=5')).entries.find((candidate) => candidate.id === entry.id);

    assert.deepEqual([refreshed.undone, refreshed.can_undo], [true, false]);
  });

  test('undo refuses to overwrite a later edit by someone else', async () => {
    const [, card] = await firstCards(2);

    await mcpOk(env, miaWrite.token, 'update_card', { card_id: card.id, fields: { Owner: 'Agent said' } });
    await settle();
    const entry = (await trail(owner, '?kind=write&limit=1')).entries[0];

    // A human (here, a second agent acting for Omar) edits the same field afterwards.
    const omarWrite = await mintToken(env, member(omar), { scope: 'write', name: "Omar's other agent" });

    await mcpOk(env, omarWrite.token, 'update_card', { card_id: card.id, fields: { Owner: 'Human said' } });
    const refused = await env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${entry.id}/undo`, undefined, owner.token);

    assert.deepEqual([refused.status, refused.body.error.code], [409, 'CHANGED_SINCE']);
    assert.equal((await mcpOk(env, miaWrite.token, 'get_card', { card_id: card.id })).card.fields.Owner, 'Human said', 'nothing was overwritten');
    assert.equal((await trail(owner, '?kind=write&limit=5')).entries.find((candidate) => candidate.id === entry.id).can_undo, true, 'still undoable later');
  });

  test('moves, archives and new cards can be undone too', async () => {
    const created = (await mcpOk(env, miaWrite.token, 'create_card', { database_id: db.databaseId, title: 'Agent made this', idempotency_key: `trail-create-${mode}-0001` })).card;

    await settle();
    let entry = (await trail(owner, '?kind=write&limit=1')).entries[0];

    assert.match(entry.summary, /^Created card .Agent made this. in /);
    assert.equal((await env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${entry.id}/undo`, undefined, owner.token)).status, 200);
    assert.equal((await mcpOk(env, miaWrite.token, 'get_card', { card_id: created.id })).card.archived, true, 'undoing a creation archives the card');

    await mcpOk(env, miaWrite.token, 'restore_card', { card_id: created.id, confirm: true });
    await settle();
    entry = (await trail(owner, '?kind=write&limit=1')).entries[0];
    assert.match(entry.summary, /^Restored /);
    assert.equal((await env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${entry.id}/undo`, undefined, owner.token)).status, 200);
    assert.equal((await mcpOk(env, miaWrite.token, 'get_card', { card_id: created.id })).card.archived, true);

    await mcpOk(env, miaWrite.token, 'restore_card', { card_id: created.id, confirm: true });
    await mcpOk(env, miaWrite.token, 'archive_card', { card_id: created.id, confirm: true });
    await settle();
    entry = (await trail(owner, '?kind=write&limit=1')).entries[0];
    assert.match(entry.summary, /^Archived /);
    assert.equal((await env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${entry.id}/undo`, undefined, owner.token)).status, 200);
    assert.equal((await mcpOk(env, miaWrite.token, 'get_card', { card_id: created.id })).card.archived, false, 'undoing an archive restores it');

    const detail = (await mcpOk(env, miaWrite.token, 'get_database', { database_id: db.databaseId })).database;
    const column = detail.boards[0].columns.map((candidate) => candidate.name);
    const target = column.find((name) => name !== created.column) ?? column[0];
    const before = (await mcpOk(env, miaWrite.token, 'get_card', { card_id: created.id })).card;

    await mcpOk(env, miaWrite.token, 'move_card', { card_id: created.id, column: target });
    await settle();
    entry = (await trail(owner, '?kind=write&limit=1')).entries[0];
    assert.match(entry.summary, /^Moved .Agent made this. from /);
    assert.equal((await env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${entry.id}/undo`, undefined, owner.token)).status, 200);
    assert.equal((await mcpOk(env, miaWrite.token, 'get_card', { card_id: created.id })).card.column, before.column, 'the card is back in its column');
  });

  test('undo rules: reads and failures cannot be undone, unknown ids are 404, outsiders are refused', async () => {
    const all = (await trail(owner, '?limit=100')).entries;
    const read = all.find((entry) => entry.kind === 'read');
    const failed = all.find((entry) => !entry.ok);
    const undo = (id, who = owner) => env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${id}/undo`, undefined, who.token);

    assert.equal((await undo(read.id)).body.error.code, 'NOT_UNDOABLE');
    assert.equal((await undo(failed.id)).body.error.code, 'NOT_UNDOABLE');
    assert.equal((await undo(crypto.randomUUID())).status, 404);
    assert.equal((await undo(read.id, outsider)).status, 403);
    assert.equal((await env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${read.id}/undo`)).status, 401);
  });

  test('the trail keeps the agent name after the token is revoked and survives a restart', async () => {
    const temp = await mintToken(env, member(mia), { scope: 'read', name: 'Short-lived agent' });

    await mcpOk(env, temp.token, 'list_databases', {});
    await settle();
    assert.equal((await env.api('DELETE', `/api/workspace/${owner.workspaceId}/agent-tokens/${temp.id}`, undefined, mia.token)).status, 200);
    const find = async () => (await trail(owner, `?token_id=${temp.id}`)).entries[0];

    assert.equal((await find()).agent, 'Short-lived agent');
    await env.restart();
    assert.equal((await find()).agent, 'Short-lived agent', 'the trail is durable');
  });
});
