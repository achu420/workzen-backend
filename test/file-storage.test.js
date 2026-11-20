// /api/file_storage: small uploads (PUT), multipart uploads, authenticated downloads, size limits and isolation.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startServer } from '../server.js';

let dir, running, base;
const MAX = 50_000;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-files-'));
  running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key', fileMaxBytes: MAX });
  base = `http://127.0.0.1:${running.address.port}`;
});
after(async () => {
  running.server.closeAllConnections?.();
  await new Promise((resolve) => running.server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function raw(method, route, payload, token, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: payload,
  });

  return response;
}

async function json(method, route, payload, token) {
  const response = await raw(method, route, payload === undefined ? undefined : JSON.stringify(payload), token, { 'content-type': 'application/json' });
  const text = await response.text();

  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function account(label) {
  const email = `${label}@example.test`;

  await json('POST', '/api/auth/register', { email, password: 'Correct horse 456' });
  const token = (await json('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
  const workspaceId = (await json('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;

  return { token, workspaceId };
}

const blobUrl = (ws, parent, file = '') => `/api/file_storage/${ws}/v1/blob/${parent}${file ? `/${file}` : ''}`;
const bytes = (n, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256));

test('a small file round-trips byte for byte and is served as an image inline', async () => {
  const owner = await account('files-roundtrip');
  const parent = crypto.randomUUID();
  const png = bytes(2048);
  const put = await raw('PUT', blobUrl(owner.workspaceId, parent), png, owner.token, { 'content-type': 'image/png' });
  const fileId = (await put.json()).data.file_id;

  assert.equal(put.status, 200);
  assert.match(fileId, /^[0-9a-f-]{36}$/);
  const got = await raw('GET', blobUrl(owner.workspaceId, parent, fileId), undefined, owner.token);

  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('content-disposition'), 'inline');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
  const head = await raw('HEAD', blobUrl(owner.workspaceId, parent, fileId), undefined, owner.token);

  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '2048');
});

test('active content (HTML, SVG, scripts) is never rendered inline', async () => {
  const owner = await account('files-active');
  const parent = crypto.randomUUID();

  for (const type of ['text/html', 'image/svg+xml', 'application/javascript', 'text/html; charset=utf-8', 'garbage']) {
    const put = await raw('PUT', blobUrl(owner.workspaceId, parent), Buffer.from('<script>alert(1)</script>'), owner.token, { 'content-type': type });
    const got = await raw('GET', blobUrl(owner.workspaceId, parent, (await put.json()).data.file_id), undefined, owner.token);

    assert.equal(got.headers.get('content-type'), 'application/octet-stream', type);
    assert.equal(got.headers.get('content-disposition'), 'attachment', type);
  }
});

test('access rules: sign-in and membership are required, ids are validated, other workspaces cannot read', async () => {
  const owner = await account('files-access');
  const stranger = await account('files-access-stranger');
  const parent = crypto.randomUUID();
  const put = await raw('PUT', blobUrl(owner.workspaceId, parent), bytes(10), owner.token, { 'content-type': 'image/png' });
  const fileId = (await put.json()).data.file_id;

  assert.equal((await raw('GET', blobUrl(owner.workspaceId, parent, fileId))).status, 401);
  assert.equal((await raw('PUT', blobUrl(owner.workspaceId, parent), bytes(10))).status, 401);
  assert.equal((await raw('GET', blobUrl(owner.workspaceId, parent, fileId), undefined, stranger.token)).status, 403);
  assert.equal((await raw('PUT', blobUrl(owner.workspaceId, parent), bytes(10), stranger.token)).status, 403);
  // the same ids inside the stranger's own workspace do not resolve to the owner's file
  assert.equal((await raw('GET', blobUrl(stranger.workspaceId, parent, fileId), undefined, stranger.token)).status, 404);
  assert.equal((await raw('GET', blobUrl(owner.workspaceId, parent, 'missing'), undefined, owner.token)).status, 404);
  assert.equal((await raw('PUT', blobUrl(owner.workspaceId, 'a.b'), bytes(10), owner.token)).status, 400, 'dots are not allowed in directory names');
  assert.equal((await raw('GET', blobUrl(owner.workspaceId, parent, 'a%5Cb'), undefined, owner.token)).status, 404);
});

test('files above the limit are refused, whether announced by Content-Length or streamed', async () => {
  const owner = await account('files-limit');
  const parent = crypto.randomUUID();
  const tooBig = bytes(MAX + 1);
  const refused = await raw('PUT', blobUrl(owner.workspaceId, parent), tooBig, owner.token, { 'content-type': 'image/png' });

  assert.equal(refused.status, 413);
  assert.equal((await raw('PUT', blobUrl(owner.workspaceId, parent), bytes(MAX), owner.token, { 'content-type': 'image/png' })).status, 200, 'exactly the limit is fine');
  const streamed = await raw('PUT', blobUrl(owner.workspaceId, parent), new ReadableStream({
    start(controller) { controller.enqueue(bytes(MAX)); controller.enqueue(bytes(10)); controller.close(); },
  }), owner.token, { 'content-type': 'image/png' }).catch((error) => ({ status: 'aborted', error }));

  assert.ok(streamed.status === 413 || streamed.status === 'aborted', `streamed oversize upload was ${streamed.status}`);
  const leftovers = (await readdir(path.join(dir, 'files', owner.workspaceId, parent))).filter((name) => name.endsWith('.partial'));

  assert.deepEqual(leftovers, [], 'no partial files are left behind');
});

test('multipart upload: parts can be listed and resumed, the result is the concatenation, wrong tags are refused', async () => {
  const owner = await account('files-multipart');
  const other = await account('files-multipart-other');
  const parent = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const chunks = [bytes(20_000, 1), bytes(20_000, 2), bytes(5_000, 3)];
  const created = await json('POST', `/api/file_storage/${owner.workspaceId}/create_upload`, { file_id: fileId, parent_dir: parent, content_type: 'application/pdf', file_size: 45_000 }, owner.token);
  const uploadId = created.body.data.upload_id;
  const partUrl = (n) => `/api/file_storage/${owner.workspaceId}/upload_part/${parent}/${fileId}/${uploadId}/${n}`;

  assert.equal(created.status, 200);
  assert.equal(created.body.data.file_id, fileId);
  const etags = [];

  for (const [index, chunk] of chunks.entries()) {
    const put = await raw('PUT', partUrl(index + 1), chunk, owner.token);
    const result = (await put.json()).data;

    assert.equal(result.part_num, index + 1);
    assert.equal(result.e_tag, createHash('sha256').update(chunk).digest('hex'));
    etags.push(result.e_tag);
    if (index === 0) {
      const listed = (await json('GET', `/api/file_storage/${owner.workspaceId}/upload_parts/${parent}/${fileId}/${uploadId}`, undefined, owner.token)).body.data;

      assert.deepEqual(listed.parts, [{ part_number: 1, e_tag: etags[0] }]);
    }
  }
  const complete = (parts) => json('PUT', `/api/file_storage/${owner.workspaceId}/complete_upload`, { file_id: fileId, parent_dir: parent, upload_id: uploadId, parts }, owner.token);

  assert.equal((await complete([{ part_number: 1, e_tag: etags[0] }, { part_number: 2, e_tag: 'wrong' }, { part_number: 3, e_tag: etags[2] }])).status, 400);
  assert.equal((await complete([{ part_number: 1, e_tag: etags[0] }, { part_number: 3, e_tag: etags[2] }])).status, 400, 'gaps are refused');
  assert.equal((await raw('PUT', partUrl(1), chunks[0], other.token)).status, 403);
  assert.equal((await complete(etags.map((e_tag, i) => ({ part_number: i + 1, e_tag })))).status, 200);
  const got = await raw('GET', blobUrl(owner.workspaceId, parent, fileId), undefined, owner.token);

  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), Buffer.concat(chunks));
  assert.equal((await raw('PUT', partUrl(1), chunks[0], owner.token)).status, 404, 'a finished session is gone');
});

test('multipart: size limit, abort, bad ids and foreign sessions', async () => {
  const owner = await account('files-multipart2');
  const other = await account('files-multipart2-other');
  const parent = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const create = (token, ws, extra = {}) => json('POST', `/api/file_storage/${ws}/create_upload`, { file_id: fileId, parent_dir: parent, content_type: 'image/png', file_size: 10, ...extra }, token);

  assert.equal((await create(owner.token, owner.workspaceId, { file_size: MAX + 1 })).status, 413);
  assert.equal((await create(owner.token, owner.workspaceId, { parent_dir: '../x' })).status, 400);
  assert.equal((await create(owner.token, owner.workspaceId, { file_id: 'a/b' })).status, 400);
  const uploadId = (await create(owner.token, owner.workspaceId)).body.data.upload_id;
  const sessionUrl = `/api/file_storage/${owner.workspaceId}/upload_parts/${parent}/${fileId}/${uploadId}`;

  assert.equal((await json('GET', sessionUrl, undefined, other.token)).status, 403, 'another workspace cannot see it');
  assert.equal((await json('GET', `/api/file_storage/${other.workspaceId}/upload_parts/${parent}/${fileId}/${uploadId}`, undefined, other.token)).status, 404);
  assert.equal((await raw('PUT', `/api/file_storage/${owner.workspaceId}/upload_part/${parent}/${fileId}/${uploadId}/0`, bytes(5), owner.token)).status, 400);
  assert.equal((await raw('PUT', `/api/file_storage/${owner.workspaceId}/upload_part/${parent}/${fileId}/${uploadId}/2001`, bytes(5), owner.token)).status, 400);
  assert.equal((await json('DELETE', `/api/file_storage/${owner.workspaceId}/upload/${parent}/${fileId}/${uploadId}`, undefined, owner.token)).status, 200);
  assert.equal((await json('GET', sessionUrl, undefined, owner.token)).status, 404);
  assert.equal((await json('DELETE', `/api/file_storage/${owner.workspaceId}/upload/${parent}/${fileId}/${uploadId}`, undefined, owner.token)).status, 200, 'aborting twice is harmless');
});
