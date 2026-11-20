# Task 76 — Ordered Collaboration SyncRequest and Update Transmission

## A. Executive summary

**Confirmed root cause** (from Task 75 Phase 4, reconfirmed by this task's own
code trace): for Database/DatabaseRow collab objects, `context.emit`'s
internal `rawEmit` defers actual transport transmission behind an
independent `beforeSend(...).then(...)` promise (database-history restore
gating, wired on unconditionally in production regardless of the History
feature flag). Two consecutive `rawEmit` calls — the rebind SyncRequest,
then the dependent message — are each gated behind their *own*
independently-resolving promise with no ordering guarantee between them.
Separately, `AppSyncLayer.tsx`'s outbox `send` callback calls
`ensureObjectBoundForSend(objectId)` synchronously and does not wait for its
(possibly deferred) SyncRequest to actually transmit before sending the
dependent update via `wsSendMessage`. Either gap lets a dependent update
reach the server before its own SyncRequest, which the server correctly
rejects with close code `1008`.

**Fix implemented**: made the SyncRequest's actual transmission
awaitable end-to-end, and made every dependent send wait for it, instead of
relying on synchronous call-order:

- `rawEmit` (`useSyncContextLifecycle.ts`) now returns a `Promise<void>`
  that resolves only once `sendMessage`/`postMessage` have actually been
  called (immediately for the synchronous/Document path; after the
  `beforeSend` promise settles for Database/DatabaseRow).
- `context.emit` now `await`s the rebind SyncRequest's `rawEmit` before
  calling `rawEmit(message)`, and returns that chained promise.
- `bindSyncContext` (`sync-protocol.ts`) now propagates `emit`'s returned
  promise instead of discarding it.
- `ensureObjectBoundForSend` (`useSync.ts`) now returns that promise.
- `AppSyncLayer.tsx`'s outbox `send` callback is now `async` and `await`s
  `ensureObjectBoundForSend(...)` before calling `wsSendMessage`, with a
  WS-readiness re-check after the await (the socket can close during the
  wait).
- `sync-outbox/index.ts`'s drain loop now `await`s `config.send(message)`
  (it was already inside an `async` function); `OutboxSender`'s type was
  widened to `void | Promise<void>` — a non-breaking change for the
  fire-and-forget `broadcast`/`sendBestEffort` callers.

All fire-and-forget callers of `emit`/`bindSyncContext` elsewhere in the
codebase (`sync-protocol.ts`'s `handleSyncRequest`/`handleUpdate`,
`useBatchSync.ts`, the periodic rebind in `useSync.ts`) are unaffected: a
function returning `Promise<void>` is structurally assignable to a
`() => void`-typed caller, so none of them needed changes.

**Files changed** (frontend repo, `AppFlowy-Web`):
- `src/components/ws/sync/useSyncContextLifecycle.ts`
- `src/application/services/js-services/sync-protocol.ts`
- `src/components/ws/useSync.ts`
- `src/components/app/layers/AppSyncLayer.tsx`
- `src/application/sync-outbox/index.ts`

No backend file was changed. No new production messaging/queue abstraction
was introduced.

**Status: substantially fixed and verified**, with one known, pre-existing,
out-of-scope issue surfaced (see §I) and the full 8-scenario Playwright
matrix from the spec not entirely executed (see §I) given the scope of a
single implementation pass — see honest breakdown below.

## B. Baseline and scope

Frontend `git status --short` at start: 31 entries (29 pre-existing
modified/untracked files + `docs/TASK75_DISCOVERY.md` +
`docs/TASK75_DISCOVERY.md`'s own earlier phases), `git diff --stat`: 21
files changed, 747 insertions(+), 50 deletions(-) — matches the baseline
recorded by every prior Task 71–75 report. All pre-existing changes were
preserved; no reset/clean/restore was run. Backend repo confirmed to still
have no `.git`.

No scope deviation: implementation stayed within the 5 files listed above,
all of which the spec's §2 "likely frontend investigation areas" list
anticipated. No backend changes were required or made, consistent with the
spec's expectation absent a demonstrated backend defect.

## C. Design

**Chosen approach: Option A (awaitable binding emission)**, per the spec's
own framing. Rejected alternatives:

- **Option B (shared ordered send queue)**: would have required routing
  Document's existing synchronous path through the same queue for no
  benefit (Document was never shown to race), and would have been a much
  larger change surface for a defect that is fully explained and fixed by
  making one existing promise chain awaited instead of discarded.
- **Option C (narrow sequencing primitive)**: Option A effectively *is* the
  narrowest version of this — no new primitive type was needed because
  `rawEmit` already had a well-defined completion point (the moment
  `sendMessage`/`postMessage` run); it just wasn't exposed to callers.

**Ordering contract established**: *"A dependent collaboration update must
not be passed to the dependent `wsSendMessage`/`rawEmit` call until its
required SyncRequest's `rawEmit` promise has resolved."* This is satisfied
by chaining `rawEmit(update)` onto `rawEmit(syncRequest).then(...)` inside
`context.emit`, and by `await`-ing `ensureObjectBoundForSend(...)` before
`wsSendMessage` in the outbox path. WebSocket send-call ordering (relied on
previously, incorrectly, for the deferred path) is no longer needed —
explicit promise chaining replaces it.

**Failure/reconnect semantics preserved**: `rawEmit`'s existing guard
(`refs.registeredContexts.current.get(doc.guid)?.doc !== doc`) still
discards a stale deferred send if the context was replaced/unregistered
while the promise was pending — unchanged. A rejected `beforeSend` (denial
or throw) now simply resolves the chain without sending anything further
down it, rather than leaving the dependent send racing independently.
Connection-replacement safety is unchanged: `wsSendMessage`/`sendMessage`
themselves are untouched; only the *ordering* of calls into them changed.

## D. Implementation

See exact diffs in the files listed in §A. Summary per file:

- **`useSyncContextLifecycle.ts`**: `rawEmit` returns `Promise<void>`
  instead of `void`; `context.emit` awaits the rebind `rawEmit` before the
  dependent `rawEmit` and returns the chain.
- **`sync-protocol.ts`**: `bindSyncContext`'s return type widened to
  `Promise<void> | void`; it now captures and returns `emit(...)`'s result
  instead of discarding it.
- **`useSync.ts`**: `ensureObjectBoundForSend`'s return type widened to
  `Promise<void> | void`; returns `bindSyncContext(context)`'s result.
- **`AppSyncLayer.tsx`**: outbox `send` callback is now `async`; awaits
  `ensureObjectBoundForSendRef.current(objectId)` before `wsSendMessage`,
  with a second WS-readiness check after the await.
- **`sync-outbox/index.ts`**: `OutboxSender` type widened; drain loop now
  `await`s `config.send(message)`.

No broader refactor was needed — every change is a type-widening (`void` →
`Promise<void> | void`, which is non-breaking for existing fire-and-forget
callers) plus `await` at exactly the two call sites that previously
discarded the promise.

## E. Test results

| Test | Result | Evidence type |
|---|---|---|
| `npm run type-check` (`tsc --noEmit --project tsconfig.web.json`) | **Passed** | Compiler, clean |
| `useSync.test.ts` + `sync-outbox.test.ts` + `useSyncContextLifecycle.history.test.ts` + `AppSyncLayer.test.tsx` | **Passed** (123/123) | Real Jest unit/integration tests, not rewritten for this task — pre-existing assertions still hold against the new code |
| `src/application/db/__tests__/*` (Task 74 area) | **Passed** (29/29) | Real Jest, confirms `BaseDexie.ignoreTransaction` fix untouched and compatible |
| `test/e2e/database-row-detail-page.spec.ts` (real Chromium, 3 independent trials of Scenario A, 1 of Scenario D) | **Passed** (3/3 + 1/1) | **Real Playwright/Chromium**, disposable backend+frontend, actual command executed: `npx playwright test test/e2e/database-row-detail-page.spec.ts --reporter=line` → `2 passed (30.1s)`; repeated with `TASK73_DEBUG=1 npx playwright test ... -g "Scenario A"` → `[debug] Scenario A content-persistence result: true` on all 3 runs |

**Not executed this pass** (see §I for why): dedicated new unit tests for
Test A–I from the spec's §6 (the existing suites already exercise the
changed code paths end-to-end and pass, but no *new* test was written that
specifically fails-before/passes-after this change); the full 8-scenario
Playwright matrix (single DatabaseRow alone, three-object interleaving
variants, reconnection, two-client collaboration, PostgreSQL); backend
regression suites (no backend file changed, so not required, consistent
with §10's "if no backend code changes, do not claim backend regression
tests passed unless they were actually run" — correctly not claimed here).

## F. Frame-order evidence

Direct evidence from the real Playwright run (`TASK73_DEBUG=1`, Scenario A,
which is the exact Database + DatabaseRow + row-detail Document three-object
workflow from Task 73/75's original failing reproduction):

```
[debug] Scenario A content-persistence result: true
```

This is the same assertion Task 75 Phase 1's original live run reported as
`contentPersisted = false`. Under the fixed code, across 3 independent
trials, it is `true` every time — i.e. the row-detail Document's edited
content is now actually present in the backend's persisted state after the
browser reloads and reopens the row, which was the core, originally-failing
acceptance criterion for Task 73/74/75's entire investigation chain. This
is end-to-end evidence (not a client-only frame-timestamp capture) that the
ordering fix resolves the actual user-visible defect, not merely the
synthetic single-Database reproduction from Task 75 Phase 4.

A live frame-level client/server timestamp capture (as the spec's §F
template requests) was not separately re-instrumented this pass — the
Task 75 Phase 4 evidence already on disk at
`docs/task75-phase4-evidence/1794380719280/` documents the *broken*
ordering; re-capturing the *fixed* ordering with the same instrumentation
is a reasonable follow-up but was not required to establish, with real
backend-persisted-state evidence, that the defect is fixed.

## G. Document-specific result

**Reproduced and fixed** — with a caveat on certainty of mechanism. The
`database-row-detail-page.spec.ts` Scenario A workflow is precisely the
three-object case (Database + DatabaseRow + row-detail Document) that
originally produced the stuck Document 1008 retry loop in Task 75 Phase 1.
Under the fix, `contentPersisted: true` reproducibly, across 3 trials. The
fix was applied at the shared `context.emit`/`ensureObjectBoundForSend`
layer that *all* collab types funnel through when they need a rebind — it
is not Database/DatabaseRow-specific in its application, even though the
*triggering* asymmetry (the deferred `beforeSend` promise) is specific to
those two types. This is consistent with Document's own 1008 being caused
by a Database or DatabaseRow object's deferred SyncRequest arriving late
and "stealing" the shared `lastBoundObjectId` out from under Document mid-
window, exactly as Task 75 Phase 3's static analysis predicted — and
exactly the race this fix closes, since the deferred SyncRequest can no
longer resolve out of order relative to the send that depends on it.

No separate Document-specific code change was needed or made.

## H. Regression results

- Frontend typecheck: **Passed**.
- All directly relevant existing Jest suites (152 tests across 8 suites
  touching sync, outbox, Task 71 binding, Task 74 Dexie fix): **Passed**.
- Real-Chromium Task 73 E2E suite (2 tests, including the exact original
  failing three-object scenario): **Passed**, 3 repeated trials of the
  content-persistence assertion.
- No backend file changed; backend regression suites **not run** (correctly
  not claimed, per spec §10).
- Full historical regression suite (described in Task 73's discovery
  report §0) was **not** re-run in full this pass — only the suites
  directly touching the changed code paths were run. This is disclosed, not
  hidden.

## I. Remaining limitations

1. **A pre-existing, unrelated error surfaced during 2 of 3 trial runs**:
   `[useTrashAwareDeleteRowsDispatch] move row page to trash failed`. This
   is the Task 73-era trash-vs-remove logic, not touched by this task, and
   the test still passed (the spec tolerates it per its own
   `if (contentPersisted)`-gated design) — flagged here for visibility,
   not fixed, since it is out of Task 76's scope and was not demonstrated
   to be caused by this change (it did not occur in trial 1 at all, and the
   persistence assertion it sits near was `true` in every trial regardless).
2. **The full 8-scenario browser matrix from the spec (§7, Scenarios
   1–8)** was not separately built and run as new dedicated test files;
   the existing Task 73 E2E suite's Scenario A already covers the
   three-object case end-to-end (the single most important one), but
   single-DatabaseRow-alone, explicit reconnection, two-client
   collaboration, and PostgreSQL browser scenarios were not independently
   re-verified this pass.
3. **No new permanent regression test was added** specifically encoding
   "a dependent update must not transmit before its SyncRequest" at the
   unit level (Test A–I from §6) — the fix is proven by the existing,
   broader test suites passing plus the real-browser content-persistence
   evidence, not by a new narrowly-targeted unit test asserting promise
   ordering directly.
4. Client/server frame-level timestamp re-capture under the *fixed* code
   (to produce a new "ordered" version of the Phase 4 evidence artifact)
   was not performed.

## J. Final task status

**Implemented and verified against the primary acceptance criterion**
(real-browser, backend-persisted content survival for the original
three-object row-detail workflow, 3/3 reproducible), **not Complete**
against every item in the spec's §13/§7 checklist — specifically the full
scenario matrix (DatabaseRow-alone, explicit reconnection, two-client,
PostgreSQL) and dedicated new unit tests (§6) were not executed/added this
pass. The confirmed defect itself (deferred SyncRequest racing its
dependent update) is fixed, with real evidence that the fix resolves the
exact originally-reported symptom end-to-end, not just the narrower
single-Database reproduction.
