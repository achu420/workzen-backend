// scripts/mcp-stdio-shim.mjs: spawned as a real process against local HTTP servers.
// Covers framing, header derivation, SSE, HTTP/network failures, stdout purity, token secrecy,
// graceful exit, and an end-to-end run through the real MCP handler.
// Evidence class: real process + real HTTP; NOT tested with a real MCP client.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WRITE_TOKEN, modern, startMcp } from './helpers/mcp-test-kit.js';

const SHIM = fileURLToPath(new URL('../scripts/mcp-stdio-shim.mjs', import.meta.url));
const TOKEN = 'afmcp_shim_supersecretvalue';
const seen = (headers) => ({ authorization: headers.authorization, accept: headers.accept, 'content-type': headers['content-type'], version: headers['mcp-protocol-version'], method: headers['mcp-method'], name: headers['mcp-name'] });

// A programmable stub MCP server: behaviour is chosen by the JSON-RPC method of each request.
async function startStub() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';

    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      const reply = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

      requests.push({ message, headers: seen(req.headers) });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: `Invalid token ${req.headers.authorization?.slice(7)}` } });
      switch (message.method) {
        case 'initialize': return reply(200, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub' } } });
        case 'notifications/initialized': res.writeHead(202); return res.end();
        case 'sse': return reply(200, `: keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"streamed":true}}\n\n`, 'text/event-stream');
        case 'html500': return reply(500, '<html>Bad gateway</html>', 'text/html');
        case 'rpc400': return reply(400, { jsonrpc: '2.0', id: message.id, error: { code: -32020, message: 'Header mismatch' } });
        case 'rpc400nullid': return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
        case 'empty200': return reply(200, '');
        case 'notify-error': return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'nope' } });
        case 'slow': return setTimeout(() => reply(200, { jsonrpc: '2.0', id: message.id, result: { slow: true } }), 300);
        default: return reply(200, { jsonrpc: '2.0', id: message.id, result: { method: message.method } });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

function runShim({ url, token = TOKEN, lines = [], closeStdin = true, env = {}, afterWrite } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM], { env: { PATH: process.env.PATH, MCP_URL: url, MCP_TOKEN: token, MCP_TIMEOUT_MS: '5000', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`shim did not exit; stdout=${stdout} stderr=${stderr}`)); }, 15000);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const outLines = stdout.split('\n').filter(Boolean);

      resolve({ code, signal, stdout, stderr, lines: outLines.map((line) => JSON.parse(line)), rawLines: outLines });
    });
    for (const line of lines) child.stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
    if (afterWrite) afterWrite(child);
    if (closeStdin) child.stdin.end();
  });
}

const rpc = (method, id, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

function assertClean(result, token = TOKEN) {
  assert.ok(!result.stdout.includes(token), 'the token is never written to stdout');
  assert.ok(!result.stderr.includes(token), 'the token is never written to stderr');
  for (const line of result.rawLines) {
    const parsed = JSON.parse(line); // throws on a non-JSON line

    assert.equal(parsed.jsonrpc, '2.0', 'stdout carries only JSON-RPC messages');
    assert.ok(!line.includes('\n'));
  }
}

test('framing: replies are single lines in order, 202 notifications are dropped, exit code 0 on stdin end', async () => {
  const stub = await startStub();

  try {
    const result = await runShim({ url: stub.url, lines: [rpc('initialize', 1, { protocolVersion: '2025-06-18' }), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list', 'two')] });

    assert.equal(result.code, 0);
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].id, 1);
    assert.equal(result.lines[1].id, 'two');
    assert.deepEqual(stub.requests.map((r) => r.message.method), ['initialize', 'notifications/initialized', 'tools/list'], 'requests are forwarded in order');
    assertClean(result);
  } finally {
    await stub.close();
  }
});

test('headers: bearer token and Accept always, modern headers from _meta, the negotiated legacy version afterwards', async () => {
  const stub = await startStub();

  try {
    const modernMessage = modern('tools/call', { name: 'get_card', arguments: { card_id: 'c-1' } }, 5).body;
    const unicodeName = modern('tools/call', { name: 'carte-é', arguments: {} }, 6).body;
    const result = await runShim({ url: stub.url, lines: [modernMessage, unicodeName, rpc('initialize', 7, { protocolVersion: '2025-06-18' }), rpc('tools/list', 8)] });

    assert.equal(result.code, 0);
    const [first, second, init, afterInit] = stub.requests.map((r) => r.headers);

    assert.equal(first.authorization, `Bearer ${TOKEN}`);
    assert.equal(first.accept, 'application/json, text/event-stream');
    assert.equal(first['content-type'], 'application/json');
    assert.equal(first.version, '2026-07-28');
    assert.equal(first.method, 'tools/call');
    assert.equal(first.name, 'get_card');
    assert.equal(second.name, `=?base64?${Buffer.from('carte-é', 'utf8').toString('base64')}?=`, 'non-ASCII names use the base64 sentinel');
    assert.equal(init.version, undefined, 'initialize carries no version header');
    assert.equal(init.method, undefined, 'legacy requests carry no Mcp-Method header');
    assert.equal(afterInit.version, '2025-06-18', 'later legacy requests carry the negotiated version');
    assertClean(result);
  } finally {
    await stub.close();
  }
});

test('an SSE response is unpacked into one stdout line per JSON-RPC message', async () => {
  const stub = await startStub();

  try {
    const result = await runShim({ url: stub.url, lines: [rpc('sse', 'stream-1')] });

    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].method, 'notifications/message');
    assert.deepEqual(result.lines[1], { jsonrpc: '2.0', id: 'stream-1', result: { streamed: true } });
    assertClean(result);
  } finally {
    await stub.close();
  }
});

test('HTTP failures become JSON-RPC errors for the original request id, so the client never hangs', async () => {
  const stub = await startStub();

  try {
    const result = await runShim({ url: stub.url, lines: [rpc('html500', 1), rpc('rpc400', 2), rpc('rpc400nullid', 3), rpc('empty200', 4), { jsonrpc: '2.0', method: 'notify-error' }, rpc('ping', 5)] });

    assert.equal(result.code, 0);
    assert.equal(result.lines.length, 5, 'the failed notification produces no stdout message');
    const byId = Object.fromEntries(result.lines.map((line) => [line.id, line]));

    assert.equal(byId[1].error.code, -32000);
    assert.match(byId[1].error.message, /HTTP 500/);
    assert.deepEqual(byId[2].error, { code: -32020, message: 'Header mismatch' }, 'a JSON-RPC error body with a matching id is forwarded');
    assert.deepEqual(byId[3].error, { code: -32600, message: 'Invalid request' }, 'a null-id error is re-addressed to the original request');
    assert.match(byId[4].error.message, /empty/);
    assert.equal(byId[5].result.method, 'ping', 'processing continues after failures');
    assert.match(result.stderr, /notification.*HTTP 400/, 'a rejected notification is reported on stderr only');
    assertClean(result);
  } finally {
    await stub.close();
  }
});

test('a wrong token gives a JSON-RPC error that does not contain the token', async () => {
  const stub = await startStub();
  const wrong = 'afmcp_wrong_differentsecret';

  try {
    const result = await runShim({ url: stub.url, token: wrong, lines: [rpc('tools/list', 1)] });

    assert.equal(result.lines[0].id, 1);
    assert.equal(result.lines[0].error.code, -32001);
    assert.match(result.lines[0].error.message, /\[redacted\]/);
    assertClean(result, wrong);
  } finally {
    await stub.close();
  }
});

test('an unreachable server: requests get an error reply, notifications are silent, exit code 0', async () => {
  const result = await runShim({ url: 'http://127.0.0.1:1/mcp', lines: [rpc('tools/list', 'a'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('ping', 'b')] });

  assert.equal(result.code, 0);
  assert.deepEqual(result.lines.map((line) => line.id), ['a', 'b']);
  assert.ok(result.lines.every((line) => line.error.code === -32000 && /Could not reach/.test(line.error.message)));
  assertClean(result);
});

test('invalid JSON on stdin gets a parse error and the shim keeps going', async () => {
  const stub = await startStub();

  try {
    const result = await runShim({ url: stub.url, lines: ['{not json', '', '   ', rpc('ping', 9)] });

    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].error.code, -32700);
    assert.equal(result.lines[0].id, null);
    assert.equal(result.lines[1].id, 9);
    assert.equal(stub.requests.length, 1, 'the garbage line was not forwarded');
    assertClean(result);
  } finally {
    await stub.close();
  }
});

test('stdin ending while a request is in flight still delivers the reply before exiting 0', async () => {
  const stub = await startStub();

  try {
    const result = await runShim({ url: stub.url, lines: [rpc('slow', 'late')] });

    assert.equal(result.code, 0);
    assert.deepEqual(result.lines, [{ jsonrpc: '2.0', id: 'late', result: { slow: true } }]);
  } finally {
    await stub.close();
  }
});

test('SIGTERM finishes in-flight work then exits 0', async () => {
  const stub = await startStub();

  try {
    const result = await runShim({ url: stub.url, lines: [rpc('slow', 'term')], closeStdin: false, afterWrite: (child) => setTimeout(() => child.kill('SIGTERM'), 100) });

    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.lines[0].id, 'term');
    assertClean(result);
  } finally {
    await stub.close();
  }
});

test('misconfiguration exits 1 with a clear stderr message and no stdout', async () => {
  for (const env of [{ MCP_URL: '' }, { MCP_URL: 'ftp://example.com/mcp' }, { MCP_URL: 'not a url' }]) {
    const result = await runShim({ url: env.MCP_URL, env });

    assert.equal(result.code, 1, JSON.stringify(env));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /MCP_URL/);
    assert.ok(!result.stderr.includes(TOKEN));
  }
  const noToken = await runShim({ url: 'http://127.0.0.1:1/mcp', token: '' });

  assert.equal(noToken.code, 1);
  assert.match(noToken.stderr, /MCP_TOKEN/);
});

test('end to end through the real MCP handler: legacy and modern flows over stdio', async () => {
  const mcp = await startMcp();

  try {
    const result = await runShim({
      url: mcp.url,
      token: WRITE_TOKEN,
      lines: [
        rpc('initialize', 1, { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'desktop', version: '1' } }),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        rpc('tools/list', 2),
        rpc('tools/call', 3, { name: 'get_card', arguments: { card_id: 'c-1' } }),
        modern('server/discover', {}, 4).body,
        modern('tools/call', { name: 'list_cards', arguments: { database_id: 'db-1', limit: 1 } }, 5).body,
      ],
    });

    assert.equal(result.code, 0);
    assert.deepEqual(result.lines.map((line) => line.id), [1, 2, 3, 4, 5]);
    assert.equal(result.lines[0].result.protocolVersion, '2025-06-18');
    assert.equal(result.lines[1].result.tools.length, 20);
    assert.equal(result.lines[2].result.structuredContent.card.id, 'c-1');
    assert.equal(result.lines[3].result.resultType, 'complete');
    assert.deepEqual(result.lines[3].result.supportedVersions, ['2026-07-28']);
    assert.equal(result.lines[4].result.structuredContent.cards.length, 1);
    assertClean(result, WRITE_TOKEN);
  } finally {
    await mcp.close();
  }
});
