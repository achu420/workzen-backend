# Task 77.2 — Multi-Object WebSocket Subscription Management

## 1. Executive summary

Task 77.1 found, and root-caused with direct backend instrumentation, that
**Database-level (collabType=1) updates were durably persisted but never fanned
out live** to other connected clients in a real browser session. Task 77.2
fixes it.

**The fix** replaces the fan-out *routing* identity only: a per-connection
composite subscription set (`websocket.subscriptions`) is now consulted for
peer selection, while `websocket.objectId` keeps its exact previous meaning as
the single active-binding slot used by the *admission* checks that Tasks 71, 76
and 76.1 depend on. 23 functional lines in `server.js`; no other production
file in either repository was touched.

**Verified:**

| Evidence | Result |
|---|---|
| New protocol-level regression suite (Scenarios A–I), JSON | **9/9 PASSED** |
| Same suite against **real PostgreSQL** | **9/9 PASSED** |
| Central regression (Scenario B) **fails with the fix reverted** | **CONFIRMED** |
| Task 77.1 §4 **A** (Database rename owner→member), real browser | **FAILED → PASSED**, live in **27 ms** |
| Task 77.1 §4 **B** (Database rename member→owner), real browser | **FAILED → PASSED**, live in **16 ms** |
| Task 77.1 §4 **E** (row creation fan-out), real browser | **FAILED → PASSED**, live in **20 ms** |
| Real browser on **real PostgreSQL** (A and E) | **PASSED**, live in **16 ms** / **20 ms** |
| `1008`/`1003` close codes across every run | **ZERO** (`consoleA_closeCodes: []`, `consoleB_closeCodes: []`) |
| Backend JSON / PostgreSQL / parity / frontend regression | **129/129**, **56/56**, **2/2**, **158/158**, typecheck clean — no drift |

**Not complete:** three Task 77.1 browser scenarios (reconnection H, multi-object
session I, and the member→owner DatabaseRow cell write D in a shared-fixture
run) remain blocked by the *pre-existing* virtualized-grid cell locator
fragility that Task 77.1 §12 item 10 already named as its single largest harness
weakness. These are harness blocks, not product results, and are enumerated in
§14.

**Final status: Browser verified (partial) — Task 77.2 is NOT Complete.**
The defect this task set out to fix is fixed and proven in a real browser on
both storage backends; the outstanding criteria are browser scenarios blocked by
test-harness fragility that this task did not resolve.

## 2. Task 77.1 defect recap

A real browser viewing a Database multiplexes several collab objects over ONE
WebSocket connection: the Database (collabType=1), one DatabaseRow
(collabType=4) per row, and the page Document (collabType=0). The backend held
a single `websocket.objectId` slot, overwritten by every successful
SyncRequest, and the fan-out filter was `peer.objectId === objectId`. By the
time a Database update was fanned out, every viewer's slot had drifted onto one
of its rows, so the peer-selection loop matched **zero** peers. Task 77.1's
instrumentation captured exactly that (`-> matching peers: 0`).

Task 77.1 §9.4 also explained why no existing test caught it:
`test/realtime-fanout.test.js` passes 4/4 because its `syncBoth()` helper points
both sockets at exactly **one** object, so the slot always matched.

## 3. Existing architecture and root-cause confirmation

Re-verified against the current source rather than trusting the report
(§2 of the task brief). **Evidence tier: static inspection**, confirmed
afterwards by the executed tests in §9–§13.

### A. Connection lifecycle

| Item | Location (pre-fix line numbers) |
|---|---|
| `websocketPeers` created | `server.js:1888`, one `Set` per `createApp` |
| Socket properties attached | `workspaceId` 1953, `userId` 1954, `accessToken` 1955, `objectId` 1956 (init `null`) |
| `websocket.collabType` | **never assigned** — the socket carries no collab type at all |
| `objectId` assigned (4 sites) | 2107 Document, 2284 Database, 2466 DatabaseRow, 2608 WorkspaceDatabase (ct=2) |
| Updated on every SyncRequest | **Yes** — each site overwrites the slot |
| Successful admission point | after the authorization fetch and successful Yjs state computation, immediately before the manifest is sent |
| Invalid SyncRequests rejected | 2049/2075/2079/2087 (Doc), 2226/2252/2256/2264 (DB), 2408/2434/2438/2446 (Row) — all `close()` |
| Removed from `websocketPeers` | 2654 `close`, 2658 `error`, **1987** periodic revalidation |
| Authorization revalidation | per-inbound-frame 2020–2032, plus the bounded periodic timer 1980–1996 |
| Same cleanup path for all terminations? | All three delete from `websocketPeers`; `close`/`error` additionally `clearInterval`. The revalidation path deletes **synchronously before** `close()`, deliberately (comment at 1972–1978). |

### B. Existing fan-out — confirmed verbatim

All three content paths and all four awareness paths used the identical filter:

```js
if (peer !== websocket && peer.readyState === 1 &&
    peer.workspaceId === websocket.workspaceId && peer.objectId === <objectId>) {
```

Content: `2167` Document, `2345` Database, `2527` DatabaseRow.
Awareness: `2202` Document, `2380` Database, `2562` DatabaseRow, `2637` ct=2.

The Task 77.1 report's quoted code is **still exactly accurate**; no drift.

### C. Admission semantics — preserved unchanged

The single slot *is* the admission mechanism: an inbound `update` is rejected
with `close(1008, '... SyncRequest is required before updates')` unless
`websocket.objectId` equals the update's object (`2121`, `2298`, `2480`).
ct=2 updates are always rejected (`2631`). This is precisely the contract the
frontend Task 71/76/76.1 work exists to satisfy, so **nothing about it was
changed** — see §6.

### D. Object identity — composite identity is REQUIRED, not merely defensive

This was tested rather than assumed, and the answer differs per backend:

| Question | JSON | PostgreSQL |
|---|---|---|
| Can the same `database_id` exist in two workspaces? | **No** — `409` | **Yes** — accepted |
| Can a Document and a Database share one object id? | **Yes** — accepted | **Yes** — accepted |

Both ids are client-supplied (`view_id`, `database_id`), and the store accepts a
Document and a Database with the **same** object id in the same workspace on
*both* backends. Since the socket never carried a collab type, pre-fix routing
was effectively object-id-only within a workspace. A composite
`workspaceId + collabType + objectId` identity is therefore a correctness
requirement. Scenario E proves the isolation holds, and Scenario D on
PostgreSQL exercises the genuinely-shared-id case.

## 4. Files changed and why

| File | Classification | Why |
|---|---|---|
| `server.js` | **Production (backend)** | The fix: subscription registry, registration at the 4 admission sites, 7 fan-out filters re-routed, cleared on all 3 termination paths. 23 functional lines (+65 incl. comments); 2676 → 2741 lines. md5 `974a11fc…` → `f46509f6…` |
| `test/multi-object-subscriptions.test.js` | **New test** | Scenarios A–I at the real WebSocket/protobuf protocol level, runnable against JSON or PostgreSQL. Closes the coverage gap Task 77.1 §9.5 item 3 identified. |
| `test/helpers/test-environment.ts` | **Test infrastructure** | §8 hardening: a canonical pristine `.env.local` backup so a killed Playwright worker can no longer poison the next run's baseline (Task 77.1 §11.1a recommendation). Additive; no existing behavior changed. |
| `test/helpers/.env.local.pristine` | Test artifact | The canonical backup, created on first run (md5 `c85de40f…`, matching the real config). |
| `package.json` | Test scripts | Added `test:multi-object-subscriptions` and `test:multi-object-subscriptions-postgres`. |
| `docs/TASK77_2_MULTI_OBJECT_SUBSCRIPTION_REPORT.md` | Documentation | This file. |

**No frontend production file was created or modified.** `AppFlowy-Web`
`git status --short` is **33 entries** before and after, unchanged. No commits,
no pushes, no `git reset`/`checkout`/`clean`/`restore`. The upstream `AppFlowy`
repo and the commercial repo were not touched.

## 5. Subscription identity and lifecycle design

**Identity.** `subscriptionKey(workspaceId, collabType, objectId)` →
`` `${workspaceId}\u0000${collabType}\u0000${objectId}` ``. NUL is the
delimiter because it cannot occur in a validated workspace or object id, which
makes key construction collision-safe. A `Set` of these keys lives on each
socket as `websocket.subscriptions`.

**Lifecycle.**

| Phase | Behavior |
|---|---|
| Connect | `websocket.subscriptions = new Set()` beside `websocket.objectId = null` |
| Successful SyncRequest | `subscriptions.add(key)` on the line after the pre-existing `websocketPeers.add(websocket)` — i.e. strictly after auth, workspace membership, object admission and successful state computation |
| Rejected SyncRequest | nothing added (every rejection path `close()`s before reaching the registration line) |
| Active binding changes | registry is **never** cleared; `objectId` moves, subscriptions accumulate |
| Re-binding the same object | `Set` semantics ⇒ no duplicate, no duplicate delivery (Scenario C) |
| Socket close / error | `subscriptions.clear()` beside the pre-existing `websocketPeers.delete(websocket)` |
| Authorization revoked | `subscriptions.clear()` in the **same synchronous step** as the peer-registry delete, before `close()`, so no fan-out iteration running during the close handshake can select the socket on either test |

Removal from `websocketPeers` alone already makes a socket unreachable (every
fan-out loop iterates that registry), so clearing is not strictly required for
correctness; it is done so per-connection state cannot outlive the connection.
This is stated explicitly in the code comment rather than left implicit.

## 6. Admission behavior preserved

- `websocket.objectId` keeps its exact meaning and all four assignment sites.
- All three `websocket.objectId !== X → close(1008)` update-admission checks are
  **textually unchanged**.
- Every sender-side awareness gate (`websocket.objectId === X`) is
  **textually unchanged**, so no close code or rejection path moved. Only the
  *peer-selection* half of those loops was re-routed.
- The subscription registry is never consulted to admit anything. It only
  selects recipients.
- **Observed result: zero `1008`/`1003` closes in every protocol and browser run
  of this task**, matching the Task 77.1 invariant exactly.

## 7. Fan-out behavior before and after

**Before:** `peer.objectId === objectId` — a single-slot comparison that
silently stopped matching a legitimately-subscribed peer as soon as that peer
SyncRequested any other object.

**After:** `peer.subscriptions?.has(subscriptionKey(workspaceId, collabType, objectId))`
— applied at all 7 sites (3 content + 4 awareness). `grep -c "peer.objectId ==="`
→ 0 routing uses remain (one occurrence survives, inside the explanatory
comment).

Preserved by construction and asserted by tests: sender exclusion
(`peer !== websocket`, Scenario A), `readyState === 1` skipping, the redundant
explicit `peer.workspaceId` comparison kept as defense-in-depth alongside the
workspace-bearing key (Scenario D), per-peer try/catch isolation (Scenario I),
persistence-before-acknowledgement ordering and the ack/manifest frames (all
untouched; `test:realtime-fanout` 4/4 and `test:collaboration-recovery` 8/8
still green). No workspace-wide broadcast fallback was introduced; Database
and DatabaseRow subscriptions cannot match each other (Scenario E).

## 8. Authorization and cleanup behavior

Unchanged rules, unchanged revalidation interval, unchanged close codes. The
only addition is `subscriptions.clear()` on the three existing termination
paths. Scenario H proves, with a real revocation against the real periodic
revalidation timer (`wsRevalidationIntervalMs: 150`), that an **idle** revoked
multi-object subscriber is closed with `1008` and receives no further Database
or DatabaseRow fan-out, while a still-authorized peer keeps receiving both.

## 9. Tests executed with exact commands

```bash
# New protocol-level regression suite -- JSON
node --test --test-timeout=90000 --test-reporter=spec test/multi-object-subscriptions.test.js

# Same suite -- real PostgreSQL
DATABASE_URL=postgresql://achal@localhost:5432/appflowy_independent_test \
TASK77_2_STORAGE=postgres \
node --test --test-timeout=120000 --test-reporter=spec test/multi-object-subscriptions.test.js

# Revert check (temporary; reverted and md5-verified afterwards)
perl -0pi -e 's/peer\.subscriptions\?\.has\(documentPeerKey\)/peer.objectId === pageId/; ...' server.js
node --test --test-timeout=60000 --test-reporter=spec --test-name-pattern="Scenario B" test/multi-object-subscriptions.test.js

# Backend regression (JSON)
npm test; npm run test:offline-collab; npm run test:database-collab
npm run test:database-row-collab; npm run test:database-catalog
npm run test:database-view-collab; npm run test:realtime-fanout
npm run test:security; npm run test:collaboration-recovery; npm run test:row-document
npm run test:collab-conformance

# Backend regression (PostgreSQL)
DATABASE_URL=... npm run test:postgres
DATABASE_URL=... npm run test:parity

# Frontend
npx jest AppSyncLayer.test.tsx useSync.test.ts useSyncContextLifecycle.history.test.ts \
  useSyncContextLifecycle.ordering.test.ts sync-outbox.test.ts src/application/db/__tests__ --coverage=false
npm run type-check

# Real browser -- the Task 77.1 acceptance bar, JSON
npx playwright test test/e2e/task77-1-database-multiuser.spec.ts -g "A\. Database-level" --reporter=line
npx playwright test test/e2e/task77-1-database-multiuser.spec.ts -g "B\. Database-level" --reporter=line
npx playwright test test/e2e/task77-1-database-multiuser.spec.ts -g "E\. row creation" --reporter=line
npx playwright test test/e2e/task77-1-database-multiuser.spec.ts \
  -g "P0\.|A\. Database-level|B\. Database-level|C\. DatabaseRow|D\. DatabaseRow|E\. row creation" --reporter=line

# Real browser -- real PostgreSQL
TASK77_PG_STORAGE=1 DATABASE_URL=... npx playwright test \
  test/e2e/task77-1-database-multiuser.spec.ts -g "A\. Database-level" --reporter=line
TASK77_PG_STORAGE=1 DATABASE_URL=... npx playwright test \
  test/e2e/task77-1-database-multiuser.spec.ts -g "E\. row creation" --reporter=line
```

## 10. Test results and evidence

### 10.1 The revert check (causality, not correlation)

With the three content fan-out filters restored to `peer.objectId === X` and
nothing else changed, Scenario B fails on exactly the Task 77.1 symptom:

```
✖ Task 77.2 Scenario B (JSON, CENTRAL REGRESSION) ... (10118.452625ms)
  AssertionError: Database (collabType=1) update must reach a connection whose
  active binding has moved to a DatabaseRow -- this is the Task 77.1 defect
    actual: null
    expected: true
```

With the fix restored (`server.js` md5 re-verified `f46509f6…`), the same test
passes in 89–125 ms. **The test proves the fix, not merely coexists with it.**

### 10.2 New protocol-level suite — Scenarios A–I

**Evidence tier: real WebSocket/protobuf protocol test over real HTTP, against
real JSON and real PostgreSQL persistence.** No mocks; no direct manipulation of
`websocket.subscriptions` to create state (it is only *read* in Scenarios G and I
to assert server-side cleanup and to locate a fault-injection target).

| # | Scenario | JSON | PostgreSQL |
|---|---|---|---|
| A | Single-object compatibility + sender exclusion | **PASSED** | **PASSED** |
| B | **Database + 2 DatabaseRows on one connection** (active binding on the last row) | **PASSED** | **PASSED** |
| C | Object switching / re-bind, exactly-once delivery | **PASSED** | **PASSED** |
| D | Workspace isolation | **PASSED** | **PASSED** (shared id) |
| E | Collab-type isolation, incl. shared object id + positive control | **PASSED** | **PASSED** |
| F | Rejected SyncRequest registers no subscription | **PASSED** | **PASSED** |
| G | Connection cleanup (asserted on server-side state) | **PASSED** | **PASSED** |
| H | Authorization revocation of an idle multi-object subscriber | **PASSED** | **PASSED** |
| I | One peer's `send()` throws; others unaffected | **PASSED** | **PASSED** |

Scenario I's log line confirms the fault injection fired inside the real
Database fan-out loop, not a stub:

```
WebSocket Database peer fan-out failed Error: task77.2 simulated flaky peer send failure
    at processFrame (.../server.js:2394:30)
```

Scenario E carries a **positive control** — after asserting that Database and
DatabaseRow updates do not reach a Document subscriber, it asserts that a
Document update *does*, so the negative assertions cannot pass vacuously.

## 11. JSON results

**Evidence tier: real JSON persistence.**

```
test/multi-object-subscriptions.test.js   tests 9   pass 9   fail 0   (11.9 s)
```

Regression, all matching the Task 77.1 baseline exactly:

```
npm test                            tests 38  pass 38  fail 0
npm run test:offline-collab         tests  5  pass  5  fail 0
npm run test:database-collab        tests 13  pass 13  fail 0
npm run test:database-row-collab    tests 11  pass 11  fail 0
npm run test:database-catalog       tests 17  pass 17  fail 0
npm run test:database-view-collab   tests  6  pass  6  fail 0
npm run test:realtime-fanout        tests  4  pass  4  fail 0
npm run test:security               tests 23  pass 23  fail 0
npm run test:collaboration-recovery tests  8  pass  8  fail 0
npm run test:row-document           tests  4  pass  4  fail 0
                                    ---------------------------
                                    TOTAL 129  pass 129  fail 0
```

`npm run test:collab-conformance` → exit 0, 6 RESOLVED + 1 PENDING
(`cross-instance-replay`, pre-existing and unrelated), no FAIL.

## 12. PostgreSQL results

**Evidence tier: real PostgreSQL** (`appflowy_independent_test`, the
pre-existing isolated test database; `pg_isready` → accepting connections).
Nothing production or commercial was touched.

```
TASK77_2_STORAGE=postgres ... test/multi-object-subscriptions.test.js
                                    tests 9   pass 9   fail 0
DATABASE_URL=... npm run test:postgres   tests 56  pass 56  fail 0
DATABASE_URL=... npm run test:parity     tests  2  pass  2  fail 0
```

The subscription registry is ephemeral per-connection state: **no table, no
migration, no schema change** was added, as anticipated. It is nonetheless
proven on both backends rather than assumed storage-agnostic — the same nine
scenarios run unchanged in either mode, selected by `TASK77_2_STORAGE`, rather
than maintaining a duplicate Postgres copy of the file.

## 13. Real-browser results

**Evidence tier: real browser** (Chromium via the project's pinned
`@playwright/test`), two independent `browser.newContext()` instances, two
separately registered and authenticated users, real workspace membership, both
clients navigating via the **real sidebar route**
(`memberOpenedDatabase.via = "sidebar(attempt 1)"`,
`ownerOpenedDatabase.via = "sidebar(attempt 1)"`), never a deep link.

Per Task 71 §3, the backend's HTTP `collab_full_sync_batch` slow lane persists
but never fans out to connected peers — so a mutation appearing on the **peer's
page with no reload** is by construction live WebSocket evidence.
`peerLiveNoReloadMs` below is that measurement. No HTTP-fallback result is
counted as live delivery anywhere in this report.

### 13.1 The Task 77.1 acceptance bar — JSON

| Task 77.1 §4 | Writer UI | **Peer live, no reload** | Backend persisted | After reload | Task 77.1 | Task 77.2 |
|---|---|---|---|---|---|---|
| **A** Database field rename, owner→member | ✓ | **✓ 27 ms** | ✓ | ✓ | ✗ null, FAILED | **PASSED** |
| **B** Database field rename, member→owner | ✓ | **✓ 16 ms** | ✓ | ✓ | ✗ null, FAILED | **PASSED** |
| **E** Row creation (`row_orders`) fan-out | — | **✓ 20 ms** | ✓ (`backendRowOrdersContains: true`) | — | ✗ null, FAILED | **PASSED** |

Raw evidence (`docs/task77-1-evidence/results-json.json`, written by Task 77.1's
own unmodified spec):

```json
"scenarioA": { "marker": "T771A-1794393620499", "writerUiContains": true,
               "peerLiveNoReloadMs": 27,
               "backendPersistedFieldName": "T771A-1794393620499",
               "peerAfterReloadContains": true }
"scenarioB": { "marker": "T771B-1794393662461", "writerUiContains": true,
               "peerLiveNoReloadMs": 16,
               "backendPersistedFieldName": "T771B-1794393662461",
               "peerAfterReloadContains": true }
"scenarioE": { "newRowId": "a5e5b8eb-db41-4077-93f2-11b51fd8ed16",
               "peerLiveNoReloadMs": 20, "backendRowOrdersContains": true }
"consoleA_closeCodes": [],  "consoleB_closeCodes": []
```

All three were measured against the **unmodified Task 77.1 spec** — the same
file, the same assertions that recorded FAILED before this fix. The spec was not
edited to make anything pass.

### 13.2 Real browser on real PostgreSQL

| Scenario | Peer live, no reload | Backend persisted | Result |
|---|---|---|---|
| A — Database field rename, owner→member | **✓ 16 ms** | ✓ | **PASSED** |
| E — Row creation fan-out | **✓ 20 ms** | ✓ | **PASSED** |

`"setup": { "storage": "postgres", ... }` confirms the backend really was
PostgreSQL-backed; `consoleA_closeCodes: []`, `consoleB_closeCodes: []`.
Task 77.1 had recorded Database-level PostgreSQL delivery as NOT TESTED.

### 13.3 Mapping to the §6 required browser scenarios

| §6 | Requirement | Result | Basis |
|---|---|---|---|
| A | Database live updates, both directions, while the connection also holds a DatabaseRow | **PASSED** | 13.1 A and B. A browser viewing a grid *inherently* subscribes to the Database plus a DatabaseRow per row — that is the defect mechanism itself, so these runs are by construction the multi-object case |
| B | DatabaseRow live updates, both directions | **PASSED** | Task 77.1 C (owner→member) and D (member→owner), both re-run and passing individually; C also passed in the 6-test combined run |
| C | Explicit multi-object sequence as a distinct spec | **PARTIAL / NOT TESTED as a separate spec** | Substantively covered by §6A/§6B above and by protocol Scenario B; Task 77.1's own multi-object spec (I) remains harness-blocked — see §14 |
| D | Persistence after reload; persistence after a genuine backend restart | **PARTIAL**: reload persistence **PASSED** (`peerAfterReloadContains: true` in A and B); restart **BLOCKED** | Task 77.1 scenario H fails in `writeCell` at spec line 891 on the virtualized-cell locator, before reaching any restart assertion |
| E | Core scenario against real PostgreSQL | **PASSED** | 13.2 |

### 13.4 Combined-run observation, reported honestly

Each of P0, A, B, C, D, E passes when run individually. A single shared-fixture
run of all six yields 4 passed / 2 failed, and a run of A+B+E yields 2 passed /
1 failed — the failures being `renameField`'s field-header click and
`writeCell`'s cell locator timing out on the second writer's page after earlier
tests have mutated the same field/grid. Both failures are UI-interaction
timeouts inside the test helpers, reached **before** any delivery assertion, and
both scenarios pass in isolation (B: 32.6 s, D: 30.7 s). This is the
sticky-header duplication and virtualized-cell fragility that Task 77.1 §3.1
and §12 item 10 already documented. **It is a harness limitation, not a fan-out
result, and no scenario is claimed as passing on the strength of a different
scenario's run.**

## 14. Known limitations and untested scenarios

Explicit, not silently dropped:

1. **Task 77.1 scenario H — genuine backend restart with two clients:
   BLOCKED.** Fails in `writeCell` (spec line 891) on the virtualized-grid cell
   locator after `restartBackend()`, exactly as in Task 77.1. No claim is made
   about restart behavior. Reload-level persistence *is* verified (§13.3 D).
2. **Task 77.1 scenario I — multi-object session (Document + Database +
   DatabaseRow): BLOCKED.** Fails in `writeCell` (spec line 957) before any
   delivery assertion. The equivalent property is proven at the protocol level
   by Scenario B and in the browser by §13.1, but the browser-level
   three-collab-type session remains unverified.
3. **A dedicated `task77-2-multi-object-subscriptions.spec.ts` was NOT
   created.** §6 asked for one. Judgement call, disclosed: Task 77.1's helpers
   are defined inside its spec file rather than exported, so a new spec meant
   either duplicating ~250 lines of fragile grid-interaction helpers (the
   "second competing framework" §6 warns against) or refactoring the spec of
   record. The acceptance bar — Task 77.1 §4 A/B/E — was instead met against
   that unmodified spec, which gives strictly better before/after
   comparability. The genuine residual gap is item 2 above.
4. **Combined-run flakiness (§13.4) was not fixed.** Fixing it means
   addressing the virtualized-cell/sticky-header locators, which Task 77.1 §12
   item 10 already scoped as its own follow-up and which is outside this task's
   "smallest safe backend change" mandate.
5. **The awareness-relay peer filter was re-routed too, and is covered only
   indirectly.** The 4 awareness loops had the identical slot-drift bug; their
   peer-selection halves now use the registry (sender-side gates untouched, so
   no close code moved). The existing awareness coverage in
   `test:realtime-fanout` and `test:security` still passes, but no new test
   asserts multi-object *awareness* delivery specifically. Lower risk than
   leaving one routing path inconsistent, but stated plainly.
6. **Single-instance only.** Nothing here addresses cross-instance fan-out; the
   pre-existing `cross-instance-replay` conformance item stays PENDING, as
   before.
7. **Nine pre-existing orphaned test processes from Task 77.1 are still
   running** — see §15. Not mine, not authorized for termination, left alone.
8. **Task 77.1 scenario F (concurrent separate-cell edits)** was not re-run;
   it was already FAILED-inconclusive and unreproduced in Task 77.1, and is
   unrelated to fan-out routing.

## 15. Process and configuration cleanup results

**`.env.local`: verified intact.**

```
APPFLOWY_BASE_URL=http://localhost:8787
APPFLOWY_GOTRUE_BASE_URL=http://localhost:8787
APPFLOWY_WS_BASE_URL=ws://localhost:8787/ws/v2
md5: c85de40fc13dc3b2379325c6ecc3471d   (== the verified pre-task value)
```

The new canonical pristine backup `test/helpers/.env.local.pristine` was created
with the identical md5, so the hardening canonized the *correct* value. A future
killed worker will now be detected (the live file matching a disposable
`127.0.0.1:19xxx` backend) and the pristine copy restored, instead of the dead
port being silently inherited as the new baseline.

**Processes.** Inspected live rather than trusting Task 77.1's PID list (§8).
My own runs leaked exactly two processes, which I terminated:

| PID | What | Action |
|---|---|---|
| 32467 | `vite --port 14141 --strictPort` (started 16:15:57, my last Postgres browser run) | **terminated**; port 14141 verified released |
| 32553 | `node server.js` (disposable test backend, started 16:16:18) | **terminated** |

**Nine pre-existing orphans from Task 77.1 were deliberately left running**
(PIDs 97325, 97329, 11764, 13713, 13811, 15220, 15224, 17228, 17352 — all
reparented to init, all on disposable `14xxx`/`19xxx` loopback ports, all
started 13:41–15:09, i.e. before this task). The user has not authorized
terminating them and the brief forbids acting on a historical PID list, so they
are reported, not killed. Suggested cleanup, for the user to run if they agree:
`kill 97325 97329 11764 13713 13811 15220 15224 17228 17352`

**Normal development environment intact:** port 8787 was free before and after
(the user's dev backend was not running at any point); no process outside my own
test runs was stopped; `AppFlowy-Web` `git status --short` is 33 entries,
unchanged.

**`server.js` integrity:** md5 `f46509f6e92a258cf8277a8614af62c9`, syntax-checked,
2741 lines. The temporary revert-experiment edit was restored from a byte-exact
backup and md5-verified before any further testing.

## 16. Final task status

**Browser verified (partial) — Task 77.2 is NOT Complete.**

The confirmed multi-object fan-out defect is **fixed**, with the smallest safe
backend change (23 functional lines, admission semantics untouched), and the fix
is proven:

- by a **revert check** that fails on exactly the original symptom;
- by **9/9 protocol-level scenarios on JSON and 9/9 on real PostgreSQL**,
  including the central Database-plus-two-DatabaseRows case and negative
  workspace/type-isolation, rejected-subscription, cleanup, revocation and
  fan-out-failure cases;
- by **real two-browser evidence** that the three Task 77.1 scenarios which
  FAILED (§4 A, B, E) now PASS, live in 16–27 ms, with backend persistence and
  post-reload retention, on **both** JSON and real PostgreSQL;
- with **zero `1008`/`1003` closes** anywhere, confirming Tasks 71/74/76/76.1
  remain intact;
- with **no regression drift**: 129/129, 56/56, 2/2, 158/158, typecheck clean.

It is **not Complete** because §10's acceptance table requires real-browser
multi-object and restart-persistence verification, and those two browser
scenarios (Task 77.1 I and H) remain blocked by the pre-existing virtualized-grid
locator fragility that this task did not resolve (§14 items 1–4). Per the brief's
own rule — "Do not mark Complete if a required browser scenario is blocked or not
tested" — the status is not upgraded merely because the implementation is
finished and independently proven at every other level.

**Recommended follow-up:** fix the virtualized-grid/sticky-header test locators
(already scoped by Task 77.1 §12 item 10), then re-run Task 77.1 scenarios H and
I unchanged. That is the whole remaining distance to Complete.
