# AppFlowy-Web / AppFlowy-Cloud protocol revision match

**Review date:** 2026-10-28  
**Scope:** Read-only source and revision investigation; this report is the only file created  
**Conclusion:** No matching AppFlowy-Cloud revision was found in the locally available refs or public `main`. The checked-out Cloud server is not protocol-compatible with the checked-out Web revision. Do not claim end-to-end compatibility or start integration testing against this mismatched server.

## Revisions examined

| Repository | Revision | Evidence |
|---|---|---|
| AppFlowy-Web | `57bdf395a17a0837baae18435b9653b619dd54ab` | Exact checked-out `HEAD`; local Web worktree also has pre-existing modifications and untracked files, which were left untouched. |
| AppFlowy-Cloud | `c5bcfd33edd46ced4a9b4fdb7ddb3bbf8c0326da` | Exact checked-out `HEAD`, clean worktree, `main`; the unauthenticated public GitHub API reports the same commit for `main`. |
| Cloud collaboration protobuf history | `6548e81e83aec2aa52139661ea006d37a3774254` (latest path commit, 2025-05-27), preceded by `811aa1ac953604163f3a85409f76524cde93e041` | `git log --all` for the Cloud protobuf paths and public commit history for `libs/appflowy-proto/proto/collab.proto`. The newer Web-only fields are absent. |

The Cloud checkout has 5,533 commits reachable from its local refs. Its locally available branches, tags, and other refs were inspected; searches across reachable history found no `before_state_vector`, `after_state_vector`, `database_restore_id`, or `/full-sync/batch` contract. The publicly available Cloud `main` is still `c5bcfd33…`. Its README at that commit says the repository is archived and the currently maintained server codebase is closed-source. That excluded code was not accessed.

## Contract comparison

| Area | Web at `57bdf395…` | Cloud at `c5bcfd33…` | Result |
|---|---|---|---|
| Protobuf messages | `src/proto/collab.proto` defines `Rid`, version-bearing `SyncRequest` / `Update`, `before_state_vector`, `after_state_vector`, restore identity, batch request/response, and per-result server state vector and message ID (lines 12–82, 134–174). `src/proto/notification.proto` defines `DatabaseRestored` with `database_restore_id` and version (lines 18–27). | `libs/appflowy-proto/proto/collab.proto` has the older sync/update messages; it has no version, causal-vector, restore, or batch fields (lines 12–99). `libs/appflowy-proto/proto/notification.proto` only declares profile and permission notifications (lines 5–21). | **Mismatch.** Field numbers and message envelopes cannot satisfy Web's required schema by inference. |
| State vectors and updates | `src/application/services/js-services/sync-protocol.ts` sends and handles sync requests, uses the last message ID, and emits update causal metadata (lines 93–110, 131–190, 233–248, 302–310). | Cloud's protocol has a state vector on `SyncRequest`, and its HTTP single-object request carries `sv` and `doc_state`; its `Update` has no before/after vectors or version (Cloud proto lines 28–62; `libs/collab-rt-entity/proto/collab.proto` lines 6–15). | **Partial older behavior only.** This does not implement Web's causal admission or version contract. |
| `Rid` and replay | Web declares the workspace-stream `Rid` and carries a last-known ID in sync context (Web proto lines 12–45; `sync-protocol.ts` lines 24, 93–110, 233–248). | Cloud uses Redis `XADD` with `*` on a workspace stream key `af:u:{workspace_id}` (`libs/collab-stream/src/model.rs` lines 476–540). Workspace replay reads updates after a cursor and advances its cursor (`services/appflowy-collaborate/src/ws2/actors/workspace.rs` lines 278–317, 415–443). | **Substantial implementation overlap, not a match.** Source confirms Cloud's own Redis ID and replay mechanics, but not Web's entire newer message contract or behavioral interoperability. |
| Restore metadata and transitions | Web carries `database_restore_id` in collab updates, batch state, and restore notifications (Web proto lines 74–82, 134–141; notification proto lines 18–27). Its client restore path fences incoming data and handles the notification (`useCollabMessageHandler.ts` lines 72–85; `useDatabaseHistoryRestoreSync.ts` lines 536–555). | Cloud's checked-in collab and notification protos contain no restore ID or restored notification; history searches found no occurrence in reachable Cloud refs. | **Mismatch; server behavior not resolvable from this source.** |
| HTTP full-sync | `collab-api.ts` posts a protobuf `CollabBatchSyncRequest` to `/api/workspace/v1/{workspace}/collab/full-sync/batch`, decodes `CollabBatchSyncResponse`, and consumes per-object missing updates, server vectors, versions, and message IDs (lines 285–428). | Cloud registers the `/v1/{workspace}/collab/{object}/full-sync` route (`src/api/workspace.rs` lines 181–182); its client constructs the full `/api/workspace/v1/{workspace}/collab/{object}/full-sync` path (`libs/client-api/src/http_collab.rs` lines 507–554). The handler decodes one `CollabDocStateParams` and returns a compressed byte body (`workspace.rs` lines 2842–2942). That parameter has only object ID, collab type, compression, state vector, and doc state (`libs/collab-rt-entity/proto/collab.proto` lines 10–15; `libs/collab-rt-entity/src/collab_proto.rs` lines 4–14). | **Definitive mismatch** in route, request schema, and response schema. |
| Integration tests | Web tests exercise client behavior and offline state handling; they are not server interoperability tests. | Cloud has realtime missing-update tests (`tests/collab/missing_update_test.rs` lines 11–45) and single-object HTTP full-sync tests (`tests/collab/single_device_edit.rs` lines 591–690, 698–752). | **Insufficient for this Web revision.** They do not run the newer Web batch request against a matching server, nor prove all seven server behaviors below. |

## Seven protocol gaps and test boundary

The old Cloud source provides useful implementation evidence for some mechanisms, but the revision mismatch prevents using those observations as a compatibility pass for Web:

1. **`Rid` allocation/resume:** Cloud source shows Redis-generated IDs and cursor replay. Concurrent allocation, cursor completeness, and reconnect behavior for the exact Web client still need matching-revision integration tests.
2. **Duplicate admission:** no matching-revision evidence establishes replay deduplication, effects, or response semantics. A server test must deliver the same update twice and inspect durable result and acknowledgement.
3. **Realtime acknowledgement:** the Cloud source does not establish Web's required acknowledgement/crash boundary. A matching server test must cover persistence, response/fan-out, and a crash window.
4. **Compaction/history recovery:** snapshot and stream machinery exists in Cloud, but no matching test establishes recovery when retained history no longer covers the Web cursor.
5. **Restore transitions:** the required fields and notification are absent from this Cloud source. A matching server revision and restore tests are needed for generation changes, stale writes, and event ordering.
6. **Cross-instance replay:** workspace Redis stream code exists, but the cited tests do not establish multi-process replay, restart, or failover for the Web protocol.
7. **WebSocket/HTTP convergence:** the HTTP endpoint schema is incompatible, and existing tests do not compare equivalent updates across WebSocket and Web batch HTTP paths.

## Finding and next step

**Was a matching Cloud revision found? No.** No matching revision appears in the local Cloud refs or public `AppFlowy-IO/AppFlowy-Cloud` `main`; the exact public main hash matches the local checkout. Public repository metadata and history confirm the old protobuf history, while its README describes the repository as archived. This is not evidence that no newer implementation exists elsewhere; it is evidence that the permitted public Cloud source reviewed here does not provide it. No commercial source, deployment, credentials, database, or running service was accessed.

**Next step: further source investigation, not integration testing.** Identify an approved, publicly available server source revision that explicitly contains Web's current protobuf and batch full-sync contract. If none is available under the allowed source boundary, record that limitation and do not infer compatibility from Cloud's older implementation. Only after a matching source revision is established should isolated integration tests be designed for the seven cases.

Public metadata checked:

- Cloud `main` commit: <https://api.github.com/repos/AppFlowy-IO/AppFlowy-Cloud/commits/main>
- Cloud collaboration-proto history: <https://api.github.com/repos/AppFlowy-IO/AppFlowy-Cloud/commits?path=libs/appflowy-proto/proto/collab.proto&per_page=100>
- Cloud README at reviewed revision: <https://raw.githubusercontent.com/AppFlowy-IO/AppFlowy-Cloud/c5bcfd33edd46ced4a9b4fdb7ddb3bbf8c0326da/README.md>
