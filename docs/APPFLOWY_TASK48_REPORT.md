# Task 48 — Version History / Restore: Discovery and Design (no implementation)

Scope per instructions: discovery and design only. No production code changed. `collab_updates` untouched. RID allocation untouched. No restore implemented.

## Part A — Upstream/frontend discovery

### A1–A2: Does version history exist, is it first-class in the frontend?

**Yes — found concrete, non-trivial frontend implementation in the checked-out `AppFlowy-Web`, not a stub.** Evidence:

- `src/application/collab-version.type.ts` defines `CollabVersionInfo { viewId, currentVersionId, history: CollabVersionRecord[] }` and `CollabVersionRecord { viewId?, versionId, parentId, name, createdAt, deletedAt, editors[] }`.
- `src/application/services/js-services/history.ts` (`collabVersions(workspaceId, viewId)`) calls `getCollabVersions` over HTTP.
- `src/application/services/js-services/http/collab-api.ts` (lines ~579–700) implements four HTTP calls:
  - `GET /api/workspace/{workspaceId}/collab/{objectId}/history?since=<epoch-ms>` → list of `{version, parent, name, created_at, created_by, deleted_at|is_deleted, editors[]}`.
  - `GET /api/workspace/{workspaceId}/collab/{objectId}/history/{version}?collab_type=` → raw bytes (a point-in-time preview, returned as an `arraybuffer`, not applied to the live doc).
  - `POST /api/workspace/{workspaceId}/collab/{objectId}/history` with `{snapshot (base64), name, collab_type}` → explicit client-triggered snapshot creation.
  - `DELETE /api/workspace/{workspaceId}/collab/{objectId}/history` with a version id body → explicit snapshot deletion.
  - `POST /api/workspace/{workspaceId}/collab/{objectId}/revert` with `{version, collab_type}` → `{state_vector, doc_state, collab_version, version(encoder)}`.
- UI entry points: `src/components/document/history/DocumentHistoryModal.tsx` + `DocumentHistoryVersionList.tsx` (document version history dialog with date filters, "only mine", preview pane rendering the historical Yjs doc read-only via the real `Editor`, and a Restore button), and a parallel `database/history/DatabaseHistoryModal.tsx` for databases. A shared `_shared/version-history` component provides the dialog/list chrome.
- WebSocket-side coordination: `src/components/ws/sync/useCollabVersionRevert.ts` implements `revertCollabVersion(viewId, version)`: it pauses the active sync context, discards pending local edits, calls the HTTP revert endpoint, deletes/rebuilds the local IndexedDB-cached Yjs doc from the returned `docState`, and replays any WebSocket messages that arrived mid-revert (`replayQueuedMessages`) once the local doc is consistent again. `databaseRestoreState.ts`, `useDatabaseHistoryRestoreSync.ts`, and `useCollabMessageHandler.ts`'s `allowVersionReset` flag show the server is expected to emit something (a version-changed/reset signal) that active clients must recognize so they resync instead of treating post-restore server state as a conflicting edit.

Conclusion: version history/restore is a first-class, fully wired frontend feature in `AppFlowy-Web` (not found in the Flutter/Rust `AppFlowy` desktop client, which only exposes local offline-editing-history "snapshots" for its own crash recovery — see A6 below). This backend currently implements **none of these five endpoints**.

### A3: Does restore create a new version or overwrite current state?

Both, per the frontend contract: the `revert` endpoint doesn't delete history — it returns a `doc_state`/`state_vector` pair representing the Yjs state *as of* the selected historical version, which becomes the new live state, and `collab_version` (a *new* current-version id) is returned alongside it. The old "current" state before the revert is not described as deleted by this contract — `history` entries carry `deletedAt`/`is_deleted` (tombstone), implying history is independently retained and only tombstoned, never silently discarded by a revert. This is consistent with "restore creates a new live generation; nothing is destructively overwritten in storage."

### A4: Does restore preserve document ID?

Yes. Every endpoint operates on a fixed `objectId`/`viewId`; the response never carries a new object id, only a new `collab_version`/version token for that same object. Document identity (and by extension this backend's RID allocation and page id) is explicitly unaffected — confirming Task 48's constraint not to touch RID allocation is consistent with the real contract, not just a safety rule.

### A5: How does restore interact with active WebSocket clients?

Inferred from `useCollabVersionRevert.ts` + `useCollabMessageHandler.ts`'s `allowVersionReset`: the client that *initiates* restore pauses its own sync context, discards unconfirmed local edits, fetches the new state via HTTP (not WebSocket), destroys/rebuilds its local Yjs doc, then replays any WebSocket messages queued during the reset. This implies the server must (a) reject/fence any stale in-flight update that still carries the pre-restore generation token, and (b) notify *other* connected clients (not just the initiator) that the document changed server-side, so they resync rather than apply stale deltas on top of now-replaced state. The exact wire message for "other clients, please resync" was not found in this repo slice (no explicit `versionChanged`/broadcast handler reviewed beyond the local `'reset'` event the initiator emits on its own doc) — this is an open question, see Part E blockers.

### A6: Desktop client (`AppFlowy` Flutter/Rust) findings

`frontend/rust-lib/flowy-document/src/manager.rs` and `flowy-document-pub/src/cloud.rs` define `DocumentSnapshotService`/`get_document_snapshots`/`DocumentSnapshotPB` — but this is the **local offline-edit-history** mechanism (`subscribe_document_snapshot_state`, periodic local snapshotting for recovery/undo, keyed by integer `snapshot_id: i64`), not a server-backed, user-facing version-history/restore feature. It does not define a restore-to-version operation, a parent-chain, editor attribution, or tombstoning — it's a different, narrower mechanism. The real "restore historical version" feature traced in Part A1 lives only in `AppFlowy-Web`, confirming the web client (our actual integration target) is the right place to have looked.

### Verification of raw-update-log assumption (explicitly required by the task)

`collab_updates` (JSON: `pageCollabUpdates`, Postgres: `collab_updates` table, schema in `migrations/001_initial.sql:90-105`) stores one row per **admitted Yjs delta**, keyed by `payload_digest`/`message_key`, with no `name`, no `parent`, no `deleted_at`, and no concept of "this row is a selectable restore point." It is purely a dedup/replay log, not point-in-time-labeled version history. This refutes treating individual rows as "versions": the frontend's `history` concept (`CollabVersionRecord`: named, parented, tombstonable, with editor attribution) has no structural analog in `collab_updates` today. A real implementation needs a **separate** version-metadata table/store (see Part C), not a reinterpretation of `collab_updates`.

## Part B — Backend restore contract (proposed, not implemented)

Proposed operation: `POST /api/workspace/{workspaceId}/collab/{objectId}/revert` (matches the frontend's existing call exactly — zero frontend changes needed).

Behavior:
1. Caller supplies `{version, collab_type}`. `version` must reference an existing, non-tombstoned row in a new `collab_versions` metadata table for this `objectId`.
2. Server loads the *frozen snapshot bytes* for that version (see Part C — not reconstructed by replaying `collab_updates`, since that log has no version boundaries).
3. Server allocates a **new restore generation** by writing a fresh, non-null `restore_id` (e.g. a ULID) onto the document's durable row — reusing Task 45's existing `restore_id`/`expectedRestoreId` fencing field verbatim; no new fencing mechanism needed.
4. Server persists the restored `document_state`/`state_vector` and the new `restore_id` **atomically together** with the normal `mutate()` (JSON) / transaction (Postgres) path, before returning any success response — same durability discipline Task 42/44 already proved for ordinary updates.
5. Server records a `restore_events` audit row (who, when, from-version, resulting `restore_id`/`collab_version`).
6. Server responds with `{state_vector, doc_state, collab_version, version}` exactly as the frontend expects, where `collab_version`/`restore_id` is the new generation token.
7. Any WebSocket update still carrying the pre-restore `restoreId` is rejected via the existing `RESTORE_GENERATION_MISMATCH` path (Task 45), closing with 1008 as today.
8. The server must push a resync signal to *other* currently-connected clients on that object (new WebSocket server→client message, e.g. `documentReset`/`versionChanged` carrying the new `restore_id`) so they discard in-flight state and re-fetch, mirroring what the client-side `allowVersionReset`/`'reset'` event already expects to exist.

JSON/PostgreSQL parity: both stores need the same new `collab_versions` table/structure (Part C) and the same restore endpoint logic reusing each backend's own `mutate`/transaction primitive — Postgres's advantage is it can additionally store version-bytes more cheaply by reusing already-retained `collab_updates` payload bytes *if* an explicit snapshot boundary is recorded (see C's "snapshot-on-write" option), but `collab_updates` must not be assumed restorable on its own in either backend.

## Part C — Persistence/recovery data model (design only)

New entity, `collab_versions` (name chosen to match the frontend's `CollabVersionRecord`):

| Field | Type | Notes |
|---|---|---|
| `version_id` | text/ULID, PK | matches frontend's `versionId` |
| `workspace_id`, `object_id` | uuid | document identity, FK to pages |
| `parent_id` | text, nullable | previous version in the chain, matches frontend's `parentId` |
| `name` | text, nullable | user-supplied label (from `createCollabVersion`) or null for implicit/scheduled snapshots |
| `created_at` | timestamptz | |
| `created_by` | user id | actor |
| `deleted_at` | timestamptz, nullable | tombstone, matches frontend `deletedAt` |
| `editors` | int[] | contributing editor ids since parent, matches frontend `editors[]` |
| `doc_state`, `state_vector` | bytea/blob | the frozen Yjs snapshot bytes — **not** derived from `collab_updates` at read time |
| `collab_type` | enum | Document vs Database etc. |

New entity, `restore_events` (audit):

| Field | Notes |
|---|---|
| `restore_id` | the new generation token written into `pageCollabDocuments.restore_id` / Postgres equivalent |
| `object_id`, `workspace_id` | |
| `source_version_id` | FK into `collab_versions` |
| `actor`, `created_at` | |
| `previous_document_state_backup_ref` | pointer/blob of the pre-restore live state, so "restore" never silently discards the prior current state (Part D requirement) |

Snapshot creation triggers (options, not implemented/scheduled):
- **Explicit** (already in the frontend contract: `createCollabVersion`/`POST .../history`) — lowest-risk, ship first.
- **Before-restore** — always snapshot current live state into `collab_versions` immediately before applying a restore, satisfying "never silently lose pre-restore current state" without a separate backup table.
- **Scheduled/periodic** — out of scope per task constraints; flagged as a future option only.
- **Lifecycle** (e.g. on page archive/delete) — future option, not designed further here.

Retention policy: undetermined — needs a product decision (unlimited vs. capped count vs. TTL per plan tier, mirrors the frontend's `isPro` gating already visible in `DocumentHistoryModal.tsx`). Flagged as a blocker in Part E.

## Part D — Safety and concurrency

- **Restore during an in-flight WebSocket update**: the update and the restore both go through the same single-writer `mutate()` (JSON) / transaction (Postgres) serialization already used for ordinary updates (Task 46's proof that this point serializes all admission). Whichever commits first establishes the new `restore_id`/state; the other, if it carries the old `restoreId`, is rejected via existing `RESTORE_GENERATION_MISMATCH` fencing — no new concurrency primitive required, only reuse.
- **Two concurrent restore requests**: both attempt to write a new `restore_id` inside the same serialization point; second writer sees the generation already changed by the first and should fail with a conflict (`RESTORE_ALREADY_IN_PROGRESS`/`STALE_RESTORE_TARGET`) rather than silently double-applying — exact semantics (last-wins vs. reject) is a Part E open question.
- **Old client reconnecting after restore**: it will resync via the normal `SyncRequest`/manifest exchange and receive current (post-restore) `document_state` plus the new `restore_id`; any update it still has queued under the old `restoreId` is rejected the same way Task 45 already tested.
- **Duplicate restore requests** (same version, retried): should be idempotent similarly to ordinary update dedup (Task 41) — keyed on a client-supplied idempotency key or on "already at this `restore_id`" detection, returning the same response rather than creating two `restore_events` rows.
- **Failure between snapshot selection and state persistence**: must follow the same pattern Task 44 proved for ordinary updates — no success response before the atomic write (`mutate()` rename / Postgres commit) completes; a failure here must leave the document's prior `restore_id`/state completely unchanged (already guaranteed by `mutate()`'s rollback-via-`structuredClone` pattern in JSON mode, and by a normal transaction in Postgres).
- **Backend restart during restore**: because nothing is reported to the caller until the atomic write completes, a restart before that point simply means the restore never happened (caller sees a connection error / can safely retry); a restart after the atomic rename is a durable complete restore, verifiable by a fresh process reading the file/DB, consistent with Task 42/47's restart-persistence findings.
- **JSON atomic persistence**: reuse Task 42's exact `mutate()`/temp-file-write-then-rename pattern for the combined `(document_state, state_vector, restore_id, collab_versions row, restore_events row)` write — all as one atomic state mutation, not a multi-step partial write.
- **PostgreSQL transaction boundaries**: the restore must write the document row's new `restore_id`/state, the `collab_versions` tombstone/insert (if before-restore snapshotting), and the `restore_events` row inside **one transaction**, matching the same all-or-nothing guarantee.
- **Interaction with dedup/RID (Task 46)**: restore should **not** consume a new `Rid`/`messageId` from the per-workspace update allocator — it's a distinct administrative operation, not an ordinary collaborative edit. The post-restore state should simply reset the document's position such that the *next* ordinary update still draws its `Rid` from the existing per-workspace sequence, unaffected by the restore. Existing duplicate-update detection (keyed on payload digest/message key, separate from `restore_id`) is unaffected since restore doesn't go through `acceptPageCollabUpdate`'s dedup path at all.
- **"Never report success before durable state transition is complete"**: satisfied structurally by placing the new restore operation inside the existing `mutate`-for-JSON / transaction-for-Postgres boundary, returning the HTTP response only after that call resolves — identical discipline to what Task 44 fault-injection already proved for ordinary updates, just applied to a new operation rather than a new mechanism.

## Part E — Implementation decision

**1. Recommended API contract** (reuses the frontend's existing calls verbatim — no frontend change needed):

```
GET /api/workspace/{workspaceId}/collab/{objectId}/history?since=<epoch_ms>
  -> 200 [{version, parent, name, created_at, created_by, deleted_at|null, editors:[uid,...]}]

GET /api/workspace/{workspaceId}/collab/{objectId}/history/{version}?collab_type=0
  -> 200 arraybuffer (raw encoded Yjs snapshot bytes for preview, read-only)

POST /api/workspace/{workspaceId}/collab/{objectId}/history
  body: {snapshot: base64, name: string, collab_type: 0}
  -> 200 "<new version id>"

DELETE /api/workspace/{workspaceId}/collab/{objectId}/history
  body: "<version id>"  (tombstone, not hard delete)
  -> 200

POST /api/workspace/{workspaceId}/collab/{objectId}/revert
  body: {version: "<version id>", collab_type: 0}
  -> 200 {state_vector: number[], doc_state: number[], collab_version: string|null, version: 0}
```

**2. Required storage changes**: new `collab_versions` + `restore_events` tables/structures in both `postgres-collab-repository.js`/migrations and `storage.js`'s JSON shape (currently JSON mode has no raw-bytes retention at all per Task 47 — this is a new capability for JSON mode, not just Postgres). `pageCollabDocuments`/equivalent Postgres row gains a real write-path for `restore_id` (today only null-at-creation per Task 45).

**3. WebSocket protocol changes**: new server→client broadcast (e.g. `documentReset`) carrying the new `restore_id`/version so *other* connected clients resync, matching what `useCollabVersionRevert.ts`'s `allowVersionReset`/`'reset'` machinery implies the server should emit. This is the one piece with no confirmed wire-format evidence in this repo slice — a blocker.

**4. Frontend integration**: none required if the contract above is matched exactly — `AppFlowy-Web`'s `collab-api.ts`/`useCollabVersionRevert.ts`/`DocumentHistoryModal.tsx` already call these exact routes and shapes.

**5. Migration/backward-compat**: `restore_id` column/field already exists (Task 45) and defaults to null — no schema break for existing documents. New tables are purely additive. Existing documents simply have empty history until either an explicit snapshot is taken or "before-restore" snapshotting (Part C) first fires.

**6. Test plan for the future implementation task**:
   - Success: create version → revert → GET history still lists it (not deleted) → new `collab_version` returned → fresh client fetch reflects reverted state.
   - Stale clients: WebSocket update carrying pre-restore `restoreId` rejected (1008/`RESTORE_GENERATION_MISMATCH`, already partially covered by Task 45's fixture); other connected clients receive a resync signal and do not silently diverge.
   - Concurrency: two simultaneous revert calls on the same object — exactly one succeeds in a well-defined way, the other gets a clear conflict, no corrupted/mixed state.
   - Duplicate requests: identical revert request retried — idempotent, not double-counted in `restore_events`.
   - Persistence failure: inject a failure between snapshot read and the atomic write (reusing Task 44's `store.persist` gate-hook pattern) — caller gets an error, document `restore_id`/state is provably unchanged.
   - Restart recovery: restart the backend process mid-restore-attempt and after a completed restore (reusing Task 42/47's restart pattern) — unattempted/interrupted restores leave no partial trace; completed ones are durable across restart.

**7. Implementation blockers (must resolve before coding)**:
   - No confirmed wire format for the "other clients must resync" WebSocket broadcast — only inferred from frontend handler names (`allowVersionReset`), not from an explicit message type definition found in this repo slice.
   - Retention policy (count/TTL/plan-tier gating — the frontend already shows an `isPro` gate in `DocumentHistoryModal.tsx`) is a product decision, not yet made.
   - Concurrent-restore conflict semantics (reject vs. last-wins) undecided.
   - Snapshot-creation trigger policy for Part C (explicit-only vs. before-restore-also) needs a decision; recommend **both**, explicit for named user-saved versions and before-restore implicit for safety, but this is a recommendation, not a confirmed requirement.
   - PostgreSQL's `collab_updates` raw payload retention (Task 47 finding) is *not* to be treated as a cheap substitute for `collab_versions` bytes — using it that way would conflate an unlabeled dedup log with labeled, user-facing version history; this must be explicitly decided against before anyone is tempted to "just use the existing table."
   - No live PostgreSQL instance has been exercised against this design (consistent with Tasks 42-47) — needs verification against a real isolated Postgres before implementation is considered complete.
