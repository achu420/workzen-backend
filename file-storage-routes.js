// Image and file uploads for documents, covers, avatars and attachment cells (the web client's /api/file_storage
// contract): a single PUT for small files and an S3-style multipart flow (create_upload, upload_part,
// upload_parts, complete_upload, abort) for files of 5 MB and more.
//
// Files live on local disk, one directory per workspace:
//   <FILE_STORAGE_DIR>/<workspaceId>/<parentDir>/<fileId>        the bytes
//   <FILE_STORAGE_DIR>/<workspaceId>/<parentDir>/<fileId>.meta   { content_type, size, created_by, created_at }
//   <FILE_STORAGE_DIR>/<workspaceId>/.uploads/<uploadId>/        in-flight multipart sessions
// Back this directory up together with the database (it is not part of the Postgres dump).
//
// Every route needs workspace membership. Downloads are served with nosniff and a sandboxing CSP, and only
// known-safe image/pdf/audio/video types are shown inline; everything else (HTML, SVG, scripts) is a download.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const INLINE_TYPES = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;
const MAX_PARTS = 2000;

class UploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createFileStorageRoutes({ store, helpers, options = {}, dataFile }) {
  const env = options.env ?? process.env;
  const root = path.resolve(options.fileStorageDir ?? env.FILE_STORAGE_DIR ?? path.join(path.dirname(dataFile), 'files'));
  const maxBytes = options.fileMaxBytes ?? (Number(env.FILE_MAX_BYTES) || 100 * 1024 * 1024);
  const { requireWorkspace, send, appFlowyResponse, body, now, validateUuid } = helpers;
  const fail = (res, status, code, message) => send(res, status, { code: status, message, error: { code, message } });

  const safe = (value) => typeof value === 'string' && SAFE_ID.test(value);
  const fileDir = (workspaceId, parentDir) => path.join(root, workspaceId, parentDir);
  const sessionDir = (workspaceId, uploadId) => path.join(root, workspaceId, '.uploads', uploadId);

  // Streams a request body to `target`, refusing anything over `limit` bytes. Returns the byte count and sha256.
  async function receive(req, target, limit) {
    let size = 0;
    const hash = createHash('sha256');
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > limit) return callback(new UploadError(413, 'FILE_TOO_LARGE', `File is larger than ${limit} bytes`));
        hash.update(chunk);
        return callback(null, chunk);
      },
    });

    await mkdir(path.dirname(target), { recursive: true });
    const partial = `${target}.${randomUUID()}.partial`;

    try {
      await pipeline(req, meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return { size, sha256: hash.digest('hex') };
  }

  const cleanContentType = (value) => {
    const type = String(value ?? '').split(';')[0].trim().toLowerCase();

    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : 'application/octet-stream';
  };

  async function writeMeta(dir, fileId, meta) {
    await writeFile(path.join(dir, `${fileId}.meta`), JSON.stringify(meta), { mode: 0o600 });
  }

  async function putBlob(req, res, access, parentDir) {
    if (!safe(parentDir)) return fail(res, 400, 'INVALID_INPUT', 'Invalid parent directory');
    const fileId = randomUUID();
    const dir = fileDir(access.workspace.id, parentDir);
    const declared = Number(req.headers['content-length']);

    if (Number.isFinite(declared) && declared > maxBytes) return fail(res, 413, 'FILE_TOO_LARGE', 'File is too large');
    const { size } = await receive(req, path.join(dir, fileId), maxBytes);

    await writeMeta(dir, fileId, { content_type: cleanContentType(req.headers['content-type']), size, created_by: access.user.id, created_at: now() });
    return send(res, 200, appFlowyResponse({ file_id: fileId }));
  }

  async function getBlob(req, res, access, parentDir, fileId) {
    if (!safe(parentDir) || !safe(fileId)) return fail(res, 404, 'NOT_FOUND', 'File not found');
    const dir = fileDir(access.workspace.id, parentDir);
    let meta;
    let info;

    try {
      meta = JSON.parse(await readFile(path.join(dir, `${fileId}.meta`), 'utf8'));
      info = await stat(path.join(dir, fileId));
    } catch {
      return fail(res, 404, 'NOT_FOUND', 'File not found');
    }
    const inline = INLINE_TYPES.test(meta.content_type);

    res.writeHead(200, {
      'content-type': inline ? meta.content_type : 'application/octet-stream',
      'content-length': info.size,
      'content-disposition': inline ? 'inline' : 'attachment',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();
    return pipeline(createReadStream(path.join(dir, fileId)), res).catch(() => res.destroy());
  }

  async function createUpload(res, access, b) {
    const parentDir = b.parent_dir;
    const fileId = b.file_id ?? randomUUID();

    if (!safe(parentDir) || !safe(fileId)) return fail(res, 400, 'INVALID_INPUT', 'parent_dir and file_id must be simple ids');
    if (Number.isFinite(Number(b.file_size)) && Number(b.file_size) > maxBytes) return fail(res, 413, 'FILE_TOO_LARGE', 'File is too large');
    const uploadId = randomUUID();
    const dir = sessionDir(access.workspace.id, uploadId);

    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.json'), JSON.stringify({
      parent_dir: parentDir, file_id: fileId, content_type: cleanContentType(b.content_type), user_id: access.user.id, created_at: now(),
    }), { mode: 0o600 });
    return send(res, 200, appFlowyResponse({ upload_id: uploadId, file_id: fileId }));
  }

  async function loadSession(access, parentDir, fileId, uploadId) {
    if (!validateUuid(uploadId)) throw new UploadError(404, 'UPLOAD_NOT_FOUND', 'Upload not found');
    try {
      const dir = sessionDir(access.workspace.id, uploadId);
      const session = JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8'));

      if (session.parent_dir !== parentDir || session.file_id !== fileId || session.user_id !== access.user.id) throw new Error('mismatch');
      return { dir, session };
    } catch {
      throw new UploadError(404, 'UPLOAD_NOT_FOUND', 'Upload not found');
    }
  }

  async function listParts(dir) {
    const names = await readdir(dir).catch(() => []);

    return names.filter((name) => /^part-\d+$/.test(name)).map((name) => Number(name.slice(5))).sort((a, b) => a - b);
  }

  async function partEtag(dir, partNumber) {
    return (await readFile(path.join(dir, `part-${partNumber}.etag`), 'utf8').catch(() => null));
  }

  async function putPart(req, res, access, [parentDir, fileId, uploadId, number]) {
    const partNumber = Number(number);

    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) return fail(res, 400, 'INVALID_INPUT', 'Invalid part number');
    const { dir } = await loadSession(access, parentDir, fileId, uploadId);
    const { sha256 } = await receive(req, path.join(dir, `part-${partNumber}`), 64 * 1024 * 1024);

    await writeFile(path.join(dir, `part-${partNumber}.etag`), sha256, { mode: 0o600 });
    return send(res, 200, appFlowyResponse({ e_tag: sha256, part_num: partNumber }));
  }

  async function listUploadedParts(res, access, [parentDir, fileId, uploadId]) {
    const { dir } = await loadSession(access, parentDir, fileId, uploadId);
    const parts = [];

    for (const partNumber of await listParts(dir)) {
      const etag = await partEtag(dir, partNumber);

      if (etag) parts.push({ part_number: partNumber, e_tag: etag });
    }
    return send(res, 200, appFlowyResponse({ file_id: fileId, upload_id: uploadId, parts }));
  }

  async function completeUpload(res, access, b) {
    const { parent_dir: parentDir, file_id: fileId, upload_id: uploadId, parts } = b;

    if (!safe(parentDir) || !safe(fileId) || !Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
      return fail(res, 400, 'INVALID_INPUT', 'parent_dir, file_id, upload_id and parts are required');
    }
    const { dir, session } = await loadSession(access, parentDir, fileId, uploadId);
    const ordered = [...parts].sort((a, b2) => a.part_number - b2.part_number);
    let total = 0;

    for (let index = 0; index < ordered.length; index += 1) {
      const { part_number: number, e_tag: etag } = ordered[index];

      if (number !== index + 1) return fail(res, 400, 'INVALID_PARTS', 'Parts must be numbered 1..n without gaps');
      if ((await partEtag(dir, number)) !== etag) return fail(res, 400, 'INVALID_PARTS', `Part ${number} is missing or does not match its e_tag`);
      total += (await stat(path.join(dir, `part-${number}`))).size;
    }
    if (total > maxBytes) return fail(res, 413, 'FILE_TOO_LARGE', 'File is too large');
    const target = fileDir(access.workspace.id, parentDir);

    await mkdir(target, { recursive: true });
    const assembled = path.join(dir, 'assembled');
    const out = createWriteStream(assembled, { mode: 0o600 });

    for (const { part_number: number } of ordered) {
      await pipeline(createReadStream(path.join(dir, `part-${number}`)), out, { end: false });
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    await rename(assembled, path.join(target, fileId));
    await writeMeta(target, fileId, { content_type: session.content_type, size: total, created_by: access.user.id, created_at: now() });
    await rm(dir, { recursive: true, force: true });
    return send(res, 200, appFlowyResponse(null));
  }

  async function abortUpload(res, access, [parentDir, fileId, uploadId]) {
    const { dir } = await loadSession(access, parentDir, fileId, uploadId).catch((error) => {
      if (error.status === 404) return { dir: null };
      throw error;
    });

    if (dir) await rm(dir, { recursive: true, force: true });
    return send(res, 200, appFlowyResponse(null));
  }

  async function handle({ req, res, parts, method }) {
    if (parts[0] !== 'api' || parts[1] !== 'file_storage' || !parts[2]) return false;
    const access = await requireWorkspace(store, req, res, parts[2]);

    if (!access) return true;
    const [, , , kind, a, b2, c, d] = parts;

    try {
      if (kind === 'v1' && a === 'blob' && b2 && !c && method === 'PUT' && parts.length === 6) await putBlob(req, res, access, b2);
      else if (kind === 'v1' && a === 'blob' && b2 && c && ['GET', 'HEAD'].includes(method) && parts.length === 7) await getBlob(req, res, access, b2, c);
      else if (kind === 'create_upload' && method === 'POST' && parts.length === 4) await createUpload(res, access, await body(req));
      else if (kind === 'upload_part' && method === 'PUT' && parts.length === 8) await putPart(req, res, access, [a, b2, c, d]);
      else if (kind === 'upload_parts' && method === 'GET' && parts.length === 7) await listUploadedParts(res, access, [a, b2, c]);
      else if (kind === 'complete_upload' && method === 'PUT' && parts.length === 4) await completeUpload(res, access, await body(req));
      else if (kind === 'upload' && method === 'DELETE' && parts.length === 7) await abortUpload(res, access, [a, b2, c]);
      else return false;
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      if (error instanceof UploadError) fail(res, error.status, error.code, error.message);
      else if (error.status) fail(res, error.status, 'INVALID_INPUT', error.message);
      else throw error;
    }
    return true;
  }

  return { handle, root };
}
