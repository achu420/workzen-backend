# Task 42 — Resume Assessment: Ground Truth on Startup Failure and Persistence

**Date:** 2026-11-05
**Nature of this task:** read-only investigation and verification only. No application code was changed.

## 0. Framing correction

This task was briefed assuming (a) a Task 41 report describing a failure to start the backend on port 8787, and (b) a separate, later investigation claiming WebSocket-driven Yjs updates were only applied in memory and never durably persisted, contradicting Task 39/40. After reading every existing report in `docs/` (`APPFLOWY_TASK39_BROWSER_VERIFICATION_REPORT.md`, `APPFLOWY_TASK40_REPORT.md`, `APPFLOWY_TASK41_REPORT.md`, and `docs/AGENT_HANDOVER.md`) and searching the whole `/Volumes/work disk/Codes/Tracker` tree for `8787`, "in memory", "never persisted", and similar phrases, **no such Task 41 startup-failure report and no such contradicting in-memory-only investigation exist in this repository.** The actual Task 41 report describes a clean run (changed only `test/backend.test.js` and `test/collab-conformance.js`, no startup problem mentioned) that *resolved* the duplicate-admission conformance case with a new durable integration test, consistent with Task 39/40. This report documents what was actually found; it does not assume the premised prior failure happened in this codebase.

## 1. Current working-tree state

The backend project at `/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend` is **not a git repository** — there is no `.git` directory, and `git status`/`git log` both fail with "not a git repository (or any parent up to mount point /Volumes)". The frontend checkout (`AppFlowy-Web`) and the other sibling projects (`AppFlowy`, `AppFlowy-SelfHost-Commercial`, `AppFlowy-Cloud`) do have `.git` directories, but the backend — the subject of this task — does not, so there is no commit history, branch, or diff to report for it. "Uncommitted/untracked files" is not a meaningful category here; the whole tree is simply unversioned files on disk. `docs/AGENT_HANDOVER.md` itself notes the Web checkout retains its own pre-existing modified `vite.config.ts`, unrelated to this task.

## 2. Reason for the Task 41 "startup failure" — not reproducible, and not evidenced

Starting the backend cleanly succeeded on the first attempt in this session:

```
cd "/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend"
HOST=127.0.0.1 PORT=8787 STORAGE=json DATA_FILE=/tmp/appflowy-task42.json DEV_TEST_KEY=task42-dev-key node server.js
```

Output: `Independent backend listening on http://127.0.0.1:8787`. `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/api/server-info` returned `200`. `lsof -i :8787` before starting showed the port free; node is v26.11.0 (>= the `engines.node: ">=20"` requirement in `package.json`); `node_modules` was already installed (`pg`, `protobufjs`, `ws`, `yjs`, `@playwright/test` all present).

`POST /api/auth/register` is present and reachable: `server.js:851` registers `if (method === 'POST' && url.pathname === '/api/auth/register')`, and a live call against the freshly started instance returned `201`-shape JSON with a created user (`{"user":{"id":"...","email":"task42@example.test",...}}`).

Conclusion: there is no evidence in this codebase of a port-8787 startup failure or a missing `/api/auth/register` route. `STORAGE=json` mode needs no external services (no Postgres/Redis required); `.env.example` documents `DATABASE_URL` as required only for `STORAGE=postgres`. If a prior session genuinely failed to start on 8787, the most likely causes — based on what actually matters in this server — are an already-bound port 8787 from a stray earlier process (Task 39's report independently documents finding two stray `node server.js` processes from unrelated earlier sessions, on ports 3000 and 45250, one of which an earlier agent lacked permission to stop) or a missing/wrong working directory or env file, not an application-code defect. No such failure was reproduced in this session.

## 3. Actual Yjs/WebSocket implementation status

Traced directly in `server.js`:

- **Document WebSocket `SyncRequest`** (`collabType === 0`, i.e. a page/Document object): handled starting around `server.js:1020-1070`. Validates the client's state vector, loads/applies the persisted document state into a throwaway `Y.Doc`, and sends back a manifest frame (`sendDocumentManifest`).
- **Document WebSocket `update`** (an incremental Yjs update push): handled at `server.js:1073-1131`. Requires a prior `SyncRequest` on the same `websocket.objectId` (line 1075-1078), rejects a client-assigned `messageId` (1079-1082), then **awaits** `store.acceptPageCollabUpdate(...)` (line 1084) before building the acknowledgement frame and sending it (lines 1093-1110). Known admission-error codes (`UNSUPPORTED_FLAGS`, `EMPTY_UPDATE`, `VERSION_MISMATCH`, `RESTORE_GENERATION_MISMATCH`, `INVALID_BEFORE_STATE_VECTOR`, `MISSING_CAUSAL_STATE`, `MALFORMED_YJS_UPDATE`, `UNRESOLVED_DEPENDENCY`) close the socket with 1008; anything else closes with 1011 ("Document update could not be persisted").
- **Awareness updates**: handled at `server.js:1134-1143`, broadcast to other peers on the same workspace/object, not persisted (correctly — awareness is ephemeral by the Yjs protocol).
- **WorkspaceDatabase (`collabType === 2`) `SyncRequest`**: handled at `server.js:1156` onward; same shape, scoped to `activeWorkspace.database_storage_id`.
- **HTTP full-sync/batch** (`POST /api/workspace/v1/{workspaceId}/collab/full-sync/batch`): handled around `server.js:491-581`; calls the **same** `store.acceptPageCollabUpdate` function (line 581) as the WebSocket `update` handler (line 1084) — confirmed by direct grep, both call sites pass through to one shared admission function in `storage.js`.

This matches Task 41's own "new finding" that both lanes share one admission function — re-confirmed independently in this task by reading the same two call sites.

## 4. The persistence discrepancy: reconciled — Task 39/40/41 were correct

Traced `store.acceptPageCollabUpdate` in `storage.js:162-245` (JSON mode):

- It is wrapped in a serialized queue (`store.pageCollabUpdateQueue`, lines 242-244) so concurrent updates to the same store don't race.
- The actual mutation runs inside `mutate(store, (s) => {...})` (line 166, body through line 236).
- `mutate` (defined at `storage.js:269-274`) is:
  ```js
  export async function mutate(store, fn) {
    const result = await fn(store.state);
    if (store.persist) await store.persist(store.state);
    else await persist(store.file, store.state);
    return result;
  }
  ```
  It **awaits a disk write before returning**, every single call, with no separate "flush" step and no batching/debouncing.
- `persist` (lines 263-267) writes to a temp file and does an atomic `rename` onto the real data file — a crash-safe, all-or-nothing write pattern, not a partial in-place write.
- Back in `server.js`'s WebSocket `update` handler, `await store.acceptPageCollabUpdate(...)` (line 1084) is on the **critical path before** the acknowledgement frame is ever constructed or sent (lines 1093-1110). There is no code path that sends an "update accepted" ack before the JSON file rename has completed.

**Conclusion: the briefing's premise that WebSocket updates were "only applied in memory and never durably persisted" does not match this code.** Every WebSocket `update` admitted through `server.js`'s Document handler is synchronously, durably written to the JSON data file (atomic rename) before the server acknowledges it to the client, via the exact same `acceptPageCollabUpdate` → `mutate` → `persist` chain used by the HTTP full-sync/batch lane. There is one shared admission+persistence path, not two diverging ones. If an investigation elsewhere concluded otherwise, it was either looking at a different code path (e.g. `collab-repository.js`'s explicitly-documented in-memory, non-durable `OfflinePageCollabRepository` prototype used only by `test/offline-collab.test.js`, which *is* process-local and non-durable by design and is clearly labeled as such), or it is simply incorrect about this repository's `server.js`/`storage.js` implementation. Task 39/40's claim that a text marker survived backend restart is consistent with, and explained by, this code: the marker was on disk (via this exact synchronous-write path) before the backend process was ever stopped.

PostgreSQL mode (`postgres-collab-repository.js`) was read structurally and uses the equivalent pattern (a transactional `UPDATE`/`INSERT` with the duplicate-digest check, committed before the function returns) but — consistent with every prior task — was **not exercised against a live database** in this session; no PostgreSQL cluster was started.

## 5. Exact test results (this session)

```
$ npm test
...
ℹ tests 17
ℹ pass 17
ℹ fail 0
ℹ skipped 0
```
(All 17 tests passed, identical count/names to Task 41's baseline, including "AppFlowy-Web Document WebSocket reconnect replays the manifest and resent updates are admitted exactly once" and "AppFlowy-Web initializes and durably admits an authenticated Document WebSocket update".)

```
$ npm run test:offline-collab
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

```
$ npm run test:collab-conformance
COLLAB_CONFORMANCE_SUMMARY
passed=6
failed=0
pending=6
skipped=0
resolved=1
```
(6 pass, 0 fail, 6 pending, 1 resolved — "duplicate-admission" — identical to Task 41's recorded post-task state.)

```
$ HOST=127.0.0.1 PORT=8787 STORAGE=json DATA_FILE=/tmp/appflowy-task42.json DEV_TEST_KEY=task42-dev-key node server.js
Independent backend listening on http://127.0.0.1:8787

$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/api/server-info
200

$ curl -s -X POST http://127.0.0.1:8787/api/auth/register -H "Content-Type: application/json" -d '{"email":"task42@example.test","password":"Password123!"}'
{"user":{"id":"f273cec8-5830-49ef-aef5-bd7ddf84f3cd","email":"task42@example.test","created_at":"2026-11-05T04:22:39.303Z"}}
```

`test-collab-chunk1.js`/`chunk2`/`chunk3` at the repo root use CommonJS `require()` syntax against an ESM (`"type": "module"`) `package.json`; they are not runnable as-is with plain `node test-collab-chunk1.js` (would throw on `require`) and were not part of any `npm run` script. They were read but not executed standalone in this session — treat them as ad hoc manual-test scratch scripts from an earlier session, not part of the maintained suite (`test/backend.test.js`, `test/offline-collab.test.js`, `test/collab-conformance.js`).

## 6. Confirmed limitations

- No real browser was used in this session (only `Bash`/`curl`/`node` — consistent with every non-Task-39/40 session in this project's history). The one-client browser-reload-and-restart verification remains Task 39/40's claim, not independently re-verified by live browser in this task.
- No actual kill-and-restart-of-the-backend-process test was performed against a live WebSocket-driven edit in this session (time/tooling constraints); this task's persistence conclusion rests on direct code-path tracing (§4) plus the already-passing automated reconnect/duplicate-admission test from Task 41, not a newly executed end-to-end process-restart test.
- No multi-client/multi-instance test was performed.
- No PostgreSQL-mode runtime test was performed (no isolated cluster configured), consistent with every prior task.
- The backend has no `.git` history to audit (see §1); this report cannot speak to "uncommitted work" in version-control terms, only to the state of files on disk.
- The specific prior "Task 41 port 8787 failure" and "in-memory-only" investigation referenced in this task's briefing could not be located anywhere in `/Volumes/work disk/Codes/Tracker` and could not be examined directly; this report is based on independently re-deriving ground truth from the current code and docs, not on refuting a document that was found.

## 7. Highest-priority next implementation task

Per Task 41's own recommendation (§7 of `APPFLOWY_TASK41_REPORT.md`), and independently re-confirmed by this task's code reading (§3 above — both lanes already call the same `acceptPageCollabUpdate`): **write the `websocket-http-convergence` fixture** in `test/backend.test.js` — send update A through the Document WebSocket, then a logically independent update B through `POST .../collab/full-sync/batch` against the same page, and assert both lanes' resulting `documentState`/`stateVector`/message sequencing are mutually consistent. This requires no new production code (unless the fixture surfaces a real bug) and directly resolves or re-scopes one of the six remaining pending conformance cases, continuing the project's "verify what's already built" pattern rather than adding new unrelated endpoints.
