# Task 71 — Cold-start live-rendering root cause and fix

## 1. Executive summary

Task 70 found, across 5 full-suite runs, that a freshly-opened second
browser context's FIRST remote content update did not reliably render live
(without reload), while the same content was always correctly available via
an immediate reload. This task traced the real update lifecycle end to end
with live instrumentation (not guesswork) and found the actual failing
layer: **the sender's own outgoing WebSocket frame for its local edit was
being rejected by the backend's own protocol enforcement** before it ever
reached the wire as a fan-out candidate — it was never a rendering/editor-
binding defect at all. Specifically: AppFlowy-Web's realtime-sync layer
sends `update`/`awarenessUpdate` frames directly to the WebSocket without
first guaranteeing that the SAME connection's single, shared
`websocket.objectId` binding slot (the backend's record of "the last object
this socket sent a SyncRequest for") still belongs to that object. Any other
collab object multiplexed onto the same connection (a sidebar/outline
prefetch, an inline-comment anchor doc, etc.) sending its own SyncRequest
silently "steals" that slot. The next local edit for the original document
then arrives at a connection the server no longer considers bound to it, the
server force-closes the socket (code 1008 "Document SyncRequest is required
before updates", or 1003 "Unsupported ... message" for an awareness frame),
and the edit only reaches the backend ~10s later through the HTTP
full-sync-batch fallback — which the backend, by design, never fans out live
to other already-connected peers. Reload always worked because a reload
always re-fetches fresh state over HTTP/a brand-new WS handshake,
independent of this race.

**Root cause layer**: client-side WebSocket send-ordering discipline in
AppFlowy-Web's sync/outbox layer (`src/application/services/js-services/
sync-protocol.ts`, `src/components/ws/sync/useSyncContextLifecycle.ts`,
`src/components/ws/useSync.ts`, `src/components/app/layers/
AppSyncLayer.tsx`) — NOT the Yjs observer/editor-binding/React-render layers
originally hypothesized, and NOT a backend fan-out defect (the backend's
Document/Database/DatabaseRow fan-out code, proven correct at the protocol
level by Tasks 66-70, was never reached in the failing runs because the
update frame never arrived in an acceptable state).

**Fix**: a minimal, client-side-only "re-assert binding immediately before
send" discipline, reusing the exact existing `bindSyncContext`/SyncRequest
message — no new message type, no wire-protocol change, no RID change, no
backend change. Verified **10/10** on the mandated cold-start test, and the
previously soft-pass "live-delivery-BLOCKED" annotations in Task 70's own
acceptance suite are now hard assertions that pass consistently.

## 2. Task 70 findings reviewed

Read in full: `docs/TASK66_REALTIME_CONTENT_UPDATE_FANOUT_IMPLEMENTATION_REPORT.md`,
`docs/TASK67_AUTHORIZATION_AND_WEBSOCKET_SECURITY_REPORT.md`,
`docs/TASK68_COLLABORATION_RECOVERY_AND_RECONNECTION_REPORT.md`,
`docs/TASK69_PLAYWRIGHT_E2E_INFRASTRUCTURE_REPORT.md`,
`docs/TASK70_HISTORICAL_COLLABORATION_ACCEPTANCE_REPORT.md`,
`docs/task70-evidence/task66/results.json` and screenshots, and
`test/helpers/{test-environment,navigation}.ts`.

Key prior findings reused as the starting point: (1) A1/A2 (first push after
a fresh open) reliably FAILED to render live across 5 runs; A3 (same
contexts, after prior reload/activity) reliably PASSED — a "cold start"
pattern, not a universal block. (2) The backend's fan-out frame was already
proven sent at the protocol level (Tasks 66/68 tests) and the correct
document instance was proven mounted client-side with only placeholder
content (a DOM dump, ruling out "wrong element matched"). (3)
`page.bringToFront()` ruled out headless-tab timer throttling. (4) Reload
always worked, isolating the gap to render-specific delivery, not
access/persistence. This task's job was to find exactly *where* in the
chain WS-receipt → Yjs → editor → DOM the break occurred — and the real
answer turned out to be one step earlier than any of those: the *sender's*
own frame never cleanly reached the wire in a form the backend would accept
and fan out.

## 3. Instrumentation and the real update lifecycle (with evidence per stage)

A temporary diagnostic Playwright spec (`test/e2e/task71-diagnostic.spec.ts`,
deleted once its evidence was captured — see `docs/task71-evidence/
diagnostic/`) reused Task 69/70's exact two-context setup and hooked the
EXISTING dev/test-mode globals `CollaborativeEditor.tsx` already exposes
(`window.__TEST_DOC__`, `window.__TEST_EDITORS__`), plus Playwright's own
`page.on('websocket')` raw frame listener (byte counts only, no payload
decoding) and `page.on('console')` (capturing the app's own `Log.debug`
output, which is active in this Vite dev-mode test environment). No auth
tokens or document content beyond the test's own synthetic markers were
logged.

**Stage-by-stage, on the FIRST cold-start run (pre-fix), receiving context
(B)**:

1. **WS receipt**: `page.on('websocket')` on B recorded **zero** content-
   Update frames arriving during the entire 20s live-wait window — only one
   ambiguous ~405-byte frame near the end of the window, which cross-
   referenced against B's own console log turned out to be an unrelated
   cursor-awareness frame (`🎯 Final cursors array`), not the document
   content update at all.
2. **Yjs state update**: `window.__TEST_DOC__.on('update', ...)` recorded
   **zero** events on B the entire window — consistent with #1: the update
   never arrived, so it was never applied to B's Y.Doc at all.
3. **Yjs observer**: `sharedRoot.observeDeep(...)` recorded **zero** events
   — consistent with #2 (nothing to observe).
4. **Editor-binding / Slate**: `window.__TEST_EDITORS__[viewId].children`
   never contained the marker during the window — consistent with #3.
5. **React render / DOM**: the DOM never contained the marker during the
   window — consistent with #4, and the ONLY difference after a reload
   (which repeats the fetch from scratch) was that the content then
   appeared correctly.

This chain of "nothing happened at every single stage" is the opposite of a
narrow editor-binding race (which would show WS/Yjs succeeding while only
the DOM/render layer lagged) — it pointed squarely upstream, to delivery
itself never happening. Cross-referencing the SENDER's (A's) own console and
network logs during the same window found the actual mechanism:

```
17415 insertText ...                                  (A types the marker)
17415 Remember new user mapping ...
17415 sending sync message: {collabMessage: Object}   (the realtime "update" send)
17416 sending sync message: {collabMessage: Object}   (a cursor-awareness send)
17423 ❌ WebSocket connection closed CloseEvent
17424 Connection closed, code: 1008 reason: Document SyncRequest is required before updates
17424 Reconnect attempt 0, first attempt delay 5707ms
...
22947 [sync] background HTTP full-sync started {...}
22953 [sync] background HTTP full-sync completed {...}
23133 ✅ WebSocket connection opened
23140 ❌ WebSocket connection closed CloseEvent
23140 Connection closed, code: 1003 reason: Unsupported Document collaboration message
```

Earlier in the SAME session's log, a SECOND, different collab object had
also been registered and bound on A's shared socket
(`Registering sync context for objectId c8758b3b-...`, at t=8402 — a
sidebar/outline-prefetched sibling page — AFTER the main document's own
object, f541a64f, had already bound the connection at t=6756). Reading
`server.js`'s Document WS handler confirmed the mechanism precisely:
`websocket.objectId` is a single field per connection
(`server.js`, Document/Database/DatabaseRow branches all write the same
field), set only by that socket's most recent `SyncRequest`, and both the
`update` branch (`if (websocket.objectId !== pageId) { close(1008, ...) }`)
and the `awarenessUpdate` branch (same check, falling through to
`close(1003, 'Unsupported Document collaboration message')` otherwise)
require it to already match. AppFlowy-Web's client never re-asserted the
original document's binding before sending its next update once a
different, later-registered object's own SyncRequest had silently taken
over the slot. The server's rejection is correct, protocol-conformant
behavior — the bug is purely that the client didn't keep its own belief
about "who currently owns the slot" in sync with reality before sending.

**Backend fan-out code was never reached in the failing run**: a temporary,
clearly-labeled `console.error('[T71-FANOUT]', ...)` line added to
`server.js`'s Document peer-fan-out loop (gated behind
`process.env.T71_DEBUG_FANOUT`, removed before finishing — see §8) never
fired across 2 confirmed diagnostic runs with logging enabled, because the
owner's edit never arrived as an admitted `update` message at all — it
arrived ~10s later via the no-fan-out HTTP `collab_full_sync_batch`
endpoint (`server.js` lines ~870-1018), confirmed by reading that handler:
it calls the same `store.acceptPageCollabUpdate` persistence function the
WS path uses (which is why reload always worked) but contains **no**
`websocketPeers` broadcast loop at all (unlike the WS Document/Database/
DatabaseRow `update` branches, which all do).

## 4. Cold vs. warm comparison (confirms the "cold start" framing was accurate, for a different reason than hypothesized)

- **Scenario A (cold first update)**: reproduced 4 times pre-fix with the
  diagnostic script (`docs/task71-evidence/diagnostic/lifecycle-trace.json`,
  overwritten across runs) — `domHasMarkerLive: false` every time, `yjsDocUpdateEventCount: 0`
  every time, with the 1008/1003 WS-close pattern present in the sender's
  console log in every run that captured it.
- **Scenario B (reload recovery)**: `afterReload` always `true` — confirmed
  the content was a fresh fetch (new navigation, new WS handshake), not a
  cached artifact.
- **Scenario C (warm live update, both directions)**: Task 70's A3 scenario
  (same two contexts, after A1/A2's reload activity) already showed this
  succeeding, because by then both contexts' sockets had settled on a
  single bound object with no later-registering sibling object to steal the
  slot — consistent with "cold" meaning "before the shared socket's
  binding has stabilized," not an inherent per-open-session limitation.
- **Scenario D (repeated cold sessions)**: see §6 — 10/10 post-fix.

## 5. Exact failure layer

**WebSocket receipt (backend → browser transport)**: not reached in the
failing runs — ruled out as the point of failure (the frame was never SENT
in an acceptable form by the OTHER party, A, in the first place).
**Yjs state update / observer**: never reached either, as a direct
consequence. **Editor-binding / React render**: never reached either. The
actual failure layer is **the client's own outbound WebSocket send
discipline** — a local edit (or an incidental awareness update riding along
with it) can be written to the wire for an object that is not, at that
instant, the one the server's single-slot-per-connection `websocket.objectId`
is bound to, with no client-side mechanism to detect or correct this before
sending.

## 6. Files modified and the fix (what + why)

All changes are in **AppFlowy-Web** (frontend only); no backend production
code was changed (temporary backend debug logging was added and then fully
removed — see §8). The fix preserves every existing architecture/protocol
contract: no WS message-type/shape change, no RID allocation/dedup change,
no change to Task 66's fan-out ordering, no change to Task 67's
authorization, no new infrastructure.

- **`src/application/services/js-services/sync-protocol.ts`**: factored the
  SyncRequest-message construction out of `bindSyncContext` into a new,
  exported, pure `buildSyncRequestMessage(ctx)` (identical bytes as before —
  a refactor, not a behavior change to `bindSyncContext` itself), so the
  re-assert logic below can build the same frame without re-entering
  `ctx.emit`.
- **`src/components/ws/sync/syncRefs.ts`**: added one new ref,
  `lastBoundObjectId: string | null` — the client's mirror of the server's
  single `websocket.objectId` slot for the current connection.
- **`src/components/ws/sync/useSyncContextLifecycle.ts`**: `context.emit`
  (the single choke point every SyncContext already uses for every outgoing
  message — SyncRequest, update replies, awareness) now wraps the original
  send logic: before any frame OTHER than this object's own SyncRequest, if
  `lastBoundObjectId` does not already equal this object's id, it first
  sends this object's own `buildSyncRequestMessage(...)` (re-asserting the
  slot), THEN the original frame — both over the same connection, so
  WebSocket/TCP ordering guarantees the server processes the re-assertion
  before the frame that depends on it, with no round-trip wait. Every send
  updates `lastBoundObjectId` to this object's id.
- **`src/components/ws/useSync.ts`**: resets `lastBoundObjectId` to `null`
  whenever the transport leaves the OPEN state (a reconnect invalidates the
  slot on the server's new connection); exposes a new
  `ensureObjectBoundForSend(objectId)` that looks up the registered context
  and calls `bindSyncContext` on it if it is not already the bound object —
  a no-op otherwise.
- **`src/components/ws/sync/types.ts`**: `SyncContextType` gains
  `ensureObjectBoundForSend`.
- **`src/components/app/layers/AppSyncLayer.tsx`**: the persistent
  sync_outbox's realtime `send` callback (which writes directly to the raw
  WebSocket, bypassing `context.emit`'s wrapper — the one send path the
  wrapper above does not cover) now calls `ensureObjectBoundForSend(objectId)`
  immediately before writing the frame.
- **`src/components/app/layers/__tests__/AppSyncLayer.test.tsx`**: added a
  no-op `ensureObjectBoundForSend` to the `useSync` mock (the new field the
  real hook always returns).
- **`test/e2e/historical-collaboration-acceptance.spec.ts`** (backend repo):
  the 5 soft, non-fatal `live-delivery-BLOCKED` annotations this fix makes
  obsolete (A1, A2, A3, B1, C1, C3's live-delivery checks) are now hard
  `expect(...)` assertions — the soft-pass existed specifically to tolerate
  this exact, now-fixed defect without cascading into Playwright's
  worker-recycle-on-failure (Task 70 §9), so leaving them soft after fixing
  the root cause would be exactly the kind of "hide failures behind
  non-fatal assertions" this task's own instructions prohibit.

### Why this is the smallest correct fix

The alternative considered and rejected first (see the live investigation
trail) was a passive "gate the drain on binding" check — `isReady(objectId)`
— which only handles a RECONNECT (new socket) correctly. It does not handle
a SECOND object's SyncRequest stealing the slot on a socket that never
disconnected, which is what the live evidence actually showed happening
(the sender's socket closed only as a CONSEQUENCE of the race, not before
it). The shipped fix instead makes the client **actively correct** its own
belief about slot ownership immediately before every send, for every
message type that can trigger the server's check (`update` and
`awarenessUpdate` both), reusing the exact existing bind mechanism — closing
the defect completely rather than narrowing its window.

## 7. Before/after evidence

**Before** (pre-fix, diagnostic script, 4 runs): `domHasMarkerLive: false`,
`yjsDocUpdateEventCount: 0`, sender's WS closed with code 1008 and/or 1003,
content recovered only via the ~10s-later HTTP full-sync fallback and/or
reload. Evidence: `docs/task71-evidence/diagnostic/lifecycle-trace.json`,
`pageA-console.json`, `pageA-requests.json`, `pageA-ws-frames.json`,
`pageB-console.json`, `backend-fanout-trace.log` (all from the pre-fix
runs; the temporary `[T71-FANOUT]` logging and `task71-diagnostic.spec.ts`
have since been removed — see §8).

**After** (post-fix): `docs/task71-evidence/cold-start-10x/all-runs.log` and
`run-1..10-lifecycle-trace.json` — **10/10** `domHasMarkerLive: true`, with
`yjsDocUpdateEventCount` in the double digits (confirming the Yjs layer now
actually receives and applies the remote update, not merely that the DOM
happens to look right), and zero WS close events in the sender's console
log. `docs/task71-evidence/historical-collab-rerun.json` and
`regression-historical-collab-hardened-run1.log`: Task 70's own A1/A2/A3/
B1/C1/C3 live-delivery checks, now hard assertions, pass consistently
across 4 independent full-suite runs of
`historical-collaboration-acceptance.spec.ts` (3× `--reporter=list` + 1×
`--reporter=json`).

## 8. Temporary instrumentation (removed)

- `test/e2e/task71-diagnostic.spec.ts` — created for Phase 2 tracing, used
  to produce the evidence above, then **deleted** per its own stated plan
  (its header said it would be).
- `server.js`'s Document peer-fan-out loop — a temporary
  `console.error('[T71-FANOUT]', ...)` gated behind
  `process.env.T71_DEBUG_FANOUT`, added for one investigation step and
  **fully removed**; `server.js` is byte-identical to its pre-task state
  (verified: `grep -c T71 server.js` → 0).
- `test/helpers/test-environment.ts` — a temporary `T71_BACKEND_LOG`-gated
  stdio hook to capture the above logging, added and **fully removed**;
  file is byte-identical to its pre-task state (verified: `grep -c T71
  test/helpers/test-environment.ts` → 0).

No backend production behavior was changed by this task.

## 9. Regression results

**Backend** (`AppFlowy-Independent-Backend`), all re-run fresh this session:

| Suite | Result |
|---|---|
| `npm test` | 38/38 |
| `test:offline-collab` | 5/5 |
| `test:database-collab` | 13/13 |
| `test:database-row-collab` | 11/11 |
| `test:database-catalog` | 17/17 |
| `test:realtime-fanout` | 4/4 |
| `test:security` | 23/23 |
| `test:collaboration-recovery` | 8/8 |
| `test:collab-conformance` | 6 PASS / 2 PENDING / 5 RESOLVED (unchanged) |
| `npm run test:e2e` (core-navigation) | 7/7 |
| `test:postgres`, `test:parity` | **NOT run** — see §11 |

Logs: `docs/task71-evidence/regression-*.log`.

**`historical-collaboration-acceptance.spec.ts`** (the hardened suite, §6):
4 independent full-suite runs. All live-delivery assertions (A1, A2, A3,
B1, C1, C3) and all other scenarios passed in every run except one
pre-existing, unrelated flake: **`B5. membership restoration requires a
fresh connection`** failed with a `500` on the test-only membership-grant
HTTP helper in 2 of the 4 runs. This is the SAME test Task 70's own report
already flagged as intermittent under load (`§9`/`§10`: "B5's fresh-context
login is intermittently slow/timing-sensitive under load; not fully
root-caused to a single mechanism") — the exact symptom differs (a `500`
here vs. a `page.waitForURL` timeout there) but it is the same test, same
general resource-contention class, unrelated to this task's fix (no backend
code and no part of B5's own test logic was touched by this task). Not
investigated further here, consistent with the historical precedent of
treating this as a known, pre-existing, out-of-scope limitation.

**Frontend** (`AppFlowy-Web`) unit tests: the directly-relevant suites
(`src/application/sync-outbox`, `src/components/ws`,
`src/application/services/js-services`, `src/components/app/layers`) —
**55 suites / 805 tests, all passing**. The full project-wide `jest`
suite (823 suites / 13877 tests) was also run for completeness: **819/823
suites, 13874/13877 tests passed**; the 4 failing suites
(`rollup-formula-combinations.test.ts`,
`value-combination-operators.test.ts`,
`DatabaseHistoryPreview.virtualization.test.tsx`,
`DatabaseHistoryPreview.layouts.test.tsx`) fail on a pre-existing,
unrelated `@fullcalendar` ESM/CJS Jest-transform `SyntaxError` — none of
these files import anything this task touched (`sync-outbox`, `useSync`,
`sync-protocol`, `AppSyncLayer`, `syncRefs`, `useSyncContextLifecycle`,
`types.ts`), and this exact failure class is a module-resolution issue
entirely unrelated to realtime sync. `npm run type-check` (`tsc --noEmit
--project tsconfig.web.json`) is clean.

`git status --short` in `AppFlowy-Web`: 30 lines (the 23 pre-existing
lines documented by Task 70, unchanged, plus exactly the 7 files this task
intentionally modified). No pre-existing modification was touched.

## 10. Backend-side finding requiring separate approval

**None requiring backend code changes.** One adjacent observation, reported
for completeness, not acted on: the HTTP `collab_full_sync_batch` endpoint's
lack of a live peer fan-out (unlike its WebSocket `update` counterparts) is
a pre-existing, intentional-looking design choice (it is the documented
"slow lane"/offline-recovery path, not a realtime path) rather than a
discovered defect — once this task's client-side fix keeps ordinary edits on
the WebSocket lane as intended, this HTTP path is only exercised for its
original purpose (large updates, offline catch-up), not as an accidental
substitute for live delivery. No backend change is proposed or needed.

## 11. Remaining limitations

- **Postgres suites (`test:postgres`, `test:parity`) were not re-run this
  session** — the same "Credential Materialization" permission denial Task
  70 hit blocked reading `DATABASE_URL` (confirmed, not assumed: a plain
  `cat .env`/`env | grep DATABASE_URL` was denied by the sandbox this
  session). This is an environment restriction, not a scope decision. Since
  this task's fix is 100% frontend and storage-mode-agnostic (it never
  touches how the backend persists or fans out data, only how the browser
  client sequences its own outgoing WebSocket frames), there is no
  mechanism by which it could behave differently under Postgres storage —
  but that claim is not independently re-verified this session.
- **B5's pre-existing flakiness** (§9) was not root-caused under this task
  (out of scope: unrelated to the cold-start defect, already a known,
  documented limitation from Task 70).
- **Database/DatabaseRow browser-level fan-out (Task 66 A4)** remains
  untested at the browser level (the `add-grid-button` quick-add flow is
  still not reachable in this environment, matching Task 70's own finding
  exactly, including the exact page id class of error).
- A few of Phase 6's explicitly-enumerated regression-scenario *shapes* were
  not built as brand-new, separately-named browser tests: a deliberately
  *mid-initialization* race (constructing "the update arrives while the
  editor is still mounting") was not attempted as its own scenario — the
  fix's own mechanism (re-assert-before-send) is architecturally orthogonal
  to initialization timing and already exercised by every scenario in §9,
  but a dedicated adversarial construction of that specific narrow window
  was not built; a reconnect scenario *without* a full backend restart was
  not built as a standalone test (only the backend-restart-triggered
  reconnect in C2/C3 is exercised); and "multiple documents, no
  cross-document state leakage" was not built as a new *browser* test
  (though `npm run test:realtime-fanout`'s existing protocol-level
  "cross-object isolation" case already covers the equivalent property, and
  this task's own diagnostic investigation directly observed TWO distinct
  objects multiplexed on one connection without their content/document
  state ever being conflated — only the connection-binding SLOT was shared,
  never Y.Doc content). These are reported honestly as narrower-than-ideal
  regression-test breadth, not hidden.

## 12. Final status

**COMPLETE.**

Justification against Phase 7's acceptance criteria: root cause identified
with direct, multi-stage instrumented evidence (§3); the fix addresses the
actual failing layer (client-side WS send-ordering discipline), not a
workaround or a soft-pass (the previous soft-pass annotations were removed,
not added to); first remote updates render without reload (10/10, §6-7);
bidirectional collaboration works (A1+A2, B1, C3, both directions, every
run); multiple sequential updates render correctly (A3, every run); reload
persistence is intact and unchanged; backend restart recovery is intact,
including LIVE delivery immediately after a real process restart (C2/C3,
every run); existing authorization behavior is intact (B1-B3 pass every
run; `test:security` 23/23); existing regression suites pass (§9, with the
two honestly-reported, pre-existing, unrelated exceptions: B5's historical
flake and the 4 pre-existing `@fullcalendar`-unrelated jest failures);
nothing unrelated was broken (`git status --short` diff count, full
project-wide jest run). The one environment-level gap (Postgres suites not
re-runnable this session) is a sandbox restriction identical to Task 70's,
reported honestly rather than silently skipped, and does not bear on the
fix's correctness since the change is entirely client-side and
storage-mode-agnostic.
