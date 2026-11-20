// The web client can put an edit on the wire before the earlier edit it builds on (manifest replies and queued
// local updates are sent from different paths). The server must not close the socket for that: it holds the
// premature update briefly and applies it once its dependency has been accepted. An update whose dependency never
// arrives is still rejected (socket closed) after the reorder window, as before.
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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-causal-reorder-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key', wsReorderWindowMs: 600 });
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
    schema_version: 'v1', request_id: crypto.randomUUID(), parent_view_id: spaceId, name: 'Reorder', position: { kind: 'start' }, view_id: pageId,
  }, token)).status, 200);
  const collabUrl = `/api/workspace/v1/${workspaceId}/collab/${pageId}?collab_type=0`;
  const state = (await api('GET', collabUrl, undefined, token)).body.data;
  const client = new Y.Doc({ guid: pageId });

  Y.applyUpdate(client, new Uint8Array(state.doc_state));
  return { token, workspaceId, pageId, collabUrl, client };
}

async function openSocket({ token, workspaceId, pageId }, { sync = true } = {}) {
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws/v2/${workspaceId}/?clientId=${Math.floor(Math.random() * 1e6)}&deviceId=reorder&token=${token}&cv=0.10.0&cp=web`);
  const frames = [];
  const waiters = [];
  const state = { closed: null, reason: null };

  socket.on('message', (data) => {
    const frame = decodeMessage(new Uint8Array(data)).collabMessage;

    if (!frame) return;
    const waiter = waiters.shift();

    if (waiter) waiter(frame); else frames.push(frame);
  });
  socket.on('close', (code, reason) => { state.closed = code; state.reason = reason.toString(); });
  const next = (timeoutMs = 4000) => new Promise((resolve, reject) => {
    const queued = frames.shift();

    if (queued) return resolve(queued);
    const timer = setTimeout(() => reject(new Error(`no frame (socket closed with ${state.closed} ${state.reason})`)), timeoutMs);

    waiters.push((frame) => { clearTimeout(timer); resolve(frame); });
  });

  await new Promise((resolve) => socket.on('open', resolve));
  const sendSyncRequest = async () => {
    socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }), { binary: true });
    while (!(await next()).syncRequest) { /* drain the diff frame up to the manifest */ }
  };

  if (sync) await sendSyncRequest();
  return { socket, next, state, frames, sendSyncRequest };
}

const updateFrame = (pageId, payload, before) => encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: before } } });
const firstText = (doc) => [...doc.getMap('data').get('document').get('meta').get('text_map').values()].find((value) => value instanceof Y.Text);

async function persistedTexts({ token, collabUrl, pageId }) {
  const persisted = new Y.Doc({ guid: pageId });

  Y.applyUpdate(persisted, new Uint8Array((await api('GET', collabUrl, undefined, token)).body.data.doc_state));
  return [...persisted.getMap('data').get('document').get('meta').get('text_map').values()].filter((value) => value instanceof Y.Text).map((value) => value.toString()).join('|');
}

test('an edit that overtakes the edit it builds on is held and applied once its dependency arrives', async () => {
  const fixture = await documentFixture('reorder-ok');
  const { client, pageId } = fixture;
  const text = firstText(client);
  const sv0 = Y.encodeStateVector(client);

  text.insert(0, 'first-edit ');
  const update1 = Y.encodeStateAsUpdate(client, sv0);
  const sv1 = Y.encodeStateVector(client);

  text.insert(text.length, 'second-edit');
  const update2 = Y.encodeStateAsUpdate(client, sv1);
  const { socket, next, state } = await openSocket(fixture);

  try {
    // The dependent edit (before = after edit 1) goes first; the server does not have edit 1 yet.
    socket.send(updateFrame(pageId, update2, sv1), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(state.closed, null, 'the premature update does not close the socket');
    socket.send(updateFrame(pageId, update1, sv0), { binary: true });
    const acks = [];

    while (acks.length < 2) {
      const frame = await next();

      if (frame.update) acks.push(frame);
    }
    assert.equal(acks.length, 2, 'both updates are acknowledged');
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(state.closed, null, 'still open after the reorder window passed');
  } finally {
    socket.close();
  }
  const stored = await persistedTexts(fixture);

  assert.ok(stored.includes('first-edit') && stored.includes('second-edit'), `both edits are stored (got ${stored})`);
});

test('an update whose dependency never arrives still closes the socket after the reorder window', async () => {
  const fixture = await documentFixture('reorder-orphan');
  const { client, pageId } = fixture;
  const text = firstText(client);
  const sv0 = Y.encodeStateVector(client);

  text.insert(0, 'lost-edit ');
  const sv1 = Y.encodeStateVector(client);

  text.insert(text.length, 'orphan-edit');
  const orphan = Y.encodeStateAsUpdate(client, sv1);
  const { socket, state } = await openSocket(fixture);
  const closed = new Promise((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));

  void sv0;
  socket.send(updateFrame(pageId, orphan, sv1), { binary: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(state.closed, null, 'held, not closed, inside the window');
  const result = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('still open'), 3000))]);

  assert.notEqual(result, 'still open', 'closed once the window expired');
  assert.equal(result.code, 1008);
  assert.equal(result.reason, 'Document update was rejected');
  assert.ok(!(await persistedTexts(fixture)).includes('orphan-edit'), 'the unsatisfiable update was never stored');
});

test('an edit sent before its SyncRequest is held and applied once the SyncRequest is processed', async () => {
  const fixture = await documentFixture('reorder-unbound');
  const { client, pageId } = fixture;
  const text = firstText(client);
  const sv0 = Y.encodeStateVector(client);

  text.insert(0, 'early-edit');
  const early = Y.encodeStateAsUpdate(client, sv0);
  const { socket, state, sendSyncRequest } = await openSocket(fixture, { sync: false });

  try {
    socket.send(updateFrame(pageId, early, sv0), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(state.closed, null, 'the early update does not close the socket');
    await sendSyncRequest();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(state.closed, null);
  } finally {
    socket.close();
  }
  assert.ok((await persistedTexts(fixture)).includes('early-edit'), 'the held edit was stored after the SyncRequest');
});

test('an edit for an object that never gets a SyncRequest still closes with the original reason', async () => {
  const fixture = await documentFixture('reorder-never-bound');
  const { client, pageId } = fixture;
  const text = firstText(client);
  const sv0 = Y.encodeStateVector(client);

  text.insert(0, 'unbound-edit');
  const { socket } = await openSocket(fixture, { sync: false });
  const closed = new Promise((resolve) => socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));

  socket.send(updateFrame(pageId, Y.encodeStateAsUpdate(client, sv0), sv0), { binary: true });
  const result = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('still open'), 3000))]);

  assert.notEqual(result, 'still open');
  assert.equal(result.code, 1008);
  assert.equal(result.reason, 'Document SyncRequest is required before updates');
  assert.ok(!(await persistedTexts(fixture)).includes('unbound-edit'));
});
