// HTTP routes for bring-your-own-key AI: per-workspace provider settings, model list,
// the editor writer stream, database row summarize/translate, and persisted AI chat.
// server.js calls `handle(ctx)` early in its request handler; it returns true when the
// request was one of ours.
import path from 'node:path';
import { AI_PROVIDERS, AiProviderError, createAiProvider } from './ai-provider.js';
import { createKeyVault, resolveAiSecret } from './ai-crypto.js';
import { buildWorkspaceContext } from './ai-workspace-chat.js';
import { buildCardContext, cardChatId, cardChatSystem, isUuid } from './ai-card-chat.js';
import {
  buildWriterPrompt, CHAT_SYSTEM, isCompletionType, parseJsonStringArray, RELATED_QUESTIONS_SYSTEM,
  SUMMARIZE_ROW_SYSTEM, translateRowPrompt,
} from './ai-prompts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_000_000;
const MAX_MODEL_LENGTH = 200;
const CHAT_HISTORY_CHAR_BUDGET = 24_000;
const NOT_CONFIGURED = 'AI is not configured. Ask a workspace owner to add an API key in Settings > AI.';

class AiRouteError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.status = status;
    this.errorCode = code;
    this.headers = headers;
  }
}

function envBaseUrls(env) {
  return {
    ...(env.AI_OPENROUTER_BASE_URL ? { openrouter: env.AI_OPENROUTER_BASE_URL } : {}),
    ...(env.AI_OPENAI_BASE_URL ? { openai: env.AI_OPENAI_BASE_URL } : {}),
    ...(env.AI_ANTHROPIC_BASE_URL ? { anthropic: env.AI_ANTHROPIC_BASE_URL } : {}),
  };
}

const intParam = (value) => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);

  return Number.isInteger(parsed) ? parsed : undefined;
};

export function createAiRoutes({ store, helpers, options = {}, dataFile }) {
  const env = options.env ?? process.env;
  const provider = createAiProvider({
    baseUrls: { ...envBaseUrls(env), ...(options.aiProviderBaseUrls ?? {}) },
    anthropicVersion: options.aiAnthropicVersion ?? env.AI_ANTHROPIC_VERSION ?? '2023-06-01',
    timeoutMs: options.aiUpstreamTimeoutMs ?? (Number(env.AI_UPSTREAM_TIMEOUT_MS) || 120000),
  });
  const maxOutputTokens = options.aiMaxOutputTokens ?? (Number(env.AI_MAX_OUTPUT_TOKENS) || 4096);
  const ratePerMinute = options.aiRateLimitPerMinute ?? (Number(env.AI_RATE_LIMIT_PER_MINUTE) || 30);
  const maxConcurrent = options.aiMaxConcurrentStreams ?? (Number(env.AI_MAX_CONCURRENT_STREAMS) || 4);
  const modelCacheTtlMs = options.aiModelCacheTtlMs ?? 5 * 60 * 1000;
  const secretFile = options.aiSecretFile ?? path.join(path.dirname(dataFile), '.ai-key-secret');
  let vaultPromise;
  const getVault = () => (vaultPromise ??= resolveAiSecret({ secret: options.aiKeySecret ?? env.AI_KEY_SECRET, secretFile }).then(createKeyVault));
  const modelCache = new Map();
  const requestLog = new Map();
  const activeByWorkspace = new Map();

  const { send, appFlowyResponse } = helpers;

  const sendError = (res, status, code, message, headers = {}) => send(res, status, { code: status, message, error: { code, message } }, headers);
  const sendData = (res, data) => send(res, 200, appFlowyResponse(data), { 'cache-control': 'private, no-store' });

  async function readJson(req) {
    const value = await helpers.body(req);

    if ((req.rawBody ?? '').length > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
    return value;
  }

  // ---------------------------------------------------------------- limits
  function acquire(workspaceId, userId) {
    const now = Date.now();
    const recent = (requestLog.get(userId) ?? []).filter((time) => now - time < 60_000);

    if (recent.length >= ratePerMinute) {
      const retryAfter = Math.max(1, Math.ceil((60_000 - (now - recent[0])) / 1000));

      throw new AiRouteError(429, 'AI_RATE_LIMITED', 'Too many AI requests. Please wait a moment and try again.', { 'retry-after': String(retryAfter) });
    }
    if ((activeByWorkspace.get(workspaceId) ?? 0) >= maxConcurrent) {
      throw new AiRouteError(429, 'AI_BUSY', 'This workspace has too many AI requests running at once. Please try again shortly.', { 'retry-after': '2' });
    }
    recent.push(now);
    requestLog.set(userId, recent);
    activeByWorkspace.set(workspaceId, (activeByWorkspace.get(workspaceId) ?? 0) + 1);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      const left = (activeByWorkspace.get(workspaceId) ?? 1) - 1;

      if (left <= 0) activeByWorkspace.delete(workspaceId);
      else activeByWorkspace.set(workspaceId, left);
    };
  }

  // -------------------------------------------------------------- settings
  const settingsView = (record) => ({
    provider: record?.provider ?? null,
    has_key: !!record?.key_enc,
    key_hint: record?.key_enc ? `...${record.key_enc.last4}` : null,
    model: record?.model ?? null,
    enabled_models: record?.enabled_models ?? [],
  });

  async function loadAiContext(workspaceId) {
    const settings = await store.getAiSettings(workspaceId);

    if (!settings?.provider || !settings.key_enc) throw new AiRouteError(400, 'AI_NOT_CONFIGURED', NOT_CONFIGURED);
    let apiKey;

    try {
      apiKey = (await getVault()).decrypt(workspaceId, settings.key_enc);
    } catch {
      throw new AiRouteError(400, 'AI_KEY_UNREADABLE', 'The stored AI API key can no longer be read. Re-enter it in Settings > AI.');
    }
    return { settings, provider: settings.provider, apiKey };
  }

  async function providerModels(workspaceId, aiContext) {
    const cacheKey = `${workspaceId}:${aiContext.provider}:${aiContext.settings.key_enc.last4}`;
    const cached = modelCache.get(cacheKey);

    if (cached && Date.now() - cached.at < modelCacheTtlMs) return cached.models;
    const models = await provider.listModels({ provider: aiContext.provider, apiKey: aiContext.apiKey });

    modelCache.set(cacheKey, { at: Date.now(), models });
    return models;
  }

  const clearModelCache = (workspaceId) => {
    for (const key of modelCache.keys()) if (key.startsWith(`${workspaceId}:`)) modelCache.delete(key);
  };

  async function resolveModel(workspaceId, aiContext, requested) {
    const { settings } = aiContext;
    const name = String(requested ?? '').trim();

    if (['', 'auto', 'default'].includes(name.toLowerCase())) {
      const fallback = settings.model ?? settings.enabled_models?.[0];

      if (!fallback) throw new AiRouteError(400, 'AI_NO_MODEL', 'No default model is selected. Choose one in Settings > AI.');
      return fallback;
    }
    if (name.length > MAX_MODEL_LENGTH) throw new AiRouteError(400, 'AI_BAD_MODEL', 'The model name is too long.');
    if (name === settings.model) return name;
    if (settings.enabled_models?.length) {
      if (settings.enabled_models.includes(name)) return name;
      throw new AiRouteError(400, 'AI_MODEL_NOT_ENABLED', 'That model is not enabled for this workspace.');
    }
    try {
      if ((await providerModels(workspaceId, aiContext)).some((model) => model.id === name)) return name;
    } catch {
      return name;
    }
    throw new AiRouteError(400, 'AI_MODEL_NOT_ENABLED', 'That model is not available for this API key.');
  }

  const requireManager = (res, access) => {
    if (['owner', 'admin'].includes(access.membership.role)) return true;
    sendError(res, 403, 'AI_SETTINGS_FORBIDDEN', 'Only workspace owners and admins can manage AI settings.');
    return false;
  };

  const cleanKey = (value) => {
    if (typeof value !== 'string') return null;
    const key = value.trim();

    return key.length >= 1 && key.length <= 512 && !/\s/.test(key) ? key : null;
  };

  async function handleSettings({ req, res, method, parts, access }) {
    if (!requireManager(res, access)) return true;
    const workspaceId = access.workspace.id;
    const sub = parts[4];

    if (!sub && method === 'GET') {
      sendData(res, settingsView(await store.getAiSettings(workspaceId)));
      return true;
    }
    if (!sub && method === 'DELETE') {
      await store.deleteAiSettings(workspaceId);
      clearModelCache(workspaceId);
      sendData(res, settingsView(null));
      return true;
    }
    if (!sub && method === 'PUT') {
      const input = await readJson(req);
      const unknown = Object.keys(input).filter((key) => !['provider', 'api_key', 'model', 'enabled_models'].includes(key));

      if (unknown.length) return sendError(res, 400, 'INVALID_INPUT', `Unsupported fields: ${unknown.join(', ')}`), true;
      if (!AI_PROVIDERS.includes(input.provider)) return sendError(res, 400, 'INVALID_INPUT', `provider must be one of ${AI_PROVIDERS.join(', ')}`), true;
      if (input.api_key !== undefined && cleanKey(input.api_key) === null) return sendError(res, 400, 'INVALID_INPUT', 'The API key must be 1-512 characters with no spaces.'), true;
      if (input.model !== undefined && input.model !== null && (typeof input.model !== 'string' || input.model.length > MAX_MODEL_LENGTH)) return sendError(res, 400, 'INVALID_INPUT', 'model must be a string of at most 200 characters'), true;
      if (input.enabled_models !== undefined && (!Array.isArray(input.enabled_models) || input.enabled_models.length > 200 ||
        input.enabled_models.some((model) => typeof model !== 'string' || !model || model.length > MAX_MODEL_LENGTH))) {
        return sendError(res, 400, 'INVALID_INPUT', 'enabled_models must be at most 200 model names'), true;
      }
      const existing = await store.getAiSettings(workspaceId);
      const providerChanged = !existing || existing.provider !== input.provider;
      const apiKey = input.api_key === undefined ? null : cleanKey(input.api_key);

      if ((providerChanged || !existing?.key_enc) && !apiKey) return sendError(res, 400, 'INVALID_INPUT', 'An API key is required when setting or changing the provider.'), true;
      const saved = await store.saveAiSettings(workspaceId, {
        provider: input.provider,
        keyEnc: apiKey ? (await getVault()).encrypt(workspaceId, apiKey) : undefined,
        model: input.model !== undefined ? input.model : providerChanged ? null : existing.model,
        enabledModels: input.enabled_models !== undefined ? [...new Set(input.enabled_models)] : providerChanged ? [] : existing.enabled_models,
        updatedBy: access.user.id,
      });

      clearModelCache(workspaceId);
      sendData(res, settingsView(saved));
      return true;
    }
    if (sub === 'test' && method === 'POST') {
      const input = await readJson(req);
      const stored = await store.getAiSettings(workspaceId);
      const testProvider = input.provider ?? stored?.provider;
      let apiKey = input.api_key !== undefined ? cleanKey(input.api_key) : null;

      if (!AI_PROVIDERS.includes(testProvider)) return sendError(res, 400, 'INVALID_INPUT', 'Choose a provider to test.'), true;
      if (input.api_key !== undefined && !apiKey) return sendError(res, 400, 'INVALID_INPUT', 'The API key must be 1-512 characters with no spaces.'), true;
      if (!apiKey && stored?.key_enc && stored.provider === testProvider) {
        try { apiKey = (await getVault()).decrypt(workspaceId, stored.key_enc); } catch { /* handled below */ }
      }
      if (!apiKey) return sendError(res, 400, 'INVALID_INPUT', 'Enter an API key to test.'), true;
      try {
        sendData(res, await provider.testKey({ provider: testProvider, apiKey }));
      } catch (error) {
        const failure = error instanceof AiProviderError ? error : new AiProviderError('unavailable');

        sendError(res, 400, `AI_${failure.kind.toUpperCase()}`, failure.message);
      }
      return true;
    }
    // Lists models with the key typed into the panel (or the stored one), so the model
    // picker can fill in right after "Test key", before anything is saved.
    if (sub === 'models' && method === 'POST') {
      const input = await readJson(req);
      const stored = await store.getAiSettings(workspaceId);
      const modelsProvider = input.provider ?? stored?.provider;
      let apiKey = input.api_key !== undefined ? cleanKey(input.api_key) : null;

      if (!AI_PROVIDERS.includes(modelsProvider)) return sendError(res, 400, 'INVALID_INPUT', 'Choose a provider first.'), true;
      if (input.api_key !== undefined && !apiKey) return sendError(res, 400, 'INVALID_INPUT', 'The API key must be 1-512 characters with no spaces.'), true;
      if (!apiKey && stored?.key_enc && stored.provider === modelsProvider) {
        try { apiKey = (await getVault()).decrypt(workspaceId, stored.key_enc); } catch { /* handled below */ }
      }
      if (!apiKey) return sendError(res, 400, 'INVALID_INPUT', 'Enter an API key to load models.'), true;
      try {
        sendData(res, { models: await provider.listModels({ provider: modelsProvider, apiKey }) });
      } catch (error) {
        const failure = error instanceof AiProviderError ? error : new AiProviderError('unavailable');

        sendError(res, 400, `AI_${failure.kind.toUpperCase()}`, failure.message);
      }
      return true;
    }
    if (sub === 'models' && method === 'GET') {
      try {
        const aiContext = await loadAiContext(workspaceId);

        sendData(res, { models: await providerModels(workspaceId, aiContext) });
      } catch (error) {
        if (error instanceof AiRouteError) sendError(res, error.status, error.errorCode, error.message);
        else if (error instanceof AiProviderError) sendError(res, 400, `AI_${error.kind.toUpperCase()}`, error.message);
        else throw error;
      }
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ model list
  async function handleModelList({ res, access }) {
    const workspaceId = access.workspace.id;
    const settings = await store.getAiSettings(workspaceId);
    const auto = {
      name: 'Auto',
      provider: settings?.provider ?? '',
      metadata: { is_default: true, desc: settings?.model ? `Uses the workspace default model (${settings.model})` : 'Uses the workspace default model' },
    };

    if (!settings?.key_enc) return sendData(res, { models: [auto] });
    let names = new Map();

    try {
      const aiContext = await loadAiContext(workspaceId);
      const listed = await providerModels(workspaceId, aiContext);

      names = new Map(listed.map((model) => [model.id, model.name]));
      const ids = settings.enabled_models?.length ? settings.enabled_models : listed.map((model) => model.id);

      sendData(res, { models: [auto, ...ids.map((id) => modelEntry(settings, id, names))] });
    } catch {
      const ids = settings.enabled_models?.length ? settings.enabled_models : settings.model ? [settings.model] : [];

      sendData(res, { models: [auto, ...ids.map((id) => modelEntry(settings, id, names))] });
    }
    return undefined;
  }

  const modelEntry = (settings, id, names) => ({
    name: id,
    provider: settings.provider,
    metadata: { is_default: false, desc: names.get(id) && names.get(id) !== id ? names.get(id) : '' },
  });

  // ------------------------------------------------------------- streaming
  const toProviderError = (error) => (error instanceof AiProviderError ? error : new AiProviderError('unavailable'));

  // Forwards provider text as upstream-compatible frames: one JSON object per line, `"1"` = text delta.
  async function streamAnswer({ res, aiContext, model, messages, system, maxTokens, release, sources = [] }) {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    let started = false;

    res.on('close', onClose);
    try {
      for await (const delta of provider.streamChat({
        provider: aiContext.provider, apiKey: aiContext.apiKey, model, messages, system, maxTokens: Math.min(maxTokens, maxOutputTokens), signal: controller.signal,
      })) {
        if (!started) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
          started = true;
          // The pages and cards the answer drew on, shown as source chips under it.
          if (sources.length) res.write(`${JSON.stringify({ 0: sources })}\n`);
        }
        res.write(`${JSON.stringify({ 1: delta })}\n`);
      }
      res.end();
      helpers.logApiResponse(res, 200);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof AiProviderError)) {
        helpers.logApiResponse(res, 499);
        return;
      }
      const failure = toProviderError(error);

      if (!started) sendError(res, failure.httpStatus, `AI_${failure.kind.toUpperCase()}`, failure.message, failure.retryAfterSecs ? { 'retry-after': String(failure.retryAfterSecs) } : {});
      else {
        res.write(`${JSON.stringify({ code: failure.httpStatus, message: failure.message })}\n`);
        res.end();
        helpers.logApiResponse(res, 200);
      }
    } finally {
      res.off('close', onClose);
      release();
    }
  }

  async function completeText({ res, aiContext, model, messages, system, maxTokens }) {
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };

    res.on('close', onClose);
    try {
      return await provider.completeChat({
        provider: aiContext.provider, apiKey: aiContext.apiKey, model, messages, system, maxTokens: Math.min(maxTokens, maxOutputTokens), signal: controller.signal,
      });
    } finally {
      res.off('close', onClose);
    }
  }

  const headerModel = (req) => req.headers['ai-model'];

  async function handleWriter({ req, res, access }) {
    const input = await readJson(req);
    const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};

    if (typeof input.text !== 'string' || input.text.length > 100_000) return sendError(res, 400, 'INVALID_INPUT', 'text is required (at most 100,000 characters).');
    if (!isCompletionType(input.completion_type)) return sendError(res, 400, 'INVALID_INPUT', 'completion_type must be an integer from 1 to 8.');
    const history = Array.isArray(metadata.completion_history) ? metadata.completion_history.filter((turn) => turn && typeof turn.content === 'string' && turn.content.length <= 50_000) : [];
    const customSystem = typeof metadata.custom_prompt?.system === 'string' ? metadata.custom_prompt.system.slice(0, 20_000) : undefined;
    const release = acquire(access.workspace.id, access.user.id);

    try {
      const aiContext = await loadAiContext(access.workspace.id);
      const model = await resolveModel(access.workspace.id, aiContext, headerModel(req));
      const { system, messages } = buildWriterPrompt({ type: input.completion_type, text: input.text, history, customSystem });

      await streamAnswer({ res, aiContext, model, messages, system, maxTokens: maxOutputTokens, release });
    } catch (error) {
      release();
      throw error;
    }
    return undefined;
  }

  // -------------------------------------------------------- row summarize/translate
  async function handleSummarizeRow({ req, res, access }) {
    const input = await readJson(req);
    const content = input.data?.Content;

    if (!content || typeof content !== 'object' || Array.isArray(content) || Object.values(content).some((value) => typeof value !== 'string')) {
      return sendError(res, 400, 'INVALID_INPUT', 'data.Content must be an object of field names to text.');
    }
    const serialized = JSON.stringify(content);

    if (serialized.length > 50_000) return sendError(res, 400, 'INVALID_INPUT', 'The row is too large to summarize.');
    const release = acquire(access.workspace.id, access.user.id);

    try {
      const aiContext = await loadAiContext(access.workspace.id);
      const model = await resolveModel(access.workspace.id, aiContext, headerModel(req));
      const text = await completeText({ res, aiContext, model, system: SUMMARIZE_ROW_SYSTEM, messages: [{ role: 'user', content: serialized }], maxTokens: 512 });

      sendData(res, { text: text.trim() });
    } finally {
      release();
    }
    return undefined;
  }

  async function handleTranslateRow({ req, res, access }) {
    const input = await readJson(req);
    const data = input.data ?? {};
    const cells = data.cells;

    if (!Array.isArray(cells) || cells.length === 0 || cells.length > 100 || cells.some((cell) => !cell || typeof cell.title !== 'string' || typeof cell.content !== 'string')) {
      return sendError(res, 400, 'INVALID_INPUT', 'data.cells must be 1-100 {title, content} entries.');
    }
    if (typeof data.language !== 'string' || !data.language.trim() || data.language.length > 100) return sendError(res, 400, 'INVALID_INPUT', 'data.language is required.');
    const includeHeader = data.include_header === true;
    const payload = cells.map((cell) => (includeHeader ? `${cell.title}: ${cell.content}` : cell.content));

    if (JSON.stringify(payload).length > 50_000) return sendError(res, 400, 'INVALID_INPUT', 'The row is too large to translate.');
    const release = acquire(access.workspace.id, access.user.id);

    try {
      const aiContext = await loadAiContext(access.workspace.id);
      const model = await resolveModel(access.workspace.id, aiContext, headerModel(req));
      const text = await completeText({
        res, aiContext, model, system: translateRowPrompt({ language: data.language.trim(), includeHeader }),
        messages: [{ role: 'user', content: JSON.stringify(payload) }], maxTokens: 2048,
      });
      const parsed = parseJsonStringArray(text);
      const translated = parsed ?? (cells.length === 1 ? [text.trim()] : null);

      if (!translated) throw new AiProviderError('empty', 'The model returned an unexpected translation format. Try again.');
      sendData(res, { items: cells.map((cell, index) => ({ title: cell.title, content: translated[index] ?? '' })) });
    } finally {
      release();
    }
    return undefined;
  }

  // ------------------------------------------------------------------ chat
  async function chatFor(res, access, chatId) {
    if (!UUID.test(chatId)) {
      sendError(res, 400, 'INVALID_INPUT', 'Invalid chat id.');
      return { failed: true };
    }
    const chat = await store.getAiChat(chatId);

    // Card chats are private to the person who started them; anyone else gets the same answer as for a missing chat.
    if (chat && (chat.workspace_id !== access.workspace.id || (chat.metadata?.scope === 'card' && chat.created_by !== access.user.id))) {
      sendError(res, 404, 'CHAT_NOT_FOUND', 'Chat not found.');
      return { failed: true };
    }
    return { chat };
  }

  const isReadableSpacePermission = (permission) => helpers.isSupportedPublicSpacePermission(permission);
  const cardContextFor = (access, chat) => buildCardContext(store, access.workspace.id, chat.metadata?.database_id, chat.metadata?.row_id, { isReadableSpacePermission });
  const CARD_KEYS = ['scope', 'database_id', 'row_id'];

  // Validates a settings POST that touches the card scope. Returns an error message, or null when it is fine
  // (and removes a chat that squatted on the caller's reserved id).
  async function checkCardScope(access, chatId, chat, metadata) {
    if (!CARD_KEYS.some((key) => key in metadata)) return null;
    if (chat?.metadata?.scope === 'card') {
      return CARD_KEYS.some((key) => key in metadata && metadata[key] !== chat.metadata[key]) ? { status: 400, message: 'The card of a card chat cannot be changed.' } : null;
    }
    if (metadata.scope !== 'card') return null;
    if (!isUuid(metadata.database_id) || !isUuid(metadata.row_id)) return { status: 400, message: 'A card chat needs database_id and row_id.' };
    if (chatId !== cardChatId(access.workspace.id, metadata.row_id, access.user.id)) return { status: 400, message: 'Invalid card chat id.' };
    if (!(await buildCardContext(store, access.workspace.id, metadata.database_id, metadata.row_id, { isReadableSpacePermission }))) return { status: 404, message: 'Card not found.' };
    // The derived id is reserved for this user; a plain chat someone ELSE created on it first must not block the real one
    // (the user's own earlier plain chat is simply upgraded in place).
    if (chat && chat.created_by !== access.user.id) await store.deleteAiChat(chatId);
    return null;
  }

  async function ensureChat(access, chatId) {
    const result = await store.upsertAiChat(access.workspace.id, chatId, {}, access.user.id);

    return result.conflict ? null : result.chat;
  }

  async function handleChat({ req, res, method, parts, url, access }) {
    const chatId = parts[3];
    const sub = parts[4];
    const { chat, failed } = await chatFor(res, access, chatId);

    if (failed) return;
    // Clears a chat and its history. Only the creator may do it; a missing chat is already clear.
    if (parts.length === 4 && method === 'DELETE') {
      if (chat && chat.created_by !== access.user.id) return sendError(res, 404, 'CHAT_NOT_FOUND', 'Chat not found.');
      if (chat) await store.deleteAiChat(chatId);
      sendData(res, null);
      return;
    }
    if (sub === 'settings' && parts.length === 5) {
      if (method === 'GET') {
        sendData(res, chat
          ? { name: chat.name, rag_ids: chat.rag_ids, metadata: chat.metadata, full_workspace: chat.full_workspace, web_search_enabled: chat.web_search_enabled }
          : { name: '', rag_ids: [], metadata: {}, full_workspace: false, web_search_enabled: false });
        return;
      }
      if (method === 'POST') {
        const input = await readJson(req);

        if ((input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 500)) ||
            (input.rag_ids !== undefined && (!Array.isArray(input.rag_ids) || input.rag_ids.length > 500 || input.rag_ids.some((id) => typeof id !== 'string' || id.length > 200))) ||
            (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata) || JSON.stringify(input.metadata).length > 50_000)) ||
            (input.full_workspace !== undefined && typeof input.full_workspace !== 'boolean') ||
            (input.web_search_enabled !== undefined && typeof input.web_search_enabled !== 'boolean')) {
          return sendError(res, 400, 'INVALID_INPUT', 'Invalid chat settings.');
        }
        const scopeProblem = input.metadata ? await checkCardScope(access, chatId, chat, input.metadata) : null;

        if (scopeProblem) return sendError(res, scopeProblem.status, scopeProblem.status === 404 ? 'CARD_NOT_FOUND' : 'INVALID_INPUT', scopeProblem.message);
        const result = await store.upsertAiChat(access.workspace.id, chatId, input, access.user.id);

        if (result.conflict) return sendError(res, 404, 'CHAT_NOT_FOUND', 'Chat not found.');
        sendData(res, null);
        return;
      }
    }
    if (sub === 'message' && parts.length === 5 && method === 'GET') {
      const page = chat
        ? await store.listAiChatMessages(chatId, {
          limit: intParam(url.searchParams.get('limit')), offset: intParam(url.searchParams.get('offset')),
          before: intParam(url.searchParams.get('before')), after: intParam(url.searchParams.get('after')),
        })
        : { messages: [], has_more: false, total: 0 };

      sendData(res, page);
      return;
    }
    if (sub === 'message' && parts[5] === 'question' && parts.length === 6 && method === 'POST') {
      const input = await readJson(req);

      if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 32_000) return sendError(res, 400, 'INVALID_INPUT', 'The question must be 1-32,000 characters.');
      if (!(await ensureChat(access, chatId))) return sendError(res, 404, 'CHAT_NOT_FOUND', 'Chat not found.');
      sendData(res, await store.addAiChatQuestion(chatId, { authorUuid: access.user.id, content: input.content, metaData: [] }));
      return;
    }
    if (sub === 'message' && parts[5] === 'answer' && parts.length === 6 && method === 'POST') {
      const input = await readJson(req);

      if (!Number.isInteger(input.question_message_id) || typeof input.content !== 'string' || input.content.length > 200_000 ||
          (input.meta_data !== undefined && (!Array.isArray(input.meta_data) || JSON.stringify(input.meta_data).length > 100_000))) {
        return sendError(res, 400, 'INVALID_INPUT', 'Invalid answer.');
      }
      const saved = chat ? await store.saveAiChatAnswer(chatId, input.question_message_id, { content: input.content, metaData: input.meta_data ?? [] }) : null;

      if (!saved) return sendError(res, 404, 'QUESTION_NOT_FOUND', 'Question not found.');
      sendData(res, saved);
      return;
    }
    if (sub === 'answer' && parts[5] === 'stream' && parts.length === 6 && method === 'POST') {
      await handleAnswerStream({ req, res, access, chat, chatId });
      return;
    }
    if (parts[5] === 'related_question' && parts.length === 6 && method === 'GET') {
      await handleRelatedQuestions({ req, res, access, chat, chatId, questionId: Number(parts[4]) });
      return;
    }
    sendError(res, 404, 'NOT_FOUND', 'Route not found');
  }

  // Oldest-first turns ending with the question, trimmed from the oldest end to the budget.
  function conversationFrom(messagesNewestFirst) {
    const turns = [];
    let used = 0;

    for (const message of messagesNewestFirst) {
      if (![1, 3].includes(message.author.author_type) || !message.content) continue;
      if (turns.length > 0 && used + message.content.length > CHAT_HISTORY_CHAR_BUDGET) break;
      used += message.content.length;
      turns.push({ role: message.author.author_type === 1 ? 'user' : 'assistant', content: message.content });
    }
    return turns.reverse();
  }

  async function handleAnswerStream({ req, res, access, chat, chatId }) {
    const input = await readJson(req);

    if (!Number.isInteger(input.question_id)) return sendError(res, 400, 'INVALID_INPUT', 'question_id is required.');
    const question = chat ? await store.getAiChatMessage(chatId, input.question_id) : null;

    if (!question || question.author.author_type !== 1) return sendError(res, 404, 'QUESTION_NOT_FOUND', 'Question not found.');
    const release = acquire(access.workspace.id, access.user.id);

    try {
      const aiContext = await loadAiContext(access.workspace.id);
      const requested = headerModel(req) && String(headerModel(req)).toLowerCase() !== 'auto' ? headerModel(req) : input.model_name ?? chat.metadata?.ai_model;
      const model = await resolveModel(access.workspace.id, aiContext, typeof requested === 'string' ? requested : undefined);
      const history = await store.listAiChatMessages(chatId, { limit: 100, before: question.message_id + 1 });
      let system = CHAT_SYSTEM;

      if (chat.metadata?.scope === 'card') {
        // Rebuilt from the stored card on every question; nothing the client sends is used as context.
        const cardContext = await cardContextFor(access, chat);

        if (!cardContext) {
          await store.deleteAiChat(chatId);
          throw new AiRouteError(404, 'CARD_NOT_FOUND', 'This card is no longer available.');
        }
        system = cardChatSystem(cardContext);
      }
      let sources = [];

      if (chat.metadata?.scope !== 'card' && chat.metadata?.workspace_context !== false) {
        // Searched on the server, by what the asker may read. Failure to search must not stop the chat answering.
        try {
          // history.messages is newest first; questions are wanted oldest to newest.
          const turns = history.messages.filter((message) => message.author.author_type === 1).map((message) => message.content).reverse();
          const built = await buildWorkspaceContext({
            knowledge: helpers.getKnowledge(), workspaceId: access.workspace.id, workspaceName: access.workspace.name,
            questions: turns, chat: { ...chat, chat_id: chatId }, timeZone: helpers.timeZone ?? 'UTC',
          });

          system = built.system;
          sources = built.sources;
        } catch (contextError) {
          console.warn('[ai] workspace context failed:', contextError?.message);
        }
      }
      await streamAnswer({ res, aiContext, model, system, messages: conversationFrom(history.messages), maxTokens: maxOutputTokens, release, sources });
    } catch (error) {
      release();
      throw error;
    }
  }

  async function handleRelatedQuestions({ res, access, chat, chatId, questionId }) {
    const empty = { message_id: String(questionId), items: [] };
    const question = chat && Number.isInteger(questionId) ? await store.getAiChatMessage(chatId, questionId) : null;

    if (!question) return sendError(res, 404, 'QUESTION_NOT_FOUND', 'Question not found.');
    let release;

    try {
      release = acquire(access.workspace.id, access.user.id);
      let cardContext = null;

      if (chat.metadata?.scope === 'card') {
        cardContext = await cardContextFor(access, chat);
        if (!cardContext) {
          await store.deleteAiChat(chatId);
          release();
          release = undefined;
          return sendError(res, 404, 'CARD_NOT_FOUND', 'This card is no longer available.');
        }
      }
      const aiContext = await loadAiContext(access.workspace.id);
      const model = await resolveModel(access.workspace.id, aiContext, undefined);
      const upTo = question.reply_message_id ? question.reply_message_id + 1 : question.message_id + 1;
      const history = await store.listAiChatMessages(chatId, { limit: 6, before: upTo });
      const text = await completeText({
        res, aiContext, model, maxTokens: 256, messages: conversationFrom(history.messages),
        system: cardContext ? `${RELATED_QUESTIONS_SYSTEM}\nThe questions must be answerable from this card only:\n<card_data>\n${cardContext.replace(/<\/?card_data>/gi, '')}\n</card_data>` : RELATED_QUESTIONS_SYSTEM,
      });
      const items = (parseJsonStringArray(text) ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 3);

      sendData(res, { message_id: String(questionId), items: items.map((content) => ({ content })) });
    } catch {
      sendData(res, empty);
    } finally {
      release?.();
    }
    return undefined;
  }

  // ----------------------------------------------------------------- routing
  async function handle({ req, res, url, parts, method }) {
    if (parts[0] !== 'api') return false;
    const isSettings = parts[1] === 'workspace' && parts[3] === 'ai-settings' && parts.length >= 4 && parts.length <= 5;
    const isAi = parts[1] === 'ai' && parts[2];
    const isChat = parts[1] === 'chat' && parts[2] && parts[3];

    if (!isSettings && !isAi && !isChat) return false;
    const workspaceId = isSettings ? parts[2] : parts[2];
    const route = isSettings ? 'settings' : isAi ? `ai:${method}:${parts.slice(3).join('/')}` : 'chat';
    const aiRoutes = new Set(['ai:GET:model/list', 'ai:POST:v2/complete/stream', 'ai:POST:complete/stream', 'ai:POST:summarize_row', 'ai:POST:translate_row']);

    if (route.startsWith('ai:') && !aiRoutes.has(route)) return false;
    if (isSettings && !['GET', 'PUT', 'DELETE', 'POST'].includes(method)) return false;

    const access = await helpers.requireWorkspace(store, req, res, workspaceId);

    if (!access) return true;
    try {
      const context = { req, res, url, parts, method, access };

      if (route === 'settings') {
        if (!(await handleSettings(context))) sendError(res, 404, 'NOT_FOUND', 'Route not found');
      } else if (route === 'ai:GET:model/list') await handleModelList(context);
      else if (route === 'ai:POST:v2/complete/stream' || route === 'ai:POST:complete/stream') await handleWriter(context);
      else if (route === 'ai:POST:summarize_row') await handleSummarizeRow(context);
      else if (route === 'ai:POST:translate_row') await handleTranslateRow(context);
      else await handleChat(context);
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return true;
      }
      if (error instanceof AiRouteError) sendError(res, error.status, error.errorCode, error.message, error.headers);
      else if (error instanceof AiProviderError) sendError(res, error.httpStatus, `AI_${error.kind.toUpperCase()}`, error.message);
      else throw error;
    }
    return true;
  }

  // Chats are keyed by their page id; drop the chat when its page is permanently deleted.
  function attachChatCleanup() {
    const original = store.deletePagePermanently?.bind(store);

    if (!original) return;
    store.deletePagePermanently = async (pageId, workspaceId) => {
      const page = await store.getPage(pageId);
      const deleted = await original(pageId, workspaceId);

      if (deleted) {
        const chat = await store.getAiChat(pageId);

        if (chat && chat.workspace_id === workspaceId) await store.deleteAiChat(pageId);
        // A permanently deleted database takes every card chat of its rows with it.
        if (page?.extra?.is_database_container === true && page.extra.database_id) await store.deleteAiChatsByDatabase(workspaceId, page.extra.database_id);
      }
      return deleted;
    };
  }

  return { handle, attachChatCleanup, getVault };
}
