import './env-file.js';
import http from 'node:http';
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { URL, pathToFileURL } from 'node:url';
import path from 'node:path';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import * as Y from 'yjs';
import { WebSocketServer } from 'ws';
import { openStore, mutate } from './storage.js';
import { hashPassword, verifyPassword, tokenHash, issueToken, id } from './auth.js';
import { createDefaultWorkspaceDatabaseState } from './workspace-database.js';
import { decodeFullSyncBatch, decodeMessage, encodeFullSyncBatch, encodeMessage } from './collab-protocol.js';
import { createInitialPageCollab, createPageCollabFromFirstBodyContribution, decodeCreationCollab, pageIdFromDocumentId, rowDocumentIdFromRowId } from './page-document.js';
import { createInitialDatabaseCollab, DATABASE_COLLAB_VERSION, FOLDER_LAYOUTS, SUPPORTED_ADDITIONAL_VIEW_LAYOUTS } from './database-document.js';
import { createInitialDatabaseRowCollab } from './database-row-document.js';
import { createAgentAuthenticator } from './agent-auth.js';
import { createCardService, createIndexRowCandidates } from './cards.js';
import { createMcpHandler } from './mcp.js';
import { TOOL_BY_NAME } from './mcp-tools.js';
import { buildDatabaseCollabFromTemplate } from './database-template-builder.js';
import { getDatabaseTemplate, listDatabaseTemplates } from './database-template-library.js';
import { buildReadableIndex, createSearchIndex, searchMentions, searchWorkspace } from './search-index.js';
import { createFolderNotifier } from './folder-notifier.js';
import { buildDocumentCollabFromTemplate } from './document-template-builder.js';
import { getDocumentTemplate, listDocumentTemplates } from './document-template-library.js';
import { createAiRoutes } from './ai-routes.js';
import { createWorkspaceOpsRoutes } from './workspace-ops-routes.js';
import { createFileStorageRoutes } from './file-storage-routes.js';
import { clientAddress, createLoginThrottle } from './login-throttle.js';
import { checkProductionConfig } from './production-checks.js';
import { createAgentRoutes } from './agent-routes.js';
import { createCardHistory } from './card-history.js';
import { createCardHistoryRoutes } from './card-history-routes.js';
import { createWorkspaceKnowledge } from './workspace-knowledge.js';
import { createPageWriter } from './page-writer.js';
import { createPageComments } from './page-comments.js';
import { planTemplateDatabases, relinkTemplateDatabase } from './database-template-plan.js';
import { createMailer } from './mailer.js';
import { createPageVersioner } from './page-versioner.js';
import { createAuthCodes } from './auth-codes.js';
import { addedToWorkspaceEmail, codeEmail, emailableNotificationTypes, notificationEmail } from './email-templates.js';
import { resolveAiSecret } from './ai-crypto.js';

const DEFAULT_DEV_CORS_ORIGINS = ['http://localhost:5183', 'http://127.0.0.1:5183', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://127.0.0.1:3000'];
const config = { host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 8787), file: path.resolve(process.env.DATA_FILE || './data/appflowy-independent.json'), storage: process.env.STORAGE || 'json', databaseUrl: process.env.DATABASE_URL, devKey: process.env.DEV_TEST_KEY || '', corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS !== undefined ? process.env.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) : DEFAULT_DEV_CORS_ORIGINS, enablePageHistory: process.env.ENABLE_PAGE_HISTORY !== undefined ? process.env.ENABLE_PAGE_HISTORY !== 'false' : true, apiLogFile: path.resolve(process.env.API_LOG_FILE || './logs/api.log') };
// Task 79: PATCH added for updatePage() (page-api.ts) -- PATCH
// /api/workspace/{id}/page-view/{viewId}, used to rename a page/view, set
// its icon, or replace its `extra` metadata (e.g. syncTemplateViewMetadata's
// cover/database_row_template fields). Omitting it from this allowlist
// doesn't surface as a 404 in the server log the way a missing route does:
// the browser's own CORS preflight check silently blocks the real PATCH
// from ever being sent once it sees PATCH isn't in Access-Control-Allow-Methods,
// so only the (successful, 204) OPTIONS preflight was ever visible anywhere.
const CORS_ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
// X-Platform and Client-Version are sent by AppFlowy-Web's axios client (core.ts,
// auth-api.ts, collab-api.ts); X-Device-Id and If-Match are included defensively for
// device-scoped requests and optimistic-concurrency page updates respectively.
// Cache-Control is sent by AppFlowy-Web's collab-api.ts, atomic-creation-api.ts, and
// database-history-api.ts on post-creation/atomic read-back GET requests (Task 55) —
// without it, the browser's CORS preflight rejects those requests and navigation to a
// newly created document silently fails. Device-Id (lowercase, no "X-" prefix; distinct
// from the pre-existing X-Device-Id entry above) is sent literally as 'device-id' by
// collab-api.ts (full-sync/batch) and inline-comment-api.ts via getOrCreateDeviceId() —
// also genuinely missing until Task 55.
// X-Request-Time / X-Request-Stream-Id are sent by AppFlowy-Web's search requests (misc-api.ts); without
// them the browser's CORS preflight blocks every search call before it reaches the server.
const CORS_ALLOWED_HEADERS = 'Content-Type, Authorization, If-Match, X-Development-Key, X-Platform, X-Device-Id, Client-Version, Cache-Control, Device-Id, X-Request-Time, X-Request-Stream-Id, ai-model';
// Applies CORS response headers when the request's Origin is in the configured allowlist.
// Credentials are never enabled: auth here is Bearer-token-based (see `bearer()`), not
// cookie-based, so a credentialed CORS mode is unnecessary and we avoid pairing it with
// any origin reflection to prevent the wildcard+credentials class of bug.
function applyCorsHeaders(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (!allowedOrigins.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  return true;
}
// A client whose doc has any deleted items answers every server manifest with
// a non-empty (delete-set only) update, because Yjs always re-encodes the whole
// delete set. That update is a duplicate whose causal base is exactly the
// server's current state vector; acknowledging it again with a fresh manifest
// restarts the exchange forever. A resent update with any other base (a real
// retry) still gets its manifest.
function isRedundantManifestReply(accepted, update) {
  const before = update.beforeStateVector;
  const current = accepted.stateVector;
  if (accepted.duplicate !== true || !before?.byteLength || !current || before.byteLength !== current.byteLength) return false;
  return Buffer.from(before).equals(Buffer.from(current));
}
// --- API access/error logging ---
// Every REST response and every WebSocket connect/reject/close is logged
// here, one JSON line per event, to `config.apiLogFile` (plus a concise
// human-readable mirror to stdout). This exists because every bug found
// during manual testing before this (the embedded:false validation gap,
// the move-to-trash 500, the persist-race ENOENT) was only discoverable by
// the user manually copying the browser's Network tab -- nothing server-
// side recorded what request actually came in, what it contained, or what
// was sent back. Request/response bodies are only logged for non-2xx
// responses (kept lean for the common case, and because that's where the
// debugging value is); secrets are redacted before anything touches disk.
let apiLogDirReady = null;
function redactSecrets(raw) {
  if (!raw) return raw;
  return raw
    .replace(/("(?:password|current_password|new_password|access_token|refresh_token|authorization|api_key|secret)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/afmcp_[a-z0-9]{12,40}_[A-Za-z0-9_-]{20,}/g, 'afmcp_[redacted]');
}
// The WS handshake URL carries the live access token as a `token` query
// param (see the client's `/ws/v2/{workspaceId}?token=...` connection
// string) -- logging req.url verbatim would put a valid bearer credential
// in the log file. Masked here, not in redactSecrets, since this is a URL
// string, not a JSON body.
function redactWsUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  return rawUrl.replace(/([?&]token=)[^&]+/i, '$1[redacted]');
}
// Size-capped rotation: api.log -> api.log.1 ... api.log.N (API_LOG_MAX_BYTES, API_LOG_KEEP), so a long-running
// server cannot fill its disk. Writes are serialised so a rotation never races an append.
const API_LOG_MAX_BYTES = Number(process.env.API_LOG_MAX_BYTES) || 20 * 1024 * 1024;
const API_LOG_KEEP = Number(process.env.API_LOG_KEEP) || 5;
const API_LOG_FIELD_MAX_CHARS = 4000;
let apiLogChain = Promise.resolve();
let apiLogSize = null;
async function rotateApiLog() {
  for (let index = API_LOG_KEEP - 1; index >= 1; index -= 1) {
    await rename(`${config.apiLogFile}.${index}`, `${config.apiLogFile}.${index + 1}`).catch(() => undefined);
  }
  await rename(config.apiLogFile, `${config.apiLogFile}.1`).catch(() => undefined);
  apiLogSize = 0;
}
function writeApiLogLine(line) {
  apiLogChain = apiLogChain.then(async () => {
    try {
      if (!apiLogDirReady) apiLogDirReady = mkdir(path.dirname(config.apiLogFile), { recursive: true });
      await apiLogDirReady;
      if (apiLogSize === null) apiLogSize = (await stat(config.apiLogFile).catch(() => ({ size: 0 }))).size;
      if (apiLogSize >= API_LOG_MAX_BYTES) await rotateApiLog();
      await appendFile(config.apiLogFile, line + '\n');
      apiLogSize += Buffer.byteLength(line) + 1;
    } catch (writeError) {
      console.error('API log write failed', writeError);
    }
  });
  return apiLogChain;
}
// A request or response body can be a whole collaboration document; keep log lines small enough to read and grep.
function capLogField(value) {
  if (value === undefined || value === null) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);

  return text.length > API_LOG_FIELD_MAX_CHARS ? `${text.slice(0, API_LOG_FIELD_MAX_CHARS)}...[truncated ${text.length - API_LOG_FIELD_MAX_CHARS} chars]` : value;
}
function logApiEvent(entry) {
  const capped = { ...entry };
  for (const field of ['request_body', 'response_body']) if (field in capped) capped[field] = capLogField(capped[field]);
  const line = JSON.stringify({ time: new Date().toISOString(), ...capped });
  void writeApiLogLine(line);
  const summary = `[api] ${entry.kind}${entry.method ? ` ${entry.method}` : ''}${entry.path ? ` ${entry.path}` : ''}` +
    `${entry.status !== undefined ? ` -> ${entry.status}` : ''}${entry.duration_ms !== undefined ? ` (${entry.duration_ms}ms)` : ''}` +
    `${entry.request_id ? ` [${entry.request_id}]` : ''}`;
  if (entry.status >= 500) console.error(summary, entry.status >= 400 ? { request_body: entry.request_body, response_body: entry.response_body } : '');
  else if (entry.status >= 400) console.warn(summary, { request_body: entry.request_body, response_body: entry.response_body });
  else console.log(summary);
}
function logApiResponse(res, status, responseBody) {
  const ctx = res.__apiLog;
  if (!ctx) return;
  const durationMs = Math.round(Number(process.hrtime.bigint() - ctx.startedAt) / 1e4) / 100;
  logApiEvent({
    kind: 'request',
    request_id: ctx.requestId,
    method: ctx.method,
    path: ctx.path,
    query: ctx.query,
    status,
    duration_ms: durationMs,
    ...(status >= 400 ? { request_body: redactSecrets(ctx.req.rawBody), response_body: responseBody } : {}),
  });
}
// Sent on every API response: no MIME sniffing, no referrer leakage, never framed. HSTS only when the operator says the
// server is reached over HTTPS (HSTS=true), since sending it over plain HTTP is meaningless and risky in development.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  ...(process.env.HSTS === 'true' ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
};
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
  logApiResponse(res, status, status >= 400 ? body : undefined);
};
const MAX_FULL_SYNC_BYTES = 64 * 1024 * 1024;
// Largest raw Yjs update a client may send over the realtime socket. The web client reads this from
// server-info (`max_update_bytes`, falling back to 4 MiB when absent) and sends anything bigger through its
// HTTP slow lane. The socket's own frame cap must be at least this plus protobuf framing, otherwise a
// browser holding a large local history gets disconnected on every reconnect, forever (the update is
// resent first thing, exceeds the cap again, and the socket is torn down before anything is synced).
const REALTIME_MAX_UPDATE_BYTES = 4 * 1024 * 1024;
const REALTIME_MAX_FRAME_BYTES = REALTIME_MAX_UPDATE_BYTES + 256 * 1024;
const MAX_FULL_SYNC_ITEMS = 64;
const sendBinary = (res, status, bytes) => {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/octet-stream', 'content-length': bytes.byteLength, 'cache-control': 'no-store' });
  res.end(bytes);
  logApiResponse(res, status, undefined);
};
const error = (res, status, code, message) => send(res, status, { error: { code, message } });
const goTrueError = (res, status, errorType, errorCode, description) => send(res, status, {
  error: errorType,
  error_code: errorCode,
  error_description: description,
  msg: description,
}, { 'cache-control': 'no-store' });
const appFlowyResponse = (data) => ({ code: 0, message: 'success', data });
async function body(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2_000_000) throw Object.assign(new Error('body too large'), { status: 413 }); } req.rawBody = raw; if (!raw) return {}; try { const value = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); } }
async function binaryBody(req, maximumBytes) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maximumBytes) throw Object.assign(new Error('binary request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}
function inflateFullSyncPayload(payload, compression) {
  if (compression === 0) return new Uint8Array(payload);
  if (compression !== 2) throw Object.assign(new Error('unsupported_compression'), { code: 'UNSUPPORTED_COMPRESSION' });
  try {
    return new Uint8Array(gunzipSync(payload, { maxOutputLength: MAX_FULL_SYNC_BYTES }));
  } catch {
    throw Object.assign(new Error('invalid_gzip_payload'), { code: 'INVALID_COMPRESSION' });
  }
}
function decodeFullSyncStateVector(value) {
  try { return Y.decodeStateVector(value); }
  catch { throw Object.assign(new Error('invalid_state_vector'), { code: 'INVALID_STATE_VECTOR' }); }
}
function stateVectorsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [clientId, clock] of left) if (right.get(clientId) !== clock) return false;
  return true;
}
function emptyFullSyncResult(item, errorMessage, serverStateVector = Uint8Array.from([0]), collabVersion = '') {
  return {
    objectId: item.objectId,
    collabType: item.collabType,
    compression: 0,
    missingUpdate: new Uint8Array(),
    error: errorMessage,
    serverStateVector,
    collabVersion,
  };
}
const now = () => new Date().toISOString();
const publicUser = (u) => ({ id: u.id, email: u.email, created_at: u.created_at });
function bearer(req) { const value = req.headers.authorization || ''; return value.startsWith('Bearer ') ? value.slice(7) : null; }
function sessionExpired(session) { return !session || session.expires_at <= now(); }
async function currentUser(store, req) { const token = bearer(req); const session = token && await store.getSession(tokenHash(token)); if (sessionExpired(session)) return null; return store.getUserById(session.user_id); }
async function userByAccessToken(store, token) {
  if (!token) return null;
  const session = await store.getSession(tokenHash(token));
  if (sessionExpired(session)) return null;
  return store.getUserById(session.user_id);
}
async function requireUser(store, req, res) { const user = await currentUser(store, req); if (!user) { error(res, 401, 'UNAUTHENTICATED', 'Authentication required'); return null; } return user; }
async function requireWorkspace(store, req, res, workspaceId) { const user = await requireUser(store, req, res); if (!user) return null; const workspace = await store.getWorkspace(workspaceId); const m = workspace && await store.getMembership(workspaceId, user.id); if (!m) { error(res, 403, 'WORKSPACE_FORBIDDEN', 'Workspace access denied'); return null; } return { user, membership: m, workspace }; }

// Resolves the ancestor chain (root-first, inclusive of the target) from the workspace
// down to a space or page view_id, by walking persisted parent_view_id links. Returns
// null if the view does not exist in this workspace, so the caller can 404.
async function resolveNavigationAncestorChain(store, workspace, viewId) {
  if (viewId === workspace.id) return [{ kind: 'workspace', record: workspace }];
  const space = await store.getSpace(viewId);
  if (space && space.workspace_id === workspace.id) {
    return [{ kind: 'workspace', record: workspace }, { kind: 'space', record: space }];
  }
  const page = await store.getPage(viewId);
  if (!page || page.workspace_id !== workspace.id) return null;
  const chain = [{ kind: 'page', record: page }];
  let cursorId = page.parent_view_id;
  let guard = 0;
  while (cursorId && cursorId !== workspace.id && guard < 64) {
    guard += 1;
    const ancestorSpace = await store.getSpace(cursorId);
    if (ancestorSpace && ancestorSpace.workspace_id === workspace.id) {
      chain.push({ kind: 'space', record: ancestorSpace });
      cursorId = workspace.id;
      break;
    }
    const ancestorPage = await store.getPage(cursorId);
    if (!ancestorPage || ancestorPage.workspace_id !== workspace.id) return null;
    chain.push({ kind: 'page', record: ancestorPage });
    cursorId = ancestorPage.parent_view_id;
  }
  chain.push({ kind: 'workspace', record: workspace });
  return chain.reverse();
}

// Favorite and trash list items are leaf pages (never spaces), rendered with
// the same View shape used elsewhere so the web client's existing View
// typing/handling applies unchanged.
function pageToFavoriteOrTrashView(page, workspaceId) {
  return {
    view_id: page.id,
    name: page.title,
    icon: page.icon ?? null,
    layout: 0,
    extra: page.extra ?? null,
    children: [],
    has_children: false,
    is_published: false,
    is_private: false,
    is_favorite: !!page.is_favorite,
    is_pinned: page.is_pinned ?? true,
    favorited_at: page.favorited_at ?? null,
    created_at: page.created_at,
    last_edited_time: page.updated_at,
    parent_view_id: page.parent_view_id ?? workspaceId,
    workspace_id: workspaceId,
  };
}

function navigationNodeView(node, workspace, children) {
  if (node.kind === 'workspace') {
    return {
      view_id: workspace.id,
      name: workspace.name,
      icon: null,
      layout: 0,
      extra: null,
      children,
      has_children: children.length > 0,
      is_published: false,
      is_private: false,
      created_at: workspace.created_at,
      workspace_id: workspace.id,
    };
  }
  if (node.kind === 'space') {
    const space = node.record;
    return {
      view_id: space.id,
      name: space.name,
      icon: null,
      layout: 0,
      extra: { is_space: true },
      children,
      has_children: children.length > 0,
      is_published: false,
      is_private: false,
      created_at: space.created_at,
      last_edited_time: space.created_at,
      parent_view_id: workspace.id,
      workspace_id: workspace.id,
    };
  }
  const page = node.record;
  return {
    view_id: page.id,
    name: page.title,
    icon: page.icon ?? null,
    // Task 61: Document pages never set `.layout`, so this is unchanged (0)
    // for every pre-existing page; only Database container/view pages (which
    // store layout:1, ViewLayout.Grid) report a non-zero value here.
    layout: page.layout ?? 0,
    extra: page.extra ?? null,
    children,
    has_children: children.length > 0,
    is_published: false,
    is_private: false,
    created_at: page.created_at,
    last_edited_time: page.updated_at,
    parent_view_id: page.parent_view_id,
    workspace_id: workspace.id,
  };
}

async function buildNavigationTargetChildren(store, workspace, targetNode, depth) {
  if (depth <= 0) return [];
  if (targetNode.kind === 'page') {
    const pages = await store.listPages(workspace.id);
    return pages
      .filter((item) => item.parent_view_id === targetNode.record.id && !item.is_trashed)
      .sort((left, right) => pageSortKey(left) - pageSortKey(right) || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
      .map((item) => navigationNodeView({ kind: 'page', record: item }, workspace, []));
  }
  if (targetNode.kind === 'space') {
    const pages = await store.listPages(workspace.id);
    return pages
      .filter((item) => item.parent_view_id === targetNode.record.id && !item.is_trashed)
      .sort((left, right) => pageSortKey(left) - pageSortKey(right) || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
      .map((item) => navigationNodeView({ kind: 'page', record: item }, workspace, []));
  }
  return [];
}
function validateEmail(email) { return typeof email === 'string' && email.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email); }
function validatePassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 200; }
function validateDocument(document) { return document !== null && typeof document === 'object' && !Array.isArray(document); }
// Deterministic v5-shaped uuid from a request id + label, so a replayed
// template-creation request resolves to exactly the objects its first call made.
function deriveUuid(requestId, label) {
  const bytes = createHash('sha256').update(`${requestId}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// Where a new page or database may be created: a supported public Space, or (nesting) a live document page of the
// same workspace. Database containers, card documents and trashed pages are not valid parents.
async function isWritableCreationParent(store, workspaceId, parentViewId, space) {
  if (space) return space.workspace_id === workspaceId && isSupportedPublicSpacePermission(space.permission);
  const page = await store.getPage(parentViewId);

  return Boolean(page) && page.workspace_id === workspaceId && !page.is_trashed && (page.layout ?? 0) === 0 &&
    page.extra?.is_database_container !== true && !page.extra?.row_document;
}

// The Space a page ultimately lives in: walks parent links through nested pages up to a Space of the same
// workspace (null when the chain breaks, loops, or leaves the workspace). Authorization for a nested page is the
// permission of that Space, exactly as for a top-level page.
async function governingSpace(store, workspaceId, page) {
  let cursor = page?.parent_view_id;

  for (let guard = 0; cursor && guard < 64; guard += 1) {
    const space = await store.getSpace(cursor);

    if (space) return space.workspace_id === workspaceId ? space : null;
    const parent = await store.getPage(cursor);

    if (!parent || parent.workspace_id !== workspaceId || parent.is_trashed) return null;
    cursor = parent.parent_view_id;
  }
  return null;
}

function validateUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
// Task 62: DatabaseRow row/default request validation helpers.
const ORIGINAL_DATABASE_RESTORE_ID = '00000000-0000-0000-0000-000000000000';
function isPlainObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

// Extracted from the single-view GET handler so Task 79's batch /views
// endpoint (getViews() in view-api.ts) can reuse the exact same tree shape
// per requested id, rather than drifting out of sync with a second copy.
// Returns null (not an error object) when viewId isn't found, so the batch
// endpoint can just filter out misses instead of failing the whole request.
// Builds the Folder-tree node for one page, nesting its children while
// `remainingDepth` allows. Children are always present in `has_children`, so the
// sidebar can offer an expand arrow even when the levels below are not inlined.
function pageViewNode(page, workspace, childrenByParent, remainingDepth) {
  const childPages = childrenByParent.get(page.id) ?? [];
  return {
    view_id: page.id,
    name: page.title,
    icon: page.icon ?? null,
    // Task 61: Document pages default to 0 (unchanged); Database
    // container/view pages report ViewLayout.Grid (1).
    layout: page.layout ?? 0,
    extra: page.extra ?? null,
    children: remainingDepth > 0 ? childPages.map((child) => pageViewNode(child, workspace, childrenByParent, remainingDepth - 1)) : [],
    has_children: childPages.length > 0,
    is_published: false,
    is_private: false,
    created_at: page.created_at,
    last_edited_time: page.updated_at,
    parent_view_id: page.parent_view_id ?? workspace.id,
    workspace_id: workspace.id,
  };
}

// Sibling order: an explicit position.sort_key (set by drag and drop) wins, otherwise creation time.
const pageSortKey = (page) => (typeof page.position?.sort_key === 'number' ? page.position.sort_key : Date.parse(page.created_at));

function groupPagesByParent(pages) {
  const byParent = new Map();
  for (const page of [...pages].sort((left, right) => pageSortKey(left) - pageSortKey(right) || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))) {
    const key = page.parent_view_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(page);
  }
  return byParent;
}

async function buildViewNode(store, workspace, viewId, depth) {
  if (viewId === workspace.id) {
    const spaces = (await store.listSpaces(workspace.id))
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    // Trashed pages must not reappear in the sidebar tree (they only
    // belong in the dedicated trash view) -- filtered at the source so
    // every derived list below (root pages, space children, has_children)
    // inherits the exclusion.
    const allPages = (await store.listPages(workspace.id)).filter((page) => !page.is_trashed);
    const childrenByParent = groupPagesByParent(allPages);
    const rootPages = [...(childrenByParent.get(workspace.id) ?? []), ...(childrenByParent.get(null) ?? [])];

    return {
      view_id: workspace.id,
      name: workspace.name,
      icon: null,
      layout: 0,
      extra: null,
      children: depth > 0 ? [
        ...spaces.map((space) => ({
          view_id: space.id,
          name: space.name,
          icon: null,
          layout: 0,
          extra: { is_space: true },
          children: depth > 1
            ? (childrenByParent.get(space.id) ?? []).map((page) => pageViewNode(page, workspace, childrenByParent, depth - 2))
            : [],
          has_children: (childrenByParent.get(space.id) ?? []).length > 0,
          is_published: false,
          is_private: false,
          created_at: space.created_at,
          last_edited_time: space.created_at,
          parent_view_id: workspace.id,
          workspace_id: workspace.id,
        })),
        ...rootPages.map((page) => pageViewNode(page, workspace, childrenByParent, depth - 1)),
      ] : [],
      has_children: spaces.length > 0 || rootPages.length > 0,
      is_published: false,
      is_private: false,
      created_at: workspace.created_at,
      workspace_id: workspace.id,
    };
  }

  const space = await store.getSpace(viewId);
  const page = space ? null : await store.getPage(viewId);

  if ((!space || space.workspace_id !== workspace.id) && (!page || page.workspace_id !== workspace.id)) {
    return null;
  }

  // Task 61: a page target (e.g. a newly created Database container
  // view) can itself have children -- the Database's own primary/
  // inline view is stored as a child Folder page of the container.
  // Previously this branch hardcoded `children: []` for any page
  // target; Document pages never have Folder children today, so this
  // was unobservable until Database child views needed it.
  const parentId = space ? space.id : page?.id;
  const childrenByParent = groupPagesByParent((await store.listPages(workspace.id)).filter((item) => !item.is_trashed));
  const children = parentId
    ? (childrenByParent.get(parentId) ?? []).map((item) => pageViewNode(item, workspace, childrenByParent, depth - 1))
    : [];

  return {
    view_id: space?.id ?? page.id,
    name: space?.name ?? page.title,
    icon: page?.icon ?? null,
    layout: space ? 0 : (page?.layout ?? 0),
    extra: space ? { is_space: true } : (page?.extra ?? null),
    children,
    has_children: children.length > 0,
    is_published: false,
    is_private: false,
    created_at: space?.created_at ?? page.created_at,
    last_edited_time: space?.created_at ?? page.updated_at,
    parent_view_id: page?.parent_view_id ?? workspace.id,
    workspace_id: workspace.id,
  };
}
function isJsonSafeCellValue(value, depth = 0) {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonSafeCellValue(item, depth + 1));
  if (isPlainObject(value)) return Object.values(value).every((item) => isJsonSafeCellValue(item, depth + 1));
  return false;
}
function isSupportedPublicSpacePermission(permission) {
  return permission && typeof permission === 'object' && !Array.isArray(permission) &&
    permission.visibility === 'public' &&
    permission.owner_access_level === 50 &&
    permission.member_default_access_level === 30 &&
    (permission.everyone_else_access_level === null || permission.everyone_else_access_level === undefined) &&
    permission.invite_policy === 'owners_only' &&
    permission.sidebar_edit_policy === 'owners_only' &&
    permission.invite_link_enabled === false &&
    permission.security && typeof permission.security === 'object' &&
    permission.security.disable_guests === false &&
    permission.security.disable_public_links === false &&
    permission.security.disable_export === false;
}
/**
 * Task 73: lazily materialize a row-detail-page Document as an "orphaned"
 * Folder-tree page (no parent_view_id/Space), shared by the explicit
 * POST /orphaned-view route (favorite-button flow) and the generic
 * GET .../collab/:objectId?collab_type=0 lazy-creation branch (the
 * primary row-detail body-editor flow, via AppFlowy-Web's getCollab()
 * passing database_id/row_id/row_document_id -- see fetchRowDocumentCollab
 * in src/application/services/js-services/fetch.ts). Returns the
 * existing or newly-created page's collab (doc_state/state_vector/etc,
 * same shape as store.getPageCollab), or null if databaseId is not a
 * real, accessible database in this workspace.
 */
async function ensureRowDocumentPage(store, access, { databaseId, databaseViewId, rowId, documentId, actorUserId }) {
  if (rowDocumentIdFromRowId(rowId) !== documentId) return { error: 'IDENTITY_MISMATCH' };
  const databaseCollab = await store.getDatabaseCollab(access.workspace.id, databaseId);
  if (!databaseCollab) return { error: 'DATABASE_NOT_FOUND' };

  const existingPage = await store.getPage(documentId);
  if (existingPage && existingPage.workspace_id === access.workspace.id) {
    const existingCollab = await store.getPageCollab(access.workspace.id, documentId);
    if (existingCollab) return { collab: existingCollab };
  }

  const timestamp = now();
  const collab = createInitialPageCollab(documentId);
  const extra = { row_document: { source: { database_id: databaseId, database_view_id: databaseViewId ?? databaseId, row_id: rowId } } };
  const page = {
    id: documentId,
    workspace_id: access.workspace.id,
    parent_view_id: null,
    title: '',
    icon: null,
    extra,
    is_favorite: false,
    document: {},
    schema_version: 'appflowy-document-v1',
    creator_id: actorUserId,
    version: 1,
    created_at: timestamp,
    updated_at: timestamp,
    position: { kind: 'start' },
  };
  try {
    const requestId = id();
    await store.createAtomicDocumentPage(page, collab, {
      request_id: requestId,
      request_digest: createHash('sha256').update(`${documentId}:${access.workspace.id}`).digest('hex'),
    });
    // Re-read via the normal storage path rather than hand-constructing the
    // response: a hand-built object with collab_version:null disagreed with
    // what store.getPageCollab returns for the same row afterwards (real
    // "appflowy-page-v1"), and that mismatch made the frontend's own
    // version-guard treat every subsequent poll as an external change,
    // repeatedly resetting the editor's local Yjs doc and silently
    // truncating in-progress typed input to whatever was typed within one
    // poll interval -- a genuine bug found via real-browser testing this task.
    const freshCollab = await store.getPageCollab(access.workspace.id, documentId);
    return { collab: freshCollab };
  } catch (creationError) {
    if (creationError.code === 'PAGE_EXISTS' || creationError.code === '23505') {
      const racedCollab = await store.getPageCollab(access.workspace.id, documentId);
      if (racedCollab) return { collab: racedCollab };
      return { error: 'RACE_UNRESOLVED' };
    }
    throw creationError;
  }
}

function createNumericUserId() { return randomInt(1, 2 ** 48); }
function createWorkspaceForUser(user, name) {
  const timestamp = now();
  return {
    workspace: { id: id(), name, icon: '', database_storage_id: id(), created_at: timestamp, owner_id: user.id },
    membership: { workspace_id: '', user_id: user.id, role: 'owner', created_at: timestamp },
  };
}
function appFlowyWorkspace(row, owner) {
  return {
    workspace_id: row.workspace.id,
    owner_uid: Number(owner.uid),
    owner_name: owner.name ?? owner.email,
    workspace_name: row.workspace.name,
    icon: row.workspace.icon ?? '',
    created_at: row.workspace.created_at,
    member_count: row.member_count,
    database_storage_id: row.workspace.database_storage_id,
    role: row.membership.role,
  };
}
// Task 79: shared by GET /mentionable-person (list) and GET
// /workspace-profile (self) -- same MentionablePerson shape (workspace-api.ts),
// same display-name fallback convention appFlowyWorkspace already uses above.
const COMMENT_MAX_CHARS = 10_000;
const REACTION_TYPE_MAX_CHARS = 64;
const MAX_MENTIONED_USERS = 50;
function userLabel(user) {
  return user?.name || (user?.email ? String(user.email).split('@')[0] : 'Someone');
}
function commentUser(user) {
  if (!user) return null;
  return {
    uuid: user.id,
    name: userLabel(user),
    avatar_url: (isPlainObject(user.metadata) && typeof user.metadata.icon_url === 'string') ? user.metadata.icon_url : null,
  };
}
async function loadUsersById(store, userIds) {
  const users = new Map();
  await Promise.all([...new Set(userIds)].map(async (userId) => { users.set(userId, await store.getUserById(userId)); }));
  return users;
}
function inlineCommentDto(comment, usersById, access) {
  return {
    user: commentUser(usersById.get(comment.user_id) ?? null),
    comment_id: comment.comment_id,
    view_id: comment.view_id,
    block_id: comment.block_id ?? null,
    // A deleted comment stays in the list as a placeholder so replies keep their thread.
    content: comment.is_deleted ? '' : comment.content,
    reply_comment_id: comment.reply_comment_id ?? null,
    is_resolved: !!comment.is_resolved,
    is_deleted: !!comment.is_deleted,
    can_be_deleted: !comment.is_deleted && (comment.user_id === access.user.id || access.membership.role === 'owner'),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}
function notificationDto(notification) {
  return {
    id: notification.id,
    workspace_id: notification.workspace_id,
    type: notification.type,
    view_id: notification.view_id ?? null,
    actor_uid: notification.actor_uid ?? null,
    metadata: isPlainObject(notification.metadata) ? notification.metadata : {},
    is_read: !!notification.is_read,
    is_archived: !!notification.is_archived,
    created_at: notification.created_at,
    read_at: notification.read_at ?? null,
  };
}
// "Space / Parent page" breadcrumb shown under a notification (the page itself is the title).
async function pageAncestorPath(store, workspace, page) {
  const names = [];
  let cursor = page.parent_view_id;
  for (let guard = 0; cursor && cursor !== workspace.id && guard < 8; guard += 1) {
    const space = await store.getSpace(cursor);
    if (space && space.workspace_id === workspace.id) { names.unshift(space.name); break; }
    const parent = await store.getPage(cursor);
    if (!parent || parent.workspace_id !== workspace.id) break;
    names.unshift(parent.title);
    cursor = parent.parent_view_id;
  }
  return names.join(' / ');
}
function parsePageParam(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) return null;
  return Math.min(parsed, maximum);
}
function parseUuidList(value) {
  if (!Array.isArray(value) || value.length > 500 || !value.every((item) => validateUuid(item))) return null;
  return [...new Set(value)];
}

function memberProfileText(profile, key) {
  return isPlainObject(profile) && typeof profile[key] === 'string' && profile[key].length > 0 ? profile[key] : null;
}
function mentionablePerson(user, membership) {
  const profile = membership?.profile;
  const accountAvatar = (isPlainObject(user.metadata) && typeof user.metadata.icon_url === 'string') ? user.metadata.icon_url : null;

  return {
    uid: Number(user.uid) || user.id,
    avatar_url: memberProfileText(profile, 'avatar_url') ?? accountAvatar,
    cover_image_url: memberProfileText(profile, 'cover_image_url'),
    custom_image_url: memberProfileText(profile, 'custom_image_url'),
    description: memberProfileText(profile, 'description'),
    email: user.email,
    name: memberProfileText(profile, 'name') ?? user.name ?? user.email,
    // MentionPersonRole: Member=1, Guest=2, Contact=3. This backend's
    // memberships are always full workspace members (owner/admin/member),
    // never guests or external contacts.
    role: 1,
    person_id: user.id,
    invited: false,
    last_mentioned_at: null,
  };
}
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateInviteCode() {
  return Array.from({ length: 10 }, () => INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)]).join('');
}
// The invite landing page keys off the numeric InvalidInvitationCode (1068).
const invalidInvitationCode = (res) => send(res, 400, {
  code: 1068,
  message: 'Invalid or expired invitation code',
  error: { code: 'INVALID_INVITATION_CODE', message: 'Invalid or expired invitation code' },
});
function createGoTrueSession(user, refreshExpiresAt = new Date(Date.now() + 7 * 86400000).toISOString()) {
  const createdAt = Date.now();
  const expiresAt = Math.floor(createdAt / 1000) + 60 * 60;
  const accessToken = issueToken();
  const refreshToken = issueToken();
  return {
    accessToken,
    refreshToken,
    session: {
      user_id: user.id,
      created_at: new Date(createdAt).toISOString(),
      expires_at: new Date(expiresAt * 1000).toISOString(),
      refresh_token_hash: tokenHash(refreshToken),
      refresh_expires_at: refreshExpiresAt,
    },
    response: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expiresAt,
      user: { id: user.id, email: user.email },
    },
  };
}

export async function createApp(options = {}) {
  const storage = options.storage || config.storage;
  if (!['json', 'postgres'].includes(storage)) throw new Error(`Unsupported STORAGE=${storage}`);
  const store = await openStore(options.file || config.file, { storage, databaseUrl: options.databaseUrl || config.databaseUrl });
  // Workspace search index: wraps the store's mutators to stay current, and is
  // rebuilt in the background on start (never blocks listen, never throws).
  const searchIndex = createSearchIndex(store, { delayMs: options.searchIndexDelayMs ?? Number(process.env.SEARCH_INDEX_DELAY_MS ?? 1500) });
  searchIndex.attach();
  // Page-tree changes (creation, rename, trash, delete) are announced to every connected client so
  // sidebars and database view tabs update without a refresh; bursts coalesce into one event.
  const folderNotifier = createFolderNotifier(store, {
    send: (workspaceId) => sendFolderChangedNow(workspaceId),
    delayMs: options.folderChangedDelayMs ?? Number(process.env.FOLDER_CHANGED_DELAY_MS ?? 150),
  });
  folderNotifier.attach();
  const pageVersioner = createPageVersioner(store, {
    quietMs: options.versionQuietMs ?? Number(process.env.VERSION_QUIET_SECONDS ?? 180) * 1000,
    maxMs: options.versionMaxMs ?? Number(process.env.VERSION_MAX_SECONDS ?? 600) * 1000,
    keepAuto: options.versionKeepAuto ?? Number(process.env.VERSION_KEEP_AUTO ?? 100),
  });
  if (options.enableAutoVersions ?? (options.enablePageHistory ?? config.enablePageHistory)) pageVersioner.attach();
  if (options.searchBackfill ?? (process.env.SEARCH_BACKFILL !== 'off')) void searchIndex.startBackfill();
  // Bring-your-own-key AI (settings, writer, row actions, persisted chat).
  const aiRoutes = createAiRoutes({
    store,
    options,
    dataFile: options.file || config.file,
    helpers: {
      requireWorkspace, send, body, appFlowyResponse, logApiResponse, isSupportedPublicSpacePermission,
      getKnowledge: () => workspaceKnowledge,
      timeZone: options.mcpTimeZone ?? process.env.MCP_TIME_ZONE ?? 'UTC',
    },
  });
  aiRoutes.attachChatCleanup();
  // Outgoing e-mail (defined early: several route modules use it).
  const mailer = options.mailer ?? createMailer();
  const authCodes = options.authCodes ?? createAuthCodes();
  const emailNotifications = options.emailNotifications ?? process.env.EMAIL_NOTIFICATIONS === 'true';
  const configuredPublicUrl = (options.publicUrl ?? process.env.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  // Where links in e-mails point. PUBLIC_URL wins; else the page that made the request; else the first web origin allowed
  // by CORS; else the Vite dev address.
  const publicBaseUrl = (req) => {
    if (configuredPublicUrl) return configuredPublicUrl;
    const origin = String(req?.headers?.origin ?? '');

    if (/^https?:\/\/[^/\s]+$/.test(origin)) return origin;
    return (options.corsAllowedOrigins || config.corsAllowedOrigins).find((candidate) => /^https?:\/\//.test(candidate)) ?? 'http://localhost:3000';
  };
  const fileStorageRoutes = createFileStorageRoutes({
    store,
    options,
    dataFile: options.file || config.file,
    helpers: { requireWorkspace, send, appFlowyResponse, body, now, validateUuid },
  });
  const workspaceOpsRoutes = createWorkspaceOpsRoutes({
    store,
    helpers: { requireWorkspace, send, appFlowyResponse, error, body, now, validateUuid, pageSortKey, isSupportedPublicSpacePermission, mailer, publicBaseUrl },
  });
  const searchReady = () => Promise.race([searchIndex.whenReady(), new Promise((resolve) => setTimeout(resolve, 5000).unref?.())]);
  // Who may create an account. Default: anyone (development). In production set SIGNUP_ENABLED=false, or keep it on
  // and restrict to company addresses with SIGNUP_ALLOWED_DOMAINS=example.com,example.org. Existing users and
  // invite-code joins are unaffected (an invite still needs an account, so create accounts for the team first).
  const signupEnabled = options.signupEnabled ?? (process.env.SIGNUP_ENABLED !== 'false');
  const signupDomains = (options.signupAllowedDomains ?? (process.env.SIGNUP_ALLOWED_DOMAINS ?? '').split(',')).map((domain) => domain.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  const signupPolicy = {
    enabled: signupEnabled,
    denial: (email) => {
      if (!signupEnabled) return 'Sign-up is disabled on this server. Ask an administrator for an account.';
      if (signupDomains.length && !signupDomains.includes(email.split('@')[1])) return `Sign-up is limited to ${signupDomains.map((d) => `@${d}`).join(', ')} addresses.`;
      return null;
    },
  };
  // --- Outgoing e-mail: invitations, recovery / sign-in codes, notification e-mails ---
  // Signed links (one-click unsubscribe) use the same server secret as the AI key vault.
  let linkKeyPromise;
  const linkKey = () => (linkKeyPromise ??= resolveAiSecret({ secret: process.env.AI_KEY_SECRET, secretFile: path.join(path.dirname(options.file || config.file), '.ai-key-secret') }));
  const signLink = async (userId) => createHmac('sha256', await linkKey()).update(`unsubscribe:${userId}`).digest('base64url');
  const emailedRecently = new Map();

  // A new account accepts every open invitation addressed to its e-mail.
  async function acceptInvitationsFor(user) {
    const accepted = [];

    for (const invitation of await store.findOpenInvitationsByEmail(user.email)) {
      if (!(await store.getWorkspace(invitation.workspace_id))) continue;
      if (!(await store.getMembership(invitation.workspace_id, user.id))) {
        await store.saveMembership({ workspace_id: invitation.workspace_id, user_id: user.id, role: invitation.role === 'admin' ? 'admin' : 'member', created_at: now() });
      }
      await store.acceptWorkspaceInvitation(invitation.id, now());
      accepted.push(invitation.workspace_id);
    }
    return accepted;
  }
  // Sign-up is closed or limited by policy, but a person someone invited by e-mail may always create their account.
  async function signupDenial(email) {
    const denied = signupPolicy.denial(email);

    if (!denied) return null;
    return (await store.findOpenInvitationsByEmail(email)).length ? null : denied;
  }
  // Best effort, never blocks or fails the request that caused it.
  function emailNotification(access, { recipientId, type, viewId, metadata }) {
    if (!emailNotifications || !mailer.enabled || !emailableNotificationTypes.has(type)) return;
    void (async () => {
      const recipient = await store.getUserById(recipientId);

      if (!recipient || recipient.metadata?.email_notifications === false) return;
      const throttleKey = `${recipientId}:${type}:${viewId ?? ''}`;

      if (Date.now() - (emailedRecently.get(throttleKey) ?? 0) < 5 * 60_000) return;
      emailedRecently.set(throttleKey, Date.now());
      if (emailedRecently.size > 5000) for (const [key, at] of emailedRecently) if (Date.now() - at > 5 * 60_000) emailedRecently.delete(key);
      const base = publicBaseUrl(null);
      const unsubscribeUrl = `${base.replace(/\/$/, '')}/api/email/unsubscribe?u=${encodeURIComponent(recipientId)}&s=${await signLink(recipientId)}`;
      const message = notificationEmail({
        type,
        actorName: metadata?.actor_name || access.user.email,
        pageName: metadata?.page_name,
        workspaceName: access.workspace.name,
        url: `${base}/app/${access.workspace.id}${viewId ? `/${viewId}` : ''}`,
        unsubscribeUrl,
      });

      await mailer.send({ to: recipient.email, ...message });
    })().catch((error) => console.warn('[mail] notification e-mail failed:', error?.message));
  }

  // The development membership helper (POST/DELETE /api/workspaces/{id}/test-members) exists only when a key is
  // configured (DEV_TEST_KEY, or `devKey` in tests) and the caller presents it; there is no default key.
  const devHelperKey = options.devKey || config.devKey;
  const devKeyMatches = (req) => Boolean(devHelperKey) && req.headers['x-development-key'] === devHelperKey;
  const environment = options.environment || process.env.NODE_ENV || 'development';

  if (environment === 'production') {
    const { errors, warnings } = checkProductionConfig({ storage: options.storage || config.storage, devKey: devHelperKey, corsOrigins: options.corsAllowedOrigins || config.corsAllowedOrigins });

    for (const warning of warnings) console.warn(`[config] ${warning}`);
    if (errors.length) throw new Error(`Refusing to start in production:\n - ${errors.join('\n - ')}`);
  }
  // Sign-in throttling: failures are counted per account and per client address.
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === 'true';
  const loginThrottle = options.loginThrottle ?? createLoginThrottle({
    maxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS) || 10,
    windowMs: (Number(process.env.LOGIN_WINDOW_SECONDS) || 900) * 1000,
  });
  const throttleKeys = (req, email) => [...(email ? [`acct:${email}`] : []), `ip:${clientAddress(req, trustProxy)}`];
  const tooManyAttempts = (res, retryAfterSeconds, goTrue = false) => {
    const message = `Too many failed attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`;

    return send(res, 429, goTrue
      ? { error: 'over_request_rate_limit', error_code: 'over_request_rate_limit', error_description: message, msg: message }
      : { code: 429, message, error: { code: 'TOO_MANY_ATTEMPTS', message } }, { 'retry-after': String(retryAfterSeconds) });
  };
  const corsAllowedOrigins = options.corsAllowedOrigins || config.corsAllowedOrigins;
  // Light MCP: agents read/create/update/move/archive/restore database rows ("cards") through the same
  // storage and live-collab paths as the web app. Agent tokens work ONLY on /mcp (see handler below).
  const cardService = createCardService({
    store,
    broadcast: (event) => broadcastCollabUpdate(event),
    searchRows: createIndexRowCandidates(store, { isReadableSpace: isSupportedPublicSpacePermission }),
    isReadableSpace: isSupportedPublicSpacePermission,
    timeZone: options.mcpTimeZone ?? process.env.MCP_TIME_ZONE ?? 'UTC',
  });
  // The agent activity trail: one row per MCP call, with the token's name copied in and, for writes, how to undo.
  function persistAgentActivity(record) {
    void (async () => {
      const tool = TOOL_BY_NAME.get(record.tool);
      const detail = record.detail ?? {};
      const failedSummary = `Failed: ${record.tool ?? 'unknown call'}${record.error_code ? ` (${record.error_code})` : ''}`;

      await store.recordAgentActivity({
        id: id(),
        workspace_id: record.workspace_id,
        token_id: record.token_id,
        token_name: record.token_name ?? (await store.getAgentToken(record.token_id))?.name ?? 'Agent',
        user_id: record.user_id,
        scope: record.scope ?? 'read',
        tool: String(record.tool ?? 'unknown').slice(0, 64),
        kind: tool?.scope === 'write' ? 'write' : 'read',
        target_type: detail.target_type ?? null,
        target_id: detail.target_id ?? record.target ?? null,
        target_title: detail.target_title ?? null,
        summary: record.ok ? (detail.summary ?? tool?.title ?? record.tool) : failedSummary,
        ok: Boolean(record.ok),
        error_code: record.error_code ?? null,
        duration_ms: record.duration_ms ?? null,
        undo: record.ok ? (detail.undo ?? null) : null,
        created_at: record.at ?? now(),
      });
    })().catch((error) => console.warn('[agent] could not record activity:', error?.message));
  }
  const cardHistory = createCardHistory({
    store,
    cards: cardService,
    quietMs: options.cardHistoryQuietMs ?? Number(process.env.CARD_HISTORY_QUIET_SECONDS ?? 15) * 1000,
    maxMs: options.cardHistoryMaxMs ?? Number(process.env.CARD_HISTORY_MAX_SECONDS ?? 60) * 1000,
  });
  if (options.enableCardHistory ?? true) cardHistory.attach();
  const cardHistoryRoutes = createCardHistoryRoutes({ store, cards: cardService, cardHistory, helpers: { requireWorkspace, send, appFlowyResponse, now } });
  // Creates a library database template (its own database plus any databases it links to, see
  // database-template-plan.js) under `parentViewId`. Each database is created by its own atomic call, linked ones first,
  // so a replay of the same request finds the finished ones "already applied" and completes the rest. `derive` makes
  // every id deterministic per request. `embeddedViewIds` (original view ids) marks views shown inside a document.
  async function createTemplateDatabases({ access, template, parentViewId, derive, requestId, digest, timestamp, position, name, icon, extra, embedded = false, embeddedViewIds = [] }) {
    const baseMs = Date.parse(timestamp);
    const plans = planTemplateDatabases(template, derive);
    const showEmbedded = new Set(embeddedViewIds.filter((viewId) => template.views.some((view) => view.id === viewId)));

    if (embedded && !showEmbedded.size) showEmbedded.add(template.views[0].id);
    const buildPlanned = (plan) => {
      const { database: source, databaseId, containerId, viewIdMap, rowIdMap, primary } = plan;
      const linked = relinkTemplateDatabase(plan, plans);
      const markEmbedded = (view) => embedded && primary && showEmbedded.has(view.id);
      const collab = buildDatabaseCollabFromTemplate({
        databaseId, template: { ...linked, views: linked.views.map((view) => ({ ...view, embedded: markEmbedded(view) })) }, viewIdMap, rowIdMap, timestamp,
      });
      const rows = linked.rows.map((row) => {
        const rowId = rowIdMap.get(row.id);
        const rowCollab = createInitialDatabaseRowCollab({
          rowId,
          databaseId,
          cells: row.cells,
          height: row.height,
          visibility: row.visibility,
          timestamp,
          actorUid: access.user.uid,
        });
        return { rowId, documentState: rowCollab.documentState, stateVector: rowCollab.stateVector };
      });
      // Card bodies of the template's rows: each is the row's detail-page document, found by its derived id.
      const rowDocuments = linked.rows.filter((row) => row.document).map((row) => {
        const rowId = rowIdMap.get(row.id);
        const documentId = rowDocumentIdFromRowId(rowId);

        return {
          page: {
            id: documentId,
            workspace_id: access.workspace.id,
            parent_view_id: null,
            title: '',
            icon: null,
            extra: { row_document: { source: { database_id: databaseId, database_view_id: viewIdMap.get(source.views[0].id), row_id: rowId } } },
            is_favorite: false,
            document: {},
            schema_version: 'appflowy-document-v1',
            creator_id: access.user.id,
            version: 1,
            created_at: timestamp,
            updated_at: timestamp,
            position: { kind: 'start' },
          },
          collab: buildDocumentCollabFromTemplate({ documentId, document: row.document, pageIdMap: new Map() }),
        };
      });
      const containerPage = {
        id: containerId,
        workspace_id: access.workspace.id,
        parent_view_id: parentViewId,
        title: primary ? (name ?? source.name) : source.name,
        icon: primary ? (icon ?? source.icon ?? null) : (source.icon ?? null),
        extra: { is_database_container: true, database_id: databaseId, ...(embedded ? { embedded: true } : {}), ...(primary ? (extra ?? {}) : {}) },
        layout: FOLDER_LAYOUTS[source.views[0].layout],
        is_favorite: false,
        creator_id: access.user.id,
        version: 1,
        created_at: timestamp,
        updated_at: timestamp,
        position: primary ? position : { kind: 'end' },
      };
      const viewPages = source.views.map((view, index) => ({
        id: viewIdMap.get(view.id),
        workspace_id: access.workspace.id,
        parent_view_id: containerId,
        title: view.name,
        icon: null,
        extra: { database_id: databaseId, ...(markEmbedded(view) ? { embedded: true } : {}) },
        layout: FOLDER_LAYOUTS[view.layout],
        is_favorite: false,
        creator_id: access.user.id,
        version: 1,
        // Children sort by created_at; stagger so template view order is kept.
        created_at: new Date(baseMs + index).toISOString(),
        updated_at: timestamp,
        position: { kind: 'end' },
      }));
      return { containerPage, viewPages, databaseId, collab, rows, rowDocuments };
    };
    const created = [];

    for (const plan of [...plans.filter((candidate) => !candidate.primary), ...plans.filter((candidate) => candidate.primary)]) {
      const own = plan.primary ? { request_id: requestId, request_digest: digest } : { request_id: derive(`request:${plan.ref}`), request_digest: `${digest}:${plan.ref}` };

      created.push({ plan, result: await store.createDatabaseFromTemplate({ ...buildPlanned(plan), request: own }) });
    }
    const primary = created.find((entry) => entry.plan.primary);

    return {
      primaryResult: primary.result,
      primaryPlan: primary.plan,
      linked: created.filter((entry) => !entry.plan.primary).map((entry) => ({ name: entry.plan.database.name, ...entry.result.result })),
    };
  }
  const agentRoutes = createAgentRoutes({ store, cards: cardService, pageComments: () => pageComments, helpers: { requireWorkspace, send, appFlowyResponse, body, now } });
  // Search / read / write documents for agents (MCP) and workspace-aware answers (AI chat).
  const workspaceKnowledge = createWorkspaceKnowledge({ store, isReadableSpace: isSupportedPublicSpacePermission, cards: cardService });
  const pageWriter = createPageWriter({
    store,
    broadcast: (event) => broadcastCollabUpdate(event),
    isReadableSpace: isSupportedPublicSpacePermission,
    cards: cardService,
    ensureRowDocument: async ({ workspaceId, databaseId, rowId, actorUserId }) => ensureRowDocumentPage(
      store, { workspace: { id: workspaceId } }, { databaseId, databaseViewId: null, rowId, documentId: rowDocumentIdFromRowId(rowId), actorUserId },
    ),
  });
  const pageComments = createPageComments({
    store,
    broadcast: (event) => broadcastCollabUpdate(event),
    broadcastCommentChanged: (workspaceId, viewId) => broadcastCommentChanged(workspaceId, viewId),
    notify: (event) => notifyPageComment(event),
    isReadableSpace: isSupportedPublicSpacePermission,
    newId: () => id(),
    now,
  });
  // People who should hear about a comment an agent wrote on someone's behalf (same rules as the editor's own comments).
  async function notifyPageComment({ workspaceId, actorUserId, page, commentId, blockId, parentUserId }) {
    const [workspace, user] = await Promise.all([store.getWorkspace(workspaceId), store.getUserById(actorUserId)]);

    if (!workspace || !user) return;
    const access = { workspace, user };
    const recipients = new Map();

    if (parentUserId) recipients.set(parentUserId, 'comment_reply');
    if (page.creator_id && !recipients.has(page.creator_id)) recipients.set(page.creator_id, 'comment_on_page');
    const metadata = {
      actor_name: userLabel(user), page_name: page.title, page_path: await pageAncestorPath(store, workspace, page),
      ...(blockId ? { block_id: blockId } : {}), comment_id: commentId,
    };

    for (const [recipientId, type] of recipients) await createInboxNotification(access, { recipientId, type, viewId: page.id, metadata });
  }
  async function notifyCardComment({ workspaceId, actorUserId, card, commentId, parentUserId }) {
    if (!parentUserId) return;
    const [workspace, user, index, row] = await Promise.all([
      store.getWorkspace(workspaceId), store.getUserById(actorUserId), buildReadableIndex(store, { id: workspaceId }, isSupportedPublicSpacePermission), cardService.getCard({ workspaceId, cardId: card.id }),
    ]);
    const container = index.containers.get(row.database_id);

    if (!workspace || !user || !container) return;
    await createInboxNotification({ workspace, user }, {
      recipientId: parentUserId, type: 'comment_reply', viewId: container.id,
      metadata: { actor_name: userLabel(user), page_name: container.title, page_path: await pageAncestorPath(store, workspace, container), row_id: card.id, comment_id: commentId },
    });
  }
  const userNames = async (workspaceId, userIds) => {
    const users = await loadUsersById(store, userIds.filter(Boolean));

    return new Map([...users].filter(([, user]) => user).map(([userId, user]) => [userId, userLabel(user)]));
  };
  // /mcp is for non-browser agents: a present Origin header must be listed here (loopback is also accepted
  // when the server itself is bound to loopback). Deliberately separate from the web CORS allow-list.
  const mcpAllowedOrigins = options.mcpAllowedOrigins ?? (process.env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  const mcpHandler = createMcpHandler({
    cards: cardService,
    services: { knowledge: workspaceKnowledge, writer: pageWriter, pageComments, userNames, notifyCardComment },
    authenticate: createAgentAuthenticator({ store }),
    audit: (record) => {
      const { detail, token_name: tokenName, ...loggable } = record;

      logApiEvent({ kind: 'mcp_call', ...loggable });
      persistAgentActivity(record);
    },
    allowedOrigins: mcpAllowedOrigins,
    limits: options.mcpLimits ?? {},
  });
  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const parts = url.pathname.split('/').filter(Boolean); const method = req.method;
    res.__apiLog = { req, requestId: id(), method, path: url.pathname, query: url.search || undefined, startedAt: process.hrtime.bigint() };
    res.setHeader('X-Request-Id', res.__apiLog.requestId);
    // Mounted BEFORE the CORS/OPTIONS handling: no Access-Control-* headers are ever emitted for /mcp and a
    // browser preflight gets a 405, so a web page cannot call it cross-origin (the handler also checks Origin).
    if (url.pathname === '/mcp') {
      try {
        await mcpHandler(req, res);
      } catch (mcpError) {
        console.error('MCP handler failed', mcpError);
        if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
      }
      logApiResponse(res, res.statusCode, undefined);
      return;
    }
    applyCorsHeaders(req, res, corsAllowedOrigins);
    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204);
      res.end();
      logApiResponse(res, 204, undefined);
      return;
    }
    try {
      if (await aiRoutes.handle({ req, res, url, parts, method })) return;
      if (await workspaceOpsRoutes.handle({ req, res, url, parts, method })) return;
      if (await agentRoutes.handle({ req, res, url, parts, method })) return;
      if (await cardHistoryRoutes.handle({ req, res, url, parts, method })) return;
      if (await fileStorageRoutes.handle({ req, res, url, parts, method })) return;
      if (method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, storage_schema: store.state.schema_version });
      if (method === 'GET' && url.pathname === '/api/server-info') {
        return send(res, 200, appFlowyResponse({
          // The AppFlowy-Cloud API baseline this server speaks, not this project's own version. The web client shows a
          // "Requires server X or later" banner to every user when this is lower than its floor (0.18.10).
          version: process.env.SERVER_API_VERSION || '0.18.10',
          enable_page_history: options.enablePageHistory ?? config.enablePageHistory,
          enable_atomic_creation: true,
          enable_atomic_creation_defaults: true,
          self_hosted: true,
          ai_enabled: true,
          // No third-party integrations: an empty list is authoritative, so the client stops probing /api/integrations.
          connections: [],
          // The bulk row-seed endpoint (database blob/diff) is not implemented; the client then uses per-row sync.
          enable_database_blob_diff: false,
          // Per-card change history with restore (card-history.js).
          enable_card_history: true,
          // No groups, and no per-page sharing: every member of a workspace can open everything in it.
          enable_workspace_groups: false,
          enable_page_sharing: false,
          max_update_bytes: options.realtimeMaxUpdateBytes ?? REALTIME_MAX_UPDATE_BYTES,
        }));
      }
      // --- GoTrue-compatible account endpoints the web client talks to directly ---
      if (method === 'GET' && url.pathname === '/settings') {
        return send(res, 200, {
          external: { email: true, phone: false, google: false, github: false, apple: false, discord: false, azure: false, gitlab: false, bitbucket: false, facebook: false, twitter: false },
          disable_signup: !signupPolicy.enabled,
          mailer_autoconfirm: true,
          phone_autoconfirm: false,
          sms_provider: '',
        });
      }
      if (method === 'POST' && url.pathname === '/signup') {
        const b = await body(req);
        const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';

        if (!validateEmail(email) || !validatePassword(b.password)) {
          return goTrueError(res, 422, 'invalid_request', 'validation_failed', 'A valid email and a password of 8-200 characters are required');
        }
        const denied = await signupDenial(email);

        if (denied) return goTrueError(res, 403, 'signup_disabled', 'signup_disabled', denied);
        // GoTrue answers 200 with no identities for an address that already exists (no account enumeration).
        if (await store.getUserByEmail(email)) return send(res, 200, { id: id(), email, identities: [] });
        const user = { id: id(), uid: createNumericUserId(), email, password_hash: await hashPassword(b.password), created_at: now() };
        const { workspace, membership } = createWorkspaceForUser(user, 'My Workspace');

        membership.workspace_id = workspace.id;
        try {
          await store.createUserWithWorkspace(user, workspace, membership);
        } catch (e) {
          if (e.code === '23505' && e.constraint === 'users_email_key') return send(res, 200, { id: id(), email, identities: [] });
          throw e;
        }
        await acceptInvitationsFor(user);
        const issued = createGoTrueSession(user);

        await store.saveSession(tokenHash(issued.accessToken), issued.session);
        return send(res, 200, issued.response, { 'cache-control': 'no-store' });
      }
      if (url.pathname === '/user' && ['GET', 'PUT'].includes(method)) {
        const user = await requireUser(store, req, res);

        if (!user) return;
        if (method === 'PUT') {
          const b = await body(req);

          if (b.password !== undefined) {
            if (!validatePassword(b.password)) return goTrueError(res, 422, 'invalid_request', 'weak_password', 'Password must be 8-200 characters');
            await store.updateUserPassword(user.id, await hashPassword(b.password), tokenHash(bearer(req)));
          }
        }
        return send(res, 200, { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', created_at: user.created_at, app_metadata: { provider: 'email' }, user_metadata: {} });
      }
      // Tells the account settings whether this person has chosen a password themselves (everyone here has).
      if (method === 'GET' && url.pathname === '/user/auth-info') {
        const user = await requireUser(store, req, res);

        if (!user) return;
        return send(res, 200, { has_password: true, is_sso_user: false, is_non_default_password: true });
      }
      if (method === 'POST' && url.pathname === '/user/change-password') {
        const user = await requireUser(store, req, res);

        if (!user) return;
        const b = await body(req);

        if (!validatePassword(b.password)) return goTrueError(res, 422, 'invalid_request', 'weak_password', 'Password must be 8-200 characters');
        const passwordKeys = throttleKeys(req, user.email);
        const passwordGate = loginThrottle.check(passwordKeys);
        if (!passwordGate.allowed) return tooManyAttempts(res, passwordGate.retryAfterSeconds, true);
        if (typeof b.current_password !== 'string' || !await verifyPassword(b.current_password, user.password_hash)) {
          loginThrottle.fail(passwordKeys);
          return goTrueError(res, 400, 'invalid_grant', 'invalid_credentials', 'Current password is incorrect');
        }
        loginThrottle.clear([passwordKeys[0]]);
        await store.updateUserPassword(user.id, await hashPassword(b.password), tokenHash(bearer(req)));
        return send(res, 200, { code: 0, msg: 'ok' });
      }
      // Passwordless e-mail codes (GoTrue-compatible): /recover (forgotten password) and /magiclink (sign-in) e-mail a
      // 6-digit code; /verify exchanges it for a session. The answer never reveals whether an account exists.
      if (method === 'POST' && (url.pathname === '/recover' || url.pathname === '/magiclink')) {
        const type = url.pathname === '/recover' ? 'recovery' : 'magiclink';
        const b = await body(req);
        const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';

        if (!validateEmail(email)) return goTrueError(res, 422, 'invalid_request', 'validation_failed', 'A valid email is required');
        if (!mailer.enabled) return goTrueError(res, 400, 'email_provider_disabled', 'email_provider_disabled', 'E-mail is not set up on this server, so a code cannot be sent. Ask an administrator to reset your password.');
        const askKeys = [`ask:${clientAddress(req, trustProxy)}`];
        const askGate = loginThrottle.check(askKeys);

        if (!askGate.allowed) return tooManyAttempts(res, askGate.retryAfterSeconds, true);
        loginThrottle.fail(askKeys);
        const issued = authCodes.issue(email, type);

        if (issued.limited) return tooManyAttempts(res, issued.retryAfterSeconds, true);
        const user = await store.getUserByEmail(email);

        if (user) {
          const sent = await mailer.send({ to: email, ...codeEmail({ type, code: issued.code, minutes: 10 }) });

          if (!sent.sent && sent.reason === 'smtp_error') return goTrueError(res, 502, 'unexpected_failure', 'unexpected_failure', 'The e-mail could not be sent right now. Try again in a few minutes.');
        }
        return send(res, 200, {});
      }
      if (method === 'POST' && url.pathname === '/verify') {
        const b = await body(req);
        const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
        const type = b.type === 'recovery' ? 'recovery' : ['magiclink', 'email'].includes(b.type) ? 'magiclink' : null;

        if (!type || !validateEmail(email) || typeof b.token !== 'string') return goTrueError(res, 422, 'invalid_request', 'validation_failed', 'email, token and type are required');
        const keys = throttleKeys(req, `otp:${email}`);
        const gate = loginThrottle.check(keys);

        if (!gate.allowed) return tooManyAttempts(res, gate.retryAfterSeconds, true);
        const user = await store.getUserByEmail(email);

        if (!user || !authCodes.verify(email, type, b.token)) {
          loginThrottle.fail(keys);
          return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        }
        loginThrottle.clear([keys[0]]);
        const issued = createGoTrueSession(user);

        await store.saveSession(tokenHash(issued.accessToken), issued.session);
        return send(res, 200, issued.response, { 'cache-control': 'no-store' });
      }
      // One-click unsubscribe from notification e-mails (the link is signed per person).
      if (method === 'GET' && url.pathname === '/api/email/unsubscribe') {
        const userId = url.searchParams.get('u') ?? '';
        const provided = Buffer.from(url.searchParams.get('s') ?? '');
        const expected = Buffer.from(userId ? await signLink(userId) : '');
        const user = provided.length === expected.length && expected.length > 0 && timingSafeEqual(provided, expected) ? await store.getUserById(userId) : null;
        const page = (title, message) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px"><h2>${title}</h2><p>${message}</p></body>`;

        if (!user) {
          res.writeHead(400, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
          return res.end(page('Link not valid', 'This unsubscribe link is not valid.'));
        }
        await store.updateUserProfile(user.id, { metadata: { ...(user.metadata ?? {}), email_notifications: false } });
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
        return res.end(page('You are unsubscribed', 'You will no longer get notification e-mails from this workspace. Sign-in codes and invitations are still sent when you ask for them.'));
      }
      if (method === 'POST' && url.pathname === '/token') {
        const grantType = url.searchParams.get('grant_type');
        const b = await body(req);
        if (grantType === 'password') {
          if (typeof b.email !== 'string' || typeof b.password !== 'string' || !validateEmail(b.email.trim().toLowerCase()) || !validatePassword(b.password)) {
            return goTrueError(res, 400, 'invalid_request', 'validation_failed', 'Email and password are required');
          }
          const keys = throttleKeys(req, b.email.trim().toLowerCase());
          const gate = loginThrottle.check(keys);
          if (!gate.allowed) return tooManyAttempts(res, gate.retryAfterSeconds, true);
          const user = await store.getUserByEmail(b.email.trim().toLowerCase());
          if (!user || !await verifyPassword(b.password, user.password_hash)) {
            loginThrottle.fail(keys);
            return goTrueError(res, 400, 'invalid_grant', 'invalid_credentials', 'Invalid login credentials');
          }
          loginThrottle.clear([keys[0]]);
          const issued = createGoTrueSession(user);
          await store.saveSession(tokenHash(issued.accessToken), issued.session);
          return send(res, 200, issued.response, { 'cache-control': 'no-store' });
        }
        if (grantType === 'refresh_token') {
          if (typeof b.refresh_token !== 'string' || !b.refresh_token.trim()) {
            return goTrueError(res, 400, 'invalid_request', 'validation_failed', 'Refresh token is required');
          }
          const oldRefreshHash = tokenHash(b.refresh_token);
          const current = await store.getSessionByRefreshHash(oldRefreshHash);
          if (!current || current.refresh_expires_at <= now()) {
            return goTrueError(res, 400, 'invalid_grant', 'invalid_token', 'Invalid or expired refresh token');
          }
          const user = await store.getUserById(current.user_id);
          if (!user) {
            return goTrueError(res, 400, 'invalid_grant', 'invalid_token', 'Invalid or expired refresh token');
          }
          const issued = createGoTrueSession(user, current.refresh_expires_at);
          const rotated = await store.rotateSession(
            current.access_token_hash,
            tokenHash(issued.accessToken),
            oldRefreshHash,
            issued.session
          );
          if (!rotated) {
            return goTrueError(res, 400, 'invalid_grant', 'invalid_token', 'Invalid or expired refresh token');
          }
          return send(res, 200, issued.response, { 'cache-control': 'no-store' });
        }
        return goTrueError(res, 400, 'unsupported_grant_type', 'unsupported_grant_type', 'Supported grant types are password and refresh_token');
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'user' && parts[2] === 'verify' && parts.length === 4) {
        const user = await userByAccessToken(store, parts[3]);
        if (!user) return send(res, 401, { code: 401, message: 'User unauthorized' }, { 'cache-control': 'no-store' });
        return send(res, 200, appFlowyResponse({ is_new: false }), { 'cache-control': 'no-store' });
      }
      if (method === 'GET' && url.pathname === '/api/user/profile') {
        const user = await requireUser(store, req, res);
        if (!user) return;
        const workspaces = await store.listWorkspaces(user.id);
        return send(res, 200, appFlowyResponse({
          uid: user.uid?.toString() ?? user.id,
          uuid: user.id,
          email: user.email,
          name: user.name ?? null,
          metadata: user.metadata ?? {},
          encryption_sign: null,
          latest_workspace_id: workspaces[0]?.id ?? '',
          updated_at: Date.parse(user.created_at),
        }), { 'cache-control': 'private, no-store' });
      }
      // updateUserProfile() (user-api.ts) -- lets a user set their display
      // name and/or metadata (e.g. metadata.icon_url, read back by
      // getCurrentUser() as `avatar`). GET /api/user/profile above already
      // read these fields defensively; nothing ever wrote them until now.
      if (method === 'POST' && url.pathname === '/api/user/update') {
        const user = await requireUser(store, req, res);
        if (!user) return;
        const b = await body(req);
        const changes = {};

        if ('name' in b) {
          if (b.name !== null && typeof b.name !== 'string') return error(res, 400, 'INVALID_INPUT', 'name must be a string or null');
          if (typeof b.name === 'string' && b.name.length > 200) return error(res, 400, 'INVALID_INPUT', 'name must be at most 200 characters');
          changes.name = b.name;
        }

        if ('metadata' in b) {
          if (b.metadata !== null && !isPlainObject(b.metadata)) return error(res, 400, 'INVALID_INPUT', 'metadata must be an object or null');
          changes.metadata = b.metadata ?? {};
        }

        if (Object.keys(b).some((key) => !['name', 'metadata'].includes(key))) {
          return error(res, 400, 'INVALID_INPUT', 'Unsupported fields in user update request');
        }

        await store.updateUserProfile(user.id, changes);
        return send(res, 200, appFlowyResponse(null));
      }
      // getAuthProviders() (auth-api.ts), called on every visit to the login
      // page. The client already has a complete, already-correct fallback
      // for a failed fetch (just the password provider) -- this route was
      // simply never implemented, so every login paid for one guaranteed
      // failed request plus two console errors first.
      // Notion-style database templates: the catalog the "new page" menu's
      // Templates section renders. The library is static (templates/databases/,
      // generated by scripts/build-template-library.mjs), identical for everyone.
      if (method === 'GET' && url.pathname === '/api/template-catalog/database') {
        const user = await requireUser(store, req, res);
        if (!user) return;
        return send(res, 200, appFlowyResponse({ templates: listDatabaseTemplates() }));
      }
      if (method === 'GET' && url.pathname === '/api/template-catalog/document') {
        const user = await requireUser(store, req, res);
        if (!user) return;
        return send(res, 200, appFlowyResponse({ templates: listDocumentTemplates() }));
      }
      // --- Workspace search (Cmd+K modal, @ mention panel) and recent pages ---
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'search' && parts[2] && (parts.length === 3 || (parts.length === 4 && parts[3] === 'page'))) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        await searchReady();
        const readableIndex = await buildReadableIndex(store, access.workspace, isSupportedPublicSpacePermission);
        // The client's `score` parameter is advisory: every prefix match is returned and ranked.
        const result = await searchWorkspace(store, access.workspace, readableIndex, {
          query: (url.searchParams.get('query') ?? '').slice(0, 200),
          limit: url.searchParams.get('limit'),
          offset: url.searchParams.get('offset'),
          previewSize: url.searchParams.get('preview_size'),
        });

        return send(res, 200, appFlowyResponse(parts.length === 3 ? result.items : result), { 'cache-control': 'private, no-store' });
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'search' && parts[2] && parts[3] === 'summary' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        await body(req);
        return send(res, 200, appFlowyResponse({ summaries: [] }));
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'mentions' && parts[4] === 'search' && parts.length === 5) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const mentionRequest = await body(req);

        if ((mentionRequest.query !== undefined && typeof mentionRequest.query !== 'string') ||
            (mentionRequest.include !== undefined && !Array.isArray(mentionRequest.include))) {
          return error(res, 400, 'INVALID_INPUT', 'query must be a string and include must be a list');
        }
        await searchReady();
        const readableIndex = await buildReadableIndex(store, access.workspace, isSupportedPublicSpacePermission);
        const people = (await store.listWorkspaceMembers(access.workspace.id)).map(({ user, membership }) => mentionablePerson(user, membership));
        const result = await searchMentions(store, access.workspace, readableIndex, {
          people,
          request: { ...mentionRequest, query: (mentionRequest.query ?? '').slice(0, 200) },
        });

        return send(res, 200, appFlowyResponse(result), { 'cache-control': 'private, no-store' });
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'recent' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const recentIds = await store.getRecentPages(access.workspace.id, access.user.id);
        const readableIndex = await buildReadableIndex(store, access.workspace, isSupportedPublicSpacePermission);
        const noChildren = new Map();
        const views = recentIds
          .filter((pageId) => readableIndex.isReadable(pageId))
          .map((pageId) => pageViewNode(readableIndex.pagesById.get(pageId), access.workspace, noChildren, 0));

        return send(res, 200, appFlowyResponse({ views }), { 'cache-control': 'private, no-store' });
      }
      // Generic page creation, POST /api/workspace/{id}/page-view. The client falls back to it for layouts
      // that have no atomic "default" creation endpoint; the only one this backend supports is an AI chat
      // page (layout 4), a plain Folder entry whose messages live in the chat store, not in a collab.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'page-view' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const pageBody = await body(req);

        if (pageBody.layout !== 4) return error(res, 400, 'UNSUPPORTED_LAYOUT', 'Only AI chat pages can be created through this endpoint');
        const name = pageBody.name === undefined || pageBody.name === null ? 'New chat' : pageBody.name;
        const requestedId = pageBody.view_id === undefined || pageBody.view_id === null ? id() : pageBody.view_id;

        if (!validateUuid(pageBody.parent_view_id) || !validateUuid(requestedId) || typeof name !== 'string' || name.length === 0 || name.length > 200) {
          return error(res, 400, 'INVALID_INPUT', 'A parent space and a valid name are required');
        }
        const space = await store.getSpace(pageBody.parent_view_id);

        if (!space || space.workspace_id !== access.workspace.id || !isSupportedPublicSpacePermission(space.permission)) {
          return error(res, 403, 'SPACE_WRITE_FORBIDDEN', 'Page creation requires a supported public space in this workspace');
        }
        if (await store.getPage(requestedId)) return error(res, 409, 'PAGE_EXISTS', 'Page ID already exists');
        const timestamp = now();

        await store.createPage({
          id: requestedId,
          workspace_id: access.workspace.id,
          parent_view_id: space.id,
          title: name,
          icon: null,
          extra: null,
          layout: 4,
          is_favorite: false,
          document: {},
          schema_version: 'appflowy-ai-chat-v1',
          creator_id: access.user.id,
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          position: pageBody.prev_view_id ? { kind: 'after', view_id: pageBody.prev_view_id } : { kind: 'start' },
        });
        return send(res, 200, appFlowyResponse({ view_id: requestedId }));
      }
      // --- Workspace invite links (MembersPanel + the /app/invited/:code landing page) ---
      if (parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'invite-code' && parts.length === 4 &&
          ['GET', 'POST', 'DELETE'].includes(method)) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        if (!['owner', 'admin'].includes(access.membership.role)) {
          return error(res, 403, 'INVITE_CODE_FORBIDDEN', 'Only workspace owners and admins can manage the invite link');
        }
        if (method === 'GET') {
          const existing = await store.getWorkspaceInviteCode(access.workspace.id);

          return send(res, 200, appFlowyResponse({ code: existing?.code ?? null }), { 'cache-control': 'private, no-store' });
        }
        if (method === 'DELETE') {
          await store.deleteWorkspaceInviteCode(access.workspace.id);
          return send(res, 200, appFlowyResponse(null));
        }
        const inviteBody = await body(req);
        const hours = inviteBody.validity_period_hours ?? null;

        if (hours !== null && (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 365)) {
          return error(res, 400, 'INVALID_INPUT', 'validity_period_hours must be a positive number of hours (at most one year) or null');
        }
        let code;

        do { code = generateInviteCode(); } while (await store.findWorkspaceInviteCodeByCode(code));
        const createdAt = now();

        await store.setWorkspaceInviteCode({
          workspaceId: access.workspace.id,
          code,
          createdBy: access.user.id,
          createdAt,
          expiresAt: hours === null ? null : new Date(Date.parse(createdAt) + hours * 3600000).toISOString(),
        });
        return send(res, 200, appFlowyResponse({ code }));
      }
      if (method === 'POST' && url.pathname === '/api/workspace/join-by-invite-code') {
        const user = await requireUser(store, req, res);
        if (!user) return;
        const joinBody = await body(req);
        const codeKeys = [`code:${user.id}`];
        const codeGate = loginThrottle.check(codeKeys);

        if (!codeGate.allowed) return tooManyAttempts(res, codeGate.retryAfterSeconds);
        const record = typeof joinBody.code === 'string' ? await store.findWorkspaceInviteCodeByCode(joinBody.code.trim()) : null;
        const workspace = record && await store.getWorkspace(record.workspace_id);

        if (!workspace) { loginThrottle.fail(codeKeys); return invalidInvitationCode(res); }
        if (!(await store.getMembership(workspace.id, user.id))) {
          await store.saveMembership({ workspace_id: workspace.id, user_id: user.id, role: 'member', created_at: now() });
        }
        return send(res, 200, appFlowyResponse({ workspace_id: workspace.id }));
      }
      if (method === 'GET' && url.pathname === '/api/invite-code-info') {
        const user = await requireUser(store, req, res);
        if (!user) return;
        const code = (url.searchParams.get('code') ?? '').trim();
        const codeKeys = [`code:${user.id}`];
        const codeGate = loginThrottle.check(codeKeys);

        if (!codeGate.allowed) return tooManyAttempts(res, codeGate.retryAfterSeconds);
        const record = code ? await store.findWorkspaceInviteCodeByCode(code) : null;
        const workspace = record && await store.getWorkspace(record.workspace_id);

        if (!workspace) { loginThrottle.fail(codeKeys); return invalidInvitationCode(res); }
        const owner = await store.getUserById(workspace.owner_id);
        const ownerPerson = owner ? mentionablePerson(owner, await store.getMembership(workspace.id, owner.id)) : null;

        return send(res, 200, appFlowyResponse({
          workspace_id: workspace.id,
          workspace_name: workspace.name,
          workspace_icon_url: workspace.icon ?? '',
          owner_name: ownerPerson?.name ?? '',
          owner_avatar: ownerPerson?.avatar_url ?? '',
          is_member: !!(await store.getMembership(workspace.id, user.id)),
          member_count: (await store.listWorkspaceMembers(workspace.id)).length,
        }), { 'cache-control': 'private, no-store' });
      }
      // --- Workspace members list and the caller's own per-workspace profile ---
      // One member's display profile (name, email, avatar); the AI chat uses it for message authors.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] === 'v1' && parts[3] && parts[4] === 'member' &&
          parts[5] === 'user' && parts[6] && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[3]);
        if (!access) return;
        const memberUser = validateUuid(parts[6]) ? await store.getUserById(parts[6]) : null;
        const memberRecord = memberUser && await store.getMembership(access.workspace.id, memberUser.id);

        if (!memberUser || !memberRecord) return error(res, 404, 'MEMBER_NOT_FOUND', 'Member not found');
        const person = mentionablePerson(memberUser, memberRecord);

        return send(res, 200, appFlowyResponse({ name: person.name, email: person.email, avatar_url: person.avatar_url ?? '' }), { 'cache-control': 'private, no-store' });
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'member' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const members = (await store.listWorkspaceMembers(access.workspace.id))
          .map(({ user, membership }) => ({ person: mentionablePerson(user, membership), membership }))
          .sort((left, right) => (left.membership.role === 'owner' ? 0 : 1) - (right.membership.role === 'owner' ? 0 : 1) ||
            String(left.membership.created_at).localeCompare(String(right.membership.created_at)))
          .map(({ person, membership }) => ({
            uid: String(person.uid),
            name: person.name,
            email: person.email,
            avatar_url: person.avatar_url ?? '',
            role: membership.role === 'owner' ? 'Owner' : 'Member',
            joined_at: membership.created_at,
            is_pending_invitation: false,
          }));

        if (url.searchParams.get('include_pending') === 'true' || url.searchParams.get('include_pending') === '1') {
          for (const invitation of await store.listWorkspaceInvitations(access.workspace.id)) {
            members.push({
              // Pending people have no account id yet: a stable, clearly out-of-range number keeps list keys unique.
              uid: String(9_000_000_000_000 + (parseInt(createHash('sha256').update(invitation.id).digest('hex').slice(0, 8), 16) % 1_000_000_000)),
              name: invitation.email,
              email: invitation.email,
              avatar_url: '',
              role: 'Member',
              joined_at: invitation.created_at,
              is_pending_invitation: true,
            });
          }
        }
        return send(res, 200, appFlowyResponse(members), { 'cache-control': 'private, no-store' });
      }
      if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'update-member-profile' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const profileBody = await body(req);
        const limits = { name: 200, avatar_url: 2048, cover_image_url: 2048, custom_image_url: 2048, description: 1000 };

        if (Object.keys(profileBody).some((key) => !(key in limits))) {
          return error(res, 400, 'INVALID_INPUT', 'Unsupported fields in member profile update');
        }
        for (const [key, max] of Object.entries(limits)) {
          const value = profileBody[key];

          if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > max)) {
            return error(res, 400, 'INVALID_INPUT', `${key} must be a string of at most ${max} characters`);
          }
        }
        if (typeof profileBody.name !== 'string' || profileBody.name.trim().length === 0) {
          return error(res, 400, 'INVALID_INPUT', 'name is required');
        }
        // Omitted fields keep their stored value; an empty string clears one.
        const next = { ...(isPlainObject(access.membership.profile) ? access.membership.profile : {}) };

        for (const key of Object.keys(limits)) {
          if (profileBody[key] !== undefined) next[key] = key === 'name' ? profileBody[key].trim() : (profileBody[key] ?? '');
        }
        await store.updateMembershipProfile(access.workspace.id, access.user.id, next);
        return send(res, 200, appFlowyResponse(null));
      }
      if (method === 'GET' && url.pathname === '/api/server-info/auth-providers') {
        return send(res, 200, appFlowyResponse({
          count: 1,
          providers: ['password'],
          signup_disabled: false,
          mailer_autoconfirm: true,
        }));
      }
      // parseServerErrorCatalog() (server-error-catalog.ts) -- an optional
      // overlay mapping numeric Cloud error codes to localized copy. This
      // server already returns human-readable `message` strings directly in
      // every error body, which the client falls back to when this catalog
      // is unavailable, so a minimal-but-valid catalog (not empty: the
      // parser requires at least one reason) is enough to stop the
      // unconditional per-load fetch-and-fail.
      if (method === 'GET' && url.pathname === '/api/error-messages') {
        return send(res, 200, appFlowyResponse({
          schema_version: 1,
          locale: 'en',
          reasons: { UNKNOWN: 'Something went wrong. Please try again.' },
          codes: {},
        }));
      }
      if (method === 'GET' && url.pathname === '/api/user/workspace') {
        const user = await requireUser(store, req, res);
        if (!user) return;
        const rows = await store.listWorkspaceBootstrapRows(user.id);
        if (rows.length === 0) return error(res, 404, 'NO_WORKSPACE', 'The authenticated user has no workspace');
        const workspaces = rows.map((row) => appFlowyWorkspace(row, user));
        return send(res, 200, appFlowyResponse({
          user_profile: { uuid: user.id },
          visiting_workspace: workspaces[0],
          workspaces,
        }), { 'cache-control': 'private, no-store' });
      }
      // Every user already gets a workspace at registration
      // (createWorkspaceForUser, below), and both storage backends already
      // fully implement multi-workspace storage (store.createWorkspace,
      // store.listWorkspaceBootstrapRows) -- this was a genuine gap in the
      // HTTP surface only: AppFlowy-Web's workspace-api.ts createWorkspace()/
      // getWorkspaces() had no matching route at all, so "Create workspace"
      // in the workspace switcher 404'd outright.
      if (method === 'GET' && url.pathname === '/api/workspace' && parts.length === 2) {
        const user = await requireUser(store, req, res);
        if (!user) return;
        const rows = await store.listWorkspaceBootstrapRows(user.id);
        return send(res, 200, appFlowyResponse(rows.map((row) => appFlowyWorkspace(row, user))), { 'cache-control': 'private, no-store' });
      }
      if (method === 'POST' && url.pathname === '/api/workspace' && parts.length === 2) {
        const user = await requireUser(store, req, res);
        if (!user) return;
        const b = await body(req);
        const name = String(b.workspace_name || '').trim();
        if (!name || name.length > 200) return error(res, 400, 'INVALID_INPUT', 'A valid workspace_name (1-200 characters) is required');
        const { workspace, membership } = createWorkspaceForUser(user, name);
        membership.workspace_id = workspace.id;
        await store.createWorkspace(workspace, membership);
        return send(res, 201, appFlowyResponse({ workspace_id: workspace.id }));
      }
      // AppFlowy-Web's workspace switcher calls this immediately after
      // switching to (or creating) a workspace (workspace-api.ts
      // openWorkspace()) -- without it, GET /api/user/workspace's
      // visiting_workspace always reported the user's first-ever
      // workspace, so a newly created one would exist but never actually
      // become the active one in the UI.
      if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'open' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        await store.markWorkspaceVisited(access.user.id, access.workspace.id);
        return send(res, 200, appFlowyResponse(null));
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'spaces' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const b = await body(req);
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        const spaceIcon = typeof b.space_icon === 'string' ? b.space_icon : '';
        const spaceIconColor = typeof b.space_icon_color === 'string' ? b.space_icon_color : '';
        const spaceId = b.view_id ?? id();
        if (!name || name.length > 200 || spaceIcon.length > 500 || spaceIconColor.length > 128 || !validateUuid(spaceId)) {
          return error(res, 400, 'INVALID_SPACE', 'A valid space name and UUID view_id are required');
        }
        if (!isSupportedPublicSpacePermission(b.permission)) {
          return error(res, 400, 'UNSUPPORTED_SPACE_PERMISSION', 'Only the checked-in frontend default public-space permission is supported');
        }
        const matchesExisting = (existing) => existing &&
          existing.workspace_id === access.workspace.id &&
          existing.creator_id === access.user.id &&
          existing.name === name &&
          existing.space_icon === spaceIcon &&
          existing.space_icon_color === spaceIconColor;
        const existing = await store.getSpace(spaceId);
        if (existing) {
          if (!matchesExisting(existing)) return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Space ID already exists');
          return send(res, 200, appFlowyResponse({ view_id: existing.id }));
        }
        const space = {
          id: spaceId,
          workspace_id: access.workspace.id,
          name,
          space_icon: spaceIcon,
          space_icon_color: spaceIconColor,
          permission: b.permission,
          creator_id: access.user.id,
          created_at: now(),
        };
        try {
          await store.createSpace(space);
        } catch (e) {
          if (e.code === '23505' || e.code === 'SPACE_EXISTS') {
            const raced = await store.getSpace(spaceId);
            if (matchesExisting(raced)) return send(res, 200, appFlowyResponse({ view_id: raced.id }));
            return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Space ID already exists');
          }
          throw e;
        }
        return send(res, 200, appFlowyResponse({ view_id: space.id }));
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'v2' &&
          parts[4] === 'page-view' && parts[5] === 'document' && parts[6] === 'default' && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const request = await body(req);
        const requestId = request.request_id;
        const viewId = request.view_id;
        const parentViewId = request.parent_view_id;
        const name = request.name;
        const position = request.position ?? { kind: 'start' };
        if (request.schema_version !== 'v1' || !validateUuid(requestId) || !validateUuid(viewId) ||
            !validateUuid(parentViewId) || typeof name !== 'string' || name.length > 200 ||
            !position || typeof position !== 'object' || Array.isArray(position) ||
              !['start', 'end'].includes(position.kind) ||
              (request.icon !== undefined && request.icon !== null && (typeof request.icon !== 'object' || Array.isArray(request.icon))) ||
              (request.extra !== undefined && request.extra !== null && (typeof request.extra !== 'object' || Array.isArray(request.extra))) ||
              (request.is_favorite !== undefined && typeof request.is_favorite !== 'boolean')) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'A valid v1 default Document request is required');
        }
        if (Object.keys(request).some((key) => !['schema_version', 'request_id', 'view_id', 'parent_view_id', 'name', 'position', 'icon', 'extra', 'is_favorite'].includes(key))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Unsupported fields in default Document request');
        }
        const space = await store.getSpace(parentViewId);
        if (!(await isWritableCreationParent(store, access.workspace.id, parentViewId, space))) {
          return error(res, 403, 'SPACE_WRITE_FORBIDDEN', 'Page creation requires a supported public space or a document page in this workspace');
        }
        const rawBody = req.rawBody ?? '';
        const digest = createHash('sha256').update(rawBody).digest('hex');
        const timestamp = now();
        const collab = createInitialPageCollab(viewId);
        const page = {
          id: viewId,
          workspace_id: access.workspace.id,
          parent_view_id: parentViewId,
          title: name,
          icon: request.icon ?? null,
          extra: request.extra ?? null,
          is_favorite: request.is_favorite === true,
          document: {},
          schema_version: 'appflowy-document-v1',
          creator_id: access.user.id,
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          position,
        };
        try {
          const created = await store.createAtomicDocumentPage(page, collab, {
            request_id: requestId,
            request_digest: digest,
          });
          return send(res, 200, appFlowyResponse({ request_id: requestId, ...created }));
        } catch (creationError) {
          if (creationError.code === 'REQUEST_ID_REUSED') return error(res, 409, 'REQUEST_ID_REUSED', creationError.message);
          if (creationError.code === 'PAGE_EXISTS' || creationError.code === '23505') {
            return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Page ID already exists');
          }
          throw creationError;
        } finally {
          collab.documentState.fill(0);
          collab.stateVector.fill(0);
        }
      }
      // Task 73: materializes a row-detail-page Document as an "orphaned" Folder-tree
      // page (no parent_view_id/Space) so it can be favorited/trashed/restored through
      // the ordinary page-view APIs above, and so its Document (collabType=0) WS sync
      // is admitted. Contract verified against AppFlowy-Web's view-api.ts
      // createOrphanedView()/lifecycle.ts ensureRowDocumentView(): POST body is
      // { document_id, row_document_source?: { database_id, database_view_id, row_id } },
      // response data is the raw doc_state byte array (Vec<u8>), not wrapped in an object.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'orphaned-view' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const b = await body(req);
        const documentId = b.document_id;
        const source = b.row_document_source;
        if (!validateUuid(documentId)) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'A valid document_id is required');
        }
        let extra = null;
        if (source !== undefined) {
          if (!source || typeof source !== 'object' || Array.isArray(source) ||
              typeof source.database_id !== 'string' || typeof source.database_view_id !== 'string' ||
              typeof source.row_id !== 'string') {
            return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'row_document_source must carry database_id, database_view_id and row_id');
          }
          if (rowDocumentIdFromRowId(source.row_id) !== documentId) {
            return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'document_id does not match the derived id for row_id');
          }
          extra = { row_document: { source: { database_id: source.database_id, database_view_id: source.database_view_id, row_id: source.row_id } } };
        }
        const existingPage = await store.getPage(documentId);
        if (existingPage && existingPage.workspace_id === access.workspace.id) {
          const existingCollab = await store.getPageCollab(access.workspace.id, documentId);
          if (existingCollab) return send(res, 200, appFlowyResponse(Array.from(existingCollab.doc_state)));
        }
        const timestamp = now();
        const collab = createInitialPageCollab(documentId);
        const page = {
          id: documentId,
          workspace_id: access.workspace.id,
          parent_view_id: null,
          title: '',
          icon: null,
          extra,
          is_favorite: false,
          document: {},
          schema_version: 'appflowy-document-v1',
          creator_id: access.user.id,
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          position: { kind: 'start' },
        };
        try {
          const requestId = id();
          await store.createAtomicDocumentPage(page, collab, {
            request_id: requestId,
            request_digest: createHash('sha256').update(`${documentId}:${access.workspace.id}`).digest('hex'),
          });
          return send(res, 200, appFlowyResponse(Array.from(collab.documentState)));
        } catch (creationError) {
          if (creationError.code === 'PAGE_EXISTS' || creationError.code === '23505') {
            const racedCollab = await store.getPageCollab(access.workspace.id, documentId);
            if (racedCollab) return send(res, 200, appFlowyResponse(Array.from(racedCollab.doc_state)));
            return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Page ID already exists');
          }
          throw creationError;
        } finally {
          collab.documentState.fill(0);
          collab.stateVector.fill(0);
        }
      }
      // Task 73: existence probe for ViewService.checkCollabExists()/rowDocumentExists() —
      // used by the frontend to decide whether a row's "Delete" action should soft-delete
      // (trash, restorable) or remove outright (non-restorable). Response is { exists }.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'collab' && parts[4] && parts[5] === 'collab-exists' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const objectId = parts[4];
        const page = await store.getPage(objectId);
        const exists = !!page && page.workspace_id === access.workspace.id &&
          !!(await store.getPageCollab(access.workspace.id, objectId));
        return send(res, 200, appFlowyResponse({ exists }));
      }
      // Task 61 (Phase 1 Grid database foundation), generalized: default
      // Database creation, mirroring the document/default route immediately
      // above it. Contract verified directly against AppFlowy-Web
      // src/application/services/js-services/http/page-default-creation.ts
      // (prepareDefaultPage, DATABASE_LAYOUTS) and atomic-creation/types.ts
      // (CreateDefaultDatabasePageRequest) -- the frontend never sends
      // field/view definitions, only identity + placement; the server alone
      // owns the initial Database shape (see database-document.js).
      // Originally Grid-only; now accepts every layout
      // SUPPORTED_ADDITIONAL_VIEW_LAYOUTS already supports for a second+
      // view (Task 72), since buildView (database-document.js) builds a
      // database's first/primary view with the exact same per-layout recipe
      // -- Form (layout=7) remains excluded (its companion "Responses" view
      // is a distinct, larger feature, see that export's doc comment).
      // `timezone_id` is a real IANA string (not null) for Calendar/Timeline
      // per page-default-creation.ts's `timezone_id: [Calendar,
      // Timeline].includes(layout) ? timezone : null` -- validated here but,
      // like the additional-view endpoint's identical rule, never stored
      // (no per-view timezone field exists in the Yjs shape).
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'v2' &&
          parts[4] === 'page-view' && parts[5] === 'database' && parts[6] === 'default' && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const request = await body(req);
        const requestId = request.request_id;
        const containerId = request.container_id;
        const parentViewId = request.parent_view_id;
        const name = request.name;
        const position = request.position ?? { kind: 'start' };
        const database = request.database;
        const validDatabaseOptions = database && typeof database === 'object' && !Array.isArray(database) &&
          validateUuid(database.database_id) && validateUuid(database.view_id) &&
          typeof database.name === 'string' && database.name.length > 0 && database.name.length <= 200 &&
          Number.isInteger(database.layout) && SUPPORTED_ADDITIONAL_VIEW_LAYOUTS.includes(database.layout) &&
          // The real frontend derives this from view/document context (see
          // AppFlowy-Web dispatch.ts's `isEmbeddedView`/`isDocumentBlock`
          // logic). The value is never actually used downstream (the
          // created primary view's own `embedded` flag is always hardcoded
          // false in buildView), so only its type need be checked, matching
          // the additional-view endpoint's existing rule below.
          typeof database.embedded === 'boolean' &&
          database.responses_view_id === null &&
          Array.isArray(database.initial_row_ids) && database.initial_row_ids.every((rowId) => validateUuid(rowId)) &&
          (database.timezone_id === null || database.timezone_id === undefined || typeof database.timezone_id === 'string');
        if (request.schema_version !== 'v1' || !validateUuid(requestId) || !validateUuid(containerId) ||
            !validateUuid(parentViewId) || typeof name !== 'string' || name.length > 200 ||
            !position || typeof position !== 'object' || Array.isArray(position) ||
              !['start', 'end'].includes(position.kind) ||
              (request.icon !== undefined && request.icon !== null && (typeof request.icon !== 'object' || Array.isArray(request.icon))) ||
              (request.extra !== undefined && request.extra !== null && (typeof request.extra !== 'object' || Array.isArray(request.extra))) ||
              (request.is_favorite !== undefined && typeof request.is_favorite !== 'boolean') ||
              !validDatabaseOptions) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'A valid v1 default Database request is required');
        }
        if (Object.keys(request).some((key) => !['schema_version', 'request_id', 'container_id', 'parent_view_id', 'name', 'position', 'icon', 'extra', 'is_favorite', 'database'].includes(key)) ||
            Object.keys(database).some((key) => !['database_id', 'view_id', 'name', 'layout', 'embedded', 'responses_view_id', 'initial_row_ids', 'timezone_id'].includes(key))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Unsupported fields in default Database request');
        }
        const space = await store.getSpace(parentViewId);
        if (!(await isWritableCreationParent(store, access.workspace.id, parentViewId, space))) {
          return error(res, 403, 'SPACE_WRITE_FORBIDDEN', 'Database creation requires a supported public space or a document page in this workspace');
        }
        const rawBody = req.rawBody ?? '';
        const digest = createHash('sha256').update(rawBody).digest('hex');
        const timestamp = now();
        const primaryFieldId = id();
        const collab = createInitialDatabaseCollab({
          databaseId: database.database_id,
          viewId: database.view_id,
          name: database.name,
          primaryFieldId,
          timestamp,
          layout: database.layout,
        });
        // The Folder-tree sidebar entry for the database, mapped through
        // FOLDER_LAYOUTS (Folder-side ViewLayout, distinct from
        // DatabaseViewLayout on the Database object's own view -- see
        // AppFlowy-Web types.ts) -- the same mapping the additional-view
        // route below already uses for every layout past the first.
        const containerPage = {
          id: containerId,
          workspace_id: access.workspace.id,
          parent_view_id: parentViewId,
          title: name,
          icon: request.icon ?? null,
          extra: { is_database_container: true, database_id: database.database_id },
          layout: FOLDER_LAYOUTS[database.layout],
          is_favorite: request.is_favorite === true,
          creator_id: access.user.id,
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          position,
        };
        // The Folder-tree child entry for the database's own primary/inline
        // view, required by AppFlowy-Web's validateDatabase() (see
        // created-page-hydration.ts): it looks up this child by
        // `database.view_id` under the container and checks its Folder
        // `layout` against the Database view's own `layout` via a fixed
        // DatabaseViewLayout -> ViewLayout mapping (FOLDER_LAYOUTS).
        const primaryViewPage = {
          id: database.view_id,
          workspace_id: access.workspace.id,
          parent_view_id: containerId,
          title: database.name,
          icon: null,
          extra: { database_id: database.database_id },
          layout: FOLDER_LAYOUTS[database.layout],
          is_favorite: false,
          creator_id: access.user.id,
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          position: { kind: 'start' },
        };
        try {
          const created = await store.createAtomicDatabasePage(containerPage, primaryViewPage, database.database_id, collab, {
            request_id: requestId,
            request_digest: digest,
          });
          return send(res, 200, appFlowyResponse({ request_id: requestId, ...created }));
        } catch (creationError) {
          if (creationError.code === 'REQUEST_ID_REUSED') return error(res, 409, 'REQUEST_ID_REUSED', creationError.message);
          if (creationError.code === 'PAGE_EXISTS' || creationError.code === 'DATABASE_EXISTS' || creationError.code === '23505') {
            return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Database or page ID already exists');
          }
          throw creationError;
        } finally {
          collab.documentState.fill(0);
          collab.stateVector.fill(0);
        }
      }
      // Creates a document template's page (and its whole sub-page tree) as a
      // child of one of the caller's Spaces. Same envelope/validation/
      // idempotency model as document/default above; the server owns every
      // generated id, derived from request_id so a replay is a no-op.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'v2' &&
          parts[4] === 'page-view' && parts[5] === 'document' && parts[6] === 'from-template' && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const request = await body(req);
        const requestId = request.request_id;
        const parentViewId = request.parent_view_id;
        const position = request.position ?? { kind: 'start' };
        if (request.schema_version !== 'v1' || !validateUuid(requestId) || !validateUuid(parentViewId) ||
            typeof request.template_id !== 'string' || request.template_id.length === 0 || request.template_id.length > 100 ||
            (request.name !== undefined && (typeof request.name !== 'string' || request.name.length === 0 || request.name.length > 200)) ||
            !position || typeof position !== 'object' || Array.isArray(position) || !['start', 'end'].includes(position.kind) ||
            (request.icon !== undefined && request.icon !== null && (typeof request.icon !== 'object' || Array.isArray(request.icon))) ||
            (request.extra !== undefined && request.extra !== null && (typeof request.extra !== 'object' || Array.isArray(request.extra)))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'A valid v1 template Document request is required');
        }
        if (Object.keys(request).some((key) => !['schema_version', 'request_id', 'template_id', 'parent_view_id', 'name', 'position', 'icon', 'extra'].includes(key))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Unsupported fields in template Document request');
        }
        const template = getDocumentTemplate(request.template_id);
        if (!template) return error(res, 404, 'TEMPLATE_NOT_FOUND', 'Document template not found');
        const space = await store.getSpace(parentViewId);
        if (!(await isWritableCreationParent(store, access.workspace.id, parentViewId, space))) {
          return error(res, 403, 'SPACE_WRITE_FORBIDDEN', 'Page creation requires a supported public space or a document page in this workspace');
        }
        const digest = createHash('sha256').update(req.rawBody ?? '').digest('hex');
        const timestamp = now();
        const baseMs = Date.parse(timestamp);
        const flat = [];
        const walk = (node, parentOldId) => {
          flat.push({ node, parentOldId });
          for (const child of node.children) walk(child, node.id);
        };
        walk(template.pages, null);
        const pageIdMap = new Map(flat.map(({ node }) => [node.id, deriveUuid(requestId, `page:${node.id}`)]));
        // Databases embedded in the page: each is created under the new page, and the block that shows it is pointed at
        // the new database and view ids (the template file holds the original ones).
        const embedded = (template.embedded_databases ?? []).map((embed) => {
          const embedDerive = (label) => deriveUuid(requestId, `emb:${embed.block_id}:${label}`);

          return { embed, embedDerive, plan: planTemplateDatabases(embed.database, embedDerive).find((candidate) => candidate.primary) };
        });
        const documentFor = (node) => {
          if (node !== template.pages || !embedded.length) return node.document;
          const document = structuredClone(node.document);

          for (const { embed, plan } of embedded) {
            const block = document.blocks[embed.block_id];

            if (!block) continue;
            const mapped = embed.view_ids.map((viewId) => plan.viewIdMap.get(viewId)).filter(Boolean);
            const shown = mapped.length ? mapped : [plan.viewIdMap.get(embed.database.views[0].id)];

            block.data = { ...block.data, parent_id: pageIdMap.get(template.pages.id), view_ids: shown, view_id: shown[0], database_id: plan.databaseId };
          }
          return document;
        };
        const entries = flat.map(({ node, parentOldId }, index) => {
          const pageId = pageIdMap.get(node.id);
          const isRoot = parentOldId === null;
          return {
            page: {
              id: pageId,
              workspace_id: access.workspace.id,
              parent_view_id: isRoot ? parentViewId : pageIdMap.get(parentOldId),
              title: isRoot ? (request.name ?? node.name) : node.name,
              icon: isRoot ? (request.icon ?? node.icon ?? null) : (node.icon ?? null),
              extra: isRoot ? (request.extra ?? null) : null,
              is_favorite: false,
              document: {},
              schema_version: 'appflowy-document-v1',
              creator_id: access.user.id,
              version: 1,
              // Children sort by created_at; stagger so template order is kept.
              created_at: new Date(baseMs + index).toISOString(),
              updated_at: timestamp,
              position: isRoot ? position : { kind: 'end' },
            },
            collab: buildDocumentCollabFromTemplate({ documentId: pageId, document: documentFor(node), pageIdMap }),
          };
        });
        try {
          const created = await store.createDocumentTreeFromTemplate({
            entries,
            request: { request_id: requestId, request_digest: digest },
          });
          const databases = [];

          for (const { embed, embedDerive } of embedded) {
            const made = await createTemplateDatabases({
              access, template: embed.database, parentViewId: pageIdMap.get(template.pages.id), derive: embedDerive,
              requestId: embedDerive('request'), digest: `${digest}:emb:${embed.block_id}`, timestamp,
              position: { kind: 'end' }, name: embed.name, icon: embed.icon, embedded: true, embeddedViewIds: embed.view_ids,
            });

            databases.push({ block_id: embed.block_id, ...made.primaryResult.result, ...(made.linked.length ? { related: made.linked } : {}) });
          }
          return send(res, 200, appFlowyResponse({ request_id: requestId, ...created, ...(databases.length ? { embedded_databases: databases } : {}) }));
        } catch (creationError) {
          if (creationError.code === 'REQUEST_ID_REUSED') return error(res, 409, 'REQUEST_ID_REUSED', creationError.message);
          if (creationError.code === 'PAGE_EXISTS' || creationError.code === '23505') {
            return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Page ID already exists');
          }
          throw creationError;
        }
      }
      // Creates a complete database (fields, views and sample rows) from a
      // static library template, as a child of one of the caller's Spaces.
      // Same envelope/validation/idempotency model as database/default above,
      // except the server owns every generated id (the client cannot know how
      // many views/rows a template has). Ids are derived from request_id so a
      // replayed request resolves to exactly the objects the first call made.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'v2' &&
          parts[4] === 'page-view' && parts[5] === 'database' && parts[6] === 'from-template' && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const request = await body(req);
        const requestId = request.request_id;
        const parentViewId = request.parent_view_id;
        const position = request.position ?? { kind: 'start' };
        if (request.schema_version !== 'v1' || !validateUuid(requestId) || !validateUuid(parentViewId) ||
            typeof request.template_id !== 'string' || request.template_id.length === 0 || request.template_id.length > 100 ||
            (request.name !== undefined && (typeof request.name !== 'string' || request.name.length === 0 || request.name.length > 200)) ||
            !position || typeof position !== 'object' || Array.isArray(position) || !['start', 'end'].includes(position.kind) ||
            (request.icon !== undefined && request.icon !== null && (typeof request.icon !== 'object' || Array.isArray(request.icon))) ||
            (request.extra !== undefined && request.extra !== null && (typeof request.extra !== 'object' || Array.isArray(request.extra)))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'A valid v1 template Database request is required');
        }
        if (Object.keys(request).some((key) => !['schema_version', 'request_id', 'template_id', 'parent_view_id', 'name', 'position', 'icon', 'extra'].includes(key))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Unsupported fields in template Database request');
        }
        const template = getDatabaseTemplate(request.template_id);
        if (!template) return error(res, 404, 'TEMPLATE_NOT_FOUND', 'Database template not found');
        const space = await store.getSpace(parentViewId);
        if (!(await isWritableCreationParent(store, access.workspace.id, parentViewId, space))) {
          return error(res, 403, 'SPACE_WRITE_FORBIDDEN', 'Database creation requires a supported public space or a document page in this workspace');
        }
        const derive = (label) => deriveUuid(requestId, label);
        const digest = createHash('sha256').update(req.rawBody ?? '').digest('hex');

        try {
          const made = await createTemplateDatabases({
            access, template, parentViewId, derive, requestId, digest, timestamp: now(),
            position, name: request.name, icon: request.icon, extra: request.extra,
          });

          return send(res, 200, appFlowyResponse({ request_id: requestId, ...made.primaryResult, ...(made.linked.length ? { related: made.linked } : {}) }));
        } catch (creationError) {
          if (creationError.code === 'REQUEST_ID_REUSED') return error(res, 409, 'REQUEST_ID_REUSED', creationError.message);
          if (creationError.code === 'PAGE_EXISTS' || creationError.code === 'DATABASE_EXISTS' || creationError.code === '23505') {
            return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Database or page ID already exists');
          }
          throw creationError;
        }
      }
      // Task 72 (database views): additional database-view creation. The
      // one confirmed backend gap found by this task's discovery (see
      // docs/TASK72_DATABASE_VIEWS_DISCOVERY.md) -- everything else about
      // view configuration (rename, delete, filters/sorts/groups/
      // field_settings/field_orders/layout_settings) was already fully
      // handled by the generic Database collabType=1 WS admission path
      // (Task 61) plus the existing generic page-rename/trash routes; only
      // CREATING a view beyond a database's first/primary one had no route
      // at all. Contract verified directly against AppFlowy-Web
      // src/application/database-yjs/creation/create-default-view.ts
      // (createDefaultDatabaseView) and its own opt-in server-interop test
      // (default-database-view-creation.integration.test.ts), which this
      // route is written to satisfy exactly: identical atomic-creation
      // request/response envelope as page-view/database/default above,
      // idempotent replay via request_id, and a server-owned recipe for the
      // new view's content (the frontend never sends filter/sort/group/
      // field-setting content itself -- see that test's explicit assertion
      // that the request JSON contains none of those keys).
      //
      // Form (DatabaseViewLayout.Form = 7) is deliberately rejected --
      // see SUPPORTED_ADDITIONAL_VIEW_LAYOUTS's doc comment
      // (database-document.js) for why its companion "Responses"
      // view/public-submission semantics are out of this task's scope.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'v2' &&
          parts[4] === 'page-view' && parts[5] === 'database-view' && parts[6] === 'default' && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const request = await body(req);
        const requestId = request.request_id;
        const view = request.view;
        const position = request.position ?? { kind: 'end' };
        const validView = isPlainObject(view) &&
          validateUuid(view.database_id) && validateUuid(view.view_id) && validateUuid(view.parent_view_id) &&
          (view.source_view_id === null || view.source_view_id === undefined || validateUuid(view.source_view_id)) &&
          typeof view.name === 'string' && view.name.length > 0 && view.name.length <= 200 &&
          Number.isInteger(view.layout) && SUPPORTED_ADDITIONAL_VIEW_LAYOUTS.includes(view.layout) &&
          typeof view.embedded === 'boolean' &&
          (view.responses_view_id === null || view.responses_view_id === undefined) &&
          (view.timezone_id === null || view.timezone_id === undefined || typeof view.timezone_id === 'string');
        const validPosition = isPlainObject(position) &&
          (((position.kind === 'start' || position.kind === 'end') && Object.keys(position).length === 1) ||
            (position.kind === 'index' && Number.isInteger(position.index) && position.index >= 0 && Object.keys(position).length === 2));
        if (request.schema_version !== 'v1' || !validateUuid(requestId) ||
            request.database_restore_id !== ORIGINAL_DATABASE_RESTORE_ID || !validView || !validPosition ||
            (request.icon !== undefined && request.icon !== null && (typeof request.icon !== 'object' || Array.isArray(request.icon))) ||
            (request.extra !== undefined && request.extra !== null && (typeof request.extra !== 'object' || Array.isArray(request.extra)))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'A valid v1 default database-view request is required');
        }
        if (Object.keys(request).some((key) => !['schema_version', 'request_id', 'database_restore_id', 'view', 'position', 'icon', 'extra'].includes(key)) ||
            Object.keys(view).some((key) => !['database_id', 'view_id', 'parent_view_id', 'source_view_id', 'name', 'layout', 'embedded', 'responses_view_id', 'timezone_id'].includes(key))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Unsupported fields in default database-view request');
        }
        const databaseId = view.database_id;
        const databaseCollab = await store.getDatabaseCollab(access.workspace.id, databaseId);
        if (!databaseCollab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');
        const parentPage = await store.getPage(view.parent_view_id);
        if (!parentPage || parentPage.workspace_id !== access.workspace.id) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'parent_view_id does not resolve to a page in this workspace');
        }
        const rawBody = req.rawBody ?? '';
        const digest = createHash('sha256').update(rawBody).digest('hex');
        const timestamp = now();
        const sourceViewId = view.source_view_id || null;
        // Folder-tree sidebar/tab entry for the new view -- same shape as
        // Task 61's primaryViewPage, just parented by whatever page the
        // frontend resolved as the database's container (usually, but not
        // necessarily, the same container as the primary view).
        const viewPage = {
          id: view.view_id,
          workspace_id: access.workspace.id,
          parent_view_id: view.parent_view_id,
          title: view.name,
          icon: request.icon ?? null,
          extra: { database_id: databaseId },
          layout: FOLDER_LAYOUTS[view.layout],
          is_favorite: false,
          creator_id: access.user.id,
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          position,
        };
        try {
          const created = await store.createAtomicDatabaseView({
            workspaceId: access.workspace.id,
            databaseId,
            viewId: view.view_id,
            sourceViewId,
            layout: view.layout,
            name: view.name,
            embedded: view.embedded,
            timestamp,
            page: viewPage,
            request: { request_id: requestId, request_digest: digest, update_batch_id: id() },
          });
          // AppFlowy-Web's own atomic-creation journal
          // (validateAtomicCreationReceipt, 'database-view' case) requires
          // this exact receipt shape -- discovered via real-browser
          // verification (see storage.js createAtomicDatabaseView's
          // comment): without it the client throws
          // AtomicCreationPendingError even though this HTTP call itself
          // succeeded. `view_ids` always has exactly one entry since Form
          // (the only layout with a companion "responses" view) is
          // rejected above. `database_version` is null, matching this
          // Phase's "no per-view versioning" posture (same as
          // restore-state's always-null database_restore_id).
          // Other open tabs hold their own copy of the Database document; without this push the new
          // view only exists for the creating tab (whose client merges the receipt itself) until refresh.
          broadcastDatabaseUpdate(access.workspace.id, databaseId, created);
          return send(res, 200, appFlowyResponse({
            request_id: requestId,
            outcome: created.outcome,
            result: {
              view_id: created.view_id,
              database_id: databaseId,
              database_restore_id: ORIGINAL_DATABASE_RESTORE_ID,
              view_ids: [view.view_id],
              database_version: null,
              update_batch_id: created.update_batch_id,
              database_update_v1: Buffer.from(created.database_update).toString('base64'),
            },
          }));
        } catch (creationError) {
          if (creationError.code === 'REQUEST_ID_REUSED') return error(res, 409, 'REQUEST_ID_REUSED', creationError.message);
          if (creationError.code === 'PAGE_EXISTS' || creationError.code === '23505') return error(res, 409, 'RECORD_ALREADY_EXISTS', 'View ID already exists');
          if (creationError.code === 'VIEW_NOT_FOUND') return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'source_view_id does not belong to this Database');
          if (creationError.code === 'DATABASE_NOT_FOUND') return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');
          throw creationError;
        }
      }
      // Task 62 (minimum viable DatabaseRow lifecycle): default row
      // creation. Contract verified directly against AppFlowy-Web
      // src/application/database-yjs/creation/create-row.ts
      // (createCloudRow, prepareDefaultRowRequest) and
      // src/application/services/js-services/http/atomic-row-creation-api.ts
      // (postDefaultRowCreation -> POST /v2/database/{databaseId}/row/default).
      // The frontend sends only identity + cell/height/visibility/
      // presentation content; this atomically (a) creates the new
      // DatabaseRow collab object and (b) inserts {id, height} into the
      // parent Database's single Phase-1 inline Grid view's row_orders,
      // returning the resulting Database diff as `database_update_v1` so
      // the creating client can merge it locally without a second round
      // trip (see database-row-document.js, storage.js
      // createAtomicDatabaseRow). The optional
      // `activation.row_encoded_collab_v1` hint (a Rust-EncodedCollab-shaped
      // optimization -- see AppFlowy-Web encoded-collab.ts
      // decodeCreatedRowCollab) is intentionally NOT implemented: it is
      // optional in the frontend's own contract
      // (CreatedRowReceipt.activation?), and createCloudRow() already has a
      // fully-specified fallback that reads the new Database + DatabaseRow
      // state back via the existing single-object
      // GET /collab/{id}?collab_type= route (readCollabStates), which this
      // task extends to collab_type=4 above. Row templates/duplication
      // (POST /v2/database/{databaseId}/row, submit-template-row.ts) use a
      // separate, more advanced endpoint and are explicitly out of scope.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'v2' &&
          parts[4] === 'database' && parts[5] && parts[6] === 'row' && parts[7] === 'default' && parts.length === 8) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const databaseId = parts[5];
        const request = await body(req);
        const requestId = request.request_id;
        const rowId = request.row_id;
        const sourceViewId = request.source_view_id;
        const position = request.position;
        const cells = request.cells;
        const height = request.height;
        const visibility = request.visibility;
        const presentation = request.presentation;

        const validPosition = isPlainObject(position) &&
          (((position.kind === 'start' || position.kind === 'end') && Object.keys(position).length === 1) ||
            (['before', 'after'].includes(position.kind) && validateUuid(position.row_id) && Object.keys(position).length === 2));
        const validCells = isPlainObject(cells) && Object.entries(cells).every(([fieldId, cell]) =>
          typeof fieldId === 'string' && fieldId.length > 0 && isPlainObject(cell) && isJsonSafeCellValue(cell));
        const validPresentation = isPlainObject(presentation) &&
          Object.keys(presentation).every((key) => ['icon_url', 'cover'].includes(key)) &&
          (presentation.icon_url === undefined || presentation.icon_url === null || typeof presentation.icon_url === 'string') &&
          (presentation.cover === undefined || presentation.cover === null ||
            (isPlainObject(presentation.cover) && typeof presentation.cover.data === 'string' &&
              Number.isFinite(presentation.cover.cover_type) && Number.isFinite(presentation.cover.upload_type) &&
              Number.isFinite(presentation.cover.offset)));

        if (request.schema_version !== 'v1' || !validateUuid(requestId) || !validateUuid(rowId) ||
            request.database_restore_id !== ORIGINAL_DATABASE_RESTORE_ID || !validateUuid(sourceViewId) ||
            !validCells || !Number.isInteger(height) || height <= 0 || height > 100_000 ||
            typeof visibility !== 'boolean' || !validPosition || !validPresentation) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'A valid v1 default Row creation request is required');
        }
        if (Object.keys(request).some((key) => !['schema_version', 'request_id', 'row_id', 'database_restore_id', 'source_view_id', 'cells', 'height', 'visibility', 'presentation', 'position'].includes(key))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Unsupported fields in default Row creation request');
        }

        const databaseCollab = await store.getDatabaseCollab(access.workspace.id, databaseId);
        if (!databaseCollab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');

        // Reject cell field ids that don't belong to this Database's own
        // fields -- an unknown field id can never be a legitimate cell write.
        const fieldCheckDoc = new Y.Doc({ guid: databaseId });
        let knownFieldIds;
        try {
          Y.applyUpdate(fieldCheckDoc, databaseCollab.doc_state);
          const database = fieldCheckDoc.getMap('data').get('database');
          const fields = database && database.get('fields');
          knownFieldIds = fields ? Array.from(fields.keys()) : [];
        } finally {
          fieldCheckDoc.destroy();
        }
        if (Object.keys(cells).some((fieldId) => !knownFieldIds.includes(fieldId))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Row cells reference an unknown field');
        }

        const rawBody = req.rawBody ?? '';
        const digest = createHash('sha256').update(rawBody).digest('hex');
        const timestamp = now();
        const rowCollab = createInitialDatabaseRowCollab({
          rowId, databaseId, cells, height, visibility, timestamp, actorUid: access.user.uid,
        });
        try {
          const created = await store.createAtomicDatabaseRow({
            workspaceId: access.workspace.id,
            databaseId,
            rowId,
            sourceViewId,
            position,
            rowCollab,
            request: { request_id: requestId, request_digest: digest, height, timestamp, update_batch_id: id() },
          });
          broadcastDatabaseUpdate(access.workspace.id, databaseId, created);
          return send(res, 200, appFlowyResponse({
            request_id: requestId,
            outcome: created.outcome,
            result: {
              row_id: created.row_id,
              database_id: databaseId,
              database_restore_id: ORIGINAL_DATABASE_RESTORE_ID,
              database_version: databaseCollab.collab_version,
              database_update_v1: Buffer.from(created.database_update).toString('base64'),
              update_batch_id: created.update_batch_id,
            },
          }));
        } catch (creationError) {
          if (creationError.code === 'REQUEST_ID_REUSED') return error(res, 409, 'REQUEST_ID_REUSED', creationError.message);
          if (creationError.code === 'ROW_EXISTS' || creationError.code === '23505') return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Row ID already exists');
          if (creationError.code === 'VIEW_NOT_FOUND') return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'source_view_id does not belong to this Database');
          if (creationError.code === 'DATABASE_NOT_FOUND') return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');
          throw creationError;
        } finally {
          rowCollab.documentState.fill(0);
          rowCollab.stateVector.fill(0);
        }
      }
      // Task 79: publishes a row-page's "first body" atomically -- the
      // counterpart to Task 62's default-row-creation endpoint immediately
      // above, but for the row's Document (its detail-page content), not
      // its cells. Contract verified against AppFlowy-Web
      // src/application/row-document/atomic-first-body.ts (prepareAtomicRowFirstBody)
      // and src/application/atomic-creation/types.ts (PublishRowDocumentRequest/
      // PublishRowDocumentResult): POST /v2/page-view/row-document.
      //
      // Task 62's comment above called row templates "explicitly out of
      // scope" for a "separate, more advanced endpoint" -- this is that
      // endpoint. A database template's row is never created via the
      // default-row-creation route above (it is deliberately hidden from
      // every view's row_orders, see row-source-readiness.ts's
      // hasCurrentRowDocumentSource on the client); this route creates that
      // row, as a bare placeholder with no cell content (the client's own
      // live Yjs sync fills in the real cells once it binds to this row,
      // same as any other row), together with its Document in one request.
      // An ordinary row's first-body publish (e.g. opening a brand-new grid
      // row for the first time) also reaches this same route, but by then
      // its row was already committed by the default-row-creation route;
      // ensureHiddenDatabaseRow is a no-op in that case (row already exists).
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'v2' &&
          parts[4] === 'page-view' && parts[5] === 'row-document' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const request = await body(req);
        const requestId = request.request_id;
        const databaseId = request.database_id;
        const rowId = request.row_id;
        const sourceViewId = request.source_view_id;
        const name = request.name;
        const contribution = request.contribution;
        const validContribution = isPlainObject(contribution) &&
          ((contribution.kind === 'default_schema' && contribution.schema_version === 'v1' && Object.keys(contribution).length === 2) ||
            (contribution.kind === 'default_actions' && contribution.schema_version === 'v1' &&
              Array.isArray(contribution.actions) && contribution.actions.length <= 1024 &&
              Object.keys(contribution).length === 3));

        // PublishRowDocumentRequest (atomic-creation/types.ts) carries no
        // top-level schema_version -- only contribution.schema_version.
        if (!validateUuid(requestId) || !validateUuid(databaseId) ||
            request.database_restore_id !== ORIGINAL_DATABASE_RESTORE_ID || !validateUuid(rowId) ||
            !validateUuid(sourceViewId) || typeof name !== 'string' || name.length > 200 || !validContribution) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'A valid row-document publish request is required');
        }
        if (Object.keys(request).some((key) => !['request_id', 'database_id', 'database_restore_id', 'row_id', 'source_view_id', 'name', 'contribution'].includes(key))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Unsupported fields in row-document publish request');
        }

        const databaseCollab = await store.getDatabaseCollab(access.workspace.id, databaseId);
        if (!databaseCollab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');

        const documentId = rowDocumentIdFromRowId(rowId);
        const timestamp = now();
        const rowCollab = createInitialDatabaseRowCollab({
          rowId, databaseId, cells: {}, height: 37, visibility: true, timestamp, actorUid: access.user.uid,
        });
        let documentCollab;

        try {
          try {
            documentCollab = createPageCollabFromFirstBodyContribution(documentId, contribution);
          } catch (contributionError) {
            return error(res, 400, 'INVALID_ATOMIC_REQUEST', `Unsupported first-body contribution: ${contributionError.message}`);
          }

          await store.ensureHiddenDatabaseRow({
            workspaceId: access.workspace.id, databaseId, rowId, rowCollab, timestamp,
          });

          const rawBody = req.rawBody ?? '';
          const digest = createHash('sha256').update(rawBody).digest('hex');
          const page = {
            id: documentId,
            workspace_id: access.workspace.id,
            parent_view_id: null,
            title: name,
            icon: null,
            extra: { row_document: { source: { database_id: databaseId, database_view_id: sourceViewId, row_id: rowId } } },
            is_favorite: false,
            document: {},
            schema_version: 'appflowy-document-v1',
            creator_id: access.user.id,
            version: 1,
            created_at: timestamp,
            updated_at: timestamp,
            position: { kind: 'start' },
          };

          let created;

          try {
            created = await store.createAtomicDocumentPage(page, documentCollab, { request_id: requestId, request_digest: digest });
          } catch (creationError) {
            if (creationError.code === 'REQUEST_ID_REUSED') return error(res, 409, 'REQUEST_ID_REUSED', creationError.message);
            if (creationError.code === 'PAGE_EXISTS' || creationError.code === '23505') {
              return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Row-page document already exists');
            }
            throw creationError;
          }

          return send(res, 200, appFlowyResponse({
            request_id: requestId,
            outcome: created.outcome,
            result: {
              document_id: documentId,
              row_id: rowId,
              database_id: databaseId,
              database_restore_id: ORIGINAL_DATABASE_RESTORE_ID,
              row_version: null,
              document_version: null,
              update_batch_id: id(),
            },
          }));
        } finally {
          rowCollab.documentState.fill(0);
          rowCollab.stateVector.fill(0);
        }
      }
      // Task 79: the "seeded" template-row-creation path (AppFlowy-Web's
      // submit-template-row.ts: prepareTemplateRowGraph's simple case, no
      // embedded databases -- exactly one row and at most one document,
      // both already fully built client-side). Contract verified against
      // row-template-graph-types.ts's CreateDatabaseRowRequest and
      // row-creation-types.ts's CreatedRowReceipt: POST /v2/database/{id}/row.
      //
      // Unlike the default-row-creation route above, the row (and its
      // document, if present) arrive pre-encoded via encodeCreationCollab
      // (decodeCreationCollab below is its exact inverse) rather than as
      // loose cell/field data for the server to assemble -- this is how a
      // database template with real body content, not just an empty
      // "New template", actually gets applied to create a page. The
      // row is inserted into every view in position_view_ids (every view
      // where the template's position anchor is visible), not just one.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'v2' &&
          parts[4] === 'database' && parts[5] && parts[6] === 'row' && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const databaseId = parts[5];
        const request = await body(req);
        const requestId = request.request_id;
        const sourceViewId = request.source_view_id;
        const row = request.row;
        const position = request.position;
        const positionViewIds = request.position_view_ids;
        const documentName = request.document_name;

        const validPosition = isPlainObject(position) &&
          (((position.kind === 'start' || position.kind === 'end') && Object.keys(position).length === 1) ||
            (['before', 'after'].includes(position.kind) && validateUuid(position.row_id) && Object.keys(position).length === 2));
        const validRow = isPlainObject(row) && validateUuid(row.row_id) && typeof row.collab === 'string' &&
          (row.document === undefined || typeof row.document === 'string') &&
          Object.keys(row).every((key) => ['row_id', 'collab', 'document'].includes(key));
        const validPositionViewIds = Array.isArray(positionViewIds) && positionViewIds.length > 0 &&
          positionViewIds.length <= 1000 && positionViewIds.every((viewId) => validateUuid(viewId));

        if (!validateUuid(requestId) || request.database_restore_id !== ORIGINAL_DATABASE_RESTORE_ID ||
            !validateUuid(sourceViewId) || !validRow || !validPosition || !validPositionViewIds ||
            (documentName !== undefined && typeof documentName !== 'string') ||
            (documentName !== undefined && documentName.length > 200)) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'A valid seeded row-creation request is required');
        }
        if (Object.keys(request).some((key) => !['request_id', 'database_restore_id', 'source_view_id', 'row', 'position', 'position_view_ids', 'document_name'].includes(key))) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Unsupported fields in seeded row-creation request');
        }

        const databaseCollab = await store.getDatabaseCollab(access.workspace.id, databaseId);
        if (!databaseCollab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');

        const rowId = row.row_id;
        let decodedRow, decodedDocument;

        try {
          decodedRow = decodeCreationCollab(row.collab);
          if (row.document !== undefined) decodedDocument = decodeCreationCollab(row.document);
        } catch (decodeError) {
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', `Unsupported row collab: ${decodeError.message}`);
        }

        let height;

        try {
          const data = decodedRow.doc.getMap('data').get('data');

          if (
            !(data instanceof Y.Map) || data.get('id') !== rowId || data.get('database_id') !== databaseId ||
            !Number.isInteger(data.get('height')) || data.get('height') <= 0
          )
            throw new Error('Row collab identity or shape is invalid');
          height = data.get('height');

          if (decodedDocument) {
            const documentId = rowDocumentIdFromRowId(rowId);
            const doc = decodedDocument.doc.getMap('data').get('document');

            if (!(doc instanceof Y.Map) || doc.get('page_id') !== pageIdFromDocumentId(documentId))
              throw new Error('Row document collab identity does not match its row');
          }
        } catch (shapeError) {
          decodedRow.doc.destroy();
          decodedDocument?.doc.destroy();
          return error(res, 400, 'INVALID_ATOMIC_REQUEST', shapeError.message);
        }

        const documentId = decodedDocument ? rowDocumentIdFromRowId(rowId) : undefined;
        const timestamp = now();
        let documentPage;

        if (decodedDocument) {
          documentPage = {
            id: documentId,
            page: {
              id: documentId,
              workspace_id: access.workspace.id,
              parent_view_id: null,
              title: documentName ?? '',
              icon: null,
              extra: { row_document: { source: { database_id: databaseId, database_view_id: sourceViewId, row_id: rowId } } },
              is_favorite: false,
              document: {},
              schema_version: 'appflowy-document-v1',
              creator_id: access.user.id,
              version: 1,
              created_at: timestamp,
              updated_at: timestamp,
              position: { kind: 'start' },
            },
            collab: { documentState: decodedDocument.state, stateVector: decodedDocument.vector, collabVersion: 'appflowy-page-v1' },
          };
        }

        decodedRow.doc.destroy();
        decodedDocument?.doc.destroy();

        const rawBody = req.rawBody ?? '';
        const digest = createHash('sha256').update(rawBody).digest('hex');
        let created;

        try {
          created = await store.createSeededDatabaseRow({
            workspaceId: access.workspace.id, databaseId, rowId, positionViewIds, position, height,
            rowState: decodedRow.state, rowStateVector: decodedRow.vector, documentPage,
            request: { request_id: requestId, request_digest: digest, timestamp, update_batch_id: id() },
          });
        } catch (creationError) {
          if (creationError.code === 'REQUEST_ID_REUSED') return error(res, 409, 'REQUEST_ID_REUSED', creationError.message);
          if (creationError.code === 'ROW_EXISTS' || creationError.code === 'PAGE_EXISTS' || creationError.code === '23505') {
            return error(res, 409, 'RECORD_ALREADY_EXISTS', 'Row or its document already exists');
          }
          if (creationError.code === 'VIEW_NOT_FOUND') return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'position_view_ids do not belong to this Database');
          if (creationError.code === 'DATABASE_NOT_FOUND') return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');
          throw creationError;
        }

        broadcastDatabaseUpdate(access.workspace.id, databaseId, created);
        return send(res, 200, appFlowyResponse({
          request_id: requestId,
          outcome: created.outcome,
          result: {
            row_id: rowId,
            database_id: databaseId,
            database_restore_id: ORIGINAL_DATABASE_RESTORE_ID,
            database_version: databaseCollab.collab_version,
            database_update_v1: Buffer.from(created.database_update).toString('base64'),
            update_batch_id: created.update_batch_id,
          },
        }));
      }
      // Task 61: database restore-state. Restore/versioning for Database
      // objects is out of scope for Phase 1 (see
      // DATABASE_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md); this always
      // reports "no restore has ever happened" with the fixed collab_version
      // that createInitialDatabaseCollab() stamps on every Database object,
      // which is exactly what AppFlowy-Web's verifyCreatedPage() requires
      // (created-page-hydration.ts: `restore.version !== remote.version`
      // must never fire for a Phase-1-created database).
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'database' &&
          parts[4] && parts[5] === 'restore-state' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const collab = await store.getDatabaseCollab(access.workspace.id, parts[4]);
        if (!collab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');
        return send(res, 200, appFlowyResponse({
          database_restore_id: null,
          version: DATABASE_COLLAB_VERSION,
        }), { 'cache-control': 'private, no-store' });
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] &&
          parts[3] === 'collab' && parts[4] && parts[5] === 'permission' && parts.length === 6) {
        const collabType = url.searchParams.get('collab_type');
        if (!['0', '1'].includes(collabType)) return error(res, 400, 'UNSUPPORTED_COLLAB_TYPE', 'Only Document and Database object permissions are supported');
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const isWorkspaceOwner = access.membership.role === 'owner';
        // Task 61: AppFlowy-Web's permission probe resolves a Database view's
        // target as {collabObjectId: database_id, collabType: Types.Database}
        // (permissionProbe.ts resolvePermissionProbeTarget), not Document --
        // this is what gates the Grid view's own "add property"/field-menu
        // UI actions. Checked first since collab_type disambiguates it from
        // the Document/space branches below (which only ever handle '0').
        if (collabType === '1') {
          const databaseCollab = await store.getDatabaseCollab(access.workspace.id, parts[4]);
          if (!databaseCollab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');
          return send(res, 200, appFlowyResponse({
            object_id: databaseCollab.object_id,
            collab_type: 1,
            governing_view_id: databaseCollab.object_id,
            access_level: isWorkspaceOwner ? 50 : 30,
            can_read: true,
            can_write: true,
            can_comment: true,
            can_share: isWorkspaceOwner,
          }));
        }
        const page = await store.getPage(parts[4]);
        if (page) {
          const parentSpace = await governingSpace(store, access.workspace.id, page);
          const collab = page.workspace_id === access.workspace.id &&
            parentSpace?.workspace_id === access.workspace.id &&
            isSupportedPublicSpacePermission(parentSpace.permission)
            ? await store.getPageCollab(access.workspace.id, page.id)
            : null;
          // A database's sidebar entry (its Folder "container" page) has no
          // Document collab, but AppFlowy-Web probes it as collab_type=0
          // (resolvePermissionProbeTarget only treats the container's child
          // *views* as Database objects). A 404 here left the sidebar menu
          // with no permissions, hiding Delete/Rename/Duplicate/Move.
          const containerDatabaseId = !collab && page.workspace_id === access.workspace.id && page.extra?.is_database_container === true
            ? page.extra.database_id
            : null;
          // An AI chat page (layout 4) is a Folder entry with no document collab either.
          const isChatPage = !collab && page.workspace_id === access.workspace.id && page.layout === 4;
          if (isChatPage || (containerDatabaseId && await store.getDatabaseCollab(access.workspace.id, containerDatabaseId))) {
            return send(res, 200, appFlowyResponse({
              object_id: page.id,
              collab_type: 0,
              governing_view_id: page.parent_view_id ?? page.id,
              access_level: isWorkspaceOwner ? 50 : 30,
              can_read: true,
              can_write: true,
              can_comment: true,
              can_share: isWorkspaceOwner,
            }));
          }
          if (!collab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Document collaboration object not found');
          return send(res, 200, appFlowyResponse({
            object_id: page.id,
            collab_type: 0,
            governing_view_id: parentSpace.id,
            access_level: isWorkspaceOwner ? 50 : 30,
            can_read: true,
            can_write: true,
            can_comment: true,
            can_share: isWorkspaceOwner,
          }));
        }
        // Task 61: AppFlowy-Web's own permission-probe design
        // (resolvePermissionProbeTarget, permissionProbe.ts) treats this
        // single endpoint generically as "permission for workspace folder
        // view X", defaulting to collab_type=0 for any non-Database view --
        // including spaces -- not strictly "permission for a Document collab
        // object". It is the only thing gating the sidebar's per-space
        // inline "+" (add-page) button, which is the sole UI entry point for
        // picking a non-Document layout (Grid/Board/Calendar/...), so a
        // Space id reaching here with a 404 silently hides that button and
        // blocks creating a Grid database through the real UI entirely.
        // This branch is purely additive: Document identity/shape/behavior
        // above is unchanged.
        const space = await store.getSpace(parts[4]);
        if (space && space.workspace_id === access.workspace.id && isSupportedPublicSpacePermission(space.permission)) {
          return send(res, 200, appFlowyResponse({
            object_id: space.id,
            collab_type: 0,
            governing_view_id: space.id,
            access_level: isWorkspaceOwner ? 50 : 30,
            can_read: true,
            can_write: true,
            can_comment: true,
            can_share: isWorkspaceOwner,
          }));
        }
        return error(res, 404, 'COLLAB_NOT_FOUND', 'Document collaboration object not found');
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] === 'v1' &&
          parts[3] && parts[4] === 'collab' && parts[5] === 'full-sync' && parts[6] === 'batch' && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[3]);
        if (!access) return;
        if (!/^application\/octet-stream(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
          return error(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Full-sync batch requests must use application/octet-stream');
        }

        const requestBytes = await binaryBody(req, MAX_FULL_SYNC_BYTES);
        let request;
        try {
          request = decodeFullSyncBatch(requestBytes);
        } catch {
          return error(res, 400, 'INVALID_FULL_SYNC_REQUEST', 'Malformed CollabBatchSyncRequest protobuf');
        }
        if (!Array.isArray(request.items) || request.items.length === 0 || request.items.length > MAX_FULL_SYNC_ITEMS ||
            request.responseCompression !== 0) {
          return error(res, 400, 'INVALID_FULL_SYNC_REQUEST', 'A non-empty bounded batch with uncompressed response is required');
        }

        const itemKeys = new Set();
        for (const item of request.items) {
          if (typeof item.objectId !== 'string' || !item.objectId || item.objectId.length > 128 ||
              !Number.isInteger(item.collabType) || !(item.sv instanceof Uint8Array) ||
              !(item.docState instanceof Uint8Array) ||
              (item.collabVersion !== undefined && item.collabVersion.length > 256) ||
              (item.databaseRestoreId !== undefined && item.databaseRestoreId.length > 64)) {
            return error(res, 400, 'INVALID_FULL_SYNC_REQUEST', 'Each batch item requires a bounded object ID, type, state vector, and document state');
          }
          const itemKey = `${item.objectId}:${item.collabType}`;
          if (itemKeys.has(itemKey)) return error(res, 400, 'INVALID_FULL_SYNC_REQUEST', 'Duplicate collaboration objects are not allowed in one batch');
          itemKeys.add(itemKey);
        }

        const results = [];
        for (const item of request.items) {
          if (item.collabType !== 0) {
            results.push(emptyFullSyncResult(item, 'unsupported_collab_type'));
            continue;
          }
          if (item.compression !== 0 && item.compression !== 2) {
            results.push(emptyFullSyncResult(item, 'unsupported_compression'));
            continue;
          }

          let clientStateVector;
          let docState;
          try {
            clientStateVector = inflateFullSyncPayload(item.sv, item.compression);
            decodeFullSyncStateVector(clientStateVector);
            docState = inflateFullSyncPayload(item.docState, item.compression);
          } catch (payloadError) {
            results.push(emptyFullSyncResult(item, payloadError.message));
            continue;
          }

          const page = await store.getPage(item.objectId);
          const parentSpace = await governingSpace(store, access.workspace.id, page);
          const authorizedPage = page && page.workspace_id === access.workspace.id &&
            parentSpace?.workspace_id === access.workspace.id &&
            isSupportedPublicSpacePermission(parentSpace.permission);
          const current = authorizedPage ? await store.getPageCollab(access.workspace.id, item.objectId) : null;
          if (!current) {
            results.push(emptyFullSyncResult(item, 'permission_denied'));
            continue;
          }
          if (item.databaseRestoreId && item.databaseRestoreId !== current.restore_id) {
            results.push(emptyFullSyncResult(item, 'restore_generation_mismatch', current.state_vector, current.collab_version));
            continue;
          }

          const serverDoc = new Y.Doc({ guid: item.objectId });
          let clientDoc;
          try {
            Y.applyUpdate(serverDoc, current.doc_state);
            const serverStateVector = Y.encodeStateVector(serverDoc);
            const serverVector = decodeFullSyncStateVector(serverStateVector);
            const clientVector = decodeFullSyncStateVector(clientStateVector);
            if (item.collabVersion && item.collabVersion !== current.collab_version) {
              results.push({
                ...emptyFullSyncResult(item, '', serverStateVector, current.collab_version),
                missingUpdate: Y.encodeStateAsUpdate(serverDoc, clientStateVector),
                messageId: current.last_message_id,
              });
              continue;
            }

            if (docState.byteLength > 0) {
              clientDoc = new Y.Doc({ guid: item.objectId });
              try {
                Y.applyUpdate(clientDoc, docState);
              } catch {
                results.push(emptyFullSyncResult(item, 'invalid_document_state', serverStateVector, current.collab_version));
                continue;
              }
              if (clientDoc.store.pendingStructs || clientDoc.store.pendingDs ||
                  !stateVectorsEqual(clientVector, decodeFullSyncStateVector(Y.encodeStateVector(clientDoc)))) {
                results.push(emptyFullSyncResult(item, 'invalid_document_state', serverStateVector, current.collab_version));
                continue;
              }

              const incomingUpdate = Y.encodeStateAsUpdate(clientDoc, serverStateVector);
              if (!(incomingUpdate.byteLength === 2 && incomingUpdate[0] === 0 && incomingUpdate[1] === 0)) {
                const accepted = await store.acceptPageCollabUpdate({
                  workspaceId: access.workspace.id,
                  pageId: item.objectId,
                  actorUserId: access.user.id,
                  flags: 0,
                  payload: incomingUpdate,
                  beforeStateVector: serverStateVector,
                  collabVersion: current.collab_version,
                  restoreId: current.restore_id,
                });
                const reconciledDoc = new Y.Doc({ guid: item.objectId });
                try {
                  Y.applyUpdate(reconciledDoc, accepted.documentState);
                  results.push({
                    objectId: item.objectId,
                    collabType: item.collabType,
                    compression: 0,
                    missingUpdate: Y.encodeStateAsUpdate(reconciledDoc, clientStateVector),
                    serverStateVector: accepted.stateVector,
                    collabVersion: accepted.collabVersion,
                    messageId: accepted.messageId,
                  });
                } finally {
                  reconciledDoc.destroy();
                }
                continue;
              }
            }

            results.push({
              objectId: item.objectId,
              collabType: item.collabType,
              compression: 0,
              missingUpdate: Y.encodeStateAsUpdate(serverDoc, clientStateVector),
              serverStateVector,
              collabVersion: current.collab_version,
              ...(docState.byteLength > 0 && current.last_message_id.timestamp > 0
                ? { messageId: current.last_message_id }
                : {}),
            });
          } catch (syncError) {
            if (syncError.code === 'VERSION_MISMATCH') {
              results.push(emptyFullSyncResult(item, 'collab_version_mismatch', current.state_vector, current.collab_version));
              continue;
            }
            if (syncError.code === 'RESTORE_GENERATION_MISMATCH') {
              results.push(emptyFullSyncResult(item, 'restore_generation_mismatch', current.state_vector, current.collab_version));
              continue;
            }
            if (syncError.code === 'MISSING_CAUSAL_STATE' || syncError.code === 'UNRESOLVED_DEPENDENCY' ||
                syncError.code === 'MALFORMED_YJS_UPDATE') {
              results.push(emptyFullSyncResult(item, 'invalid_document_state', current.state_vector, current.collab_version));
              continue;
            }
            throw syncError;
          } finally {
            if (clientDoc) clientDoc.destroy();
            serverDoc.destroy();
          }
        }
        return sendBinary(res, 200, encodeFullSyncBatch({ results, responseCompression: 0 }));
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] === 'v1' && parts[3] && parts[4] === 'collab' && parts[5] && parts.length === 6) {
        const collabType = url.searchParams.get('collab_type');
        if (!['0', '1', '2', '4'].includes(collabType)) return error(res, 400, 'UNSUPPORTED_COLLAB_TYPE', 'Only Document, Database, DatabaseRow, and WorkspaceDatabase collaboration reads are supported');
        const access = await requireWorkspace(store, req, res, parts[3]);
        if (!access) return;
        const objectId = parts[5];
        if (collabType === '4') {
          // Task 62: DatabaseRow collaboration read, used by AppFlowy-Web's
          // readCollabStates() (collab-api.ts) as createCloudRow()'s
          // fallback after row creation (no `collab_version` is returned --
          // AppFlowy-Web's own decode() in create-row.ts requires an
          // undefined collabVersion for a DatabaseRow read, unlike Database
          // reads which carry a real version string).
          const collab = await store.getDatabaseRowCollab(access.workspace.id, objectId);
          if (!collab) return error(res, 404, 'COLLAB_NOT_FOUND', 'DatabaseRow collaboration object not found');
          return send(res, 200, appFlowyResponse({
            object_id: collab.object_id,
            doc_state: Array.from(collab.doc_state),
            state_vector: Array.from(collab.state_vector),
            version: collab.version,
            collab_version: null,
          }), { 'cache-control': 'private, no-store' });
        }
        if (collabType === '0') {
          let collab = await store.getPageCollab(access.workspace.id, objectId);
          if (!collab) {
            // Task 73: the row-detail body-editor's primary open/create path
            // (AppFlowy-Web's fetchRowDocumentCollab -> getCollab with
            // rowDocumentSource) requests this same generic Document read,
            // passing database_id/row_id/row_document_id so the backend can
            // lazily materialize the row's Document + orphaned Folder-tree
            // page on first open, authorized via the parent database rather
            // than a direct Document ACL (there is none yet).
            const databaseIdParam = url.searchParams.get('database_id');
            const rowIdParam = url.searchParams.get('row_id');
            const rowDocumentIdParam = url.searchParams.get('row_document_id');
            if (databaseIdParam && rowIdParam && rowDocumentIdParam === objectId) {
              const result = await ensureRowDocumentPage(store, access, {
                databaseId: databaseIdParam,
                rowId: rowIdParam,
                documentId: objectId,
                actorUserId: access.user.id,
              });
              if (result.error === 'IDENTITY_MISMATCH') return error(res, 400, 'INVALID_REQUEST', 'row_document_id does not match the derived id for row_id');
              if (result.error === 'DATABASE_NOT_FOUND') return error(res, 404, 'COLLAB_NOT_FOUND', 'Parent database not found or not accessible');
              if (result.error) return error(res, 500, 'ROW_DOCUMENT_CREATE_FAILED', 'Failed to materialize row document');
              collab = result.collab;
            }
          }
          if (!collab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Document collaboration object not found');
          return send(res, 200, appFlowyResponse({
            object_id: collab.object_id,
            doc_state: Array.from(collab.doc_state),
            state_vector: Array.from(collab.state_vector),
            version: collab.version,
            collab_version: collab.collab_version,
          }), { 'cache-control': 'private, no-store' });
        }
        if (collabType === '1') {
          // Task 61: Database collaboration read, used by AppFlowy-Web's
          // readCollabStates() (collab-api.ts) -- same response shape as the
          // Document branch above.
          const collab = await store.getDatabaseCollab(access.workspace.id, objectId);
          if (!collab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');
          return send(res, 200, appFlowyResponse({
            object_id: collab.object_id,
            doc_state: Array.from(collab.doc_state),
            state_vector: Array.from(collab.state_vector),
            version: collab.version,
            collab_version: collab.collab_version,
          }), { 'cache-control': 'private, no-store' });
        }
        if (objectId !== access.workspace.database_storage_id) return error(res, 404, 'COLLAB_NOT_FOUND', 'Workspace database collaboration object not found');
        const collab = await store.getOrCreateWorkspaceDatabaseCollab(
          access.workspace.id,
          objectId,
          createDefaultWorkspaceDatabaseState(objectId)
        );
        if (!collab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Workspace database collaboration object not found');
        return send(res, 200, appFlowyResponse({
          object_id: collab.object_id,
          doc_state: Array.from(collab.doc_state),
        }), { 'cache-control': 'private, no-store' });
      }
      // --- Task 49A: document version history / restore (JSON storage only) ---
      // Contract confirmed against AppFlowy-Web src/application/services/js-services/http/collab-api.ts
      // (getCollabVersions, previewCollabVersion, createCollabVersion, deleteCollabVersion, revertCollabVersion).
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'collab' && parts[4] && parts[5] === 'history' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const sinceRaw = url.searchParams.get('since');
        const since = sinceRaw && sinceRaw !== 'null' ? Number(sinceRaw) : null;
        if (since !== null && !Number.isFinite(since)) return error(res, 400, 'INVALID_INPUT', 'since must be a timestamp in milliseconds');
        const versions = await store.listPageCollabVersions(access.workspace.id, parts[4], { since });
        if (versions === null) return error(res, 404, 'COLLAB_NOT_FOUND', 'Document collaboration object not found');
        return send(res, 200, appFlowyResponse(versions.map((v) => ({
          version: v.version,
          parent: v.parent,
          name: v.name,
          created_at: v.created_at,
          created_by: v.created_by,
          deleted_at: v.deleted_at,
          editors: v.editors,
        }))), { 'cache-control': 'private, no-store' });
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'collab' && parts[4] && parts[5] === 'history' && parts[6] && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const collabType = url.searchParams.get('collab_type');
        if (collabType !== '0') return error(res, 400, 'UNSUPPORTED_COLLAB_TYPE', 'Only Document version history is supported');
        const version = await store.getPageCollabVersion(access.workspace.id, parts[4], parts[6]);
        if (!version || version.deleted_at) return error(res, 404, 'VERSION_NOT_FOUND', 'Document version not found');
        return sendBinary(res, 200, Uint8Array.from(version.document_state));
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'collab' && parts[4] && parts[5] === 'history' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const b = await body(req);
        if (b.collab_type !== 0 && b.collab_type !== '0') return error(res, 400, 'UNSUPPORTED_COLLAB_TYPE', 'Only Document snapshots are supported');
        if (typeof b.snapshot !== 'string' || !b.snapshot) return error(res, 400, 'INVALID_INPUT', 'snapshot (base64 Yjs state) is required');
        const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 200) : null;
        let snapshotBytes;
        try { snapshotBytes = Buffer.from(b.snapshot, 'base64'); } catch { return error(res, 400, 'INVALID_INPUT', 'snapshot must be valid base64'); }
        // The stored version must be a full, independently reconstructable Yjs
        // state (not an arbitrary individual update), so validate it replays
        // cleanly into an empty document before persisting it.
        let fullState;
        const probe = new Y.Doc();
        try {
          Y.applyUpdate(probe, new Uint8Array(snapshotBytes));
          if (probe.store.pendingStructs || probe.store.pendingDs) return error(res, 400, 'INVALID_INPUT', 'snapshot is not a complete reconstructable document state');
          fullState = Y.encodeStateAsUpdate(probe);
        } catch {
          return error(res, 400, 'INVALID_INPUT', 'snapshot is not a valid Yjs update');
        } finally {
          probe.destroy();
        }
        const created = await store.createPageCollabVersion(access.workspace.id, parts[4], { name, documentState: fullState, actorUid: access.user.uid });
        if (!created) return error(res, 404, 'COLLAB_NOT_FOUND', 'Document collaboration object not found');
        return send(res, 201, appFlowyResponse(created.version));
      }
      if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'collab' && parts[4] && parts[5] === 'history' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const raw = (await binaryBody(req, 10_000)).toString('utf8');
        let versionId;
        try { versionId = JSON.parse(raw); } catch { return error(res, 400, 'INVALID_INPUT', 'Request body must be a JSON-encoded version id string'); }
        if (typeof versionId !== 'string' || !versionId) return error(res, 400, 'INVALID_INPUT', 'Request body must be a JSON-encoded version id string');
        const result = await store.tombstonePageCollabVersion(access.workspace.id, parts[4], versionId);
        if (result.status === 'not_found') return error(res, 404, 'VERSION_NOT_FOUND', 'Document version not found');
        return send(res, 200, appFlowyResponse(null));
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'collab' && parts[4] && parts[5] === 'revert' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const b = await body(req);
        if (b.collab_type !== 0 && b.collab_type !== '0') return error(res, 400, 'UNSUPPORTED_COLLAB_TYPE', 'Only Document restore is supported');
        if (typeof b.version !== 'string' || !b.version) return error(res, 400, 'INVALID_INPUT', 'version is required');
        try {
          const restored = await store.restorePageCollabVersion({
            workspaceId: access.workspace.id,
            pageId: parts[4],
            versionId: b.version,
            actorUid: access.user.uid,
          });
          return send(res, 200, appFlowyResponse({
            state_vector: Array.from(restored.stateVector),
            doc_state: Array.from(restored.documentState),
            collab_version: restored.collabVersion ?? null,
            version: 0,
          }));
        } catch (restoreError) {
          if (restoreError.code === 'COLLAB_DOCUMENT_NOT_FOUND') return error(res, 404, 'COLLAB_NOT_FOUND', 'Document collaboration object not found');
          if (restoreError.code === 'VERSION_NOT_FOUND') return error(res, 404, 'VERSION_NOT_FOUND', 'Document version not found');
          if (restoreError.code === 'VERSION_DELETED') return error(res, 409, 'VERSION_DELETED', 'Document version has been deleted');
          throw restoreError;
        }
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'page-view' && parts[4] && parts.length === 5) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const page = await store.getPage(parts[4]);
        if (!page || page.workspace_id !== access.workspace.id || !page.parent_view_id) {
          return error(res, 404, 'PAGE_NOT_FOUND', 'Page view not found');
        }
        // Task 64: AppFlowy-Web's getPageCollab (collab-api.ts) treats this
        // route as the generic "cold load this view's collab bytes" endpoint
        // for ANY view layout, not just Document -- see view-loader.ts
        // fetchAndApply, which calls it whenever a view is opened WITHOUT
        // `databaseMetadataOnly` (true only for secondary relation/rollup
        // lookups, never for a view's own primary/cold load -- see
        // useViewOperations.ts). Before this fix, a Database container or
        // primary-view page (`extra.database_id` set) had no Document collab
        // object at all, so this route always 404'd for it. That 404 was
        // masked in every prior single-session test because the creating
        // client already had the Database's Yjs doc cached locally from the
        // atomic-creation response and never needed to cold-fetch it -- the
        // SAME real-browser scenario Task 64 was asked to verify (a second
        // member, or any fresh session, with no local cache) hits this path
        // for the first time and got a fatal "Page not found" even after the
        // Task 64 catalog fix, which only solved discovery, not opening.
        // The fix: when the page represents a Database (container or
        // primary view), serve the Database collab's bytes here instead of
        // requiring a Document collab -- read-only, no new storage method
        // (store.getDatabaseCollab already existed from Task 61).
        const databaseId = isPlainObject(page.extra) && typeof page.extra.database_id === 'string' ? page.extra.database_id : null;
        let encodedCollabState;
        if (databaseId) {
          const databaseCollab = await store.getDatabaseCollab(access.workspace.id, databaseId);
          if (!databaseCollab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Database collaboration object not found');
          encodedCollabState = databaseCollab.doc_state;
        } else {
          const collab = await store.getPageCollab(access.workspace.id, page.id);
          if (!collab) return error(res, 404, 'COLLAB_NOT_FOUND', 'Page collaboration state not found');
          encodedCollabState = collab.doc_state;
        }
        return send(res, 200, appFlowyResponse({
          view: {
            view_id: page.id,
            name: page.title,
            icon: page.icon ?? null,
            // Task 64: was hardcoded to 0 (Document) regardless of the
            // page's real Folder layout -- harmless for Document pages
            // (`page.layout` is always unset -> `?? 0` either way) but wrong
            // for a Database container/primary-view page, which is Folder
            // ViewLayout.Grid (1). Matches the `page.layout ?? 0` convention
            // already used by this file's other Folder-tree routes.
            layout: page.layout ?? 0,
            extra: page.extra ?? null,
            children: [],
            has_children: false,
            is_published: false,
            is_private: false,
            created_at: page.created_at,
            last_edited_time: page.updated_at,
            parent_view_id: page.parent_view_id,
            workspace_id: access.workspace.id,
          },
          data: {
            encoded_collab: Array.from(encodedCollabState),
            row_data: {},
          },
        }), { 'cache-control': 'private, no-store' });
      }
      // Task 79: updatePage() (page-api.ts) -- PATCH /page-view/{id}, used
      // to rename a page, set its icon, and/or replace its `extra`
      // metadata (e.g. DatabaseTemplateButton.tsx's syncTemplateViewMetadata,
      // which sets extra.database_row_template/cover after saving a
      // template's title/icon/cover). No route existed for this at all
      // until now -- see this file's CORS_ALLOWED_METHODS comment for why
      // that was invisible in the server's own request log (the browser's
      // CORS preflight silently blocked every real PATCH before it was
      // ever sent, once PATCH was missing from Access-Control-Allow-Methods).
      if (method === 'PATCH' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'page-view' && parts[4] && parts.length === 5) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const pageId = parts[4];

        if (!validateUuid(pageId)) return error(res, 404, 'PAGE_NOT_FOUND', 'Page view not found');
        const b = await body(req);
        const changes = {};

        if ('name' in b) {
          if (typeof b.name !== 'string' || b.name.length > 200) {
            return error(res, 400, 'INVALID_INPUT', 'A valid page name (up to 200 characters) is required');
          }

          changes.title = b.name;
        }

        if ('icon' in b) {
          if (b.icon !== null && (!isPlainObject(b.icon) || typeof b.icon.ty !== 'number' || typeof b.icon.value !== 'string')) {
            return error(res, 400, 'INVALID_INPUT', 'icon must be null or {ty, value}');
          }

          changes.icon = b.icon;
        }

        if ('extra' in b) {
          if (b.extra !== null && !isPlainObject(b.extra)) return error(res, 400, 'INVALID_INPUT', 'extra must be null or an object');
          changes.extra = b.extra;
        }

        if (Object.keys(b).some((key) => !['name', 'icon', 'extra', 'is_locked'].includes(key))) {
          return error(res, 400, 'INVALID_INPUT', 'Unsupported fields in page update request');
        }

        const page = await store.getPage(pageId);

        if (!page || page.workspace_id !== access.workspace.id) return error(res, 404, 'PAGE_NOT_FOUND', 'Page view not found');
        if (Object.keys(changes).length === 0) return send(res, 200, appFlowyResponse(null));
        const updated = await store.updatePageMetadata(pageId, access.workspace.id, changes, now());

        if (!updated) return error(res, 404, 'PAGE_NOT_FOUND', 'Page view not found');
        broadcastFolderChanged(access.workspace.id);
        return send(res, 200, appFlowyResponse(null));
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'page-view' && parts[4] && parts[5] === 'update-name' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const pageId = parts[4];
        if (!validateUuid(pageId)) return error(res, 404, 'PAGE_NOT_FOUND', 'Page view not found');
        const b = await body(req);
        const title = b.name;
        if (typeof title !== 'string' || title.length > 200) {
          return error(res, 400, 'INVALID_INPUT', 'A valid page name (up to 200 characters) is required');
        }
        const page = await store.getPage(pageId);
        if (!page || page.workspace_id !== access.workspace.id || !page.parent_view_id) {
          return error(res, 404, 'PAGE_NOT_FOUND', 'Page view not found');
        }
        const updated = await store.updatePageTitle(pageId, access.workspace.id, title.trim(), now());
        if (!updated) return error(res, 404, 'PAGE_NOT_FOUND', 'Page view not found');
        broadcastFolderChanged(access.workspace.id);
        return send(res, 200, appFlowyResponse(null));
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'view' && parts[4] && parts.length === 5) {
        const depth = Number(url.searchParams.get('depth') ?? 1);
        if (!Number.isInteger(depth) || depth < 0 || depth > 50) return error(res, 400, 'INVALID_DEPTH', 'depth must be an integer between 0 and 50');
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const view = await buildViewNode(store, access.workspace, parts[4], depth);

        if (!view) return error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
        return send(res, 200, appFlowyResponse(view), { 'cache-control': 'private, no-store' });
      }
      // Task 79: AppFlowy-Web's getViews() (view-api.ts) -- a batch
      // subtree fetch the Outline/sidebar uses to resync several views'
      // children at once (loadViewChildrenBatch, useWorkspaceData.ts) after
      // a space/page is created or on cold navigation. The client already
      // falls back from POST to GET on a 404/405 (isUnsupportedPostRouteError),
      // so only GET is implemented here -- same response shape either way,
      // `{ views: View[] }`, reusing buildViewNode per requested id.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'views' && parts.length === 4) {
        const depth = Number(url.searchParams.get('depth') ?? 1);
        if (!Number.isInteger(depth) || depth < 0 || depth > 50) return error(res, 400, 'INVALID_DEPTH', 'depth must be an integer between 0 and 50');
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const viewIdsParam = url.searchParams.get('view_ids') ?? '';
        const viewIds = viewIdsParam.split(',').map((id) => id.trim()).filter(Boolean);

        if (viewIds.length > 256) return error(res, 400, 'INVALID_ATOMIC_REQUEST', 'Too many view_ids in one batch request');
        const views = (await Promise.all(viewIds.map((viewId) => buildViewNode(store, access.workspace, viewId, depth))))
          .filter((view) => view !== null);

        return send(res, 200, appFlowyResponse({ views }), { 'cache-control': 'private, no-store' });
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'view' && parts[4] && parts[5] === 'navigation' && parts.length === 6) {
        const depth = Number(url.searchParams.get('depth') ?? 0);
        if (!Number.isInteger(depth) || depth < 0 || depth > 50) return error(res, 400, 'INVALID_DEPTH', 'depth must be an integer between 0 and 50');
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const chain = await resolveNavigationAncestorChain(store, access.workspace, parts[4]);
        if (!chain) return error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
        const targetNode = chain[chain.length - 1];
        let navigation = navigationNodeView(targetNode, access.workspace, await buildNavigationTargetChildren(store, access.workspace, targetNode, depth));
        for (let index = chain.length - 2; index >= 0; index -= 1) {
          const ancestor = chain[index];
          let ancestorChildren = [navigation];
          // The web client builds a database's view tabs from its container's
          // children in this chain, so the container must list every view, not
          // just the one on the path to the target.
          if (ancestor.kind === 'page' && ancestor.record.extra?.is_database_container === true) {
            const onPathId = navigation.view_id;
            ancestorChildren = (await store.listPages(access.workspace.id))
              .filter((item) => item.parent_view_id === ancestor.record.id && !item.is_trashed)
              .sort((left, right) => pageSortKey(left) - pageSortKey(right) || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
              .map((item) => item.id === onPathId ? navigation : navigationNodeView({ kind: 'page', record: item }, access.workspace, []));
          }
          navigation = navigationNodeView(ancestor, access.workspace, ancestorChildren);
        }
        return send(res, 200, appFlowyResponse(navigation), { 'cache-control': 'private, no-store' });
      }
      // --- Inbox notifications (notification-api.ts) ---
      // Per-user inbox rows created by the producers below (comment mentions/replies,
      // page-mention, row-comment notification). Listing is always scoped to the caller.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'notifications' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const offset = parsePageParam(url.searchParams.get('offset'), 0, 0, 1_000_000);
        const limit = parsePageParam(url.searchParams.get('limit'), 50, 1, 500);
        if (offset === null || limit === null) return error(res, 400, 'INVALID_PAGINATION', 'offset and limit must be non-negative integers');
        const result = await store.listNotifications(access.workspace.id, access.user.id, {
          unreadOnly: url.searchParams.get('unread_only') === 'true',
          archived: url.searchParams.get('archived') === 'true',
          offset,
          limit,
        });
        return send(res, 200, appFlowyResponse({ notifications: result.notifications.map(notificationDto), has_more: result.has_more }), { 'cache-control': 'private, no-store' });
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'notifications' && parts[4] === 'unread-count' && parts.length === 5) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        return send(res, 200, appFlowyResponse({ unread_count: await store.countUnreadNotifications(access.workspace.id, access.user.id) }), { 'cache-control': 'private, no-store' });
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'notifications' &&
          ['read', 'read-all', 'archive', 'archive-all'].includes(parts[4]) && parts.length === 5) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const b = await body(req);
        let ids = null;
        if (parts[4] === 'read' || parts[4] === 'archive') {
          ids = parseUuidList(b.ids);
          if (!ids) return error(res, 400, 'INVALID_NOTIFICATION_IDS', 'ids must be an array of notification ids');
        }
        if (parts[4].startsWith('read')) await store.markNotificationsRead(access.workspace.id, access.user.id, ids, now());
        else await store.archiveNotifications(access.workspace.id, access.user.id, ids);
        return send(res, 200, appFlowyResponse(null));
      }
      // --- Inline document comments (inline-comment-api.ts) ---
      // Flat comments (replies carry reply_comment_id); the web client reloads the whole list
      // after every mutation, so the server list is the source of truth. The text anchor lives
      // in the document itself (`comment-ids` attribute), never here.
      if (parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'document' && parts[4] &&
          parts[5] === 'inline-comment' && parts.length <= 7) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const viewId = parts[4];
        const sub = parts[6] ?? null;
        const page = validateUuid(viewId) ? await store.getPage(viewId) : null;
        if (!page || page.workspace_id !== access.workspace.id) return error(res, 404, 'VIEW_NOT_FOUND', 'Page not found in this workspace');
        const workspaceId = access.workspace.id;
        const noStore = { 'cache-control': 'private, no-store' };

        if (method === 'GET' && sub === null) {
          const offset = parsePageParam(url.searchParams.get('offset'), 0, 0, 1_000_000);
          const limit = parsePageParam(url.searchParams.get('limit'), 100, 1, 200);
          if (offset === null || limit === null) return error(res, 400, 'INVALID_PAGINATION', 'offset and limit must be non-negative integers');
          const result = await store.listInlineComments(workspaceId, viewId, { offset, limit });
          const users = await loadUsersById(store, result.comments.map((comment) => comment.user_id));
          return send(res, 200, appFlowyResponse({
            comments: result.comments.map((comment) => inlineCommentDto(comment, users, access)),
            has_more: result.has_more,
            next_offset: result.has_more ? offset + result.comments.length : null,
          }), noStore);
        }

        if (method === 'POST' && (sub === null || sub === 'v2')) {
          const b = await body(req);
          const content = typeof b.content === 'string' ? b.content.trim() : '';
          if (!content || content.length > COMMENT_MAX_CHARS) return error(res, 400, 'INVALID_COMMENT', `content must be 1-${COMMENT_MAX_CHARS} characters`);
          if (b.block_id !== undefined && b.block_id !== null && (typeof b.block_id !== 'string' || b.block_id.length > 200)) return error(res, 400, 'INVALID_COMMENT', 'block_id must be a string');
          if (b.reply_comment_id !== undefined && b.reply_comment_id !== null && !validateUuid(b.reply_comment_id)) return error(res, 400, 'INVALID_COMMENT', 'reply_comment_id must be a comment id');
          if (b.mentioned_user_uuids !== undefined && (!Array.isArray(b.mentioned_user_uuids) || b.mentioned_user_uuids.length > 500)) return error(res, 400, 'INVALID_COMMENT', 'mentioned_user_uuids must be an array');
          const parent = b.reply_comment_id ? await store.getInlineComment(workspaceId, viewId, b.reply_comment_id) : null;
          if (b.reply_comment_id && !parent) return error(res, 400, 'INVALID_REPLY_TARGET', 'reply_comment_id must be a comment on this page');
          const timestamp = now();
          const comment = await store.createInlineComment({
            comment_id: id(),
            workspace_id: workspaceId,
            view_id: viewId,
            block_id: b.block_id ?? parent?.block_id ?? null,
            user_id: access.user.id,
            content,
            reply_comment_id: parent ? parent.comment_id : null,
            created_at: timestamp,
            updated_at: timestamp,
          });
          // Notifications never fail the comment itself; the comment is already durable.
          try {
            const mentioned = [];
            for (const candidate of [...new Set((b.mentioned_user_uuids ?? []).filter((value) => validateUuid(value)))].slice(0, MAX_MENTIONED_USERS)) {
              if (candidate !== access.user.id && await store.getMembership(workspaceId, candidate)) mentioned.push(candidate);
            }
            const recipients = new Map(mentioned.map((userId) => [userId, 'mention']));
            if (parent && !recipients.has(parent.user_id)) recipients.set(parent.user_id, 'comment_reply');
            if (page.creator_id && !recipients.has(page.creator_id)) recipients.set(page.creator_id, 'comment_on_page');
            const metadata = {
              actor_name: userLabel(access.user),
              page_name: page.title,
              page_path: await pageAncestorPath(store, access.workspace, page),
              ...(comment.block_id ? { block_id: comment.block_id } : {}),
              comment_id: comment.comment_id,
            };
            for (const [recipientId, type] of recipients) {
              await createInboxNotification(access, { recipientId, type, viewId, metadata });
            }
          } catch (notificationError) {
            console.error('Comment notification failed', notificationError);
          }
          broadcastCommentChanged(workspaceId, viewId);
          return send(res, 200, appFlowyResponse({ comment_id: comment.comment_id }));
        }

        if (method === 'DELETE' && sub === null) {
          const b = await body(req);
          if (!validateUuid(b.comment_id)) return error(res, 400, 'INVALID_COMMENT', 'comment_id is required');
          const comment = await store.getInlineComment(workspaceId, viewId, b.comment_id);
          if (!comment) return error(res, 404, 'COMMENT_NOT_FOUND', 'Comment not found');
          if (comment.user_id !== access.user.id && access.membership.role !== 'owner') return error(res, 403, 'COMMENT_DELETE_FORBIDDEN', 'Only the author or a workspace owner can delete a comment');
          await store.softDeleteInlineComment(workspaceId, viewId, comment.comment_id, now());
          broadcastCommentChanged(workspaceId, viewId);
          return send(res, 200, appFlowyResponse(null));
        }

        if (method === 'PUT' && sub === 'resolve') {
          const b = await body(req);
          if (!validateUuid(b.comment_id) || typeof b.is_resolved !== 'boolean') return error(res, 400, 'INVALID_COMMENT', 'comment_id and is_resolved are required');
          const updated = await store.setInlineCommentResolved(workspaceId, viewId, b.comment_id, b.is_resolved, now());
          if (!updated) return error(res, 404, 'COMMENT_NOT_FOUND', 'Comment not found');
          broadcastCommentChanged(workspaceId, viewId);
          return send(res, 200, appFlowyResponse(null));
        }

        // Only used when a user may comment but not edit the page. Every member of this
        // backend can edit, so the client never sends it; refuse rather than apply a Yjs
        // update that has not been validated to touch only `comment-ids`.
        if (method === 'PUT' && sub === 'anchor') {
          return error(res, 403, 'COMMENT_ANCHOR_UNSUPPORTED', 'Anchoring a comment without edit access is not supported');
        }

        if (sub === 'reaction' && method === 'GET') {
          const commentId = url.searchParams.get('comment_id');
          if (commentId && !validateUuid(commentId)) return error(res, 400, 'INVALID_COMMENT', 'comment_id must be a comment id');
          const reactions = await store.listInlineCommentReactions(workspaceId, viewId, commentId || null);
          const users = await loadUsersById(store, reactions.map((reaction) => reaction.user_id));
          const grouped = new Map();
          for (const reaction of reactions) {
            const key = `${reaction.comment_id}|${reaction.reaction_type}`;
            if (!grouped.has(key)) grouped.set(key, { reaction_type: reaction.reaction_type, react_users: [], comment_id: reaction.comment_id });
            const reactor = commentUser(users.get(reaction.user_id) ?? null);
            if (reactor) grouped.get(key).react_users.push(reactor);
          }
          return send(res, 200, appFlowyResponse({ reactions: [...grouped.values()] }), noStore);
        }

        if (sub === 'reaction' && (method === 'POST' || method === 'DELETE')) {
          const b = await body(req);
          const reactionType = typeof b.reaction_type === 'string' ? b.reaction_type.trim() : '';
          if (!reactionType || reactionType.length > REACTION_TYPE_MAX_CHARS || !validateUuid(b.comment_id)) return error(res, 400, 'INVALID_REACTION', 'reaction_type and comment_id are required');
          const comment = await store.getInlineComment(workspaceId, viewId, b.comment_id);
          if (!comment) return error(res, 404, 'COMMENT_NOT_FOUND', 'Comment not found');
          const reaction = { comment_id: comment.comment_id, reaction_type: reactionType, user_id: access.user.id };
          if (method === 'POST') {
            if (comment.is_deleted) return error(res, 400, 'COMMENT_DELETED', 'Cannot react to a deleted comment');
            await store.addInlineCommentReaction({ ...reaction, created_at: now() });
          } else {
            await store.removeInlineCommentReaction(reaction);
          }
          broadcastCommentChanged(workspaceId, viewId);
          return send(res, 200, appFlowyResponse(null));
        }

        return error(res, 404, 'NOT_FOUND', 'Route not found');
      }
      // updatePageMention (workspace-api.ts): a person was @-mentioned in a document or text cell,
      // or assigned in a Person cell. The client calls it after saving; the server only notifies.
      if (method === 'PUT' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'page-view' && parts[4] && parts[5] === 'page-mention' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const b = await body(req);
        const page = validateUuid(parts[4]) ? await store.getPage(parts[4]) : null;
        if (!page || page.workspace_id !== access.workspace.id) return error(res, 404, 'VIEW_NOT_FOUND', 'Page not found in this workspace');
        if (!validateUuid(b.person_id) || typeof b.require_notification !== 'boolean' ||
            (b.block_id !== undefined && b.block_id !== null && typeof b.block_id !== 'string') ||
            (b.row_id !== undefined && b.row_id !== null && typeof b.row_id !== 'string')) {
          return error(res, 400, 'INVALID_PAGE_MENTION', 'person_id and require_notification are required');
        }
        if (b.require_notification) {
          // A row set without a block, outside a row document, is a Person-cell assignment.
          const isAssignment = !!b.row_id && !b.block_id && b.is_row_document !== true;
          await createInboxNotification(access, {
            recipientId: b.person_id,
            type: isAssignment ? 'person_property_assigned' : 'mention',
            viewId: page.id,
            metadata: {
              actor_name: userLabel(access.user),
              page_name: typeof b.view_name === 'string' && b.view_name ? b.view_name.slice(0, 200) : page.title,
              page_path: await pageAncestorPath(store, access.workspace, page),
              ...(b.block_id ? { block_id: b.block_id } : {}),
              ...(b.row_id ? { row_id: b.row_id } : {}),
            },
          });
        }
        return send(res, 200, appFlowyResponse(null));
      }
      // notifyRowComment (row-comment-api.ts): row comments live in the row's Yjs doc, so the
      // server's only job is to tell the people who were mentioned or are in the thread.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'database' && parts[4] &&
          parts[5] === 'row' && parts[6] && parts[7] === 'comment' && parts[8] === 'notification' && parts.length === 9) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const b = await body(req);
        const page = validateUuid(parts[4]) ? await store.getPage(parts[4]) : null;
        if (!page || page.workspace_id !== access.workspace.id) return error(res, 404, 'VIEW_NOT_FOUND', 'Database view not found in this workspace');
        const mentioned = parseUuidList(b.mentioned_user_uuids ?? []);
        const participants = parseUuidList(b.reply_participant_uuids ?? []);
        if (!validateUuid(b.comment_id) || !mentioned || !participants || !validateUuid(parts[6])) {
          return error(res, 400, 'INVALID_ROW_COMMENT_NOTIFICATION', 'comment_id and uuid lists are required');
        }
        const recipients = new Map(mentioned.map((userId) => [userId, 'mention']));
        for (const userId of participants) if (!recipients.has(userId)) recipients.set(userId, 'comment_reply');
        const metadata = {
          actor_name: userLabel(access.user),
          page_name: typeof b.view_name === 'string' && b.view_name ? b.view_name.slice(0, 200) : page.title,
          page_path: await pageAncestorPath(store, access.workspace, page),
          row_id: parts[6],
          comment_id: b.comment_id,
        };
        for (const [recipientId, type] of recipients) await createInboxNotification(access, { recipientId, type, viewId: page.id, metadata });
        return send(res, 200, appFlowyResponse(null));
      }
      // mentionable-person (getMentionableUsers, workspace-api.ts) -- the
      // @-mention autocomplete list. Backed by real workspace membership,
      // not a stub: every member of this workspace is mentionable.
      // Who can open a page (the Share popover). Pages are not shared one by one here: everybody in the workspace has
      // access, so the list is the workspace's members and there are never groups. Both the v2 (GET) and the older
      // (POST) form of the request are answered, so the web app stops trying fallbacks.
      const shareDetails = async (access, pageId) => {
        const page = validateUuid(pageId) ? await store.getPage(pageId) : null;
        if (!page || page.workspace_id !== access.workspace.id) return null;
        const members = await store.listWorkspaceMembers(access.workspace.id);
        const levelOf = (role) => (role === 'owner' ? 50 : 30);
        return {
          view_id: page.id,
          target: { type: 'page', page_id: page.id },
          // Never "full access": that would show an invite box and per-person permission menus, and pages are not shared
          // one by one here. Everyone sees the list as read-only: who can open the page, and that they can edit it.
          current_user_permission: { object_id: page.id, object_type: 'page', access_level: 30, visible: true },
          shared_with: members.map(({ user, membership }) => ({
            email: user.email,
            name: userLabel(user),
            access_level: levelOf(membership.role),
            role: membership.role === 'owner' ? 'Owner' : 'Member',
            avatar_url: (isPlainObject(user.metadata) && typeof user.metadata.icon_url === 'string') ? user.metadata.icon_url : '',
            pending_invitation: false,
            access_source: 'inherited',
          })),
          groups: [],
        };
      };
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'sharing' && parts[2] === 'workspace' && parts[3] && parts[4] === 'access-details' && parts[5] === 'v2' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[3]);
        if (!access) return;
        const details = await shareDetails(access, url.searchParams.get('page_id'));
        if (!details) return error(res, 404, 'VIEW_NOT_FOUND', 'Page not found in this workspace');
        return send(res, 200, appFlowyResponse(details), { 'cache-control': 'private, no-store' });
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'sharing' && parts[2] === 'workspace' && parts[3] && parts[4] === 'view' && parts[5] && parts[6] === 'access-details' && parts.length === 7) {
        const access = await requireWorkspace(store, req, res, parts[3]);
        if (!access) return;
        const details = await shareDetails(access, parts[5]);
        if (!details) return error(res, 404, 'VIEW_NOT_FOUND', 'Page not found in this workspace');
        return send(res, 200, appFlowyResponse(details), { 'cache-control': 'private, no-store' });
      }
      // Groups do not exist (see enable_workspace_groups in server-info); answer "none" instead of an error.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'groups' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        return send(res, 200, appFlowyResponse({ groups: [] }), { 'cache-control': 'private, no-store' });
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'views' && parts[4] && parts[5] === 'group' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        return send(res, 200, appFlowyResponse({ groups: [] }), { 'cache-control': 'private, no-store' });
      }
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'mentionable-person' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const members = await store.listWorkspaceMembers(access.workspace.id);

        return send(res, 200, appFlowyResponse({
          persons: members.map(({ user, membership }) => mentionablePerson(user, membership)),
        }), { 'cache-control': 'private, no-store' });
      }
      // getWorkspaceMemberProfile (user-api.ts) -- the current user's own
      // mentionable-person entry for this workspace (same shape as one
      // entry of the list above).
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'workspace-profile' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        return send(res, 200, appFlowyResponse(mentionablePerson(access.user, access.membership)), { 'cache-control': 'private, no-store' });
      }
      // addRecentPages (workspace-api.ts) -- a lightweight "recently
      // visited" signal the client fires on navigation. Accepted and
      // persisted per-user so a future "Recent" surface has real data to
      // read, rather than silently discarded.
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'add-recent-pages' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const b = await body(req);
        const viewIds = Array.isArray(b.recent_view_ids) ? b.recent_view_ids.filter((id) => validateUuid(id)) : [];

        await store.addRecentPages(access.workspace.id, access.user.id, viewIds);
        return send(res, 200, appFlowyResponse(null));
      }
      // --- Task 53: favorites, trash, shared-with-me, database catalog ---
      // These back the AppFlowy-Web sidebar (Favorite.tsx / Trash panel / the
      // app-outline "shared with me" space), which previously 404'd and
      // blocked the sidebar from ever finishing its initial load.
      if (parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'favorite' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        if (method === 'GET') {
          const favorites = await store.listFavoritePages(access.workspace.id);
          const views = favorites
            .sort((a, b) => (b.favorited_at || '').localeCompare(a.favorited_at || ''))
            .map((page) => pageToFavoriteOrTrashView(page, access.workspace.id));
          return send(res, 200, appFlowyResponse({ views }), { 'cache-control': 'private, no-store' });
        }
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'page-view' && parts[4] && parts[5] === 'favorite' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const page = await store.getPage(parts[4]);
        if (!page || page.workspace_id !== access.workspace.id) return error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
        const b = await body(req);
        const isFavorite = b.is_favorite !== undefined ? !!b.is_favorite : true;
        const isPinned = b.is_pinned !== undefined ? !!b.is_pinned : true;
        await store.setPageFavorite(page.id, access.workspace.id, isFavorite, isPinned, now());
        return send(res, 200, appFlowyResponse(null));
      }
      if (parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'trash' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        if (method === 'GET') {
          const trashed = await store.listTrashedPages(access.workspace.id);
          const views = trashed
            .sort((a, b) => (b.trashed_at || '').localeCompare(a.trashed_at || ''))
            .map((page) => pageToFavoriteOrTrashView(page, access.workspace.id));
          return send(res, 200, appFlowyResponse({ views }), { 'cache-control': 'private, no-store' });
        }
      }
      if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'trash' && parts[4] && parts.length === 5) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const page = await store.getPage(parts[4]);
        if (!page || page.workspace_id !== access.workspace.id) return error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
        if (!page.is_trashed) return error(res, 409, 'NOT_IN_TRASH', 'View is not in the trash');
        await store.deletePagePermanently(page.id, access.workspace.id);
        return send(res, 200, appFlowyResponse(null));
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'page-view' && parts[4] && parts[5] === 'move-to-trash' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const page = await store.getPage(parts[4]);
        if (!page || page.workspace_id !== access.workspace.id) return error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
        await store.setPageTrashed(page.id, access.workspace.id, true, now());
        return send(res, 200, appFlowyResponse(null));
      }
      if (method === 'POST' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'page-view' && parts[4] && parts[5] === 'restore-from-trash' && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const page = await store.getPage(parts[4]);
        if (!page || page.workspace_id !== access.workspace.id) return error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
        await store.setPageTrashed(page.id, access.workspace.id, false, now());
        return send(res, 200, appFlowyResponse(null));
      }
      // Shared-with-me view tree. This backend has no sharing/collaborator
      // invitation feature yet (no data model for per-view grants), so an
      // empty tree is the honest minimal response: "nothing has been shared
      // with you," not a fabricated success for a write capability. The web
      // client already treats a failed/empty fetch here as non-fatal and
      // degrades gracefully (see useWorkspaceData.ts loadOutline), so this
      // only needs to stop being a 404.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'sharing' && parts[2] === 'workspace' && parts[3] && parts[4] === 'view' && parts[5] && parts.length === 6) {
        const access = await requireWorkspace(store, req, res, parts[3]);
        if (!access) return;
        if (parts[5] !== parts[3]) return error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
        return send(res, 200, appFlowyResponse({
          view_id: access.workspace.id,
          name: access.workspace.name,
          icon: null,
          layout: 0,
          extra: { is_space: true, is_hidden_space: true },
          children: [],
          has_children: false,
          is_published: false,
          is_private: false,
          created_at: access.workspace.created_at,
          last_edited_time: access.workspace.created_at,
          parent_view_id: null,
          workspace_id: access.workspace.id,
        }), { 'cache-control': 'private, no-store' });
      }
      // Task 64: real workspace Database catalog. This previously returned a
      // hardcoded `{ databases: [], has_more: false }` unconditionally in
      // BOTH storage modes -- a stub left over from before Task 61 added
      // real Database creation. That stub blocked any session that did not
      // itself just create a Database (fresh login, a second workspace
      // member's first visit) from discovering it at all: AppFlowy-Web's
      // `getDatabaseIdFromWorkspaceCatalog`/`getViewIdFromWorkspaceCatalog`
      // (src/application/services/js-services/workspace-database-catalog.ts)
      // depend on this exact endpoint as their server-authoritative source
      // whenever a Database's identity can't be resolved from an
      // already-cached Yjs doc or Folder-tree `extra.database_id` -- see
      // AppBusinessLayer.tsx's permission-probe comment: "The catalog is
      // PostgreSQL-first on the server and uses legacy metadata only as its
      // compatibility fallback." With the stub always empty, that fallback
      // path had nothing to resolve, and Task 63 confirmed the resulting
      // real-browser failure (fresh session 404s opening an existing
      // Database's primary view).
      //
      // `store.listWorkspaceDatabaseCatalog` (storage.js / postgres-storage.js)
      // derives the catalog read-only from the SAME page records Task 61's
      // createAtomicDatabasePage already writes (`extra.is_database_container`
      // + `extra.database_id`) -- see database-catalog.js for the exact
      // container/primary-view association rule and malformed-metadata
      // handling. No second Database registry, no new migration: Task 63
      // already proved these page rows are fully queryable in both modes.
      //
      // Pagination mirrors the frontend's actual contract
      // (getWorkspaceDatabaseListPage in view-api.ts): `offset`/`limit`
      // query params over the list of DATABASES (not views), default
      // limit 200 (WORKSPACE_DATABASE_LIST_PAGE_SIZE), `has_more` driven by
      // the real remaining count. Ordering is stable (container page
      // `created_at` then `id`, matching this file's existing Folder-tree
      // tie-break convention) so repeated requests against unchanged data
      // return identical pages.
      if (method === 'GET' && parts[0] === 'api' && parts[1] === 'workspace' && parts[2] && parts[3] === 'database' && parts.length === 4) {
        const access = await requireWorkspace(store, req, res, parts[2]);
        if (!access) return;
        const offsetParam = url.searchParams.get('offset');
        const limitParam = url.searchParams.get('limit');
        const offset = offsetParam === null ? 0 : Number(offsetParam);
        const limit = limitParam === null ? 200 : Number(limitParam);
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit <= 0 || limit > 1000) {
          return error(res, 400, 'INVALID_PAGINATION', 'offset must be a non-negative integer and limit must be an integer between 1 and 1000');
        }
        const catalog = await store.listWorkspaceDatabaseCatalog(access.workspace.id);
        const page = catalog.slice(offset, offset + limit);
        const hasMore = offset + page.length < catalog.length;
        return send(res, 200, appFlowyResponse({ databases: page, has_more: hasMore }), { 'cache-control': 'private, no-store' });
      }
      if (method === 'POST' && url.pathname === '/api/auth/register') {
        const b = await body(req); const email = String(b.email || '').trim().toLowerCase();
        if (!validateEmail(email) || !validatePassword(b.password)) return error(res, 400, 'INVALID_INPUT', 'Valid email and password (8-200 characters) required');
        const signupDenied = await signupDenial(email);
        if (signupDenied) return error(res, 403, 'SIGNUP_DISABLED', signupDenied);
        if (await store.getUserByEmail(email)) return error(res, 409, 'EMAIL_EXISTS', 'Email is already registered');
        const user = { id: id(), uid: createNumericUserId(), email, password_hash: await hashPassword(b.password), created_at: now() };
        const { workspace, membership } = createWorkspaceForUser(user, 'My Workspace');
        membership.workspace_id = workspace.id;
        try { await store.createUserWithWorkspace(user, workspace, membership); } catch (e) { if (e.code === '23505' && e.constraint === 'users_email_key') return error(res, 409, 'EMAIL_EXISTS', 'Email is already registered'); throw e; }
        await acceptInvitationsFor(user);
        return send(res, 201, { user: publicUser(user) });
      }
      if (method === 'POST' && url.pathname === '/api/auth/login') {
        const b = await body(req); const loginEmail = String(b.email || '').trim().toLowerCase();
        const loginKeys = throttleKeys(req, loginEmail); const loginGate = loginThrottle.check(loginKeys);
        if (!loginGate.allowed) return tooManyAttempts(res, loginGate.retryAfterSeconds);
        const user = await store.getUserByEmail(loginEmail);
        if (!user || !await verifyPassword(String(b.password || ''), user.password_hash)) { loginThrottle.fail(loginKeys); return error(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password'); }
        loginThrottle.clear([loginKeys[0]]);
        const token = issueToken(); const session = { user_id: user.id, created_at: now(), expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }; await store.saveSession(tokenHash(token), session);
        return send(res, 200, { access_token: token, token_type: 'Bearer', expires_at: session.expires_at, user: publicUser(user) });
      }
      if (method === 'POST' && url.pathname === '/api/auth/logout') { const user = await requireUser(store, req, res); if (!user) return; await store.revokeSession(tokenHash(bearer(req))); return send(res, 204, {}); }
      if (method === 'GET' && url.pathname === '/api/auth/me') { const user = await requireUser(store, req, res); if (!user) return; return send(res, 200, { user: publicUser(user) }); }
      if (method === 'POST' && url.pathname === '/api/workspaces') { const user = await requireUser(store, req, res); if (!user) return; const b = await body(req); const name = String(b.name || '').trim(); if (!name || name.length > 200) return error(res, 400, 'INVALID_INPUT', 'Workspace name is required'); const workspace = { id: id(), name, icon: '', database_storage_id: id(), created_at: now(), owner_id: user.id }; await store.createWorkspace(workspace, { workspace_id: workspace.id, user_id: user.id, role: 'owner', created_at: now() }); return send(res, 201, { workspace }); }
      if (method === 'GET' && url.pathname === '/api/workspaces') { const user = await requireUser(store, req, res); if (!user) return; return send(res, 200, { workspaces: await store.listWorkspaces(user.id) }); }
      if (parts[0] === 'api' && parts[1] === 'workspaces' && parts[2] && parts.length === 3 && method === 'GET') { const access = await requireWorkspace(store, req, res, parts[2]); if (!access) return; return send(res, 200, { workspace: access.workspace, membership: access.membership }); }
      if (parts[0] === 'api' && parts[1] === 'workspaces' && parts[2] && parts[3] === 'test-members' && method === 'POST') { const access = await requireWorkspace(store, req, res, parts[2]); if (!access) return; const environment = options.environment || process.env.NODE_ENV || 'development'; if (!['owner', 'admin'].includes(access.membership.role) || !['test', 'development'].includes(environment) || !devKeyMatches(req)) return error(res, 403, 'TEST_HELPER_DISABLED', 'Development membership helper denied'); const b = await body(req); const target = await store.findUserByEmail(String(b.email || '').trim().toLowerCase()); if (!target) return error(res, 404, 'USER_NOT_FOUND', 'Test user not found'); const membershipRecord = { workspace_id: parts[2], user_id: target.id, role: ['admin', 'member'].includes(b.role) ? b.role : 'member', created_at: now() }; await store.saveMembership(membershipRecord); return send(res, 201, { membership: membershipRecord }); }
      // Task 67: dev/test-only membership REVOCATION helper, gated identically
      // to the POST test-members helper above (owner/admin role + test/dev
      // environment + X-Development-Key). This backend has no product UI or
      // REST endpoint for removing a workspace member at all (confirmed by
      // Stage 2's inventory: only the POST helper above, which the frontend
      // itself never calls -- it is a test fixture, not a real feature). Real
      // membership revocation is therefore not a currently-supported product
      // capability; this exists solely so the security test suite and manual
      // verification can exercise "membership removed while connected" against
      // real persisted storage (JSON and Postgres) without inventing a product
      // feature outside this task's scope.
      if (parts[0] === 'api' && parts[1] === 'workspaces' && parts[2] && parts[3] === 'test-members' && parts.length === 4 && method === 'DELETE') { const access = await requireWorkspace(store, req, res, parts[2]); if (!access) return; const environment = options.environment || process.env.NODE_ENV || 'development'; if (!['owner', 'admin'].includes(access.membership.role) || !['test', 'development'].includes(environment) || !devKeyMatches(req)) return error(res, 403, 'TEST_HELPER_DISABLED', 'Development membership helper denied'); const targetEmail = String(url.searchParams.get('email') || '').trim().toLowerCase(); const target = targetEmail && await store.findUserByEmail(targetEmail); if (!target) return error(res, 404, 'USER_NOT_FOUND', 'Test user not found'); await store.deleteMembership(parts[2], target.id); return send(res, 200, appFlowyResponse(null)); }
      if (parts[0] === 'api' && parts[1] === 'workspaces' && parts[2] && parts[3] === 'pages') { const workspaceId = parts[2]; const access = await requireWorkspace(store, req, res, workspaceId); if (!access) return; if (method === 'POST' && parts.length === 4) { const b = await body(req); if (!String(b.title || '').trim() || !validateDocument(b.document)) return error(res, 400, 'INVALID_PAGE', 'Title and object document are required'); const page = { id: id(), workspace_id: workspaceId, title: String(b.title).trim(), document: b.document, schema_version: String(b.schema_version || 'appflowy-web-v1'), creator_id: access.user.id, version: 1, created_at: now(), updated_at: now() }; await store.createPage(page); return send(res, 201, { page }); } if (method === 'GET' && parts.length === 4) return send(res, 200, { pages: await store.listPages(workspaceId) }); }
      if (parts[0] === 'api' && parts[1] === 'pages' && parts[2]) { const page = await store.getPage(parts[2]); if (!page) return error(res, 404, 'NOT_FOUND', 'Page not found'); const access = await requireWorkspace(store, req, res, page.workspace_id); if (!access) return; if (method === 'GET') return send(res, 200, { page }); if (method === 'PUT') { const b = await body(req); const expected = Number(b.expected_version ?? req.headers['if-match']); if (!Number.isInteger(expected)) return error(res, 409, 'STALE_PAGE', 'Page version is stale'); if (!String(b.title ?? page.title).trim() || !validateDocument(b.document ?? page.document)) return error(res, 400, 'INVALID_PAGE', 'Invalid page update'); const updated = await store.updatePage(page.id, page.workspace_id, expected, { title: String(b.title ?? page.title).trim(), document: b.document ?? page.document, updated_at: now() }); if (!updated) return error(res, 409, 'STALE_PAGE', 'Page version is stale'); return send(res, 200, { page: updated }); } }
      return error(res, 404, 'NOT_FOUND', 'Route not found');
    } catch (e) {
      // Unlike the WebSocket admission handlers, this catch-all previously
      // swallowed every unexpected (non-e.status) error without logging it
      // -- a 500 here gave no trace of what actually failed (see the
      // move-to-trash persist-race incident this was added to diagnose).
      if (!e.status) console.error(`Unhandled error on ${method} ${url.pathname}`, e);
      if (url.pathname === '/token') {
        const status = e.status || 500;
        return goTrueError(
          res,
          status,
          status === 500 ? 'server_error' : 'invalid_request',
          status === 500 ? 'internal_error' : status === 413 ? 'request_body_too_large' : 'validation_failed',
          status === 500 ? 'Authentication request failed' : e.message
        );
      }
      return error(res, e.status || 500, e.status ? 'REQUEST_ERROR' : 'INTERNAL_ERROR', e.status ? e.message : 'Internal server error');
    }
  };
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: options.realtimeMaxFrameBytes ?? REALTIME_MAX_FRAME_BYTES, perMessageDeflate: false });
  const websocketPeers = new Set();
  // Task 79: a page rename/icon/extra update (PATCH page-view, update-name)
  // is NOT a Document/Database/DatabaseRow collab update -- it changes the
  // Folder tree's own metadata, which the sidebar/outline renders from a
  // separate, non-reactive fetch (useWorkspaceData.ts's outline state). Until
  // now nothing ever told a connected client that fetch had gone stale, so a
  // rename was only ever visible after a full page reload. The client
  // already listens for exactly this signal and has a no-op-safe fallback
  // for it: WorkspaceNotification.folderChanged with no outlineDiffJson
  // triggers a full `loadOutline()` (see useWorkspaceData.ts's
  // handleFolderOutlineChanged) -- so broadcasting the bare notification,
  // without implementing the optional JSON-patch diff optimization, is
  // sufficient to fix the staleness.
  // Routes call this after a tree change; delivery is coalesced by the folder notifier.
  function broadcastFolderChanged(workspaceId) {
    folderNotifier.notify(workspaceId);
  }
  function sendFolderChangedNow(workspaceId) {
    const frame = encodeMessage({ notification: { folderChanged: {} } });

    for (const peer of websocketPeers) {
      if (peer.readyState === 1 && peer.workspaceId === workspaceId) {
        try {
          peer.send(frame, { binary: true });
        } catch (peerSendError) {
          console.error('WebSocket folderChanged fan-out failed', peerSendError);
        }
      }
    }
  }
  function broadcastToWorkspace(workspaceId, notification) {
    const frame = encodeMessage({ notification });

    for (const peer of websocketPeers) {
      if (peer.readyState === 1 && peer.workspaceId === workspaceId) {
        try { peer.send(frame, { binary: true }); } catch (peerSendError) { console.error('WebSocket workspace notification fan-out failed', peerSendError); }
      }
    }
  }
  // Only sockets that already completed a SyncRequest are in websocketPeers; the web
  // client does that for the workspace database right after connecting.
  function pushToUser(workspaceId, userId, notification) {
    const frame = encodeMessage({ notification });

    for (const peer of websocketPeers) {
      if (peer.readyState === 1 && peer.workspaceId === workspaceId && peer.userId === userId) {
        try { peer.send(frame, { binary: true }); } catch (peerSendError) { console.error('WebSocket user notification push failed', peerSendError); }
      }
    }
  }
  // Pushes a server-originated Yjs diff (already persisted by the caller) to every peer subscribed to
  // exactly this workspace + collab type + object. Same frame shape as the browser-originated fan-out; one
  // failing peer never affects another peer or the persisted change.
  async function broadcastCollabUpdate({ workspaceId, collabType, objectId, update, accepted }) {
    if (!update?.byteLength) return;
    const frame = encodeMessage({ collabMessage: { objectId, collabType, update: {
      ...(accepted?.messageId ? { messageId: accepted.messageId } : {}),
      flags: 0,
      payload: update,
      ...(accepted?.collabVersion ? { version: accepted.collabVersion } : {}),
    } } });
    const key = subscriptionKey(workspaceId, collabType, objectId);

    for (const peer of websocketPeers) {
      if (peer.readyState === 1 && peer.workspaceId === workspaceId && peer.subscriptions?.has(key)) {
        try { peer.send(frame, { binary: true }); } catch (peerSendError) { console.error('WebSocket card fan-out failed', peerSendError); }
      }
    }
  }
  // Server-originated Database document changes (a new view, a new card) reach the creating tab
  // through its HTTP receipt; every other open tab needs the same Yjs update pushed to it.
  function broadcastDatabaseUpdate(workspaceId, databaseId, created) {
    if (created?.outcome !== 'applied' || !created.database_update?.byteLength) return;
    void broadcastCollabUpdate({
      workspaceId,
      collabType: 1,
      objectId: databaseId,
      update: created.database_update,
      accepted: { collabVersion: DATABASE_COLLAB_VERSION },
    }).catch((broadcastError) => console.error('database update fan-out failed', broadcastError));
  }
  function broadcastCommentChanged(workspaceId, viewId) {
    broadcastToWorkspace(workspaceId, { commentChanged: { workspaceId, viewId } });
  }
  // Creates one inbox notification for a workspace member and pushes it live. Returns null
  // (and creates nothing) for non-members, for the actor themself, or when the recipient
  // already has an identical unread one -- re-saving a mention must not spam the inbox.
  async function createInboxNotification(access, { recipientId, type, viewId, metadata }) {
    if (!recipientId || recipientId === access.user.id) return null;
    if (!(await store.getMembership(access.workspace.id, recipientId))) return null;
    const unread = await store.listNotifications(access.workspace.id, recipientId, { unreadOnly: true, limit: 200 });
    const same = (existing) => existing.type === type && (existing.view_id ?? null) === (viewId ?? null) &&
      ['block_id', 'row_id', 'comment_id'].every((key) => (existing.metadata?.[key] ?? null) === (metadata[key] ?? null));

    if (unread.notifications.some(same)) return null;
    const created = await store.createNotification({
      id: id(),
      workspace_id: access.workspace.id,
      recipient_user_id: recipientId,
      type,
      view_id: viewId ?? null,
      actor_uid: Number.isSafeInteger(Number(access.user.uid)) ? Number(access.user.uid) : null,
      metadata,
      created_at: now(),
    });

    emailNotification(access, { recipientId, type, viewId, metadata });
    pushToUser(access.workspace.id, recipientId, { inboxNotification: {
      id: created.id,
      type: created.type,
      ...(created.view_id ? { viewId: created.view_id } : {}),
      ...(created.actor_uid !== null && created.actor_uid !== undefined ? { actorUid: created.actor_uid } : {}),
      metadataJson: JSON.stringify(created.metadata ?? {}),
      createdAt: Math.floor(Date.parse(created.created_at) / 1000),
    } });
    return created;
  }
  // Task 77.2: fan-out routing identity. `websocket.objectId` is a single
  // slot holding the LAST object this connection successfully SyncRequested,
  // and it must stay that way because it is the admission check for incoming
  // updates (Tasks 71/76/76.1 depend on exactly that semantics). But a real
  // browser multiplexes several collab objects over one connection (a
  // Database plus one DatabaseRow per row, plus the page Document), so every
  // new SyncRequest overwrites the slot and the pre-existing
  // `peer.objectId === objectId` fan-out filter then silently stops matching
  // peers that are still legitimately subscribed to an earlier object --
  // the Task 77.1 defect. Fan-out is therefore routed off a per-connection
  // subscription SET instead, keyed by the full composite identity
  // (workspace + collab type + object) so a Database subscription can never
  // match a DatabaseRow one, nor cross a workspace boundary, even if an
  // object ID were ever reused across collab types. NUL is used as the key
  // delimiter because it cannot occur in a validated workspace/object id,
  // which keeps key construction collision-safe.
  const subscriptionKey = (workspaceId, collabType, objectId) => `${workspaceId}\u0000${collabType}\u0000${objectId}`;
  const handleUpgrade = async (req, socket, head) => {
    const wsRequestId = id();
    const reject = (status, message) => {
      if (socket.destroyed) return;
      const body = `${message}\n`;
      const phrases = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' };
      socket.end(`HTTP/1.1 ${status} ${phrases[status]}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      logApiEvent({ kind: 'ws_reject', request_id: wsRequestId, path: redactWsUrl(req.url), status, response_body: message });
    };

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      reject(400, 'Invalid WebSocket request');
      return;
    }

    // Support both the versioned route (`/ws/v2/{workspaceId}`, used by some
    // clients/tests) and the unversioned route (`/ws/{workspaceId}`, used by
    // AppFlowy-Web's real client per APPFLOWY_WS_BASE_URL). Both are aliased
    // into the exact same handshake/auth/collab implementation below -- no
    // protocol or behavior difference between them.
    const pathParts = url.pathname.split('/').filter(Boolean);
    let workspaceId;
    if (pathParts[0] === 'ws' && pathParts[1] === 'v2' && pathParts.length === 3) {
      workspaceId = pathParts[2];
    } else if (pathParts[0] === 'ws' && pathParts.length === 2) {
      workspaceId = pathParts[1];
    } else {
      reject(404, 'WebSocket route not found');
      return;
    }
    const accessToken = url.searchParams.get('token');
    const clientId = url.searchParams.get('clientId');
    const deviceId = url.searchParams.get('deviceId');
    if (
      !accessToken ||
      !clientId ||
      !/^\d+$/.test(clientId) ||
      !Number.isSafeInteger(Number(clientId)) ||
      Number(clientId) > 0xffff_ffff ||
      !deviceId ||
      deviceId.length > 128 ||
      url.searchParams.get('cv') !== '0.10.0' ||
      url.searchParams.get('cp') !== 'web'
    ) {
      reject(400, 'Invalid WebSocket connection parameters');
      return;
    }

    try {
      const user = await userByAccessToken(store, accessToken);
      if (!user) {
        reject(401, 'Invalid or expired session');
        return;
      }
      const workspace = await store.getWorkspace(workspaceId);
      const membership = workspace && await store.getMembership(workspaceId, user.id);
      if (!membership) {
        reject(403, 'Workspace access denied');
        return;
      }
      if (socket.destroyed) return;

      websocketServer.handleUpgrade(req, socket, head, (websocket) => {
        websocket.workspaceId = workspaceId;
        websocket.userId = user.id;
        websocket.accessToken = accessToken;
        websocket.objectId = null;
        // Task 77.2: every composite subscription this connection has been
        // admitted to, not just the active one. Populated only alongside the
        // existing `websocketPeers.add(websocket)` calls, i.e. only after a
        // SyncRequest has fully passed authorization and object admission.
        websocket.subscriptions = new Set();
        websocket.__logRequestId = wsRequestId;
        logApiEvent({ kind: 'ws_connect', request_id: wsRequestId, path: redactWsUrl(req.url), workspace_id: workspaceId, user_id: user.id });
        let messageQueue = Promise.resolve();
        // Task 67: bounded periodic session/membership revalidation.
        // processFrame's own per-inbound-message revalidation (below) only
        // ever runs when THIS socket sends another frame -- it closes a
        // revoked connection the next time it tries to sync/update/send
        // awareness, which is immediate for an active sender. It does
        // nothing for a socket that is idle on the send side and only ever
        // RECEIVES other peers' fan-out (Task 66's Document/Database/
        // DatabaseRow Update relay and the pre-existing awarenessUpdate
        // relay): such a socket could otherwise keep receiving other users'
        // live content indefinitely after its workspace membership is
        // revoked or its session is deleted/expired, exactly the residual
        // exposure Task 66 flagged and deferred to this task. This timer
        // re-runs the identical token+workspace+membership check on a fixed
        // interval, independent of inbound traffic, and on failure removes
        // the socket from `websocketPeers` SYNCHRONOUSLY (not deferred to
        // the async 'close' event) before calling close() -- so no fan-out
        // loop iteration that executes after this check can ever select a
        // revoked socket, even while its TCP close handshake is still in
        // flight. The documented residual window is bounded by
        // `wsRevalidationIntervalMs` (default below): a revoked, otherwise
        // idle peer can keep receiving fan-out for at most one interval.
        const revalidationIntervalMs = options.wsRevalidationIntervalMs ?? 15000;
        const revalidationTimer = setInterval(() => {
          (async () => {
            try {
              const revalidatedUser = await userByAccessToken(store, websocket.accessToken);
              const revalidatedWorkspace = revalidatedUser && await store.getWorkspace(websocket.workspaceId);
              const revalidatedMembership = revalidatedWorkspace && await store.getMembership(websocket.workspaceId, revalidatedUser.id);
              if (!revalidatedMembership) {
                websocketPeers.delete(websocket);
                // Task 77.2: drop the fan-out subscriptions in the same
                // synchronous step as the peer-registry removal, so a revoked
                // connection cannot be selected by any fan-out loop that runs
                // while its close handshake is still in flight -- on either
                // the registry membership test or the subscription test.
                websocket.subscriptions.clear();
                if (websocket.readyState === 0 || websocket.readyState === 1) {
                  websocket.close(1008, 'Workspace access revoked');
                }
              }
            } catch (revalidationError) {
              console.error('WebSocket periodic revalidation failed', revalidationError);
            }
          })();
        }, revalidationIntervalMs);
        const processFrame = async (data, isBinary) => {
          if (!isBinary) {
            if (data.toString() === 'echo') websocket.send('echo');
            else websocket.close(1003, 'Binary protobuf frames are required');
            return;
          }

          let message;
          try {
            message = decodeMessage(data);
          } catch {
            websocket.close(1002, 'Malformed protobuf frame');
            return;
          }
          const collabMessage = message.collabMessage;
          if (!collabMessage) {
            websocket.close(1003, 'Unsupported WebSocket message');
            return;
          }

          let current;
          let activeWorkspace;
          let activeMembership;
          try {
            current = await userByAccessToken(store, websocket.accessToken);
            activeWorkspace = current && await store.getWorkspace(websocket.workspaceId);
            activeMembership = current && activeWorkspace && await store.getMembership(websocket.workspaceId, current.id);
          } catch (authorizationError) {
            console.error('WebSocket authorization check failed', authorizationError);
            websocket.close(1011, 'Workspace authorization failed');
            return;
          }
          if (!activeMembership) {
            websocket.close(1008, 'Workspace access revoked');
            return;
          }
          if (collabMessage.collabType === 0) {
            const pageId = collabMessage.objectId;
            const page = await store.getPage(pageId);
            // Task 73: a row-detail-page Document is registered as an "orphaned" page
            // (parent_view_id is null, see POST /orphaned-view above) — it has no parent
            // Space to authorize against, so it is authorized by workspace membership
            // alone, same as every other route operating on it (favorite/trash/restore).
            // This does not relax the parent-Space check for any non-orphaned Document.
            const isOrphanedRowDocument = !!page && page.parent_view_id == null && !!page.extra?.row_document;
            const parentSpace = await governingSpace(store, websocket.workspaceId, page);
            const pageCollab = page && page.workspace_id === websocket.workspaceId &&
              (isOrphanedRowDocument ||
                (parentSpace?.workspace_id === websocket.workspaceId && isSupportedPublicSpacePermission(parentSpace.permission)))
              ? await store.getPageCollab(websocket.workspaceId, pageId)
              : null;
            if (!pageCollab) {
              websocket.close(1008, 'Document collaboration object is not authorized');
              return;
            }

            const collabVersion = pageCollab.collab_version;
            const serverRid = pageCollab.last_message_id || { timestamp: 0, counter: 0 };
            const sendDocumentFrame = (data) => {
              if (websocket.readyState === 1) {
                websocket.send(encodeMessage({ collabMessage: data }), { binary: true });
              }
            };
            const sendDocumentManifest = (stateVector, messageId = serverRid) => {
              sendDocumentFrame({
                objectId: pageId,
                collabType: 0,
                syncRequest: {
                  lastMessageId: messageId,
                  stateVector,
                  version: collabVersion,
                },
              });
            };

            if (collabMessage.syncRequest) {
              const request = collabMessage.syncRequest;
              if (!(request.stateVector instanceof Uint8Array)) {
                websocket.close(1002, 'Document SyncRequest state vector is required');
                return;
              }
              if (request.version && request.version !== collabVersion) {
                websocket.close(1008, 'Document collaboration version mismatch');
                return;
              }
              let clientStateVector;
              try {
                Y.decodeStateVector(request.stateVector);
                clientStateVector = request.stateVector;
              } catch {
                websocket.close(1002, 'Invalid Document state vector');
                return;
              }

              const doc = new Y.Doc({ guid: pageId });
              try {
                Y.applyUpdate(doc, pageCollab.doc_state);
                const missingUpdate = Y.encodeStateAsUpdate(doc, clientStateVector);
                if (!(missingUpdate.length === 2 && missingUpdate[0] === 0 && missingUpdate[1] === 0)) {
                  sendDocumentFrame({
                    objectId: pageId,
                    collabType: 0,
                    update: {
                      messageId: serverRid,
                      flags: 0,
                      payload: missingUpdate,
                      version: collabVersion,
                    },
                  });
                }
                websocket.objectId = pageId;
                websocketPeers.add(websocket);
                websocket.subscriptions.add(subscriptionKey(websocket.workspaceId, 0, pageId));
                sendDocumentManifest(Y.encodeStateVector(doc));
              } catch (syncError) {
                console.error('WebSocket Document sync failed', syncError);
                websocket.close(1011, 'Document sync failed');
              } finally {
                doc.destroy();
              }
              return;
            }

            if (collabMessage.update) {
              const update = collabMessage.update;
              if (websocket.objectId !== pageId) {
                websocket.close(1008, 'Document SyncRequest is required before updates');
                return;
              }
              if (update.messageId) {
                websocket.close(1008, 'Client cannot assign a Document message ID');
                return;
              }
              try {
                const accepted = await store.acceptPageCollabUpdate({
                  workspaceId: websocket.workspaceId,
                  pageId,
                  actorUserId: websocket.userId,
                  flags: update.flags,
                  payload: update.payload,
                  beforeStateVector: update.beforeStateVector,
                  collabVersion: update.version || collabVersion,
                  restoreId: update.databaseRestoreId || null,
                });
                const doc = new Y.Doc({ guid: pageId });
                try {
                  Y.applyUpdate(doc, accepted.documentState);
                  const acknowledgedUpdate = Y.encodeStateAsUpdate(
                    doc,
                    update.beforeStateVector?.byteLength ? update.beforeStateVector : new Uint8Array([0])
                  );
                  const documentUpdateMessage = {
                    objectId: pageId,
                    collabType: 0,
                    update: {
                      messageId: accepted.messageId,
                      flags: 0,
                      payload: acknowledgedUpdate,
                      version: accepted.collabVersion,
                    },
                  };
                  sendDocumentFrame(documentUpdateMessage);
                  if (isRedundantManifestReply(accepted, update)) return;
                  sendDocumentManifest(accepted.stateVector, accepted.lastMessageId);
                  // Task 66: fan out the already-persisted, already-acknowledged
                  // update to other connected peers on the same workspace+object,
                  // reusing the exact websocketPeers registry/filter the awareness
                  // relay below uses. Reached only after store.acceptPageCollabUpdate
                  // has durably accepted the update, so no peer ever receives an
                  // update storage rejected. Each peer send is isolated so one
                  // failed/slow peer can never block another peer or be mistaken for
                  // an admission failure on the sender's own connection.
                  const documentPeerFrame = encodeMessage({ collabMessage: documentUpdateMessage });
                  // Task 77.2: routed off the composite subscription set, not
                  // the single active-binding slot -- see subscriptionKey above.
                  const documentPeerKey = subscriptionKey(websocket.workspaceId, 0, pageId);
                  for (const peer of websocketPeers) {
                    if (peer !== websocket && peer.readyState === 1 &&
                        peer.workspaceId === websocket.workspaceId && peer.subscriptions?.has(documentPeerKey)) {
                      try {
                        peer.send(documentPeerFrame, { binary: true });
                      } catch (peerSendError) {
                        console.error('WebSocket Document peer fan-out failed', peerSendError);
                      }
                    }
                  }
                } finally {
                  doc.destroy();
                }
              } catch (admissionError) {
                if ([
                  'UNSUPPORTED_FLAGS',
                  'EMPTY_UPDATE',
                  'VERSION_MISMATCH',
                  'RESTORE_GENERATION_MISMATCH',
                  'INVALID_BEFORE_STATE_VECTOR',
                  'MISSING_CAUSAL_STATE',
                  'MALFORMED_YJS_UPDATE',
                  'UNRESOLVED_DEPENDENCY',
                ].includes(admissionError.code)) {
                  websocket.close(1008, 'Document update was rejected');
                } else {
                  console.error('WebSocket Document update admission failed', admissionError);
                  websocket.close(1011, 'Document update could not be persisted');
                }
              }
              return;
            }

            if (collabMessage.awarenessUpdate && websocket.objectId === pageId) {
              const frame = encodeMessage({ collabMessage });
              // Task 77.2: peer selection routed off the composite
              // subscription set for the same reason as the content fan-out
              // above. The sender-side gate (`websocket.objectId === pageId`)
              // is deliberately left exactly as it was, so no close-code or
              // admission behavior changes.
              const documentAwarenessKey = subscriptionKey(websocket.workspaceId, 0, pageId);
              for (const peer of websocketPeers) {
                if (peer !== websocket && peer.readyState === 1 &&
                    peer.workspaceId === websocket.workspaceId && peer.subscriptions?.has(documentAwarenessKey)) {
                  peer.send(frame, { binary: true });
                }
              }
              return;
            }

            websocket.close(1003, 'Unsupported Document collaboration message');
            return;
          }
          // Task 61 (Phase 1 Grid database foundation): Database collab
          // object (CollabType.Database = 1) admission. This mirrors the
          // Document branch above exactly -- same sync/update/awareness
          // message shapes, same persist-before-ack ordering
          // (store.acceptDatabaseCollabUpdate awaits durable write before any
          // ack frame is sent), same error-code-based 1008 vs 1011 close
          // reason split. It is purely additive: the Document branch above
          // and the WorkspaceDatabase gate below are both unchanged.
          if (collabMessage.collabType === 1) {
            const databaseId = collabMessage.objectId;
            const databaseCollab = await store.getDatabaseCollab(websocket.workspaceId, databaseId);
            if (!databaseCollab) {
              websocket.close(1008, 'Database collaboration object is not authorized');
              return;
            }

            const collabVersion = databaseCollab.collab_version;
            const serverRid = databaseCollab.last_message_id || { timestamp: 0, counter: 0 };
            const sendDatabaseFrame = (data) => {
              if (websocket.readyState === 1) {
                websocket.send(encodeMessage({ collabMessage: data }), { binary: true });
              }
            };
            const sendDatabaseManifest = (stateVector, messageId = serverRid) => {
              sendDatabaseFrame({
                objectId: databaseId,
                collabType: 1,
                syncRequest: {
                  lastMessageId: messageId,
                  stateVector,
                  version: collabVersion,
                },
              });
            };

            if (collabMessage.syncRequest) {
              const request = collabMessage.syncRequest;
              if (!(request.stateVector instanceof Uint8Array)) {
                websocket.close(1002, 'Database SyncRequest state vector is required');
                return;
              }
              if (request.version && request.version !== collabVersion) {
                websocket.close(1008, 'Database collaboration version mismatch');
                return;
              }
              let clientStateVector;
              try {
                Y.decodeStateVector(request.stateVector);
                clientStateVector = request.stateVector;
              } catch {
                websocket.close(1002, 'Invalid Database state vector');
                return;
              }

              const doc = new Y.Doc({ guid: databaseId });
              try {
                Y.applyUpdate(doc, databaseCollab.doc_state);
                const missingUpdate = Y.encodeStateAsUpdate(doc, clientStateVector);
                if (!(missingUpdate.length === 2 && missingUpdate[0] === 0 && missingUpdate[1] === 0)) {
                  sendDatabaseFrame({
                    objectId: databaseId,
                    collabType: 1,
                    update: {
                      messageId: serverRid,
                      flags: 0,
                      payload: missingUpdate,
                      version: collabVersion,
                    },
                  });
                }
                websocket.objectId = databaseId;
                websocketPeers.add(websocket);
                websocket.subscriptions.add(subscriptionKey(websocket.workspaceId, 1, databaseId));
                sendDatabaseManifest(Y.encodeStateVector(doc));
              } catch (syncError) {
                console.error('WebSocket Database sync failed', syncError);
                websocket.close(1011, 'Database sync failed');
              } finally {
                doc.destroy();
              }
              return;
            }

            if (collabMessage.update) {
              const update = collabMessage.update;
              if (websocket.objectId !== databaseId) {
                websocket.close(1008, 'Database SyncRequest is required before updates');
                return;
              }
              if (update.messageId) {
                websocket.close(1008, 'Client cannot assign a Database message ID');
                return;
              }
              try {
                const accepted = await store.acceptDatabaseCollabUpdate({
                  workspaceId: websocket.workspaceId,
                  databaseId,
                  flags: update.flags,
                  payload: update.payload,
                  beforeStateVector: update.beforeStateVector,
                  collabVersion: update.version || collabVersion,
                  restoreId: update.databaseRestoreId || null,
                });
                const doc = new Y.Doc({ guid: databaseId });
                try {
                  Y.applyUpdate(doc, accepted.documentState);
                  const acknowledgedUpdate = Y.encodeStateAsUpdate(
                    doc,
                    update.beforeStateVector?.byteLength ? update.beforeStateVector : new Uint8Array([0])
                  );
                  const databaseUpdateMessage = {
                    objectId: databaseId,
                    collabType: 1,
                    update: {
                      messageId: accepted.messageId,
                      flags: 0,
                      payload: acknowledgedUpdate,
                      version: accepted.collabVersion,
                    },
                  };
                  sendDatabaseFrame(databaseUpdateMessage);
                  if (isRedundantManifestReply(accepted, update)) return;
                  sendDatabaseManifest(accepted.stateVector, accepted.lastMessageId);
                  // Task 66: fan out the already-persisted, already-acknowledged
                  // update to other connected peers on the same workspace+object,
                  // reusing the exact websocketPeers registry/filter the awareness
                  // relay below uses. Reached only after
                  // store.acceptDatabaseCollabUpdate has durably accepted the
                  // update, so no peer ever receives an update storage rejected.
                  // Each peer send is isolated so one failed/slow peer can never
                  // block another peer or be mistaken for an admission failure on
                  // the sender's own connection.
                  const databasePeerFrame = encodeMessage({ collabMessage: databaseUpdateMessage });
                  // Task 77.2: routed off the composite subscription set, not
                  // the single active-binding slot -- see subscriptionKey above.
                  // This is the exact filter whose slot-drift caused the Task
                  // 77.1 defect (a browser viewing a Database also holds a
                  // DatabaseRow per row, so the slot was never the Database).
                  const databasePeerKey = subscriptionKey(websocket.workspaceId, 1, databaseId);
                  for (const peer of websocketPeers) {
                    if (peer !== websocket && peer.readyState === 1 &&
                        peer.workspaceId === websocket.workspaceId && peer.subscriptions?.has(databasePeerKey)) {
                      try {
                        peer.send(databasePeerFrame, { binary: true });
                      } catch (peerSendError) {
                        console.error('WebSocket Database peer fan-out failed', peerSendError);
                      }
                    }
                  }
                } finally {
                  doc.destroy();
                }
              } catch (admissionError) {
                if ([
                  'UNSUPPORTED_FLAGS',
                  'EMPTY_UPDATE',
                  'VERSION_MISMATCH',
                  'RESTORE_GENERATION_MISMATCH',
                  'INVALID_BEFORE_STATE_VECTOR',
                  'MISSING_CAUSAL_STATE',
                  'MALFORMED_YJS_UPDATE',
                  'UNRESOLVED_DEPENDENCY',
                ].includes(admissionError.code)) {
                  websocket.close(1008, 'Database update was rejected');
                } else {
                  console.error('WebSocket Database update admission failed', admissionError);
                  websocket.close(1011, 'Database update could not be persisted');
                }
              }
              return;
            }

            if (collabMessage.awarenessUpdate && websocket.objectId === databaseId) {
              const frame = encodeMessage({ collabMessage });
              // Task 77.2: see the Document awareness relay above.
              const databaseAwarenessKey = subscriptionKey(websocket.workspaceId, 1, databaseId);
              for (const peer of websocketPeers) {
                if (peer !== websocket && peer.readyState === 1 &&
                    peer.workspaceId === websocket.workspaceId && peer.subscriptions?.has(databaseAwarenessKey)) {
                  peer.send(frame, { binary: true });
                }
              }
              return;
            }

            websocket.close(1003, 'Unsupported Database collaboration message');
            return;
          }
          // Task 62 (minimum viable DatabaseRow lifecycle): DatabaseRow
          // collab object (CollabType.DatabaseRow = 4) admission. Mirrors
          // the Database branch immediately above exactly (same
          // sync/update/awareness message shapes, same persist-before-ack
          // ordering via store.acceptDatabaseRowCollabUpdate, same
          // 1008-vs-1011 close-code split). This is what lets
          // AppFlowy-Web's cell edits (writeCellToRow -- an ordinary Yjs
          // Y.Map mutation, verified in dispatch/row.ts and dispatch/cell.ts;
          // no bespoke cell-update server code, same finding as Task 61's
          // field add/rename) sync after a row is created. Purely
          // additive: the Document/Database branches above and the
          // WorkspaceDatabase gate below are all unchanged.
          if (collabMessage.collabType === 4) {
            const rowId = collabMessage.objectId;
            const rowCollab = await store.getDatabaseRowCollab(websocket.workspaceId, rowId);
            if (!rowCollab) {
              // Still rejected hard: this id belongs to something else in
              // this workspace (wrong collab type), or to a row that exists
              // but in a DIFFERENT workspace (cross-workspace access
              // attempt) -- silently admitting either would hide a real
              // client bug or a tenant-isolation probe. But an id that
              // doesn't exist as ANYTHING, anywhere, is different: a client
              // legitimately subscribes to a template's row before the
              // atomic row-document creation (POST .../v2/page-view/row-document)
              // has committed it, since that row and its live-sync binding
              // are set up together. Closing the whole multiplexed socket
              // for that ordinary same-workspace race (as this branch did
              // until Task 79) forced a reconnect storm that could tear down
              // the in-flight template editor UI along with it. Only drop
              // this one message for that specific case.
              const existsElsewhere = await store.getDatabaseCollab(websocket.workspaceId, rowId) ||
                await store.getPageCollab(websocket.workspaceId, rowId) ||
                await store.getDatabaseRowWorkspaceId(rowId);

              if (existsElsewhere) {
                websocket.close(1008, 'DatabaseRow collaboration object is not authorized');
              }

              return;
            }

            const rowCollabVersion = rowCollab.collab_version || undefined;
            const serverRowRid = rowCollab.last_message_id || { timestamp: 0, counter: 0 };
            const sendRowFrame = (data) => {
              if (websocket.readyState === 1) {
                websocket.send(encodeMessage({ collabMessage: data }), { binary: true });
              }
            };
            const sendRowManifest = (stateVector, messageId = serverRowRid) => {
              sendRowFrame({
                objectId: rowId,
                collabType: 4,
                syncRequest: {
                  lastMessageId: messageId,
                  stateVector,
                  version: rowCollabVersion,
                },
              });
            };

            if (collabMessage.syncRequest) {
              const request = collabMessage.syncRequest;
              if (!(request.stateVector instanceof Uint8Array)) {
                websocket.close(1002, 'DatabaseRow SyncRequest state vector is required');
                return;
              }
              if (request.version && rowCollabVersion && request.version !== rowCollabVersion) {
                websocket.close(1008, 'DatabaseRow collaboration version mismatch');
                return;
              }
              let clientStateVector;
              try {
                Y.decodeStateVector(request.stateVector);
                clientStateVector = request.stateVector;
              } catch {
                websocket.close(1002, 'Invalid DatabaseRow state vector');
                return;
              }

              const doc = new Y.Doc({ guid: rowId });
              try {
                Y.applyUpdate(doc, rowCollab.doc_state);
                const missingUpdate = Y.encodeStateAsUpdate(doc, clientStateVector);
                if (!(missingUpdate.length === 2 && missingUpdate[0] === 0 && missingUpdate[1] === 0)) {
                  sendRowFrame({
                    objectId: rowId,
                    collabType: 4,
                    update: {
                      messageId: serverRowRid,
                      flags: 0,
                      payload: missingUpdate,
                      version: rowCollabVersion,
                    },
                  });
                }
                websocket.objectId = rowId;
                websocketPeers.add(websocket);
                websocket.subscriptions.add(subscriptionKey(websocket.workspaceId, 4, rowId));
                sendRowManifest(Y.encodeStateVector(doc));
              } catch (syncError) {
                console.error('WebSocket DatabaseRow sync failed', syncError);
                websocket.close(1011, 'DatabaseRow sync failed');
              } finally {
                doc.destroy();
              }
              return;
            }

            if (collabMessage.update) {
              const update = collabMessage.update;
              if (websocket.objectId !== rowId) {
                websocket.close(1008, 'DatabaseRow SyncRequest is required before updates');
                return;
              }
              if (update.messageId) {
                websocket.close(1008, 'Client cannot assign a DatabaseRow message ID');
                return;
              }
              try {
                const accepted = await store.acceptDatabaseRowCollabUpdate({
                  workspaceId: websocket.workspaceId,
                  rowId,
                  actorUserId: websocket.userId,
                  flags: update.flags,
                  payload: update.payload,
                  beforeStateVector: update.beforeStateVector,
                  collabVersion: update.version || rowCollabVersion,
                  restoreId: null,
                });
                const doc = new Y.Doc({ guid: rowId });
                try {
                  Y.applyUpdate(doc, accepted.documentState);
                  const acknowledgedUpdate = Y.encodeStateAsUpdate(
                    doc,
                    update.beforeStateVector?.byteLength ? update.beforeStateVector : new Uint8Array([0])
                  );
                  const rowUpdateMessage = {
                    objectId: rowId,
                    collabType: 4,
                    update: {
                      messageId: accepted.messageId,
                      flags: 0,
                      payload: acknowledgedUpdate,
                      version: accepted.collabVersion || undefined,
                    },
                  };
                  sendRowFrame(rowUpdateMessage);
                  if (isRedundantManifestReply(accepted, update)) return;
                  sendRowManifest(accepted.stateVector, accepted.lastMessageId);
                  // Task 66: fan out the already-persisted, already-acknowledged
                  // update to other connected peers on the same workspace+object,
                  // reusing the exact websocketPeers registry/filter the awareness
                  // relay below uses. Reached only after
                  // store.acceptDatabaseRowCollabUpdate has durably accepted the
                  // update, so no peer ever receives an update storage rejected.
                  // Each peer send is isolated so one failed/slow peer can never
                  // block another peer or be mistaken for an admission failure on
                  // the sender's own connection.
                  const rowPeerFrame = encodeMessage({ collabMessage: rowUpdateMessage });
                  // Task 77.2: routed off the composite subscription set, not
                  // the single active-binding slot -- see subscriptionKey above.
                  const rowPeerKey = subscriptionKey(websocket.workspaceId, 4, rowId);
                  for (const peer of websocketPeers) {
                    if (peer !== websocket && peer.readyState === 1 &&
                        peer.workspaceId === websocket.workspaceId && peer.subscriptions?.has(rowPeerKey)) {
                      try {
                        peer.send(rowPeerFrame, { binary: true });
                      } catch (peerSendError) {
                        console.error('WebSocket DatabaseRow peer fan-out failed', peerSendError);
                      }
                    }
                  }
                } finally {
                  doc.destroy();
                }
              } catch (admissionError) {
                if ([
                  'UNSUPPORTED_FLAGS',
                  'EMPTY_UPDATE',
                  'VERSION_MISMATCH',
                  'RESTORE_GENERATION_MISMATCH',
                  'INVALID_BEFORE_STATE_VECTOR',
                  'MISSING_CAUSAL_STATE',
                  'MALFORMED_YJS_UPDATE',
                  'UNRESOLVED_DEPENDENCY',
                ].includes(admissionError.code)) {
                  websocket.close(1008, 'DatabaseRow update was rejected');
                } else {
                  console.error('WebSocket DatabaseRow update admission failed', admissionError);
                  websocket.close(1011, 'DatabaseRow update could not be persisted');
                }
              }
              return;
            }

            if (collabMessage.awarenessUpdate && websocket.objectId === rowId) {
              const frame = encodeMessage({ collabMessage });
              // Task 77.2: see the Document awareness relay above.
              const rowAwarenessKey = subscriptionKey(websocket.workspaceId, 4, rowId);
              for (const peer of websocketPeers) {
                if (peer !== websocket && peer.readyState === 1 &&
                    peer.workspaceId === websocket.workspaceId && peer.subscriptions?.has(rowAwarenessKey)) {
                  peer.send(frame, { binary: true });
                }
              }
              return;
            }

            websocket.close(1003, 'Unsupported DatabaseRow collaboration message');
            return;
          }
          if (
            collabMessage.collabType !== 2 ||
            collabMessage.objectId !== activeWorkspace.database_storage_id
          ) {
            websocket.close(1008, 'Collaboration object is not authorized');
            return;
          }

          if (collabMessage.syncRequest) {
            if (!(collabMessage.syncRequest.stateVector instanceof Uint8Array)) {
              websocket.close(1002, 'SyncRequest state vector is required');
              return;
            }
            try {
              const stored = await store.getOrCreateWorkspaceDatabaseCollab(
                websocket.workspaceId,
                activeWorkspace.database_storage_id,
                createDefaultWorkspaceDatabaseState(activeWorkspace.database_storage_id)
              );
              if (!stored) {
                websocket.close(1008, 'Collaboration object is not available');
                return;
              }

              const doc = new Y.Doc({ guid: stored.object_id });
              try {
                Y.applyUpdate(doc, stored.doc_state);
                const clientStateVector = collabMessage.syncRequest.stateVector;
                const missingUpdate = Y.encodeStateAsUpdate(doc, clientStateVector);
                if (!(missingUpdate.length === 2 && missingUpdate[0] === 0 && missingUpdate[1] === 0)) {
                  websocket.close(1008, 'State diff replay requires server Rid support');
                  return;
                }

                websocket.objectId = stored.object_id;
                websocketPeers.add(websocket);
                websocket.subscriptions.add(subscriptionKey(websocket.workspaceId, 2, stored.object_id));
                websocket.send(encodeMessage({
                  collabMessage: {
                    objectId: stored.object_id,
                    collabType: 2,
                    syncRequest: {
                      lastMessageId: { timestamp: 0, counter: 0 },
                      stateVector: Y.encodeStateVector(doc),
                    },
                  },
                }), { binary: true });
              } finally {
                doc.destroy();
              }
            } catch (syncError) {
              console.error('WebSocket WorkspaceDatabase sync failed', syncError);
              websocket.close(1011, 'WorkspaceDatabase sync failed');
            }
            return;
          }

          if (collabMessage.update) {
            websocket.close(1008, 'Realtime update admission is not implemented');
            return;
          }

          if (collabMessage.awarenessUpdate && websocket.objectId === collabMessage.objectId) {
            const frame = encodeMessage({ collabMessage });
            // Task 77.2: see the Document awareness relay above. collabType is
            // 2 here (WorkspaceDatabase), already enforced by the gate above.
            const workspaceDatabaseAwarenessKey = subscriptionKey(websocket.workspaceId, 2, websocket.objectId);
            for (const peer of websocketPeers) {
              if (peer !== websocket && peer.readyState === 1 &&
                  peer.workspaceId === websocket.workspaceId && peer.subscriptions?.has(workspaceDatabaseAwarenessKey)) {
                peer.send(frame, { binary: true });
              }
            }
            return;
          }

          websocket.close(1003, 'Unsupported collaboration message');
        };
        // Reorder window. Updates for one object can overtake what they depend on, because the web client sends
        // them from several paths (manifest replies, the queued-edit drain, the per-object bind SyncRequest):
        //  - an edit can arrive before the edit it builds on (before-state vector not satisfied yet), or
        //  - after a reconnect, a queued edit can arrive before its object's SyncRequest.
        // The server used to close the whole socket on the first such update, and the client's reconnect resent the
        // same queue in the same racy order, so the connection flapped every few seconds and edits never landed.
        // Now such an update is held briefly and applied once what it needs has arrived (the earlier edit was
        // accepted / the SyncRequest was processed). Nothing is ever stored without its dependencies, and an update
        // that stays unsatisfiable for the whole window closes the socket exactly as before.
        // A connection that bound an object earlier (SyncRequest accepted) may update it even if another object's
        // SyncRequest has since taken the shared `websocket.objectId` slot, so the slot is pointed back at it.
        const causalWindowMs = options.wsReorderWindowMs ?? 5000;
        const unboundWindowMs = options.wsUnboundWindowMs ?? options.wsReorderWindowMs ?? 3000;
        const maxHeldUpdates = 64;
        const heldUpdates = [];
        let heldTimer = null;
        const typeName = (collabType) => (collabType === 0 ? 'Document' : collabType === 1 ? 'Database' : 'DatabaseRow');
        const stateVectorCovers = (serverVector, beforeVector) => {
          try {
            const server = Y.decodeStateVector(serverVector);
            for (const [client, clock] of Y.decodeStateVector(beforeVector)) if ((server.get(client) ?? 0) < clock) return false;
          } catch { return true; } // malformed vectors take the normal (rejecting) path
          return true;
        };
        // null = ready to process now; otherwise why it has to wait.
        const waitingReason = async (data, isBinary) => {
          if (!isBinary) return null;
          let collab;
          try { collab = decodeMessage(data).collabMessage; } catch { return null; }
          const update = collab?.update;
          if (!update || ![0, 1, 4].includes(collab.collabType) || !collab.objectId) return null;
          if (!websocket.subscriptions.has(subscriptionKey(websocket.workspaceId, collab.collabType, collab.objectId))) {
            return { collabType: collab.collabType, windowMs: unboundWindowMs, closeReason: `${typeName(collab.collabType)} SyncRequest is required before updates` };
          }
          if (websocket.objectId !== collab.objectId) websocket.objectId = collab.objectId;
          if (!update.beforeStateVector?.byteLength) return null;
          const current = collab.collabType === 0 ? await store.getPageCollab(websocket.workspaceId, collab.objectId)
            : collab.collabType === 1 ? await store.getDatabaseCollab(websocket.workspaceId, collab.objectId)
              : await store.getDatabaseRowCollab(websocket.workspaceId, collab.objectId);
          if (!current?.state_vector || stateVectorCovers(current.state_vector, update.beforeStateVector)) return null;
          return { collabType: collab.collabType, windowMs: causalWindowMs, closeReason: `${typeName(collab.collabType)} update was rejected` };
        };
        const expireHeldUpdates = () => {
          heldTimer = null;
          const now = Date.now();
          const expired = heldUpdates.find((entry) => entry.at + entry.windowMs <= now);

          if (expired) {
            heldUpdates.length = 0;
            websocket.close(1008, expired.closeReason);
          } else if (heldUpdates.length) heldTimer = setTimeout(expireHeldUpdates, 250);
        };
        const holdIfWaiting = async (data, isBinary) => {
          if (heldUpdates.length >= maxHeldUpdates) return false;
          let reason;
          try { reason = await waitingReason(data, isBinary); } catch { return false; }
          if (!reason) return false;
          heldUpdates.push({ data, isBinary, at: Date.now(), windowMs: reason.windowMs, closeReason: reason.closeReason });
          if (!heldTimer) heldTimer = setTimeout(expireHeldUpdates, 250);
          return true;
        };
        const replayHeldUpdates = async () => {
          let progressed = true;
          while (heldUpdates.length && progressed && websocket.readyState === 1) {
            progressed = false;
            for (let index = 0; index < heldUpdates.length; index += 1) {
              let stillWaiting = null;
              try { stillWaiting = await waitingReason(heldUpdates[index].data, heldUpdates[index].isBinary); } catch { /* process it normally */ }
              if (stillWaiting) continue;
              const [entry] = heldUpdates.splice(index, 1);
              await processFrame(entry.data, entry.isBinary);
              progressed = true;
              break;
            }
          }
          if (!heldUpdates.length && heldTimer) { clearTimeout(heldTimer); heldTimer = null; }
        };
        websocket.on('message', (data, isBinary) => {
          messageQueue = messageQueue.then(async () => {
            if (await holdIfWaiting(data, isBinary)) return;
            await processFrame(data, isBinary);
            if (heldUpdates.length) await replayHeldUpdates();
          }).catch((frameError) => {
            console.error('WebSocket message processing failed', frameError);
            websocket.close(1011, 'WebSocket message processing failed');
          });
        });
        // Task 77.2: both termination paths clear the subscription set
        // alongside the pre-existing peer-registry removal. Removal from
        // `websocketPeers` alone already makes the socket unreachable by
        // fan-out (every loop iterates that registry), so clearing is not
        // required for correctness; it is done anyway so the per-connection
        // set cannot outlive the connection and no stale composite key is
        // retained once the socket is gone.
        websocket.on('close', (code, reasonBuffer) => {
          logApiEvent({ kind: 'ws_close', request_id: websocket.__logRequestId, workspace_id: workspaceId, user_id: user.id, status: code, response_body: reasonBuffer?.toString() || undefined });
          clearInterval(revalidationTimer); websocketPeers.delete(websocket); websocket.subscriptions.clear();
          if (heldTimer) { clearTimeout(heldTimer); heldTimer = null; }
          heldUpdates.length = 0;
        });
        websocket.on('error', (websocketError) => {
          console.error('WebSocket connection error', websocketError);
          logApiEvent({ kind: 'ws_error', request_id: websocket.__logRequestId, workspace_id: workspaceId, user_id: user.id, response_body: websocketError.message });
          clearInterval(revalidationTimer);
          websocketPeers.delete(websocket);
          websocket.subscriptions.clear();
        });
      });
    } catch (upgradeError) {
      console.error('WebSocket upgrade failed', upgradeError);
      reject(500, 'WebSocket upgrade failed');
    }
  };
  return { store, handler, handleUpgrade, websocketServer, searchIndex, pageVersioner, cardHistory };
}
export async function startServer(options = {}) {
  const app = await createApp(options);
  const server = http.createServer((req, res) => void app.handler(req, res));
  server.on('upgrade', (req, socket, head) => void app.handleUpgrade(req, socket, head));
  server.on('close', () => { app.pageVersioner.close(); app.cardHistory.close(); app.websocketServer.close(); });
  await new Promise((resolve) => server.listen(options.port ?? config.port, options.host ?? config.host, resolve));
  return { server, app, address: server.address() };
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const running = await startServer();

  console.log(`Independent backend listening on http://${running.address.address}:${running.address.port}`);
  // A graceful stop saves the automatic versions that were still waiting for their quiet period.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void Promise.all([running.app.pageVersioner.flush(), running.app.cardHistory.flush()]).catch(() => undefined).finally(() => process.exit(0));
    });
  }
}
