// A browser with a large local history sends one big Yjs update on every (re)connect. The socket used to cap
// frames at 64 KiB while the client assumes 4 MiB (server-info max_update_bytes, absent before), so that update
// killed the connection ("Max payload size exceeded") and was resent forever: edits never reached the server and
// the editor kept reconnecting. Frames up to the advertised limit must now be accepted and persisted.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { encodeMessage, decodeMessage } from '../collab-protocol.js';
import { startServer } from '../server.js';

let dir, running, base;

async function api(method, route, payload, token) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-large-update-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  running.server.closeAllConnections?.();
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function documentFixture(label) {
  const email = `${label}@example.test`;

  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  const spaceId = crypto.randomUUID();

  assert.equal((await api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: 'Space', view_id: spaceId,
    permission: {
      visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
      invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
      security: { disable_guests: false, disable_public_links: false, disable_export: false },
    },
  }, token)).status, 200);
  const pageId = crypto.randomUUID();

  assert.equal((await api('POST', `/api/workspace/${workspaceId}/v2/page-view/document/default`, {
    schema_version: 'v1', request_id: crypto.randomUUID(), parent_view_id: spaceId, name: 'Big', position: { kind: 'start' }, view_id: pageId,
  }, token)).status, 200);
  return { token, workspaceId, pageId };
}

test('server-info advertises the realtime update limit the socket actually accepts', async () => {
  const info = await api('GET', '/api/server-info');

  assert.equal(info.status, 200);
  assert.equal(info.body.data.max_update_bytes, 4 * 1024 * 1024);
});

test('a 300 KB document update is accepted over the socket and persisted (it used to close the connection)', async () => {
  const { token, workspaceId, pageId } = await documentFixture('large-update');
  const state = (await api('GET', `/api/workspace/v1/${workspaceId}/collab/${pageId}?collab_type=0`, undefined, token)).body.data;
  const client = new Y.Doc({ guid: pageId });

  Y.applyUpdate(client, new Uint8Array(state.doc_state));
  const text = [...client.getMap('data').get('document').get('meta').get('text_map').values()].find((value) => value instanceof Y.Text);

  assert.ok(text, 'the new page has a text block to edit');
  const marker = `large-update-${Date.now()}`;
  const before = Y.encodeStateVector(client);

  text.insert(text.length, `${marker}${'x'.repeat(300_000)}`);
  const update = Y.encodeStateAsUpdate(client, before);

  assert.ok(update.byteLength > 300_000, 'the update is larger than the old 64 KiB frame cap');
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/v2/${workspaceId}/?clientId=91&deviceId=large&token=${token}&cv=0.10.0&cp=web`);
  const frames = [];
  const waiters = [];
  let closed = null;

  socket.on('message', (data) => {
    const frame = decodeMessage(new Uint8Array(data)).collabMessage;

    if (!frame) return;
    const waiter = waiters.shift();

    if (waiter) waiter(frame); else frames.push(frame);
  });
  socket.on('close', (code) => { closed = code; });
  const next = () => new Promise((resolve, reject) => {
    const queued = frames.shift();

    if (queued) return resolve(queued);
    const timer = setTimeout(() => reject(new Error(`no frame (socket closed with ${closed})`)), 5000);

    waiters.push((frame) => { clearTimeout(timer); resolve(frame); });
  });

  await new Promise((resolve) => socket.on('open', resolve));
  try {
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }), { binary: true });
    while (!(await next()).syncRequest) { /* drain the diff frame until the manifest */ }
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: update, beforeStateVector: before } } }), { binary: true });
    const ack = await next();

    assert.ok(ack.update, 'the big update is acknowledged');
    assert.equal(closed, null, 'the connection stays open');
  } finally {
    socket.close();
  }
  const persisted = new Y.Doc({ guid: pageId });

  Y.applyUpdate(persisted, new Uint8Array((await api('GET', `/api/workspace/v1/${workspaceId}/collab/${pageId}?collab_type=0`, undefined, token)).body.data.doc_state));
  const persistedTexts = [...persisted.getMap('data').get('document').get('meta').get('text_map').values()].filter((value) => value instanceof Y.Text);

  assert.ok(persistedTexts.some((value) => value.toString().includes(marker)), 'the large edit was stored');
});

test('frames beyond the advertised limit are still refused', async () => {
  const { token, workspaceId } = await documentFixture('too-large-update');
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/v2/${workspaceId}/?clientId=92&deviceId=huge&token=${token}&cv=0.10.0&cp=web`);
  const closedWith = new Promise((resolve) => socket.on('close', resolve));

  socket.on('error', () => {});
  await new Promise((resolve) => socket.on('open', resolve));
  socket.send(Buffer.alloc(4 * 1024 * 1024 + 512 * 1024, 1), { binary: true });
  const code = await Promise.race([closedWith, new Promise((resolve) => setTimeout(() => resolve('still open'), 5000))]);

  assert.notEqual(code, 'still open', 'an absurdly large frame closes the socket');
});
