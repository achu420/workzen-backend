// Document page templates: GET /api/template-catalog/document and
// POST /api/workspace/{id}/v2/page-view/document/from-template. A template is
// instantiated as a real page plus its whole sub-page tree inside the caller's
// own workspace.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { startServer } from '../server.js';

let dir, running, base;

async function api(method, route, payload, token) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-doc-template-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key' });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function setup(label) {
  const email = `${label}@example.test`;
  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  const spaceId = crypto.randomUUID();
  const created = await api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: 'Space', view_id: spaceId,
    permission: {
      visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
      invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
      security: { disable_guests: false, disable_public_links: false, disable_export: false },
    },
  }, token);
  assert.equal(created.status, 200);
  return { token, workspaceId, spaceId };
}

const request = (spaceId, overrides = {}) => ({
  schema_version: 'v1', request_id: crypto.randomUUID(), template_id: 'startup-company-home', parent_view_id: spaceId, position: { kind: 'end' }, ...overrides,
});
const createUrl = (workspaceId) => `/api/workspace/${workspaceId}/v2/page-view/document/from-template`;

function documentOf(store, pageId) {
  const stored = store.state.pageCollabDocuments[pageId];
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(stored.document_state));
  return doc.getMap('data').get('document');
}

test('catalog lists the library templates (the nine built-in ones and the imported AppFlowy ones) and requires authentication', async () => {
  const { token } = await setup('catalog');
  assert.equal((await api('GET', '/api/template-catalog/document')).status, 401);
  const response = await api('GET', '/api/template-catalog/document', undefined, token);
  assert.equal(response.status, 200);
  const byId = Object.fromEntries(response.body.data.templates.map((t) => [t.template_id, t]));
  for (const id of ['startup-company-home', 'press-release', 'weekly-to-do-list', 'product-spec', 'write-a-doc', 'one-on-one-meeting', 'product-one-pager', 'event-planning-sop', 'customer-onboarding-checklist']) assert.ok(byId[id], `${id} is in the catalog`);
  assert.equal(byId['startup-company-home'].page_count, 8);
  assert.equal(byId['press-release'].page_count, 2);
  assert.equal(byId['weekly-to-do-list'].page_count, 1);
});

test('creating a template builds the whole page tree with real content', async () => {
  const { token, workspaceId, spaceId } = await setup('create');
  const response = await api('POST', createUrl(workspaceId), request(spaceId), token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const { view_id: rootId, view_ids: viewIds } = response.body.data.result;
  assert.equal(viewIds.length, 8);
  assert.equal(viewIds[0], rootId);

  const store = running.app.store;
  const pages = viewIds.map((id) => store.state.pages[id]);
  assert.equal(pages[0].title, 'Simple Startup Company Home');
  assert.equal(pages[0].parent_view_id, spaceId);
  for (const page of pages.slice(1)) assert.ok(viewIds.includes(page.parent_view_id), `${page.title} parented inside the tree`);
  assert.deepEqual(pages.map((p) => p.title).slice(0, 5), ['Simple Startup Company Home', 'New Joiners Guidebook', 'New Hire Onboarding', 'Company values', 'Our Story']);
  const grand = pages.filter((p) => p.parent_view_id === viewIds[4]).map((p) => p.title);
  assert.deepEqual(grand, ['Company', 'Metrics', 'Project']);

  for (const id of viewIds) {
    const document = documentOf(store, id);
    assert.equal(store.state.pageCollabDocuments[id].workspace_id, workspaceId);
    assert.ok(document.get('blocks').size > 1, 'has real blocks');
    assert.equal(document.get('page_id'), document.get('blocks').get(document.get('page_id')).get('id'));
  }
  const allText = viewIds
    .flatMap((id) => [...documentOf(store, id).get('meta').get('text_map').values()].map((t) => t.toString()))
    .join('\n');
  assert.ok(allText.length > 1000, 'the tree carries real text');
  const source = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'templates', 'documents', 'startup-company-home.json'), 'utf8'));
  const sourceText = Object.values(source.pages.document.meta.text_map).map((raw) => JSON.parse(raw).map((op) => op.insert).join('')).find((t) => t.length > 20);
  assert.ok(sourceText && allText.includes(sourceText), 'known template body text is present');
});

test('in-template page mentions are remapped to the new page ids; out-of-template ones become text', async () => {
  const { token, workspaceId, spaceId } = await setup('mentions');
  const response = await api('POST', createUrl(workspaceId), request(spaceId), token);
  const { view_ids: viewIds } = response.body.data.result;
  const store = running.app.store;
  const mentionTargets = [];
  for (const id of viewIds) {
    for (const text of documentOf(store, id).get('meta').get('text_map').values()) {
      for (const op of text.getContent().children) if (op.format?.mention?.type === 'page') mentionTargets.push(op.format.mention.page_id);
    }
  }
  assert.ok(mentionTargets.length > 0, 'template has page mentions');
  for (const target of mentionTargets) assert.ok(viewIds.includes(target), 'mention points at a page in the new tree');
  const rootText = [...documentOf(store, viewIds[0]).get('meta').get('text_map').values()].map((t) => t.toString()).join('\n');
  assert.ok(rootText.includes('Open Positions'), 'mention of the skipped database page is plain text');
});

test('uploaded file/image blocks are blanked', async () => {
  const { token, workspaceId, spaceId } = await setup('uploads');
  for (const templateId of ['product-one-pager', 'one-on-one-meeting']) {
    const response = await api('POST', createUrl(workspaceId), request(spaceId, { template_id: templateId }), token);
    assert.equal(response.status, 200);
    const document = documentOf(running.app.store, response.body.data.result.view_id);
    for (const block of document.get('blocks').values()) {
      if (block.get('ty') === 'image' || block.get('ty') === 'file') assert.equal(JSON.parse(block.get('data')).url, '');
    }
  }
});

test('distinct instantiations get distinct ids, and a custom name renames only the root', async () => {
  const { token, workspaceId, spaceId } = await setup('multi');
  const first = await api('POST', createUrl(workspaceId), request(spaceId, { template_id: 'press-release' }), token);
  const second = await api('POST', createUrl(workspaceId), request(spaceId, { template_id: 'press-release', name: 'Launch PR' }), token);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.data.result.view_ids.length, 2);
  assert.ok(first.body.data.result.view_ids.every((id) => !second.body.data.result.view_ids.includes(id)));
  const pages = running.app.store.state.pages;
  assert.equal(pages[second.body.data.result.view_ids[0]].title, 'Launch PR');
  assert.equal(pages[second.body.data.result.view_ids[1]].title, 'PR & FAQs');
});

test('replaying the same request_id is idempotent and returns the same ids', async () => {
  const { token, workspaceId, spaceId } = await setup('replay');
  const body = request(spaceId);
  const first = await api('POST', createUrl(workspaceId), body, token);
  const replay = await api('POST', createUrl(workspaceId), body, token);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.data.result.view_ids, first.body.data.result.view_ids);
  assert.equal(Object.keys(running.app.store.state.pages).filter((id) => first.body.data.result.view_ids.includes(id)).length, 8);
  assert.equal((await api('POST', createUrl(workspaceId), { ...body, template_id: 'write-a-doc' }, token)).status, 409);
});

test('invalid requests are rejected', async () => {
  const { token, workspaceId, spaceId } = await setup('invalid');
  assert.equal((await api('POST', createUrl(workspaceId), request(spaceId, { template_id: 'nope' }), token)).status, 404);
  assert.equal((await api('POST', createUrl(workspaceId), request(spaceId, { extra_field: 1 }), token)).status, 400);
  assert.equal((await api('POST', createUrl(workspaceId), request(spaceId, { schema_version: 'v2' }), token)).status, 400);
  assert.equal((await api('POST', createUrl(workspaceId), request(crypto.randomUUID()), token)).status, 403);
  assert.equal((await api('POST', createUrl(workspaceId), request(spaceId), undefined)).status, 401);
});

test('another workspace cannot instantiate into this workspace', async () => {
  const owner = await setup('owner');
  const outsider = await setup('outsider');
  const before = Object.keys(running.app.store.state.pages).length;
  const response = await api('POST', createUrl(owner.workspaceId), request(owner.spaceId), outsider.token);
  assert.equal(response.status, 403);
  assert.equal(Object.keys(running.app.store.state.pages).length, before);
});
