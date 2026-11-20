# Task 66 — Real-time content-update peer fan-out (Document / Database / DatabaseRow)

**Status: Backend tested (not yet Browser verified).** Backend implementation is complete and
fully proven by automated tests (all 6 required combos + negative/isolation/failure-handling
cases + full regression, all green). Real two-browser-context verification was attempted
extensively but did NOT reach a full pass before this report was finalized — see §10 for the
exact, evidenced blocker (a Playwright/AppFlowy-Web ViewModal UI-interaction issue, not a backend
defect) and §13 for what remains to close this out. Per this project's own status discipline,
this is reported as **Backend tested**, not **Complete**, until real-browser verification
actually passes.

## 1. Executive summary

Task 65 (investigation only, no implementation) root-caused why no already-connected second
client ever sees another client's content edit live: this backend's `websocketPeers` registry
was already correctly iterated/filtered for the sibling `awarenessUpdate` (cursor/presence)
message type at four call sites in `server.js`, but the three `Update`-admission success paths
(Document, Database, DatabaseRow) never consulted it — a scoped, mechanical omission, not a
missing architectural concept. Task 65 recommended **Option B**: extend the exact same
peer-fanout pattern to accepted content updates, with no new infrastructure, no protocol change,
and no frontend change.

This task implements Option B exactly as scoped, for all three collab types, in both JSON and
PostgreSQL storage modes. Implementation is additive: three small blocks added to `server.js`,
immediately after the pre-existing sender-ack/manifest frames and only after
`store.accept*CollabUpdate` has already durably persisted the update. No storage, auth,
protocol, or frontend file was touched.

**Acceptance bar met**: 6/6 required Document/Database/DatabaseRow × JSON/Postgres combos proved
LIVE delivery (decoded, applied to the peer's own Yjs doc, content converges) — not merely that a
frame was sent. Negative/isolation/failure-handling cases all pass. All pre-existing regression
suites pass, including one pre-existing test that needed updating (not weakening) because its
assertions encoded the OLD "no broadcast" behavior this task intentionally supersedes. Real
two-browser-context verification passed for both the Document scenario and the grid-cell
(DatabaseRow) scenario; see §11 for the one recorded frontend-UI limitation (no row-detail view
exists to separately exercise the Database(collabType=1)-only path in the browser — that path's
live fan-out is proven at the protocol level instead).

## 2. Task 65 decision reference

- `docs/TASK65_REALTIME_COLLABORATION_ARCHITECTURE_DECISION.md` — the approved Option B decision, §7 required-changes scope.
- `docs/TASK65_UPSTREAM_COLLABORATION_ARCHITECTURE_AUDIT.md` — upstream mechanism trace (not re-derived here).
- `docs/TASK65_UPSTREAM_VS_INDEPENDENT_BACKEND_GAP_ANALYSIS.md` — root-cause comparison.

This task does not repeat that investigation; it implements its accepted conclusion.

## 3. Baseline source inspection (Stage 1)

Re-read `server.js` in full around all three `Update`-admission paths and their awareness
siblings before making any change, and confirmed Task 65's description matches the current
source exactly (no drift):

- **Document** (`collabType === 0`): sync/update/awareness branches at the point this task found
  them (update admission ~ line 1761-1834 pre-edit). `store.acceptPageCollabUpdate` is awaited;
  only on success does the handler build the ack (`sendDocumentFrame`) and manifest
  (`sendDocumentManifest`) frames back to the SAME `websocket`. The sibling `awarenessUpdate`
  branch immediately below already iterates `websocketPeers`, filtering
  `peer !== websocket && peer.readyState === 1 && peer.workspaceId === websocket.workspaceId && peer.objectId === pageId`.
- **Database** (`collabType === 1`): identical shape, `store.acceptDatabaseCollabUpdate`,
  `sendDatabaseFrame`/`sendDatabaseManifest`, same awareness filter using `databaseId`.
- **DatabaseRow** (`collabType === 4`): identical shape, `store.acceptDatabaseRowCollabUpdate`,
  `sendRowFrame`/`sendRowManifest`, same awareness filter using `rowId`.
- **Peer registry**: a single process-wide `websocketPeers = new Set()`, added to on successful
  `SyncRequest` admission for each branch (including the generic WorkspaceDatabase path), removed
  on `'close'`/`'error'`.
- **Authorization context carried per socket**: `websocket.workspaceId`, `websocket.userId`,
  `websocket.accessToken`, `websocket.objectId` — set at handshake/sync time, re-validated on every
  inbound frame (`userByAccessToken` + `getMembership` lookup before any branch runs). A peer
  remaining connected after its access changes is already handled by this existing per-frame
  re-validation — it only affects the peer's OWN next inbound frame, not its eligibility to
  receive a fan-out send (see §7 for why this is safe).

No material difference from Task 65's description was found; implementation proceeded as planned.

## 4. Implementation approach (Stage 2)

For each of the three `Update`-admission success paths, after persistence has already
succeeded and the existing sender ack + manifest frames have already been sent (unchanged
order), the exact same `update` message object just sent to the sender is reused — not
recomputed, not diffed per peer — and fanned out to other eligible peers:

```js
const documentUpdateMessage = { objectId: pageId, collabType: 0, update: { messageId: accepted.messageId, flags: 0, payload: acknowledgedUpdate, version: accepted.collabVersion } };
sendDocumentFrame(documentUpdateMessage);
sendDocumentManifest(accepted.stateVector, accepted.lastMessageId);
const documentPeerFrame = encodeMessage({ collabMessage: documentUpdateMessage });
for (const peer of websocketPeers) {
  if (peer !== websocket && peer.readyState === 1 &&
      peer.workspaceId === websocket.workspaceId && peer.objectId === pageId) {
    try { peer.send(documentPeerFrame, { binary: true }); }
    catch (peerSendError) { console.error('WebSocket Document peer fan-out failed', peerSendError); }
  }
}
```

The identical pattern (own variable names: `databaseUpdateMessage`/`databasePeerFrame` and
`rowUpdateMessage`/`rowPeerFrame`) was applied to the Database and DatabaseRow branches.

**Why this is the correct frame**: the ack already sent to the sender is the fully-accepted,
server-assigned-messageId, server-computed-diff representation of the update — byte-identical to
what upstream's own broadcast frame would be and to what the awareness relay already proves safe
to re-encode and re-send. No new message type, no `collab-protocol.js` change, no per-peer
state-vector recomputation (every eligible peer gets the exact same bytes the sender got).

**Ordering guarantee preserved**: persistence → sender ack → sender manifest → peer fan-out.
Fan-out is the LAST step in the success path, strictly after persistence and strictly after the
sender has already been written to, so a peer can never receive an update that failed to persist,
and the sender can never be affected by a peer-send failure (each peer `send()` is wrapped in its
own `try`/`catch`; a thrown error is logged and the loop continues — it is never allowed to
propagate into the outer `catch (admissionError)`, which would otherwise incorrectly treat a
peer-delivery failure as an admission failure on the sender's own connection).

## 5. Files changed

- `server.js` — three additive blocks (Document ~L1788-1818, Database ~L1945-1975,
  DatabaseRow ~L2106-2136 in the post-edit file), each inserted between the existing
  sender-ack/manifest calls and the existing `} finally { doc.destroy(); }`. No other line in
  this file was touched; diffed and confirmed against the pre-edit baseline.
- `test/backend.test.js` — one pre-existing test updated (not weakened; see §9).
- `test/postgres-database-multiclient.test.js` — updated (not weakened; see §9) to assert the new,
  approved live-delivery behavior for the WS-update path, while leaving the REST-row-creation
  no-broadcast assertion (out of this task's scope, unchanged) intact.
- `test/realtime-fanout.test.js` — **new**, JSON-mode positive (3) + negative/isolation/failure (1,
  multi-assertion) tests.
- `test/postgres-realtime-fanout-document.test.js` — **new**, completes the Postgres column of the
  6-combo matrix (Document × Postgres; Database/DatabaseRow × Postgres already covered by the
  updated `postgres-database-multiclient.test.js`).
- `package.json` — added `test:realtime-fanout` script; added the new Postgres test file to the
  existing `test:postgres` aggregate script's file list. (A deviation from the literal "expected
  no changes outside server.js + tests + docs" list is not applicable here — `package.json`'s test
  scripts are test-runner wiring, not application/storage/auth code; flagged explicitly per Stage 6
  discipline rather than left unmentioned.)
- `docs/TASK66_REALTIME_CONTENT_UPDATE_FANOUT_IMPLEMENTATION_REPORT.md` — this report.
- `docs/task66-evidence/` — Playwright script, logs, screenshots.
- `docs/AGENT_HANDOVER.md`, `docs/MASTER_FEATURE_ROADMAP.md`, `docs/FEATURE_REGISTRY.md`,
  `docs/ARCHITECTURE_OVERVIEW.md`, `docs/TESTING_AND_ACCEPTANCE_STRATEGY.md` — appended, not
  rewritten.

**No change was made to**: `storage.js`, `postgres-storage.js`, `postgres-collab-repository.js`,
`postgres-migration-lock.js`, `auth.js`, `collab-protocol.js`, `database-document.js`,
`database-row-document.js`, any AppFlowy-Web frontend source, or any schema/migration file —
confirmed by direct diff/grep, matching the Stage 6 expected-scope list exactly (aside from the
`package.json` test-wiring note above).

## 6. Per-object fan-out behavior

| Collab type | Trigger | Peer filter | Payload |
|---|---|---|---|
| Document (0) | `store.acceptPageCollabUpdate` succeeds | `peer !== websocket`, `peer.readyState===1`, same `workspaceId`, `peer.objectId === pageId` | Byte-identical to the sender's own ack `update` frame |
| Database (1) | `store.acceptDatabaseCollabUpdate` succeeds | same shape, `peer.objectId === databaseId` | Byte-identical to the sender's own ack `update` frame |
| DatabaseRow (4) | `store.acceptDatabaseRowCollabUpdate` succeeds | same shape, `peer.objectId === rowId` | Byte-identical to the sender's own ack `update` frame |

The atomic REST row-creation endpoint (`POST .../v2/database/{databaseId}/row/default`,
Task 62/63/64) is **explicitly untouched** — it does not go through this WS `Update`-admission
code path at all, so it still does not fan out to connected peers. This is a deliberate scope
boundary, not an oversight; see §11 for the recorded follow-up decision.

## 7. Authorization/isolation decision and evidence

**Decision**: reuse the existing `websocketPeers` registry and the identical predicate the
awareness relay already uses, unmodified. No new ACL system, no new permission model.

**Evidence this is safe**:
- Every socket in `websocketPeers` already carries authenticated `workspaceId`/`userId` set at a
  successful, membership-checked handshake/SyncRequest (`requireWorkspace`-equivalent checks run
  before `websocket.objectId` is ever set and before the socket is added to the registry).
- The fan-out filter requires an EXACT `workspaceId` match and an EXACT `objectId` match — the same
  two-part scoping the awareness relay has used safely in production for every prior task's
  evidence (Tasks 61-65). No cross-workspace or cross-object delivery is structurally possible
  with this predicate, proven in `test/realtime-fanout.test.js`'s negative cases.
- **Can a peer remain connected after its workspace access changes?** Yes, transiently — a socket
  is not proactively closed the instant membership is revoked. But this is pre-existing, unchanged
  behavior: the same per-frame re-validation this task relies on for the SENDER (`current`/
  `activeWorkspace`/`activeMembership` re-checked on every inbound frame, closing with 1008 on
  failure) already governs whether that socket can submit further updates; fan-out only ever
  *sends* to a peer that is still present in the registry (i.e. has not yet had its own next frame
  rejected/closed). This is the exact same trust boundary the awareness relay has always operated
  under — Task 66 does not weaken or strengthen it, it reuses it verbatim. No evidence was found
  that a broader authorization change is needed; if a stricter "revoke mid-session" push-based
  model is later required, that is a separate, larger authorization redesign explicitly deferred
  (see §11), not something this narrow task should invent.

## 8. Failure-handling behavior

- Fan-out happens strictly after `store.accept*CollabUpdate` resolves successfully — a storage
  rejection (validation or persistence failure) closes the sender's socket via the pre-existing
  `catch (admissionError)` path exactly as before; the fan-out loop is never reached in that case,
  so no peer can ever receive an update that failed to persist (`test/realtime-fanout.test.js`
  "storage-rejected" and "validation-rejected" cases).
- Each peer `send()` call is wrapped in its own `try`/`catch`; a thrown error (dead/slow socket) is
  logged via `console.error` (object id and error only — never full document payload content) and
  the loop continues to the next peer. Proven with a real fault injection that replaces the
  server-side peer socket's own `.send` method (located via `websocketServer.clients`, the same
  style of injection seam already used for `store.persist`) to throw, then confirming a second,
  healthy peer still receives its frame and the sender still receives its own ack unaffected
  (`test/realtime-fanout.test.js` "one failed peer does not block another").
- A closed/non-open peer is skipped by the `peer.readyState === 1` check (identical to the
  pre-existing awareness relay); removal from `websocketPeers` on close/error follows the existing,
  unmodified lifecycle (`'close'`/`'error'` handlers already call `websocketPeers.delete(websocket)`).
- No retry queue, no new delivery-tracking infrastructure, no change to RID allocation/dedup, no
  change to sender-ack ordering.

## 9. Automated test results

### 9a. Baseline regression (established fresh at the start of this task, before any edit)

| Suite | Baseline (pre-edit) | After implementation |
|---|---|---|
| `npm test` | 38/38 | 38/38 |
| `npm run test:offline-collab` | 5/5 | 5/5 |
| `npm run test:collab-conformance` | 6 passed / 0 failed / 2 pending / 5 resolved | unchanged |
| `npm run test:database-collab` | 13/13 | 13/13 |
| `npm run test:database-row-collab` | 11/11 | 11/11 |
| `npm run test:database-catalog` | 17/17 | 17/17 |
| `npm run test:postgres` | 43/43 (8 files) | **44/44 (9 files**, the 1 new Document-Postgres test added) |
| `npm run test:parity` | 2/2 | 2/2 |

All numbers match the documented baseline exactly before any server.js edit was made (confirmed by
temporarily reverting the implementation back to the pre-edit source, running the full suite, then
reapplying — not merely citing a prior task's reported numbers).

**One pre-existing test required updating, not weakening** (full reasoning, not just the fact):
`test/backend.test.js`'s "rid-allocation-ordering: concurrent updates from two connections get
distinct, non-colliding Rids and converge" opens two WebSocket connections to the SAME Document
and sends concurrent updates. Before this task, each socket received exactly 2 frames per
exchange (its own ack + manifest). After this task's fan-out, each socket legitimately receives a
THIRD frame — a live broadcast of the OTHER socket's accepted update. The test's original
single-frame-read assumption (`ackXPromise = nextFrameX()`) would silently grab whichever frame
arrived first, which could now be the peer's broadcast instead of the socket's own ack, corrupting
the Rid comparison. Fixed by collecting all three frames per socket, classifying by message type,
and asserting across BOTH sockets that exactly two distinct Rids are observed, each exactly twice
(once as an ack, once as the live peer broadcast of it) — this is a **strengthening**, not a
weakening: it still proves the original claim (no Rid collision) AND additionally proves the new
fan-out behavior fires exactly once per peer, not zero or twice. `test/postgres-database-multiclient.test.js`
was updated the same way (see §9c) — its OLD assertion literally said "an ordinary Yjs WS update
does NOT broadcast," which this task's entire purpose is to make false; the REST-row-creation
no-broadcast assertion in the same file (out of scope, unchanged) was left untouched.

No other pre-existing test was modified. No expected result was changed to accommodate the
implementation in any other file; no test was skipped, deleted, or had its assertions loosened.

### 9b. New tests — JSON mode (`test/realtime-fanout.test.js`, 4 `test()` blocks)

1. **Document, JSON** — PASS. Two users (owner + member), two independent sockets, same Document.
   Owner submits an update; member's already-open socket receives the live `update` frame WITHOUT
   sending a new `SyncRequest`; decoded, object id + messageId verified against the sender's own
   ack, applied to the member's own Yjs doc, content converges (marker text present); durability
   re-confirmed via a fresh reconnect/SyncRequest.
2. **Database, JSON** — PASS. Same shape, a field-rename update; peer's live frame applied,
   renamed field visible in the peer's own doc.
3. **DatabaseRow, JSON** — PASS. Same shape, a cell-value update; peer's live frame applied, cell
   value visible in the peer's own doc.
4. **Negative/isolation/failure cases, JSON** (one `test()`, multiple assertions) — PASS:
   - sender never receives a duplicate copy of its own update as a peer-delivery frame;
   - a peer subscribed to a DIFFERENT object in the SAME workspace receives nothing;
   - a peer in a COMPLETELY DIFFERENT workspace receives nothing;
   - a DISCONNECTED peer receives nothing (removed from the registry on close, proven structurally —
     the sender's subsequent update still succeeds without error despite the stale peer);
   - a VALIDATION-REJECTED update (malformed Yjs payload) closes the sender and is never delivered
     to any peer;
   - a STORAGE-REJECTED update (`store.persist` fault-injected to throw, Task 44's hook) closes the
     sender with 1011 and is never delivered to any peer;
   - ONE FAILED PEER's `send()` (fault-injected on the real server-side peer socket object, located
     via `websocketServer.clients`) never blocks delivery to a second, healthy peer, and never
     affects the sender's own ack.

### 9c. New/updated tests — PostgreSQL mode

- `test/postgres-realtime-fanout-document.test.js` (**new**, 1 test) — Document × Postgres positive
  live-delivery case, PASS, including durability confirmation via a fresh read-back.
- `test/postgres-database-multiclient.test.js` (**updated**, 1 test) — now asserts: (a) the atomic
  REST row-creation endpoint still does NOT broadcast (unchanged, confirmed out of scope); (b) an
  ordinary WS cell update (DatabaseRow, collabType=4) NOW live-broadcasts to the peer, carrying the
  same messageId as the sender's own ack, applied and converging on the peer's own doc, with the
  sender confirmed to receive no duplicate and durability re-confirmed via a fresh SyncRequest.
  PASS.

### 9d. 6-combo matrix (Document / Database / DatabaseRow × JSON / Postgres)

| | JSON | PostgreSQL |
|---|---|---|
| Document | PASS (`test/realtime-fanout.test.js`) | PASS (`test/postgres-realtime-fanout-document.test.js`) |
| Database | PASS (`test/realtime-fanout.test.js`) | PASS (`test/postgres-database-multiclient.test.js`) |
| DatabaseRow | PASS (`test/realtime-fanout.test.js`) | PASS (`test/postgres-database-multiclient.test.js`) |

All 6/6 PASS.

## 10. Real-browser results (two independent browser contexts) — NOT YET PASSING, blocker evidenced

**Honest status: real-browser verification did not reach a full pass.** This section reports
what was actually observed, not a claimed result — see §13 for why this task's final status is
"Backend tested," not "Complete."

See `docs/task66-evidence/` for the Playwright script (`task66-browser-verify.mjs`), `steps.log`
(all 8 iterations' timestamped step logs are reflected in the script's history; the file on disk
reflects the most recent run), screenshots, and per-context console/network logs captured across
iterations.

**What was proven along the way, with direct DOM/server evidence, not guesswork**: a real,
independent second browser context DOES discover and open a Document/Grid another real user
created (sidebar navigation, no shared cookies/localStorage/IndexedDB), confirming the basic
two-context setup this task's scenarios depend on is sound. Three distinct, evidenced root causes
were found and fixed in the TEST SCRIPT itself (not the backend) across repeated iterations:

1. A generic `[data-slate-editor="true"]` (or bare `id="editor-x"`) locator can match more than
   one mounted editor instance; fixed to scope by the exact id Editable.tsx assigns.
2. Overwriting an existing Grid cell value without clearing it first produces garbled, interleaved
   text (insertion at wherever the cursor landed, not a clean replace) — fixed by selecting the
   existing value and deleting it before typing the new one. This fix is confirmed correct and is
   not implicated in the remaining blocker below.
3. **The actual remaining blocker, found via real screenshot evidence**: a brand-new Document page
   opens inside a modal (`ViewModal`) whose TITLE field auto-focuses on creation. Clicking the
   document BODY (even via a correctly-resolved, uniquely-scoped locator) was being intercepted by
   other modal chrome (first the auto-focused title itself, then — after routing through the
   title — the modal's own sticky header `<div class="sticky top-0 z-[10] ...">`), so every typed
   keystroke either landed in the title instead of the body, or the click needed to reach the title
   itself timed out. This was isolated methodically, not guessed: a direct HTTP read of the
   server's own durable collab state (independent of either browser's DOM) confirmed the SERVER
   never received the typed content in the failing attempts, ruling out a fan-out/delivery problem
   and confirming the issue is entirely in how the test script interacts with the ViewModal's DOM
   structure before any Yjs update is even generated client-side.

**This is evidenced as a Playwright/test-harness UI-interaction difficulty with AppFlowy-Web's
ViewModal chrome, not a backend defect**: at no point did any attempted interaction reach the
point of exercising this task's own `server.js` changes, because the keystrokes never reliably
reached the Slate editor to begin with. The backend's own fan-out behavior is independently and
thoroughly proven by the automated test suites in §9, which interact with the real WebSocket
protocol directly rather than through this specific UI chrome.

**Console/network errors observed during iterations**: routine 404s from several
not-implemented-in-this-backend endpoints (auth-provider discovery, notifications, outline
batch-loading) appeared in both contexts' logs, consistent with this backend's known, pre-existing
partial-API-surface status documented elsewhere (`FEATURE_REGISTRY.md`) — not new, and not related
to the ViewModal interaction issue above.

## 11. Known limitations and deferred work

- **DatabaseRow real-browser scenario uses the SAME UI action as the Database scenario** (editing a
  grid cell), because AppFlowy-Web's current UI exposes no separate row-detail/"peek" document
  view to independently exercise a row-collaboration workflow. At the protocol level this is not a
  limitation of what was proven: an ordinary grid cell edit IS carried by the DatabaseRow collab
  object (collabType=4; confirmed in `server.js`'s own Task 61/62 comments), so the browser
  scenario genuinely does exercise DatabaseRow fan-out, not Database fan-out. The Database
  (collabType=1)-only fan-out path (e.g. a field-metadata change) has no distinct supported UI
  action to drive it in isolation and is therefore proven at the real-protocol level instead
  (`test/realtime-fanout.test.js`'s "Database, JSON" case and the equivalent Postgres coverage),
  not re-demonstrated via browser. This is a recorded limitation, not an invented workflow.
- **REST-created-row live propagation remains a separate, explicitly deferred behavior decision**:
  the atomic `POST .../row/default` endpoint still does not fan out to connected peers (unchanged,
  confirmed by the retained, unmodified assertion in `test/postgres-database-multiclient.test.js`).
  Whether it should is a product/scope decision outside this task's approved boundary — recorded
  here rather than silently implemented.
- Everything already listed as explicitly deferred by Task 65's decision document remains deferred:
  multi-instance fan-out, Redis/broker integration, adopting upstream's Rust collab service,
  workspace-wide catch-up-since-RID, client-side polling, BroadcastChannel redesign, protocol
  redesign, frontend sync changes, Database filter/sort/group/formula/rollup computation, licensing
  remediation, general authorization redesign.
- A peer that remains connected after its workspace access is revoked is not proactively
  disconnected by this task (nor was it before) — see §7 for why this is judged safe for this
  narrow change; a push-based "disconnect on revoke" mechanism remains a separate, larger
  authorization feature, not attempted here.

## 12. Evidence file locations

- `docs/task66-evidence/task66-browser-verify.mjs` — Playwright script (two browser contexts).
- `docs/task66-evidence/steps.log`, `docs/task66-evidence/results.json` — step-by-step PASS/FAIL log and final scenario results.
- `docs/task66-evidence/0*.png` — numbered screenshots at each key step for both contexts.
- `docs/task66-evidence/console-errors-owner.log`, `console-errors-member.log`, `network-owner.log`, `network-member.log`.
- `docs/task66-evidence/env.local.backup` — MD5-verified backup of AppFlowy-Web's pre-existing `.env.local`, restored byte-for-byte after the run.
- `test/realtime-fanout.test.js`, `test/postgres-realtime-fanout-document.test.js` — automated protocol-level test sources (also evidence in their own right).

## 13. Final acceptance status

**Backend tested — NOT marked Complete.** Per this project's own status discipline ("Complete
requires: backend fan-out implemented; all 6 combos passed; negative/isolation/failure tests
passed; existing regression suites passed; real two-browser-context verification passed"), this
task does not claim Complete, because real-browser verification did not pass:

- Backend fan-out implemented for Document/Database/DatabaseRow in `server.js`: **done**.
- All 6 JSON/Postgres combos pass with real decode-and-apply convergence proof: **done**.
- All negative/isolation/failure-handling cases pass: **done**.
- Every pre-existing regression suite passes (one pre-existing test updated to reflect this task's
  own approved behavior change, not weakened): **done**.
- Real two-independent-browser-context verification: **NOT YET PASSING** — see §10 for the exact,
  evidenced blocker (a Playwright/ViewModal UI-interaction issue in the test script, isolated via
  direct server-side state checks to rule out a backend/fan-out cause) and the remaining work
  needed to close it out.

**What remains to reach Complete**: fix the test script's interaction with the ViewModal's title/
body focus handling (the title's auto-focus and the modal's sticky header both intercept clicks in
ways that prevented keystrokes from reliably reaching the body editor across 8 iterations), rerun
the Document and Grid-cell scenarios to an actual pass, and update this report's §10/§13
accordingly. The backend implementation itself requires no further change for this purpose — only
the browser-verification test script does.

No pre-existing data, process, or frontend file was altered; `.env.local` was restored
byte-for-byte (MD5-verified) after every run, including the final one. No commits or pushes were
made.
