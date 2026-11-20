// Page icon, move (re-parent + order), duplicate, trash empty/restore-all, leave, invite, remove members, rename
// space, and the empty integrations answer. These routes returned 404 before, which broke sidebar drag and drop,
// "Duplicate", icons, the Members dialog and Settings > Trash in the web client.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

let dir, running, base, store;

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-ws-ops-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key' });
  base = `http://127.0.0.1:${running.address.port}`;
  store = running.app.store;
});
after(async () => {
  running.server.closeAllConnections?.();
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const PERMISSION = {
  visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
  invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
  security: { disable_guests: false, disable_public_links: false, disable_export: false },
};

async function account(label) {
  const email = `${label}@example.test`;

  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;

  return { email, token, workspaceId };
}

async function space(owner, name = 'Space') {
  const viewId = crypto.randomUUID();

  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/spaces`, { name, view_id: viewId, permission: PERMISSION }, owner.token)).status, 200);
  return viewId;
}

async function doc(owner, parentId, name) {
  const viewId = crypto.randomUUID();

  assert.equal((await api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/default`, {
    schema_version: 'v1', request_id: crypto.randomUUID(), parent_view_id: parentId, name, position: { kind: 'end' }, view_id: viewId,
  }, owner.token)).status, 200);
  return viewId;
}

const children = async (owner, viewId) => (await api('GET', `/api/workspace/${owner.workspaceId}/view/${viewId}?depth=1`, undefined, owner.token)).body.data.children.map((child) => child.name);
const pageUrl = (owner, viewId, action) => `/api/workspace/${owner.workspaceId}/page-view/${viewId}/${action}`;

async function member(owner, label, role = 'member') {
  const user = await account(label);

  assert.equal((await api('POST', `/api/workspaces/${owner.workspaceId}/test-members`, { email: user.email, role }, owner.token, { 'x-development-key': 'test-key' })).status, 201);
  return { ...user, workspaceId: owner.workspaceId };
}

test('update-icon sets, replaces and clears a page icon, and rejects bad input', async () => {
  const owner = await account('ops-icon');
  const page = await doc(owner, await space(owner), 'Icon page');
  const url = pageUrl(owner, page, 'update-icon');

  assert.equal((await api('POST', url, { icon: { ty: 0, value: '🚀' } }, owner.token)).status, 200);
  assert.deepEqual((await api('GET', `/api/workspace/${owner.workspaceId}/view/${page}?depth=0`, undefined, owner.token)).body.data.icon, { ty: 0, value: '🚀' });
  assert.equal((await api('POST', url, { icon: null }, owner.token)).status, 200);
  assert.equal((await api('GET', `/api/workspace/${owner.workspaceId}/view/${page}?depth=0`, undefined, owner.token)).body.data.icon, null);
  assert.equal((await api('POST', url, { icon: 'rocket' }, owner.token)).status, 400);
  assert.equal((await api('POST', url, { icon: { ty: 0, value: 'x'.repeat(2001) } }, owner.token)).status, 400);
  assert.equal((await api('POST', pageUrl(owner, crypto.randomUUID(), 'update-icon'), { icon: null }, owner.token)).status, 404);
  const stranger = await account('ops-icon-stranger');

  assert.equal((await api('POST', url, { icon: null }, stranger.token)).status, 403);
});

test('move re-parents a page, orders it among siblings and keeps the tree consistent', async () => {
  const owner = await account('ops-move');
  const a = await space(owner, 'A');
  const b = await space(owner, 'B');
  const one = await doc(owner, a, 'one');
  const two = await doc(owner, a, 'two');
  const three = await doc(owner, a, 'three');

  assert.deepEqual(await children(owner, a), ['one', 'two', 'three']);
  // to the front, then between, then to the end of another space
  assert.equal((await api('POST', pageUrl(owner, three, 'move'), { new_parent_view_id: a, prev_view_id: null }, owner.token)).status, 200);
  assert.deepEqual(await children(owner, a), ['three', 'one', 'two']);
  assert.equal((await api('POST', pageUrl(owner, two, 'move'), { new_parent_view_id: a, prev_view_id: three }, owner.token)).status, 200);
  assert.deepEqual(await children(owner, a), ['three', 'two', 'one']);
  assert.equal((await api('POST', pageUrl(owner, one, 'move'), { new_parent_view_id: b }, owner.token)).status, 200);
  assert.deepEqual(await children(owner, b), ['one']);
  assert.deepEqual(await children(owner, a), ['three', 'two']);
  // many repeated inserts at the same spot keep a strict order
  for (const name of ['p1', 'p2', 'p3', 'p4']) {
    const id = await doc(owner, a, name);

    assert.equal((await api('POST', pageUrl(owner, id, 'move'), { new_parent_view_id: a, prev_view_id: three }, owner.token)).status, 200);
  }
  assert.deepEqual(await children(owner, a), ['three', 'p4', 'p3', 'p2', 'p1', 'two']);
});

test('move validation: cycles, bad parents, trashed pages, foreign pages and database views', async () => {
  const owner = await account('ops-move-rules');
  const stranger = await account('ops-move-stranger');
  const s = await space(owner);
  const parent = await doc(owner, s, 'parent');
  const child = await doc(owner, parent, 'child');
  const trashed = await doc(owner, s, 'trashed');

  assert.equal((await api('POST', pageUrl(owner, parent, 'move'), { new_parent_view_id: parent }, owner.token)).status, 400, 'into itself');
  assert.equal((await api('POST', pageUrl(owner, parent, 'move'), { new_parent_view_id: child }, owner.token)).status, 400, 'into its own sub-page');
  assert.equal((await api('POST', pageUrl(owner, child, 'move'), { new_parent_view_id: crypto.randomUUID() }, owner.token)).status, 400, 'unknown destination');
  assert.equal((await api('POST', pageUrl(owner, child, 'move'), { new_parent_view_id: 'nope' }, owner.token)).status, 400);
  assert.equal((await api('POST', pageUrl(owner, child, 'move'), { new_parent_view_id: s, prev_view_id: crypto.randomUUID() }, owner.token)).status, 400, 'prev is not a sibling');
  await api('POST', pageUrl(owner, trashed, 'move-to-trash'), {}, owner.token);
  assert.equal((await api('POST', pageUrl(owner, child, 'move'), { new_parent_view_id: trashed }, owner.token)).status, 400, 'into the trash');
  assert.equal((await api('POST', pageUrl(owner, trashed, 'move'), { new_parent_view_id: s }, owner.token)).status, 404, 'moving a trashed page');
  assert.equal((await api('POST', pageUrl(owner, child, 'move'), { new_parent_view_id: s }, stranger.token)).status, 403);
  assert.equal((await api('POST', pageUrl(owner, s, 'move'), { new_parent_view_id: s }, owner.token)).status, 404, 'a space is not a page');

  const created = await api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/database/from-template`, {
    schema_version: 'v1', request_id: crypto.randomUUID(), template_id: 'tasks', parent_view_id: s, position: { kind: 'end' },
  }, owner.token);
  const { view_id: containerId, view_ids: viewIds } = created.body.data.result;

  assert.equal((await api('POST', pageUrl(owner, viewIds[0], 'move'), { new_parent_view_id: s }, owner.token)).status, 400, 'a database view cannot leave its database');
  assert.equal((await api('POST', pageUrl(owner, child, 'move'), { new_parent_view_id: containerId }, owner.token)).status, 400, 'nothing goes inside a database');
  // the whole database can move, with its views
  const other = await space(owner, 'Other');

  assert.equal((await api('POST', pageUrl(owner, containerId, 'move'), { new_parent_view_id: other }, owner.token)).status, 200);
  assert.equal((await children(owner, other)).length, 1);
});

test('duplicate copies a document, its content and its sub-pages; databases are refused clearly', async () => {
  const owner = await account('ops-dup');
  const s = await space(owner);
  const original = await doc(owner, s, 'Plan');
  const sub = await doc(owner, original, 'Plan child');
  const other = await space(owner, 'Elsewhere');

  assert.equal((await api('POST', pageUrl(owner, original, 'duplicate'), {}, owner.token)).status, 200);
  assert.deepEqual(await children(owner, s), ['Plan', 'Plan (Copy)']);
  const copy = (await api('GET', `/api/workspace/${owner.workspaceId}/view/${s}?depth=1`, undefined, owner.token)).body.data.children.find((child) => child.name === 'Plan (Copy)');

  assert.notEqual(copy.view_id, original);
  assert.deepEqual(await children(owner, copy.view_id), ['Plan child']);
  const src = await store.getPageCollab(owner.workspaceId, original);
  const dst = await store.getPageCollab(owner.workspaceId, copy.view_id);

  assert.deepEqual(Array.from(dst.doc_state), Array.from(src.doc_state), 'the document content is copied');
  // custom suffix, another parent, no children
  assert.equal((await api('POST', pageUrl(owner, original, 'duplicate'), { suffix: ' v2', parent_view_id: other, include_children: false }, owner.token)).status, 200);
  assert.deepEqual(await children(owner, other), ['Plan v2']);
  const v2 = (await api('GET', `/api/workspace/${owner.workspaceId}/view/${other}?depth=1`, undefined, owner.token)).body.data.children[0];

  assert.deepEqual(await children(owner, v2.view_id), []);
  assert.equal((await api('POST', pageUrl(owner, original, 'duplicate'), { suffix: 'x'.repeat(101) }, owner.token)).status, 400);
  assert.equal((await api('POST', pageUrl(owner, original, 'duplicate'), { parent_view_id: crypto.randomUUID() }, owner.token)).status, 400);
  assert.equal((await api('POST', pageUrl(owner, crypto.randomUUID(), 'duplicate'), {}, owner.token)).status, 404);

  const created = await api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/database/from-template`, {
    schema_version: 'v1', request_id: crypto.randomUUID(), template_id: 'tasks', parent_view_id: s, position: { kind: 'end' },
  }, owner.token);
  const refused = await api('POST', pageUrl(owner, created.body.data.result.view_id, 'duplicate'), {}, owner.token);

  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'DUPLICATE_UNSUPPORTED');
  assert.ok(sub);
});

test('restore-all and empty trash; only owners and admins can empty it', async () => {
  const owner = await account('ops-trash');
  const helper = await member(owner, 'ops-trash-member');
  const s = await space(owner);
  const [a, b] = [await doc(owner, s, 'a'), await doc(owner, s, 'b')];

  for (const id of [a, b]) await api('POST', pageUrl(owner, id, 'move-to-trash'), {}, owner.token);
  const all = (action) => `/api/workspace/${owner.workspaceId}/${action}`;

  assert.equal((await api('POST', all('restore-all-pages-from-trash'), {}, helper.token)).status, 200);
  assert.deepEqual(await children(owner, s), ['a', 'b']);
  for (const id of [a, b]) await api('POST', pageUrl(owner, id, 'move-to-trash'), {}, owner.token);
  assert.equal((await api('POST', all('delete-all-pages-from-trash'), {}, helper.token)).status, 403);
  assert.equal((await store.listTrashedPages(owner.workspaceId)).length, 2);
  assert.equal((await api('POST', all('delete-all-pages-from-trash'), {}, owner.token)).status, 200);
  assert.equal((await store.listTrashedPages(owner.workspaceId)).length, 0);
  assert.equal(await store.getPage(a), null);
});

test('invite by email adds existing accounts and keeps a pending invitation (with a clear message) for unknown ones; only managers invite', async () => {
  const owner = await account('ops-invite');
  const joiner = await account('ops-invite-joiner');
  const plain = await member(owner, 'ops-invite-plain');
  const url = `/api/workspace/${owner.workspaceId}/invite`;

  assert.equal((await api('POST', url, [{ email: joiner.email, role: 1 }], plain.token)).status, 403);
  assert.equal((await api('POST', url, [{ email: joiner.email.toUpperCase(), role: 1 }], owner.token)).status, 200);
  assert.equal((await api('POST', url, [{ email: joiner.email }], owner.token)).status, 200, 'inviting a member again is harmless');
  assert.equal((await store.getMembership(owner.workspaceId, (await store.findUserByEmail(joiner.email)).id)).role, 'member');
  // This test server has no mail settings, so the invitation is saved and the answer says e-mail is not set up.
  const unknown = await api('POST', url, [{ email: 'Nobody-Here@Example.test' }], owner.token);

  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'EMAIL_NOT_CONFIGURED');
  assert.match(unknown.body.error.message, /nobody-here@example.test/);
  assert.deepEqual((await store.listWorkspaceInvitations(owner.workspaceId)).map((invitation) => invitation.email), ['nobody-here@example.test']);
  for (const bad of [[], {}, [{ nope: 1 }], 'x']) assert.equal((await api('POST', url, bad, owner.token)).status, 400);
});

test('remove members: owners and admins only, never the owner, admins only by the owner', async () => {
  const owner = await account('ops-remove');
  const admin = await member(owner, 'ops-remove-admin', 'admin');
  const otherAdmin = await member(owner, 'ops-remove-admin2', 'admin');
  const plain = await member(owner, 'ops-remove-plain');
  const victim = await member(owner, 'ops-remove-victim');
  const url = `/api/workspace/${owner.workspaceId}/member`;
  const remove = (emails, token) => api('DELETE', url, emails, token);

  assert.equal((await remove([victim.email], plain.token)).status, 403);
  assert.equal((await remove([owner.email], admin.token)).status, 400, 'the owner is protected');
  assert.equal((await remove([otherAdmin.email], admin.token)).status, 403, 'an admin cannot remove an admin');
  assert.equal((await remove([victim.email, 'ghost@example.test'], admin.token)).status, 200);
  assert.equal((await api('GET', `/api/workspace/${owner.workspaceId}/member`, undefined, victim.token)).status, 403, 'the removed member lost access');
  assert.equal((await remove([otherAdmin.email], owner.token)).status, 200);
  for (const bad of [[], {}, [1]]) assert.equal((await remove(bad, owner.token)).status, 400);
});

test('leave: members can, the owner cannot; access ends immediately', async () => {
  const owner = await account('ops-leave');
  const plain = await member(owner, 'ops-leave-member');
  const url = `/api/workspace/${owner.workspaceId}/leave`;

  assert.equal((await api('POST', url, {}, owner.token)).status, 400);
  assert.equal((await api('POST', url, {}, plain.token)).status, 200);
  assert.equal((await api('GET', `/api/workspace/${owner.workspaceId}/member`, undefined, plain.token)).status, 403);
  assert.equal((await api('GET', `/api/workspace/${owner.workspaceId}/member`, undefined, owner.token)).status, 200);
});

test('PATCH space renames it and changes its icon; validation and workspace scoping', async () => {
  const owner = await account('ops-space');
  const stranger = await account('ops-space-stranger');
  const s = await space(owner, 'Old');
  const url = `/api/workspace/${owner.workspaceId}/space/${s}`;

  assert.equal((await api('PATCH', url, { name: ' New name ', space_icon: 'star', space_icon_color: '#fff' }, owner.token)).status, 200);
  const view = (await api('GET', `/api/workspace/${owner.workspaceId}/view/${s}?depth=0`, undefined, owner.token)).body.data;

  assert.equal(view.name, 'New name');
  assert.equal((await api('PATCH', url, { name: '' }, owner.token)).status, 400);
  assert.equal((await api('PATCH', url, { name: 'x'.repeat(201) }, owner.token)).status, 400);
  assert.equal((await api('PATCH', url, { space_icon: 7 }, owner.token)).status, 400);
  assert.equal((await api('PATCH', url, { name: 'x' }, stranger.token)).status, 403);
  assert.equal((await api('PATCH', `/api/workspace/${owner.workspaceId}/space/${crypto.randomUUID()}`, { name: 'x' }, owner.token)).status, 404);
  assert.equal((await store.getSpace(s)).space_icon, 'star');
});

test('integrations: none are configured, advertised as an empty list', async () => {
  const owner = await account('ops-integrations');
  const list = await api('GET', `/api/integrations/connections?workspace_id=${owner.workspaceId}`, undefined, owner.token);

  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data, { connections: [] });
  const info = (await api('GET', '/api/server-info')).body.data;

  assert.deepEqual(info.connections, []);
  assert.equal(info.enable_database_blob_diff, false, 'the client is told not to ask for the bulk row endpoint');
});

const PUBLIC = { visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null, invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false, security: { disable_guests: false, disable_public_links: false, disable_export: false } };

test('spaces: list, permission details, structured update; renaming needs an owner or admin; private spaces are refused', async () => {
  const owner = await account('ops-spaces');
  const plain = await member(owner, 'ops-spaces-member');
  const stranger = await account('ops-spaces-stranger');
  const [one, two] = [await space(owner, 'One'), await space(owner, 'Two')];
  const base = `/api/workspace/${owner.workspaceId}`;
  const listed = (await api('GET', `${base}/spaces`, undefined, plain.token)).body.data.spaces;

  // Two spaces made within the same millisecond have no defined order, so compare as sets.
  assert.deepEqual(listed.map((item) => [item.space_id, item.name, item.current_user_access_level, item.can_leave]).sort(), [[one, 'One', 30, false], [two, 'Two', 30, false]].sort());
  const asOwner = (await api('GET', `${base}/spaces/${one}/permission`, undefined, owner.token)).body.data;

  assert.deepEqual([asOwner.space_id, asOwner.current_user_access_level, asOwner.can_manage_space, asOwner.can_manage_members, asOwner.explicit_member_count], [one, 50, true, false, 0]);
  assert.deepEqual(asOwner.permission, PUBLIC);
  const asMember = (await api('GET', `${base}/spaces/${one}/permission`, undefined, plain.token)).body.data;

  assert.deepEqual([asMember.current_user_access_level, asMember.can_manage_space], [30, false]);
  assert.equal((await api('GET', `${base}/spaces/${crypto.randomUUID()}/permission`, undefined, owner.token)).status, 404);
  assert.equal((await api('GET', `${base}/spaces/${one}/permission`, undefined, stranger.token)).status, 403);
  assert.equal((await api('GET', `/api/workspace/${stranger.workspaceId}/spaces/${one}/permission`, undefined, stranger.token)).status, 404, "another workspace's space is invisible");

  assert.equal((await api('PATCH', `${base}/spaces/${one}`, { name: 'Renamed', space_icon: 'x', permission: PUBLIC }, owner.token)).body.data.view_id, one);
  assert.equal((await store.getSpace(one)).name, 'Renamed');
  assert.equal((await api('PATCH', `${base}/spaces/${one}`, { name: 'Nope' }, plain.token)).status, 403);
  assert.equal((await api('PATCH', `${base}/space/${one}`, { name: 'Nope' }, plain.token)).status, 403);
  assert.equal((await api('PATCH', `${base}/spaces/${one}`, { permission: { ...PUBLIC, visibility: 'private' } }, owner.token)).status, 400);
  assert.equal((await api('PATCH', `${base}/spaces/${one}/permission`, { ...PUBLIC, member_default_access_level: 10 }, owner.token)).status, 400);
  assert.equal((await api('PATCH', `${base}/spaces/${one}/permission`, PUBLIC, owner.token)).body.data.space_id, one);
  assert.equal((await api('PATCH', `${base}/spaces/${one}`, { name: '' }, owner.token)).status, 400);
  assert.equal((await store.getSpace(one)).name, 'Renamed', 'a refused update changed nothing');
});
