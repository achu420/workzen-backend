#!/usr/bin/env node
// stdio <-> HTTP bridge for MCP clients that can only launch local commands (for example
// Claude Desktop). Reads newline-delimited JSON-RPC from stdin, POSTs each message to the
// server's /mcp endpoint with the agent token, and writes each JSON-RPC reply as ONE line
// on stdout. stdout carries only MCP messages; diagnostics go to stderr (token redacted).
//
//   MCP_URL=http://127.0.0.1:8787/mcp MCP_TOKEN=afmcp_... node scripts/mcp-stdio-shim.mjs
import readline from 'node:readline';

const MCP_URL = process.env.MCP_URL;
const TOKEN = process.env.MCP_TOKEN;
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS) || 120000;

const scrub = (value) => (TOKEN ? String(value).split(TOKEN).join('[redacted]') : String(value));
const log = (message) => process.stderr.write(`[mcp-shim] ${scrub(message)}\n`);
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: scrub(message) } });

if (!MCP_URL || !TOKEN) {
  log('MCP_URL and MCP_TOKEN must both be set.');
  process.exit(1);
}
try {
  if (!/^https?:$/.test(new URL(MCP_URL).protocol)) throw new Error('not http(s)');
} catch {
  log('MCP_URL must be an http(s) URL.');
  process.exit(1);
}

process.stdout.on('error', () => process.exit(0)); // the client went away

// Mcp-Name values that are not header-safe travel as =?base64?<utf-8 base64>?=.
function encodeHeaderValue(value) {
  const safe = /^[\x21-\x7E]([\x20-\x7E]*[\x21-\x7E])?$/.test(value) && !/^=\?base64\?.*\?=$/.test(value);

  return safe ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function parseSse(text) {
  const events = [];

  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');

    if (data) events.push(data);
  }
  return events;
}

const tryParse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const isRpc = (value) => value && typeof value === 'object' && !Array.isArray(value) && value.jsonrpc === '2.0';

let legacyVersion = null; // negotiated by `initialize`, then sent on later requests as the legacy spec requires

function requestHeaders(message) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` };
  const modernVersion = message?.params?._meta?.[META_VERSION];

  if (typeof modernVersion === 'string' && typeof message.method === 'string') {
    headers['mcp-protocol-version'] = modernVersion;
    headers['mcp-method'] = message.method;
    const name = message.method === 'resources/read' ? message.params.uri : ['tools/call', 'prompts/get'].includes(message.method) ? message.params.name : undefined;

    if (typeof name === 'string') headers['mcp-name'] = encodeHeaderValue(name);
  } else if (legacyVersion && message?.method !== 'initialize') {
    headers['mcp-protocol-version'] = legacyVersion;
  }
  return headers;
}

async function forward(line) {
  const message = tryParse(line);

  if (message === undefined) {
    emit(rpcError(null, -32700, 'Parse error: the line is not valid JSON'));
    return;
  }
  const id = message && typeof message === 'object' && !Array.isArray(message) && 'id' in message ? message.id : undefined;
  const wantsReply = id !== undefined;

  try {
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers: requestHeaders(message),
      body: line,
      redirect: 'error', // never send the token to a redirect target
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const payloads = (contentType.includes('text/event-stream') ? parseSse(text) : [text]).map(tryParse).filter(isRpc);

    if (!payloads.length) {
      if (wantsReply) emit(rpcError(id, -32000, response.ok ? 'The MCP server sent an empty or non-JSON-RPC reply' : `The MCP server answered HTTP ${response.status} without a JSON-RPC body`));
      else if (!response.ok) log(`notification rejected with HTTP ${response.status}`);
      return;
    }
    for (const payload of payloads) {
      const isReply = 'result' in payload || 'error' in payload;

      if (!isReply) { emit(payload); continue; } // server notification
      if (wantsReply && payload.id === id) {
        emit(payload);
        if (message.method === 'initialize' && typeof payload.result?.protocolVersion === 'string') legacyVersion = payload.result.protocolVersion;
      } else if (wantsReply) {
        // e.g. an HTTP-level rejection that could not echo the id: answer the original request.
        emit(rpcError(id, payload.error?.code ?? -32000, payload.error?.message ?? `The MCP server answered HTTP ${response.status}`));
      } else {
        log(`server replied to a notification with HTTP ${response.status}`);
      }
    }
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timed out' : (error?.cause?.code ?? error?.code ?? error?.message ?? 'failed');

    log(`request failed: ${reason}`);
    if (wantsReply) emit(rpcError(id, -32000, `Could not reach the MCP server (${reason}).`));
  }
}

let chain = Promise.resolve();
let stopping = false;
const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.on('line', (line) => {
  if (line.trim()) chain = chain.then(() => forward(line)).catch((error) => log(`unexpected error: ${error?.message}`));
});

function finish() {
  chain.then(() => process.stdout.write('', () => process.exit(0)));
}

reader.on('close', finish);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) process.exit(0);
    stopping = true;
    reader.close(); // stop reading; in-flight requests finish first
  });
}
