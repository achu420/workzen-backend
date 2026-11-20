// Inline document comments: /api/workspace/{ws}/document/{view}/inline-comment*
// (AppFlowy-Web inline-comment-api.ts). Flat comments, soft delete, resolve,
// reactions, paging and workspace scoping.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { id } from '../auth.js';
import { startServer } from '../server.js';

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-inline-comments-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'comment-key', environment: 'test' });
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
  return { email, token, userId: user.id, workspaceId };
}

async function addMember(owner, memberEmail) {
  assert.equal((await api('POST', `/api/workspaces/${owner.workspaceId}/test-members`, { email: memberEmail, role: 'member' }, owner.token, { 'x-development-key': 'comment-key' })).status, 201);
}

async function createPage(owner, label) {
  const spaceId = id();
  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/spaces`, { name: `${label} space`, view_id: spaceId, permission: PUBLIC_SPACE_PERMISSION }, owner.token)).status, 200);
  const pageId = id();
  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, {
    schema_version: 'v1', request_id: id(), view_id: pageId, parent_view_id: spaceId, name: `${label} page`, position: { kind: 'start' },
  }, owner.token)).status, 200);
  return pageId;
}

// Owner + one extra member in the owner's workspace, and a page they can comment on.
async function setup(label) {
  const owner = await registerAndLogin(`${label}-owner`);
  const member = await registerAndLogin(`${label}-member`);
  await addMember(owner, member.email);
  const pageId = await createPage(owner, label);
  const route = `/api/workspace/${owner.workspaceId}/document/${pageId}/inline-comment`;
  return { owner, member, pageId, route };
}

const post = (ctx, who, payload, suffix = '/v2') => api('POST', `${ctx.route}${suffix}`, payload, who.token);
const list = async (ctx, who, query = '') => (await api('GET', `${ctx.route}${query}`, undefined, who.token)).body.data;

test('an empty page lists no comments', async () => {
  const ctx = await setup('empty');
  const response = await api('GET', ctx.route, undefined, ctx.owner.token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, { comments: [], has_more: false, next_offset: null });
});

test('create returns the id; v2 and the legacy route both work; list carries user, flags and block anchor', async () => {
  const ctx = await setup('create');
  const created = await post(ctx, ctx.owner, { content: '  hello  ', block_id: 'block-1', mentioned_user_uuids: [] });
  assert.equal(created.status, 200);
  assert.match(created.body.data.comment_id, /^[0-9a-f-]{36}$/);
  assert.equal((await post(ctx, ctx.member, { content: 'second' }, '')).status, 200);

  const { comments } = await list(ctx, ctx.owner);
  assert.equal(comments.length, 2);
  const [first, second] = comments;
  assert.equal(first.comment_id, created.body.data.comment_id);
  assert.equal(first.content, 'hello', 'content is trimmed');
  assert.equal(first.block_id, 'block-1');
  assert.equal(first.view_id, ctx.pageId);
  assert.equal(first.reply_comment_id, null);
  assert.equal(first.is_resolved, false);
  assert.equal(first.is_deleted, false);
  assert.equal(first.user.uuid, ctx.owner.userId);
  assert.equal(first.user.name, ctx.owner.email.split('@')[0], 'falls back to the email local part');
  assert.equal(first.user.avatar_url, null);
  assert.equal(first.can_be_deleted, true);
  assert.ok(Date.parse(first.created_at) > 0 && Date.parse(first.updated_at) > 0);
  assert.equal(second.user.uuid, ctx.member.userId);

  const memberView = await list(ctx, ctx.member);
  assert.equal(memberView.comments[0].can_be_deleted, false, 'a member cannot delete the owner comment');
  assert.equal(memberView.comments[1].can_be_deleted, true);
});

test('a profile name and icon show up on the comment user', async () => {
  const ctx = await setup('profile');
  assert.equal((await api('POST', '/api/user/update', { name: 'Ada Lovelace', metadata: { icon_url: 'https://example.test/a.png' } }, ctx.owner.token)).status, 200);
  await post(ctx, ctx.owner, { content: 'hi' });
  const [comment] = (await list(ctx, ctx.owner)).comments;
  assert.deepEqual(comment.user, { uuid: ctx.owner.userId, name: 'Ada Lovelace', avatar_url: 'https://example.test/a.png' });
});

test('replies reference a comment on the same page and inherit its block', async () => {
  const ctx = await setup('reply');
  const parent = (await post(ctx, ctx.owner, { content: 'parent', block_id: 'b-9' })).body.data.comment_id;
  const reply = await post(ctx, ctx.member, { content: 'reply', reply_comment_id: parent });
  assert.equal(reply.status, 200);
  const comments = (await list(ctx, ctx.owner)).comments;
  const stored = comments.find((comment) => comment.comment_id === reply.body.data.comment_id);
  assert.equal(stored.reply_comment_id, parent);
  assert.equal(stored.block_id, 'b-9');

  const otherPage = await createPage(ctx.owner, 'reply-other');
  const foreign = await api('POST', `/api/workspace/${ctx.owner.workspaceId}/document/${otherPage}/inline-comment/v2`, { content: 'x', reply_comment_id: parent }, ctx.owner.token);
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.error.code, 'INVALID_REPLY_TARGET');
});

test('invalid comment bodies are rejected', async () => {
  const ctx = await setup('validate');
  for (const bad of [{}, { content: '   ' }, { content: 5 }, { content: 'x'.repeat(10_001) }, { content: 'x', block_id: 5 }, { content: 'x', reply_comment_id: 'nope' }, { content: 'x', mentioned_user_uuids: 'nope' }]) {
    assert.equal((await post(ctx, ctx.owner, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await post(ctx, ctx.owner, { content: 'x'.repeat(10_000) })).status, 200);
  assert.equal((await api('GET', `${ctx.route}?limit=0`, undefined, ctx.owner.token)).status, 400);
  assert.equal((await api('GET', `${ctx.route}?offset=-1`, undefined, ctx.owner.token)).status, 400);
});

test('paging walks the list with has_more and next_offset', async () => {
  const ctx = await setup('paging');
  for (let index = 0; index < 5; index += 1) await post(ctx, ctx.owner, { content: `c${index}` });
  const seen = [];
  let offset = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await list(ctx, ctx.owner, `?limit=2&offset=${offset}`);
    seen.push(...page.comments.map((comment) => comment.content));
    if (!page.has_more) { assert.equal(page.next_offset, null); break; }
    assert.equal(page.next_offset, offset + page.comments.length);
    offset = page.next_offset;
  }
  assert.deepEqual(seen, ['c0', 'c1', 'c2', 'c3', 'c4']);
});

test('delete is soft: author or owner only, replies survive, content is hidden', async () => {
  const ctx = await setup('delete');
  const ownerComment = (await post(ctx, ctx.owner, { content: 'owner says' })).body.data.comment_id;
  const memberComment = (await post(ctx, ctx.member, { content: 'member says', reply_comment_id: ownerComment })).body.data.comment_id;
  const del = (who, commentId) => api('DELETE', ctx.route, { comment_id: commentId }, who.token);

  assert.equal((await del(ctx.member, ownerComment)).status, 403, 'a member cannot delete someone else comment');
  assert.equal((await del(ctx.owner, id())).status, 404);
  assert.equal((await api('DELETE', ctx.route, {}, ctx.owner.token)).status, 400);

  assert.equal((await del(ctx.owner, ownerComment)).status, 200);
  assert.equal((await del(ctx.owner, ownerComment)).status, 200, 'idempotent');
  const afterOwner = (await list(ctx, ctx.member)).comments;
  const deleted = afterOwner.find((comment) => comment.comment_id === ownerComment);
  assert.equal(deleted.is_deleted, true);
  assert.equal(deleted.content, '');
  assert.equal(deleted.can_be_deleted, false);
  assert.equal(afterOwner.find((comment) => comment.comment_id === memberComment).reply_comment_id, ownerComment, 'the reply keeps its thread');

  assert.equal((await del(ctx.owner, memberComment)).status, 200, 'a workspace owner can delete a member comment');
});

test('resolve toggles and validates', async () => {
  const ctx = await setup('resolve');
  const commentId = (await post(ctx, ctx.owner, { content: 'todo' })).body.data.comment_id;
  const resolve = (payload) => api('PUT', `${ctx.route}/resolve`, payload, ctx.member.token);
  assert.equal((await resolve({ comment_id: commentId, is_resolved: true })).status, 200);
  assert.equal((await list(ctx, ctx.owner)).comments[0].is_resolved, true);
  assert.equal((await resolve({ comment_id: commentId, is_resolved: false })).status, 200);
  assert.equal((await list(ctx, ctx.owner)).comments[0].is_resolved, false);
  assert.equal((await resolve({ comment_id: commentId })).status, 400);
  assert.equal((await resolve({ comment_id: id(), is_resolved: true })).status, 404);
});

test('reactions: add is idempotent, grouped by type with users, filter, remove, none on deleted comments', async () => {
  const ctx = await setup('reactions');
  const first = (await post(ctx, ctx.owner, { content: 'one' })).body.data.comment_id;
  const second = (await post(ctx, ctx.owner, { content: 'two' })).body.data.comment_id;
  const react = (who, method, payload) => api(method, `${ctx.route}/reaction`, payload, who.token);

  assert.equal((await react(ctx.owner, 'POST', { reaction_type: '👍', comment_id: first })).status, 200);
  assert.equal((await react(ctx.owner, 'POST', { reaction_type: '👍', comment_id: first })).status, 200);
  assert.equal((await react(ctx.member, 'POST', { reaction_type: '👍', comment_id: first })).status, 200);
  assert.equal((await react(ctx.member, 'POST', { reaction_type: '🎉', comment_id: second })).status, 200);

  const all = (await api('GET', `${ctx.route}/reaction`, undefined, ctx.owner.token)).body.data.reactions;
  assert.equal(all.length, 2);
  const thumbs = all.find((reaction) => reaction.reaction_type === '👍');
  assert.equal(thumbs.comment_id, first);
  assert.deepEqual(thumbs.react_users.map((user) => user.uuid).sort(), [ctx.owner.userId, ctx.member.userId].sort());

  const filtered = (await api('GET', `${ctx.route}/reaction?comment_id=${second}`, undefined, ctx.owner.token)).body.data.reactions;
  assert.deepEqual(filtered.map((reaction) => reaction.reaction_type), ['🎉']);

  assert.equal((await react(ctx.member, 'DELETE', { reaction_type: '👍', comment_id: first })).status, 200);
  const afterRemove = (await api('GET', `${ctx.route}/reaction?comment_id=${first}`, undefined, ctx.owner.token)).body.data.reactions;
  assert.deepEqual(afterRemove[0].react_users.map((user) => user.uuid), [ctx.owner.userId]);

  assert.equal((await react(ctx.owner, 'POST', { reaction_type: '', comment_id: first })).status, 400);
  assert.equal((await react(ctx.owner, 'POST', { reaction_type: '👍', comment_id: id() })).status, 404);
  await api('DELETE', ctx.route, { comment_id: second }, ctx.owner.token);
  assert.equal((await react(ctx.owner, 'POST', { reaction_type: '👍', comment_id: second })).status, 400);
});

test('anchoring without edit access is refused', async () => {
  const ctx = await setup('anchor');
  const response = await api('PUT', `${ctx.route}/anchor`, { comment_id: id(), doc_state: [0, 0] }, ctx.owner.token);
  assert.equal(response.status, 403);
});

test('comments are scoped to the workspace and the page', async () => {
  const ctx = await setup('scope');
  const outsider = await registerAndLogin('scope-outsider');
  assert.equal((await api('GET', ctx.route, undefined, outsider.token)).status, 403, 'not a member of this workspace');
  assert.equal((await api('GET', ctx.route)).status, 401);

  // A page that exists only in the outsider's workspace is not reachable through the owner's.
  const outsiderPage = await createPage(outsider, 'scope-outsider');
  const crossRoute = `/api/workspace/${ctx.owner.workspaceId}/document/${outsiderPage}/inline-comment`;
  assert.equal((await api('GET', crossRoute, undefined, ctx.owner.token)).status, 404);
  assert.equal((await api('GET', `/api/workspace/${ctx.owner.workspaceId}/document/${id()}/inline-comment`, undefined, ctx.owner.token)).status, 404);
  assert.equal((await api('GET', `/api/workspace/${ctx.owner.workspaceId}/document/not-a-uuid/inline-comment`, undefined, ctx.owner.token)).status, 404);

  const commentId = (await post(ctx, ctx.owner, { content: 'private' })).body.data.comment_id;
  assert.equal((await api('DELETE', `/api/workspace/${outsider.workspaceId}/document/${outsiderPage}/inline-comment`, { comment_id: commentId }, outsider.token)).status, 404, 'a comment id is only valid on its own page');
});

test('comments created in the same millisecond keep their creation order (the id tie-break is random)', async () => {
  const store = running.app.store;
  const owner = await registerAndLogin('same-ms-owner');
  const { workspaceId, userId } = owner;
  const viewId = id();
  const sameInstant = '2026-11-14T10:00:00.000Z';
  const created = [];

  for (let index = 0; index < 8; index += 1) {
    const commentId = id();

    created.push(commentId);
    await store.createInlineComment({ comment_id: commentId, workspace_id: workspaceId, view_id: viewId, block_id: null, user_id: userId, content: `c${index}`, reply_comment_id: null, created_at: sameInstant, updated_at: sameInstant });
  }
  const listed = (await store.listInlineComments(workspaceId, viewId, { offset: 0, limit: 100 })).comments;

  assert.deepEqual(listed.map((comment) => comment.comment_id), created);
  assert.equal(new Set(listed.map((comment) => comment.created_at)).size, 8, 'every comment has its own timestamp');
  const paged = [];

  for (let offset = 0; offset < 8; offset += 3) paged.push(...(await store.listInlineComments(workspaceId, viewId, { offset, limit: 3 })).comments.map((comment) => comment.comment_id));
  assert.deepEqual(paged, created, 'paging walks the same order without gaps or repeats');
});
