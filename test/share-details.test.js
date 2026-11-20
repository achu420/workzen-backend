// The Share popover and the People settings ask for things this server answers in its own way: pages are not shared one
// by one (every member can open everything), and there are no groups. They must get a clear answer, not a 404 that the
// web app shows as an error.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { account, startCardsEnv } from './helpers/cards-env.js';
import { mcpOk, mintToken } from './helpers/mcp-live-env.js';

let env, owner, member, outsider, pageId;

before(async () => {
  env = await startCardsEnv({ storage: 'json', serverOptions: { searchIndexDelayMs: 0 } });
  owner = await account(env, 'share-owner');
  member = await account(env, 'share-member');
  outsider = await account(env, 'share-outsider');
  const added = await fetch(`${env.base}/api/workspaces/${owner.workspaceId}/test-members`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}`, 'x-development-key': 'test-key' }, body: JSON.stringify({ email: member.email, role: 'member' }) });

  assert.equal(added.status, 201);
  const agent = await mintToken(env, owner, { scope: 'write', name: 'Share test agent' });

  pageId = (await mcpOk(env, agent.token, 'create_page', { parent_id: owner.spaceId, title: 'Shared plan', idempotency_key: 'share-details-page-0001' })).page_id;
});
after(async () => { await env?.stop(); });

const v2 = (who, workspaceId, page) => env.api('GET', `/api/sharing/workspace/${workspaceId}/access-details/v2?type=page&page_id=${page}`, undefined, who?.token);
const legacy = (who, workspaceId, page) => env.api('POST', `/api/sharing/workspace/${workspaceId}/view/${page}/access-details`, { ancestor_view_ids: [] }, who?.token);

test('server-info says there are no workspace groups', async () => {
  const info = (await env.api('GET', '/api/server-info')).body.data;

  assert.equal(info.enable_workspace_groups, false);
  assert.equal(info.enable_page_sharing, false, 'pages are not shared one by one, so Share only lists who has access');
});

test('access details list the workspace members as the people with access, in both request forms', async () => {
  for (const ask of [v2, legacy]) {
    const response = await ask(member, owner.workspaceId, pageId);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const details = response.body.data;

    assert.equal(details.view_id, pageId);
    assert.deepEqual(details.target, { type: 'page', page_id: pageId });
    assert.deepEqual(details.groups, []);
    assert.deepEqual(details.shared_with.map((person) => [person.email, person.role, person.access_level, person.pending_invitation]).sort(), [
      [member.email, 'Member', 30, false],
      [owner.email, 'Owner', 50, false],
    ].sort());
    assert.equal(details.current_user_permission.access_level, 30, 'can edit, but never "full access" (no invite box or permission menus)');
    assert.equal(details.current_user_permission.object_id, pageId);
  }
  const asOwner = (await v2(owner, owner.workspaceId, pageId)).body.data;

  assert.equal(asOwner.current_user_permission.access_level, 30, 'the owner is not offered invites either');
  assert.equal(asOwner.shared_with.find((person) => person.email === owner.email).access_level, 50, 'but is listed as the owner');
});

test('access details refuse unknown pages, other workspaces and anonymous callers', async () => {
  assert.equal((await v2(owner, owner.workspaceId, crypto.randomUUID())).status, 404);
  assert.equal((await v2(owner, owner.workspaceId, 'not-an-id')).status, 404);
  assert.equal((await legacy(owner, owner.workspaceId, crypto.randomUUID())).status, 404);
  assert.ok([403, 404].includes((await v2(outsider, owner.workspaceId, pageId)).status), 'an outsider cannot read it');
  assert.ok([403, 404].includes((await legacy(outsider, owner.workspaceId, pageId)).status));
  assert.equal((await v2(undefined, owner.workspaceId, pageId)).status, 401);
  assert.equal((await legacy(undefined, owner.workspaceId, pageId)).status, 401);
  // A page of another workspace is not found even for a member of this one.
  const otherPage = (await mcpOk(env, (await mintToken(env, outsider, { scope: 'write', name: 'Other agent' })).token, 'create_page', { parent_id: outsider.spaceId, title: 'Not yours', idempotency_key: 'share-details-other-0001' })).page_id;

  assert.equal((await v2(owner, owner.workspaceId, otherPage)).status, 404);
});

test('the group lists are empty instead of an error', async () => {
  const groups = await env.api('GET', `/api/workspace/${owner.workspaceId}/groups`, undefined, member.token);
  const forPage = await env.api('GET', `/api/workspace/${owner.workspaceId}/views/${pageId}/group`, undefined, member.token);

  assert.equal(groups.status, 200);
  assert.deepEqual(groups.body.data, { groups: [] });
  assert.equal(forPage.status, 200);
  assert.deepEqual(forPage.body.data, { groups: [] });
  assert.equal((await env.api('GET', `/api/workspace/${owner.workspaceId}/groups`, undefined, outsider.token)).status === 200, false, 'not for outsiders');
  assert.equal((await env.api('GET', `/api/workspace/${owner.workspaceId}/groups`)).status, 401);
});
