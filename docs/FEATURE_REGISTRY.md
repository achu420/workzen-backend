# Feature registry — consolidated gap matrix (Task 58)

Status labels used consistently throughout: **Not assessed** / **Discovered** / **Specified** / **Blocked** / **In development** / **Backend tested** / **Frontend integrated** / **Browser verified** / **Complete**. A feature can carry multiple evidence levels at once (e.g. "Backend tested" + "Browser verified" are both true for document sync) — each row's JSON/Postgres/Browser/Tests columns disambiguate which.

Evidence classes used in the "Automated tests" column: *previously verified* (reported by an earlier task, re-confirmed on disk this task), *newly executed this task* (re-run in Task 58), *static code inspection* (read the code, did not execute), *not assessed*.

## 1. Workspace / document foundation

| Feature | Upstream reference | Backend status | Frontend status | JSON | Postgres | Browser | Tests (evidence) | Gap | Dependency | Risk | Priority | Milestone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Password auth, session/refresh tokens | `AppFlowy-Cloud` GoTrue integration; here: custom `auth.js` | Complete | Complete | Tested | Not tested (Postgres mode exists structurally, not separately runtime-tested for auth this task) | Verified (Tasks 26-28, 32, 39) | previously verified (`npm test`) | Postgres-mode auth runtime not freshly re-verified | none | Low | P3 | Hardening backlog |
| Workspace/space CRUD | `flowy-folder`, AppFlowy-Cloud workspace API | Complete | Complete | Tested | Tested (Task 50 fixed fixture bug; structural parity) | Verified (34, 56) | previously verified | none | — | Low | — | — |
| Page CRUD / rename / move (no nested-folder move UI confirmed) | `flowy-folder` view tree | Complete for CRUD+rename; move/duplicate unconfirmed this task | Complete | Tested | Tested | Verified (35, 39, 40) | previously verified | Move-between-spaces/duplicate not explicitly re-verified this task | — | Low | P3 | — |
| Favorites | `/{workspace}/favorite` (Cloud) | Complete | Complete | Tested | Tested (migration 006) | Verified (53, 56) | previously verified | none | — | Low | — | — |
| Trash / restore-from-trash | AppFlowy folder trash | Complete | Complete | Tested | Tested | Verified (53) | previously verified | Trash retention/auto-purge policy undefined | — | Low | P3 | Hardening backlog |
| Document collaboration (single client/instance) | collab-document Yjs sync | Complete | Complete | Tested | Tested | Verified (36, 37, 39-47, 56) | previously verified + newly executed (38/38 this task) | Multi-instance — see §4 | — | Low (single-instance) | — | — |

## 2. Database functionality (MAJOR gap — backend essentially unbuilt)

| Feature | Upstream reference | Backend status | Frontend status | JSON | Postgres | Browser | Tests | Gap | Dependency | Risk | Priority | Milestone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Database-catalog listing | `AppFlowy-Cloud` `/{workspace}/database` | Discovered only — "honest empty" stub `{databases:[], has_more:false}` (`server.js` ~line 1092-1103) | Complete (Grid/Board/Calendar/Gallery/Form/Timeline/Chart components under `src/components/database/`) | N/A (no real data) | N/A | Not verified (nothing to show) | static code inspection | No database row/field/view data model exists at all | Needs new collab_type + schema design | High | **P0** | Milestone 2 |
| Grid/Board/Calendar/Gallery views | `flowy-database2` + `collab-database` crate; field types incl. Relation, Summary(AI), Translate(AI) — **no native Rollup field type found upstream** | Not started | Fully built, including `CalendarUnsupportedPage.tsx` fallback already in frontend | N/A | N/A | Not verified | static code inspection | Entire server-side row/field CRUD, filter/sort/group services missing | Database-catalog data model (above) | High | **P0** | Milestone 2 |
| Field/property types | `field_entities.rs` enum (15 types) | Not started | Property editors exist (`components/property/*`) | N/A | N/A | Not verified | static code inspection | — | — | High | P1 | Milestone 2 |
| Filters/sort/group | `services/{filter,sort,group}` (Rust) | Not started | UI exists (`FiltersButton.tsx`, `SortsButton.tsx`) | N/A | N/A | Not verified | static code inspection | — | Row/field model | High | P1 | Milestone 2 |
| Row CRUD/navigation, relations/rollups | Cloud `/{workspace}/database/{id}/row`, `/fields` | Not started | `DatabaseRowModal.tsx`, relation/rollup property UI exist | N/A | N/A | Not verified | static code inspection | — | Row/field model | High | P1 | Milestone 2 |
| Database import/export (CSV/AFDatabase) | `services/share/csv/{import,export}.rs`, folder `ImportTypePB` | Not started | Unknown — not inventoried this task | N/A | N/A | Not verified | not assessed | — | Row/field model | Medium | P2 | Milestone 2 |
| Database real-time collab | Yjs via `collab-database` | Not started (WorkspaceDatabase catalog collab_type=2 exists only as an empty-state skeleton, Task 31) | Data layer is Yjs-based (`src/application/database-yjs/`), consistent with backend's existing Yjs machinery | N/A | N/A | Not verified | static code inspection | Needs new collab_type wired through existing admission/persistence machinery (architecturally plausible — see Part E) | Row/field schema decision | High | P1 | Milestone 2 |

**Do not confuse** the database-catalog stub (which exists and returns HTTP 200) with a working database feature — it deliberately returns zero databases and has no write path.

### Task 60 addendum — deeper discovery sharpens and corrects the above table

A dedicated deep-dive task (Task 60, three parallel research passes: frontend, upstream Rust/collab data model, upstream collaboration protocol; full detail in `docs/DATABASE_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`) found the gap is both structurally different and larger than the table above states:

- **At least 15 distinct frontend-declared endpoints beyond the one known stub have zero backend implementation** — atomic database/view/row creation (3 routes), legacy database-view creation, row-document duplication, row-comment notification, database version history, database blob-diff, CSV import (3-4 routes), `orphaned-view` (row-detail-page materialization), and `upgrade-database-container`. Exact paths/payloads are in the architecture doc §2.3.
- **The backend's WebSocket handler has no branch at all for `collabType` 1 (Database), 3 (Folder), or 4 (DatabaseRow)** — only 0 (Document) and 2 (WorkspaceDatabase placeholder) are admitted (`server.js:1406-1407` and related gates at lines 512-513/701-702/753-754/763/801/559-573, re-confirmed by direct code read this task). This is a protocol-layer gap: adding the missing REST routes alone would not enable real-time database sync.
- **Upstream's actual architecture is confirmed (by reading real pinned-revision `AppFlowy-Collab` source) to be a graph of linked Yjs collab objects**, not one document: a per-workspace `WorkspaceDatabase` catalog; one `Database` object per database (fields+views+row-order references only, no row content); one independent `DatabaseRow` object per row; and a lazily-created `Document`-type object per row-detail page (same collab type as an ordinary page, id derived via UUIDv5 from the row id). Cells are flat last-write-wins maps (no per-cell CRDT, not even for rich text); row ordering *is* genuine Yjs-Array CRDT state, per-view.
- **Re-confirmed independently (two separate research passes): no native upstream Rollup field type, and no CreatedBy/LastEditedBy field type exist upstream at all.** New finding not previously documented: the frontend's own `FieldType` enum nonetheless includes `Rollup=16`, `CreatedBy=17`, `LastEditedBy=18`, `Person=15`, `Formula=19` with deep, dedicated test coverage — a genuine frontend/upstream contract divergence requiring an explicit decision before Phase 3 field-type work (architecture doc §11).
- **Relation fields are confirmed to have real upstream complexity and are explicitly excluded even from AppFlowy-Cloud's own REST row-detail API** (`UNSUPPORTED_FIELD_TYPES = &[FieldType::Relation]`) — strong precedent for scoping Relation as its own dedicated design pass rather than general field-type work.
- **No upstream precedent for database-level version history/restore was found at all** — the frontend's `database-history-api.ts`/blob-diff contract has no located upstream server implementation; this backend's existing document version-history mechanism (Tasks 49A/49B/57) does not automatically cover database state, since database/row state lives in collab objects entirely outside any Document object's history.
- **Authorization re-confirmed membership-only by direct code inspection** (`requireWorkspace()`, `server.js:107`) — no role-differentiated write enforcement exists on any real production route (the one `role`-checking call site found is a test-only development helper).

This addendum sharpens, and in the endpoint-count/WS-protocol-gap respects **corrects**, the otherwise-still-accurate summary rows above (the rows are not wrong that database functionality is "Not started" — they understated how many distinct pieces "not started" actually covers).

### Task 61 addendum — Phase 1 of the above is now real and real-browser-verified (table rows above intentionally left as-is; read this addendum alongside them, not as a replacement)

Task 61 implemented and real-browser-verified Task 60's recommended Phase 1. Updated status for the specific rows above, stated here rather than edited into the table so the original discovery-time snapshot is preserved:

- **"Database real-time collab" row**: no longer "Not started." The WebSocket handler now admits `collabType=1` (additive branch, mirrors Document exactly — persist-before-ack, Rid allocation, idempotency all reused unmodified). **Backend tested** (13 new tests, `test/database-collab.test.js`) + **Browser verified** (full add-field/rename-field workflow through the real WebSocket channel, see `docs/APPFLOWY_TASK61_REPORT.md` §6). JSON mode; Postgres parity (Phase 1b) completed by Task 63 (see the Task 63 addendum below).
- **"Database-catalog listing" row**: the REST stub (`GET /{workspace}/database`) itself is **unchanged** (still returns `{databases:[], has_more:false}`) — confirmed this task to be genuinely unnecessary for create/discover/reopen, since discoverability runs through the pre-existing Folder-tree mechanism (the same one Document pages already use) instead. A **new** atomic-creation route (`POST .../v2/page-view/database/default`) now exists and is **Backend tested + Browser verified**.
- **"Grid/Board/Calendar/Gallery views" row**: Grid only is now real (one default inline view per database, JSON mode, no rows). Board/Calendar/Gallery/Chart/List/Feed/Form/Timeline creation requests are explicitly rejected (400) — still "Not started" for those layouts, unchanged.
- **"Field/property types" row**: the primary/title field (`RichText`, type 0) is now real, seeded on creation and editable (add/rename) through the real UI with zero bespoke server code (the backend admits the frontend's own generic Yjs field-add/rename mutations exactly like a Document edit — see the Task 61 report §2.5/§3c). The FieldType 15-19 divergence flagged by the Task 60 addendum above remains **fully unresolved** — not touched, not silently remapped.
- **"Row CRUD/navigation, relations/rollups" row**: unchanged, "Not started" — rows remain explicitly out of scope for Phase 1.
- **New gap discovered this task, not previously tracked anywhere**: the pre-existing object-permission endpoint (`GET /collab/{id}/permission?collab_type=`, tracked in §3's "Object-level permission" row below for the *sharing* milestone) turned out to also gate **database-adjacent UI**, not just sharing — see the Task 61 report §3g/§9 for the exact mechanism. This is now partially addressed (collab_type=0 for spaces, collab_type=1 for Database objects), but the underlying row-vs-column access-level model behind it is still exactly as undeveloped as §3 describes; only its *coverage* (which object types it recognizes at all) grew.

### Task 62 addendum — minimum viable DatabaseRow lifecycle is now real and real-browser-verified (table rows above intentionally left as-is; read this addendum alongside them, not as a replacement)

Task 62 implemented and real-browser-verified the minimum viable slice of row creation/ordering/cell-editing. Updated status for the specific rows above, stated here rather than edited into the table so the original discovery-time snapshot is preserved:

- **"Database real-time collab" row**: now additionally admits `collabType=4` (DatabaseRow) — additive branch, mirrors the `collabType=1` branch Task 61 built exactly (persist-before-ack, Rid allocation, idempotency all reused unmodified). **Backend tested** (11 new tests, `test/database-row-collab.test.js`) + **Browser verified** (create-row + edit-primary-cell workflow through the real WebSocket channel, see `docs/TASK62_DATABASE_ROW_CONTRACT_AND_IMPLEMENTATION_REPORT.md` §6). JSON mode; Postgres parity (Phase 1b) completed by Task 63 for both the Database and the DatabaseRow object (see the Task 63 addendum below).
- **"Row CRUD/navigation, relations/rollups" row**: partially real now — row **creation** (atomic `POST .../v2/database/{databaseId}/row/default`, with row-order insertion) and the primary RichText field's **cell editing** (generic Yjs admission, zero bespoke server code) are implemented and real-browser-verified. Still **not started**: relations, rollups, any non-primary/non-RichText field's cell-data shape (not individually re-verified this task), row-detail-page navigation/materialization (`orphaned-view`, confirmed lazily-triggered and not needed by this task's workflow), row templates/duplication (a separate, more advanced endpoint, confirmed distinct from the one implemented this task).
- **"Grid/Board/Calendar/Gallery views" row**: unchanged from the Task 61 addendum — Grid only, one view per database. Rows now exist within that single Grid view; Board/Calendar/Gallery/etc. remain entirely "Not started."
- **"Field/property types" row**: unchanged from the Task 61 addendum for field *definitions* (still only RichText/type 0 is real); this task adds that RichText **cell content** (not just the field definition) can now be written and persisted for a real row, via the generic WS path.
- **New findings this task, not previously tracked anywhere**: (1) row *deletion/unlink* is confirmed **already fully functional today**, requiring zero new backend code — the frontend's existing soft-delete (tombstone) and remove-from-view operations are ordinary Yjs mutations of the Database doc's `row_orders` array, already admitted by Task 61's `collabType=1` branch; hard deletion of a DatabaseRow collab object is confirmed, not assumed, to never be required by the real frontend in any code path. (2) a row's detail/"peek" page is confirmed to be a lazily-created, separate `CollabType.Document` object (deterministic `uuidv5('document_id', rowId)` id) — not eagerly created by row creation, and not implemented by this task since nothing in the mandatory minimum workflow required it. (3) one new, non-blocking, **frontend-side** observation (a pre-existing, unmodified `sync-outbox` IndexedDB write occasionally fails with a Dexie `NotFoundError` in the headless-Chromium browser-verification harness when applying a row-creation diff locally) was found, reproduced, and documented rather than silently worked around — see the Task 62 report §6b; it did not affect data correctness in any observed run.

### Task 63 addendum — PostgreSQL parity for Database and DatabaseRow (Phase 1b) is now real and tested (table rows above intentionally left as-is; read this addendum alongside them, not as a replacement)

Task 63 implemented and tested full PostgreSQL storage parity for the Database (Task 61) and DatabaseRow (Task 62) collab objects, including the atomic row-creation transaction. Full detail in `docs/TASK63_POSTGRES_DATABASE_AND_DATABASE_ROW_PARITY_REPORT.md`.

- **"Database real-time collab" row**: Postgres column updates from "Phase 1b is not started" to **Tested** — `database_collab_documents`/`database_collab_updates`/`database_row_collab_documents`/`database_row_collab_updates`/`atomic_row_creation_requests` (migration 007) back `getDatabaseCollab`/`acceptDatabaseCollabUpdate`/`getDatabaseRowCollab`/`acceptDatabaseRowCollabUpdate`/`createAtomicDatabaseRow` for `collabType=1` and `=4` identically to JSON mode (proven by a dedicated JSON/Postgres parity test, byte-for-byte-identical logical fingerprints). **Browser verified** (two rows, two values, reload, and a real backend-process restart, all through the real UI in `STORAGE=postgres` mode — see `docs/task63-evidence/browser-run/`).
- **"Row CRUD/navigation" row**: the atomic row-creation transaction now has full Postgres parity, including real fault-injection-proven rollback at six checkpoints and true-concurrency correctness (independent rows, identical-request-id races, conflicting-request-id races) — not just the JSON-mode behavior Task 62 proved.
- **"Database-catalog listing" row**: **re-confirmed, with a sharper finding than Task 61's addendum** — the stub (`GET /{workspace}/database`, still `{databases:[], has_more:false}`) is not merely "unnecessary for create/discover/reopen within the SAME session" as Task 61 found; it is the exact, traced root cause of a 404 when ANY session that did not itself just complete the creation flow (a fresh login, or a different real user) tries to open an existing Database. This is storage-mode-agnostic (identical in JSON mode) and is now the single most important open item in this section — see the main Task 63 report for the full evidence chain.
- **New cross-cutting finding, not previously tracked anywhere**: this backend's real-time collaboration model broadcasts **nothing** to other already-connected peers except `awarenessUpdate` (cursor/presence) — traced directly in `server.js` for all three collab types (Document, Database, DatabaseRow). Every content write (ordinary Yjs update OR the atomic row-creation REST endpoint) is durable immediately but is only observed by another connected peer the next time that peer issues its own `SyncRequest`. This generalizes Task 62's "REST row creation doesn't broadcast" finding to the whole system, for every collab type and every write path, proven by a real two-WebSocket-connection test (`test/postgres-database-multiclient.test.js`).

### Task 64 addendum — "Database-catalog listing" row is now real in both storage modes, and a second route fix was required to actually open what it discovers

Task 64 fixed the exact stub Task 63's addendum above flagged, plus one more gap it masked. Full detail: `docs/TASK64_DATABASE_CATALOG_AND_FRESH_SESSION_NAVIGATION_REPORT.md`.

- **"Database-catalog listing" row**: upgrades from "hardcoded `[]` stub, storage-mode-agnostic gap" to **Tested + Browser verified, both storage modes**. `GET /api/workspace/{id}/database` now derives the real catalog from `pages` (container + primary-view pairing, malformed/orphan/decoy-mismatch cases handled defensively — see `database-catalog.js`), with real `offset`/`limit` pagination. 17 new JSON tests (`test/database-catalog.test.js`), 12 new Postgres tests (`test/postgres-database-catalog.test.js`), 1 new JSON/Postgres parity test.
- **New finding this task, not previously tracked anywhere**: the catalog fix alone did not make a Database openable from a fresh session — `GET .../page-view/{viewId}` (the frontend's generic cold-fetch route for any view with no local cache) required a Document collab object a Database page never has, producing a fatal "Page not found" even after the catalog fix. Fixed in the same route: serves the Database collab's bytes when the page carries `extra.database_id`. Both fixes together, not either alone, make the "second real user opens a Database they never created" acceptance outcome actually true — proven with a real independent-second-browser-context Playwright run in both JSON and PostgreSQL mode (`docs/task64-evidence/`).
- **Real-time broadcast model finding (Task 63) is unchanged** — still re-confirmed, still out of scope for this task, per its own explicit brief.
- **New, deliberately unfixed, pre-existing, unrelated finding**: a non-UUID-formatted workspace id in the URL path returns 500 in PostgreSQL mode (native `uuid` column cast failure) instead of JSON mode's 403 — not specific to the catalog route (affects `requireWorkspace`, used file-wide), out of this task's scope, documented rather than fixed.

## 3. Sharing / permissions (MAJOR gap — enforcement model does not exist)

| Feature | Upstream reference | Backend status | Frontend status | JSON | Postgres | Browser | Tests | Gap | Dependency | Risk | Priority | Milestone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Workspace membership/roles | `AFRolePB` (Owner/Member/Guest), Cloud `/member` API | Discovered (membership exists, used for workspace access checks) but roles beyond "member exists" not confirmed enforced this task | Member management UI exists (`workspace_member_page` equivalent not in Web — unconfirmed) | Partial | Partial | Not verified | static code inspection | Role-based permission differentiation (owner vs member write limits) not confirmed to exist in `server.js` authz checks | — | Medium | P1 | Milestone 3 |
| Per-document sharing/invitations | Cloud `/invite`, `/invite/{id}/accept`, invite-by-code | Not started | Fully built (`SharePanel.tsx`, `InviteGuest.tsx`, `AcceptInvitationPage.tsx`, `access-api.ts` expecting `/api/sharing/workspace/{id}/view`, `/api/workspace/invite/{id}`, `/api/workspace/accept-invite/{id}`) | N/A | N/A | Not verified | static code inspection | Entire invitation/grant data model missing | Role model decision | High | **P0** | Milestone 3 |
| Sharing-view ("shared with me") | Cloud publish/access-request system | Discovered — honest empty stub (`server.js` ~1065-1091) | Built | N/A | N/A | Not verified | static code inspection | — | Invitation model | High | P0 | Milestone 3 |
| Public sharing / "publish to web" | Cloud `post_publish_collabs_handler`, publish-namespace API | Not started | Unconfirmed in Web inventory this task | N/A | N/A | Not verified | not assessed | Distinct feature from per-user sharing; upstream supports it | — | Medium | P2 | Milestone 3b |
| Access revocation | Cloud `.../revoke-access` | Not started | `access-api.ts` has the client call | N/A | N/A | Not verified | static code inspection | — | Invitation model | Medium | P1 | Milestone 3 |
| Object-level permission (`/collab/{id}/permission`) | Cloud collab permission handler | Not started | `access-api.ts` expects it | N/A | N/A | Not verified | static code inspection | — | Role model | Medium | P1 | Milestone 3 |
| WS authorization for shared docs | n/a (backend-specific) | Discovered — current WS auth is workspace-membership only, no per-document grant check | n/a | — | — | — | static code inspection | Needs to extend once per-doc sharing exists | Per-doc model | Medium | P2 | Milestone 3 |

## 4. Collaboration

| Feature | Upstream reference | Backend status | Frontend status | JSON | Postgres | Browser | Tests | Gap | Dependency | Risk | Priority | Milestone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Yjs WS sync, persist-before-ack | collab-document protocol | Complete (single instance) | Complete | Tested (28+ fixtures) | Tested (structurally; collab persistence Postgres-tested via version-history suite) | Verified | previously verified + newly executed | — | — | Low | — | — |
| Reconnect / offline-edit replay | client sync-outbox convention | Backend tested | Complete | Tested | Not independently tested | Verified (Task 41/56) | previously verified | Postgres-mode reconnect not separately browser-verified | — | Low-Med | P2 | Hardening |
| Rid allocation/ordering | inferred from protocol comments, no upstream server source available | Resolved (single-instance; per-workspace, in-process) | n/a | Tested | Tested (allocator pattern) | n/a | previously verified (Task 46) | **Not proven across processes/instances** | Cross-instance design | Medium | P1 | Milestone 1 |
| Restore-generation fencing | n/a (original design here) | Complete | Complete | Tested | Tested | Verified | previously verified | — | — | Low | — | — |
| Cross-instance replay/ordering | protocol comments imply shared Redis stream; no upstream server source found | **Pending — unimplemented and unverified** | n/a | N/A | N/A | N/A | not assessed (nothing exists to test) | No pub/sub, no shared ordering authority across processes | Needs architecture decision | **High** | **P0** | Milestone 1 |
| Compaction/retention | n/a — nothing compacts today | **Pending — deliberately unresolved** (Task 47: no compaction exists; current-state blob is already minimal, but `collab_updates`/version history grow unboundedly) | n/a | N/A | N/A | N/A | not assessed | Needs retention policy decision | — | Medium | P1 | Milestone 1 |
| Presence (live cursors/avatars) | AppFlowy presence protocol | Not started | Unconfirmed in frontend inventory this task | N/A | N/A | Not verified | not assessed | — | — | Medium | P2 | Milestone 1b |
| Comments (page/inline/row) | 3 separate upstream subsystems | Not started | Fully built (`global-comment/`, `inline-comment/`, database `row-comment-api.ts`) | N/A | N/A | Not verified | static code inspection | — | — | Medium | P2 | Milestone 5 |
| Mentions | editor mention panel | Not started | Fully built (`mention-panel/`, `leaf/mention/`) | N/A | N/A | Not verified | static code inspection | — | Depends on search/user-lookup | Medium | P2 | Milestone 5 |
| Notifications | Cloud `/notifications`, unread-count, archive | Not started | Fully built (`NotificationBell.tsx`, `notification-api.ts`) | N/A | N/A | Not verified | static code inspection | — | — | Low-Med | P2 | Milestone 5 |

## 5. Version history / recovery (most mature area post-Task 57)

| Feature | Upstream reference | Backend status | Frontend status | JSON | Postgres | Browser | Tests | Gap | Dependency | Risk | Priority | Milestone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| List/preview versions | `collab-api.ts` `getCollabVersions`/preview | Complete | Complete (incl. Task 57 UI) | Tested | Tested (real Postgres, Task 49B/56) | **Verified** (Task 57, 14/14 steps) | previously verified | — | — | Low | — | — |
| Create named snapshot | `createCollabVersion` | Complete | Complete (Task 57 added the UI control) | Tested | Tested | Verified | previously verified | — | — | Low | — | — |
| Tombstone-delete version | `deleteCollabVersion` | Complete | Complete (Task 57 added the UI control) | Tested | Tested | Verified | previously verified | — | — | Low | — | — |
| Restore/revert | `revertCollabVersion` | Complete | Complete | Tested | Tested | Verified | previously verified | — | — | Low | — | — |
| Generation fencing on restore | original design here, reusing Task 45 fencing | Complete | n/a | Tested | Tested | Verified | previously verified | — | — | Low | — | — |
| Concurrent-restore resolution | n/a | Complete (first-durable-write-wins) | n/a | Tested | Tested | n/a (not browser-exercised concurrently) | previously verified | Concurrent restore not demonstrated in a real two-browser session (only backend-level concurrency fixtures) | — | Low-Med | P2 | Hardening |
| Live-propagation to already-connected client | n/a | Discovered (works via ordinary Yjs sync channel, not a dedicated broadcast) | n/a | n/a | n/a | Verified (Task 56/49C-R3) | previously verified | **Distinct from, and does not replace,** a true restore-notification frame for a client that must be told explicitly (vs. silently resyncing) | — | Low | P3 | — |
| Restore-notification broadcast to stale/disconnected clients | n/a (no upstream source found) | **Not implemented** — only reject-then-reconnect fencing | n/a | N/A | N/A | N/A | not assessed | No frame type defined | Protocol decision | Medium | P2 | Milestone 1 |
| Retention/backup policy (count/TTL/plan-tier gating) | frontend shows an `isPro` gate upstream | **Undecided — product/design gap** | Partially gated in frontend (`isPro` check exists) | N/A | N/A | N/A | not assessed | No retention limit enforced; unbounded growth | Product decision | Medium | P1 | Milestone 1 |

## 6. Files / attachments / templates (essentially unbuilt on backend)

| Feature | Upstream reference | Backend status | Frontend status | JSON | Postgres | Browser | Tests | Gap | Dependency | Risk | Priority | Milestone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| File/image upload & storage | Cloud `file_storage.rs`, MinIO/S3 required service | **Not started** | Fully built (`UploadImage.tsx`, `FileDropzone.tsx`, editor file/image/pdf/video/audio blocks, `file-api.ts` expecting `/api/file_storage/...`) | N/A | N/A | Not verified | static code inspection | No storage backend of any kind (no local disk, no S3-compatible) chosen or built | Storage-backend decision | High | **P0** | Milestone 4 |
| Multipart upload | Cloud multipart API | Not started | `multipart-upload.ts` client exists | N/A | N/A | Not verified | static code inspection | — | Storage backend | Medium | P2 | Milestone 4 |
| Template discovery/gallery | Cloud `template.rs` (categories/creators/templates/homepage/avatar) — **self-hosted data model, not a public marketplace API** | Not started | Fully built (`as-template/`, `template-api.ts` expecting `/api/template-center/*`) | N/A | N/A | Not verified | static code inspection | No template data model | File storage (for template assets) | Medium | P2 | Milestone 6 |
| Official live AppFlowy template retrieval | **Unknown** — no external marketplace URL/API found in any checked-out repo despite explicit search | **Unknown** | n/a | n/a | n/a | n/a | not assessed — explicitly not invented | Cannot build "official template sync" without confirming whether such a public API exists; would need evidence from AppFlowy's live production service, not source | — | — | — | Design decision needed before Milestone 6 |
| Offline/custom template library | n/a | Not started | n/a | N/A | N/A | Not verified | not assessed | Simplest self-hosted path: bundle a static template set, skip external sync entirely | Product decision | Low | P3 | Milestone 6 |
| Import/export (Markdown/HTML/CSV) | `document_exporter.dart`, CSV services | Not started | Unconfirmed this task | N/A | N/A | Not verified | not assessed | — | — | Medium | P2 | Milestone 4b |

## 7. Search / productivity

| Feature | Upstream reference | Backend status | Frontend status | JSON | Postgres | Browser | Tests | Gap | Dependency | Risk | Priority | Milestone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Full-text/semantic search | Dedicated `appflowy_search` microservice: pgvector + Redis + OpenAI/Azure embeddings + on-disk keyword index + background indexer | **Not started** | Fully built (`Search.tsx`, `misc-api.ts` expecting `/api/search/{workspace}`, `.../page`, `.../summary`) | N/A | N/A | Not verified | static code inspection | Upstream search is a hybrid vector+keyword system requiring external embedding API keys — **a full-fidelity port would reintroduce exactly the external/commercial dependency this project exists to avoid**; a scoped-down Postgres-`tsvector`-only alternative is the realistic self-hosted target | Product decision: full semantic parity vs. keyword-only | Medium-High | P1 | Milestone 5 |
| Recent documents | Cloud `/recent` | Not started | Unconfirmed (separate "quick-note" API referenced) | N/A | N/A | Not verified | static code inspection | — | — | Low | P2 | Milestone 5 |
| Global search UI | Flutter + Web `Search.tsx` | n/a (frontend-only) | Built | n/a | n/a | n/a | static code inspection | — | Search backend | — | — | — |
| Settings/preferences | not inventoried this task | Not assessed | Not assessed | — | — | — | not assessed | — | — | — | — | — |

## 8. Integrations / AI

| Feature | Upstream reference | Backend status | Frontend status | JSON | Postgres | Browser | Tests | Gap | Dependency | Risk | Priority | Milestone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AI chat / "Ask AI" | Cloud `chat.rs` (streaming SSE, chat-context), dedicated `appflowy_ai` microservice requiring `OPENAI_API_KEY`/Azure | **Not started** | Fully built (`ai-chat/`, `chat/` incl. model selector, writer tools; `chat-request.ts` expecting `/api/chat/*`, `/api/ai/*`) | N/A | N/A | Not verified | static code inspection | Real external dependency on a commercial/3rd-party AI gateway upstream — **must not be silently required**; if built, must be an explicit, optional, self-hosted-key-configurable feature, never a hard dependency | Explicit product decision: build a thin optional AI proxy, or omit AI entirely and let the UI gracefully degrade | High (dependency-egress risk) | P2 (do last; optional) | Milestone 7 |
| Commercial plan gating (Free/Pro/Team/AiMax/AiLocal) | Flutter `workspace_subscription_ext.dart` | **Confirmed upstream feature-gates AI/other tiers by paid plan** — this backend must never adopt or require that gate | n/a | n/a | n/a | n/a | static code inspection | Must ensure no frontend code path silently requires a commercial subscription check to function | — | High if ignored | P0 (must verify, not build) | Cross-cutting constraint |
| GoTrue-shaped auth assumptions in frontend | `gotrue.ts`, `gotrue-error.ts` | Discovered — currently harmless (custom backend's responses happen to satisfy the code), but a latent compatibility risk | n/a | n/a | n/a | Working today by coincidence of response shape | static code inspection | Should be explicitly tested/decoupled, not left as an accidental compatibility | — | Medium | P1 | Milestone 1b / hardening |

## 9. Production readiness

| Feature | Evidence | Status | Risk | Priority | Milestone |
|---|---|---|---|---|---|
| CORS allowlist, preflight, no wildcard+credentials | `server.js` CORS_ALLOWED_ORIGINS/HEADERS, re-confirmed this task | Complete, backend tested + browser verified | Low | — | — |
| Rate limiting | Grep confirms **zero** rate-limiting code anywhere in `server.js`/deps | **Missing entirely** | High (DoS/brute-force exposure, especially login) | **P0** before any public exposure | Milestone 8 |
| Input validation | Type/length checks exist (email/password/document/workspace-name); no schema-validation library; page title length unbounded; most rigorous check is Yjs-replay validation on snapshot creation | Partial | Medium | P1 | Milestone 8 |
| Secrets management | scrypt password hashing + `timingSafeEqual`; 256-bit CSPRNG tokens; only fallback literal is an explicitly-named dev-only test key gated to non-prod environments; no secrets hardcoded | Good | Low | — | — |
| Postgres connection pooling | `pg.Pool` (max 5) used everywhere, not a bare client; `withClient` helper releases via `finally` | Good | Low | — | — |
| Postgres transaction boundaries | `BEGIN`/`COMMIT`/`ROLLBACK` wrapping every multi-step op in both `postgres-storage.js` and `postgres-collab-repository.js`; release unconditional via `finally` | Good | Low | — | — |
| **Postgres migration advisory lock** | **Re-confirmed missing this task** — `openPostgresStore` still runs `client.query(migration)` with no `pg_advisory_lock`/`pg_advisory_xact_lock` anywhere in the file; only mitigated at test-invocation level (`--test-concurrency=1`), not in production code (Task 56 finding, unresolved) | **Unresolved known defect** | Medium-High (deadlock under concurrent startup in any multi-process/multi-container deployment) | **P0** | Milestone 1 |
| Logging/observability | Only ad hoc `console.error`/`console.log`; no structured logger, no request logging middleware, no metrics/error-tracking integration | Missing | Medium | P1 | Milestone 8 |
| Multi-instance / horizontal scaling | Per-workspace Rid allocator is in-process; no shared pub/sub; cross-instance-replay conformance case explicitly pending | Not ready | High for any HA/scale-out deployment | **P0** (if horizontal scaling is a near-term goal) | Milestone 1 |
| Backup/recovery (of the backend's own data) | Not assessed this task beyond version-history's own restore feature (which is a document-level undo, not a database backup strategy) | Not assessed | Unknown | P2 | Milestone 8 |
| Deployment docs | `README.md`/`.env.example` cover local dev only; no container/orchestration/upgrade-rollback docs found | Missing | Medium | P2 | Milestone 8 |
| OSS licensing/attribution | Not independently re-audited this task; no red flags found in files read | Not assessed | Unknown | P3 | — |

### Why the P0s are P0

- **No real database functionality** — the single largest product-completeness gap; the frontend is fully built and waiting, so this is the highest-leverage work, but it is P0-for-roadmap-sequencing (must be designed first) rather than P0-urgent-fix.
- **No real sharing/permission enforcement** — same shape of gap as database: frontend fully built, backend absent; also a trust/security gap once any multi-user data exists.
- **Postgres migration advisory-lock gap** — a concrete, reproducible defect (not a missing feature) in code that has already shipped and is relied upon by committed tests; cheap to fix, high value to fix before any concurrent/production Postgres usage.
- **No rate limiting** — a concrete security exposure (login brute-force, resource exhaustion) in code already exposed to a browser; cheap relative to its risk.
- **Cross-instance replay unimplemented** — blocks any horizontal-scaling or HA deployment; P0 only if that is a near-term deployment goal (flagged as a dependency-gated P0, not an unconditional one).
- **Commercial plan-gating / AI-gateway dependency must not leak in** — a non-negotiable constraint check, not a feature request; P0 to verify and document now, not to defer.

## 10. Task 65 addendum — real-time collaboration broadcast gap, root-caused and architecturally decided (investigation only, no implementation yet)

**Feature row update**: "Real-time collaboration (live push of content updates to other already-connected peers)" is now a distinctly tracked row, separate from the already-working "Initial sync / SyncRequest / reconnect catch-up" row and the already-working "Awareness/presence relay" row (both unaffected by this finding). Status: **Missing capability, root-caused, architecture decision produced and documented, implementation NOT started — awaiting approval.** Evidence: `docs/TASK65_UPSTREAM_COLLABORATION_ARCHITECTURE_AUDIT.md` (upstream mechanism, function-level), `docs/TASK65_UPSTREAM_VS_INDEPENDENT_BACKEND_GAP_ANALYSIS.md` (full comparison table + root cause), `docs/TASK65_REALTIME_COLLABORATION_ARCHITECTURE_DECISION.md` (recommended fix + required-changes scope + rejected alternatives). Risk: Medium (responsiveness-only, not a data-integrity defect — every existing persist-before-ack/dedup/validation guarantee is proven unaffected and unchanged by the proposed fix). Priority: P1 (a basic two-user collaborative scenario visibly fails to feel collaborative today, but every write is still eventually correct on reconnect). Milestone: cross-cutting (affects Document, Database, and DatabaseRow identically — not a Database-specific or Milestone-2-specific item).

**What was newly confirmed this task, beyond Task 63's original side-finding**: (1) upstream's own live protocol (`/ws/v2`, the one AppFlowy-Web's real client and this backend both actually implement) has **no per-update acknowledgement at all** and a **weaker, asynchronous** long-term-durability guarantee than this backend's persist-before-ack design — i.e. this backend's ack/durability model is already stronger than upstream's in this respect, not weaker; (2) the root cause is narrowly that this backend's own already-working awareness-relay pattern (a flat, filtered scan of an in-process peer set) was never extended to content updates — not a missing broker, not a missing protocol capability, not a frontend limitation; (3) adopting any part of upstream's realtime service remains not viable (re-confirmed for the live v2 stack specifically, not just the previously-examined legacy stack) because it is hard-coupled to Redis and to AppFlowy-Cloud's own auth/workspace schema regardless of which of its two internal designs is considered.

**For future reference**: do not re-open this investigation from scratch in a future task — read the three Task 65 documents first. If the recommended fix is approved and implemented, this section should be updated (not replaced) to mark the "Real-time collaboration" row Complete/Backend-tested/Browser-verified per §5's existing completion-standard discipline, with its own new evidence references, exactly as every other row in this registry already does.

## 11. Task 66 addendum — "Real-time collaboration (live push)" row upgraded to Backend tested (Browser verified NOT yet achieved)

Task 66 implemented Task 65's approved Option B decision. Full detail: `docs/TASK66_REALTIME_CONTENT_UPDATE_FANOUT_IMPLEMENTATION_REPORT.md`.

- **"Real-time collaboration (live push of content updates to other already-connected peers)" row**: status upgrades from "Missing capability, root-caused, architecture decision produced, implementation NOT started" to **Backend tested** (6/6 JSON/Postgres × Document/Database/DatabaseRow combos, plus negative/isolation/failure-handling cases, `test/realtime-fanout.test.js` + `test/postgres-realtime-fanout-document.test.js` + the Task-66-updated `test/postgres-database-multiclient.test.js`). **Browser verified is NOT yet achieved**: real two-browser-context verification was attempted across 8 iterations but did not reach a pass, due to a Playwright/AppFlowy-Web `ViewModal` UI-interaction issue in the test script (title auto-focus + modal sticky-header click interception) — isolated via a direct server-side state read as a test-script issue, not a backend/fan-out defect, since the server never received the typed content in the failing attempts. See `docs/TASK66_REALTIME_CONTENT_UPDATE_FANOUT_IMPLEMENTATION_REPORT.md` §10 for full evidence and what remains. The "Initial sync / SyncRequest / reconnect catch-up" and "Awareness/presence relay" rows this row was deliberately kept separate from are unaffected and unchanged.
- **Scope boundary, explicitly recorded not silently crossed**: the atomic REST row-creation endpoint (Task 62/63/64) still does not fan out to connected peers — confirmed unchanged; whether it should is a separate, undecided product/scope question, not addressed by this task.
- **Recorded browser-evidence limitation**: AppFlowy-Web's current UI has no separate row-detail/"peek" document view, so the real-browser DatabaseRow scenario reuses the same grid-cell-editing action as the Database scenario. This is not a gap in what was proven — an ordinary grid cell edit is itself carried by the DatabaseRow collab object at the protocol level — but the Database(collabType=1)-only fan-out path (e.g. a field-metadata change) has no distinct supported UI action to drive it in isolation and is proven at the protocol level instead of via browser.
- **Risk/Priority update**: Risk downgrades from Medium (responsiveness-only gap) to Low (backend proven, only a test-harness interaction issue remains); Priority remains P2 until real-browser verification actually passes and this row can be moved to "Complete."

## 12. Task 67 addendum — authorization/REST/WebSocket security audit; new "WS session/membership revocation lifecycle" row added; "Postgres migration advisory lock" / "Rate limiting" rows re-confirmed unresolved (unchanged, out of this task's scope)

Task 67 was a dedicated security audit and hardening task. Full detail: `docs/TASK67_AUTHORIZATION_AND_WEBSOCKET_SECURITY_REPORT.md`.

**New feature row**: "WS session/membership revocation lifecycle (an already-connected peer's access is actively re-checked and revoked mid-connection, not only on its own next message)." Status: **Backend tested** (real protocol-level tests, both JSON and Postgres; real-browser verification Blocked — see below). Evidence: `test/security-authorization.test.js`, `test/postgres-security-authorization.test.js`, `docs/TASK67_AUTHORIZATION_AND_WEBSOCKET_SECURITY_REPORT.md`. Risk: Low (bounded, documented residual exposure window equal to the periodic-revalidation interval; immediate push-based revocation would require a broker this backend does not have and was correctly not introduced for this). Priority: was effectively P1 as an unresolved finding carried over from Task 66; now resolved for the backend.

**Pre-existing rows re-confirmed, unchanged, and explicitly NOT touched by this task** (sampled during the authorization audit, since both are adjacent to "security"): `Rate limiting` — grep-confirmed still **zero** rate-limiting code anywhere; still **Missing entirely**, still P0-before-public-exposure, unchanged, out of this task's scope (this task hardened authorization/authentication state machines, not DoS/brute-force protection, a materially different class of control). `Postgres migration advisory lock` — not re-touched this task; status unchanged from its last recorded state (resolved by Task 59; see that task's own entry) — listed here only to prevent a future reader from assuming a security-titled task silently re-audited every row in this table.

**REST/WS authorization surface itself is now a tracked row, not an assumed property**: "REST/WS authorization — membership-scoped object access, no cross-workspace leak via guessed ids" — Status: **Complete for the currently-implemented operation set** (no role-gated operations exist to extend this to; see the report's §2 role-model decision gate). Evidence: the same two new test files, covering non-member/cross-workspace/malformed-id/parent-ownership-chain rejection in both storage modes.

**Scope boundary, explicitly recorded**: this task did not build a role/ACL framework (none of the currently-implemented operations need one, confirmed with evidence, not assumed), did not add rate limiting, did not touch the Postgres migration-lock row, and did not implement a real product membership-management feature (the revocation helper added is dev/test-only, mirroring the pre-existing grant helper's own scope).

## 13. Task 68 addendum — collaboration recovery/reconnection; new "Recovery/reconnection correctness" row added, confirmed Already Correct, not a new feature

Task 68 investigated network interruption, backend restart, lost-ack/duplicate-replay, concurrent reconnection, offline outbox, and authorization-during-recovery. Full detail: `docs/TASK68_COLLABORATION_RECOVERY_AND_RECONNECTION_REPORT.md`.

**New feature row**: "Collaboration recovery/reconnection correctness (state-vector reconciliation after reconnect, lost-ack/duplicate-replay dedup, RID continuity across backend restart, authorization re-checked on every recovery connection)." Status: **Backend tested** (real protocol-level tests, both JSON and Postgres, including a genuine backend process restart; real-browser verification of the restart scenario Blocked — see below). Evidence: `test/collaboration-recovery.test.js`, `test/postgres-collaboration-recovery.test.js`, `docs/TASK68_COLLABORATION_RECOVERY_AND_RECONNECTION_REPORT.md`. Risk: Low — every mechanism this row depends on (digest-based dedup, durable per-workspace Rid allocation, per-connection/per-frame CURRENT-auth-state checks) pre-dated this task and was independently re-verified, not newly built. Priority: P2 (verification/hardening task, not a blocking gap).

**No new defect found, no production code changed**: this task is a verification task, not a bug-fix vehicle — `server.js`, `storage.js`, `postgres-storage.js`, `postgres-collab-repository.js` were read extensively but not modified. The one file changed is a pre-existing Playwright test-harness syntax defect (`test/screens/DocumentScreen.ts`), unrelated to recovery logic itself.

**Dexie `NotFoundError` row (Tasks 62/63) re-confirmed unresolved, not re-touched**: this task's bounded real-browser budget did not include a fresh row-creation reproduction attempt; the observation remains carried forward exactly as Task 63 left it (non-blocking, frontend-side, pre-existing code, outbox fallback confirmed working each prior occurrence).

**Real-browser verification of backend-restart recovery is Blocked** (3/3 distinct attempts) — the same pre-existing `ViewModal`/navigation-timing fragility Tasks 66 and 67 already independently documented (8 and 3 attempts respectively), now confirmed a third time by an independent task using a different scenario. This is now a pattern worth a dedicated future investigation in its own right (see `docs/AGENT_HANDOVER.md`'s Task 68 section for a concrete alternative-strategy suggestion), separate from whatever feature/recovery task next needs real-browser proof.

## 14. Task 69 addendum — Playwright browser-automation reliability: the "ViewModal/navigation-timing fragility" row Tasks 66/67/68 each independently hit is root-caused and the test infrastructure fixed; no feature-row status changes

Task 69 was a dedicated test-infrastructure task. Full detail: `docs/TASK69_PLAYWRIGHT_E2E_INFRASTRUCTURE_REPORT.md`.

**New tracked row**: "Real-browser E2E test infrastructure (navigation reliability, modal/route/identity handling, test isolation)." Status: **Test infrastructure verified** (5/5 consecutive full-suite passes, 35/35 individual scenario passes, `test/e2e/core-navigation.spec.ts`). This is a test-infrastructure row, not a product-feature row — it does not itself change the status of any product-feature row in this registry.

**Root cause of the recurring real-browser blocker Tasks 66/67/68 each hit, proven not assumed**: the sidebar quick-add-document flow opens new Documents in a real, full-viewport, pointer-events-active `ViewModal` dialog while the underlying full page also mounts behind it; this single mechanism explains every prior task's distinct-looking symptom (sticky-header interception, content-not-found toast, DOM-focus rejection, stale-looking sidebar visibility). A second defect (Slate body-editor focus not reliably following a bounding-box-center click) was also found and fixed in the test harness.

**Effect on existing rows, applied narrowly**: "Real-time collaboration (live push)" (row from §11, Task 66 addendum) and "WS session/membership revocation lifecycle" (row from §12, Task 67 addendum) remain **Backend tested** — their full original browser scenarios were not re-run this task. "Collaboration recovery/reconnection correctness" (row from §13, Task 68 addendum) also remains **Backend tested**, but its real-browser evidence gap is now partially closed: the core backend-restart scenario (persisted content + new post-restart edit, verified in a real browser) now passes using the new infrastructure (`docs/task69-evidence/task68-scenario-b-reverify/results.json`); a bonus second-context live-delivery check within that same scenario was not completed (an unrelated second-login timeout, not a reoccurrence of the original blocker). None of these three rows' status strings are changed by this task, per its own explicit instruction not to silently upgrade them.

**No AppFlowy-Web product source file was changed by this task.**

**Scope boundary, explicitly recorded**: this task did not redesign the collaboration protocol, did not add a new idempotency/outbox mechanism (the existing digest-based dedup and AppFlowy-Web's own pre-existing `sync-outbox` already satisfy the requirement), did not touch Task 59's migration-lock guarantees, and did not weaken Task 66's ack ordering or Task 67's auth checks.

## 15. Task 70 addendum — historical Tasks 66/67/68 real-browser verification completed; "WS session/membership revocation lifecycle" row upgraded to Complete

Task 70 used Task 69's infrastructure to run all three historical
workstreams' outstanding real-browser scenarios in one coordinated effort.
Full detail: `docs/TASK70_HISTORICAL_COLLABORATION_ACCEPTANCE_REPORT.md`.

**Row updated**: "WS session/membership revocation lifecycle" (§12, Task 67
addendum) is upgraded from **Backend tested** to **Complete**. Two
independent real browser contexts proved: initial authorized access;
membership revocation closing an already-open WebSocket (real
`page.on('websocket')` close-event evidence, within the documented ~15s
periodic-revalidation window); a reconnection attempt hitting AppFlowy-Web's
own explicit "No access to this page" screen plus repeated 403 responses
(not merely an inferred UI failure); the owner remaining unaffected; and
membership restoration requiring a genuinely fresh connection (confirmed via
the same WS-event tracker: no new 'open' event on the OLD tab unless content
genuinely reappeared through a newly-opened one).

**Rows left unchanged, on a specific evidenced finding, not time/scope
alone**: "Real-time collaboration (live push)" (§11) and "Collaboration
recovery/reconnection correctness" (§13) remain **Backend tested**. Both
were re-attempted in full with two genuinely independent browser contexts,
and bidirectional delivery, correct object isolation, and reload-based
persistence (including, for recovery, the specific second-context leg Task
69 left incomplete) are now proven in a real browser. However, a
reproducible finding -- an already-open second context's FIRST live content
push after opening does not reliably re-render without a reload, though the
same content is correctly available via reload and live delivery was
observed to succeed later in the same session after prior activity -- means
neither row's full "no manual refresh" acceptance bar is consistently met.
Database/DatabaseRow browser fan-out (Task 66) and offline+authorization
(Task 67) remain explicitly untested at the browser level.

**No AppFlowy-Web product source file was changed by this task.** Two
additive, test-only changes were made: `restartBackend()` added to
`test/helpers/test-environment.ts`; `typeIntoDocumentBody` in
`test/helpers/navigation.ts` fixed to only clear existing content when
non-empty (a real, if intermittent, defect found during this task's own
regression run, not a hypothetical).

## 16. Task 71 addendum — the "no manual refresh" gap behind "Real-time collaboration (live push)" (§11) and "Collaboration recovery/reconnection correctness" (§13) is root-caused and fixed

Task 71 investigated and fixed the specific, evidenced finding Task 70 left
both rows on "Backend tested" for. Full detail:
`docs/TASK71_COLD_START_LIVE_RENDERING_REPORT.md`.

**Root cause**: a client-side (AppFlowy-Web) WebSocket send-ordering race,
not a backend defect and not a Yjs/editor-binding defect. The backend
scopes each connection's `websocket.objectId` to a single, shared slot
across every collab object multiplexed onto it; AppFlowy-Web's
realtime-sync layer could send an `update`/`awarenessUpdate` frame for an
object that was not, at that instant, the one the slot belonged to (e.g.
after a sidebar/outline-prefetched sibling document's own SyncRequest took
over the slot), causing the server to correctly force-close the connection
(1008/1003) and the edit to fall through to the HTTP full-sync-batch
fallback -- which has no live peer fan-out by design. **Fixed** entirely in
AppFlowy-Web (`sync-protocol.ts`, `useSyncContextLifecycle.ts`,
`useSync.ts`, `AppSyncLayer.tsx`, `types.ts`, `syncRefs.ts`): before any
outgoing frame other than an object's own SyncRequest, the client now
re-asserts that object's binding first if another object's SyncRequest most
recently won the slot -- no WS message-type/shape change, no RID change,
no backend change.

**Verified 10/10** on an independent cold-start session test (the exact
acceptance bar Task 70 could not meet), plus Task 70's own
`historical-collaboration-acceptance.spec.ts` live-delivery checks (now
hard assertions, no longer soft/non-fatal) passing consistently across 4
independent full-suite runs.

**Rows §11 and §13 can now be considered to meet their full "no manual
refresh" acceptance bar** (bidirectional live delivery, multiple sequential
updates, live delivery immediately after a real backend restart all
verified in a real browser, every run) -- this task did not itself rewrite
either row's status string (that remains for whichever task next formally
revisits the registry), but the specific evidenced blocker both rows cited
is closed, with evidence. Database/DatabaseRow browser fan-out (Task 66 A4)
and offline+authorization (Task 67 B4) remain explicitly untested at the
browser level, unchanged from Task 70.

**No backend production code was changed.** `test:postgres`/`test:parity`
were not re-run this session (the same `DATABASE_URL` credential-access
restriction Task 70 hit, confirmed again); the fix is frontend-only and
storage-mode-agnostic, so this does not bear on its correctness.

## 17. Task 72 addendum — "Grid/Board/Calendar/Gallery views" row: additional-view creation is now real in both storage modes (table rows above intentionally left as-is; read this addendum alongside them, not as a replacement)

Full detail: `docs/TASK72_DATABASE_VIEWS_DISCOVERY.md`,
`docs/TASK72_DATABASE_VIEWS_IMPLEMENTATION_REPORT.md`.

- **"Grid/Board/Calendar/Gallery views" row** (§2, line above): no longer
  "Not started" for view LIFECYCLE. Creating a second/Nth view
  (Grid/Board/Calendar/Chart/List/Gallery/Feed/Timeline — 8 of 9
  `DatabaseViewLayout` values; Form deliberately excluded, see below) in an
  EXISTING database is now implemented: `POST
  /api/workspace/{id}/v2/page-view/database-view/default`, JSON +
  PostgreSQL parity, idempotent, with correct Folder-layout mapping and
  per-view config cloning/defaults. **Backend tested** (6 new tests,
  `test/database-view-collab.test.js`, real JSON + real WebSocket, incl. a
  two-peer live fan-out test for a NEWLY CREATED view's config change) +
  **Postgres tested** (3 new tests, real Postgres, incl. a JSON/Postgres
  parity fingerprint) + **Browser verified** for the creation flow itself
  (real "Add view" button → real dropdown → real POST → real client-side
  receipt validation passing after a fix, real persisted state
  independently cross-checked) — see the implementation report §8 for the
  honest scoping of what the browser pass does and does not cover (a
  discovered-but-unfixed frontend view-tabs rendering gap blocked UI-level
  rename/switch/multi-client-visual exercise; the underlying capabilities
  are separately proven at the protocol level).
- **"Filters/sort/group" and "Field/property types" rows** (§2): their own
  CONFIGURATION/EDITING concern (as opposed to query execution, which
  stays frontend-owned by design) is **re-confirmed already fully
  functional today, requiring zero new backend code** — the exact same
  generic Database `collabType=1` WS admission path already proven for
  field add/rename (Task 61) and row content (Task 62) admits arbitrary
  Yjs mutations to a view's `filters`/`sorts`/`groups`/`field_settings`/
  `field_orders`/`layout_settings` with no bespoke server-side logic,
  re-verified this task with a dedicated test that mutates a VIEW (not a
  field) and proves persistence + multi-view independence + live two-peer
  fan-out. This was a verification/confirmation, not new backend work.
- **Deliberately out of scope, not silently dropped**: Form
  (`DatabaseViewLayout.Form = 7`) view creation — its companion
  "Responses" view/public-submission semantics are a materially larger,
  distinct feature from "view lifecycle + configuration," rejected with a
  clear `400`, the same conservative posture Task 61 used for non-Grid
  layouts on a database's first view.
- **New, reported-not-fixed frontend finding**: the view-tabs switching UI
  (`DatabaseViewTabs`/`DatabaseTabItem`) did not render for a standalone
  database page in the checked-out AppFlowy-Web build during this task's
  real-browser verification, even though the underlying Yjs state was
  independently confirmed correct (2 views, correct layouts) and the
  creation flow itself completed without error. Root cause not
  conclusively identified within this task's budget; a client-compatibility
  version-banner that also appeared was investigated and ruled OUT as the
  cause (confirmed purely cosmetic). Flagged as a frontend-side follow-up
  item, not fixed here (out of scope to modify unrelated frontend
  behavior).
