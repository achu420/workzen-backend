// Task 68: PostgreSQL half of the collaboration-recovery matrix, mirroring
// test/collaboration-recovery.test.js (JSON storage). Conventions match the
// existing Postgres suites (test/postgres-realtime-fanout-document.test.js,
// test/postgres-security-authorization.test.js): real Postgres storage via
// RUN_POSTGRES_TESTS=1 + DATABASE_URL (skipped entirely otherwise), one
// `startServer({ storage: 'postgres', ... })` per test.
//
// "Backend restart" against Postgres storage is modeled by closing the
// server's HTTP/WS listener and starting a brand-new one against the SAME
// DATABASE_URL -- the durable state lives in Postgres, not the Node
// process, so this is the faithful Postgres analogue of the JSON suite's
// same-file restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { id } from '../auth.js';
import { startServer } from '../server.js';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;
let base;

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
  const token = login.body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  return { email, token, workspaceId };
}

async function addMember(ownerToken, workspaceId, memberEmail, devKey) {
  assert.equal(
    (await api('POST', `/api/workspaces/${workspaceId}/test-members`, { email: memberEmail, role: 'member' }, ownerToken, { 'x-development-key': devKey })).status,
    201
  );
}

async function revokeMember(ownerToken, workspaceId, memberEmail, devKey) {
  assert.equal(
    (await api('DELETE', `/api/workspaces/${workspaceId}/test-members?email=${encodeURIComponent(memberEmail)}`, undefined, ownerToken, { 'x-development-key': devKey })).status,
    200
  );
}

async function createPublicSpace(token, workspaceId, label) {
  const spaceId = id();
  assert.equal((await api('POST', `/api/workspace/${workspaceId}/spaces`, { name: `${label} space`, view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, token)).status, 200);
  return spaceId;
}

async function createDocumentPage(token, workspaceId, spaceId, label) {
  const pageId = id();
  assert.equal((await api('POST', `/api/workspace/${workspaceId}/v2/page-view/document/default`, {
    schema_version: 'v1', request_id: id(), view_id: pageId, parent_view_id: spaceId, name: `${label} page`, position: { kind: 'start' },
  }, token)).status, 200);
  return pageId;
}

function connectSocket(wsBase, workspaceId, token, clientId) {
  const websocketBase = wsBase.replace(/^http/, 'ws');
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${websocketBase}/ws/v2/${workspaceId}/?${query}`);
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

function frameReader(socket) {
  const pending = []; const waiters = [];
  socket.on('message', (frame, isBinary) => { const r = waiters.shift(); if (r) r({ frame, isBinary }); else pending.push({ frame, isBinary }); });
  return (timeoutMs = 2000) => new Promise((resolve) => {
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

async function readManifest(next) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const frame = await next();
    if (!frame || frame.syncRequest) return frame;
  }
  return null;
}

function docTextNodes(doc) {
  return [...doc.getMap('data').get('document').get('meta').get('text_map').values()].filter((v) => v instanceof Y.Text);
}

test('PostgreSQL recovery: backend process restart against the same database preserves content, Rid continuity, and live fan-out keeps working', { skip: !configured }, async () => {
  const devKey = 'task68-pg-restart-key';
  let server1 = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey, environment: 'test' });
  base = `http://127.0.0.1:${server1.address.port}`;

  const owner = await registerAndLogin('pg-restart-owner');
  const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'pg-restart');
  const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'pg-restart');
  const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;

  const socket = await connectSocket(base, owner.workspaceId, owner.token, 31001);
  const next = frameReader(socket);
  const sv0 = (() => { const d = new Y.Doc({ guid: pageId }); Y.applyUpdate(d, new Uint8Array(initial.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();
  const manifestP = readManifest(next);
  socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv0 } } }));
  await manifestP;

  const editDoc = new Y.Doc({ guid: pageId });
  Y.applyUpdate(editDoc, new Uint8Array(initial.doc_state));
  const marker1 = `pg-restart-pre-${id()}`;
  docTextNodes(editDoc)[0].insert(0, marker1);
  const payload1 = Y.encodeStateAsUpdate(editDoc, sv0);
  const ack1P = next();
  socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: payload1, beforeStateVector: sv0 } } }));
  const ack1 = await ack1P;
  assert.ok(ack1.update, 'pre-restart update must be acked');
  await next(); // drain manifest
  const sv1 = Y.encodeStateVector(editDoc);

  socket.terminate();
  await new Promise((resolve) => socket.once('close', resolve));
  await new Promise((resolve) => server1.server.close(resolve));

  const server2 = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey, environment: 'test' });
  base = `http://127.0.0.1:${server2.address.port}`;

  try {
    const readBack = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
    assert.equal(readBack.status, 200);
    const persisted = new Y.Doc({ guid: pageId });
    Y.applyUpdate(persisted, new Uint8Array(readBack.body.data.doc_state));
    assert.ok(docTextNodes(persisted).some((t) => t.toString().includes(marker1)), 'pre-restart edit must survive a backend process restart against the same Postgres database');
    persisted.destroy();

    const socket2 = await connectSocket(base, owner.workspaceId, owner.token, 31002);
    const next2 = frameReader(socket2);
    const manifestP2 = readManifest(next2);
    socket2.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv1 } } }));
    await manifestP2;

    const peerSocket = await connectSocket(base, owner.workspaceId, owner.token, 31003);
    const peerNext = frameReader(peerSocket);
    const peerManifestP = readManifest(peerNext);
    peerSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv1 } } }));
    await peerManifestP;

    const marker2 = `pg-restart-post-${id()}`;
    docTextNodes(editDoc)[0].insert(0, marker2);
    const payload2 = Y.encodeStateAsUpdate(editDoc, sv1);
    const peerLiveP = peerNext(3000);
    const ack2P = next2();
    socket2.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: payload2, beforeStateVector: sv1 } } }));
    const ack2 = await ack2P;
    assert.ok(ack2.update, 'post-restart update must be acked');
    assert.ok(
      BigInt(ack2.update.messageId.timestamp) > BigInt(ack1.update.messageId.timestamp) ||
      (BigInt(ack2.update.messageId.timestamp) === BigInt(ack1.update.messageId.timestamp) && ack2.update.messageId.counter > ack1.update.messageId.counter),
      'Rid allocated after Postgres backend restart must strictly continue past the pre-restart Rid'
    );
    const peerLive = await peerLiveP;
    assert.ok(peerLive && peerLive.update, 'live fan-out must keep working for a brand-new connection established after the Postgres backend restart');

    socket2.terminate(); peerSocket.terminate();
  } finally {
    editDoc.destroy();
    await new Promise((resolve) => server2.server.close(resolve));
  }
});

test('PostgreSQL recovery: two clients reconnect simultaneously with distinct pending edits -- no lost updates, no Rid collision, both converge', { skip: !configured }, async () => {
  const devKey = 'task68-pg-concurrent-key';
  const running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey, environment: 'test' });
  base = `http://127.0.0.1:${running.address.port}`;
  try {
    const owner = await registerAndLogin('pg-concurrent-owner');
    const peer = await registerAndLogin('pg-concurrent-peer');
    await addMember(owner.token, owner.workspaceId, peer.email, devKey);
    const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'pg-concurrent');
    const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'pg-concurrent');
    const initial = (await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token)).body.data;
    const sv0 = (() => { const d = new Y.Doc({ guid: pageId }); Y.applyUpdate(d, new Uint8Array(initial.doc_state)); const v = Y.encodeStateVector(d); d.destroy(); return v; })();

    const [socketA, socketB] = await Promise.all([
      connectSocket(base, owner.workspaceId, owner.token, 32001),
      connectSocket(base, owner.workspaceId, peer.token, 32002),
    ]);
    const nextA = frameReader(socketA);
    const nextB = frameReader(socketB);
    await Promise.all([
      (async () => { const m = readManifest(nextA); socketA.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv0 } } })); return m; })(),
      (async () => { const m = readManifest(nextB); socketB.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: sv0 } } })); return m; })(),
    ]);

    const docA = new Y.Doc({ guid: pageId }); Y.applyUpdate(docA, new Uint8Array(initial.doc_state));
    const docB = new Y.Doc({ guid: pageId }); Y.applyUpdate(docB, new Uint8Array(initial.doc_state));
    const markerA = `pg-concurrent-a-${id()}`;
    const markerB = `pg-concurrent-b-${id()}`;
    docTextNodes(docA)[0].insert(0, markerA);
    docTextNodes(docB)[0].insert(docTextNodes(docB)[0].length, markerB);
    const payloadA = Y.encodeStateAsUpdate(docA, sv0);
    const payloadB = Y.encodeStateAsUpdate(docB, sv0);

    async function collectFrames(next, count) {
      const frames = [];
      for (let i = 0; i < count; i += 1) {
        const frame = await next(2500);
        if (!frame) break;
        frames.push(frame);
      }
      return frames;
    }

    const framesAP = collectFrames(nextA, 3);
    const framesBP = collectFrames(nextB, 3);
    socketA.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: payloadA, beforeStateVector: sv0 } } }));
    socketB.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: payloadB, beforeStateVector: sv0 } } }));
    const [framesA, framesB] = await Promise.all([framesAP, framesBP]);

    function ownUpdateFrame(frames, ownMarker) {
      return frames.find((f) => {
        if (!f.update) return false;
        const probe = new Y.Doc({ guid: pageId });
        try {
          Y.applyUpdate(probe, new Uint8Array(initial.doc_state));
          Y.applyUpdate(probe, f.update.payload);
          return docTextNodes(probe).some((t) => t.toString().includes(ownMarker));
        } finally {
          probe.destroy();
        }
      });
    }

    const ackA = ownUpdateFrame(framesA, markerA);
    const ackB = ownUpdateFrame(framesB, markerB);
    assert.ok(ackA && ackB, 'both concurrently-submitted distinct edits must be accepted and acked back to their own sender (Postgres)');
    assert.notDeepEqual(ackA.update.messageId, ackB.update.messageId, 'distinct concurrent edits must receive DIFFERENT Rids under Postgres storage too');

    const readBack = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
    const merged = new Y.Doc({ guid: pageId });
    Y.applyUpdate(merged, new Uint8Array(readBack.body.data.doc_state));
    const mergedTexts = docTextNodes(merged);
    assert.ok(mergedTexts.some((t) => t.toString().includes(markerA)), 'A\'s concurrent edit must not be lost (Postgres)');
    assert.ok(mergedTexts.some((t) => t.toString().includes(markerB)), 'B\'s concurrent edit must not be lost (Postgres)');

    docA.destroy(); docB.destroy(); merged.destroy();
    socketA.terminate(); socketB.terminate();
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
  }
});

test('PostgreSQL recovery (authorization): disconnect, revoke membership, reconnection is rejected and no protected content is returned', { skip: !configured }, async () => {
  const devKey = 'task68-pg-auth-key';
  const running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey, environment: 'test' });
  base = `http://127.0.0.1:${running.address.port}`;
  try {
    const owner = await registerAndLogin('pg-auth-owner');
    const member = await registerAndLogin('pg-auth-member');
    await addMember(owner.token, owner.workspaceId, member.email, devKey);
    const spaceId = await createPublicSpace(owner.token, owner.workspaceId, 'pg-auth');
    const pageId = await createDocumentPage(owner.token, owner.workspaceId, spaceId, 'pg-auth');

    const memberSocket = await connectSocket(base, owner.workspaceId, member.token, 33001);
    const memberNext = frameReader(memberSocket);
    const manifestP = readManifest(memberNext);
    memberSocket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }));
    await manifestP;

    memberSocket.terminate();
    await new Promise((resolve) => memberSocket.once('close', resolve));
    await revokeMember(owner.token, owner.workspaceId, member.email, devKey);

    const wsBase = base.replace(/^http/, 'ws');
    const query = new URLSearchParams({ clientId: '33002', deviceId: '00000000-0000-4000-8000-000000033002', token: member.token, cv: '0.10.0', cp: 'web' });
    const rejected = await new Promise((resolve) => {
      const attempt = new WebSocket(`${wsBase}/ws/v2/${owner.workspaceId}/?${query}`);
      attempt.once('unexpected-response', (req, res) => resolve({ rejected: true, status: res.statusCode }));
      attempt.once('open', () => resolve({ rejected: false }));
      attempt.once('error', () => resolve({ rejected: true, status: 'error' }));
    });
    assert.ok(rejected.rejected, 'reconnection after revocation must be rejected under Postgres storage too');
    if (typeof rejected.status === 'number') assert.equal(rejected.status, 403);

    const restAttempt = await api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, member.token);
    assert.ok([401, 403, 404].includes(restAttempt.status), 'revoked member must not read protected collab content via REST after reconnect-recovery attempt (Postgres)');
  } finally {
    await new Promise((resolve) => running.server.close(resolve));
  }
});
