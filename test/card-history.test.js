// Card history: edits by people (browser) and by agents are recorded per card with who, what and before/after, grouped
// per burst; entries can be restored when the card still looks as that entry left it; everything is permission scoped.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';
import { account, createKitchenSink, id, KITCHEN, startCardsEnv } from './helpers/cards-env.js';
import { mcpOk, mintToken } from './helpers/mcp-live-env.js';

let env, owner, pal, outsider, db, agent;

before(async () => {
  env = await startCardsEnv({ serverOptions: { cardHistoryQuietMs: 60, cardHistoryMaxMs: 300, searchIndexDelayMs: 0 } });
  owner = await account(env, 'hist-owner');
  pal = await account(env, 'hist-pal');
  outsider = await account(env, 'hist-outsider');
  const added = await fetch(`${env.base}/api/workspaces/${owner.workspaceId}/test-members`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}`, 'x-development-key': 'test-key' }, body: JSON.stringify({ email: pal.email, role: 'member' }) });

  assert.equal(added.status, 201);
  pal = { ...pal, workspaceId: owner.workspaceId };
  db = await createKitchenSink(env, owner, 'Work');
  agent = await mintToken(env, owner, { scope: 'write', name: "Owen's Claude Code" });
});
after(async () => { await env?.stop(); });

const history = async (rowId, who = owner, query = '') => (await env.api('GET', `/api/workspace/${owner.workspaceId}/card-history/${rowId}${query}`, undefined, who.token)).body.data;
const flush = () => env.running.app.cardHistory.flush();
const restore = (rowId, entryId, who = owner) => env.api('POST', `/api/workspace/${owner.workspaceId}/card-history/${rowId}/${entryId}/restore`, undefined, who.token);
let seq = 0;
const newCard = async (fields = {}) => (await mcpOk(env, agent.token, 'create_card', { database_id: db.databaseId, title: `Card ${(seq += 1)}`, idempotency_key: `hist-card-${seq}-000001`, fields: { Notes: 'original notes', Status: 'Todo', ...fields } })).card;
const getCard = async (rowId) => (await mcpOk(env, agent.token, 'get_card', { card_id: rowId })).card;

// What a browser does: a Yjs diff on the row document, accepted with the user who sent it.
async function personEdit(user, rowId, mutate) {
  const collab = await env.store.getDatabaseRowCollab(owner.workspaceId, rowId);
  const doc = new Y.Doc({ guid: rowId });

  Y.applyUpdate(doc, collab.doc_state);
  const stateBefore = Y.encodeStateVector(doc);

  doc.transact(() => mutate(doc.getMap('data').get('data')));
  const payload = Y.encodeStateAsUpdate(doc, stateBefore);

  doc.destroy();
  return env.store.acceptDatabaseRowCollabUpdate({ workspaceId: owner.workspaceId, rowId, flags: 0, payload, beforeStateVector: stateBefore, actorUserId: user.userId });
}
const setNotes = (text) => (row) => row.get('cells').get(KITCHEN.notes).set('data', text);

test('a person\'s edit is recorded with who, which field, and the values before and after', async () => {
  const card = await newCard();

  await flush();
  const baseline = (await history(card.id)).entries.length;

  await personEdit(pal, card.id, setNotes('edited by a person'));
  await flush();
  const { entries } = await history(card.id);

  assert.equal(entries.length, baseline + 1);
  const entry = entries[0];

  assert.deepEqual(entry.actors.map((actor) => actor.email), [pal.email]);
  assert.equal(entry.via, null);
  assert.equal(entry.title, card.title);
  assert.deepEqual(entry.changes, [{ kind: 'field', field: 'Notes', before: 'original notes', after: 'edited by a person', restorable: true }]);
  assert.deepEqual([entry.can_restore, entry.restored], [true, false]);
});

test('a burst of edits is one entry (first before, last after); two people are both listed, the last credited', async () => {
  const card = await newCard();

  await flush();
  const baseline = (await history(card.id)).entries.length;

  await personEdit(owner, card.id, setNotes('draft one'));
  await personEdit(owner, card.id, setNotes('draft two'));
  await personEdit(pal, card.id, setNotes('final wording'));
  await flush();
  const { entries } = await history(card.id);

  assert.equal(entries.length, baseline + 1, 'one entry for the burst');
  assert.deepEqual(entries[0].changes[0], { kind: 'field', field: 'Notes', before: 'original notes', after: 'final wording', restorable: true });
  assert.deepEqual(entries[0].actors.map((actor) => actor.email), [owner.email, pal.email], 'everyone who edited, the last one last');
});

test('edits that change nothing leave no entry, and typing then undoing in one burst nets out to nothing', async () => {
  const card = await newCard();

  await flush();
  const baseline = (await history(card.id)).entries.length;

  await personEdit(pal, card.id, setNotes('original notes'));
  await personEdit(pal, card.id, setNotes('temporary'));
  await personEdit(pal, card.id, setNotes('original notes'));
  await flush();
  assert.equal((await history(card.id)).entries.length, baseline);
});

test('agent edits are recorded too, credited to the token\'s owner and named after the agent', async () => {
  const card = await newCard();

  await flush();
  await mcpOk(env, agent.token, 'update_card', { card_id: card.id, title: 'Renamed by agent', fields: { Notes: 'agent notes', Points: 8 } });
  await mcpOk(env, agent.token, 'move_card', { card_id: card.id, column: 'Done' });
  await flush();
  const { entries } = await history(card.id);
  const changes = entries.flatMap((entry) => entry.changes.map((change) => [change.kind, change.field, change.before, change.after]));

  assert.ok(entries.every((entry) => entry.via === "Owen's Claude Code"));
  assert.ok(entries.every((entry) => entry.actors.at(-1).email === owner.email));
  assert.ok(changes.some(([kind, field, , after]) => kind === 'title' && field === 'Title' && after === 'Renamed by agent'));
  assert.ok(changes.some(([, field, before, after]) => field === 'Notes' && before === 'original notes' && after === 'agent notes'));
  assert.ok(changes.some(([, field, before, after]) => field === 'Points' && before === null && after === 8));
  assert.ok(changes.some(([, field, before, after]) => field === 'Status' && before === 'Todo' && after === 'Done'));
});

test('restoring an entry puts the old values back once, is recorded as its own change, and is refused after a later edit', async () => {
  const card = await newCard();

  await flush();
  await personEdit(pal, card.id, setNotes('first rewrite'));
  await flush();
  await personEdit(pal, card.id, setNotes('second rewrite'));
  await flush();
  const [latest, earlier] = (await history(card.id)).entries;

  assert.equal(latest.changes[0].after, 'second rewrite');
  // The older entry no longer matches (the second rewrite is on top of it).
  const refused = await restore(card.id, earlier.id);

  assert.deepEqual([refused.status, refused.body.error.code], [409, 'CHANGED_SINCE']);
  assert.match(refused.body.error.message, /"Notes" was changed after this edit/);
  assert.equal((await getCard(card.id)).fields.Notes, 'second rewrite', 'nothing was touched');
  // The newest one can be restored, by anyone in the workspace.
  const done = await restore(card.id, latest.id, owner);

  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await getCard(card.id)).fields.Notes, 'first rewrite');
  assert.deepEqual([(await restore(card.id, latest.id)).status, (await restore(card.id, latest.id)).body.error.code], [409, 'ALREADY_RESTORED']);
  await flush();
  const after = (await history(card.id)).entries;

  assert.equal(after.find((entry) => entry.id === latest.id).restored, true);
  assert.deepEqual([after[0].changes[0].before, after[0].changes[0].after, after[0].actors[0].email], ['second rewrite', 'first rewrite', owner.email], 'the restore itself is in the history, credited to who did it');
  // With the second rewrite gone, the earlier entry fits again.
  assert.equal((await restore(card.id, earlier.id)).status, 200);
  assert.equal((await getCard(card.id)).fields.Notes, 'original notes');
});

test('restoring a title and several fields together is all or nothing', async () => {
  const card = await newCard();

  await flush();
  await mcpOk(env, agent.token, 'update_card', { card_id: card.id, title: 'New title', fields: { Notes: 'new notes', Points: 3 } });
  await flush();
  const [entry] = (await history(card.id)).entries;

  assert.equal(entry.changes.length, 3);
  await personEdit(pal, card.id, (row) => row.get('cells').get(KITCHEN.points).set('data', '99'));
  await flush();
  const blocked = await restore(card.id, entry.id);

  assert.deepEqual([blocked.status, blocked.body.error.code], [409, 'CHANGED_SINCE']);
  const current = await getCard(card.id);

  assert.deepEqual([current.title, current.fields.Notes], ['New title', 'new notes'], 'the untouched fields were not rolled back either');
});

test('archiving is recorded and restoring that entry brings the card back', async () => {
  const card = await newCard();

  await flush();
  await mcpOk(env, agent.token, 'archive_card', { card_id: card.id, confirm: true });
  await flush();
  const [entry] = (await history(card.id)).entries;

  assert.deepEqual(entry.changes.map((change) => [change.kind, change.before, change.after]), [['archived', false, true]]);
  assert.equal((await restore(card.id, entry.id)).status, 200);
  assert.equal((await getCard(card.id)).archived, false);
});

test('history is scoped to the workspace and validated: outsiders, unknown cards, foreign entries, bad ids', async () => {
  const card = await newCard();
  const other = await newCard();

  await flush();
  await personEdit(pal, card.id, setNotes('scoped edit'));
  await personEdit(pal, other.id, setNotes('other edit'));
  await flush();
  const [entry] = (await history(card.id)).entries;
  const [foreign] = (await history(other.id)).entries;
  const base = `/api/workspace/${owner.workspaceId}/card-history`;

  assert.equal((await env.api('GET', `${base}/${card.id}`, undefined, outsider.token)).status, 403);
  assert.equal((await env.api('GET', `${base}/${card.id}`)).status, 401);
  assert.equal((await env.api('POST', `${base}/${card.id}/${entry.id}/restore`, undefined, outsider.token)).status, 403);
  assert.equal((await env.api('GET', `${base}/${id()}`, undefined, owner.token)).status, 404, 'unknown card');
  assert.equal((await env.api('GET', `${base}/not-an-id`, undefined, owner.token)).status, 404);
  assert.equal((await restore(card.id, foreign.id)).status, 404, 'an entry of another card');
  assert.equal((await restore(card.id, id())).status, 404);
  assert.equal((await env.api('GET', `${base}/${card.id}?before=nope`, undefined, owner.token)).status, 400);
  assert.equal((await env.api('GET', `/api/workspace/${outsider.workspaceId}/card-history/${card.id}`, undefined, outsider.token)).status, 404, "another workspace's card id is invisible");
});

test('listing pages newest first without gaps, and the history survives a restart', async () => {
  const card = await newCard();

  await flush();
  for (let index = 0; index < 5; index += 1) {
    await personEdit(pal, card.id, setNotes(`version ${index}`));
    await flush();
  }
  const all = (await history(card.id, owner, '?limit=50')).entries;
  const walked = [];
  let page = await history(card.id, owner, '?limit=2');

  walked.push(...page.entries.map((entry) => entry.id));
  while (page.has_more) {
    page = await history(card.id, owner, `?limit=2&before=${encodeURIComponent(page.next_before)}`);
    walked.push(...page.entries.map((entry) => entry.id));
  }
  assert.deepEqual(walked, all.map((entry) => entry.id));
  assert.ok(all.every((entry, index) => index === 0 || all[index - 1].created_at >= entry.created_at));
  assert.equal(all.length, 5);
  await env.restart();
  assert.deepEqual((await history(card.id, owner, '?limit=50')).entries.map((entry) => entry.id), all.map((entry) => entry.id), 'durable');
});

test('paging never skips entries that share a timestamp', async () => {
  const card = await newCard();
  const same = '2030-01-01T00:00:00.000Z';
  const ids = [];

  for (let index = 0; index < 7; index += 1) {
    const entryId = id();

    ids.push(entryId);
    await env.store.recordCardHistory({ id: entryId, workspace_id: owner.workspaceId, database_id: db.databaseId, row_id: card.id, title: 't', actor_user_id: null, actor_user_ids: [], via: null, changes: [{ kind: 'field', field: 'F', before: index, after: index + 1, restorable: true }], created_at: same });
  }
  const walked = [];
  let page = await history(card.id, owner, '?limit=3');

  walked.push(...page.entries.map((entry) => entry.id));
  while (page.has_more) {
    page = await history(card.id, owner, `?limit=3&before=${encodeURIComponent(page.next_before)}`);
    walked.push(...page.entries.map((entry) => entry.id));
  }
  assert.deepEqual([...walked].sort(), [...ids].sort(), 'every entry exactly once');
  assert.equal(new Set(walked).size, 7);
});

test('rows that are not cards (hidden template rows) are ignored, and only 200 entries are kept per card', async () => {
  const hidden = await env.api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/row-document`, { request_id: id(), database_id: db.databaseId, database_restore_id: '00000000-0000-0000-0000-000000000000', row_id: id(), source_view_id: db.gridViewId, name: 'hidden', contribution: { kind: 'default_schema', schema_version: 'v1' } }, owner.token);

  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  await flush();
  const store = env.store;
  const rowId = id();

  for (let index = 0; index < 205; index += 1) {
    await store.recordCardHistory({ id: id(), workspace_id: owner.workspaceId, database_id: db.databaseId, row_id: rowId, title: 't', actor_user_id: null, actor_user_ids: [], via: null, changes: [{ kind: 'field', field: 'F', before: index, after: index + 1, restorable: true }], created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() });
  }
  const kept = (await store.listCardHistory(owner.workspaceId, rowId, { limit: 500 })).entries;

  assert.equal(kept.length, 200);
  assert.equal(kept.at(-1).changes[0].before, 5, 'the oldest five were dropped');
});

test('edits arriving over the real WebSocket are credited to the connected user', async () => {
  const card = await newCard();

  await flush();
  const query = new URLSearchParams({ clientId: '77', deviceId: '00000000-0000-4000-8000-000000000077', token: pal.token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${env.base.replace(/^http/, 'ws')}/ws/v2/${owner.workspaceId}/?${query}`);
  const frames = [];
  const waiters = [];

  socket.on('message', (frame) => { const message = decodeMessage(frame).collabMessage; const waiter = waiters.shift(); if (waiter) waiter(message); else frames.push(message); });
  const next = () => new Promise((resolve, reject) => { if (frames.length) return resolve(frames.shift()); const timer = setTimeout(() => reject(new Error('no frame')), 3000); return waiters.push((m) => { clearTimeout(timer); resolve(m); }); });

  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const collab = await env.store.getDatabaseRowCollab(owner.workspaceId, card.id);
  const client = new Y.Doc({ guid: card.id });

  Y.applyUpdate(client, collab.doc_state);
  socket.send(encodeMessage({ collabMessage: { objectId: card.id, collabType: 4, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(client) } } }));
  await next();
  const stateBefore = Y.encodeStateVector(client);

  client.getMap('data').get('data').get('cells').get(KITCHEN.notes).set('data', 'typed in the browser');
  socket.send(encodeMessage({ collabMessage: { objectId: card.id, collabType: 4, update: { flags: 0, payload: Y.encodeStateAsUpdate(client, stateBefore), beforeStateVector: stateBefore } } }));
  assert.ok((await next()).update);
  socket.close();
  await flush();
  const [entry] = (await history(card.id)).entries;

  assert.deepEqual([entry.actors.map((actor) => actor.email), entry.changes[0].after], [[pal.email], 'typed in the browser']);
});
