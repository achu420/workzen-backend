# Task 49A: Document Version History and Restore (JSON storage only)

## Scope

Implements the 5 real document version-history/restore HTTP endpoints discovered in
Task 48, backed by additive JSON storage structures, using the already-existing
Task 45 restore-generation fencing (`restore_id`/`expectedRestoreId` in
`preparePageCollabUpdate`). PostgreSQL parity and real browser verification are
explicitly out of scope and left for later tasks.

## Part A: confirmed frontend contract

Read directly from `AppFlowy-Web/src/application/services/js-services/http/collab-api.ts`
and `useCollabVersionRevert.ts`. Exact contract implemented:

1. **List history** — `GET /api/workspace/{workspaceId}/collab/{objectId}/history?since=<ms|null>`.
   JSON `{code,message,data:[{version,parent,name,created_at,created_by,deleted_at,editors}]}`.
2. **Preview a version** — `GET /api/workspace/{workspaceId}/collab/{objectId}/history/{version}?collab_type=0`.
   Raw binary body (not JSON-wrapped) — the exact stored full Yjs state.
3. **Create named snapshot** — `POST /api/workspace/{workspaceId}/collab/{objectId}/history`
   body `{snapshot: base64, name, collab_type}`. JSON response `data` is the new version id (string).
4. **Tombstone-delete** — `DELETE /api/workspace/{workspaceId}/collab/{objectId}/history`,
   body is a bare JSON-encoded string (`JSON.stringify(version)`, not an object) —
   handled with a dedicated raw-body reader since the server's generic `body()`
   helper requires a JSON object.
5. **Revert** — `POST /api/workspace/{workspaceId}/collab/{objectId}/revert`
   body `{version, collab_type}`. JSON response `data: {state_vector, doc_state, collab_version, version:0}`.

No `v1` prefix on any of these 5 routes (unlike the `/api/workspace/v1/.../collab/{id}` read
and full-sync-batch routes), confirmed by reading the exact URL strings in `collab-api.ts`.

Checked `AppFlowy` upstream source for a restore-generation WebSocket notification/resync
frame: **none found**, confirming Task 48's finding. No frame was invented (see Part D).

No frontend code was changed.

## Part B: storage and endpoints

`storage.js` additions (additive only, JSON storage):
- `emptyState()`: `pageCollabVersions` (per-pageId array of version entries) and
  `pageCollabRestoreEvents` (per-pageId array of restore audit events).
- Version entry: `{version (uuid), parent, name, document_state (full Yjs state,
  array), created_at, created_by (uid|null), deleted_at (tombstone, never physically
  deleted), editors[], kind: 'named'|'before_restore'}`.
- `store.listPageCollabVersions`, `store.getPageCollabVersion`,
  `store.createPageCollabVersion`, `store.tombstonePageCollabVersion`,
  `store.restorePageCollabVersion` (the restore operation).
- Restore event entry: `{digest, restored_version_id, before_restore_snapshot_version_id,
  resulting_restore_id, actor, created_at}` — used for duplicate-request idempotency.

`server.js`: the 5 routes above, plus Yjs-level validation that any submitted
snapshot is a full reconstructable state (replayed into an empty `Y.Doc` with no
pending structs) before it is stored — satisfying "full reconstructable Yjs state,
not an arbitrary individual update."

## Part C: restore safety

`store.restorePageCollabVersion` runs on the **same single-writer queue**
(`pageCollabUpdateQueue`) as ordinary `acceptPageCollabUpdate`, inside `mutate()`
(durable temp-file+rename persist before resolving — same pattern as Tasks 42-44).
It:
- Verifies workspace/page ownership and that the row exists.
- Verifies the target version belongs to the page and is not tombstoned
  (`VERSION_NOT_FOUND` / `VERSION_DELETED`, surfaced as 404/409).
- Creates an implicit before-restore snapshot (`kind: 'before_restore'`) of the
  document's current state before overwriting it.
- Installs the target version's full state as `document_state`, recomputes
  `state_vector` from it via Yjs.
- Advances `restore_id` (new UUID) and `generation`; does **not** touch
  `workspaceRids[workspaceId]` — restore allocates no Rid.
- Preserves document identity (pageId/workspace/collab_version untouched).
- **Idempotency** (no request/idempotency key in the frontend contract): a
  digest of `(pageId, targetVersionId)` is compared against the most recently
  *applied* restore event for that page. If it matches and nothing else has
  mutated the row since (its `resulting_restore_id` still equals the row's
  live `restore_id`), the request is treated as a retry and the previous result
  is returned without creating a second event/snapshot/generation bump. This
  is documented as the deliberate minimal design; a second intentional
  identical restore issued after other activity is still treated as a fresh
  restore.
- **Optimistic concurrency**: because restore and ordinary updates share one
  queue, two concurrent restores (or a restore racing an update) serialize;
  the first durable write wins and the second observes/produces a consistent
  final state (no partial/interleaved application).
- Does not weaken existing dedup or `RESTORE_GENERATION_MISMATCH` fencing in
  `acceptPageCollabUpdate`/`preparePageCollabUpdate` — reused unmodified.

## Part D: WebSocket behavior / limitation

**No notification frame was invented.** Confirmed (Task 48 + re-checked here) there
is no production or upstream-confirmed WebSocket frame for broadcasting "a restore
happened" to other already-connected clients. Safety for already-connected peers
relies entirely on the pre-existing stale-generation fencing: any update they send
carrying the pre-restore `restoreId` is rejected with `RESTORE_GENERATION_MISMATCH`
and the socket is closed (1008), exactly as Task 45 already proved. Recovery path
for such a client is to reconnect and issue a fresh `SyncRequest`, which returns the
post-restore state. **This is a real limitation**: a connected peer is not proactively
told about the restore; it only finds out when its next write is rejected (or when it
reconnects). Multi-client live-restore notification is **not** implemented and is not
claimed to be.

## Part E: tests (`test/backend.test.js`)

Three new tests, all exercising the real HTTP routes end-to-end (not just storage
internals):

1. `version-history: create named snapshot, list it, preview it, tombstone-delete it
   and verify it no longer appears` — covers endpoints 1-4, plus rejecting
   preview/restore of a deleted version (404 / 409 `VERSION_DELETED`).
2. `version-history: restore a previous version preserves identity, advances
   generation, keeps before-restore snapshot, does not consume a workspace Rid, and
   rejects stale-generation updates` — covers restore via HTTP, identity
   preservation, `restore_id`/`generation` advancing, before-restore snapshot
   retention, fresh-client reconstruction, Rid non-consumption, and reuses Task 45's
   exact fencing pattern (`RESTORE_GENERATION_MISMATCH`) for both direct
   `acceptPageCollabUpdate` calls (stale rejected, fresh accepted).
3. `version-history: duplicate restore requests do not create multiple restore
   events; competing restores use optimistic concurrency (first wins); persistence
   failure does not report success; state survives a restart reload` — covers
   idempotent duplicate restores, concurrent competing restores resolving to one
   consistent state, Task 44's `store.persist` fault-injection hook proving a failed
   persist never reports success and never mutates durable state, and a restart
   recovery check via `openStore()` on the same disposable JSON file.

Also updated `test/collab-conformance.js`: moved `restore-transition` from
`pendingVectors` to `resolvedVectors`, with evidence pointing at the new
`backend.test.js` fixtures, while explicitly carrying forward the WebSocket
notification limitation in the resolution text.

### Exact verification results

```
npm test                     -> tests 32, pass 32, fail 0
npm run test:offline-collab  -> tests 5,  pass 5,  fail 0
npm run test:collab-conformance -> passed=6 failed=0 pending=2 resolved=5
  (pending: compaction-retention, cross-instance-replay — unchanged/out of scope)
  (restore-transition moved from pending -> resolved by this task)
```

## What remains (explicitly out of scope here)

- **PostgreSQL parity**: `postgres-storage.js` / `postgres-collab-repository.js`
  were not touched. Version history, restore events, and the restore operation
  itself only exist in the JSON store.
- **Real browser verification**: no manual/Playwright verification against the
  actual AppFlowy-Web UI (`DocumentHistoryModal.tsx`) was performed; only the
  HTTP contract was verified via automated tests.
- **Multi-client live notification**: as documented in Part D, a connected peer
  only learns of a restore via rejected writes or a fresh reconnect/SyncRequest,
  not a push notification.
