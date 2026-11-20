# Light MCP v1 - implementation report

Each phase adds its own section. This file is local documentation: the backend directory is not a Git repository, so it is not tracked.

## Phase 6: Agent access panel

Status: **built and tested in the web client; backend routes not yet available, so the panel has only been exercised against mocked responses.**

### What was built (web client, `/Volumes/work disk/Codes/Tracker/AppFlowy-Web`)
Settings > **Agent access (MCP)**, owner-only like the AI panel:
- Explanation of what agents can do (list databases, read cards; with write access create, update, move, archive, restore) and a warning that a token carries its creator's workspace access and should be treated like a password; card text is untrusted.
- Create form: name (1-80), access (Read-only default / Read & write), expiry (Never, 7, 30, 90, 365 days). The name is trimmed; the button is disabled without a name.
- One-time result card: token in a read-only field with Copy (clipboard + toast); "will not be shown again" warning; tabbed ready-to-paste configuration generated from the real MCP URL and token for **Claude Code** (`claude mcp add --transport http ...`, a `.mcp.json` using an environment variable, and the export line), **Cursor** (`mcp.json` with `${env:APPFLOWY_MCP_TOKEN}` and the export line) and **Claude Desktop** (stdio entry running `node /path/to/scripts/mcp-stdio-shim.mjs` with `MCP_URL`/`MCP_TOKEN`, plus a note that the shim lives in the backend repo at `scripts/mcp-stdio-shim.mjs`); each block has its own Copy button; a note says client compatibility is still being verified. The secret exists only in component state: **Done** or leaving the panel discards it; it is never written to storage or logged.
- Token list: name, scope badge, created date, last used ("Never used" or relative), expiry, status Active / Expired / Revoked; expired and revoked rows are muted; confirmed Revoke (no button on revoked rows); empty, loading and error-with-retry states.
- MCP URL = `defaultConfig.baseURL` (the configured API base, the same source the app's other pages use) without trailing slashes + `/mcp`.

### Backend contract the panel codes against
- `POST /api/workspace/{id}/agent-tokens` `{name, scope: 'read'|'write', expires_in_days?: number|null}` -> `{id, name, scope, token, created_at, expires_at}` (secret only here)
- `GET /api/workspace/{id}/agent-tokens` -> `{tokens: [{id, name, scope, created_at, last_used_at, expires_at, revoked, expired}]}`
- `DELETE /api/workspace/{id}/agent-tokens/{tokenId}` -> `{id, revoked: true}`
Owner/admin enforcement is the backend's job; the panel only hides itself for non-owners.

### Files changed
New: `src/application/services/js-services/http/agent-tokens-api.ts`, `src/application/services/domains/agent-tokens.ts`, `src/utils/agent-access.ts`, `src/components/app/settings/AgentAccessPanel.tsx`, `src/components/app/settings/agent-access/snippets.ts`, and tests `http/__tests__/agent-tokens-api.test.ts`, `settings/__tests__/AgentAccessPanel.test.tsx`, `settings/__tests__/Settings.agentAccess.test.tsx`, `settings/agent-access/__tests__/snippets.test.ts`.
Edited (small anchored changes): `src/application/types.ts` (`SettingMenuItem.AGENT_ACCESS`), `src/application/services/domains/index.ts`, `src/components/app/settings/SettingMenu.tsx`, `src/components/app/settings/Settings.tsx`, `src/@types/translations/en.json` (`settings.agentAccess.*`).

### Test classification
| Group | Result |
|---|---|
| Unit: request shapes (list/create incl. null expiry/revoke) | **Passed** |
| Unit: snippet generation (URL normalisation, exact Claude Code command, token kept out of `.mcp.json`/Cursor JSON, Desktop stdio entry, valid JSON) | **Passed** |
| Component: list rendering, muted expired/revoked rows, revoke button rules, empty and error/retry states, create payloads (default read + null expiry, write + 30 days, trimmed name, disabled without name) | **Passed** |
| Component: secret shown once, copy, per-client snippets with the real URL/token, secret gone after Done and after reopening, secret absent from storage/console, entity-safe rendering of names and URLs, revoke needs confirmation (cancel does nothing), failure toasts | **Passed** |
| Component: Settings menu visibility (owner / recorded owner without role shows; member and guest hidden) | **Passed** |
| Whole `src/components/app/settings` suite plus the new API test | **Passed** (18 suites, 156 tests) |
| ESLint on touched files | **Passed** (only "ignored test file" notices) |
| tsc on touched source files | **Passed** (no errors; the usual jest-typing noise in test files is pre-existing) |
| Live, real UI in dark mode, **mocked backend** (agent-token calls intercepted with `page.route`; login, workspace menu and Settings dialog are real; dev web :3000, backend :8787) | **Passed**: menu item appears for the owner; list, create (write + 30 days), result card, copy to the real clipboard, Claude Code / Cursor / Claude Desktop tabs, Done removes the secret from the page, confirmed revoke marks the row Revoked and removes its button, reopening shows no secret; no page errors |
| Against the real backend token routes | **Passed in acceptance** (real UI + real routes on an isolated stack and on the dev stack; see LIGHT_MCP_ACCEPTANCE_REPORT.md, section 1). Originally 'Not tested' when this phase was written. |
| Real MCP client connection with a generated snippet (Claude Code, Cursor, Claude Desktop) | **Not tested**; the panel states that compatibility is still being verified |

### Bugs found during live verification (fixed)
- i18next escaped interpolated values, so the endpoint appeared as `http:&#x2F;&#x2F;localhost:8787&#x2F;mcp` and token names with quotes or apostrophes would have shown HTML entities. All user- or system-supplied interpolations (name, URL, dates) now pass `interpolation: { escapeValue: false }` (React already escapes the output); covered by a regression test whose i18n mock escapes like the real library.
- The secret field was too narrow; it now fills the row.

### Caveats
- The panel is owner-only on the client (the client has no admin role); the backend contract says owner/admin, so admins will not see it.
- After creating a token, the access and expiry choices stay selected for the next token (the name resets); reopening the panel resets everything.
- Compatibility with each MCP client is deliberately not claimed.
- The Claude Desktop snippet needs the shim script from the backend repo (Phase 5) at a path the user edits by hand.

## Phase 4-5: MCP protocol module and stdio shim

Status: **built and tested in isolation (fake card service, fake authenticator, real HTTP, real stdio process).** *Superseded: wired into `server.js` in the Integration phase below, and exercised with a real MCP client (the official MCP Inspector CLI v2.13.0, directly and through the stdio shim) in the acceptance run; see LIGHT_MCP_ACCEPTANCE_REPORT.md.* Claude Code, Cursor and Claude Desktop themselves remain untested.

### Files (all new; no shared file was edited)
- `mcp.js`: `createMcpHandler({ cards, authenticate, audit, limits, allowedOrigins, now, serverInfo, logger })` returning `async handle(req, res)` for the `/mcp` endpoint.
- `mcp-tools.js`: the nine tool definitions (schemas, annotations, scope) and `executeTool`.
- `scripts/mcp-stdio-shim.mjs`: stdio to HTTP bridge (about 140 lines, no dependencies).
- Tests: `test/mcp-protocol.test.js` (15), `test/mcp-tools.test.js` (16), `test/mcp-security.test.js` (11), `test/mcp-shim.test.js` (11); helper `test/helpers/mcp-test-kit.js` (independent JSON Schema validator, fake card service with call spies, HTTP harness).

### Protocol behaviour (verified against the live spec pages unless marked)
Both profiles call the same tool table; the profile is chosen per request: a request is MODERN when `params._meta["io.modelcontextprotocol/protocolVersion"]` is present or the `MCP-Protocol-Version` header is >= 2026-07-28; `initialize` is always LEGACY.

| Topic | Implementation | Source |
|---|---|---|
| Endpoint | POST only; GET/DELETE/PUT/PATCH/HEAD/OPTIONS -> 405 `Allow: POST`; `Mcp-Session-Id` / `Last-Event-ID` ignored, never issued | 2026-07-28 streamable-http "Earlier revisions"; 2025-06-18/11-25 (GET may be 405, sessions optional, DELETE may be 405) |
| Body | exactly one JSON-RPC request or notification; batches -> 400 `-32600`; notifications (no `id`) -> 202 empty body | all three revisions |
| Origin | present and not allow-listed (or loopback on a loopback socket) -> 403; checked before authentication | all revisions: MUST validate, 403 |
| MODERN headers | `MCP-Protocol-Version` must equal `_meta` version, `Mcp-Method` must equal the body method, `Mcp-Name` (base64 sentinel decoded) must equal `params.name` for `tools/call`; any miss -> 400 `-32020` HeaderMismatch | 2026-07-28 streamable-http "Request Metadata", "Server Validation" |
| Unsupported version | 400 `-32022` with `data.supported = ["2026-07-28","2025-11-25","2025-06-18"]` and `data.requested` | 2026-07-28 versioning |
| Unknown modern method | 404 `-32601` | 2026-07-28 streamable-http |
| `server/discover` | `resultType:"complete"`, `supportedVersions:["2026-07-28"]`, `capabilities:{tools:{}}`, `_meta["io.modelcontextprotocol/serverInfo"]`, `instructions`, `ttlMs`, `cacheScope` | 2026-07-28 discover |
| Modern results | carry `resultType:"complete"`; `tools/list` also `ttlMs`/`cacheScope` | 2026-07-28 tools |
| LEGACY | `initialize` echoes a supported version (2025-11-25, 2025-06-18) else answers with our latest (2025-11-25); `notifications/initialized` 202; `ping` -> `{}`; no `resultType`; JSON-RPC errors over HTTP 200; unsupported `MCP-Protocol-Version` header -> 400; missing header accepted | 2025-11-25 lifecycle + transports; 2025-06-18 transports |
| Tool errors | unknown tool and malformed `tools/call` params -> JSON-RPC `-32602` (HTTP 400 modern, 200 legacy); invalid arguments, scope refusal and CardError -> `isError:true` results the model can act on | 2026-07-28 tools "Error Handling" |
| HTTP status rule | 400 for -32700/-32600/-32602/-32020/-32022, 404 for modern -32601, 401/403 auth, 413 size, 415/406 content negotiation, 429 rate limit, 500 `-32603` generic | partly spec-mandated (-32020/-32022/-32601); the rest is our convention |

### Decisions that differ from, or go beyond, the brief
1. **Error results carry no `structuredContent`.** The brief asked for `structuredContent:{error:{...}}`. The spec says a server that declares an `outputSchema` MUST return conforming structured results and gives no explicit exemption for `isError` results; its own error example has no `structuredContent`. So errors return a text block (`Error (CODE): message` plus `Details: {...}` for AMBIGUOUS/INVALID_INPUT, e.g. valid options) and no `structuredContent`; a test asserts this.
2. **No top-level `anyOf` in `update_card`'s inputSchema.** Some clients/APIs reject top-level `anyOf/oneOf/allOf`; "title and/or fields" is enforced in the handler instead (tested: no tool schema has those keywords).
3. **Invalid arguments are tool errors, not protocol errors**, per the spec's tool error-handling section (input validation errors are execution errors); unknown tools and malformed requests are protocol errors.
4. **Scope is checked before arguments**, so a read token learns nothing about write schemas, and before the card service is touched.
5. All nine tools are listed for every token (`tools/list` may vary by authorization but we keep it deterministic); write tools refuse at call time with a clear "token is read-only" error and an audit record.
6. `tools/list` returns one page (cursor accepted and ignored, no `nextCursor`).
7. Legacy clients' JSON-RPC *responses* are rejected with 400 (we never send server-to-client requests). Legacy 2025-03-26 (which allowed batches) is not claimed.
8. `limit` default (25) is applied by the tool layer; the card service must cap at 100. `confirm` is forwarded to the service only as `true`.

### Not verified (honest list)
- `cacheScope` allowed values (assumed `public`/`private`; the discover example uses `public`) and `ttlMs` semantics: the caching utility page was not fetched.
- `resultType:"complete"` on `ping` is assumed (shown for discover, tools/list, tools/call).
- Server-side `Accept` handling is not mandated by the spec; we reject only an `Accept` that excludes JSON (406) and accept a missing one.
- Whether Claude Code, Cursor or Claude Desktop actually send the modern or legacy profile, and whether they accept our results/schemas, is unknown (no real client used).
- The 2025-03-26 and 2024-11-05 revisions were not checked.

### Interfaces assumed from the card service (`cards.js` fork must match)
Call shapes: `listDatabases({workspaceId})`, `getDatabase({workspaceId, databaseId})`, `listCards({workspaceId, databaseId, viewId, column, query, limit, cursor})`, `getCard({workspaceId, cardId})`, `createCard({workspaceId, userId, tokenId, databaseId, title, column, fields, idempotencyKey})`, `updateCard({workspaceId, userId, cardId, title, fields})`, `moveCard({workspaceId, userId, cardId, column, viewId, beforeCardId})`, `archiveCard`/`restoreCard({workspaceId, userId, cardId, confirm:true})`.
Results the tool layer tolerates: `listDatabases` -> array or `{databases}` (each `database_id|id`, `name`, optional `workspace_id`/`has_board`, `views[{view_id|id,name,layout}]`); `getDatabase` -> `{database}` or the database object (`database_id|id` and `name` required, everything else, e.g. `fields`, `title_field`, `boards[{view_id,name,grouping_field,columns[{id,name,color,card_count}]}]`, passed through); `listCards` -> `{cards, next_cursor|null}`; card-returning calls -> a card or `{card}`; `createCard` -> `{card, replayed}`; `moveCard` -> `{card, order_changed}`. A card needs `id`; missing `database_id`, `database_name`, `title`, `column`, `column_id`, `fields`, `archived`, `created_at`, `updated_at` are defaulted so output always conforms to the declared outputSchema.
Errors: throw an Error with `name === 'CardError'` or a `code` in `INVALID_INPUT, NOT_FOUND, AMBIGUOUS, CONFLICT, UNSUPPORTED, PARTIAL_FAILURE, FORBIDDEN`, a readable `message`, and JSON-serialisable `details`. Anything else becomes a generic `-32603` and is logged server-side only.
`authenticate(req)` must resolve `{tokenId, userId, workspaceId, scope:'read'|'write'}` or throw an error with `.status` 401 or 403 (message is returned to the client with the bearer token scrubbed).

### Integration notes: proposed `server.js` diff (not applied)
```js
// imports
import { createMcpHandler } from './mcp.js';
// plus the card service and token authenticator from the other phases, for example:
// import { createCardService } from './cards.js';
// import { authenticateAgentToken } from './agent-tokens.js';

// inside createApp(), after `store`, the WebSocket helpers and aiRoutes exist:
const mcpHandler = createMcpHandler({
  cards: createCardService({ store, broadcastCollabUpdate }),          // names per the cards.js fork
  authenticate: (req) => authenticateAgentToken({ store, req }),       // see contract above; throws {status, message}
  audit: (record) => logApiEvent({ kind: 'mcp_call', ...record }),     // one record per tools/call, no content or secrets
  allowedOrigins: corsAllowedOrigins,
  limits: { maxBodyBytes: 256 * 1024, ratePerMinute: 120, callTimeoutMs: 30000 },
});

// in `handler`, right after res.setHeader('X-Request-Id', ...) and BEFORE applyCorsHeaders(...) and the OPTIONS block:
if (url.pathname === '/mcp') {
  await mcpHandler(req, res);
  logApiResponse(res, res.statusCode, undefined);   // access-log line only
  return;
}
```
Why before CORS: `/mcp` is for non-browser agents; routing it first emits no `Access-Control-*` headers and makes an `OPTIONS` preflight a 405, so a web page cannot call it cross-origin (the handler also enforces Origin itself). Logging: `logApiResponse` only attaches `request_body` from `req.rawBody`, which the MCP handler never sets, so card content is not written to `logs/api.log`; the audit record is the per-call log. `last_used_at` should be updated (throttled) inside `authenticateAgentToken`. Agent tokens must be accepted ONLY here, never in `requireUser`.

### Client configuration examples (untested with the real clients)
```
# Claude Code
claude mcp add --transport http appflowy-cards http://127.0.0.1:8787/mcp --header "Authorization: Bearer $APPFLOWY_MCP_TOKEN"
# .mcp.json
{"mcpServers":{"appflowy-cards":{"type":"http","url":"http://127.0.0.1:8787/mcp","headers":{"Authorization":"Bearer ${APPFLOWY_MCP_TOKEN}"}}}}
# Cursor mcp.json
{"mcpServers":{"appflowy-cards":{"url":"http://127.0.0.1:8787/mcp","headers":{"Authorization":"Bearer ${env:APPFLOWY_MCP_TOKEN}"}}}}
# Claude Desktop claude_desktop_config.json (stdio shim)
{"mcpServers":{"appflowy-cards":{"command":"node","args":["/path/to/AppFlowy-Independent-Backend/scripts/mcp-stdio-shim.mjs"],"env":{"MCP_URL":"http://127.0.0.1:8787/mcp","MCP_TOKEN":"afmcp_..."}}}}
```
Shim behaviour: reads one JSON-RPC message per stdin line; POSTs it with `Authorization: Bearer`, `Accept: application/json, text/event-stream`; adds `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` (base64 sentinel when not header-safe) when the message carries modern `_meta`, and the version negotiated by `initialize` on later legacy messages; writes each reply as one stdout line (SSE `data:` events unpacked; 202/empty dropped); HTTP or network failures of a request with an id become JSON-RPC errors for that id; the token is scrubbed from every message and never logged; `redirect:'error'` so the token is never sent to a redirect target; exits 0 after in-flight requests on stdin end or SIGINT/SIGTERM; exits 1 on missing/invalid `MCP_URL`/`MCP_TOKEN`.

### Test classification
| Group | Evidence class | Result |
|---|---|---|
| Modern stateless flow, discovery, tools/list shape/annotations/schemas, determinism | real HTTP, fake cards | **Passed** (15 protocol tests) |
| Legacy initialize flow and negotiation, both profiles equal | real HTTP, fake cards | **Passed** |
| Header mismatch -32020, unsupported version -32022, unknown method 404, malformed params, invalid JSON-RPC, batches, notifications, content negotiation | real HTTP | **Passed** |
| Every tool: success, argument mapping, outputSchema validity (independent validator), CardError mapping incl. AMBIGUOUS options, invalid arguments (22 cases) never reaching the service, confirm rules, idempotent create replay/conflict, timeout, generic -32603 | real HTTP, fake cards | **Passed** (16 tool tests) |
| Read-only token refused for each write tool before the card service is called; identity only from the token | real HTTP, spy | **Passed** |
| Auth 401/403 (+WWW-Authenticate), token never echoed, Origin, 405s, 413, rate limit 429 with window reset, audit records (one per call, no secrets/content), failing audit sink | real HTTP | **Passed** (11 security tests) |
| Stdio shim: framing, headers, SSE, HTTP/network failures, parse errors, stdout purity, token secrecy, stdin-end and SIGTERM exit, misconfiguration, end-to-end through the real handler | real process + real HTTP | **Passed** (11 shim tests) |
| Real card service, real token store, `/mcp` mounted in `server.js` | n/a | *Superseded:* **Passed** in the Integration phase (real HTTP) and in acceptance (real MCP Inspector client) |
| Real MCP client | n/a | *Update:* the **MCP Inspector CLI v2.13.0** (direct and via the stdio shim) **Passed** in acceptance; **Claude Code, Cursor and Claude Desktop: Not tested** |
| JSON/PostgreSQL parity | n/a | **Not applicable** at this layer (no storage access) |
| Full backend suite (`node --test test/`, run while other forks were active) | real | **331 passed, 5 failed, 54 skipped** of 390; the 5 failures are the known `postgres-row-document` `DATABASE_URL` tests (baseline), the 54 skips are Postgres-gated tests (**Blocked**, not counted as passed); all 53 new MCP tests are among the passes |

## Phase 3: Agent tokens

Status: **built; JSON and real-PostgreSQL tested; live on the dev backend.** *(`/mcp` was not mounted when this phase was written; it was mounted in the Integration phase below.)* The Settings panel from Phase 6 can now create, list and revoke tokens against the real routes (verified by curl as the real account, not yet by clicking the panel).

### Files
- New: `agent-auth.js` (token generation/parsing, constant-time comparison, `createAgentAuthenticator`), `migrations/019_agent_tokens.sql`, `test/agent-tokens.test.js`.
- Edited (small anchored edits): `server.js` (import, the three routes, token pattern added to `redactSecrets`), `storage.js` (JSON store methods, lazy `agentTokens` key), `postgres-storage.js` (`rowAgentToken`, five store methods, migration 019 registered).
- Not touched: `cards.js`, `mcp.js`, `mcp-tools.js`, any web-client file.

### Routes (owner/admin only, server-enforced; errors carry a top-level `message`)
- `POST /api/workspace/{id}/agent-tokens` `{name 1..80 (trimmed), scope 'read'|'write', expires_in_days? 1..365|null}` -> `{id, name, scope, token, created_at, expires_at}`; the secret is in this response only (`cache-control: no-store`). Unknown fields, bad name/scope/expiry -> 400; more than 25 active (not revoked, not expired) tokens in a workspace -> 400.
- `GET .../agent-tokens` -> `{tokens:[{id,name,scope,created_at,last_used_at,expires_at,revoked,expired}]}`, most recent first; never any secret or hash.
- `DELETE .../agent-tokens/{tokenId}` -> `{id, revoked:true}`; idempotent, keeps the record; a token of another workspace or a malformed id -> 404.
- Members and outsiders get 403, unauthenticated callers 401. Admins (granted through the dev helper) can manage tokens. The panel contract matches exactly; no web-client change was needed.

### Decisions
1. Token format `afmcp_<id>_<secret>`: id = 16 random chars `[a-z0-9]`, secret = 32 random bytes base64url (43 chars, 256 bits). Only `sha256(secret)` (hex) is stored. Lookup by id, then `timingSafeEqual` on fixed-length digests; an unknown id still performs a dummy comparison so timing does not reveal existence.
2. JSON mode uses a lazily created `agentTokens` map (no `emptyState` change); Postgres uses table `agent_tokens` (FKs to workspaces and users with ON DELETE CASCADE, `scope` CHECK, indexes on `(workspace_id, created_at DESC)` and `user_id`).
3. Tokens act as their creator: `userId` is the creating user's id, and membership is re-checked on every call.
4. `last_used_at` is written at most once per 60 s per token per process (in-memory throttle inside the authenticator).
5. Agent tokens are not sessions: `currentUser`/`requireUser` and the WebSocket handshake look tokens up in the sessions store only, so an `afmcp_` token gets 401 there (tested for REST and WS). A normal session token is refused by the agent authenticator (401).
6. Logging: `redactSecrets` now also scrubs any `afmcp_<id>_<secret>` pattern from logged request/response bodies; a test proves the secret never reaches the log file (including a failing request whose body contains a token).
7. A revoked token reports 401 "revoked" even if its owner was removed; re-adding a removed member does not revive a revoked or expired token (an untouched, unexpired token works again for the restored member, since membership is the only thing that changed).

### The `authenticate(req)` contract for `createMcpHandler`
```js
import { createAgentAuthenticator } from './agent-auth.js';
const authenticateAgentRequest = createAgentAuthenticator({ store, now /* optional */, touchIntervalMs /* default 60000 */ });
// authenticate: (req) => authenticateAgentRequest(req)
```
Resolves `{ tokenId, userId, workspaceId, scope: 'read' | 'write' }`. Reads `Authorization: Bearer afmcp_...` only (never a query string). Throws an `Error` with `.status`:
- 401: missing header, wrong scheme, malformed token, unknown id, wrong secret, revoked ("This agent token has been revoked"), expired ("This agent token has expired").
- 403: the token's user is no longer a member of the workspace.
Messages never contain the token.

### Test classification
| Group | Evidence | Result |
|---|---|---|
| Token helpers (shape, parse, constant-time compare, never throws) | unit | **Passed** |
| Create/list/revoke, secret once, order, idempotent revoke | real HTTP, JSON store | **Passed** |
| Only the hash stored | real JSON state | **Passed** |
| Only the hash stored | **real PostgreSQL table** | **Passed** |
| Validation (14 bad inputs), 25-token cap and slot reuse | real HTTP, JSON and PostgreSQL | **Passed** |
| Owner/admin only (member, outsider 403; unauthenticated 401; admin allowed) | real HTTP, JSON and PostgreSQL | **Passed** |
| Cross-workspace revoke 404, malformed ids 404, per-workspace lists | real HTTP, JSON and PostgreSQL | **Passed** |
| Authenticator: scope, every bad credential, expiry, revoked | real store, JSON and PostgreSQL | **Passed** |
| Membership removal (403), restore does not revive revoked, token bound to its workspace | real store, JSON and PostgreSQL | **Passed** |
| `last_used_at` throttling (1 write per interval, persisted value) | real store, JSON and PostgreSQL | **Passed** |
| REST and real WebSocket handshake reject agent tokens; session token rejected by the authenticator | real HTTP + real WS | **Passed** |
| Secret never in the API log | real log file | **Passed** |
| Full backend suite without Postgres env | 434 tests | 375 pass, 5 fail (the known `postgres-row-document` tests that need `DATABASE_URL`), 54 skipped (Postgres-gated) |
| Full backend suite with Postgres env (throwaway cluster on 127.0.0.1:54329, then stopped) | 445 tests | **445 pass, 0 fail, 0 skipped** |
| Live on the dev backend (restarted once, no `AI_*_BASE_URL` overrides) | curl as the real account | create read token, list, revoke all worked; the smoke token 'phase3 smoke' remains in the list as Revoked (records are kept by design) |
| Clicking through the Settings panel against these routes | real browser | **Not tested** in this phase; **Passed** in acceptance (isolated stack and dev stack) |
| `/mcp` mounted, end-to-end with the MCP layer and a real client | - | **Not tested** in this phase; done in Integration and acceptance |

## Phase 2 / Integration: `/mcp` mounted, live collaboration, end-to-end and PostgreSQL verification

Status: **wired and verified with real HTTP, real token store, real `cards.js`, real Yjs, real WebSocket frames, on the JSON store AND on a real PostgreSQL 16 (throwaway cluster, own port).** *Update:* the real-browser acceptance run and a real MCP client (the MCP Inspector CLI, direct and via the stdio shim) were done afterwards; see LIGHT_MCP_ACCEPTANCE_REPORT.md. Claude Code, Cursor and Claude Desktop remain untested.

### What was wired (`server.js`, 3 small hunks, ~54 changed lines; diff taken against a copy made right before editing)
1. **Imports:** `createAgentAuthenticator` (from `agent-auth.js`), `createCardService` + `createIndexRowCandidates` (`cards.js`), `createMcpHandler` (`mcp.js`).
2. **Inside `createApp`, after `corsAllowedOrigins`:**
   - `cardService = createCardService({ store, broadcast: (e) => broadcastCollabUpdate(e), searchRows: createIndexRowCandidates(store, {isReadableSpace}), isReadableSpace: isSupportedPublicSpacePermission, timeZone })`. `timeZone` comes from `options.mcpTimeZone` or env `MCP_TIME_ZONE` (default `UTC`).
   - `mcpHandler = createMcpHandler({ cards, authenticate: createAgentAuthenticator({ store }), audit: (r) => logApiEvent({ kind: 'mcp_call', ...r }), allowedOrigins, limits })`. `allowedOrigins` = `options.mcpAllowedOrigins` or env `MCP_ALLOWED_ORIGINS` (comma list, default empty; loopback is accepted by the handler when the server is bound to loopback). This is deliberately **not** the web CORS allow-list: browsers should not call `/mcp`.
3. **Mount in the request handler**, right after `X-Request-Id` and **before** `applyCorsHeaders` and the OPTIONS block: `if (url.pathname === '/mcp') { await mcpHandler(req,res) ... logApiResponse(...); return; }` wrapped in try/catch (generic JSON-RPC `-32603` on an unexpected throw). No `Access-Control-*` header is ever emitted for `/mcp`.
4. **`broadcastCollabUpdate({workspaceId, collabType, objectId, update, accepted})`** next to `broadcastToWorkspace`/`pushToUser`: same `collabMessage.update` frame as the browser-originated fan-out (`messageId`/`version` only when the accepted result has them), routed with the composite `subscriptionKey(workspaceId, collabType, objectId)` (the Task 77.2 multi-object registry), per-peer try/catch, persist-first because it is only called by `cards.js` after the store accepted the diff.

Other changed files: `mcp-tools.js` (imports the real `CardError`, re-exports it for the tests; `list_cards` gains `include_archived` -> service `archived: 'include'`; error text no longer appends "Details: null"), `test/mcp-tools.test.js` (exact-argument assertion updated for `archived`, plus an `include_archived` case), `test/helpers/cards-env.js` (storage-aware: `storage: 'json'|'postgres'` or env `CARDS_TEST_STORAGE`, disposable database per environment, `restart()`, `reopenStore()`), `test/cards-service.test.js` (three restart steps now use `env.reopenStore()` instead of copying `state.json`, so they run on both stores).

### Decisions on the architecture report's "Required shared-file changes"
| # | Item | Decision |
|---|---|---|
| 1 | `broadcastCollabUpdate` | Done (above). |
| 2 | Stricter readable-space check | Done: `isSupportedPublicSpacePermission` is passed as `isReadableSpace` for the service and for search candidates. |
| 3 | Export `deriveUuid` | **Not done, by choice.** `cards.js` keeps its small local `uuidFromHash`; importing `server.js` internals into `cards.js` would create an import cycle for ~6 lines. |
| 4 | Export/call `ensureRowDocumentPage` on archive | **Not done.** Archived cards that never had a detail page cannot be restored from the app's Trash UI, but `restore_card` restores any archived card. Documented limitation. |
| 5 | MCP module imports real `CardError` | Done. |
| 6 | `include_archived` on `list_cards` | Done (the service supports it), so an agent can find an archived card id to restore. |

### Test classification (all runs this phase; evidence type in brackets)
| Group | JSON store | Real PostgreSQL 16 |
|---|---|---|
| Card service, 22 tests [real Yjs, real storage] | **Passed 22/22** | **Passed 22/22** (`CARDS_TEST_STORAGE=postgres`) |
| Card concurrency, 8 tests [real Yjs, real storage acceptance, incl. `CONCURRENT_UPDATE` retry] | **Passed 8/8** | **Passed 8/8** |
| MCP protocol/tools/security/shim, 53 tests [real HTTP around the handler, fake card service] | **Passed 53/53** | n/a (no storage) |
| Agent tokens, 26 tests (Phase 3) [real HTTP + real store] | **Passed** (14 JSON) | **Passed** (12 real PostgreSQL) |
| Live WebSocket collaboration, 6 tests [real `ws` clients, real frames applied to local Y.Docs, real storage, real `/mcp` + token] | **Passed 6/6** | **Passed 6/6** |
| MCP end to end, 11 tests [real HTTP, real tokens, real `cards.js`] | **Passed 11/11** | **Passed 11/11** |
| Full backend suite, no Postgres variables | 451 tests: **392 passed, 5 failed, 54 skipped**. The 5 failures are the known `postgres-row-document` tests that need `DATABASE_URL`; the 54 skipped tests are Postgres-gated (**Blocked** in this run, not counted as passed). | |
| Full backend suite, `DATABASE_URL` + `RUN_POSTGRES_TESTS=1` | | 479 tests: **479 passed, 0 failed, 0 skipped** |
| Real MCP client (Claude Code, Cursor, Claude Desktop) | **Not tested** | |
| Real browser session open during agent mutations | **Not tested** (the live WebSocket tests are the stand-in: they apply the frames to documents, but no real web UI rendered them) | |
| Settings panel against the real token routes | **Not tested** (panel verified against mocked routes; routes verified by curl and tests) | |

What the live tests prove (each frame applied to a local `Y.Doc` and the resulting Yjs state asserted): an MCP-created card appears in the `row_orders` of **every** view of an already-subscribed Database peer, and the new row is readable through the normal `GET .../collab/{id}?collab_type=4` path with the right title/column/field cells; a title+property update reaches only the subscribed row (a peer subscribed to several objects gets only the right one, no Database frame for a field edit) and was persisted before the frame arrived (timestamp of the store call resolving <= frame receipt); a column move changes the grouping cell (row peer) and a `before_card_id` reorder changes the Board's order (Database peer); archive and restore flip `is_deleted` in every view; a peer that vanished mid-session breaks neither persistence nor other peers; a peer in another workspace and a peer subscribed to another database/row receive nothing.

What the end-to-end tests prove: both protocol profiles (modern `server/discover`, legacy `initialize` + `notifications/initialized` 202); all nine tools on a template database that has a Board; cursor paging equals the full ordered list; column filter; text query through the search index; create idempotency (replay returns the original card with `replayed: true`, same key with another payload is `CONFLICT`, restart keeps the ledger); invalid column error lists the valid columns; an anchor from another column is rejected; archive needs `confirm`; read-only token reads but every write tool is refused and changes nothing; unknown/wrong-secret/revoked/expired tokens are 401; removing a member's workspace membership makes their token 403 and an untouched token works again when they are restored; another workspace gets `NOT_FOUND` for these ids and sees none of these databases; a foreign `Origin` is 403 with no CORS headers, loopback origin accepted, a foreign-origin preflight is refused (403) and a bare `OPTIONS` is 405 with no CORS headers, `GET` is 405; agent tokens are 401 on REST routes and the WebSocket handshake while a session token still works and is refused by `/mcp`; one `mcp_call` audit record per call (token id, user, workspace, tool, target, ok, duration) with no token secret and no card content anywhere in the API log; cards, tokens and the idempotency ledger survive a backend restart.

### JSON vs PostgreSQL logical parity
The card, concurrency, live and end-to-end suites run the **same assertions** against both stores and pass identically (30/30 card tests, 6/6 live, 11/11 e2e on each). No PostgreSQL-specific bug was found in `cards.js` or the storage paths; the one place the tests differed was test mechanics (three tests copied the JSON state file to simulate a restart), which are now store-aware. The PostgreSQL cluster is a disposable local instance on `127.0.0.1:54329` (own data directory); it is stopped.

### Dev backend smoke (curl, real account)
After the final restart (no `AI_*_BASE_URL` overrides): `afmcp_<id>_...` write and read tokens created; `initialize` (legacy) -> protocol `2025-06-18` with the tools capability; `tools/list` -> the nine tools; `list_databases` -> Tasks (Board), Projects; the read token's `create_card` -> tool error "This token is read-only..." (FORBIDDEN) and its `list_cards` works; a browser-style preflight to `/mcp` -> 403; both smoke tokens revoked; the revoked token -> 401.

### Open issues
1. *Partly resolved in acceptance:* the real **MCP Inspector CLI v2.13.0** connected (direct and through the shim) and negotiated protocol **2025-11-25** (legacy profile). **Claude Code, Cursor and Claude Desktop have not connected**; which revision they send is still unverified, and the client configuration examples remain "untested with those clients".
2. *Resolved in acceptance:* a real browser kept the Board open (no reloads) while MCP created, updated, moved, reordered, archived and restored cards, and an open card detail updated live.
3. *Resolved in acceptance:* the Settings panel was exercised against the real routes (create read/write, copy, snippets, list, revoke, reload) on an isolated stack and on the dev stack.
4. `move_card` still cannot be atomic across the DatabaseRow and Database objects (see the architecture report): a failed reorder yields `PARTIAL_FAILURE` and a retry completes it.
5. In-memory limits: the per-token rate limit and the `last_used_at` throttle are per process.
6. Pagination has no snapshot isolation under concurrent reordering (architecture report, section 8). A date-only value is pinned to `MCP_TIME_ZONE` (default UTC).
7. Archived cards without a detail page can only be restored through `restore_card` (decision 4 above).

## Acceptance addendum

The acceptance run (isolated stack on ports 8790/3100, plus a token create/list/revoke sanity pass on the dev stack) is documented in `LIGHT_MCP_ACCEPTANCE_REPORT.md`. One bug found there was fixed:

- **`get_database` text said "grouped by ?"** instead of naming the Board's grouping field. `mcp-tools.js` read `board.grouping_field` while `cards.js` emits `board.group_field`; the unit-test stand-in used the wrong name, so the tests passed. Fixed in `mcp-tools.js` (reads `group_field`), the stand-in in `test/helpers/mcp-test-kit.js` now uses the real shape, and `test/mcp-tools.test.js` asserts the summary names the field.

Informational finding (not changed): the MCP Inspector's `--strict` schema check reports 0 errors and 30 portability warnings, all about nullable output fields declared as `type: [..., "null"]`; only clients that map tool schemas onto a single-type dialect might object.
