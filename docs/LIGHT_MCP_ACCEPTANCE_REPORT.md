# Light MCP v1 - Acceptance report

Date of run: 2026-11-13. Companion reports: `LIGHT_MCP_ARCHITECTURE_REPORT.md` (design and verified contracts), `LIGHT_MCP_IMPLEMENTATION_REPORT.md` (per-phase build and test results).

**Git status of these reports:** the backend directory is **not a git repository**, so the three MCP reports are untracked by definition. In the web repo (`AppFlowy-Web`) `docs/` is listed in `.gitignore` (line 49), although a few older files there were force-added; no MCP report lives in that repo. Nothing was committed.

## Overall status: NOT "Complete" (by the spec's own rule)

Light MCP v1 works end to end with a real MCP client, a real browser and real databases, and the code is verified on both stores. It stays **below Complete** because:

1. **Criterion 12 is only partially met:** the stdio shim's intended client is Claude Desktop, which was not tested. It was verified with the official MCP Inspector acting as a real stdio client.
2. **Claude Code, Cursor and Claude Desktop were not tested at all** (none can be driven from this environment). Only the MCP Inspector CLI v2.13.0 was used as a real client, so no support is claimed for the three named clients.
3. The **modern 2026-07-28 protocol profile** is verified against the spec text and our own tests, but **no real client exercised it** (the Inspector speaks the legacy handshake).

Every other criterion is **Met**, with the caveats noted per row.

## Test setup (isolated, nothing of the user's data mutated)

- Throwaway backend `PORT=8790`, fresh JSON store in the scratchpad, `CORS_ALLOWED_ORIGINS` for the throwaway web origin; throwaway Vite dev server `:3100` with `APPFLOWY_BASE_URL`/`APPFLOWY_GOTRUE_BASE_URL`/`APPFLOWY_WS_BASE_URL` overridden through the shell environment of that process only (no config file edited).
- Account `acc-owner@example.test` registered through the API, logged in through the UI; database created with the real UI: `+` menu > Templates > Tasks, then a Board view added with the view-tab `+` (UI). Dark colour scheme throughout; screenshots `acc-*.png` in the scratchpad.
- A small logging proxy (`:8791`, records HTTP method, status, MCP headers and the JSON-RPC method only, never the Authorization header) sat between the Inspector and the backend to capture exactly what a real client sends.
- Real MCP client: **MCP Inspector CLI v2.13.0** (`npx @modelcontextprotocol/inspector --cli ...`, catalog file redirected with `MCP_CATALOG_PATH`).
- The user's dev stack (`:3000`/`:8787`) was used for exactly one read-only-style sanity pass (Settings panel: create one read token, confirm it lists, revoke it). That left a **Revoked** record named "acc read agent" in the dev token list (records are kept by design). Every token created by this run is revoked; the one active dev token ("for claude") was not created by this run.

## Which protocol revision does a real client send? (the open question)

Evidence from the logging proxy (Inspector CLI v2.13.0, HTTP transport):

```
POST /mcp  initialize            body protocolVersion = 2025-11-25   clientInfo inspector-cli 2.13.0   Accept: application/json, text/event-stream
POST /mcp  notifications/initialized   header MCP-Protocol-Version: 2025-11-25   -> 202
GET  /mcp  (optional SSE stream)        header MCP-Protocol-Version: 2025-11-25   -> 405 (accepted by the client)
POST /mcp  tools/list / tools/call      header MCP-Protocol-Version: 2025-11-25
```

So this real client uses the **legacy (2025-11-25) profile**: `initialize` handshake, no `_meta`, no `Mcp-Method`/`Mcp-Name` headers. Our legacy profile served it correctly, including the 405 on the optional GET stream. The stdio shim path showed the same sequence upstream (`initialize`, `notifications/initialized` 202, `tools/list`, `tools/call`). Implication: the legacy profile is the one that matters today for at least this client; the modern profile remains spec-verified only.

What this does and does not prove: it proves interoperability with one independent, official client implementation over both transports (HTTP and stdio-via-shim). It does **not** prove that Claude Code, Cursor or Claude Desktop connect, nor which revision they send, nor how they handle auth failures.

Behaviour worth knowing: on a revoked token the server answers `401` with `WWW-Authenticate: Bearer realm="mcp"` and a JSON-RPC error; the Inspector then tried an interactive OAuth flow and stopped with "requires a TTY". We have no OAuth server, so clients that start an OAuth flow on 401 will show an auth prompt/error instead of a plain "token revoked" message.

## Completion criteria (spec section 15)

| # | Criterion | Status | Evidence (type) |
|---|---|---|---|
| 1 | All nine tools work | **Met** | Each tool called through the real Inspector client against real data: `list_databases`, `get_database`, `list_cards` (column filter, query, cursor paging limit 2), `get_card`, `create_card` (+ replay + conflict), `update_card`, `move_card` (column + `before_card_id` reorder), `archive_card`, `restore_card` (real MCP client; real JSON; also real Postgres e2e 11/11) |
| 2 | Cards read/mutated through existing Yjs/storage contracts | **Met** | cards.js uses `acceptDatabaseRowCollabUpdate` / `acceptDatabaseCollabUpdate` / `createSeededDatabaseRow`; the browser rendered the MCP-written cells, and the Grid view of the same database showed the moved card in the same group (real Yjs, real JSON, real browser, real Postgres in tests) |
| 3 | Creation is idempotent | **Met** | Inspector: same `idempotency_key` + same payload returned the original card (`replayed:true`); same key + different payload -> `CONFLICT` tool error (real MCP client; unit/e2e on JSON and Postgres) |
| 4 | New cards reach all applicable views | **Met** | Live WebSocket tests assert the new row in `row_orders` of every view; in the browser the MCP-created card appeared in the Board and was found in the Grid view after restart (real WebSocket, real browser) |
| 5 | Board movement and ordering behave correctly | **Met** (limitation below) | Inspector `move_card` to another column, reorder with `before_card_id` (card became first in its column), move into and out of "No status", bad/unknown column errors list valid names; browser showed the card jump columns and reorder (real MCP client, real browser). Limitation: column write and reorder are two Yjs objects and cannot be atomic; a failed reorder returns `PARTIAL_FAILURE` and a retry completes it (fault-injection test, real Yjs) |
| 6 | Archive and restore work | **Met** (limitation below) | Inspector: `archive_card` needs `confirm:true`, hides the card from lists, `restore_card` brings it back; browser: card disappears and reappears live. Limitation: archived cards that never had a detail page cannot be restored from the app's Trash UI, only with `restore_card` (real MCP client, real browser) |
| 7 | Live browser updates without reload | **Met** | Board open the whole time in Playwright, **0 page navigations** (counted): create, title update, field update, column move, reorder, archive, restore all appeared in the DOM; an open card detail showed an MCP title change and a field change live; screenshots `acc-3a`..`acc-3g` (real browser, real WebSocket, real MCP client) |
| 8 | Agent tokens securely scoped and revocable | **Met** | Panel create/revoke on real routes; read token refused for all five write tools (before reaching the service); revoked / wrong-secret / malformed / missing / query-string tokens -> 401; wrong secret on a revoked id gives the generic "Invalid agent token" (no id probing); agent token refused on REST routes and on the WebSocket handshake while a session token connects; foreign Origin -> 403; no CORS headers on `/mcp` and the preflight is not granted (real HTTP, real WebSocket) |
| 9 | Membership removal invalidates tokens | **Met** | Admin created a token; owner removed the admin through the dev test-members helper -> next call `403 "The token owner no longer has access"`; re-adding the member without revoking restored access (documented: membership is re-checked on every call); revoking then re-adding did **not** revive the token (401); a token of the admin's own workspace got NOT_FOUND for the owner's database and cards on read, create and update (real HTTP) |
| 10 | Settings panel works | **Met** (caveat) | Real UI against real routes on the isolated stack and on the dev stack: create read-only (7-day expiry) and read/write (no expiry), secret shown once, Copy puts exactly the token on the real clipboard, snippets show `http://localhost:8790/mcp` (isolated) / `http://localhost:8787/mcp` (dev) and the token, list shows scope/created/last used/expiry/status, revoke with confirm marks Revoked and removes the button, secret absent after Done and after reload, no page errors. This also confirms the earlier "unable to create token" report is fixed. Caveat: the panel is owner-only on the client (the client has no admin role) although the backend also lets admins manage tokens (real browser, real routes) |
| 11 | Required protocol profiles pass their tests | **Met** (modern profile not exercised by a real client) | 53 protocol/tools/security/shim tests plus 11 e2e on JSON and Postgres; the legacy profile additionally served a real client (above). The modern 2026-07-28 profile: tests + spec text only |
| 12 | Stdio shim works with its intended client | **Partially met** | Works with the real Inspector acting as a stdio client (`tools/list` returns nine tools, a tool call succeeds, stdout carries only protocol messages, no token on stderr). **Claude Desktop (the intended client) was not tested** (real MCP client = Inspector only) |
| 13 | JSON persistence verified | **Met** | After restarting the backend: MCP re-listed the same cards in the same columns, a fresh browser load showed them, and the Grid view agreed; unit/e2e restart tests (real JSON, real browser, real MCP client) |
| 14 | PostgreSQL persistence verified | **Met** (scope below) | Throwaway PostgreSQL 16.15: MCP/card/token tests **132/132 passed, 0 skipped** in this run; full suite with Postgres env **484 passed, 0 failed, 0 skipped**. Scope: the browser/Inspector acceptance above ran on the JSON store; Postgres coverage is the automated suite (real Postgres, real Yjs, real WebSocket) |
| 15 | Real browser acceptance passes | **Met** | See criteria 5-7, 10, 13 (real browser, JSON stack) |
| 16 | At least one real MCP client performs card operations | **Met** | MCP Inspector CLI v2.13.0 performed all nine tools, directly and through the stdio shim. Claude Code, Cursor and Claude Desktop: **Not tested** |

## Regression results of this run

| Run | Result |
|---|---|
| MCP/card/token test files on real Postgres (`test/mcp-e2e`, `mcp-collab-live`, `cards-service`, `cards-concurrency`, `agent-tokens`, `mcp-tools`, `mcp-protocol`, `mcp-security`) | **132 pass, 0 fail, 0 skipped** |
| Full backend suite, no Postgres variables | 456 tests: **397 pass, 5 fail, 54 skipped**. The 5 failures are the known `postgres-row-document` tests that need `DATABASE_URL`; the 54 skips are Postgres-gated (**Blocked** in this run, not counted as passed) |
| Full backend suite, Postgres enabled (cluster `127.0.0.1:54329`, now stopped) | **484 pass, 0 fail, 0 skipped** |
| MCP Inspector `--strict` schema check | 0 errors, 30 warnings: all are nullable output fields declared as `type: [..., "null"]` (e.g. `column`, `next_cursor`); legal JSON Schema, but clients that map tool schemas onto a single-type dialect (such as the OpenAPI subset used for Gemini function declarations) may object. Not changed |

## Bug found and fixed during acceptance

- `get_database` text said "Board ... grouped by ?" instead of the grouping field name. `mcp-tools.js` read `board.grouping_field`, but `cards.js` emits `board.group_field`; the unit-test stand-in used the wrong name, so unit tests passed. Fixed in `mcp-tools.js`; the stand-in `test/helpers/mcp-test-kit.js` now uses the real shape; `test/mcp-tools.test.js` asserts the summary names the field. This is a good example of why mock-only testing was classified as insufficient.

## Known limitations (carried forward, unchanged)

1. `move_card` is not atomic across the card row and the Board order (documented `PARTIAL_FAILURE`, retry completes it).
2. Pagination has no snapshot isolation under concurrent reordering (a card moved across the cursor can be skipped or repeated); filtering by column or query reads every row for each page.
3. Date-only values are pinned to `MCP_TIME_ZONE` (default UTC); a viewer in another time zone may see the adjacent day; date ranges are read-only.
4. Rate limit and the `last_used_at` throttle are per process.
5. Archived cards without a detail page can only be restored with `restore_card`.
6. Only writable field types: title, text, number, URL, date, single-select, multi-select, checkbox; other types are read-only; select options are never created.
7. Clients that start an OAuth flow on `401` (the Inspector does) will show an auth prompt instead of a "revoked" message because no OAuth server exists.
8. Agent-token management in the web panel is owner-only on the client.

## What would make this "Complete"

Connect Claude Desktop through the shim (criterion 12), and separately connect Claude Code and Cursor using the panel's generated snippets; record which protocol revision each sends. Optionally re-run the browser acceptance against a Postgres-backed stack.

## Evidence files (scratchpad, not part of the repo)

Screenshots `acc-0a`..`acc-3i` and `acc-1a`..`acc-1h` (panel on isolated and dev stacks, live Board, detail, restart persistence, Grid). The raw Inspector transcript and the logging-proxy log were temporary and were deleted with the throwaway stack; the key excerpts are reproduced above. Screenshots may show tokens of the throwaway stack, whose data no longer exists.
