// Task 66: completes the required 6-combo matrix (Document/Database/
// DatabaseRow x JSON/Postgres) for the peer-fanout extension described in
// docs/TASK65_REALTIME_COLLABORATION_ARCHITECTURE_DECISION.md and
// implemented in server.js. The Database and DatabaseRow x Postgres combos
// are covered by the Task 66-updated test/postgres-database-multiclient.test.js;
// this file covers Document x Postgres, the remaining cell.
//
// Conventions mirror test/postgres-database-multiclient.test.js: real
// PostgreSQL storage (RUN_POSTGRES_TESTS=1 + DATABASE_URL required, skipped
// otherwise), two independent real WebSocket connections modeling two
// independent AppFlowy-Web clients, and a frame reader that resolves
// `null` on timeout so "peer received NOTHING" is assertable directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { id } from '../auth.js';
import { startServer } from '../server.js';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;
let running, base;

async function api(method, route, payload, token, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const PUBLIC_SPACE_PERMISSION = {
  visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
  invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
  security: { disable_guests: false, disable_public_links: false, disable_export: false },
};

async function registerAndLogin(label) {
  const email = `${label}-${id()}@example.test`;
  const password = 'Correct horse 907';
  assert.equal((await api('POST', '/api/auth/register', { email, password })).status, 201);
  const login = await api('POST', '/api/auth/login', { email, password });
  return { email, token: login.body.access_token };
}

function connectSocket(workspaceId, token, clientId) {
  const wsBase = base.replace(/^http/, 'ws');
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${wsBase}/ws/v2/${workspaceId}/?${query}`);
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

function frameReader(socket) {
  const pending = []; const waiters = [];
  socket.on('message', (frame, isBinary) => { const r = waiters.shift(); if (r) r({ frame, isBinary }); else pending.push({ frame, isBinary }); });
  return (timeoutMs = 1500) => new Promise((resolve) => {
    let waiterEntry;
    const timeout = setTimeout(() => {
      const index = waiters.indexOf(waiterEntry);
      if (index !== -1) waiters.splice(index, 1);
      resolve(null);
    }, timeoutMs);
    const accept = ({ frame, isBinary }) => { clearTimeout(timeout); resolve(isBinary ? decodeMessage(frame).collabMessage : null); };
    waiterEntry = accept;
    const p = pending.shift(); if (p) accept(p); else waiters.push(waiterEntry);
  });
}

test('PostgreSQL multi-client (WebSocket protocol level, Task 66): an already-connected second client receives an accepted Document update live, without sending a new SyncRequest, and content converges', { skip: !configured }, async (t) => {
  running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey: 'task66-pg-key', environment: 'test' });
  base = `http://127.0.0.1:${running.address.port}`;
  const openSockets = [];
  try {
    const owner = await registerAndLogin('pg-doc-fanout-owner');
    const ownerWorkspaceId = (await api('GET', '/api/user/workspace', undefined, owner.token)).body.data.visiting_workspace.workspace_id;
    const peer = await registerAndLogin('pg-doc-fanout-peer');
    assert.equal((await api('POST', `/api/workspaces/${ownerWorkspaceId}/test-members`, { email: peer.email, role: 'member' }, owner.token, { 'x-development-key': 'task66-pg-key' })).status, 201);

    const spaceId = id();
    assert.equal((await api('POST', `/api/workspace/${ownerWorkspaceId}/spaces`, { name: 'MC space', view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, owner.token)).status, 200);
    const pageId = id();
    assert.equal((await api('POST', `/api/workspace/${ownerWorkspaceId}/v2/page-view/document/default`, {
      schema_version: 'v1', request_id: id(), view_id: pageId, parent_view_id: spaceId, name: 'MC page', position: { kind: 'start' },
    }, owner.token)).status, 200);

    const initial = (await api('GET', `/api/workspace/v1/${ownerWorkspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;
    const baseDoc = new Y.Doc({ guid: pageId });
    Y.applyUpdate(baseDoc, new Uint8Array(initial.doc_state));
    const beforeSv = Y.encodeStateVector(baseDoc);

    const ownerSocket = await connectSocket(ownerWorkspaceId, owner.token, 9500);
    const peerSocket = await connectSocket(ownerWorkspaceId, peer.token, 9501);
    openSockets.push(ownerSocket, peerSocket);
    const ownerNext = frameReader(ownerSocket);
    const peerNext = frameReader(peerSocket);

    const ownerManifestP = ownerNext();
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: beforeSv } } }));
    assert.ok((await ownerManifestP).syncRequest);
    const peerManifestP = peerNext();
    peerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: beforeSv } } }));
    assert.ok((await peerManifestP).syncRequest);

    const editDoc = new Y.Doc({ guid: pageId });
    Y.applyUpdate(editDoc, new Uint8Array(initial.doc_state));
    const text = [...editDoc.getMap('data').get('document').get('meta').get('text_map').values()].find((v) => v instanceof Y.Text);
    const marker = `task66-pg-doc-${id()}`;
    text.insert(text.length, marker);
    const payload = Y.encodeStateAsUpdate(editDoc, beforeSv);

    const peerLiveWatch = peerNext(3000);
    const ownerAckP = ownerNext();
    ownerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload, beforeStateVector: beforeSv } } }));
    const ownerAck = await ownerAckP;
    assert.ok(ownerAck.update, 'owner must receive its own ack, unchanged by Task 66');

    const peerLive = await peerLiveWatch;
    t.diagnostic(`Document WS update broadcast check (Task 66, Postgres): peer received ${peerLive ? JSON.stringify({ objectId: peerLive.objectId, collabType: peerLive.collabType, messageId: peerLive.update?.messageId }) : 'NOTHING'}`);
    assert.ok(peerLive, 'Task 66: an already-connected peer must receive the accepted Document update live, without a new SyncRequest, under PostgreSQL storage');
    assert.ok(peerLive.update);
    assert.equal(peerLive.objectId, pageId);
    assert.equal(peerLive.collabType, 0);
    assert.deepEqual(peerLive.update.messageId, ownerAck.update.messageId, 'the live broadcast must carry the exact same server-assigned messageId as the sender\'s own ack');

    const peerDoc = new Y.Doc({ guid: pageId });
    Y.applyUpdate(peerDoc, new Uint8Array(initial.doc_state));
    Y.applyUpdate(peerDoc, peerLive.update.payload);
    const peerTexts = [...peerDoc.getMap('data').get('document').get('meta').get('text_map').values()].filter((v) => v instanceof Y.Text);
    assert.ok(peerTexts.some((v) => v.toString().includes(marker)), 'peer\'s own Yjs doc must converge with the sender\'s edit after applying the live frame');
    peerDoc.destroy();
    editDoc.destroy();
    baseDoc.destroy();

    // Durability under PostgreSQL storage: readable after a fresh SyncRequest.
    const readBack = await api('GET', `/api/workspace/v1/${ownerWorkspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
    const persisted = new Y.Doc({ guid: pageId });
    Y.applyUpdate(persisted, new Uint8Array(readBack.body.data.doc_state));
    const persistedTexts = [...persisted.getMap('data').get('document').get('meta').get('text_map').values()].filter((v) => v instanceof Y.Text);
    assert.ok(persistedTexts.some((v) => v.toString().includes(marker)), 'the edit must be durably persisted in PostgreSQL');
    persisted.destroy();
  } finally {
    for (const socket of openSockets) { try { socket.terminate(); } catch { /* ignore */ } }
    await running.app.store.close();
    await new Promise((resolve) => running.server.close(resolve));
  }
});
