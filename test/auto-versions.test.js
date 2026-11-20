// Automatic document history: editing a page saves versions without anyone pressing "save version", credited to the
// people who edited, identical states are not stored, old automatic versions are pruned (hand-saved ones never), and a
// version can be restored.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';
import { account, id, startCardsEnv } from './helpers/cards-env.js';

let env, owner, pal, pageId;

const QUIET = 120;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  env = await startCardsEnv({ serverOptions: { versionQuietMs: QUIET, versionMaxMs: 600, versionKeepAuto: 3 } });
  owner = await account(env, 'versions-owner');
  pal = await account(env, 'versions-pal');
  const response = await fetch(`${env.base}/api/workspaces/${owner.workspaceId}/test-members`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}`, 'x-development-key': 'test-key' }, body: JSON.stringify({ email: pal.email, role: 'member' }) });

  assert.equal(response.status, 201);
  pal = { ...pal, workspaceId: owner.workspaceId };
  pageId = id();
  assert.equal((await env.api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, { schema_version: 'v1', request_id: id(), parent_view_id: owner.spaceId, name: 'Notes', position: { kind: 'end' }, view_id: pageId }, owner.token)).status, 200);
});
after(async () => { await env.stop(); });

async function edit(who, text) {
  const state = await env.api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, who.token);
  const client = new Y.Doc({ guid: pageId });

  Y.applyUpdate(client, new Uint8Array(state.body.data.doc_state));
  const query = new URLSearchParams({ clientId: String(Math.floor(Math.random() * 1e6)), deviceId: '00000000-0000-4000-8000-000000000009', token: who.token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${env.base.replace(/^http/, 'ws')}/ws/v2/${owner.workspaceId}/?${query}`);
  const frames = [];
  const waiters = [];

  socket.on('message', (frame) => { const message = decodeMessage(frame).collabMessage; const waiter = waiters.shift(); if (waiter) waiter(message); else frames.push(message); });
  const next = () => new Promise((resolve, reject) => { if (frames.length) return resolve(frames.shift()); const timer = setTimeout(() => reject(new Error('no frame')), 3000); return waiters.push((m) => { clearTimeout(timer); resolve(m); }); });

  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(client) } } }));
  await next();
  const before = Y.encodeStateVector(client);
  const textMap = client.getMap('data').get('document').get('meta').get('text_map');
  const content = [...textMap.values()].find((value) => value instanceof Y.Text);

  content.insert(content.length, text);
  socket.send(encodeMessage({ collabMessage: { objectId: pageId, collabType: 0, update: { flags: 0, payload: Y.encodeStateAsUpdate(client, before), beforeStateVector: before } } }));
  assert.ok((await next()).update, 'the edit was acknowledged');
  socket.close();
}

const history = async () => (await env.api('GET', `/api/workspace/${owner.workspaceId}/collab/${pageId}/history`, undefined, owner.token)).body.data;
const uidOf = async (acct) => Number((await env.store.getUserById(acct.userId)).uid);
const textOfVersion = async (version) => {
  const response = await fetch(`${env.base}/api/workspace/${owner.workspaceId}/collab/${pageId}/history/${version}?collab_type=0`, { headers: { authorization: `Bearer ${owner.token}` } });
  const doc = new Y.Doc();

  Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()));
  return [...doc.getMap('data').get('document').get('meta').get('text_map').values()].map((value) => value.toString()).join('|');
};

test('editing a page saves a version after a quiet moment, credited to the editor', async () => {
  assert.equal((await history()).length, 0);
  await edit(owner, 'first draft');
  assert.equal((await history()).length, 0, 'nothing is saved while the edit is still fresh');
  await wait(QUIET * 3);
  const versions = await history();

  assert.equal(versions.length, 1);
  assert.deepEqual([versions[0].name, versions[0].created_by, versions[0].editors], [null, await uidOf(owner), [await uidOf(owner)]]);
  assert.match(await textOfVersion(versions[0].version), /first draft/);
});

test('versions list everyone who edited since the last one, most recent editor last', async () => {
  await edit(owner, ' + owner line');
  await edit(pal, ' + pal line');
  await wait(QUIET * 3);
  const versions = await history();

  assert.equal(versions.length, 2);
  assert.deepEqual(versions[1].editors, [await uidOf(owner), await uidOf(pal)]);
  assert.equal(versions[1].created_by, await uidOf(pal));
  assert.match(await textOfVersion(versions[1].version), /owner line.*pal line|pal line.*owner line/);
});

test('an unchanged page does not get another version, and a flush saves what is still waiting', async () => {
  const count = (await history()).length;

  env.running.app.pageVersioner.touch(owner.workspaceId, pageId, owner.userId);
  await env.running.app.pageVersioner.flush();
  assert.equal((await history()).length, count, 'identical to the latest version: nothing stored');
  await edit(owner, ' + late edit');
  await env.running.app.pageVersioner.flush();
  assert.equal((await history()).length, count + 1, 'flush saves the pending edit immediately');
});

test('only the newest automatic versions stay visible; hand-saved versions are never pruned', async () => {
  const current = await env.api('GET', `/api/workspace/v1/${owner.workspaceId}/collab/${pageId}?collab_type=0`, undefined, owner.token);
  const named = await env.api('POST', `/api/workspace/${owner.workspaceId}/collab/${pageId}/history`, { name: 'Approved plan', collab_type: 0, snapshot: Buffer.from(current.body.data.doc_state).toString('base64') }, owner.token);

  assert.equal(named.status, 201, JSON.stringify(named.body));
  for (let index = 0; index < 5; index += 1) {
    await edit(owner, ` + burst ${index}`);
    await env.running.app.pageVersioner.flush();
  }
  const versions = await history();
  const namedOnes = versions.filter((version) => version.name === 'Approved plan');
  const autos = versions.filter((version) => version.name === null);

  assert.equal(namedOnes.length, 1, 'the hand-saved version survives');
  assert.equal(autos.length, 3, 'only the newest three automatic versions remain');
  assert.match(await textOfVersion(autos.at(-1).version), /burst 4/);
});

test('an automatic version can be restored, with a safety copy of what was replaced', async () => {
  const versions = await history();
  const target = versions.find((version) => version.name === null);
  const targetText = await textOfVersion(target.version);
  const restored = await env.api('POST', `/api/workspace/${owner.workspaceId}/collab/${pageId}/revert`, { version: target.version, collab_type: 0 }, owner.token);

  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const doc = new Y.Doc();

  Y.applyUpdate(doc, new Uint8Array(restored.body.data.doc_state));
  assert.equal([...doc.getMap('data').get('document').get('meta').get('text_map').values()].map((value) => value.toString()).join('|'), targetText);
  assert.ok((await history()).length > versions.length, 'the replaced content was kept as its own version');
});

test('with page history switched off no automatic versions are made', async () => {
  const off = await startCardsEnv({ serverOptions: { versionQuietMs: 50, enablePageHistory: false } });

  try {
    assert.equal(off.running.app.store.__pageVersionerAttached, undefined);
  } finally {
    await off.stop();
  }
});
