// A fake OpenRouter / OpenAI / Anthropic server for tests. Behaviour is selected by markers
// in the last user message: [[error402]] [[error429]] [[error500]] [[context]] [[midstream]]
// [[empty]] [[slow]]. Everything the server received is kept in `state.requests`.
import http from 'node:http';

export const KEYS = { openrouter: 'sk-or-good', openai: 'sk-good-openai', anthropic: 'sk-ant-good' };

function words(text) {
  return text.split(/(\s+)/).filter(Boolean);
}

// Canned replies keyed off the system prompt, so route tests can assert prompt selection.
export function replyFor(system, lastUser) {
  if (/follow-up questions/i.test(system)) return '["First follow-up?","Second follow-up?","Third follow-up?"]';
  if (/translate database cell values/i.test(system)) {
    try { return JSON.stringify(JSON.parse(lastUser).map((item) => `T:${item}`)); } catch { return '[]'; }
  }
  if (/Summarize it in one or two sentences/i.test(system)) return `Summary of ${lastUser.slice(0, 40)}`;
  return `echo: ${lastUser}`;
}

export async function startFakeAiProvider({ port = 0 } = {}) {
  const state = { requests: [], aborted: 0, active: 0 };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    let raw = '';

    for await (const chunk of req) raw += chunk;
    let body = {};

    try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
    const record = { method: req.method, path: url.pathname, query: url.search, headers: req.headers, body };

    state.requests.push(record);
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const anthropicKey = req.headers['x-api-key'];
    const isAnthropic = anthropicKey !== undefined || url.pathname.endsWith('/messages');
    const isOpenRouter = url.pathname.startsWith('/api/v1/');

    // ---- auth
    if (isAnthropic) {
      if (anthropicKey !== KEYS.anthropic) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    } else if (bearer !== (isOpenRouter ? KEYS.openrouter : KEYS.openai)) {
      return json(401, { error: { code: 401, message: 'Incorrect API key provided' } });
    }

    // ---- model lists and key checks
    if (req.method === 'GET' && url.pathname === '/api/v1/key') return json(200, { data: { label: 'test-key', usage: 0, limit: null } });
    if (req.method === 'GET' && url.pathname === '/api/v1/models') {
      return json(200, { data: [
        { id: 'openai/gpt-test', name: 'GPT Test', context_length: 8000, pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text', 'image'] } },
        { id: 'anthropic/claude-test', name: 'Claude Test', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' }, architecture: { input_modalities: ['text'] } },
      ] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (isAnthropic) return json(200, { data: [{ id: 'claude-test-1', display_name: 'Claude Test 1', max_input_tokens: 200000, capabilities: { image_input: { supported: true } } }, { id: 'claude-text-only', display_name: 'Claude Text', max_input_tokens: 100000, capabilities: { image_input: { supported: false } } }], has_more: false });
      return json(200, { data: [{ id: 'gpt-4o-test' }, { id: 'o3-mini' }, { id: 'gpt-3.5-turbo' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'dall-e-3' }] });
    }

    // ---- chat
    const isChat = req.method === 'POST' && (url.pathname.endsWith('/chat/completions') || url.pathname.endsWith('/messages'));

    if (!isChat) return json(404, { error: { message: 'not found' } });
    const messages = body.messages ?? [];
    const system = isAnthropic ? String(body.system ?? '') : String(messages.find((m) => m.role === 'system')?.content ?? '');
    const lastUser = String([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');

    if (isAnthropic && !req.headers['anthropic-version']) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic-version header required' } });
    if (isAnthropic && !Number.isInteger(body.max_tokens)) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: Field required' } });
    if (lastUser.includes('[[error402]]')) return json(402, { error: { code: 402, message: 'Insufficient credits' } });
    if (lastUser.includes('[[error429]]')) return json(429, { error: { code: 429, message: 'Rate limited' } }, { 'retry-after': '3' });
    if (lastUser.includes('[[error500]]')) return json(500, { error: { message: 'boom' } });
    if (lastUser.includes('[[context]]')) return json(400, isAnthropic ? { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' } } : { error: { message: "This model's maximum context length is 8192 tokens." } });

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    state.active += 1;
    res.on('close', () => {
      state.active -= 1;
      if (!res.writableEnded) state.aborted += 1;
    });
    const sse = (data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    const reply = replyFor(system, lastUser.replace(/\[\[[a-z0-9]+\]\]/g, '').trim());
    const pieces = lastUser.includes('[[empty]]') ? [] : lastUser.includes('[[slow]]') ? ['slow-start'] : lastUser.includes('[[midstream]]') ? ['part', 'ial'] : words(reply);

    if (isAnthropic) {
      sse({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 5 } } }, 'message_start');
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
      sse({ type: 'ping' }, 'ping');
      for (const piece of pieces) sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, 'content_block_delta');
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'ignored' } }, 'content_block_delta');
      if (lastUser.includes('[[slow]]')) return;
      if (lastUser.includes('[[midstream]]')) { sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'); return res.end(); }
      sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }, 'message_delta');
      sse({ type: 'message_stop' }, 'message_stop');
      return res.end();
    }
    res.write(': PROCESSING\n\n');
    for (const piece of pieces) sse({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
    if (lastUser.includes('[[slow]]')) return;
    if (lastUser.includes('[[midstream]]')) {
      sse({ error: { code: 429, message: 'provider overloaded' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
      sse('[DONE]');
      return res.end();
    }
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    sse('[DONE]');
    return res.end();
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    state,
    baseUrls: { openrouter: `${url}/api/v1`, openai: `${url}/v1`, anthropic: `${url}/v1` },
    lastChat: () => [...state.requests].reverse().find((r) => r.method === 'POST'),
    chatRequests: () => state.requests.filter((r) => r.method === 'POST'),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
