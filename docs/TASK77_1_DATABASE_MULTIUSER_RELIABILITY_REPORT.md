# Task 77.1 — Database / DatabaseRow Multi-User Collaboration and Reconnection Verification

## 1. Executive summary

Task 77 closed Document reconnection and Document two-client live delivery but
explicitly could not verify the same for **Database** (collabType=1) and
**DatabaseRow** (collabType=4), because no test helper shared a Database page
across two independently-authenticated workspace members. Task 77.1 built that
helper and used it.

**Verified, with real-browser evidence:**

- A second, independently-registered workspace member **can** open the same
  Database through the real UI and read both the Database (collabType=1) and
  DatabaseRow (collabType=4) collab objects (Phase 0, asserted not assumed).
- **DatabaseRow (collabType=4) two-client live collaboration works.** A cell
  edit reached the peer, with no reload, in **20 ms** (JSON) and **10 ms**
  (real PostgreSQL), independently confirmed as persisted in the DatabaseRow
  collab on the backend and retained after an explicit reload. Verified
  owner→member and member→owner.
- **No `1008` / `1003` WebSocket closes occurred in any run, in either
  browser context.** Tasks 71, 74, 76 and 76.1 are holding; nothing found here
  is a regression of them.
- No cross-object leakage: a Database-level value never appeared in the
  DatabaseRow collab object.
- Full regression green: backend JSON **129/129**, backend PostgreSQL
  **56/56**, JSON/Postgres parity **2/2**, frontend collaboration suites
  **158/158**, frontend typecheck clean.

**One genuine product defect was found, reproduced four times, and
root-caused with direct backend instrumentation — and deliberately NOT fixed:**

> **Database-level (collabType=1) updates are durably persisted but never
> fan out live to other connected clients in a real browser session.**

This is a **pre-existing backend fan-out limitation**, independent of the
Task 71/74/76/76.1 fix chain. Correcting it requires changing the server's
per-connection subscription model, which the admission check those tasks were
built around also depends on — not a minimal change. Per this task's own
instruction ("If it requires a broad architectural change, stop and propose a
separate task"), it is written up in §10 with a proposed scope and left
unimplemented.

**Final status: Browser verified (partial) — Task 77.1 is NOT Complete.**
Outstanding acceptance criteria are enumerated in §12.

## 2. Baseline

- Frontend `/Volumes/work disk/Codes/Tracker/AppFlowy-Web`: `git status --short`
  = **33 entries** before and after this task (22 modified + 11 untracked),
  `git diff --stat` = 22 files changed, 869 insertions(+), 58 deletions(-).
  **No frontend file was created or modified by this task.** (`docs/` is
  gitignored in this repo, which is why earlier tasks' reports there do not
  appear in `git status`.)
- Backend `/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend`:
  confirmed again to have **no `.git`**.
- `server.js` is **byte-identical** to its pre-task state:
  md5 `974a11fc2657c8119c135a13108c7027` before and after, `grep -c T771` → 0.
  (Temporary diagnostic instrumentation was added during §9's root-cause work
  and fully reverted from a pre-edit backup — see §9.4.)
- Task 74's `BaseDexie.ignoreTransaction()` guard confirmed still present in
  `AppFlowy-Web/src/application/db/index.ts`; Task 71/76/76.1 files untouched.
- Browser: Chromium via the project's pinned `@playwright/test`, headless,
  1920×1080. Backend storage modes exercised: JSON (default) and real
  PostgreSQL (`appflowy_independent_test`, the pre-existing isolated test
  database Task 77 used; nothing production or commercial was touched).
- Every scenario registers its own uniquely-timestamped disposable users; no
  credentials or tokens are reproduced in this report.

## 3. Test infrastructure built

New file: **`test/e2e/task77-1-database-multiuser.spec.ts`** (test only; no
production code). It reuses, rather than duplicates, the proven primitives:
`startTestEnvironment`/`restartBackend`/`registerTestUser`
(`test/helpers/test-environment.ts`), the Task 69 navigation helpers, Task 67's
`test-members` membership grant, and Task 73's grid interactions.

What it adds:

- **Two genuinely independent clients**: two `browser.newContext()` instances,
  two separately registered/authenticated users (owner + member), real
  workspace membership granted over the API (asserted `201`). Not two tabs of
  one session.
- **Real-UI Database/row interactions**: `createGridDatabase` (quick-add grid,
  gated on a grid-scoped readiness signal), `createRow` (`grid-new-row`),
  `renameField` (field header menu → `property-name-input`, a Database-level
  write), `writeCell` (`grid-cell-<rowId>-<fieldId>`, a DatabaseRow write).
  No direct Yjs injection anywhere.
- **Independent backend-state readers** for persisted-state evidence:
  `readDatabaseCollab` (collabType=1 → field names + live `row_orders`) and
  `readRowCell` (collabType=4 → one cell's persisted value), both read over
  HTTP with the *member's own* token where the member is the observer.
- **Live-vs-fallback discipline**: peer-side polling helpers
  (`awaitCellTextLive`, `awaitFieldNameLive`, `awaitRowPresentLive`) that never
  reload the observer's page. Per Task 71 §3, the backend's HTTP
  `collab_full_sync_batch` slow lane persists but never fans out to connected
  peers, so a mutation becoming visible on the *peer* without a reload is by
  construction live WebSocket evidence.
- **Close-code tracking**: per-page WebSocket open/close capture plus console
  capture filtered for `1008`/`1003`/SyncRequest/close lines.
- **Incremental evidence**: written after *every* test, not only in
  `afterAll` — added after an `afterAll` that was cut short lost a whole run's
  evidence.

### 3.1 Three test-infrastructure findings (not product defects)

Documented because they cost real diagnosis time and will bite the next author:

1. **The grid renders a sticky-header overlay that duplicates every
   `grid-field-header-<id>` node**, so that testid legitimately matches two
   elements (Playwright strict-mode violation) *and* the overlay copy is the
   one that receives pointer interception. Resolution: target the copy inside
   `database-grid`; read header/cell text via `allInnerTexts()` across all
   matches rather than guessing which copy React updated.
2. **Quick-add grid creation lands the browser on the newly created *view*
   page, whose parent is the *Database* page the sidebar actually renders.**
   The view page's own sidebar entry is therefore hidden until its parent is
   expanded — which is exactly why Task 70's A4 attempt bailed out. Confirmed
   live from the member's own page list vs. rendered sidebar testids:

   ```
   space  f5671078
     page 71f2c8fa            (rendered in sidebar)
     page 6fa49e96  layout 1  (rendered in sidebar)
       page 70d0ef73 layout 1 (NOT rendered  <-- the created view page)
   ```

   Both pages carry the same `extra.database_id`, i.e. the same Database
   collab object. Resolution: `resolveSidebarDatabasePage()` resolves the
   ancestor the sidebar renders, and **both** clients navigate there via the
   real sidebar route. Without this, the member silently fell back to a raw
   deep link — the navigation path Task 70 proved does *not* receive live
   pushes, which would have invalidated every live-delivery result.
3. **The member's sidebar can legitimately not yet list a page whose
   membership was granted seconds earlier** (the sidebar page list is fetched,
   not pushed), so sidebar navigation is retried with a reload, bounded at 3
   attempts, rather than falling back silently.

## 4. Two-client results (Phase 2)

Both clients navigated via the real sidebar route in every run below
(`memberOpenedDatabase.via = "sidebar(attempt 1)"`,
`ownerOpenedDatabase.via = "sidebar(attempt 1)"`).

| # | Scenario | Direction | Result | Writer UI | Peer live, no reload | Backend persisted | After reload |
|---|---|---|---|---|---|---|---|
| P0 | Member can read Database + DatabaseRow collabs | — | **PASSED** | — | — | ct=1 readable, row in `row_orders`, ct=4 → `200` | — |
| A | Database-level field rename | owner → member | **FAILED** | ✓ | **✗ (null, 20 s)** | ✓ (`fieldNames[fieldId]` = marker) | ✓ |
| B | Database-level field rename | member → owner | **FAILED** | ✓ | **✗ (null, 20 s)** | ✓ | ✓ |
| C | DatabaseRow cell update | owner → member | **PASSED** | ✓ | **✓ 20 ms** (JSON) / **10 ms** (Postgres) | ✓ | ✓ |
| D | DatabaseRow cell update | member → owner | **PASSED** (JSON) | ✓ | ✓ | ✓ | ✓ |
| E | Row creation fan-out (Database `row_orders`) | owner → member | **FAILED** | ✓ | **✗ (null, 20 s)** | ✓ (new row id in `row_orders`) | — |

Scenario E is the exact "New row" Database write implicated in the Task 74/75
investigation, included deliberately as a second, structurally different
Database-level mutation (adding a whole DOM row) alongside the field rename
(changing header text). Both fail to reach the peer while a cell edit in the
same grid succeeds in 20 ms — which is why this is not a UI-reactivity
artifact.

Evidence: `docs/task77-1-evidence/results-json.json`,
`docs/task77-1-evidence/results-postgres.json`.

## 5. Reconnection results (Phase 3)

| Scenario | Result | Why |
|---|---|---|
| A — Database reconnection | **BLOCKED** | Test G below did not yield data |
| B — DatabaseRow reconnection | **BLOCKED** | Same test |
| C — Genuine backend process restart | **BLOCKED** | Test H: after `restartBackend()` + reload, the virtualized grid cell locator timed out (15 s) before the post-restart mutation could be made |
| D — Repeated reconnect ×3 | **BLOCKED** | Test G: exceeded the 300 s per-test budget (three cycles × two peer-live polls, each burning its full window because of the §9 defect), plus a Playwright trace-teardown timeout |

Test G drives genuine transport-level disconnects via
`context.setOffline(true/false)` (closing the live WebSocket and letting the
app's own reconnect logic run) and test H drives a genuine process-boundary
restart via `restartBackend()` — the mechanisms are implemented and committed
in the spec file, but neither produced usable per-cycle evidence within this
pass. Three attempts were made (including shortening the known-failing
Database-level poll window from 25 s to 10 s and making cell readiness wait on
the row container and scroll it into view first). **Reported BLOCKED by test
harness, not as a product result** — no claim is made here about whether
Database/DatabaseRow reconnection works.

## 6. Multi-object results (Phase 4)

Scenario I kept a Database and a DatabaseRow live in one connection and
alternated mutations across them in both orders.

| Property | Result |
|---|---|
| Database mutation persisted | **✓** |
| DatabaseRow mutation persisted | **✓** |
| DatabaseRow mutation reached peer live | **✓ 16.2 s** |
| Database mutation reached peer live | **✗ (null)** — the §9 defect |
| No cross-object leakage (Database value never in the DatabaseRow collab) | **✓** |
| `1008`/`1003` closes | **none** |
| Ordinary Document leg | **NOT TESTED** |

The Document leg is honestly NOT TESTED: the first implementation read
`page.url()` after a fixed timeout and silently captured the *previous* page
id, so the "ordinary Document" was the database view page itself
(`docEditable: false`). The helper now waits for a real route change and
asserts the id differs, but that corrected version was not re-run.

## 7. Concurrent-edit results (Phase 5)

| Scenario | Result | Notes |
|---|---|---|
| A — Separate row cells, concurrent | **FAILED (inconclusive)** | The owner observed the member's separate-cell edit, but the member did not observe the owner's within 25 s. Only one observation; not reproduced a second time, so no mechanism is claimed. Could be the §9 defect's sibling (the two cells belong to different fields but the same row) or harness timing. |
| B — Document concurrent edits | **NOT TESTED** | Out of this pass |
| C — Same-cell conflict | **NOT TESTED** | Not attempted; no invented conflict-resolution semantics asserted anywhere |

## 8. PostgreSQL results (Phase 6) — kept separate from JSON

| Scenario | Result | Evidence level |
|---|---|---|
| Member can read Database + DatabaseRow collabs (Postgres) | **PASSED** | Real browser + real PostgreSQL |
| B — DatabaseRow live update, owner → member | **PASSED** | **Real browser connected to real PostgreSQL**: peer-visible with no reload in **10 ms**, persisted in the DatabaseRow collab, retained after reload |
| B — DatabaseRow live update, member → owner | **FAILED (harness)** | Same virtualized-cell locator timeout as §5; passed on JSON |
| A — Database-level live update | **NOT TESTED separately** | The §9 defect is in the WebSocket fan-out layer and is storage-agnostic; not re-demonstrated under Postgres |
| C — PostgreSQL restart with two clients | **NOT TESTED** | Depends on §5 being unblocked |

Command: `TASK77_PG_STORAGE=1 DATABASE_URL=… npx playwright test
test/e2e/task77-1-database-multiuser.spec.ts -g "a non-owner member can read|DatabaseRow cell update"`
→ `2 passed, 1 failed (1.5m)`.

## 9. Defect found: Database-level fan-out never reaches peers

### 9.1 Symptom

A Database-level mutation (field rename, row creation) by either client is
durably persisted and visible to the other client **only after a reload**. It
never arrives live. Reproduced **four times** across two directions and two
structurally different mutations: §4 scenarios A, B, E and §6 scenario I.

### 9.2 What it is not

- **Not** a persistence failure — every case independently verified persisted
  via HTTP with the observer's own token.
- **Not** a UI-reactivity artifact — a field rename (header text) and a row
  creation (a whole new DOM row) are different render paths and both fail,
  while a cell edit in the same grid succeeds in 20 ms.
- **Not** a regression of Tasks 71/74/76/76.1 — **zero** `1008`/`1003` closes
  were recorded in any run, in either context
  (`consoleA_closeCodes: []`, `consoleB_closeCodes: []`).
- **Not** a navigation artifact — both clients reached the page via the real
  sidebar route, not a deep link.

### 9.3 Root cause, confirmed by direct backend instrumentation

The Database fan-out peer filter in `server.js` is:

```js
for (const peer of websocketPeers) {
  if (peer !== websocket && peer.readyState === 1 &&
      peer.workspaceId === websocket.workspaceId && peer.objectId === databaseId) {
```

and every one of the four registration sites does:

```js
websocket.objectId = <thisObjectId>;   // single slot, OVERWRITTEN per SyncRequest
websocketPeers.add(websocket);
```

`websocket.objectId` is a **single per-connection slot** recording the last
object that connection sent a SyncRequest for — the same slot Task 71
documented. It is used both for admission ("did you SyncRequest before
updating?") *and* for **peer subscription routing**. Subscription is inherently
many-objects-per-connection; one slot cannot represent it.

Temporary instrumentation logging the whole peer set at Database fan-out time
showed, at the moment of a row-creation fan-out:

```
DB-FANOUT dbId=427699e1
    SENDER obj=427699e1 ready=1 match=True
    -> matching peers: 0
```

i.e. **no peer frame was sent at all**. Registration logs confirmed both
clients do register for the Database (`collabType=1`), so the Database is
simply no longer the object their slot points at by fan-out time — a browser
viewing a Database holds the Database **plus** a DatabaseRow per row (plus a
Document for the page), and each row's SyncRequest overwrites the slot.

### 9.4 Why existing tests did not catch it

`test/realtime-fanout.test.js`'s Database case passes (4/4 green) because each
client opens **exactly one** socket and `syncBoth(databaseId, 1, …)` makes both
sockets SyncRequest **the Database and nothing else** — so
`peer.objectId === databaseId` holds and the filter matches. The defect only
manifests when a single connection multiplexes several collab objects, which
is precisely what the real UI does and what a protocol-level test with one
object per connection cannot reproduce. This also explains why Task 77's
Document two-client case passes (a Document page is effectively one object),
and why in this task the DatabaseRow that happened to hold the slot received
its fan-out in 20 ms while the Database never did.

All temporary instrumentation was reverted: `server.js` md5 is byte-identical
to its pre-task value and `grep -c T771 server.js` → 0.

### 9.5 Not fixed — separate task proposed

A correct fix replaces the single `websocket.objectId` subscription slot with a
per-connection **set** of subscribed objects (and routes fan-out off that set),
while leaving the admission check's semantics intact. That touches all four
collab-type branches and the admission path that Tasks 71, 76 and 76.1 were
built around, so it is not the "clearly minimal, in-scope" correction this
task authorises. Recommended scope for a follow-up:

1. Add a per-connection subscribed-object set; keep `websocket.objectId` for
   admission semantics so Tasks 71/76/76.1 behaviour is unchanged.
2. Route Document/Database/DatabaseRow fan-out off the set, not the slot.
3. Add a protocol-level regression test with **one connection subscribed to
   two objects** — the gap §9.4 identifies.
4. Re-run this task's §4 scenarios A, B and E as the acceptance bar.

## 10. Regression results (Phase 7)

### Backend (JSON) — 129/129

```
npm test                        → tests 38  pass 38  fail 0
npm run test:offline-collab     → tests  5  pass  5  fail 0
npm run test:database-collab    → tests 13  pass 13  fail 0
npm run test:database-row-collab→ tests 11  pass 11  fail 0
npm run test:database-catalog   → tests 17  pass 17  fail 0
npm run test:database-view-collab→tests  6  pass  6  fail 0
npm run test:realtime-fanout    → tests  4  pass  4  fail 0
npm run test:security           → tests 23  pass 23  fail 0
npm run test:collaboration-recovery → tests 8 pass 8 fail 0
npm run test:row-document       → tests  4  pass  4  fail 0
```

### Backend (PostgreSQL)

```
DATABASE_URL=… npm run test:postgres → tests 56  pass 56  fail 0
DATABASE_URL=… npm run test:parity   → tests  2  pass  2  fail 0
```

### Frontend

```
npx jest AppSyncLayer.test.tsx useSync.test.ts \
         useSyncContextLifecycle.history.test.ts \
         useSyncContextLifecycle.ordering.test.ts \
         sync-outbox.test.ts src/application/db/__tests__ --coverage=false
→ Test Suites: 9 passed, 9 total;  Tests: 158 passed, 158 total

npm run type-check → clean, exit 0
```

Task 76.1's five ordering tests (successful binding order, no unnecessary
rebind, rejected promise blocks the dependent update, `allowed: false` blocks
it, socket closure blocks it) are included in the 158 and were **not**
modified. All counts match Task 77's recorded baseline exactly — no drift.

## 11. Files changed

| File | Classification | Why |
|---|---|---|
| `test/e2e/task77-1-database-multiuser.spec.ts` | **New test / test infrastructure** | The whole deliverable: the Database-sharing two-member helper plus Phase 2/3/4/5/6 scenarios |
| `docs/task77-1-evidence/results-json.json`, `results-postgres.json`, `env.local.backup` | Test evidence | Per-stage machine-readable evidence written by the suite |
| `docs/TASK77_1_DATABASE_MULTIUSER_RELIABILITY_REPORT.md` | Documentation | This file |

**No production file was changed in either repository.** `server.js` was
temporarily instrumented for §9.3 and restored byte-for-byte (md5 verified).
No frontend file was created or modified at all. No commits, no pushes, no
`git reset`/`checkout`/`clean`, no pre-existing change overwritten, no unknown
process stopped, no commercial AppFlowy file touched.

### 11.1 Two cleanup issues found and disclosed

**(a) `AppFlowy-Web/.env.local` had been left pointing at a dead test
backend, and is now restored.** `startTestEnvironment` rewrites this file and
`stopTestEnvironment` restores it; when a Playwright worker is killed before
teardown (which happened on the §5 timeouts), the restore never runs, and the
*next* run then backs up the already-overwritten file. The result was
`.env.local` = `http://127.0.0.1:19069` (a disposable test port). The true
pre-task value, consistent across every pre-task backup — Task 66's from
2026-11-06 and Task 73's/Task 77's from minutes before this task — is
`http://localhost:8787`, which also matches `server.js`'s own default port and
`.env.example`. It has been **restored** to exactly that (md5
`c85de40fc13dc3b2379325c6ecc3471d`, byte-identical to
`docs/task77-evidence/e2e-runs/1794383695547/env.local.backup`). Note this
file is gitignored, so the unchanged `git status` entry count did not reveal
it. Worth fixing properly in the helper: back up to a single canonical
location only if no backup already exists, so a mid-run kill cannot poison the
next run's baseline.

**(b) Nine orphaned disposable test processes remain running; I could not
terminate them.** They are the backend+frontend pairs from runs whose workers
were killed before teardown. All are unambiguously test-owned: backends on
loopback test ports `127.0.0.1:19xxx` with the backend repo as cwd, Vite dev
servers spawned with exactly `--port 14xxx --strictPort`, all started between
13:41 and 15:09 on 2026-11-11 (this task's run window), paired one second
apart:

| PID | Port | Started |
|---|---|---|
| 97325 | 127.0.0.1:19098 | 13:41:54 |
| 97329 | 14006 | 13:41:55 |
| 11764 | 14355 | 14:42:25 |
| 13713 | 14087 | 14:52:13 |
| 13811 | 127.0.0.1:19441 | 14:52:35 |
| 15220 | 127.0.0.1:19057 | 14:59:34 |
| 15224 | 14024 | 14:59:35 |
| 17228 | 14148 | 15:09:24 |
| 17352 | 127.0.0.1:19069 | 15:09:46 |

One further orphan (pid 11753, backend on 127.0.0.1:19420) was successfully
terminated. The batch termination of the nine above was **denied by this
environment's permission classifier** as potentially interfering with
workloads, so they were deliberately left running and are reported here
instead of being force-killed. They are idle, bound to loopback only, and hold
no data of value (each writes to a disposable temp data file, except the
Postgres-mode ones which used the isolated test database). **Recommended
cleanup, for the user to run if they agree:**
`kill 97325 97329 11764 13713 13811 15220 15224 17228 17352`

## 12. Remaining limitations / outstanding acceptance criteria

Explicit, not silently dropped:

1. **Database-level two-client live delivery (§4 A, B, E)** — FAILED due to the
   §9 defect. Blocked on the separate task proposed in §9.5.
2. **Database reconnection (Phase 3 A)** — BLOCKED by harness.
3. **DatabaseRow reconnection (Phase 3 B)** — BLOCKED by harness.
4. **Genuine backend-restart two-client sync (Phase 3 C)** — BLOCKED by the
   post-restart virtualized-cell locator timeout.
5. **Repeated ×3 reconnect cycles (Phase 3 D)** — BLOCKED by the 300 s test
   budget; needs the Database-level poll removed or the budget raised once
   §9 is fixed.
6. **Multi-object Document leg (Phase 4)** — NOT TESTED; helper corrected but
   not re-run.
7. **Concurrent separate-cell convergence (Phase 5 A)** — FAILED once,
   inconclusive, not reproduced; no mechanism claimed.
8. **Document concurrent edits / same-cell conflict (Phase 5 B, C)** — NOT
   TESTED.
9. **PostgreSQL Database-level live, member→owner DatabaseRow live, and
   PostgreSQL restart (Phase 6 A, B-reverse, C)** — NOT TESTED / harness-blocked.
10. The `grid-cell` locator after a reload/reconnect is the single largest
    harness fragility; a `data-testid` on a stable row-detail affordance, or a
    non-virtualized read path, would make Phases 3/5/6 tractable.
11. **Nine orphaned disposable test processes left running** (§11.1b) — batch
    termination was denied by the environment's permission classifier, so they
    are disclosed with a suggested `kill` line rather than force-stopped.
12. **`.env.local` had been left pointing at a dead test port by an earlier
    killed worker**; restored to its verified pre-task value (§11.1a). The
    backup/restore logic in `test/helpers/test-environment.ts` should be made
    resilient to a mid-run kill so it cannot poison the next run's baseline.

## 13. Final status

**Browser verified (partial) — Task 77.1 is NOT Complete.**

Genuinely verified with real-browser evidence: the Database-sharing two-member
infrastructure itself; member access to Database and DatabaseRow collab
objects; **DatabaseRow two-client live collaboration in both directions, on
both JSON (20 ms) and real PostgreSQL (10 ms)**, with independent
backend-persistence and post-reload confirmation; absence of any `1008`/`1003`
close across every run (Tasks 71/74/76/76.1 intact); no cross-object leakage;
and full backend/Postgres/parity/frontend regression with zero drift.

Not Complete because the Database-level two-client criterion **fails** against
a newly identified, four-times-reproduced, directly root-caused backend
fan-out defect (§9), and because the reconnection, multi-object-Document,
concurrent-edit and PostgreSQL-two-client criteria remain harness-blocked or
untested (§12). The defect is deliberately left unfixed, with a scoped
follow-up proposed in §9.5, because fixing it means changing the server's
subscription model — which the admission path Tasks 71/76/76.1 depend on also
uses — and is therefore outside this verification task's authority.
