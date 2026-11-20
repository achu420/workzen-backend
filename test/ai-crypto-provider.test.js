// Key vault (AES-256-GCM, workspace-bound) and the provider layer against a fake server that
// speaks the OpenRouter, OpenAI and Anthropic wire formats.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKeyVault, deriveSecretKey, resolveAiSecret } from '../ai-crypto.js';
import { AiProviderError, createAiProvider, mapProviderError, normalizeAnthropicMessages } from '../ai-provider.js';
import { KEYS, startFakeAiProvider } from './helpers/fake-ai-provider.js';

let fake, provider, dir;

before(async () => {
  fake = await startFakeAiProvider();
  provider = createAiProvider({ baseUrls: fake.baseUrls, timeoutMs: 5000 });
  dir = await mkdtemp(path.join(os.tmpdir(), 'ai-crypto-'));
});
after(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

const collect = async (args) => {
  let text = '';

  for await (const delta of provider.streamChat({ maxTokens: 256, ...args })) text += delta;
  return text;
};

test('key vault round trips, binds the workspace as AAD and never leaks the key', () => {
  const vault = createKeyVault(deriveSecretKey('a passphrase'));
  const record = vault.encrypt('ws-1', 'sk-super-secret-1234');

  assert.equal(record.last4, '1234');
  assert.ok(!JSON.stringify(record).includes('sk-super-secret'));
  assert.equal(vault.decrypt('ws-1', record), 'sk-super-secret-1234');
  assert.throws(() => vault.decrypt('ws-2', record), 'a ciphertext copied to another workspace must not decrypt');
  assert.throws(() => vault.decrypt('ws-1', { ...record, tag: Buffer.alloc(16).toString('base64') }));
  assert.notEqual(vault.encrypt('ws-1', 'same').iv, vault.encrypt('ws-1', 'same').iv, 'a fresh IV per record');
});

test('secrets accept hex, base64 and passphrases; a generated secret is persisted 0600', async () => {
  const hex = 'ab'.repeat(32);

  assert.equal(deriveSecretKey(hex).toString('hex'), hex);
  assert.equal(deriveSecretKey(Buffer.alloc(32, 7).toString('base64')).length, 32);
  assert.equal(deriveSecretKey('anything at all').length, 32);
  assert.deepEqual(deriveSecretKey('x'), deriveSecretKey('x'));

  const file = path.join(dir, 'nested', '.ai-key-secret');
  const first = await resolveAiSecret({ secretFile: file });
  const again = await resolveAiSecret({ secretFile: file });

  assert.deepEqual(first, again, 'the same secret survives a restart');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, 'utf8')).trim().length, 64);
  assert.deepEqual(await resolveAiSecret({ secret: 'from-env', secretFile: file }), deriveSecretKey('from-env'));
});

test('openrouter and openai stream text via chat/completions, skipping keep-alives and usage frames', async () => {
  const router = await collect({ provider: 'openrouter', apiKey: KEYS.openrouter, model: 'openai/gpt-test', system: 'Be brief.', messages: [{ role: 'user', content: 'hello world' }] });

  assert.equal(router, 'echo: hello world');
  const routerRequest = fake.lastChat();

  assert.equal(routerRequest.path, '/api/v1/chat/completions');
  assert.equal(routerRequest.headers.authorization, `Bearer ${KEYS.openrouter}`);
  assert.ok(routerRequest.headers['http-referer'] && routerRequest.headers['x-title'] && routerRequest.headers['x-openrouter-title']);
  assert.equal(routerRequest.body.max_tokens, 256);
  assert.equal(routerRequest.body.max_completion_tokens, undefined);
  assert.deepEqual(routerRequest.body.messages[0], { role: 'system', content: 'Be brief.' });

  const openai = await collect({ provider: 'openai', apiKey: KEYS.openai, model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi there' }] });

  assert.equal(openai, 'echo: hi there');
  const openaiRequest = fake.lastChat();

  assert.equal(openaiRequest.path, '/v1/chat/completions');
  assert.equal(openaiRequest.body.max_completion_tokens, 256);
  assert.equal(openaiRequest.body.max_tokens, undefined);
  assert.equal(openaiRequest.body.temperature, undefined, 'reasoning models reject a custom temperature');
  assert.equal(openaiRequest.body.stream_options.include_usage, true);
  assert.equal(openaiRequest.headers['http-referer'], undefined);
});

test('anthropic streams text_delta only and sends system at the top level', async () => {
  const text = await collect({
    provider: 'anthropic', apiKey: KEYS.anthropic, model: 'claude-test-1', system: 'Top level.',
    messages: [{ role: 'assistant', content: 'dropped leading assistant' }, { role: 'user', content: 'one' }, { role: 'user', content: 'two' }],
  });

  assert.equal(text, 'echo: one\n\ntwo');
  const request = fake.lastChat();

  assert.equal(request.path, '/v1/messages');
  assert.equal(request.headers['x-api-key'], KEYS.anthropic);
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.body.system, 'Top level.');
  assert.equal(request.body.max_tokens, 256);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'one\n\ntwo' }]);
  assert.deepEqual(normalizeAnthropicMessages([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'b' }, { role: 'assistant', content: 'c' }]),
    [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'b\n\nc' }]);
});

test('provider errors map to readable kinds, before and during the stream', async () => {
  const cases = [
    ['openai', KEYS.openai, 'x', 'invalid_key', 'wrong-key'],
    ['openai', KEYS.openai, '[[error402]]', 'insufficient_credits'],
    ['openrouter', KEYS.openrouter, '[[error429]]', 'rate_limited'],
    ['openai', KEYS.openai, '[[context]]', 'context_length'],
    ['anthropic', KEYS.anthropic, '[[context]]', 'context_length'],
    ['openai', KEYS.openai, '[[error500]]', 'unavailable'],
    ['openai', KEYS.openai, '[[empty]]', 'empty'],
    ['openai', KEYS.openai, '[[midstream]]', 'rate_limited'],
    ['anthropic', KEYS.anthropic, '[[midstream]]', 'unavailable'],
    ['anthropic', KEYS.anthropic, '[[empty]]', 'empty'],
  ];

  for (const [name, key, marker, kind, override] of cases) {
    await assert.rejects(
      collect({ provider: name, apiKey: override ?? key, model: 'm', messages: [{ role: 'user', content: marker }] }),
      (error) => error instanceof AiProviderError && error.kind === kind && error.message.length > 10,
      `${name} ${marker} -> ${kind}`
    );
  }
  await assert.rejects(collect({ provider: 'openrouter', apiKey: KEYS.openrouter, model: 'm', messages: [{ role: 'user', content: '[[error429]]' }] }), (error) => error.retryAfterSecs === 3);
  assert.equal(mapProviderError({ status: 404 }).kind, 'model_not_found');
  assert.equal(mapProviderError({ error: { code: 'insufficient_quota' } }).kind, 'insufficient_credits');
  assert.equal(new AiProviderError('rate_limited').httpStatus, 429);
});

test('a stream can be cancelled by the caller', async () => {
  const before = fake.state.aborted;
  const controller = new AbortController();
  const stream = provider.streamChat({ provider: 'openai', apiKey: KEYS.openai, model: 'm', maxTokens: 10, messages: [{ role: 'user', content: '[[slow]]' }], signal: controller.signal });
  const first = await stream.next();

  assert.equal(first.value, 'slow-start');
  controller.abort();
  await assert.rejects(stream.next(), (error) => !(error instanceof AiProviderError));
  for (let i = 0; i < 40 && fake.state.aborted === before; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fake.state.aborted, before + 1, 'the upstream connection was closed');
});

test('model lists are normalised per provider and keys are validated', async () => {
  const router = await provider.listModels({ provider: 'openrouter', apiKey: KEYS.openrouter });

  assert.deepEqual(router.map((m) => [m.id, m.name, m.context_length, m.supports_vision, m.prompt_price]), [
    ['openai/gpt-test', 'GPT Test', 8000, true, '0.000001'],
    ['anthropic/claude-test', 'Claude Test', 200000, false, '0.000003'],
  ]);
  const openai = await provider.listModels({ provider: 'openai', apiKey: KEYS.openai });

  assert.deepEqual(openai.map((m) => m.id), ['gpt-3.5-turbo', 'gpt-4o-test', 'o3-mini'], 'embedding/whisper/dall-e are filtered out');
  assert.equal(openai.find((m) => m.id === 'gpt-4o-test').supports_vision, true);
  const anthropic = await provider.listModels({ provider: 'anthropic', apiKey: KEYS.anthropic });

  assert.deepEqual(anthropic.map((m) => [m.id, m.name, m.supports_vision]), [['claude-test-1', 'Claude Test 1', true], ['claude-text-only', 'Claude Text', false]]);
  assert.equal(fake.state.requests.at(-1).query, '?limit=1000');

  assert.deepEqual(await provider.testKey({ provider: 'openrouter', apiKey: KEYS.openrouter }), { ok: true, model_count: 2 });
  assert.deepEqual(await provider.testKey({ provider: 'anthropic', apiKey: KEYS.anthropic }), { ok: true, model_count: 2 });
  for (const name of ['openrouter', 'openai', 'anthropic']) {
    await assert.rejects(provider.testKey({ provider: name, apiKey: 'bad-key' }), (error) => error.kind === 'invalid_key');
  }
});

test('an unreachable provider reads as temporarily unavailable', async () => {
  const dead = createAiProvider({ baseUrls: { openai: 'http://127.0.0.1:1/v1' }, timeoutMs: 2000 });

  await assert.rejects(dead.completeChat({ provider: 'openai', apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'x' }] }), (error) => error.kind === 'unavailable');
});
