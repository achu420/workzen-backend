// The editor writer stream, database row summarize/translate, model selection, abort handling,
// and persisted AI chat (settings, messages, pager, answer stream, related questions).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { KEYS, startFakeAiProvider } from './helpers/fake-ai-provider.js';
import { account, addMember, configureAi, createApi, rawStream } from './helpers/ai-test-env.js';

let fake, dir, running, base, api;

before(async () => {
  fake = await startFakeAiProvider();
  dir = await mkdtemp(path.join(os.tmpdir(), 'ai-writer-chat-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key', aiProviderBaseUrls: fake.baseUrls });
  base = `http://127.0.0.1:${running.address.port}`;
  api = createApi(() => base);
});
after(async () => {
  running.server.closeAllConnections?.();
  await new Promise((resolve) => running.server.close(resolve));
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

async function configuredOwner(label, provider = 'openai', extra = { model: 'gpt-4o-test' }) {
  const owner = await account(api, label);

  await configureAi(api, owner, provider, extra);
  return owner;
}

const writerUrl = (owner) => `/api/ai/${owner.workspaceId}/v2/complete/stream`;
const systemOf = (request) => request.body.system ?? request.body.messages.find((m) => m.role === 'system')?.content ?? '';
const lastUserOf = (request) => [...request.body.messages].reverse().find((m) => m.role === 'user').content;

test('each completion type streams upstream-style frames with its own prompt', async () => {
  const owner = await configuredOwner('aiw-types');
  const expectations = [
    [1, /Improve the clarity/], [2, /Fix spelling, grammar and punctuation only/], [3, /half its length/], [4, /twice its length/],
    [5, /Continue the text naturally/], [6, /Explain the text simply/], [7, /helpful assistant inside a note-taking/],
  ];

  for (const [type, pattern] of expectations) {
    const result = await rawStream(base, writerUrl(owner), { text: 'hello there friend', completion_type: type, format: { output_content: 0, output_layout: 0 }, metadata: { object_id: 'v', workspace_id: owner.workspaceId, rag_ids: ['v'], completion_history: [] } }, owner.token, { 'ai-model': 'Auto', 'x-platform': 'web-app' });

    assert.equal(result.status, 200, `type ${type}`);
    assert.match(result.headers.get('content-type'), /text\/event-stream/);
    assert.ok(result.frames.length > 1, 'text arrives as several frames, not one block');
    assert.ok(result.frames.every((frame) => Object.keys(frame).join() === '1' && typeof frame['1'] === 'string'));
    assert.equal(result.joined, 'echo: hello there friend');
    const request = fake.lastChat();

    assert.match(systemOf(request), pattern, `type ${type} prompt`);
    assert.equal(lastUserOf(request), 'hello there friend', 'user text stays in the user turn');
    assert.equal(request.body.model, 'gpt-4o-test');
    assert.equal(request.body.stream, true);
  }
  const custom = await rawStream(base, writerUrl(owner), { text: 'make a haiku', completion_type: 8, metadata: { custom_prompt: { system: 'Pirate mode only.' } } }, owner.token);

  assert.equal(custom.status, 200);
  assert.equal(systemOf(fake.lastChat()), 'Pirate mode only.');
});

test('completion history becomes earlier turns, and Anthropic gets a top-level system prompt', async () => {
  const owner = await configuredOwner('aiw-history', 'anthropic', { model: 'claude-test-1' });
  const result = await rawStream(base, writerUrl(owner), {
    text: 'shorter please', completion_type: 3,
    metadata: { completion_history: [{ role: 'human', content: 'first ask' }, { role: 'ai', content: 'first answer' }, { role: 'bogus', content: 5 }] },
  }, owner.token);

  assert.equal(result.status, 200);
  const request = fake.lastChat();

  assert.equal(request.path, '/v1/messages');
  assert.match(request.body.system, /half its length/);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'first ask' }, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'shorter please' }]);
  assert.ok(request.body.max_tokens > 0);

  const router = await configuredOwner('aiw-router', 'openrouter', { model: 'openai/gpt-test' });

  assert.equal((await rawStream(base, writerUrl(router), { text: 'via router', completion_type: 7, metadata: {} }, router.token)).joined, 'echo: via router');
  assert.equal(fake.lastChat().path, '/api/v1/chat/completions');
});

test('the ai-model header picks the model: Auto means the workspace default, others must be enabled', async () => {
  const owner = await configuredOwner('aiw-model', 'openai', { model: 'gpt-4o-test', enabled_models: ['gpt-4o-test', 'o3-mini'] });
  const call = (header) => rawStream(base, writerUrl(owner), { text: 'hi', completion_type: 7, metadata: {} }, owner.token, header === undefined ? {} : { 'ai-model': header });

  for (const header of [undefined, 'Auto', 'auto', 'Default']) {
    assert.equal((await call(header)).status, 200);
    assert.equal(fake.lastChat().body.model, 'gpt-4o-test', `header ${header}`);
  }
  assert.equal((await call('o3-mini')).status, 200);
  assert.equal(fake.lastChat().body.model, 'o3-mini');
  const refused = await call('gpt-3.5-turbo');

  assert.equal(refused.status, 400);
  assert.match(refused.frames[0].message, /not enabled/i);

  // Without an allow-list the model must be one the provider lists; with no default there is nothing for Auto to use.
  const open = await configuredOwner('aiw-open', 'openai', {});
  const openCall = (header) => rawStream(base, writerUrl(open), { text: 'hi', completion_type: 7, metadata: {} }, open.token, { 'ai-model': header });

  assert.match((await openCall('Auto')).frames[0].message, /No default model/);
  assert.equal((await openCall('gpt-4o-test')).status, 200);
  assert.equal((await openCall('made-up-model')).status, 400);
});

test('provider failures arrive as HTTP errors before output and as an error frame after output', async () => {
  const owner = await configuredOwner('aiw-errors');
  const send = (text, extra = {}) => rawStream(base, writerUrl(owner), { text, completion_type: 7, metadata: {}, ...extra }, owner.token);

  const credits = await send('[[error402]]');

  assert.equal(credits.status, 402);
  assert.equal(credits.frames[0].code, 402);
  assert.match(credits.frames[0].message, /insufficient credits/i);
  const limited = await send('[[error429]]');

  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '3');
  assert.equal((await send('[[context]]')).status, 400);
  assert.match((await send('[[context]]')).frames[0].message, /too long/i);
  assert.equal((await send('[[error500]]')).status, 503);
  assert.equal((await send('[[empty]]')).status, 502, 'a stream with no text is an error, not an empty success');

  const mid = await send('[[midstream]]');

  assert.equal(mid.status, 200);
  assert.deepEqual(mid.frames.slice(0, 2), [{ 1: 'part' }, { 1: 'ial' }]);
  assert.equal(mid.frames.at(-1).code, 429);
  assert.match(mid.frames.at(-1).message, /rate limiting/i);

  const wrongKey = await configuredOwner('aiw-wrongkey');
  await api('PUT', `/api/workspace/${wrongKey.workspaceId}/ai-settings`, { provider: 'openai', api_key: 'sk-not-valid', model: 'gpt-4o-test' }, wrongKey.token);
  const rejected = await rawStream(base, writerUrl(wrongKey), { text: 'hi', completion_type: 7, metadata: {} }, wrongKey.token);

  assert.equal(rejected.status, 400);
  assert.match(rejected.frames[0].message, /rejected the API key/i);
  assert.ok(!rejected.text.includes('sk-not-valid'));
});

test('writer requests are validated, size-capped and only open to members', async () => {
  const owner = await configuredOwner('aiw-valid');
  const outsider = await account(api, 'aiw-outsider');
  const post = (payload, token = owner.token) => rawStream(base, writerUrl(owner), payload, token);

  assert.equal((await post({ completion_type: 7 })).status, 400);
  assert.equal((await post({ text: 5, completion_type: 7 })).status, 400);
  for (const type of [0, 9, '7', 1.5, null]) assert.equal((await post({ text: 'x', completion_type: type })).status, 400, String(type));
  assert.equal((await post({ text: 'x'.repeat(100_001), completion_type: 7 })).status, 400);
  assert.equal((await post({ text: 'x', completion_type: 7, metadata: {} }, outsider.token)).status, 403);
  const huge = await fetch(`${base}${writerUrl(owner)}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ text: 'x', completion_type: 7, metadata: { pad: 'y'.repeat(1_100_000) } }) });

  assert.equal(huge.status, 413);
  assert.equal((await fetch(`${base}${writerUrl(owner)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});

test('closing the connection aborts the upstream request', async () => {
  const owner = await configuredOwner('aiw-abort');
  const before = fake.state.aborted;
  const controller = new AbortController();
  const response = await fetch(`${base}${writerUrl(owner)}`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ text: '[[slow]]', completion_type: 7, metadata: {} }) });
  const reader = response.body.getReader();

  assert.match(new TextDecoder().decode((await reader.read()).value), /slow-start/);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 60 && fake.state.aborted === before; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fake.state.aborted, before + 1);
});

test('row summarize and translate are non-streaming and validated', async () => {
  const owner = await configuredOwner('aiw-rows');
  const summary = await api('POST', `/api/ai/${owner.workspaceId}/summarize_row`, { workspace_id: owner.workspaceId, data: { Content: { Name: 'Ship search', Status: 'Doing' } } }, owner.token);

  assert.equal(summary.status, 200);
  assert.equal(summary.body.code, 0);
  assert.match(summary.body.data.text, /^Summary of \{"Name":"Ship search"/);
  assert.match(systemOf(fake.lastChat()), /Summarize it in one or two sentences/);
  assert.deepEqual(JSON.parse(lastUserOf(fake.lastChat())), { Name: 'Ship search', Status: 'Doing' });

  const translated = await api('POST', `/api/ai/${owner.workspaceId}/translate_row`, { workspace_id: owner.workspaceId, data: { cells: [{ title: 'Name', content: 'Hello' }, { title: 'Note', content: 'World' }], language: 'French', include_header: false } }, owner.token);

  assert.deepEqual(translated.body.data.items, [{ title: 'Name', content: 'T:Hello' }, { title: 'Note', content: 'T:World' }]);
  assert.match(systemOf(fake.lastChat()), /into French/);
  assert.deepEqual(JSON.parse(lastUserOf(fake.lastChat())), ['Hello', 'World']);
  const withHeader = await api('POST', `/api/ai/${owner.workspaceId}/translate_row`, { data: { cells: [{ title: 'Name', content: 'Hello' }], language: 'German', include_header: true } }, owner.token);

  assert.deepEqual(JSON.parse(lastUserOf(fake.lastChat())), ['Name: Hello']);
  assert.equal(withHeader.body.data.items[0].content, 'T:Name: Hello');

  const bad = [
    ['summarize_row', {}], ['summarize_row', { data: { Content: { a: 5 } } }], ['summarize_row', { data: { Content: ['x'] } }],
    ['translate_row', { data: { cells: [], language: 'French' } }], ['translate_row', { data: { cells: [{ title: 'a' }], language: 'French' } }],
    ['translate_row', { data: { cells: [{ title: 'a', content: 'b' }] } }],
  ];

  for (const [route, payload] of bad) assert.equal((await api('POST', `/api/ai/${owner.workspaceId}/${route}`, payload, owner.token)).status, 400, `${route} ${JSON.stringify(payload)}`);
  assert.equal((await api('POST', `/api/ai/${owner.workspaceId}/summarize_row`, { data: { Content: { a: '[[error402]]' } } }, owner.token)).status, 402);
});

// ------------------------------------------------------------------ chat
const chatId = () => crypto.randomUUID();
const chatUrl = (owner, id, sub = '') => `/api/chat/${owner.workspaceId}/${id}${sub}`;

async function ask(owner, id, content, headers = {}) {
  const question = (await api('POST', chatUrl(owner, id, '/message/question'), { content, message_type: 1 }, owner.token)).body.data;
  const stream = await rawStream(base, chatUrl(owner, id, '/answer/stream'), { question_id: question.message_id, format: { output_layout: 0, output_content: 0 }, chat_id: id }, owner.token, { 'ai-model': 'Auto', ...headers });
  const answer = (await api('POST', chatUrl(owner, id, '/message/answer'), { question_message_id: question.message_id, content: stream.joined, meta_data: [] }, owner.token)).body.data;

  return { question, stream, answer };
}

test('chat settings default, upsert, merge metadata, and stay inside their workspace', async () => {
  const owner = await configuredOwner('aic-settings');
  const other = await configuredOwner('aic-other');
  const id = chatId();

  assert.deepEqual((await api('GET', chatUrl(owner, id, '/settings'), undefined, owner.token)).body.data, { name: '', rag_ids: [], metadata: {}, full_workspace: false, web_search_enabled: false });
  assert.equal((await api('POST', chatUrl(owner, id, '/settings'), { name: 'Roadmap', rag_ids: [id], metadata: { ai_model: 'gpt-4o-test', initial_prompt: 'p' }, web_search_enabled: true }, owner.token)).body.code, 0);
  await api('POST', chatUrl(owner, id, '/settings'), { metadata: { extra: 1 }, full_workspace: true }, owner.token);
  assert.deepEqual((await api('GET', chatUrl(owner, id, '/settings'), undefined, owner.token)).body.data, {
    name: 'Roadmap', rag_ids: [id], metadata: { ai_model: 'gpt-4o-test', initial_prompt: 'p', extra: 1 }, full_workspace: true, web_search_enabled: true,
  });

  for (const bad of [{ name: 5 }, { rag_ids: 'x' }, { metadata: [] }, { full_workspace: 'yes' }, { name: 'n'.repeat(501) }]) assert.equal((await api('POST', chatUrl(owner, id, '/settings'), bad, owner.token)).status, 400, JSON.stringify(bad));
  assert.equal((await api('GET', `/api/chat/${owner.workspaceId}/not-a-uuid/settings`, undefined, owner.token)).status, 400);

  // The same chat id in another workspace is invisible and cannot be written.
  assert.equal((await api('POST', `/api/chat/${other.workspaceId}/${id}/settings`, { name: 'hijack' }, other.token)).status, 404);
  assert.equal((await api('GET', `/api/chat/${other.workspaceId}/${id}/settings`, undefined, other.token)).status, 404);
  assert.equal((await api('GET', `/api/chat/${owner.workspaceId}/${id}/settings`, undefined, other.token)).status, 403);
  assert.equal((await api('GET', chatUrl(owner, id, '/message'), undefined, other.token)).status, 403);
  assert.equal((await api('GET', chatUrl(owner, id, '/settings'), undefined, owner.token)).body.data.name, 'Roadmap');
});

test('a chat round trip persists questions and answers with linked ids and uses the history', async () => {
  const owner = await configuredOwner('aic-flow');
  const id = chatId();

  await api('POST', chatUrl(owner, id, '/settings'), { name: 'Chat', rag_ids: [id] }, owner.token);
  const first = await ask(owner, id, 'What is AppFlowy?');

  assert.equal(first.stream.status, 200);
  assert.equal(first.stream.joined, 'echo: What is AppFlowy?');
  assert.ok(Number.isInteger(first.question.message_id) && first.question.reply_message_id > first.question.message_id);
  assert.deepEqual(first.question.author, { author_type: 1, author_uuid: first.question.author.author_uuid });
  assert.equal(first.answer.message_id, first.question.reply_message_id);
  assert.equal(first.answer.reply_message_id, first.question.message_id);
  assert.equal(first.answer.author.author_type, 3);
  assert.equal(first.answer.content, 'echo: What is AppFlowy?');
  assert.match(systemOf(fake.lastChat()), /AI assistant of a company workspace/);

  const second = await ask(owner, id, 'And its licence?');

  assert.deepEqual(fake.lastChat().body.messages.filter((m) => m.role !== 'system'), [
    { role: 'user', content: 'What is AppFlowy?' }, { role: 'assistant', content: 'echo: What is AppFlowy?' }, { role: 'user', content: 'And its licence?' },
  ]);
  assert.ok(second.question.message_id > first.answer.message_id, 'ids only grow');

  // Regenerating answers the same question again without feeding back the old answer.
  const again = await rawStream(base, chatUrl(owner, id, '/answer/stream'), { question_id: second.question.message_id }, owner.token, { 'ai-model': 'Auto' });

  assert.equal(again.status, 200);
  assert.equal(fake.lastChat().body.messages.at(-1).content, 'And its licence?');
  assert.equal(fake.lastChat().body.messages.filter((m) => m.role === 'assistant').length, 1);
  const saved = await api('POST', chatUrl(owner, id, '/message/answer'), { question_message_id: second.question.message_id, content: 'regenerated', meta_data: [{ id: 'p', name: 'Page', source: 'appflowy' }] }, owner.token);

  assert.equal(saved.body.data.message_id, second.answer.message_id, 'the answer slot is reused, not duplicated');
  const listing = (await api('GET', chatUrl(owner, id, '/message'), undefined, owner.token)).body.data;

  assert.equal(listing.total, 4);
  assert.equal(listing.messages[0].content, 'regenerated');
  assert.deepEqual(listing.messages[0].meta_data, [{ id: 'p', name: 'Page', source: 'appflowy' }]);
});

test('messages come newest first and page with before/after/offset', async () => {
  const owner = await configuredOwner('aic-pager');
  const id = chatId();

  for (let i = 1; i <= 5; i += 1) await ask(owner, id, `question ${i}`);
  const page = (query) => api('GET', chatUrl(owner, id, `/message${query}`), undefined, owner.token).then((r) => r.body.data);

  const first = await page('?limit=4');

  assert.deepEqual(first.messages.map((m) => m.content), ['echo: question 5', 'question 5', 'echo: question 4', 'question 4']);
  assert.equal(first.has_more, true);
  assert.equal(first.total, 10);
  const oldest = first.messages.at(-1).message_id;
  const older = await page(`?limit=4&before=${oldest}`);

  assert.deepEqual(older.messages.map((m) => m.content), ['echo: question 3', 'question 3', 'echo: question 2', 'question 2']);
  assert.equal(older.has_more, true);
  const last = await page(`?limit=4&before=${older.messages.at(-1).message_id}`);

  assert.deepEqual(last.messages.map((m) => m.content), ['echo: question 1', 'question 1']);
  assert.equal(last.has_more, false);
  const newer = await page(`?limit=3&after=${older.messages[0].message_id}`);

  assert.equal(newer.messages.length, 3);
  assert.deepEqual(newer.messages.map((m) => m.message_id), [...newer.messages.map((m) => m.message_id)].sort((a, b) => b - a), 'still newest first');
  assert.ok(newer.messages.every((m) => m.message_id > older.messages[0].message_id));
  assert.deepEqual((await page('?limit=2&offset=2')).messages.map((m) => m.content), ['echo: question 4', 'question 4']);
  assert.equal((await page('')).messages.length, 10, 'default page covers a short chat');
  assert.deepEqual((await api('GET', chatUrl(owner, chatId(), '/message'), undefined, owner.token)).body.data, { messages: [], has_more: false, total: 0 });
});

test('long histories are trimmed from the oldest end and the model comes from the header or chat settings', async () => {
  const owner = await configuredOwner('aic-budget', 'openai', { model: 'gpt-4o-test', enabled_models: ['gpt-4o-test', 'o3-mini'] });
  const id = chatId();

  for (let i = 1; i <= 4; i += 1) await ask(owner, id, `${'x'.repeat(9000)} turn-${i}`);
  await ask(owner, id, 'final question');
  const sent = fake.lastChat().body.messages.filter((m) => m.role !== 'system');
  const chars = sent.reduce((sum, m) => sum + m.content.length, 0);

  assert.ok(chars <= 24_000 + 100, `history stays near the 24k budget, was ${chars}`);
  assert.equal(sent.at(-1).content, 'final question');
  assert.ok(!sent.some((m) => m.content.includes('turn-1')), 'the oldest turn was dropped');

  await api('POST', chatUrl(owner, id, '/settings'), { metadata: { ai_model: 'o3-mini' } }, owner.token);
  await ask(owner, id, 'which model?');
  assert.equal(fake.lastChat().body.model, 'o3-mini', 'Auto falls back to the model stored in chat settings');
  await ask(owner, id, 'explicit', { 'ai-model': 'gpt-4o-test' });
  assert.equal(fake.lastChat().body.model, 'gpt-4o-test');
});

test('rag_ids never cause an error, and unknown or foreign questions are rejected', async () => {
  const owner = await configuredOwner('aic-rag');
  const id = chatId();

  await api('POST', chatUrl(owner, id, '/settings'), { rag_ids: [crypto.randomUUID(), crypto.randomUUID()], full_workspace: true }, owner.token);
  assert.equal((await ask(owner, id, 'use my pages')).stream.status, 200);

  const unknown = await rawStream(base, chatUrl(owner, id, '/answer/stream'), { question_id: 999999 }, owner.token);

  assert.equal(unknown.status, 404);
  assert.equal((await rawStream(base, chatUrl(owner, id, '/answer/stream'), {}, owner.token)).status, 400);
  const answerId = (await api('GET', chatUrl(owner, id, '/message?limit=1'), undefined, owner.token)).body.data.messages[0].message_id;

  assert.equal((await rawStream(base, chatUrl(owner, id, '/answer/stream'), { question_id: answerId }, owner.token)).status, 404, 'an answer is not a question');
  assert.equal((await api('POST', chatUrl(owner, id, '/message/answer'), { question_message_id: 999999, content: 'x' }, owner.token)).status, 404);
  assert.equal((await api('POST', chatUrl(owner, id, '/message/answer'), { question_message_id: 'a', content: 'x' }, owner.token)).status, 400);
  for (const content of ['', '   ', 5, 'q'.repeat(32_001)]) assert.equal((await api('POST', chatUrl(owner, id, '/message/question'), { content }, owner.token)).status, 400, String(content).slice(0, 10));

  const member = await account(api, 'aic-rag-member');

  await addMember(api, owner, member);
  const asMember = { ...member, workspaceId: owner.workspaceId };

  assert.equal((await ask(asMember, id, 'a teammate asks')).stream.status, 200, 'members share workspace chats');
});

test('related questions come back as up to three items, and an AI failure just yields none', async () => {
  const owner = await configuredOwner('aic-related');
  const id = chatId();
  const { question } = await ask(owner, id, 'Tell me about notes');
  const related = await api('GET', chatUrl(owner, id, `/${question.message_id}/related_question`), undefined, owner.token);

  assert.equal(related.status, 200);
  assert.deepEqual(related.body.data, { message_id: String(question.message_id), items: [{ content: 'First follow-up?' }, { content: 'Second follow-up?' }, { content: 'Third follow-up?' }] });
  assert.match(systemOf(fake.lastChat()), /follow-up questions/);
  assert.equal((await api('GET', chatUrl(owner, id, '/999999/related_question'), undefined, owner.token)).status, 404);

  const failing = await configuredOwner('aic-related-fail');
  const failId = chatId();
  const { question: failQuestion } = await ask(failing, failId, 'hello');

  await api('PUT', `/api/workspace/${failing.workspaceId}/ai-settings`, { provider: 'openai', api_key: 'sk-revoked' }, failing.token);
  const empty = await api('GET', chatUrl(failing, failId, `/${failQuestion.message_id}/related_question`), undefined, failing.token);

  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.items, []);
});

test('chat and AI calls without a key explain how to fix it', async () => {
  const owner = await account(api, 'aic-nokey');
  const id = chatId();
  const question = (await api('POST', chatUrl(owner, id, '/message/question'), { content: 'hello' }, owner.token)).body.data;
  const stream = await rawStream(base, chatUrl(owner, id, '/answer/stream'), { question_id: question.message_id }, owner.token);

  assert.equal(stream.status, 400);
  assert.match(stream.frames[0].message, /AI is not configured/);
});

test('a chat is removed when its page is permanently deleted', async () => {
  const owner = await configuredOwner('aic-cleanup');
  const spaceId = crypto.randomUUID();

  await api('POST', `/api/workspace/${owner.workspaceId}/spaces`, {
    name: 'Space', view_id: spaceId,
    permission: { visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null, invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false, security: { disable_guests: false, disable_public_links: false, disable_export: false } },
  }, owner.token);
  const pageId = crypto.randomUUID();

  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, { schema_version: 'v1', request_id: crypto.randomUUID(), parent_view_id: spaceId, name: 'Chat page', position: { kind: 'start' }, view_id: pageId }, owner.token)).status, 200);
  await ask(owner, pageId, 'remember me');
  assert.equal((await running.app.store.getAiChat(pageId)).workspace_id, owner.workspaceId);

  assert.equal(await running.app.store.deletePagePermanently(pageId, owner.workspaceId), true);
  assert.equal(await running.app.store.getAiChat(pageId), null);
  assert.equal(running.app.store.state.aiChatMessages?.[pageId], undefined);
  assert.equal((await api('GET', chatUrl(owner, pageId, '/message'), undefined, owner.token)).body.data.total, 0);
  assert.ok(KEYS.openai);
});

test('an AI chat page is created through the generic page-view route and is readable by its owner', async () => {
  const owner = await configuredOwner('aiw-chat-page');
  const spaceId = crypto.randomUUID();
  const permission = {
    visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
    invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
    security: { disable_guests: false, disable_public_links: false, disable_export: false },
  };

  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/spaces`, { name: 'Space', view_id: spaceId, permission }, owner.token)).status, 200);
  const url = `/api/workspace/${owner.workspaceId}/page-view`;

  const created = await api('POST', url, { parent_view_id: spaceId, layout: 4, name: 'Untitled' }, owner.token);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const chatId = created.body.data.view_id;

  const outline = await api('GET', `/api/workspace/${owner.workspaceId}/view/${owner.workspaceId}?depth=3`, undefined, owner.token);
  const node = outline.body.data.children.find((space) => space.view_id === spaceId).children.find((page) => page.view_id === chatId);
  assert.equal(node.layout, 4);
  assert.equal(node.name, 'Untitled');

  const permissionResponse = await api('GET', `/api/workspace/${owner.workspaceId}/collab/${chatId}/permission?collab_type=0`, undefined, owner.token);
  assert.equal(permissionResponse.status, 200);
  assert.equal(permissionResponse.body.data.can_read, true);

  // A chat created with the page can then be used straight away.
  assert.equal((await api('POST', `/api/chat/${owner.workspaceId}/${chatId}/settings`, { name: 'Untitled', rag_ids: [chatId], metadata: {} }, owner.token)).status, 200);

  const explicitId = crypto.randomUUID();
  assert.equal((await api('POST', url, { parent_view_id: spaceId, layout: 4, name: 'Mine', view_id: explicitId, collab_id: explicitId }, owner.token)).body.data.view_id, explicitId);
  assert.equal((await api('POST', url, { parent_view_id: spaceId, layout: 4, name: 'Dup', view_id: explicitId }, owner.token)).status, 409);
  assert.equal((await api('POST', url, { parent_view_id: spaceId, layout: 0, name: 'Doc' }, owner.token)).status, 400);
  assert.equal((await api('POST', url, { parent_view_id: crypto.randomUUID(), layout: 4, name: 'Nowhere' }, owner.token)).status, 403);
  assert.equal((await api('POST', url, { parent_view_id: spaceId, layout: 4, name: 'No auth' })).status, 401);
});
