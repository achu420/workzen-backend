// MCP comments and card bodies: list_comments / add_comment / resolve_comment on pages and cards, and
// append_to_card_body. Real HTTP server, real agent tokens, real documents; what an agent writes is checked the way the
// web app reads it (the inline-comment list route, the comment-ids text attribute, the row's comment map).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { account, createTemplateDatabase, startCardsEnv } from './helpers/cards-env.js';
import { eachStorageMode, mcpOk, mcpTool, mintToken } from './helpers/mcp-live-env.js';

eachStorageMode('MCP comments and card bodies', (mode) => {
  let env, owner, mia, outsider, db, space, ownerAgent, miaAgent, miaRead;

  const settle = async () => { await env.running.app.searchIndex.flush(); await new Promise((resolve) => setTimeout(resolve, 150)); };
  const errorOf = (response) => (response.result?.isError ? response.result.content[0].text : null);
  const call = (token, name, args) => mcpTool(env, token, name, args);
  const member = (user) => ({ ...user, workspaceId: owner.workspaceId });
  const trail = async () => (await env.api('GET', `/api/workspace/${owner.workspaceId}/agent-activity`, undefined, owner.token)).body.data.entries;
  const undo = (entry, who = owner) => env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${entry.id}/undo`, undefined, who.token);
  const latest = async (tool, agent) => (await trail()).find((entry) => entry.tool === tool && entry.agent === agent);
  const webComments = async (pageId) => (await env.api('GET', `/api/workspace/${owner.workspaceId}/document/${pageId}/inline-comment`, undefined, owner.token)).body.data.comments;
  const notifications = async (who) => (await env.api('GET', `/api/workspace/${owner.workspaceId}/notifications`, undefined, who.token)).body.data.notifications;
  let created = 0;
  const makePage = async (title, content) => (await mcpOk(env, ownerAgent.token, 'create_page', { parent_id: space, title, content, idempotency_key: `comment-page-${mode}-${(created += 1)}-0001` })).page_id;
  const pageDoc = async (pageId) => {
    const doc = new Y.Doc({ guid: pageId });

    Y.applyUpdate(doc, (await env.store.getPageCollab(owner.workspaceId, pageId)).doc_state);
    return doc;
  };
  /** [text, comment ids] for every styled span of the page's text. */
  const anchorsIn = async (pageId) => {
    const doc = await pageDoc(pageId);
    const spans = [];

    for (const text of doc.getMap('data').get('document').get('meta').get('text_map').values()) {
      for (const op of [...text.getContent().children]) if (op.format?.['comment-ids']) spans.push([op.insert, op.format['comment-ids']]);
    }
    doc.destroy();
    return spans;
  };
  const rowComments = async (cardId) => {
    const collab = await env.store.getDatabaseRowCollab(owner.workspaceId, cardId);
    const doc = new Y.Doc({ guid: cardId });

    Y.applyUpdate(doc, collab.doc_state);
    const map = doc.getMap('data').get('comment');
    const result = map ? [...map.values()].map((comment) => comment.toJSON()) : [];

    doc.destroy();
    return result;
  };
  const firstCard = async () => (await mcpOk(env, ownerAgent.token, 'list_cards', { database_id: db.databaseId, limit: 1 })).cards[0];

  before(async () => {
    env = await startCardsEnv({ storage: mode, serverOptions: { searchIndexDelayMs: 0 } });
    owner = await account(env, `cm-owner-${mode}`);
    mia = await account(env, `cm-mia-${mode}`);
    outsider = await account(env, `cm-outsider-${mode}`);
    const added = await fetch(`${env.base}/api/workspaces/${owner.workspaceId}/test-members`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}`, 'x-development-key': 'test-key' }, body: JSON.stringify({ email: mia.email, role: 'member' }) });

    assert.equal(added.status, 201);
    space = owner.spaceId;
    db = await createTemplateDatabase(env, owner, 'opportunities', 'Pipeline');
    ownerAgent = await mintToken(env, owner, { scope: 'write', name: "Owen's Claude Code" });
    miaAgent = await mintToken(env, member(mia), { scope: 'write', name: "Mia's Claude Code" });
    miaRead = await mintToken(env, member(mia), { scope: 'read', name: "Mia's Cursor" });
  });
  after(async () => { await env?.stop(); });

  test('a page comment is a real thread: shown by the web route under the owner, highlighted in the text, and the page creator is told', async () => {
    const pageId = await makePage('Launch plan', 'We ship the beta in March.\n\nPricing is still open.');
    const added = await mcpOk(env, miaAgent.token, 'add_comment', { page_id: pageId, quote: 'beta in March', content: 'Can we move this to April?' });

    assert.ok(added.comment_id);
    const comments = await webComments(pageId);

    assert.equal(comments.length, 1);
    assert.equal(comments[0].content, "Via Mia's Claude Code: Can we move this to April?");
    assert.equal(comments[0].user.uuid, mia.userId, 'shown under the token owner');
    assert.ok(comments[0].block_id);
    assert.deepEqual(await anchorsIn(pageId), [['beta in March', [added.comment_id]]], 'the quoted text carries the comment id');
    const mine = (await notifications(owner)).filter((entry) => entry.type === 'comment_on_page');

    assert.equal(mine.length, 1);
    assert.equal(mine[0].metadata.comment_id, added.comment_id);
    assert.equal(mine[0].metadata.actor_name, mia.email.split('@')[0]);
    // The page text itself is untouched.
    assert.equal((await mcpOk(env, ownerAgent.token, 'read_page', { page_id: pageId })).page.text, 'We ship the beta in March.\nPricing is still open.');
    const entry = await latest('add_comment', "Mia's Claude Code");

    assert.deepEqual([entry.target_type, entry.target_id, entry.can_undo, entry.owner.email], ['page', pageId, true, mia.email]);
    assert.match(entry.summary, /^Commented on page/);
  });

  test('list_comments shows threads with author, quote and resolved state, and replies join the thread', async () => {
    const pageId = await makePage('Budget', 'Total spend is 40k.\n\nContingency is 10 percent.');
    const first = await mcpOk(env, miaAgent.token, 'add_comment', { page_id: pageId, quote: 'Total spend is 40k', content: 'Is this the final number?' });
    const reply = await mcpOk(env, ownerAgent.token, 'add_comment', { page_id: pageId, reply_to: first.comment_id, content: 'Yes, signed off.' });

    assert.equal(reply.reply_to, first.comment_id);
    const listed = await mcpOk(env, miaRead.token, 'list_comments', { page_id: pageId });

    assert.deepEqual(listed.target, { type: 'page', id: pageId, title: 'Budget' });
    assert.deepEqual(listed.comments.map((comment) => [comment.id, comment.parent_id, comment.author, comment.resolved, comment.quote]), [
      [first.comment_id, null, mia.email.split('@')[0], false, 'Total spend is 40k'],
      [reply.comment_id, first.comment_id, owner.email.split('@')[0], false, 'Total spend is 40k'],
    ]);
    // The owner's agent replied, so Mia (author of the thread) is notified of a reply.
    assert.equal((await notifications(mia)).filter((entry) => entry.type === 'comment_reply').length, 1);
    const resolved = await mcpOk(env, miaAgent.token, 'resolve_comment', { page_id: pageId, comment_id: first.comment_id });

    assert.equal(resolved.resolved, true);
    assert.equal(resolved.changed, true);
    const after = await mcpOk(env, miaRead.token, 'list_comments', { page_id: pageId });

    assert.deepEqual(after.comments.map((comment) => comment.resolved), [true, true], 'replies show their thread as resolved');
    assert.equal((await mcpOk(env, miaRead.token, 'list_comments', { page_id: pageId, include_resolved: false })).comments.length, 0);
    assert.equal((await webComments(pageId)).find((comment) => comment.comment_id === first.comment_id).is_resolved, true);
    const again = await mcpOk(env, miaAgent.token, 'resolve_comment', { page_id: pageId, comment_id: first.comment_id });

    assert.equal(again.changed, false, 'resolving twice changes nothing');
    assert.equal((await mcpOk(env, miaAgent.token, 'resolve_comment', { page_id: pageId, comment_id: first.comment_id, resolved: false })).resolved, false);
  });

  test('overlapping quotes keep both comments highlighted, and the first match in page order is used', async () => {
    const pageId = await makePage('Overlap', 'alpha beta gamma\n\nbeta again');
    const one = await mcpOk(env, miaAgent.token, 'add_comment', { page_id: pageId, quote: 'alpha beta', content: 'first' });
    const two = await mcpOk(env, miaAgent.token, 'add_comment', { page_id: pageId, quote: 'beta gamma', content: 'second' });
    const spans = await anchorsIn(pageId);

    assert.deepEqual(spans.map(([text, ids]) => [text, [...ids].sort()]), [
      ['alpha ', [one.comment_id]],
      ['beta', [one.comment_id, two.comment_id].sort()],
      [' gamma', [two.comment_id]],
    ]);
    const listed = await mcpOk(env, miaRead.token, 'list_comments', { page_id: pageId });

    assert.deepEqual(listed.comments.map((comment) => comment.quote), ['alpha beta', 'beta gamma']);
  });

  test('undo removes an agent comment and its highlight, but refuses once somebody has replied', async () => {
    const pageId = await makePage('Undo me', 'Keep this sentence safe.');
    const thread = await mcpOk(env, miaAgent.token, 'add_comment', { page_id: pageId, quote: 'this sentence', content: 'A remark.' });
    const entry = await latest('add_comment', "Mia's Claude Code");

    await mcpOk(env, ownerAgent.token, 'add_comment', { page_id: pageId, reply_to: thread.comment_id, content: 'Reply from a person.' });
    const refused = await undo(entry);

    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal((await webComments(pageId)).filter((comment) => !comment.is_deleted).length, 2, 'nothing was touched');
    const lone = await mcpOk(env, miaAgent.token, 'add_comment', { page_id: pageId, quote: 'Keep this', content: 'Another.' });
    const loneEntry = await latest('add_comment', "Mia's Claude Code");
    const done = await undo(loneEntry);

    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await webComments(pageId)).find((comment) => comment.comment_id === lone.comment_id).is_deleted, true);
    assert.ok(!(await anchorsIn(pageId)).some(([, ids]) => [...ids].includes(lone.comment_id)), 'its highlight is gone');
    assert.ok((await anchorsIn(pageId)).some(([, ids]) => [...ids].includes(thread.comment_id)), 'the other thread keeps its highlight');
    assert.equal((await mcpOk(env, ownerAgent.token, 'read_page', { page_id: pageId })).page.text, 'Keep this sentence safe.');
    assert.equal((await undo(loneEntry)).status, 409, 'cannot be undone twice');
  });

  test('undoing a resolve reopens the thread, unless it was changed again by someone else', async () => {
    const pageId = await makePage('Resolve undo', 'Decide the vendor.');
    const thread = await mcpOk(env, miaAgent.token, 'add_comment', { page_id: pageId, quote: 'Decide', content: 'Who owns this?' });

    await mcpOk(env, miaAgent.token, 'resolve_comment', { page_id: pageId, comment_id: thread.comment_id });
    const entry = await latest('resolve_comment', "Mia's Claude Code");

    assert.equal(entry.can_undo, true);
    assert.equal((await undo(entry)).status, 200);
    assert.equal((await webComments(pageId))[0].is_resolved, false);
    await mcpOk(env, miaAgent.token, 'resolve_comment', { page_id: pageId, comment_id: thread.comment_id });
    const second = await latest('resolve_comment', "Mia's Claude Code");

    await env.api('PUT', `/api/workspace/${owner.workspaceId}/document/${pageId}/inline-comment/resolve`, { comment_id: thread.comment_id, is_resolved: false }, owner.token);
    assert.equal((await undo(second)).status, 409, 'a person reopened it first');
  });

  test('bad input, wrong targets, read-only tokens and other workspaces are refused with clear messages', async () => {
    const pageId = await makePage('Guards', 'Some guarded text.');
    const card = await firstCard();

    assert.match(errorOf(await call(miaAgent.token, 'add_comment', { page_id: pageId, content: 'no quote' })), /quote/i);
    assert.match(errorOf(await call(miaAgent.token, 'add_comment', { page_id: pageId, quote: 'text that is not there', content: 'x' })), /not found in any single paragraph/i);
    assert.match(errorOf(await call(miaAgent.token, 'add_comment', { content: 'nowhere' })), /exactly one of page_id/i);
    assert.match(errorOf(await call(miaAgent.token, 'add_comment', { page_id: pageId, card_id: card.id, content: 'both' })), /exactly one of page_id/i);
    assert.match(errorOf(await call(miaAgent.token, 'add_comment', { page_id: pageId, reply_to: crypto.randomUUID(), content: 'x' })), /not found/i);
    assert.match(errorOf(await call(miaAgent.token, 'add_comment', { page_id: pageId, quote: 'Some', content: '   ' })), /content|at least|required/i);
    assert.match(errorOf(await call(miaAgent.token, 'add_comment', { page_id: pageId, quote: 'Some', content: 'x'.repeat(5001) })), /at most 5000/);
    assert.match(errorOf(await call(miaAgent.token, 'add_comment', { page_id: db.containerId, quote: 'x', content: 'x' })), /document pages/i);
    assert.match(errorOf(await call(miaRead.token, 'add_comment', { page_id: pageId, quote: 'Some', content: 'x' })), /read-only/i);
    assert.match(errorOf(await call(miaRead.token, 'resolve_comment', { page_id: pageId, comment_id: crypto.randomUUID() })), /read-only/i);
    assert.match(errorOf(await call(miaAgent.token, 'resolve_comment', { page_id: pageId, comment_id: crypto.randomUUID() })), /not found/i);
    const theirs = await mintToken(env, outsider, { scope: 'write', name: 'Outsider agent' });

    assert.match(errorOf(await call(theirs.token, 'add_comment', { page_id: pageId, quote: 'Some', content: 'x' })), /not found/i);
    assert.match(errorOf(await call(theirs.token, 'list_comments', { page_id: pageId })), /not found/i);
    assert.match(errorOf(await call(theirs.token, 'add_comment', { card_id: card.id, content: 'x' })), /not found/i);
    assert.equal((await webComments(pageId)).length, 0, 'none of the refused calls left a comment');
  });

  test('a card comment is stored where the web app reads it, replies stay one level deep, and it can be resolved and undone', async () => {
    const card = await firstCard();
    const added = await mcpOk(env, miaAgent.token, 'add_comment', { card_id: card.id, content: 'Is the budget approved?' });
    const stored = await rowComments(card.id);

    assert.equal(stored.length, 1);
    assert.deepEqual(
      [stored[0].id, stored[0].content, stored[0].author_id, stored[0].parent_comment_id, stored[0].is_resolved, stored[0].reactions, stored[0].attachments],
      [added.comment_id, "Via Mia's Claude Code: Is the budget approved?", mia.userId, '', false, '{}', '[]'],
    );
    assert.ok(Number.isInteger(stored[0].created_at) && stored[0].created_at > 1_700_000_000, 'unix seconds like the editor writes');
    const reply = await mcpOk(env, ownerAgent.token, 'add_comment', { card_id: card.id, reply_to: added.comment_id, content: 'Approved.' });
    const nested = await mcpOk(env, miaAgent.token, 'add_comment', { card_id: card.id, reply_to: reply.comment_id, content: 'Thanks!' });
    const all = await rowComments(card.id);

    assert.equal(all.find((comment) => comment.id === nested.comment_id).parent_comment_id, added.comment_id, 'a reply to a reply joins the same thread');
    const listed = await mcpOk(env, miaRead.token, 'list_comments', { card_id: card.id });

    assert.equal(listed.target.type, 'card');
    assert.deepEqual(listed.comments.map((comment) => [comment.parent_id, comment.author]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1].localeCompare(b[1])), [[null, mia.email.split('@')[0]], [added.comment_id, mia.email.split('@')[0]], [added.comment_id, owner.email.split('@')[0]]].sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1].localeCompare(b[1])), 'one thread, two replies (same-second comments have no fixed order)');
    assert.equal((await mcpOk(env, miaRead.token, 'get_card', { card_id: card.id })).card.title, card.title, 'the card itself is unchanged');
    assert.equal((await notifications(mia)).filter((entry) => entry.type === 'comment_reply' && entry.metadata.row_id === card.id).length, 1);
    await mcpOk(env, miaAgent.token, 'resolve_comment', { card_id: card.id, comment_id: added.comment_id });
    assert.equal((await rowComments(card.id)).find((comment) => comment.id === added.comment_id).is_resolved, true);
    assert.equal((await rowComments(card.id)).find((comment) => comment.id === added.comment_id).resolved_by, mia.userId);
    const resolveEntry = await latest('resolve_comment', "Mia's Claude Code");

    assert.equal((await undo(resolveEntry)).status, 200);
    assert.equal((await rowComments(card.id)).find((comment) => comment.id === added.comment_id).is_resolved, false);
    const entries = await trail();
    const threadEntry = entries.find((entry) => entry.tool === 'add_comment' && entry.summary.startsWith('Commented on card'));

    assert.equal((await undo(threadEntry)).status, 409, 'replies exist, so the thread stays');
    const lone = await mcpOk(env, miaAgent.token, 'add_comment', { card_id: card.id, content: 'One more thought.' });
    const loneEntry = await latest('add_comment', "Mia's Claude Code");

    assert.equal((await undo(loneEntry)).status, 200);
    assert.ok(!(await rowComments(card.id)).some((comment) => comment.id === lone.comment_id));
  });

  test('append_to_card_body creates the body when the card has none, appends after it, keeps a restore point and can be undone', async () => {
    const card = (await mcpOk(env, ownerAgent.token, 'list_cards', { database_id: db.databaseId, limit: 2 })).cards[1];
    const before = (await mcpOk(env, ownerAgent.token, 'get_card', { card_id: card.id })).card;

    assert.equal(before.has_body_document, false, 'this card never had a body');
    const first = await mcpOk(env, miaAgent.token, 'append_to_card_body', { card_id: card.id, content: '## Notes\n\n- call the vendor\n- [ ] send the quote' });

    assert.deepEqual([first.card_id, first.blocks, first.restore_point], [card.id, 3, "Before Mia's Claude Code's edit"]);
    const read = (await mcpOk(env, ownerAgent.token, 'get_card', { card_id: card.id })).card;

    assert.equal(read.has_body_document, true);
    assert.equal(read.body, 'Notes\ncall the vendor\nsend the quote');
    assert.equal(read.title, card.title, 'fields and title are unchanged');
    await mcpOk(env, ownerAgent.token, 'append_to_card_body', { card_id: card.id, content: 'Second paragraph.' });
    assert.equal((await mcpOk(env, ownerAgent.token, 'get_card', { card_id: card.id })).card.body, 'Notes\ncall the vendor\nsend the quote\nSecond paragraph.');
    // The body is a normal document: the web app's version history for it holds the restore points.
    const documentId = (await import('../page-document.js')).rowDocumentIdFromRowId(card.id);
    const versions = (await env.api('GET', `/api/workspace/${owner.workspaceId}/collab/${documentId}/history`, undefined, owner.token)).body.data;

    assert.ok(versions.some((version) => version.name === "Before Mia's Claude Code's edit"));
    const entry = await latest('append_to_card_body', "Owen's Claude Code");

    assert.deepEqual([entry.target_type, entry.target_id, entry.can_undo], ['card', card.id, true]);
    assert.equal((await undo(entry)).status, 200, 'undo restores the body from before the second append');
    assert.equal((await mcpOk(env, ownerAgent.token, 'get_card', { card_id: card.id })).card.body, 'Notes\ncall the vendor\nsend the quote');
    const miaEntry = await latest('append_to_card_body', "Mia's Claude Code");

    assert.equal((await undo(miaEntry)).status, 200, 'the body is exactly as it was right after her edit, so her undo applies too');
    assert.equal((await mcpOk(env, ownerAgent.token, 'get_card', { card_id: card.id })).card.body, '', 'back to the empty body she started from');
  });

  test('append_to_card_body refuses bad input, archived cards, read-only tokens and other workspaces', async () => {
    const card = await firstCard();

    assert.match(errorOf(await call(miaRead.token, 'append_to_card_body', { card_id: card.id, content: 'x' })), /read-only/i);
    assert.match(errorOf(await call(miaAgent.token, 'append_to_card_body', { card_id: crypto.randomUUID(), content: 'x' })), /not found/i);
    assert.match(errorOf(await call(miaAgent.token, 'append_to_card_body', { card_id: card.id, content: '' })), /at least 1|required/i);
    assert.match(errorOf(await call(miaAgent.token, 'append_to_card_body', { card_id: card.id, content: 'x'.repeat(50_001) })), /at most 50000/);
    const theirs = await mintToken(env, outsider, { scope: 'write', name: 'Outsider agent' });

    assert.match(errorOf(await call(theirs.token, 'append_to_card_body', { card_id: card.id, content: 'x' })), /not found/i);
    const target = (await mcpOk(env, ownerAgent.token, 'list_cards', { database_id: db.databaseId, limit: 3 })).cards[2];

    await mcpOk(env, ownerAgent.token, 'archive_card', { card_id: target.id, confirm: true });
    assert.match(errorOf(await call(miaAgent.token, 'append_to_card_body', { card_id: target.id, content: 'x' })), /archived/i);
    assert.match(errorOf(await call(miaAgent.token, 'add_comment', { card_id: target.id, content: 'x' })), /archived/i);
  });

  test('the tool list includes the four new tools with the right scopes', async () => {
    const listed = await fetch(`${env.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${miaAgent.token}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = (await listed.json()).result.tools;

    for (const name of ['list_comments', 'add_comment', 'resolve_comment', 'append_to_card_body']) {
      const tool = tools.find((candidate) => candidate.name === name);

      assert.ok(tool, name);
      assert.equal(tool.annotations.readOnlyHint, name === 'list_comments', `${name} read/write annotation`);
    }
    assert.equal(tools.length, 20);
  });
});
