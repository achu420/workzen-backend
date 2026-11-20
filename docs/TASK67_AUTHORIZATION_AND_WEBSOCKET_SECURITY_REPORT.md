# Task 67 — Authorization, REST/WebSocket Security Audit and Hardening

## 1. Executive summary

This task audited every authorization boundary this backend actually has — REST, WebSocket admission, WebSocket inbound-message authorization, session/token lifecycle, and Task 66's peer fan-out — against the requirement "a user cannot read, modify, or receive data from a workspace/object they're not authorized to access." The audit found the REST and storage layers were **already consistently well-hardened** (every workspace-scoped route re-verifies membership server-side and every nested-resource lookup is workspace-scoped at the storage layer, never a global-by-id lookup — see §3). The one confirmed, real gap was exactly the one Task 66 flagged and explicitly deferred: an already-connected WebSocket peer that only ever *receives* fan-out (never sends another message) stayed eligible for Document/Database/DatabaseRow peer fan-out indefinitely after its workspace membership was revoked, because the pre-existing per-inbound-message revalidation only runs when that socket itself sends a frame. This task implemented a bounded periodic revalidation timer (`server.js`) that closes such a socket and removes it from `websocketPeers` within a configurable, documented window (default 15s) independent of inbound traffic — the "core new work" this task was scoped to do. 23 new JSON + 2 new Postgres automated security tests were added and pass; all 8 pre-existing regression suites pass unchanged (46/46 Postgres, including the 2 new). Real-browser verification of the new revocation mechanism specifically was **Blocked** after 3 genuinely distinct attempts on a pre-existing Playwright/AppFlowy-Web `ViewModal` focus-interception issue (the same unresolved class of flakiness Task 66 already documented across 8 of its own attempts) — the underlying security property is nonetheless proven by real (non-mocked) WebSocket+HTTP protocol-level tests against the actual running backend, in both storage modes.

**What remains exposed / out of scope**: no rate limiting (pre-existing, unrelated to this task, re-confirmed absent); no product UI/REST endpoint for a user to actually remove another member's access (this backend has no such feature at all — a dev/test-only helper was added strictly for test purposes, mirroring the existing test-membership grant helper); no role-based (Owner/Admin/Editor/Viewer) permission enforcement beyond plain membership, because none of the currently-implemented operations require it (see §2); the periodic-revalidation window means an idle revoked peer can still receive fan-out for up to the configured interval — bounded and documented, not eliminated.

## 2. Authorization model (actual, as discovered — not assumed)

**Authentication**: Bearer-token sessions (`auth.js`/`server.js`). `issueToken()` is a 256-bit CSPRNG value; only its SHA-256 hash (`tokenHash`) is ever stored (`sessions` table/map, keyed by hash). Passwords are `scrypt`-hashed with `timingSafeEqual` comparison. `sessionExpired(session)` checks `expires_at` on every lookup (`currentUser`/`userByAccessToken`) — expiration is enforced on every REST call and every WebSocket admission/revalidation, not just at login. `POST /api/auth/logout` calls `store.revokeSession`, which deletes the session row/entry outright — revocation is immediate and total (not a soft flag), identical in JSON and Postgres.

**Membership**: a flat `(workspace_id, user_id, role)` row (`memberships`). `requireWorkspace()` (REST) and the WS handshake/revalidation path both call `store.getMembership(workspaceId, userId)` fresh on every check — there is no caching layer, so a membership change takes effect on the very next request/message (proven by `test/security-authorization.test.js`'s "membership revocation takes effect immediately" tests, both REST and WS).

**Role model — decision gate resolved**: a `role` column exists (`owner`/`admin`/`member`) and is read in exactly two places: (1) the dev/test-only membership helpers, gated to `['owner','admin'].includes(role)` (never exposed to real users in production); (2) the Database/Document permission-probe endpoint, which reports `access_level`/`can_share` cosmetically differently for `owner` vs. everyone else but does not gate any actual read/write operation on it. **No currently-implemented operation enforces a role beyond "is a member."** The frontend does not depend on role-specific backend enforcement beyond that cosmetic probe. Per the task's own decision-gate guidance, this task did **not** invent role semantics or build an ACL engine — membership-only authorization is confirmed to be the real, complete existing contract for every operation this backend currently supports, and that is what was hardened, not replaced.

**Permission matrix** (operations this backend actually supports):

| Operation | Enforcement |
|---|---|
| Read workspace | Membership (`requireWorkspace`) |
| Read space/page | Membership + page/space's own `workspace_id` matches |
| Create page/Document/Database | Membership + parent space/view's `workspace_id` matches (server-verified, not trusted from client) |
| Create/update DatabaseRow | Membership + Database's `workspace_id` matches + cell field ids validated against the Database's own known fields |
| Delete/archive (trash) | Membership + page's `workspace_id` matches |
| Upload/download files | **Not implemented** (no blob route exists beyond a 404 stub noted in prior tasks) |
| WS SyncRequest / Update | Membership at handshake + re-verified on every inbound frame + object's `workspace_id` matches the connection's workspace |
| WS peer fan-out (Task 66) | Same-workspace + same-object + open socket + (new, this task) bounded periodic re-authorization |

## 3. Findings

**Existing-and-already-correct protections** (sampled across ~20 routes; no counter-example found): every `get*Collab(workspaceId, objectId)` storage method filters by `workspaceId` at the storage layer (`storage.js`/`postgres-storage.js`), so supplying another workspace's real object id under your own (legitimately-member) workspace id returns 404, not the victim's content — confirmed by a new test. Nested-resource creation (`page-view/document/default`, `page-view/database/default`) independently re-verifies the supplied `parent_view_id`'s space belongs to the caller's own workspace server-side — confirmed by a new negative test (`SPACE_WRITE_FORBIDDEN`). `/api/pages/:id` resolves the page's *own* `workspace_id` from storage before authorizing, never trusting a client-supplied workspace id for that check.

**Confirmed vulnerability (the one this task fixes)**: an idle, already-connected WS peer (receive-only, after its last inbound message) remained in `websocketPeers` and kept receiving Document/Database/DatabaseRow peer fan-out and awareness after its membership was revoked, because revalidation only ran on that socket's own next inbound frame — which might never arrive. Confirmed via a new test that reproduces exactly this: revoke, don't send on that socket, and observe (before the fix) it would keep receiving fan-out indefinitely.

**Confirmed inconsistency, now closed**: there was no mechanism at all to force-close a connection once its authorization became stale except the connection's own next send. There was also no way (dev/test or otherwise) to revoke a membership at all — only a grant helper existed.

**No other vulnerability was found** in the sampled REST surface (auth/session, workspace, space/page, Document/Database/DatabaseRow collab read/write, version-history/revert, trash/favorite, database catalog, sharing/view) or in WS admission/message-type handling.

## 4. Implementation (files changed)

- **`server.js`**: added a bounded periodic re-validation `setInterval` per WS connection (default `wsRevalidationIntervalMs = 15000`, overridable via `startServer`/`createApp` options for tests), performing the identical token+workspace+membership check the pre-existing per-message path already used; on failure it synchronously removes the socket from `websocketPeers` *before* calling `close(1008, ...)`, so no later fan-out iteration can select it even while the TCP close is in flight. The timer is cleared on `close`/`error`. Added a dev/test-only `DELETE /api/workspaces/:id/test-members?email=...` membership-revocation helper, gated identically to the pre-existing grant helper (owner/admin role + test/dev environment + `X-Development-Key`) — this backend has no product feature for removing a member at all, so this exists solely to make revocation testable against real persisted storage.
- **`storage.js` / `postgres-storage.js`**: added `deleteMembership(workspaceId, userId)` (JSON: map delete; Postgres: `DELETE FROM memberships WHERE ...`), used by the new helper route and directly by tests.
- **`package.json`**: added `test:security` script; added the new Postgres security file to `test:postgres`.
- **New test files**: `test/security-authorization.test.js` (23 tests, JSON), `test/postgres-security-authorization.test.js` (2 tests, Postgres).
- **No migration was needed** — `memberships` already supported row deletion; no schema change.

No storage/auth architecture was replaced; no new ACL framework, broker, or identity provider was introduced, per scope.

## 5. WebSocket lifecycle

- **Admission**: unauthenticated/missing-token, invalid token, expired/revoked session, and non-member are all rejected at the HTTP upgrade (400/401/403) before any socket is created — confirmed by test, including that a failed admission never reaches `websocketPeers`.
- **Inbound-message revalidation (pre-existing, preserved)**: every inbound frame (SyncRequest/Update/awarenessUpdate, any collab type) re-checks token+workspace+membership before processing; failure closes with 1008 and mutates no durable state.
- **New periodic revalidation**: closes and de-registers an otherwise-idle revoked peer within the bounded interval, independent of inbound traffic — proven with a 150ms test interval; residual exposure window for an idle revoked peer is bounded by this interval (documented, not eliminated; real immediate push-based revocation would require a broker/pub-sub this backend does not have and was not introduced, per scope).
- **Peer fan-out eligibility**: unchanged filter (not sender, open socket, same workspace, same object) remains sufficient because revoked peers are now actively removed from the registry by the interval or by their own next message — no extra per-send DB query was added; the interval amortizes the cost to one check per connection per interval, not per fan-out message.
- **Reconnection/restoration**: a fresh connection attempt after revocation is independently rejected at admission (does not reuse any cached grant); restoring membership requires — and correctly permits — only a *fresh* connection, never auto-regranting an old one.

## 6. Test results

**REST (JSON, `test/security-authorization.test.js`)**: 11 tests — unauthenticated/invalid-token/revoked-session/non-member/malformed-id rejection, positive-control authorized read, cross-workspace page/collab-id denial, parent-ownership-chain enforcement, immediate-effect revocation, revocation-helper gating. All **Passed**.

**WS admission + lifecycle (JSON)**: 12 tests — no-token/invalid-token/revoked-session/non-member rejection, positive control, cross-workspace-object rejection post-admission, malformed SyncRequest rejection (no state mutation), active-sender revalidation (pre-existing path), **idle-peer periodic revalidation (new path) — closed + stops receiving fan-out while an unrelated peer keeps receiving it**, reconnection-after-revocation rejection, restore-then-reconnect success, session-expiry-while-connected rejection. All **Passed**.

**Postgres (`test/postgres-security-authorization.test.js`)**: 2 tests — non-member/immediate-revocation REST parity, and the idle-peer periodic-revalidation WS scenario under real PostgreSQL storage. Both **Passed**.

**Real-browser (Stage 7)**: Scenario A/C combined script, 3 distinct attempts (unforced click → forced click → programmatic DOM focus), all blocked by the same pre-existing `ViewModal`/Slate-editor focus-interception issue Task 66 already documented. **Blocked** per the task's 3-attempt guardrail. Evidence: `docs/task67-evidence/revocation-browser-verify/steps.log`, `results.json`, screenshots. Scenario B/D and the core revocation security property are independently proven Passed at the real (non-mocked) protocol level above, in both storage modes.

## 7. Regression

Fresh post-change run, all matching documented baselines exactly: `npm test` 38/38; `test:offline-collab` 5/5; `test:collab-conformance` 6 passed/0 failed/2 pending/5 resolved; `test:database-collab` 13/13; `test:database-row-collab` 11/11; `test:database-catalog` 17/17; `test:realtime-fanout` 4/4; `test:parity` 2/2 (with `DATABASE_URL` exported in-command); `test:postgres` 46/46 (44 baseline + 2 new). No test was weakened or deleted.

## 8. Remaining limitations (need a product/architecture decision)

- No role-based enforcement beyond membership — correct for today's feature set, but any future role-gated feature needs its own explicit semantics decision.
- No real membership-revocation product feature exists at all; this task's helper is test-only by design.
- Idle-peer revocation has a bounded (not zero) exposure window, sized by `wsRevalidationIntervalMs`.
- Real-browser UI verification of the revocation scenario remains Blocked on a pre-existing (Task 66) Playwright/ViewModal interaction defect, unrelated to backend security.

## 9. Final status

**Backend tested.** All REST/WS authorization hardening and the new session-revocation lifecycle mechanism are implemented and fully proven by real (non-mocked) automated tests against both JSON and PostgreSQL storage, with zero regressions. Real-browser UI verification of the new revocation mechanism specifically is Blocked (3/3 attempts, well-evidenced, pre-existing UI-automation defect, not a backend defect).
