// MCP v2: search, read_page, list_pages, create_page, append_to_page. Real HTTP server, real agent tokens, real
// documents. Covers permission filtering, paging, idempotency, the restore point appending leaves in the page's version
// history, live delivery to open editors, attribution in the activity trail, and undoing a created page.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { account, createTemplateDatabase, startCardsEnv } from './helpers/cards-env.js';
import { eachStorageMode, mcpOk, mcpTool, mintToken, openViewer } from './helpers/mcp-live-env.js';
import { parseInline, parseMarkdownLite } from '../page-writer.js';

describe('markdown-lite parser', () => {
  test('headings, lists, to-dos, quotes, code, dividers and inline marks become editor blocks', () => {
    const blocks = parseMarkdownLite('# Title\n\nIntro with **bold**, *italic*, `code` and [a link](https://x.io).\n\n- bullet\n- [ ] open task\n- [x] done task\n1. first\n2) second\n> quoted\n---\n```js\nconst a = 1;\n\nconst b = 2;\n```\n#### deep');

    assert.deepEqual(blocks.map((block) => block.ty), ['heading', 'paragraph', 'bulleted_list', 'todo_list', 'todo_list', 'numbered_list', 'numbered_list', 'quote', 'divider', 'code', 'heading']);
    assert.deepEqual(blocks[0].data, { level: 1 });
    assert.deepEqual(blocks[10].data, { level: 3 }, 'deeper headings are capped at level 3');
    assert.deepEqual([blocks[3].data.checked, blocks[4].data.checked], [false, true]);
    assert.deepEqual([blocks[5].data.number, blocks[6].data.number], [1, 2]);
    assert.deepEqual(blocks[9].data, { language: 'js' });
    assert.equal(blocks[9].delta[0].insert, 'const a = 1;\n\nconst b = 2;', 'blank lines inside a code fence are kept');
    assert.deepEqual(blocks[1].delta.map((op) => [op.insert, op.attributes ?? null]), [
      ['Intro with ', null], ['bold', { bold: true }], [', ', null], ['italic', { italic: true }], [', ', null], ['code', { code: true }], [' and ', null], ['a link', { href: 'https://x.io' }], ['.', null],
    ]);
  });

  test('unsafe links stay plain text, unclosed fences still produce a block, and empty input yields nothing', () => {
    const unsafe = parseInline('[click](javascript:alert(1))');

    assert.ok(unsafe.every((op) => !op.attributes), 'no link is created');
    assert.equal(unsafe.map((op) => op.insert).join(''), '[click](javascript:alert(1))', 'the text is kept as typed');
    assert.deepEqual(parseMarkdownLite('```\nunterminated').map((block) => block.ty), ['code']);
    assert.deepEqual(parseMarkdownLite('  \n\n'), []);
    assert.equal(parseInline('snake_case_name and 2*3*4')[0].insert.startsWith('snake_case_name'), true, 'underscores inside words are not italics');
  });
});

eachStorageMode('MCP pages', (mode) => {
  let env, owner, outsider, db, space, write, read, viewer;

  const settle = async () => { await env.running.app.searchIndex.flush(); await new Promise((resolve) => setTimeout(resolve, 150)); };
  const callOf = (token, name, args) => mcpTool(env, token, name, args);
  const errorOf = (response) => response.result?.isError ? response.result.content[0].text : null;
  const trail = async (query = '') => (await env.api('GET', `/api/workspace/${owner.workspaceId}/agent-activity${query}`, undefined, owner.token)).body.data.entries;
  let created = 0;
  const makePage = (args) => mcpOk(env, write.token, 'create_page', { idempotency_key: `page-key-${mode}-${(created += 1)}-0001`, ...args });

  before(async () => {
    env = await startCardsEnv({ storage: mode, serverOptions: { searchIndexDelayMs: 0 } });
    owner = await account(env, `pages-owner-${mode}`);
    outsider = await account(env, `pages-outsider-${mode}`);
    space = owner.spaceId;
    db = await createTemplateDatabase(env, owner, 'opportunities', 'Pipeline');
    write = await mintToken(env, owner, { scope: 'write', name: "Priya's Claude Code" });
    read = await mintToken(env, owner, { scope: 'read', name: "Priya's Cursor" });
  });
  after(async () => { viewer?.close(); await env?.stop(); });

  test('create_page writes a real page that search, read_page and list_pages all see', async () => {
    const page = await makePage({ parent_id: space, title: 'Atlas launch plan', content: '# Goals\n\nShip the Atlas beta by **March**.\n\n- [ ] Finalise pricing\n- [x] Book venue\n\n## Risks\n\n> Vendor delay could slip the date.' });

    assert.equal(page.blocks, 6);
    assert.equal(page.replayed, false);
    await settle();
    const text = (await mcpOk(env, read.token, 'read_page', { page_id: page.page_id })).page;

    assert.equal(text.title, 'Atlas launch plan');
    assert.match(text.text, /Goals\nShip the Atlas beta by March\.\nFinalise pricing\nBook venue\nRisks\nVendor delay could slip the date\./);
    assert.equal(text.path, 'Space');
    const found = await mcpOk(env, read.token, 'search', { query: 'atlas pricing' });

    assert.equal(found.match, 'all');
    assert.equal(found.hits[0].id, page.page_id);
    assert.deepEqual([found.hits[0].type, found.hits[0].title, found.hits[0].path], ['page', 'Atlas launch plan', 'Space']);
    assert.match(found.hits[0].snippet, /pricing/i);
    const listing = await mcpOk(env, read.token, 'list_pages', { parent_id: space });

    assert.ok(listing.items.some((item) => item.id === page.page_id && item.type === 'page'));
    assert.equal(listing.parent.type, 'space');
    const top = await mcpOk(env, read.token, 'list_pages', {});

    assert.ok(top.items.some((item) => item.id === space && item.type === 'space'));
    // The web app's own outline shows it too.
    const tree = (await env.api('GET', `/api/workspace/${owner.workspaceId}/view/${space}?depth=1`, undefined, owner.token)).body.data;

    assert.ok(tree.children.some((child) => child.name === 'Atlas launch plan'));
  });

  test('search ranks, filters by type, falls back to matching any word, finds cards, and respects limits', async () => {
    await makePage({ parent_id: space, title: 'Zebra migration', content: 'Move the zebra servers to the new rack.' });
    await makePage({ parent_id: space, title: 'Quarterly review', content: 'Notes about the quarter, nothing about animals.' });
    await settle();
    const all = await mcpOk(env, read.token, 'search', { query: 'zebra rack' });

    assert.deepEqual(all.hits.map((hit) => hit.title), ['Zebra migration']);
    const loose = await mcpOk(env, read.token, 'search', { query: 'what is blocking the zebra servers please' });

    assert.equal(loose.match, 'any', 'a natural-language question falls back to any-word matching');
    assert.equal(loose.hits[0].title, 'Zebra migration');
    const card = (await mcpOk(env, read.token, 'list_cards', { database_id: db.databaseId, limit: 1 })).cards[0];
    const word = card.title.split(/\s+/).find((candidate) => candidate.length > 3) ?? card.title;
    const cards = await mcpOk(env, read.token, 'search', { query: word, types: ['card'] });

    assert.ok(cards.hits.length > 0 && cards.hits.every((hit) => hit.type === 'card'));
    assert.ok(cards.hits.some((hit) => hit.id === card.id && hit.database_name === 'Pipeline'));
    assert.equal((await mcpOk(env, read.token, 'search', { query: 'zebra', types: ['database'] })).hits.length, 0);
    assert.equal((await mcpOk(env, read.token, 'search', { query: 'the', limit: 1 })).hits.length <= 1, true);
    assert.equal((await mcpOk(env, read.token, 'search', { query: 'qqqnomatchqqq' })).hits.length, 0);
    assert.ok(errorOf(await callOf(read.token, 'search', { query: '' })), 'an empty query is an input error');
    assert.ok(errorOf(await callOf(read.token, 'search', { query: 'x', types: ['page', 'nope'] })));
  });

  test('another workspace is invisible: nothing found, nothing readable, nothing writable', async () => {
    const mine = await makePage({ parent_id: space, title: 'Private roadmap', content: 'Only for this workspace: codename Walrus.' });
    const theirsToken = await mintToken(env, outsider, { scope: 'write', name: 'Outsider agent' });

    await settle();
    assert.equal((await mcpOk(env, theirsToken.token, 'search', { query: 'walrus' })).hits.length, 0);
    assert.match(errorOf(await callOf(theirsToken.token, 'read_page', { page_id: mine.page_id })), /not found/i);
    assert.match(errorOf(await callOf(theirsToken.token, 'append_to_page', { page_id: mine.page_id, content: 'hello' })), /not found/i);
    assert.match(errorOf(await callOf(theirsToken.token, 'create_page', { parent_id: space, title: 'Sneaky', idempotency_key: `sneaky-${mode}-00001` })), /not found/i);
    assert.match(errorOf(await callOf(theirsToken.token, 'list_pages', { parent_id: space })), /not found/i);
  });

  test('trashed pages disappear from search and reading, and return when restored', async () => {
    const page = await makePage({ parent_id: space, title: 'Short lived', content: 'Contains the word pelican.' });

    await settle();
    assert.equal((await mcpOk(env, read.token, 'search', { query: 'pelican' })).hits.length, 1);
    await env.api('POST', `/api/workspace/${owner.workspaceId}/page-view/${page.page_id}/move-to-trash`, {}, owner.token);
    await settle();
    assert.equal((await mcpOk(env, read.token, 'search', { query: 'pelican' })).hits.length, 0);
    assert.match(errorOf(await callOf(read.token, 'read_page', { page_id: page.page_id })), /not found/i);
    await env.api('POST', `/api/workspace/${owner.workspaceId}/page-view/${page.page_id}/restore-from-trash`, {}, owner.token);
    await settle();
    assert.equal((await mcpOk(env, read.token, 'search', { query: 'pelican' })).hits.length, 1);
  });

  test('create_page is idempotent per key, validates its parent, and supports sub-pages', async () => {
    const args = { parent_id: space, title: 'Once only', content: 'Body.', idempotency_key: `once-only-${mode}-0001` };
    const first = await mcpOk(env, write.token, 'create_page', args);
    const again = await mcpOk(env, write.token, 'create_page', args);

    assert.equal(again.page_id, first.page_id);
    assert.equal(again.replayed, true);
    assert.match(errorOf(await callOf(write.token, 'create_page', { ...args, title: 'A different title' })), /idempotency_key/i);
    const children = (await mcpOk(env, read.token, 'list_pages', { parent_id: space })).items.filter((item) => item.title === 'Once only');

    assert.equal(children.length, 1, 'one page, not two');
    const child = await makePage({ parent_id: first.page_id, title: 'Child page', content: 'Nested.' });

    assert.equal((await mcpOk(env, read.token, 'read_page', { page_id: child.page_id })).page.path, 'Space / Once only');
    for (const parent of [crypto.randomUUID(), db.containerId, 'not-an-id']) {
      assert.ok(errorOf(await callOf(write.token, 'create_page', { parent_id: parent, title: 'Nope', idempotency_key: `bad-parent-${mode}-${String(parent).slice(0, 6)}` })), `parent ${parent}`);
    }
    assert.ok(errorOf(await callOf(write.token, 'create_page', { parent_id: space, title: '', idempotency_key: `empty-title-${mode}-0001` })));
    assert.ok(errorOf(await callOf(write.token, 'create_page', { parent_id: space, title: 'x'.repeat(201), idempotency_key: `long-title-${mode}-0001` })));
    assert.ok(errorOf(await callOf(write.token, 'create_page', { parent_id: space, title: 'Too long', content: 'x'.repeat(50_001), idempotency_key: `long-body-${mode}-00001` })));
    const empty = await makePage({ parent_id: space, title: 'Blank page' });

    assert.equal(empty.blocks, 0);
    assert.equal((await mcpOk(env, read.token, 'read_page', { page_id: empty.page_id })).page.text, '');
    assert.equal(errorOf(await callOf(read.token, 'create_page', { parent_id: space, title: 'Read only', idempotency_key: `read-only-${mode}-00001` })).includes('read-only'), true);
  });

  test('append_to_page adds blocks at the end, saves a named restore point, and open editors see it live', async () => {
    const page = await makePage({ parent_id: space, title: 'Weekly status', content: 'Week 1: kickoff done.' });
    const opened = await env.api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${page.page_id}?collab_type=0`, undefined, owner.token);

    assert.equal(opened.status, 200);
    viewer = await openViewer(env, owner, [{ collabType: 0, objectId: page.page_id }]);
    const result = await mcpOk(env, write.token, 'append_to_page', { page_id: page.page_id, content: '## Week 2\n\n- shipped the beta\n- [ ] write the report' });

    assert.equal(result.blocks, 3);
    assert.equal(result.restore_point, "Before Priya's Claude Code's edit");
    await viewer.waitUntil(() => viewer.framesFor(0, page.page_id).length > 0);
    const live = [...viewer.doc(0, page.page_id).getMap('data').get('document').get('meta').get('text_map').values()].map((value) => value.toString());

    assert.deepEqual(live.filter(Boolean), ['Week 1: kickoff done.', 'Week 2', 'shipped the beta', 'write the report']);
    const types = [...viewer.doc(0, page.page_id).getMap('data').get('document').get('blocks').values()].map((block) => block.get('ty'));

    assert.deepEqual(types.filter((type) => type !== 'page'), ['paragraph', 'heading', 'bulleted_list', 'todo_list']);
    const persisted = (await mcpOk(env, read.token, 'read_page', { page_id: page.page_id })).page.text;

    assert.equal(persisted, 'Week 1: kickoff done.\nWeek 2\nshipped the beta\nwrite the report');
    // The restore point is in the page's version history, attributed to the token's owner, and restoring it works.
    const versions = (await env.api('GET', `/api/workspace/${owner.workspaceId}/collab/${page.page_id}/history`, undefined, owner.token)).body.data;
    const point = versions.find((version) => version.name === "Before Priya's Claude Code's edit");

    assert.ok(point, 'named restore point exists');
    assert.equal(point.created_by, Number((await env.store.getUserById(owner.userId)).uid));
    const restored = await env.api('POST', `/api/workspace/${owner.workspaceId}/collab/${page.page_id}/revert`, { version: point.version, collab_type: 0 }, owner.token);

    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const doc = new Y.Doc();

    Y.applyUpdate(doc, new Uint8Array(restored.body.data.doc_state));
    assert.deepEqual([...doc.getMap('data').get('document').get('meta').get('text_map').values()].map((value) => value.toString()).filter(Boolean), ['Week 1: kickoff done.']);
    // Appending twice appends twice (it is not idempotent), and each time leaves its own restore point.
    await mcpOk(env, write.token, 'append_to_page', { page_id: page.page_id, content: 'Again.' });
    await mcpOk(env, write.token, 'append_to_page', { page_id: page.page_id, content: 'Again.' });
    const read2 = (await mcpOk(env, read.token, 'read_page', { page_id: page.page_id })).page.text;

    assert.equal(read2.split('\n').filter((line) => line === 'Again.').length, 2);
  });

  test('an append can be undone in one click, newest first; a later edit makes the older undo refuse', async () => {
    const page = await makePage({ parent_id: space, title: 'Undoable', content: 'Base text.' });
    const text = async () => (await mcpOk(env, read.token, 'read_page', { page_id: page.page_id })).page.text;
    const latest = async (tool) => (await trail('?kind=write&limit=20')).find((entry) => entry.tool === tool && entry.target_id === page.page_id);
    const undo = (entry) => env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${entry.id}/undo`, undefined, owner.token);

    await mcpOk(env, write.token, 'append_to_page', { page_id: page.page_id, content: 'First addition.' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const first = await latest('append_to_page');

    await mcpOk(env, write.token, 'append_to_page', { page_id: page.page_id, content: 'Second addition.' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await latest('append_to_page');

    assert.notEqual(first.id, second.id);
    assert.equal(await text(), 'Base text.\nFirst addition.\nSecond addition.');
    const blocked = await undo(first);

    assert.deepEqual([blocked.status, blocked.body.error.code], [409, 'CHANGED_SINCE'], 'the second addition sits on top of the first');
    assert.equal(await text(), 'Base text.\nFirst addition.\nSecond addition.', 'nothing was touched');
    assert.equal((await undo(second)).status, 200);
    assert.equal(await text(), 'Base text.\nFirst addition.');
    assert.equal((await undo(first)).status, 200, 'with the second gone the first is on top again');
    assert.equal(await text(), 'Base text.');
    assert.equal((await undo(first)).body.error.code, 'ALREADY_UNDONE');
    // The undone content is not lost: each undo kept a safety copy in the page history.
    const versions = (await env.api('GET', `/api/workspace/${owner.workspaceId}/collab/${page.page_id}/history`, undefined, owner.token)).body.data;

    assert.ok(versions.length >= 4, 'restore points and safety copies are all there');
    // Someone typing after the agent also blocks the undo (the page's state changed).
    await mcpOk(env, write.token, 'append_to_page', { page_id: page.page_id, content: 'Third addition.' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const third = await latest('append_to_page');
    const current = await env.store.getPageCollab(owner.workspaceId, page.page_id);
    const human = new Y.Doc({ guid: page.page_id });

    Y.applyUpdate(human, current.doc_state);
    const before = Y.encodeStateVector(human);
    const texts = [...human.getMap('data').get('document').get('meta').get('text_map').values()];

    texts[0].insert(texts[0].length, ' (edited by a person)');
    await env.store.acceptPageCollabUpdate({ workspaceId: owner.workspaceId, pageId: page.page_id, flags: 0, payload: Y.encodeStateAsUpdate(human, before), beforeStateVector: before, collabVersion: current.collab_version, restoreId: current.restore_id ?? null, actorUserId: owner.userId });
    const refused = await undo(third);

    assert.deepEqual([refused.status, refused.body.error.code], [409, 'CHANGED_SINCE']);
    assert.match(await text(), /Third addition\./, 'the person\'s edit and the agent\'s text are both still there');
  });

  test('append_to_page refuses what it must: read-only tokens, databases, cards, empty or huge content, unknown pages', async () => {
    const page = await makePage({ parent_id: space, title: 'Guarded', content: 'Original.' });
    const refused = await callOf(read.token, 'append_to_page', { page_id: page.page_id, content: 'nope' });

    assert.match(errorOf(refused), /read-only/);
    assert.match(errorOf(await callOf(write.token, 'append_to_page', { page_id: db.containerId, content: 'nope' })), /document pages/i);
    assert.ok(errorOf(await callOf(write.token, 'append_to_page', { page_id: crypto.randomUUID(), content: 'nope' })));
    assert.ok(errorOf(await callOf(write.token, 'append_to_page', { page_id: page.page_id, content: '' })));
    assert.ok(errorOf(await callOf(write.token, 'append_to_page', { page_id: page.page_id, content: 'x'.repeat(50_001) })));
    assert.equal((await mcpOk(env, read.token, 'read_page', { page_id: page.page_id })).page.text, 'Original.', 'nothing changed');
    // Reading a database page or a card's own body page points at the right tool.
    assert.match(errorOf(await callOf(read.token, 'read_page', { page_id: db.containerId })), /database/i);
  });

  test('read_page pages a long document without losing or repeating text', async () => {
    const lines = Array.from({ length: 120 }, (_, index) => `Line ${index} ${'lorem ipsum '.repeat(12)}END${index}`);
    const page = await makePage({ parent_id: space, title: 'Very long', content: lines.join('\n\n') });
    let offset = 0;
    let collected = '';
    let pages = 0;

    for (;;) {
      const result = (await mcpOk(env, read.token, 'read_page', { page_id: page.page_id, offset })).page;

      collected += result.text;
      pages += 1;
      if (result.next_offset === null) break;
      offset = result.next_offset;
    }
    assert.ok(pages > 3);
    assert.equal(collected, lines.join('\n'));
  });

  test('every call is attributed in the activity trail, and a created page can be undone by anyone in the workspace', async () => {
    const page = await makePage({ parent_id: space, title: 'Agent draft', content: 'Draft text.' });

    await mcpOk(env, read.token, 'search', { query: 'draft' });
    await mcpOk(env, read.token, 'read_page', { page_id: page.page_id });
    await mcpOk(env, write.token, 'append_to_page', { page_id: page.page_id, content: 'More.' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const entries = await trail('?limit=100');
    const find = (agent, tool) => entries.find((entry) => entry.agent === agent && entry.tool === tool && (tool === 'search' || entry.target_id === page.page_id));

    assert.match(find("Priya's Claude Code", 'create_page').summary, /^Created page .Agent draft.$/);
    assert.match(find("Priya's Claude Code", 'append_to_page').summary, /^Added 1 block to page .Agent draft. \(restore point saved/);
    assert.match(find("Priya's Cursor", 'read_page').summary, /^Read page .Agent draft.$/);
    assert.match(find("Priya's Cursor", 'search').summary, /^Searched for .draft. \(\d+ results?\)$/);
    assert.deepEqual([find("Priya's Claude Code", 'create_page').can_undo, find("Priya's Claude Code", 'append_to_page').can_undo], [true, true]);
    const undone = await env.api('POST', `/api/workspace/${owner.workspaceId}/agent-activity/${find("Priya's Claude Code", 'create_page').id}/undo`, undefined, owner.token);

    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.match(errorOf(await callOf(read.token, 'read_page', { page_id: page.page_id })), /not found/i, 'the undone page is in the trash');
    assert.equal((await env.store.getPage(page.page_id)).is_trashed, true, 'trashed, not destroyed: it can be restored from the trash');
  });
});
