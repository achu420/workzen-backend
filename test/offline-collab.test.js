import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { OfflinePageCollabRepository } from '../collab-repository.js';
import { encodeMessage, decodeMessage } from '../collab-protocol.js';

const fixtureRoot = path.resolve(process.env.APPFLOWY_FIXTURE_ROOT || '/Volumes/work disk/Codes/Tracker/AppFlowy/contracts/mvp/appflowy-golden');
const readFixture = (name) => readFile(path.join(fixtureRoot, 'binary', name));
const repoFor = async () => new OfflinePageCollabRepository({ initialUpdate: await readFixture('page-update-v1.bin'), objectId: 'offline-page', version: 'offline-v1' });

test('loads the source-derived AppFlowy page fixture and computes state-vector diffs', async () => {
  const repo = await repoFor(); const initialVector = repo.stateVector(); const diff = repo.missingUpdate(initialVector); assert.equal(diff.byteLength, 2); assert.ok(repo.documentUpdate().byteLength > 2);
  const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8')); const entry = manifest.fixtures.find((x) => x.file === 'page-update-v1.bin'); const bytes = await readFixture('page-update-v1.bin'); assert.equal(entry.byte_length, bytes.byteLength);
});

test('accepts a valid ordinary-text Yjs update and rejects duplicate delivery', async () => {
  const repo = await repoFor(); const client = new Y.Doc({ guid: 'offline-page' }); Y.applyUpdate(client, await readFixture('page-update-v1.bin'));
  const data = client.getMap('data').get('document'); const textMap = data.get('meta').get('text_map'); const text = [...textMap.values()].find((value) => value instanceof Y.Text); text.insert(text.length, ' offline edit');
  const update = Y.encodeStateAsUpdate(client, repo.stateVector()); const accepted = repo.acceptUpdate({ flags: 0, payload: update, version: 'offline-v1' }); assert.equal(accepted.status, 'applied'); assert.equal(accepted.durable, false); assert.equal(accepted.acknowledged, false);
  const duplicate = repo.acceptUpdate({ flags: 0, payload: update, version: 'offline-v1' }); assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.duplicate, true);
});

test('validates v2, metadata, malformed payloads, and unsupported flags safely', async () => {
  const repo = await repoFor(); const source = new Y.Doc({ guid: 'offline-page-v2' }); Y.applyUpdate(source, await readFixture('page-update-v1.bin')); source.getMap('data').set('offline_edit', 'v2');
  const valid = repo.validateUpdate({ flags: 1, payload: Y.encodeStateAsUpdateV2(source), version: 'offline-v1' }); assert.equal(valid.accepted, true);
  assert.equal(repo.validateUpdate({ flags: 7, payload: new Uint8Array([1]), version: 'offline-v1' }).reason, 'UNSUPPORTED_FLAGS');
  assert.equal(repo.validateUpdate({ flags: 0, payload: new Uint8Array([255]), version: 'offline-v1' }).reason, 'MALFORMED_YJS_UPDATE');
  assert.equal(repo.validateUpdate({ flags: 0, payload: new Uint8Array([1]), version: 'other' }).reason, 'VERSION_MISMATCH');
});

test('decodes source-shaped protobuf envelopes and rejects malformed frames', async () => {
  const objectId = 'offline-page'; const payload = await readFixture('page-update-v1.bin'); const frame = encodeMessage({ collabMessage: { objectId, collabType: 0, update: { flags: 0, payload, version: 'offline-v1', messageId: { timestamp: 99, counter: 1 } } } }); const decoded = decodeMessage(frame); assert.equal(decoded.collabMessage.objectId, objectId); assert.equal(decoded.collabMessage.update.flags, 0);
  const repo = await repoFor(); const result = repo.applyMessage(frame); assert.equal(result.status, 'applied'); assert.throws(() => decodeMessage(frame.subarray(0, frame.length - 1)));
});

test('rejects invalid sync vectors and does not claim durability or server ordering', async () => {
  const repo = await repoFor(); assert.throws(() => repo.missingUpdate(new Uint8Array([255]))); const sync = encodeMessage({ collabMessage: { objectId: 'offline-page', collabType: 0, syncRequest: { stateVector: repo.stateVector(), version: 'offline-v1' } } }); const result = repo.applyMessage(sync); assert.equal(result.status, 'sync-response'); assert.equal(result.durable, false);
});
