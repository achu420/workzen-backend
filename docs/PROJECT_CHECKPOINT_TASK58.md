# Project checkpoint — Task 58 (2026-11-05)

Read-only checkpoint. No application code, schema, or test files were changed to produce this document. Fresh regression evidence was gathered by running the existing suites as-is; everything else is reconciled from the 57 prior task reports in this `docs/` folder plus direct inspection of the current files on disk.

## 1. Repository state at checkpoint time

| Repo | `.git` present | Working-tree state |
|---|---|---|
| `AppFlowy-Independent-Backend` | **No** (confirmed again this task; still not a git repository — "state" means files on disk) | n/a |
| `AppFlowy-Web` | Yes | 13 modified files + 10 untracked paths, all attributable to Task 57 (Document History snapshot/delete UI) and earlier test-harness scaffolding. Full list recorded in Part B below. Nothing was touched, staged, or committed by this task. |
| `AppFlowy` (upstream reference) | Yes | Untracked files only (prior audit artifacts: `AUTOMATION_TEST_SUITE.md`, `DEPLOYMENT_GUIDE.md`, `contracts/`, `docs/`, frontend auth-analysis docs, etc.) — not modified by this task. |
| `AppFlowy-Cloud` | Yes | Clean. |
| `AppFlowy-SelfHost-Commercial` | Yes | Clean. |

`docker ps -a` (read-only) showed the pre-existing commercial self-host stack (`appflowy-selfhost-commercial-*`: cloud, worker, search, gotrue, nginx, redis, minio, postgres) running and healthy, plus unrelated exited containers (`postgres`, `chroma`, `n8n`). None were started, stopped, or touched by this task.

## 2. Documentation found vs. expected

Of the files Part A asked to locate: `docs/AGENT_HANDOVER.md` exists (469 lines) and was read in full. `ARCHITECTURE.md` exists but at the **repo root**, not `docs/`, and is a 10-line summary of the JSON/Postgres storage split only — it predates and does not cover collaboration, version history, CORS, or the WebSocket layer. `docs/MASTER_FEATURE_ROADMAP.md`, `docs/FEATURE_REGISTRY.md`, `docs/FEATURE_ONBOARDING_TEMPLATE.md`, `docs/ARCHITECTURE_OVERVIEW.md`, and `docs/TESTING_AND_ACCEPTANCE_STRATEGY.md` **did not exist before this task** — no prior task created them despite the naming convention implying they might. All five (minus the onboarding template, which no prior task ever proposed and this task does not invent) are created fresh by this task (Part G below); none are editing pre-existing drafts of themselves.

42 individual task reports (`APPFLOWY_TASK*_REPORT.md`, `APPFLOWY_*_REPORT.md`/`*_AUDIT*`/design docs) exist in `docs/`, covering Tasks 8–57 (Task 54 has no standalone report file — its content is folded into the Task 55 report's narrative, confirmed by reading `AGENT_HANDOVER.md`'s continuous task-by-task account, which has no gap in the story between Tasks 53 and 55 proper). This checkpoint does not duplicate their content; see `MASTER_FEATURE_ROADMAP.md` and `FEATURE_REGISTRY.md` for references instead of inline repetition.

## 3. Fresh regression evidence (run this session, read-only, non-destructive)

```
npm test                        → 38 passed, 0 failed
npm run test:offline-collab     → 5 passed, 0 failed
npm run test:collab-conformance → passed=6, failed=0, pending=2, resolved=5
```

Pending conformance vectors, unchanged: `compaction-retention`, `cross-instance-replay`. Resolved vectors, unchanged: `restore-transition`, `rid-allocation-ordering`, `duplicate-admission`, `websocket-http-convergence`, `realtime-ack`.

`npm run test:postgres` was **not re-run** in this task (it provisions a disposable Postgres container; re-running it was judged unnecessary churn since Tasks 50/56/57 already produced same-day, real-Postgres-runtime results — 3/3, 10/10, 10/10 respectively — against disposable containers that were torn down afterward, and this task's mandate is reconciliation, not re-verification of already-fresh evidence). This is recorded as **previously verified evidence** (same calendar day), not **newly executed** in Task 58 — see `TESTING_AND_ACCEPTANCE_STRATEGY.md` for the distinction this checkpoint draws between evidence classes.

A targeted agent re-read the live `server.js`/`postgres-storage.js`/`test/collab-conformance.js` files to re-confirm, against current code (not old reports), the CORS allowlist, the Postgres migration advisory-lock gap, dual WebSocket routes, and the two stub endpoints. All matched the most recent prior task reports exactly — no drift was found between what Tasks 50-57 reported and what is on disk today.

## 4. Verified completed functionality (summary; see `FEATURE_REGISTRY.md` for the full matrix)

- **Auth & workspace foundation**: password auth (scrypt + timing-safe compare), session/refresh tokens, workspace/space/page CRUD, rename, favorites, trash/restore-from-trash — browser verified (Tasks 39/40/53/56).
- **Document collaboration**: Yjs over WebSocket at both `/ws/v2/{workspaceId}` and `/ws/{workspaceId}`, persist-before-ack, per-workspace Rid allocation, duplicate-admission dedup, HTTP full-sync/batch, WS/HTTP convergence, reconnect replay — backend tested (28+ dedicated fixtures) and browser verified for the single-client/single-instance case (Tasks 41-47, 56).
- **Document version history/restore**: list/preview/create-named-snapshot/tombstone-delete/restore, in **both** JSON and real-Postgres storage, with restore-generation fencing, idempotent duplicate restores, concurrent-restore resolution, fault-injection rollback safety, and restart persistence — backend tested, Postgres-runtime tested (disposable containers, Tasks 49B/56), and **browser verified end-to-end including the Task 57 UI controls** (14/14 Playwright steps, Task 57).
- **CORS**: configurable allowlist for origins and headers, OPTIONS answered pre-auth, no wildcard+credentials — backend tested and browser verified (Tasks 51/55/56).
- **Sidebar-blocking gaps**: favorites/trash are real; sharing-view and database-catalog are deliberate "honest empty" stubs, not real features — confirmed unchanged on disk this task.

## 5. Known limitations carried forward, re-confirmed this task

- No WebSocket restore-broadcast frame to already-connected stale clients (fencing-on-reject, or live Yjs propagation if the client stays connected through the restore, are the only two paths — these are different mechanisms, see Task 56/49C-R3).
- `compaction-retention` and `cross-instance-replay` remain genuinely pending (nothing exists yet to test, per Tasks 46/47).
- `postgres-storage.js`'s `openPostgresStore` still reapplies migration DDL with no `pg_advisory_lock` — **re-confirmed present on disk this task**, not fixed.
- No real sharing/permission data model; no real database-type pages. Both are deliberate stubs, not placeholders claiming functionality.
- Files/attachments, templates, search, AI/chat — **essentially 0% built on the backend**, despite extensive, fully-built AppFlowy-Web frontend UI and API-client code for all of them (new finding this task — see `FEATURE_REGISTRY.md` §6-8). This is the single largest newly-quantified gap this checkpoint establishes.

## 6. Open concerns raised fresh by this checkpoint (not previously documented this explicitly)

1. **Frontend-assumes-commercial-infrastructure risk**: `AppFlowy-Web/src/application/services/js-services/http/gotrue.ts` and `chat-request.ts` show the frontend's auth-refresh error handling and AI chat are still shaped around GoTrue and a commercial AI gateway (`/api/chat/*`, `/api/ai/*`) respectively. Auth currently works only because the independent backend's responses happen to satisfy what this code expects, not because GoTrue is present — a latent compatibility risk if that code path is ever exercised differently.
2. **Unbounded growth**: Postgres's `collab_updates` table (raw payload bytes, kept indefinitely for dedup) and the new `collab_versions`/`restore_events` tables have no retention policy or size bound — flagged by Task 47, not yet a product decision.
3. **No official AppFlowy template marketplace URL could be found** in any checked-out repo (upstream `AppFlowy-Cloud`'s `template.rs` is a self-hosted template-center data model/API, not a hardcoded external discovery endpoint) — Part C's "do not invent" instruction is explicitly honored here; this is marked **unknown**, not assumed absent.

## 7. Investigation limitations

- No new browser sessions were opened this task (not required — this is a documentation/reconciliation checkpoint, and sufficiently fresh browser evidence already exists from Tasks 56/57, same calendar day).
- `npm run test:postgres` was not re-executed (see §3).
- Upstream `AppFlowy`/`AppFlowy-Cloud` source was sampled by grep/targeted file reads, not exhaustively read line-by-line; a few specific items (exact global-search UI behavior, whether a true per-page ACL exists distinct from workspace role + publish-link, rollup-as-view-aggregation) are explicitly marked **unknown** in `FEATURE_REGISTRY.md` rather than guessed.
- Commercial production data was never accessed; only the commercial stack's already-running container list (`docker ps`) and its checked-out source/compose files were read.
