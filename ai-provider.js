// Provider layer for bring-your-own-key AI: OpenRouter, OpenAI and Anthropic behind one
// `streamChat` async generator that yields plain text deltas. Plain fetch, no SDKs.
// Provider hosts are hard-coded; base URLs can only be overridden by the server
// operator (env / startServer options) for tests and local dev, never by a request.

export const AI_PROVIDERS = ['openrouter', 'openai', 'anthropic'];

const DEFAULT_BASE_URLS = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

const HTTP_STATUS_BY_KIND = {
  invalid_key: 400,
  insufficient_credits: 402,
  rate_limited: 429,
  context_length: 400,
  model_not_found: 400,
  bad_request: 400,
  empty: 502,
  unavailable: 503,
};

const MESSAGES = {
  invalid_key: 'The AI provider rejected the API key. Check the key and its permissions in Settings > AI.',
  insufficient_credits: 'The AI provider reports insufficient credits or quota. Add credits to the provider account.',
  rate_limited: 'The AI provider is rate limiting requests. Try again in a moment.',
  context_length: 'The input is too long for this model. Shorten it or choose a model with a larger context.',
  model_not_found: 'The selected model was not found for this API key. Choose another model in Settings > AI.',
  unavailable: 'The AI provider is temporarily unavailable. Try again shortly.',
  empty: 'The model returned no text. Try again or choose another model.',
};

export class AiProviderError extends Error {
  constructor(kind, message, { status, retryAfterSecs } = {}) {
    super(message ?? MESSAGES[kind] ?? 'The AI request failed.');
    this.name = 'AiProviderError';
    this.kind = kind;
    this.upstreamStatus = status;
    this.retryAfterSecs = retryAfterSecs;
    this.httpStatus = HTTP_STATUS_BY_KIND[kind] ?? 502;
  }
}

const CONTEXT_PATTERN = /context.{0,20}(length|window)|maximum context|too many tokens|prompt is too long|token limit/i;

// Maps a provider error (HTTP status and/or error payload) to a user-presentable error.
// Upstream bodies are never logged or echoed except a short, sanitized provider message
// for plain 400s.
export function mapProviderError({ status, error, retryAfterSecs } = {}) {
  const payload = error && typeof error === 'object' ? error : {};
  const type = String(payload.type ?? payload.code ?? '').toLowerCase();
  const text = typeof payload.message === 'string' ? payload.message : '';
  const numeric = Number(status ?? (typeof payload.code === 'number' ? payload.code : NaN));
  const options = { status: Number.isFinite(numeric) ? numeric : undefined, retryAfterSecs };

  if (type === 'insufficient_quota' || type === 'billing_error' || numeric === 402) return new AiProviderError('insufficient_credits', undefined, options);
  if (numeric === 401 || numeric === 403 || ['authentication_error', 'permission_error', 'invalid_api_key'].includes(type)) return new AiProviderError('invalid_key', undefined, options);
  if (numeric === 429 || type === 'rate_limit_error' || type === 'rate_limit_exceeded') return new AiProviderError('rate_limited', undefined, options);
  if (numeric === 404 || type === 'not_found_error' || type === 'model_not_found') return new AiProviderError('model_not_found', undefined, options);
  if (CONTEXT_PATTERN.test(text) || type === 'context_length_exceeded') return new AiProviderError('context_length', undefined, options);
  if (numeric === 400 || type === 'invalid_request_error') {
    const safe = text.replace(/\s+/g, ' ').slice(0, 200).replace(/(sk-[A-Za-z0-9_-]{6,})/g, '[redacted]');

    return new AiProviderError('bad_request', safe ? `The AI provider rejected the request: ${safe}` : 'The AI provider rejected the request.', options);
  }
  return new AiProviderError('unavailable', undefined, options);
}

function parseRetryAfter(headers) {
  const raw = headers?.get?.('retry-after');
  const seconds = Number(raw);

  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) : undefined;
}

// Anthropic requires the first message to be a user turn and (conservatively) alternating roles.
export function normalizeAnthropicMessages(messages) {
  const merged = [];

  for (const message of messages) {
    if (!message?.content || !['user', 'assistant'].includes(message.role)) continue;
    const last = merged[merged.length - 1];

    if (last && last.role === message.role) last.content += `\n\n${message.content}`;
    else merged.push({ role: message.role, content: String(message.content) });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let pending = '';
  let eventName = '';
  let dataLines = [];
  const flush = function* flush() {
    if (dataLines.length) yield { event: eventName, data: dataLines.join('\n') };
    eventName = '';
    dataLines = [];
  };

  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split(/\r\n|\n|\r/);

    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') yield* flush();
      else if (line.startsWith(':')) continue;
      else if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:')) dataLines.push(pending.slice(5).replace(/^ /, ''));
  yield* flush();
}

const OPENAI_CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/i;
const OPENAI_NON_CHAT = /(embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image|search-preview|instruct|davinci|babbage)/i;
const OPENAI_VISION = /^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1|o3|o4|chatgpt-4o)/i;

export function createAiProvider({
  baseUrls = {},
  anthropicVersion = '2023-06-01',
  timeoutMs = 120000,
  fetchImpl = (...args) => globalThis.fetch(...args),
  appTitle = 'AppFlowy Self-Hosted',
  appUrl = 'https://appflowy.com',
} = {}) {
  const base = (provider) => String(baseUrls[provider] || DEFAULT_BASE_URLS[provider]).replace(/\/+$/, '');

  function authHeaders(provider, apiKey) {
    if (provider === 'anthropic') return { 'x-api-key': apiKey, 'anthropic-version': anthropicVersion };
    const headers = { authorization: `Bearer ${apiKey}` };

    if (provider === 'openrouter') Object.assign(headers, { 'HTTP-Referer': appUrl, 'X-Title': appTitle, 'X-OpenRouter-Title': appTitle });
    return headers;
  }

  function combinedSignal(signal, ms) {
    const timeout = AbortSignal.timeout(ms);

    return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timeout };
  }

  async function request(url, init, signal, ms) {
    const { signal: merged, timeout } = combinedSignal(signal, ms);

    try {
      return await fetchImpl(url, { ...init, signal: merged });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new AiProviderError('unavailable', 'The AI provider took too long to respond.');
      throw new AiProviderError('unavailable');
    }
  }

  async function failFromResponse(response) {
    let error;

    try { error = (await response.json())?.error; } catch { /* non-JSON body */ }
    return mapProviderError({ status: response.status, error, retryAfterSecs: parseRetryAfter(response.headers) });
  }

  async function getJson(provider, apiKey, pathAndQuery, signal) {
    const response = await request(`${base(provider)}${pathAndQuery}`, { method: 'GET', headers: authHeaders(provider, apiKey) }, signal, 30000);

    if (!response.ok) throw await failFromResponse(response);
    try { return await response.json(); } catch { throw new AiProviderError('unavailable'); }
  }

  function buildChatRequest(provider, { apiKey, model, messages, system, maxTokens }) {
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders(provider, apiKey) };

    if (provider === 'anthropic') {
      return {
        url: `${base(provider)}/messages`,
        headers,
        body: { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: normalizeAnthropicMessages(messages), stream: true },
      };
    }
    const chat = [...(system ? [{ role: 'system', content: system }] : []), ...messages.map((m) => ({ role: m.role, content: String(m.content) }))];

    return {
      url: `${base(provider)}/chat/completions`,
      headers,
      body: provider === 'openai'
        ? { model, messages: chat, stream: true, max_completion_tokens: maxTokens, stream_options: { include_usage: true } }
        : { model, messages: chat, stream: true, max_tokens: maxTokens },
    };
  }

  async function* streamChat({ provider, apiKey, model, messages, system, maxTokens = 4096, signal }) {
    if (!AI_PROVIDERS.includes(provider)) throw new AiProviderError('bad_request', 'Unsupported AI provider.');
    const { url, headers, body } = buildChatRequest(provider, { apiKey, model, messages, system, maxTokens });
    const { signal: merged, timeout } = combinedSignal(signal, timeoutMs);
    let response;

    try {
      response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: merged });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AiProviderError('unavailable', timeout.aborted ? 'The AI provider took too long to respond.' : undefined);
    }
    if (!response.ok) throw await failFromResponse(response);

    let yielded = false;

    try {
      for await (const { event, data } of sseEvents(response.body)) {
        if (data === '[DONE]') break;
        let frame;

        try { frame = JSON.parse(data); } catch { continue; }
        if (provider === 'anthropic') {
          const type = frame.type ?? event;

          if (type === 'error') throw mapProviderError({ error: frame.error });
          if (type === 'message_stop') break;
          if (type === 'content_block_delta' && frame.delta?.type === 'text_delta' && frame.delta.text) {
            yielded = true;
            yield frame.delta.text;
          }
          continue;
        }
        if (frame.error) throw mapProviderError({ status: typeof frame.error.code === 'number' ? frame.error.code : undefined, error: frame.error });
        const choice = frame.choices?.[0];

        if (choice?.finish_reason === 'error') throw new AiProviderError('unavailable');
        const text = choice?.delta?.content;

        if (typeof text === 'string' && text) {
          yielded = true;
          yield text;
        }
      }
    } catch (error) {
      if (error instanceof AiProviderError || signal?.aborted) throw error;
      throw new AiProviderError('unavailable', timeout.aborted ? 'The AI provider took too long to respond.' : undefined);
    }
    if (!yielded) throw new AiProviderError('empty');
  }

  async function completeChat(args) {
    let text = '';

    for await (const delta of streamChat(args)) text += delta;
    return text;
  }

  async function listModels({ provider, apiKey, signal }) {
    if (provider === 'openrouter') {
      const json = await getJson(provider, apiKey, '/models', signal);

      return (json.data ?? []).map((model) => ({
        id: model.id,
        name: model.name || model.id,
        context_length: Number.isFinite(model.context_length) ? model.context_length : undefined,
        supports_vision: Array.isArray(model.architecture?.input_modalities) ? model.architecture.input_modalities.includes('image') : undefined,
        prompt_price: model.pricing?.prompt ?? null,
      }));
    }
    if (provider === 'openai') {
      const json = await getJson(provider, apiKey, '/models', signal);

      return (json.data ?? [])
        .map((model) => model.id)
        .filter((id) => typeof id === 'string' && OPENAI_CHAT_MODEL.test(id) && !OPENAI_NON_CHAT.test(id))
        .sort()
        .map((id) => ({ id, name: id, supports_vision: OPENAI_VISION.test(id), prompt_price: null }));
    }
    const json = await getJson(provider, apiKey, '/models?limit=1000', signal);

    return (json.data ?? []).map((model) => ({
      id: model.id,
      name: model.display_name || model.id,
      context_length: Number.isFinite(model.max_input_tokens) ? model.max_input_tokens : undefined,
      supports_vision: model.capabilities?.image_input?.supported === true,
      prompt_price: null,
    }));
  }

  // Validates the key with the cheapest authenticated call each provider offers.
  async function testKey({ provider, apiKey, signal }) {
    if (provider === 'openrouter') await getJson(provider, apiKey, '/key', signal);
    const models = await listModels({ provider, apiKey, signal });

    return { ok: true, model_count: models.length };
  }

  return { streamChat, completeChat, listModels, testKey };
}
