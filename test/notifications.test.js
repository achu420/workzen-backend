// Inbox notifications: list / unread-count / read / archive (notification-api.ts) and the
// producers that fill them (comment mentions and replies, page-mention, row-comment
// notification), plus the live WebSocket pushes (inbox_notification, comment_changed).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { id } from '../auth.js';
import { startServer } from '../server.js';
import { decodeMessage, encodeMessage } from '../collab-protocol.js';

let dir, running, base;

async function api(method, route, payload, token, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-notifications-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'notify-key', environment: 'test' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const PUBLIC_SPACE_PERMISSION = {
  visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
  invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
  security: { disable_guests: false, disable_public_links: false, disable_export: false },
};

async function registerAndLogin(label) {
  const email = `${label}-${id()}@example.test`;
  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 907' })).status, 201);
  const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 907' })).body.access_token;
  const user = (await api('GET', '/api/auth/me', undefined, token)).body.user;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  const profile = (await api('GET', `/api/workspace/${workspaceId}/workspace-profile`, undefined, token)).body.data;
  return { email, token, userId: user.id, uid: profile.uid, workspaceId };
}

async function addMember(owner, member) {
  assert.equal((await api('POST', `/api/workspaces/${owner.workspaceId}/test-members`, { email: member.email, role: 'member' }, owner.token, { 'x-development-key': 'notify-key' })).status, 201);
  return { ...member, workspaceId: owner.workspaceId };
}

// A owns the workspace and the page; B and C are members; X is in a different workspace.
async function setup(label) {
  const a = await registerAndLogin(`${label}-a`);
  const b = await addMember(a, await registerAndLogin(`${label}-b`));
  const c = await addMember(a, await registerAndLogin(`${label}-c`));
  const outsider = await registerAndLogin(`${label}-x`);
  const spaceId = id();
  assert.equal((await api('POST', `/api/workspace/${a.workspaceId}/spaces`, { name: 'Team space', view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, a.token)).status, 200);
  const pageId = id();
  assert.equal((await api('POST', `/api/workspace/${a.workspaceId}/v2/page-view/document/default`, {
    schema_version: 'v1', request_id: id(), view_id: pageId, parent_view_id: spaceId, name: 'Roadmap', position: { kind: 'start' },
  }, a.token)).status, 200);
  return { a, b, c, outsider, pageId, spaceId, ws: a.workspaceId, commentRoute: `/api/workspace/${a.workspaceId}/document/${pageId}/inline-comment/v2` };
}

const comment = (ctx, who, payload) => api('POST', ctx.commentRoute, payload, who.token);
const inbox = async (ctx, who, query = '') => (await api('GET', `/api/workspace/${ctx.ws}/notifications${query}`, undefined, who.token)).body.data;
const unread = async (ctx, who) => (await api('GET', `/api/workspace/${ctx.ws}/notifications/unread-count`, undefined, who.token)).body.data.unread_count;
const mutate = (ctx, who, action, payload = {}) => api('POST', `/api/workspace/${ctx.ws}/notifications/${action}`, payload, who.token);

test('a comment that mentions someone lands in their inbox with the shape the web client reads', async () => {
  const ctx = await setup('mention');
  assert.equal(await unread(ctx, ctx.b), 0);
  const created = await comment(ctx, ctx.a, { content: 'ping @[B](x)', block_id: 'blk-1', mentioned_user_uuids: [ctx.b.userId] });
  assert.equal(created.status, 200);

  const { notifications, has_more } = await inbox(ctx, ctx.b);
  assert.equal(has_more, false);
  assert.equal(notifications.length, 1);
  const [n] = notifications;
  assert.equal(n.type, 'mention');
  assert.equal(n.workspace_id, ctx.ws);
  assert.equal(n.view_id, ctx.pageId);
  assert.equal(n.actor_uid, ctx.a.uid);
  assert.equal(typeof n.actor_uid, 'number');
  assert.equal(n.is_read, false);
  assert.equal(n.is_archived, false);
  assert.equal(n.read_at, null);
  assert.ok(Date.parse(n.created_at) > 0);
  assert.equal(n.metadata.actor_name, ctx.a.email.split('@')[0]);
  assert.equal(n.metadata.page_name, 'Roadmap');
  assert.equal(n.metadata.page_path, 'Team space');
  assert.equal(n.metadata.block_id, 'blk-1');
  assert.equal(n.metadata.comment_id, created.body.data.comment_id);
  assert.equal(await unread(ctx, ctx.b), 1);
});

test('the actor is never notified and non-members are ignored', async () => {
  const ctx = await setup('actor');
  // A owns the page, mentions themself and an outsider.
  await comment(ctx, ctx.a, { content: 'note to self', mentioned_user_uuids: [ctx.a.userId, ctx.outsider.userId] });
  assert.equal(await unread(ctx, ctx.a), 0);
  const outsiderInbox = await api('GET', `/api/workspace/${ctx.outsider.workspaceId}/notifications`, undefined, ctx.outsider.token);
  assert.deepEqual(outsiderInbox.body.data.notifications, []);
});

test('one notification per recipient: mention beats reply beats comment_on_page', async () => {
  const ctx = await setup('precedence');
  // B comments on A's page: A (page creator) gets comment_on_page.
  const parent = (await comment(ctx, ctx.b, { content: 'first' })).body.data.comment_id;
  assert.deepEqual((await inbox(ctx, ctx.a)).notifications.map((n) => n.type), ['comment_on_page']);
  assert.equal((await inbox(ctx, ctx.b)).notifications.length, 0);

  // A replies to B and also mentions B: B gets exactly one, a mention.
  const reply = (await comment(ctx, ctx.a, { content: 'ack', reply_comment_id: parent, mentioned_user_uuids: [ctx.b.userId] })).body.data.comment_id;
  assert.deepEqual((await inbox(ctx, ctx.b)).notifications.map((n) => n.type), ['mention']);

  // A replies again without a mention: B gets a comment_reply (parent author), C is not involved.
  await comment(ctx, ctx.a, { content: 'one more', reply_comment_id: parent });
  assert.deepEqual((await inbox(ctx, ctx.b)).notifications.map((n) => n.type).sort(), ['comment_reply', 'mention']);
  assert.equal((await inbox(ctx, ctx.c)).notifications.length, 0);

  // B replies to A's reply: A is both parent author and page creator -> a single comment_reply.
  await comment(ctx, ctx.b, { content: 'thanks', reply_comment_id: reply });
  const aTypes = (await inbox(ctx, ctx.a)).notifications.map((n) => n.type).sort();
  assert.deepEqual(aTypes, ['comment_on_page', 'comment_reply']);
});

test('read, read-all, archive and archive-all change only the caller inbox', async () => {
  const ctx = await setup('state');
  for (let index = 0; index < 3; index += 1) await comment(ctx, ctx.a, { content: `m${index}`, mentioned_user_uuids: [ctx.b.userId, ctx.c.userId] });
  const bIds = (await inbox(ctx, ctx.b)).notifications.map((n) => n.id);
  assert.equal(bIds.length, 3);
  assert.equal(await unread(ctx, ctx.b), 3);
  assert.equal(await unread(ctx, ctx.c), 3);

  assert.equal((await mutate(ctx, ctx.b, 'read', { ids: [bIds[0]] })).status, 200);
  assert.equal(await unread(ctx, ctx.b), 2);
  const readOne = (await inbox(ctx, ctx.b)).notifications.find((n) => n.id === bIds[0]);
  assert.equal(readOne.is_read, true);
  assert.ok(Date.parse(readOne.read_at) > 0);
  assert.equal((await inbox(ctx, ctx.b, '?unread_only=true')).notifications.length, 2);

  // C cannot touch B's notifications, and B's changes never touched C's.
  await mutate(ctx, ctx.c, 'read', { ids: [bIds[1]] });
  await mutate(ctx, ctx.c, 'archive', { ids: bIds });
  assert.equal(await unread(ctx, ctx.b), 2);
  assert.equal((await inbox(ctx, ctx.b)).notifications.length, 3);
  assert.equal(await unread(ctx, ctx.c), 3, "passing B's ids changes nothing in C's own inbox");
});

test('archive moves items to the archived list and out of the unread count', async () => {
  const ctx = await setup('archive');
  for (let index = 0; index < 3; index += 1) await comment(ctx, ctx.a, { content: `m${index}`, mentioned_user_uuids: [ctx.b.userId] });
  const ids = (await inbox(ctx, ctx.b)).notifications.map((n) => n.id);

  assert.equal((await mutate(ctx, ctx.b, 'archive', { ids: [ids[0]] })).status, 200);
  assert.equal((await inbox(ctx, ctx.b)).notifications.length, 2);
  const archived = (await inbox(ctx, ctx.b, '?archived=true')).notifications;
  assert.deepEqual(archived.map((n) => n.id), [ids[0]]);
  assert.equal(archived[0].is_archived, true);
  assert.equal(await unread(ctx, ctx.b), 2, 'archived items no longer count as unread');

  assert.equal((await mutate(ctx, ctx.b, 'read-all')).status, 200);
  assert.equal(await unread(ctx, ctx.b), 0);
  assert.equal((await inbox(ctx, ctx.b, '?unread_only=true')).notifications.length, 0);

  assert.equal((await mutate(ctx, ctx.b, 'archive-all')).status, 200);
  assert.equal((await inbox(ctx, ctx.b)).notifications.length, 0);
  assert.equal((await inbox(ctx, ctx.b, '?archived=true')).notifications.length, 3);
});

test('listing is newest first and pages with offset/limit', async () => {
  const ctx = await setup('paging');
  for (let index = 0; index < 5; index += 1) await comment(ctx, ctx.a, { content: `m${index}`, mentioned_user_uuids: [ctx.b.userId] });
  const all = (await inbox(ctx, ctx.b)).notifications;
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((n) => n.created_at), [...all.map((n) => n.created_at)].sort().reverse());
  const first = await inbox(ctx, ctx.b, '?limit=2&offset=0');
  assert.equal(first.notifications.length, 2);
  assert.equal(first.has_more, true);
  const last = await inbox(ctx, ctx.b, '?limit=2&offset=4');
  assert.equal(last.notifications.length, 1);
  assert.equal(last.has_more, false);
  assert.deepEqual([...first.notifications, ...(await inbox(ctx, ctx.b, '?limit=3&offset=2')).notifications].map((n) => n.id), all.map((n) => n.id));
  assert.equal((await api('GET', `/api/workspace/${ctx.ws}/notifications?limit=0`, undefined, ctx.b.token)).status, 400);
});

test('notification routes validate input and require membership', async () => {
  const ctx = await setup('validate');
  assert.equal((await mutate(ctx, ctx.b, 'read', {})).status, 400);
  assert.equal((await mutate(ctx, ctx.b, 'archive', { ids: ['nope'] })).status, 400);
  assert.equal((await mutate(ctx, ctx.b, 'read', { ids: [id()] })).status, 200, 'unknown ids are a no-op');
  assert.equal((await api('GET', `/api/workspace/${ctx.ws}/notifications`, undefined, ctx.outsider.token)).status, 403);
  assert.equal((await api('GET', `/api/workspace/${ctx.ws}/notifications`)).status, 401);
});

test('page-mention: notifies members once, distinguishes assignment, ignores self/non-members/opt-out', async () => {
  const ctx = await setup('page-mention');
  const route = `/api/workspace/${ctx.ws}/page-view/${ctx.pageId}/page-mention`;
  const put = (who, payload) => api('PUT', route, payload, who.token);

  assert.equal((await put(ctx.a, { person_id: ctx.b.userId, block_id: 'blk-7', require_notification: false, view_name: 'Roadmap' })).status, 200);
  assert.equal(await unread(ctx, ctx.b), 0, 'require_notification false sends nothing');

  assert.equal((await put(ctx.a, { person_id: ctx.b.userId, block_id: 'blk-7', require_notification: true, view_name: 'Roadmap v2' })).status, 200);
  assert.equal((await put(ctx.a, { person_id: ctx.b.userId, block_id: 'blk-7', require_notification: true, view_name: 'Roadmap v2' })).status, 200);
  const mentions = (await inbox(ctx, ctx.b)).notifications;
  assert.equal(mentions.length, 1, 'an identical unread mention is not repeated');
  assert.equal(mentions[0].type, 'mention');
  assert.equal(mentions[0].metadata.page_name, 'Roadmap v2');
  assert.equal(mentions[0].metadata.block_id, 'blk-7');

  const rowId = id();
  assert.equal((await put(ctx.a, { person_id: ctx.b.userId, row_id: rowId, require_notification: true, view_name: 'Row 1', is_row_document: false })).status, 200);
  assert.deepEqual((await inbox(ctx, ctx.b)).notifications.map((n) => n.type).sort(), ['mention', 'person_property_assigned']);
  assert.equal((await inbox(ctx, ctx.b)).notifications.find((n) => n.type === 'person_property_assigned').metadata.row_id, rowId);

  await put(ctx.a, { person_id: ctx.a.userId, block_id: 'x', require_notification: true, view_name: 'self' });
  await put(ctx.a, { person_id: ctx.outsider.userId, block_id: 'x', require_notification: true, view_name: 'outsider' });
  assert.equal(await unread(ctx, ctx.a), 0);

  assert.equal((await put(ctx.a, { require_notification: true })).status, 400);
  assert.equal((await put(ctx.a, { person_id: ctx.b.userId })).status, 400);
  assert.equal((await api('PUT', `/api/workspace/${ctx.ws}/page-view/${id()}/page-mention`, { person_id: ctx.b.userId, require_notification: true }, ctx.a.token)).status, 404);
});

test('row comment notification: mentions and thread participants, never the author', async () => {
  const ctx = await setup('row-comment');
  const rowId = id();
  const route = `/api/workspace/${ctx.ws}/database/${ctx.pageId}/row/${rowId}/comment/notification`;
  const commentId = id();
  const response = await api('POST', route, {
    comment_id: commentId, content: 'see this', mentioned_user_uuids: [ctx.b.userId, ctx.a.userId],
    reply_participant_uuids: [ctx.b.userId, ctx.c.userId], view_name: 'Task 12',
  }, ctx.a.token);
  assert.equal(response.status, 200);

  const bNotes = (await inbox(ctx, ctx.b)).notifications;
  assert.deepEqual(bNotes.map((n) => n.type), ['mention'], 'mention wins over being a thread participant');
  assert.equal(bNotes[0].metadata.row_id, rowId);
  assert.equal(bNotes[0].metadata.page_name, 'Task 12');
  assert.equal(bNotes[0].view_id, ctx.pageId);
  assert.deepEqual((await inbox(ctx, ctx.c)).notifications.map((n) => n.type), ['comment_reply']);
  assert.equal(await unread(ctx, ctx.a), 0);

  assert.equal((await api('POST', route, { content: 'x' }, ctx.a.token)).status, 400);
  assert.equal((await api('POST', `/api/workspace/${ctx.ws}/database/${id()}/row/${rowId}/comment/notification`, { comment_id: id(), mentioned_user_uuids: [], reply_participant_uuids: [] }, ctx.a.token)).status, 404);
});

// ---- realtime ----
function connect(ctx, who, clientId) {
  const wsBase = base.replace(/^http/, 'ws');
  const query = new URLSearchParams({ clientId: String(clientId), deviceId: `00000000-0000-4000-8000-00000000${String(clientId).padStart(4, '0')}`, token: who.token, cv: '0.10.0', cp: 'web' });
  const socket = new WebSocket(`${wsBase}/ws/v2/${ctx.ws}/?${query}`);
  const notifications = [];
  socket.on('message', (frame, isBinary) => {
    if (!isBinary) return;
    const message = decodeMessage(frame);
    if (message.notification) notifications.push(message.notification);
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => {
      // Only sockets that finished a SyncRequest are registered for pushes.
      socket.send(encodeMessage({ collabMessage: { objectId: ctx.pageId, collabType: 0, syncRequest: { lastMessageId: { timestamp: 0, counter: 0 }, stateVector: Y.encodeStateVector(new Y.Doc()) } } }), { binary: true });
      setTimeout(() => resolve({ socket, notifications }), 300);
    });
  });
}
const settle = (milliseconds = 400) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('live pushes: comment_changed reaches the workspace, inbox_notification only the recipient', async () => {
  const ctx = await setup('realtime');
  const sockets = {
    a: await connect(ctx, ctx.a, 1),
    b: await connect(ctx, ctx.b, 2),
    c: await connect(ctx, ctx.c, 3),
    outsider: await connect({ ...ctx, ws: ctx.outsider.workspaceId }, ctx.outsider, 4),
  };
  try {
    await comment(ctx, ctx.a, { content: 'hello @B', mentioned_user_uuids: [ctx.b.userId] });
    await settle();

    for (const name of ['a', 'b', 'c']) {
      const changed = sockets[name].notifications.filter((n) => n.commentChanged);
      assert.equal(changed.length, 1, `${name} gets comment_changed`);
      assert.deepEqual({ ...changed[0].commentChanged }, { workspaceId: ctx.ws, viewId: ctx.pageId });
    }
    assert.equal(sockets.outsider.notifications.length, 0, 'another workspace hears nothing');

    const bInbox = sockets.b.notifications.filter((n) => n.inboxNotification);
    assert.equal(bInbox.length, 1);
    const pushed = bInbox[0].inboxNotification;
    const stored = (await inbox(ctx, ctx.b)).notifications[0];
    assert.equal(pushed.id, stored.id);
    assert.equal(pushed.type, 'mention');
    assert.equal(pushed.viewId, ctx.pageId);
    assert.equal(Number(pushed.actorUid), ctx.a.uid);
    assert.deepEqual(JSON.parse(pushed.metadataJson), stored.metadata);
    assert.equal(Number(pushed.createdAt), Math.floor(Date.parse(stored.created_at) / 1000));
    assert.equal(sockets.a.notifications.filter((n) => n.inboxNotification).length, 0, 'the author gets no inbox push');
    assert.equal(sockets.c.notifications.filter((n) => n.inboxNotification).length, 0, 'an uninvolved member gets no inbox push');

    // Resolve / react also announce a comment change.
    const commentId = (await api('GET', ctx.commentRoute.replace('/v2', ''), undefined, ctx.a.token)).body.data.comments[0].comment_id;
    await api('PUT', ctx.commentRoute.replace('/v2', '/resolve'), { comment_id: commentId, is_resolved: true }, ctx.b.token);
    await settle();
    assert.equal(sockets.c.notifications.filter((n) => n.commentChanged).length, 2);
  } finally {
    for (const { socket } of Object.values(sockets)) socket.close();
  }
});
