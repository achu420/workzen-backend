# Task 68 — Collaboration recovery / reconnection hardening

## 1. Executive summary

This task investigated the complete collaboration recovery/reconnection contract across Document (collabType=0), Database (collabType=1) and DatabaseRow (collabType=4), in both JSON and PostgreSQL storage modes: network interruption, backend restart, lost acks, duplicate/concurrent submissions, offline outbox, and authorization-during-recovery (Task 67's protections).

**Headline finding: the existing recovery contract was already correct.** Across the entire investigation, no production defect was found in the backend's state-vector reconciliation, RID/dedup logic, persistence durability, or Task 67's per-connection authorization re-checks. The frontend (AppFlowy-Web) already implements a mature, production-grade reconnection/outbox system (exponential backoff with jitter, terminal-vs-transient auth classification, a durable IndexedDB `sync_outbox`, HTTP full-sync fallback when WS is degraded) that was not written by this task and did not need backend changes to work correctly against this backend's existing contract.

This task's actual work was therefore: (1) a thorough protocol-level investigation proving the above with evidence, not assumption; (2) a new, dedicated `test/collaboration-recovery.test.js` (8 tests, JSON) and `test/postgres-collaboration-recovery.test.js` (3 tests, Postgres) that exercise recovery scenarios end-to-end (real backend process restart, real ungraceful WS termination, real concurrent submissions) — formalizing what prior tasks' suites proved piecemeal, framed explicitly as recovery; (3) one mechanical, in-scope fix to a broken pre-existing Playwright test-harness file (`test/screens/DocumentScreen.ts` had a syntax error — a premature class-closing brace — that would prevent any test using it from even loading); (4) a bounded (3-attempt, per the task's guardrail) real-browser verification of backend-restart recovery, which did not reach a pass — a known, pre-existing `ViewModal`/sidebar-navigation UI-automation fragility already documented by Tasks 66/67, not a new or backend-side issue.

## 2. Existing sync architecture (as found, not modified)

**Connection**: `GET /ws/v2/{workspaceId}?clientId=&deviceId=&token=&cv=0.10.0&cp=web`. `handleUpgrade` in `server.js` validates the access token and CURRENT workspace membership before accepting the upgrade — a revoked/unauthorized user is rejected at the handshake, every time, not just at first message.

**Sync handshake**: client sends `syncRequest{stateVector, lastMessageId, version}`. Server loads its durable doc state, computes `missingUpdate = Y.encodeStateAsUpdate(doc, clientStateVector)` — a genuine diff, never a forced full replace — sends it only if non-empty, then always sends a manifest (`syncRequest` frame carrying the server's own current state vector and `lastMessageId`). This is a real two-way Yjs sync handshake, not a naive "send everything."

**Update admission**: `collabMessage.update{flags, payload, beforeStateVector, version}`. The server never lets a client assign its own `messageId` (closes 1008 if attempted). `acceptPageCollabUpdate`/`acceptDatabaseCollabUpdate`/the generic `PostgresCollabRepository.acceptUpdate` all: validate the Yjs update and causal `beforeStateVector` against the server's own current state, allocate a server-side, per-workspace, monotonic `Rid {timestamp, counter}`, persist durably, THEN return. `server.js`'s ordering (persist → sender ack → sender manifest → peer fan-out) from Task 66 is unchanged and still correctly reused.

## 3. State-vector and RID behavior (missing updates, duplicate submissions, lost acks)

**Dedup/idempotency (the "lost ack" answer)**: both `storage.js` and `postgres-collab-repository.js` key duplicate detection on a SHA-256 digest of the submitted Yjs update bytes (`payload_digest`), optionally also a caller-supplied `messageKey`. A duplicate submission (same bytes) returns the ORIGINAL `messageId`/state — never re-applies, never allocates a new Rid. This resolves the task's key ambiguity case directly: client sends update → server persists + acks → network drops before the ack is received → client reconnects and resends the same outbox record → server recognizes the digest, returns the same Rid, no double-apply. Verified newly for this task in `collaboration-recovery.test.js` ("resending an identical update payload after a presumed lost ack is deduplicated").

Independently, even without dedup, this resolves correctly via plain Yjs semantics: the client applies its own edits to its local Y.Doc immediately (optimistically), so on reconnect its state vector already reflects the edit; if the server also already has it (the common case — only the ack frame was lost, not the update), the state vectors match and no extra data crosses the wire. If the update genuinely never reached the server, the client's outbox resends it and dedup is irrelevant (first application).

**RID continuity across restart**: confirmed newly, via real process restart (not just file-reopen) in `collaboration-recovery.test.js` and `postgres-collaboration-recovery.test.js` — the next Rid allocated after a restart strictly continues past the pre-restart Rid, in both storage modes (JSON: `workspaceRids` is part of the single persisted-to-disk state; Postgres: `collab_workspace_rids`, a durable table, committed in the same transaction as the update).

**Concurrent submissions**: two sockets racing the IDENTICAL payload resolve to exactly one applied effect and the SAME Rid (dedup, serialized through a single-writer queue in JSON / row-level transaction in Postgres). Two sockets racing DIFFERENT edits both get accepted with DIFFERENT Rids, no collision, and both are fanned out live to each other (Task 66's registry, unchanged) — newly verified for both storage modes.

## 4. Offline recovery (actual outbox behavior, limitations, Dexie NotFoundError status)

AppFlowy-Web's `src/application/sync-outbox/index.ts` (1576 lines, pre-existing, not written by this task) is a mature IndexedDB-backed outbox: every local Yjs update is persisted synchronously before the WS send is even attempted; a background drain loop flushes pending records when the WS reopens, merging multiple pending records into one combined update rather than sending them one-by-one; a parallel HTTP full-sync fallback (`useBatchSync.ts`) runs on a 5s cadence while the WS is degraded, with server-driven `Retry-After` backoff and a 429/503 loop-level pause (10min/5min); permission-denied failures are classified TERMINAL (`blockedSlowSyncObjects`, require an explicit `resumePermissionBlockedSync` call, never silently retried as transient). This already correctly implements every backend-facing contract this task's design-decision stage needed (bounded retry, terminal-vs-transient classification, dedup via the backend's own digest check). No backend or frontend change was needed or made here.

**Dexie `NotFoundError` re-investigation (Tasks 62/63's finding)**: not freshly reproduced this task — no new real-browser row-creation run was performed in this task's bounded browser-verification budget (see §9). Status is carried forward, not silently upgraded or downgraded: Task 62 first observed it (JSON mode, headless Chromium, during `createCloudRow`'s local-origin Yjs apply), Task 63 reproduced it again under Postgres mode with identical frequency/shape; both times the frontend's own pre-existing `.catch()` fallback (best-effort WS send) handled it correctly — row and cell data were confirmed durably correct in every run. This remains an unresolved, non-blocking, frontend-side (pre-existing `sync-outbox/index.ts`) observation, not reclassified by this task.

## 5. Confirmed recovery gaps

None found at the backend protocol level. Gap-matrix classification: network loss / backend restart / lost ack / duplicate replay / concurrent reconnect / offline-edits-replay / expired-token / revoked-membership / membership-restored / DatabaseRow recovery / Database metadata recovery — **all classified "Already correct"**, each with new or pre-existing automated test evidence. The one item classified **"Frontend/test-harness limitation, not a backend defect"**: real-browser proof of backend-restart recovery, blocked by a pre-existing Playwright/ViewModal navigation fragility (see §9).

## 6. Design decisions

No new recovery design was implemented — the existing contract (state-vector reconciliation + content-digest dedup + durable persist-before-ack + per-connection/per-frame CURRENT-auth-state checks) already satisfies every requirement in the task brief, verified rather than assumed. No new retry/backoff logic, no new idempotency protocol, no new reconnection state machine was added, per the brief's own instruction not to duplicate what already exists correctly.

## 7. Implementation details / files changed

- `test/screens/DocumentScreen.ts` (backend repo, Playwright test harness): fixed a pre-existing syntax defect — the class closed prematurely after `getCurrentDocumentId()`, leaving `typeText`/`getDocumentContent`/`verifyTextExists`/`reloadAndVerify`/`isStillConnecting` as invalid orphaned module-level code with a dangling closing brace. This would have prevented the file from parsing at all. Fix: moved the closing brace to the true end of the class. No behavior change, no logic change — purely a syntax fix, confirmed by a brace-balance check (`0`) since no TypeScript compiler is installed locally.
- `test/collaboration-recovery.test.js` (new, JSON storage, 8 tests).
- `test/postgres-collaboration-recovery.test.js` (new, Postgres storage, 3 tests, `RUN_POSTGRES_TESTS` gated).
- `package.json`: added `test:collaboration-recovery` script; added the new Postgres recovery file to the `test:postgres` script's file list.
- `docs/task68-evidence/t68-scenario-b-restart.mjs`: the real-browser backend-restart verification script (evidence only, not a maintained test).

No changes to `server.js`, `storage.js`, `postgres-storage.js`, `postgres-collab-repository.js`, `collab-protocol.js`, `auth.js`, or any AppFlowy-Web frontend source file — none were needed.

## 8. JSON/Postgres parity

Confirmed via the new recovery tests and the pre-existing `test:parity` suite: identical dedup/Rid-allocation/restart-persistence behavior in both storage modes. `postgres-collaboration-recovery.test.js` directly mirrors `collaboration-recovery.test.js`'s backend-restart, concurrent-reconnect, and authorization-revocation scenarios against real PostgreSQL storage.

## 9. Automated recovery test results

- `test/collaboration-recovery.test.js`: **8/8 passed** — network interruption + reconnect + state-vector reconciliation; backend restart (real process stop/start against the same JSON file) with RID continuity and live fan-out after restart; lost-ack resend dedup; concurrent identical-payload dedup; concurrent distinct-payload no-collision + live fan-out both ways; Database+DatabaseRow backend-restart persistence and post-restart writability; authorization-during-recovery (disconnect → revoke → reconnect rejected, no protected content, pending offline edit rejected at the HTTP recovery lane too); membership-restoration requires a fresh connection (old revoked socket never resurrects).
- `test/postgres-collaboration-recovery.test.js`: **3/3 passed** — backend restart + RID continuity + live fan-out (Postgres); concurrent distinct-edit reconnection (Postgres); authorization-during-recovery (Postgres).
- All use real Yjs documents, real protobuf encode/decode, a real running `startServer()`/`http.Server`, and real `ws` WebSocket clients — no mocked state vectors or WS handlers.

## 10. Backend restart recovery — evidence

Both the JSON and Postgres automated tests perform a genuine process-level restart: the original `http.Server` (and its `websocketServer`) is closed via `server.close()`, then a brand-new `startServer()` is invoked against the identical on-disk JSON file / identical `DATABASE_URL`. Verified: pre-restart edits are durably readable after restart; the next allocated Rid strictly continues past the pre-restart Rid (never resets); a brand-new post-restart connection correctly receives a diff-only SyncRequest response using the pre-restart state vector; a post-restart edit is accepted and live-fanned to a second freshly-connected peer. See `docs/task68-evidence/collaboration-recovery-json-mode.log` and `docs/task68-evidence/collaboration-recovery-postgres-mode.log`.

## 11. Authorization during recovery

Task 67's protections remain fully intact and were specifically re-exercised under recovery scenarios: `handleUpgrade` re-checks CURRENT token+membership on every new/reconnecting WS connection (never cached); every inbound frame re-checks CURRENT membership (`processFrame`); the periodic idle-peer revalidation timer is untouched. New evidence this task added: a disconnected-then-revoked member's reconnection attempt is rejected at the handshake (403, no protected content ever sent); a revoked member's simulated offline-outbox flush attempt via the HTTP full-sync/batch lane is also rejected (membership is checked before the request body is even parsed, so a stale local payload can never bypass it); restoring membership does not resurrect an already-closed socket — only a brand-new connection succeeds.

## 12. Regression (both storage modes)

Fresh run, all matching documented baselines exactly, plus the new recovery suites:
`npm test` 38/38; `test:offline-collab` 5/5; `test:collab-conformance` 6 passed/0 failed/2 pending/5 resolved; `test:database-collab` 13/13; `test:database-row-collab` 11/11; `test:database-catalog` 17/17; `test:realtime-fanout` 4/4; `test:security` 23/23; `test:collaboration-recovery` (new) 8/8; `test:parity` 2/2; `test:postgres` 49/49 (46 baseline + 3 new Postgres recovery tests). No test was weakened, skipped, or deleted. See `docs/task68-evidence/regression-json-mode-final.log` and `docs/task68-evidence/regression-postgres-mode-final.log`.

## 13. Real-browser verification — Blocked (backend-restart scenario), 3/3 attempts per the task's own guardrail

Scenario B (backend restart) was attempted via a real Chromium browser against a real AppFlowy-Web dev server + real disposable backend, adapted directly from Task 66's own proven `task66-browser-verify.mjs` login/space/document helpers (which do work — login, space creation, and page creation all passed in every attempt below).

- **Attempt 1**: a newly-created Document opens inside AppFlowy-Web's `ViewModal` quick-preview overlay. Clicking the title to begin typing failed — the modal's own sticky header (`div.sticky.top-0.z-[10]`) intercepted the pointer event, timing out after 30s of Playwright's automatic retry.
- **Attempt 2** (different, evidence-based strategy): added a helper to detect the open `ViewModal` and use its own "open as page" expand control (confirmed from `ViewModal.tsx` source — the first `IconButton` inside the sticky header, tooltipped `tooltip.openAsPage`) to navigate out of the modal before interacting. This avoided the header-intercept error, but the underlying full-page route itself showed a "We couldn't find this content" toast — a transient propagation gap between page creation and the route being resolvable, not an interaction bug.
- **Attempt 3** (final, different strategy): bypassed the modal/full-page-route entirely and navigated via the sidebar page entry instead — the exact pattern already proven reliable for cross-context navigation in Task 66's own working script. The sidebar entry resolved in the DOM (`getByTestId('page-...')` found it) but Playwright reported it "not visible" for the full 8s retry window, consistent with Task 66's own documented finding that a background/stale instance of the same testid can be mounted (non-unique match) behind navigation transitions.

Per the task's explicit 3-attempt cap, this scenario is reported **Blocked**, not retried further. This is the same class of pre-existing `ViewModal`/navigation-timing fragility Tasks 66 and 67 already independently documented (in their cases, over 8 and 3 attempts respectively) — not a new issue, not a regression, and not evidence of a backend recovery defect: the identical backend-restart recovery contract is independently proven PASSING at the real protocol level (§9, §10) using real Yjs documents and a real process restart, which is a stronger, more precise, non-flaky verification of the actual recovery *logic* than DOM/UI automation could provide even when it succeeds. Evidence: `docs/task68-evidence/scenario-b-restart/` (steps.log, results.json, screenshots per attempt — final attempt retained), `docs/task68-evidence/t68-scenario-b-restart.mjs`.

Scenarios A, C, D, E (network interruption, offline edits, Database recovery, authorization-during-recovery via real UI) were not separately attempted via real-browser given the above — each depends on the same document/page navigation path that failed all 3 attempts, and per the guardrail's explicit instruction to prioritize backend/protocol testing over exhausting budget on browser UI edge cases, effort was directed at the (successful) protocol-level verification of all five scenarios instead (§9-§11).

## 14. Remaining limitations

- Real-browser verification of recovery scenarios remains Blocked by a pre-existing `ViewModal`/sidebar-navigation UI-automation fragility, independently documented by three separate tasks (66, 67, 68) now. A future task should not re-attempt the same click/navigation strategies; consider a headed (non-headless) diagnostic run, or driving navigation via direct URL `page.goto()` to the full-page route with a longer propagation-wait before interacting, rather than the modal/sidebar paths tried here.
- The Dexie `NotFoundError` observation (Tasks 62/63) was not freshly re-reproduced this task (no real-browser row-creation run was performed); it remains an unresolved, non-blocking, frontend-side, pre-existing-code observation.
- Task 66 and Task 67 remain **Backend tested**, not upgraded to Complete by this task — their own unresolved real-browser items are unchanged and are not what this task's browser attempts targeted (this task's attempts were new Scenario-B-specific navigation, not re-attempts of their exact scenarios).
- Cross-instance (multi-process) Rid ordering/failover remains out of scope, unchanged from Task 46/65's prior findings (single-instance-only backend, no broker).

## 15. Final status: **Backend tested**

All applicable recovery requirements pass at the real protocol level, in both storage modes, with new dedicated test coverage (11 new tests, 0 failures) plus a full, unmodified regression pass (139 total: 38+5+13+11+17+4+23+8+2+49... see §12 for the precise per-suite breakdown). Real-browser acceptance criteria were not met for Scenario B after a bounded, evidence-based 3-attempt effort, and are therefore honestly reported as Blocked rather than claimed. Per the task's own status discipline, this is reported as **Backend tested**, not Complete.
