// Per-workspace AI settings (encrypted key, owner/admin only), key testing, model lists,
// the "not configured" error, request limits and log redaction.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KEYS, startFakeAiProvider } from './helpers/fake-ai-provider.js';
import { account, addMember, aiSettingsUrl, configureAi, createApi, rawStream } from './helpers/ai-test-env.js';

const logDir = await mkdtemp(path.join(os.tmpdir(), 'ai-settings-log-'));
const logFile = path.join(logDir, 'api.log');

process.env.API_LOG_FILE = logFile;
const { startServer } = await import('../server.js');

let fake, dir, running, base, api;
const extraServers = [];

async function boot(options = {}) {
  const server = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, `state-${extraServers.length}.json`), devKey: 'test-key', aiProviderBaseUrls: fake.baseUrls, ...options });

  extraServers.push(server);
  return { server, base: `http://127.0.0.1:${server.address.port}` };
}

before(async () => {
  fake = await startFakeAiProvider();
  dir = await mkdtemp(path.join(os.tmpdir(), 'ai-settings-'));
  ({ server: running, base } = await boot());
  api = createApi(() => base);
});
after(async () => {
  for (const started of extraServers) await new Promise((resolve) => { started.server.closeAllConnections?.(); started.server.close(resolve); });
  await fake.close();
  await rm(dir, { recursive: true, force: true });
  await rm(logDir, { recursive: true, force: true });
});

test('settings start empty, save with a masked hint, and never echo or store the key in clear text', async () => {
  const owner = await account(api, 'ai-set-owner');
  const url = aiSettingsUrl(owner.workspaceId);

  assert.deepEqual((await api('GET', url, undefined, owner.token)).body.data, { provider: null, has_key: false, key_hint: null, model: null, enabled_models: [] });

  const saved = await api('PUT', url, { provider: 'openai', api_key: `  ${KEYS.openai}  `, model: 'gpt-4o-test', enabled_models: ['gpt-4o-test', 'o3-mini', 'o3-mini'] }, owner.token);

  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data, { provider: 'openai', has_key: true, key_hint: '...enai', model: 'gpt-4o-test', enabled_models: ['gpt-4o-test', 'o3-mini'] });
  assert.ok(!JSON.stringify(saved.body).includes(KEYS.openai));
  assert.ok(!JSON.stringify((await api('GET', url, undefined, owner.token)).body).includes(KEYS.openai));

  const record = running.app.store.state.aiSettings[owner.workspaceId];

  assert.ok(record.key_enc.iv && record.key_enc.tag && record.key_enc.ciphertext);
  assert.ok(!JSON.stringify(running.app.store.state).includes(KEYS.openai), 'the key is encrypted at rest');

  // Omitting api_key keeps the stored key while other fields change.
  const kept = await api('PUT', url, { provider: 'openai', model: 'o3-mini' }, owner.token);

  assert.deepEqual([kept.body.data.has_key, kept.body.data.key_hint, kept.body.data.model, kept.body.data.enabled_models], [true, '...enai', 'o3-mini', ['gpt-4o-test', 'o3-mini']]);

  // Changing provider needs a new key and resets the model choices.
  assert.equal((await api('PUT', url, { provider: 'anthropic' }, owner.token)).status, 400);
  const switched = await api('PUT', url, { provider: 'anthropic', api_key: KEYS.anthropic }, owner.token);

  assert.deepEqual(switched.body.data, { provider: 'anthropic', has_key: true, key_hint: '...good', model: null, enabled_models: [] });

  const cleared = await api('DELETE', url, undefined, owner.token);

  assert.deepEqual(cleared.body.data, { provider: null, has_key: false, key_hint: null, model: null, enabled_models: [] });
  assert.equal(running.app.store.state.aiSettings[owner.workspaceId], undefined);
});

test('settings validation', async () => {
  const owner = await account(api, 'ai-set-valid');
  const url = aiSettingsUrl(owner.workspaceId);
  const bad = [
    { provider: 'gemini', api_key: 'k' },
    { api_key: 'k' },
    { provider: 'openai' },
    { provider: 'openai', api_key: '' },
    { provider: 'openai', api_key: 'has space' },
    { provider: 'openai', api_key: 'k'.repeat(513) },
    { provider: 'openai', api_key: 'k', model: 'm'.repeat(201) },
    { provider: 'openai', api_key: 'k', model: 5 },
    { provider: 'openai', api_key: 'k', enabled_models: 'gpt' },
    { provider: 'openai', api_key: 'k', enabled_models: Array.from({ length: 201 }, (_, i) => `m${i}`) },
    { provider: 'openai', api_key: 'k', enabled_models: [''] },
    { provider: 'openai', api_key: 'k', base_url: 'http://169.254.169.254' },
  ];

  for (const payload of bad) assert.equal((await api('PUT', url, payload, owner.token)).status, 400, JSON.stringify(payload).slice(0, 80));
  assert.equal((await api('GET', url, undefined, owner.token)).body.data.has_key, false, 'rejected writes change nothing');
  assert.ok((await api('PUT', url, { provider: 'openai', api_key: 'k'.repeat(512) }, owner.token)).status === 200);
});

test('only owners and admins manage settings; members can still use the model list', async () => {
  const owner = await account(api, 'ai-perm-owner');
  const member = await account(api, 'ai-perm-member');
  const outsider = await account(api, 'ai-perm-outsider');

  await addMember(api, owner, member);
  await configureAi(api, owner, 'openai');
  const url = aiSettingsUrl(owner.workspaceId);

  for (const [method, sub, payload] of [['GET', ''], ['PUT', '', { provider: 'openai', api_key: 'k' }], ['DELETE', ''], ['POST', '/test', {}], ['GET', '/models']]) {
    assert.equal((await api(method, aiSettingsUrl(owner.workspaceId, sub), payload, member.token)).status, 403, `member ${method} ${sub}`);
    assert.equal((await api(method, aiSettingsUrl(owner.workspaceId, sub), payload, outsider.token)).status, 403, `outsider ${method} ${sub}`);
    assert.equal((await api(method, aiSettingsUrl(owner.workspaceId, sub), payload)).status, 401, `anonymous ${method} ${sub}`);
  }
  assert.equal((await api('GET', url, undefined, owner.token)).body.data.has_key, true, 'denied calls changed nothing');
  assert.equal((await api('GET', `/api/ai/${owner.workspaceId}/model/list`, undefined, member.token)).status, 200);
  assert.equal((await api('GET', `/api/ai/${owner.workspaceId}/model/list`, undefined, outsider.token)).status, 403);

  // An admin may manage them.
  running.app.store.state.memberships[`${owner.workspaceId}:${(await api('GET', '/api/auth/me', undefined, member.token)).body.user.id}`].role = 'admin';
  assert.equal((await api('GET', url, undefined, member.token)).status, 200);
});

test('testing a key reports success or a readable failure, using the stored key by default', async () => {
  const owner = await account(api, 'ai-test-key');
  const url = aiSettingsUrl(owner.workspaceId, '/test');

  assert.equal((await api('POST', url, {}, owner.token)).status, 400, 'nothing to test yet');
  assert.deepEqual((await api('POST', url, { provider: 'openrouter', api_key: KEYS.openrouter }, owner.token)).body.data, { ok: true, model_count: 2 });
  assert.deepEqual((await api('POST', url, { provider: 'anthropic', api_key: KEYS.anthropic }, owner.token)).body.data, { ok: true, model_count: 2 });

  const rejected = await api('POST', url, { provider: 'openai', api_key: 'sk-wrong' }, owner.token);

  assert.equal(rejected.status, 400);
  assert.match(rejected.body.message, /rejected the API key/i);
  assert.ok(!JSON.stringify(rejected.body).includes('sk-wrong'));

  await configureAi(api, owner, 'openai');
  assert.deepEqual((await api('POST', url, {}, owner.token)).body.data, { ok: true, model_count: 3 }, 'stored key');
  assert.equal((await api('POST', url, { provider: 'anthropic' }, owner.token)).status, 400, 'a stored key is never reused for another provider');
  assert.equal((await api('POST', url, { api_key: 'has space' }, owner.token)).status, 400);
});

test('provider models are listed live, cached, and refreshed when settings change', async () => {
  const owner = await account(api, 'ai-models');
  const url = aiSettingsUrl(owner.workspaceId, '/models');

  const none = await api('GET', url, undefined, owner.token);

  assert.equal(none.status, 400);
  assert.match(none.body.message, /not configured/i);

  await configureAi(api, owner, 'openrouter');
  const countModelCalls = () => fake.state.requests.filter((r) => r.method === 'GET' && r.path === '/api/v1/models').length;
  const before = countModelCalls();
  const first = await api('GET', url, undefined, owner.token);

  assert.deepEqual(first.body.data.models.map((m) => [m.id, m.name, m.context_length, m.supports_vision, m.prompt_price]), [
    ['openai/gpt-test', 'GPT Test', 8000, true, '0.000001'],
    ['anthropic/claude-test', 'Claude Test', 200000, false, '0.000003'],
  ]);
  await api('GET', url, undefined, owner.token);
  assert.equal(countModelCalls(), before + 1, 'the second call is served from the 5-minute cache');
  await configureAi(api, owner, 'anthropic');
  assert.deepEqual((await api('GET', url, undefined, owner.token)).body.data.models.map((m) => m.id), ['claude-test-1', 'claude-text-only']);
});

test('models can be listed with a typed key before anything is saved', async () => {
  const owner = await account(api, 'ai-models-typed');
  const url = aiSettingsUrl(owner.workspaceId, '/models');

  const typed = await api('POST', url, { provider: 'openrouter', api_key: KEYS.openrouter }, owner.token);

  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  assert.ok(typed.body.data.models.length > 0);
  assert.ok(typed.body.data.models[0].id);
  assert.equal((await api('GET', aiSettingsUrl(owner.workspaceId), undefined, owner.token)).body.data.has_key, false, 'nothing was saved');

  const bad = await api('POST', url, { provider: 'openrouter', api_key: 'sk-or-wrong' }, owner.token);

  assert.equal(bad.status, 400);
  assert.ok(bad.body.message);
  assert.equal((await api('POST', url, { api_key: KEYS.openrouter }, owner.token)).status, 400, 'a provider is required');
  assert.equal((await api('POST', url, { provider: 'openai' }, owner.token)).status, 400, 'a key is required when none is stored');

  await configureAi(api, owner, 'openrouter');
  const stored = await api('POST', url, {}, owner.token);

  assert.equal(stored.status, 200, 'the stored key is used when none is typed');
  assert.equal((await api('POST', url, { provider: 'openrouter', api_key: KEYS.openrouter }, (await account(api, 'ai-models-outsider')).token)).status, 403);
});

test('the chat model picker gets Auto plus the enabled (or all provider) models', async () => {
  const owner = await account(api, 'ai-picker');
  const list = () => api('GET', `/api/ai/${owner.workspaceId}/model/list`, undefined, owner.token);

  const unconfigured = (await list()).body.data.models;

  assert.deepEqual(unconfigured.map((m) => m.name), ['Auto']);
  assert.equal(unconfigured[0].metadata.is_default, true);

  await configureAi(api, owner, 'openai', { model: 'gpt-4o-test' });
  const all = (await list()).body.data.models;

  assert.deepEqual(all.map((m) => m.name), ['Auto', 'gpt-3.5-turbo', 'gpt-4o-test', 'o3-mini']);
  assert.ok(all.slice(1).every((m) => m.provider === 'openai' && m.metadata.is_default === false));
  assert.match(all[0].metadata.desc, /gpt-4o-test/);

  await configureAi(api, owner, 'openai', { enabled_models: ['o3-mini'] });
  assert.deepEqual((await list()).body.data.models.map((m) => m.name), ['Auto', 'o3-mini']);
  await configureAi(api, owner, 'openrouter', { enabled_models: ['anthropic/claude-test'] });
  const router = (await list()).body.data.models;

  assert.deepEqual(router.map((m) => [m.name, m.metadata.desc]), [['Auto', router[0].metadata.desc], ['anthropic/claude-test', 'Claude Test']]);
});

test('every AI call says how to fix a missing key', async () => {
  const owner = await account(api, 'ai-nokey');
  const calls = [
    ['POST', `/api/ai/${owner.workspaceId}/v2/complete/stream`, { text: 'hi', completion_type: 7, metadata: {} }],
    ['POST', `/api/ai/${owner.workspaceId}/summarize_row`, { data: { Content: { a: 'b' } } }],
    ['POST', `/api/ai/${owner.workspaceId}/translate_row`, { data: { cells: [{ title: 't', content: 'c' }], language: 'French' } }],
  ];

  for (const [method, route, payload] of calls) {
    const response = await api(method, route, payload, owner.token);

    assert.equal(response.status, 400, route);
    assert.match(response.body.message, /AI is not configured.*Settings > AI/);
    assert.equal(response.body.code, 400);
  }
});

test('a per-user request rate limit applies to AI generation, not to settings or the model list', async () => {
  const { server, base: limitedBase } = await boot({ aiRateLimitPerMinute: 3 });
  const limited = createApi(() => limitedBase);
  const owner = await account(limited, 'ai-rate-owner');

  await configureAi(limited, owner, 'openai', { model: 'gpt-4o-test' });
  const call = () => limited('POST', `/api/ai/${owner.workspaceId}/summarize_row`, { data: { Content: { a: 'b' } } }, owner.token);

  for (let i = 0; i < 3; i += 1) assert.equal((await call()).status, 200);
  const blocked = await call();

  assert.equal(blocked.status, 429);
  assert.match(blocked.body.message, /too many AI requests/i);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal((await limited('GET', `/api/ai/${owner.workspaceId}/model/list`, undefined, owner.token)).status, 200);
  assert.equal((await limited('GET', aiSettingsUrl(owner.workspaceId), undefined, owner.token)).status, 200);
  assert.ok(server);
});

test('a per-workspace concurrent stream cap rejects the extra stream and frees up after a disconnect', async () => {
  const { base: capBase } = await boot({ aiMaxConcurrentStreams: 1 });
  const capped = createApi(() => capBase);
  const owner = await account(capped, 'ai-cap-owner');

  await configureAi(capped, owner, 'openai', { model: 'gpt-4o-test' });
  const url = `${capBase}/api/ai/${owner.workspaceId}/v2/complete/stream`;
  const slow = new AbortController();
  const first = await fetch(url, { method: 'POST', signal: slow.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ text: '[[slow]]', completion_type: 7, metadata: {} }) });
  const reader = first.body.getReader();

  assert.equal(first.status, 200);
  assert.ok((await reader.read()).value.length > 0);

  const second = await rawStream(capBase, `/api/ai/${owner.workspaceId}/v2/complete/stream`, { text: 'hello', completion_type: 7, metadata: {} }, owner.token);

  assert.equal(second.status, 429);
  assert.match(second.frames[0].message, /too many AI requests running/i);

  slow.abort();
  await reader.cancel().catch(() => {});
  let third;

  for (let i = 0; i < 40; i += 1) {
    third = await rawStream(capBase, `/api/ai/${owner.workspaceId}/v2/complete/stream`, { text: 'hello', completion_type: 7, metadata: {} }, owner.token);
    if (third.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(third.status, 200, 'the slot is released when the client disconnects');
});

test('API keys never reach the request log', async () => {
  const owner = await account(api, 'ai-redact');

  // A rejected write logs its body for debugging; the key must be masked there.
  await api('PUT', aiSettingsUrl(owner.workspaceId), { provider: 'nonsense', api_key: 'sk-redact-me-9999' }, owner.token);
  await api('POST', aiSettingsUrl(owner.workspaceId, '/test'), { provider: 'openai', api_key: 'sk-wrong-should-not-log' }, owner.token);
  await configureAi(api, owner, 'openai');
  await api('POST', `/api/ai/${owner.workspaceId}/v2/complete/stream`, { text: '[[error402]]', completion_type: 7, metadata: {} }, owner.token);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const log = await readFile(logFile, 'utf8');

  assert.match(log, /ai-settings/);
  assert.match(log, /\[redacted\]/);
  for (const secret of [...Object.values(KEYS), 'sk-redact-me-9999', 'sk-wrong-should-not-log']) assert.ok(!log.includes(secret), `${secret} must not be logged`);
});
