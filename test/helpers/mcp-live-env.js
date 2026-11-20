// Helpers for the MCP integration tests (real HTTP, real token store, real cards.js, real WebSocket frames):
// token minting, MCP calls over HTTP in both protocol profiles, a WebSocket "viewer" that subscribes to
// collab objects and applies every frame to a local Y.Doc, and a runner that registers a suite for the JSON
// store and (when RUN_POSTGRES_TESTS=1 + DATABASE_URL) for a real PostgreSQL.
import assert from 'node:assert/strict';
import { describe } from 'node:test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { decodeMessage, encodeMessage } from '../../collab-protocol.js';
import { callModern, legacy, post } from './mcp-test-kit.js';
import { id, postgresConfigured } from './cards-env.js';

export const COLLAB = { database: 1, row: 4 };

/** Registers `define(mode)` as a describe block per available storage mode (postgres only when configured). */
export function eachStorageMode(name, define) {
  describe(`${name} [json]`, () => define('json'));
  if (postgresConfigured) describe(`${name} [postgres]`, () => define('postgres'));
  else describe(`${name} [postgres]`, { skip: 'BLOCKED: RUN_POSTGRES_TESTS=1 and DATABASE_URL not set' }, () => {});
}

export const mcpUrl = (env) => `${env.base}/mcp`;

/** Creates an agent token as the workspace owner; returns the secret string (only ever held by the test). */
export async function mintToken(env, acct, { scope = 'write', name = 'test agent', expires_in_days } = {}) {
  const response = await env.api('POST', `/api/workspace/${acct.workspaceId}/agent-tokens`, { name, scope, ...(expires_in_days === undefined ? {} : { expires_in_days }) }, acct.token);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { token: response.body.data.token, id: response.body.data.id };
}

/** One MCP tools/call in the chosen profile; returns {status, json, result, error}. */
export async function mcpTool(env, token, name, args = {}, { profile = 'modern', id: requestId = 1 } = {}) {
  const response = profile === 'modern'
    ? await callModern(mcpUrl(env), 'tools/call', { name, arguments: args }, { token, id: requestId })
    : await post(mcpUrl(env), legacy('tools/call', { name, arguments: args }, requestId), { token });

  return { status: response.status, json: response.json, result: response.json?.result, error: response.json?.error, headers: response.headers };
}

/** Structured content of a successful tool call, asserting it did not fail. */
export async function mcpOk(env, token, name, args, options) {
  const response = await mcpTool(env, token, name, args, options);

  assert.equal(response.status, 200, `${name}: HTTP ${response.status} ${JSON.stringify(response.json)}`);
  assert.ok(response.result, `${name}: no result ${JSON.stringify(response.json)}`);
  assert.notEqual(response.result.isError, true, `${name} failed: ${JSON.stringify(response.result)}`);
  return response.result.structuredContent;
}

// ------------------------------------------------------------ websocket viewer
/**
 * A browser stand-in: connects as `acct`, SyncRequests each {collabType, objectId} (so it is a real subscriber),
 * keeps one local Y.Doc per object and applies every update frame to it. `received` records each LIVE frame
 * (frames after the subscription's initial sync).
 */
export async function openViewer(env, acct, subscriptions, clientId = Math.floor(Math.random() * 1e6)) {
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-${String(clientId).padStart(12, '0')}`, token: acct.token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${env.base.replace(/^http/, 'ws')}/ws/v2/${acct.workspaceId}/?${query}`);
  const docs = new Map();
  const received = [];
  const manifests = new Set();
  const waiters = [];

  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', (frame, isBinary) => {
    if (!isBinary) return;
    const message = decodeMessage(frame).collabMessage;

    if (!message) return;
    const key = `${message.collabType}:${message.objectId}`;

    if (message.update && docs.has(key)) {
      Y.applyUpdate(docs.get(key), message.update.payload);
      // The first update of a subscription is the initial sync diff (it precedes the manifest); only frames
      // that arrive after that are "live" frames.
      if (manifests.has(key)) received.push({ key, collabType: message.collabType, objectId: message.objectId, at: process.hrtime.bigint(), messageId: message.update.messageId ?? null, bytes: message.update.payload.length });
    } else if (message.syncRequest) {
      manifests.add(key);
    }
    for (const waiter of [...waiters]) waiter();
  });

  const waitUntil = (predicate, timeoutMs = 4000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      let done = false;

      try { done = predicate(); } catch { done = false; }
      if (done) { cleanup(); resolve(true); } else if (Date.now() - started > timeoutMs) { cleanup(); reject(new Error('viewer timed out waiting for a frame')); }
    };
    const interval = setInterval(check, 25);
    const cleanup = () => { clearInterval(interval); const index = waiters.indexOf(check); if (index !== -1) waiters.splice(index, 1); };

    waiters.push(check);
    check();
  });

  async function subscribe({ collabType, objectId }) {
    const key = `${collabType}:${objectId}`;
    const doc = new Y.Doc({ guid: objectId });

    docs.set(key, doc);
    socket.send(encodeMessage({ collabMessage: { objectId, collabType, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(doc) } } }), { binary: true });
    await waitUntil(() => manifests.has(key));
  }

  for (const subscription of subscriptions) await subscribe(subscription);

  return {
    socket, docs, received, subscribe, waitUntil,
    doc: (collabType, objectId) => docs.get(`${collabType}:${objectId}`),
    framesFor: (collabType, objectId) => received.filter((entry) => entry.key === `${collabType}:${objectId}`),
    /** Milliseconds to wait and confirm that nothing (more) arrived. */
    quiet: (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms)),
    close: () => { socket.terminate(); },
  };
}

/** Reads a row's grouping/field values from a Y.Doc of a DatabaseRow. */
export const rowData = (doc) => doc.getMap('data').get('data').toJSON();

/** row_orders of one view out of a Database Y.Doc. */
export const viewRowOrders = (doc, viewId) => doc.getMap('data').get('database').get('views').get(viewId).get('row_orders').toArray();

export { id };
