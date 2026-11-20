// Task 63: WebSocket/HTTP integration verification for Database/DatabaseRow
// storage running in POSTGRES mode -- a real HTTP + real WebSocket server
// (startServer({ storage: 'postgres', ... })) backed by the real disposable
// test database, exercised through the SAME routes/protocol AppFlowy-Web
// actually calls (not direct store-method calls, which is what
// test/postgres-database-collab.test.js already covers). This is
// deliberately separate evidence from the direct-store repository tests:
// it proves the HTTP routes, WS admission, and restart-reconstruction all
// still work unchanged when STORAGE=postgres, exactly mirroring the
// existing JSON-mode fixtures in test/database-collab.test.js and
// test/database-row-collab.test.js (same request shapes, same helpers).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { id } from '../auth.js';
import { startServer } from '../server.js';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;
let running, base;

before(async () => {
  if (!configured) return;
  running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey: 'task63-key', environment: 'test' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  if (!configured || !running) return;
  await running.app.store.close();
  await new Promise((resolve) => running.server.close(resolve));
});

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
  return { token, workspaceId };
}

async function createPublicSpace(token, workspaceId, label) {
  const spaceId = id();
  assert.equal((await api('POST', `/api/workspace/${workspaceId}/spaces`, { name: `${label} space`, view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, token)).status, 200);
  return spaceId;
}

function defaultDatabaseRequest({ parentViewId, name = 'Grid' }) {
  return {
    schema_version: 'v1', request_id: id(), parent_view_id: parentViewId, name: '', position: { kind: 'start' }, container_id: id(),
    database: { database_id: id(), view_id: id(), name, layout: 0, embedded: false, responses_view_id: null, initial_row_ids: [], timezone_id: null },
  };
}

async function createGridDatabase(token, workspaceId, spaceId) {
  const request = defaultDatabaseRequest({ parentViewId: spaceId });
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/page-view/database/default`, request, token);
  return { request, response };
}

const ORIGINAL_DATABASE_RESTORE_ID = '00000000-0000-0000-0000-000000000000';
function defaultRowRequest({ sourceViewId, position = { kind: 'end' }, cells = {} }) {
  return { schema_version: 'v1', request_id: id(), row_id: id(), database_restore_id: ORIGINAL_DATABASE_RESTORE_ID, source_view_id: sourceViewId, cells, height: 36, visibility: true, presentation: { icon_url: null, cover: null }, position };
}

async function createRow(token, workspaceId, databaseId, overrides) {
  const request = { ...defaultRowRequest(overrides) };
  const response = await api('POST', `/api/workspace/${workspaceId}/v2/database/${databaseId}/row/default`, request, token);
  return { request, response };
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
  return (timeoutMs = 3000) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket response timed out')), timeoutMs);
    const accept = ({ frame, isBinary }) => { clearTimeout(timeout); if (!isBinary) return reject(new Error('response was not binary')); resolve(decodeMessage(frame).collabMessage); };
    const p = pending.shift(); if (p) accept(p); else waiters.push(accept);
  });
}
async function nextUpdateFrame(nextFrame) {
  for (let i = 0; i < 5; i += 1) { const frame = await nextFrame(5000); if (frame.update) return frame; }
  throw new Error('No update-ack frame arrived');
}

test('PostgreSQL mode: REST Database creation, collab read, WS sync+field update, REST row creation (x2), collab read, WS cell update, and restart all work end-to-end', { skip: !configured }, async (t) => {
  const { token, workspaceId } = await registerAndLogin('pg-http');
  const spaceId = await createPublicSpace(token, workspaceId, 'pg-http');

  const { request: dbRequest, response: dbResponse } = await createGridDatabase(token, workspaceId, spaceId);
  assert.equal(dbResponse.status, 200);
  assert.equal(dbResponse.body.data.outcome, 'applied');
  const databaseId = dbRequest.database.database_id;
  const viewId = dbRequest.database.view_id;

  const collabRoute = `/api/workspace/v1/${workspaceId}/collab/${databaseId}?collab_type=1`;
  const readDb = await api('GET', collabRoute, undefined, token);
  assert.equal(readDb.status, 200);
  const primaryFieldId = (() => {
    const doc = new Y.Doc({ guid: databaseId }); Y.applyUpdate(doc, new Uint8Array(readDb.body.data.doc_state));
    const fieldId = [...doc.getMap('data').get('database').get('fields').keys()][0];
    doc.destroy(); return fieldId;
  })();

  // WS sync + a generic field-rename Yjs update (Database collabType=1).
  const client = new Y.Doc({ guid: databaseId }); Y.applyUpdate(client, new Uint8Array(readDb.body.data.doc_state));
  let stateVector = Y.encodeStateVector(client);
  const socket = await connectSocket(workspaceId, token, 9100);
  const nextFrame = frameReader(socket);
  const manifestPromise = nextFrame();
  socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector } } }));
  assert.ok((await manifestPromise).syncRequest);
  client.getMap('data').get('database').get('fields').get(primaryFieldId).set('name', 'Postgres Title');
  const fieldUpdate = Y.encodeStateAsUpdate(client, stateVector);
  const ackPromise = nextUpdateFrame(nextFrame);
  socket.send(encodeMessage({ collabMessage: { objectId: databaseId, collabType: 1, update: { flags: 0, payload: fieldUpdate, beforeStateVector: stateVector } } }));
  assert.ok((await ackPromise).update);
  socket.close();

  // Two rows via the real atomic REST endpoint.
  const row1 = await createRow(token, workspaceId, databaseId, { sourceViewId: viewId, position: { kind: 'end' }, cells: { [primaryFieldId]: { data: 'Row One' } } });
  assert.equal(row1.response.status, 200);
  assert.equal(row1.response.body.data.outcome, 'applied');
  const row2 = await createRow(token, workspaceId, databaseId, { sourceViewId: viewId, position: { kind: 'end' }, cells: { [primaryFieldId]: { data: 'Row Two' } } });
  assert.equal(row2.response.status, 200);

  const readRow1 = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${row1.request.row_id}?collab_type=4`, undefined, token);
  assert.equal(readRow1.status, 200);
  assert.equal(readRow1.body.data.collab_version, null);

  // WS cell edit on row2 (collabType=4).
  const readRow2 = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${row2.request.row_id}?collab_type=4`, undefined, token);
  const rowClient = new Y.Doc({ guid: row2.request.row_id }); Y.applyUpdate(rowClient, new Uint8Array(readRow2.body.data.doc_state));
  const rowStateVector = Y.encodeStateVector(rowClient);
  const rowSocket = await connectSocket(workspaceId, token, 9101);
  const rowNextFrame = frameReader(rowSocket);
  const rowManifestPromise = rowNextFrame();
  rowSocket.send(encodeMessage({ collabMessage: { objectId: row2.request.row_id, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: rowStateVector } } }));
  assert.ok((await rowManifestPromise).syncRequest);
  rowClient.getMap('data').get('data').get('cells').get(primaryFieldId).set('data', 'Row Two Edited');
  const cellUpdate = Y.encodeStateAsUpdate(rowClient, rowStateVector);
  const rowAckPromise = nextUpdateFrame(rowNextFrame);
  rowSocket.send(encodeMessage({ collabMessage: { objectId: row2.request.row_id, collabType: 4, update: { flags: 0, payload: cellUpdate, beforeStateVector: rowStateVector } } }));
  assert.ok((await rowAckPromise).update);
  rowSocket.close();

  // Restart: close this server/pool and start a fresh one against the SAME
  // Postgres database, then confirm everything -- Database field rename,
  // both rows, row_orders membership, and the WS cell edit -- survived.
  await running.app.store.close();
  await new Promise((resolve) => running.server.close(resolve));
  running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey: 'task63-key', environment: 'test' });
  base = `http://127.0.0.1:${running.address.port}`;

  const afterRestartDb = await api('GET', collabRoute, undefined, token);
  assert.equal(afterRestartDb.status, 200);
  const restartedDoc = new Y.Doc({ guid: databaseId }); Y.applyUpdate(restartedDoc, new Uint8Array(afterRestartDb.body.data.doc_state));
  assert.equal(restartedDoc.getMap('data').get('database').get('fields').get(primaryFieldId).get('name'), 'Postgres Title');
  const view = restartedDoc.getMap('data').get('database').get('views').get(viewId);
  const orderedRowIds = view.get('row_orders').toArray().map((o) => o.id);
  assert.deepEqual(orderedRowIds, [row1.request.row_id, row2.request.row_id], 'both rows must survive a restart, in insertion order');
  restartedDoc.destroy();

  const afterRestartRow2 = await api('GET', `/api/workspace/v1/${workspaceId}/collab/${row2.request.row_id}?collab_type=4`, undefined, token);
  const restartedRowDoc = new Y.Doc({ guid: row2.request.row_id }); Y.applyUpdate(restartedRowDoc, new Uint8Array(afterRestartRow2.body.data.doc_state));
  assert.equal(restartedRowDoc.getMap('data').get('data').get('cells').get(primaryFieldId).get('data'), 'Row Two Edited', 'the WS cell edit must survive a restart');
  restartedRowDoc.destroy();

  t.diagnostic(`Postgres HTTP/WS integration: database=${databaseId} row1=${row1.request.row_id} row2=${row2.request.row_id}`);
});
