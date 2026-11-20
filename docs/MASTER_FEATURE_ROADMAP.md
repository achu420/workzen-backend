# Master feature roadmap (Task 58)

This consolidates the roadmap; it references task reports and `FEATURE_REGISTRY.md` rather than repeating their content. Candidate workstreams were evaluated, not assumed pre-ordered — the recommended sequence differs from the order they were listed in for evaluation.

## Recommended sequencing and why

1. **Milestone 1 — Collaboration/production hardening** (advisory lock, retention policy decision, multi-instance design decision). Cheapest, highest-leverage, de-risks everything built on top of it, and part of it (the advisory lock) is a known reproducible defect, not a feature gap.
2. **Milestone 2 — Database functionality** (the single largest product gap; frontend fully built and waiting).
3. **Milestone 3 — Real sharing/permissions** (second-largest gap; also frontend-ready; depends on an authz model decision that should be made alongside Milestone 2's schema work since both touch the same authorization checks).
4. **Milestone 4 — Files/attachments** (needed by both database row cells and document image blocks; blocked on a storage-backend decision).
5. **Milestone 5 — Search/productivity, notifications, comments** (valuable but not blocking; search specifically needs a scoped-down non-commercial design decision first).
6. **Milestone 6 — Templates/offline template library** (lower urgency; blocked on the still-unresolved "does an official template API exist" question).
7. **Milestone 7 — Integrations/AI** (deliberately last: highest risk of reintroducing a commercial/external dependency this project exists to avoid; must be optional and self-hosted-key-gated if built at all).
8. **Milestone 8 — Production hardening/deployment** (rate limiting, logging/observability, deployment docs) — some of this (rate limiting) is cheap enough to pull forward opportunistically, but it is sequenced last as a dedicated milestone because it is not blocking feature work the way Milestone 1's items are.

This differs from a naive "ship small infra fixes last" ordering because two specific items (advisory lock, rate limiting) are reclassified as near-term/opportunistic rather than deferred with the rest of hardening.

## Milestone 1 — Remaining collaboration/multi-instance reliability

- **Objective**: remove the one known reproducible defect (migration advisory lock) and make an explicit decision on multi-instance scope before more collab-adjacent features are built on the current single-process assumption.
- **User-visible outcome**: none directly (infrastructure); indirectly, fewer production incidents.
- **Backend work**: add `pg_advisory_lock`/`pg_advisory_xact_lock` around `openPostgresStore`'s migration step; decide and (if in scope) prototype a shared-ordering mechanism for Rid allocation across instances.
- **Frontend work**: none.
- **DB/migration impact**: none beyond the lock itself (no schema change).
- **Dependencies**: none — this can start immediately.
- **Risks**: low for the lock fix; the multi-instance design decision itself could be large if scoped broadly — keep it to a decision document first, not an implementation, per this project's established "design before code" pattern (see Task 48's precedent).
- **Required tests**: a concurrency test proving two simultaneous `openPostgresStore` calls against a fresh database no longer deadlock.
- **Browser acceptance criteria**: n/a.
- **Completion criteria**: lock fix merged + regression green; multi-instance decision recorded in `ARCHITECTURE_OVERVIEW.md`.

## Milestone 2 — Complete database functionality

- **Objective**: replace the database-catalog stub with a real Grid/Board/Calendar data model and row/field CRUD, reusing the existing collab-admission/persistence pattern.
- **User-visible outcome**: users can create and use a real database page (Grid at minimum) instead of hitting an empty catalog.
- **Backend work**: design a new collab_type and row/field schema (likely Yjs-based per the existing `collab-database` convention the frontend already expects); row/field CRUD endpoints; filter/sort/group services; relation support (defer rollup — upstream itself has no native rollup field type, so this may not even be a real gap).
- **Frontend work**: largely already built (`src/components/database/*`); primarily wiring/integration and fixing any contract mismatches found along the way (same pattern as Task 57's "wire existing client to existing UI" work).
- **DB/migration impact**: new additive tables/collab storage, no changes to existing document tables.
- **Dependencies**: Milestone 1's advisory-lock fix should land first since this adds new migrations.
- **Risks**: High — largest net-new backend surface in the project; schema design mistakes are expensive to unwind later. Recommend starting with a Task-48-style discovery/design document (no implementation) before writing code, exactly as version history did.
- **Required tests**: JSON + Postgres backend tests per capability (creation, row CRUD, filter/sort/group), mirroring the version-history test pattern (unit → Postgres-runtime → browser).
- **Browser acceptance criteria**: create a Grid database via the real UI, add rows/fields, reload, confirm persistence — mirroring the document workflow's existing acceptance bar.
- **Completion criteria**: Grid view fully functional end-to-end (not Board/Calendar yet) with real browser verification; Board/Calendar as follow-up sub-milestones.
- **Suggested independently-verifiable sub-tasks**: (a) discovery/design doc; (b) backend row/field schema + CRUD, JSON mode only; (c) Postgres parity; (d) filter/sort/group; (e) frontend wiring/integration fixes; (f) browser verification.

### Task 60 addendum — Milestone 2 decomposed into 5 phases (supersedes this milestone's sequencing, not its intent)

Task 60 performed the discovery/design doc this milestone called for (sub-task (a) above) in much greater depth than this section anticipated — three parallel deep-dive passes (frontend, upstream Rust/collab data model, upstream collaboration protocol) found that "database functionality" is not one undifferentiated backend surface but a graph of linked Yjs collab objects upstream (`WorkspaceDatabase` catalog → `Database` object [fields+views+row-order only] → N independent `DatabaseRow` objects → lazily-created `Document`-type row-detail pages), and that the backend's WebSocket handler has no branch at all for `collabType` 1/3/4 (a protocol gap, not just missing REST routes). Full detail, including the three-option storage-architecture evaluation (Option B — hybrid relational+collaborative — recommended) and the complete repository-interface design, is in `docs/DATABASE_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`.

This milestone's original "(a)-(f)" sub-task list above is **superseded in sequencing** (not in intent — database functionality is still the right milestone to pursue next) by Task 60's five-phase breakdown:
- **Phase 1**: the `Database` collab object only (metadata + fields + one default Grid view), JSON mode, no rows, no Postgres parity, no WS wiring beyond the minimum to exercise it. Recommended as the next concrete implementation task — see the architecture doc §12.
- **Phase 1b**: Postgres parity for the Database object (ports Phase 1, following the Task 49B precedent of porting rather than redesigning).
- **Phase 2**: views — full CRUD, Grid-specific per-view settings (field visibility/column order/width/row height). Board/Calendar/Gallery/Form explicitly deferred (upstream only confirms Grid/Board/Calendar server-side layouts exist at all; Gallery/Form/Timeline/Chart are frontend-only concepts with no confirmed upstream server analog).
- **Phase 3**: rows and properties — real `DatabaseRow` (collab_type 4) objects, typed cells for the confirmed-upstream property set only, row-detail pages, stable ordering. This is the phase at which "Grid view fully functional end-to-end" (this milestone's original completion criterion) is actually met, not Phase 1.
- **Phase 4**: advanced — Board/Calendar, the query engine, Relation fields (deferred from Phase 3 — even upstream's own REST API excludes Relation as unsupported), CSV import, attachments (depends on Milestone 4's file-storage decision).
- **Phase 5**: collaboration/recovery hardening — row-deletion-vs-in-flight-edit fencing, database-restore-vs-row-state interaction, concurrency/offline fault-injection testing for database objects specifically (not assumed inherited from Document's test coverage).

**New open decision this milestone must resolve before Phase 3** (not previously known): the frontend's own `FieldType` enum includes `Rollup`, `CreatedBy`, `LastEditedBy`, `Person`, and `Formula` (values 15-19) with substantial dedicated test coverage, none of which have any upstream Rust-side counterpart (upstream confirmed to have exactly 15 field types, values 0-14, with no native Rollup and no CreatedBy/LastEditedBy at all). Whether to build these as backend-original extensions or treat them as frontend-only/client-computed is now an explicit decision, not a discovered gap-fill — see the architecture doc §11 for the full six-item open-decisions list.

### Task 61 addendum — Phase 1 implemented and real-browser-verified; Phase 1b/2 are now the next steps

Task 61 implemented Task 60's recommended Phase 1 (the `Database` collab object, metadata + fields + one default Grid view, JSON mode, no rows) in full, with real-browser verification through the existing AppFlowy-Web frontend (not just REST/WS-level tests). See `docs/APPFLOWY_TASK61_REPORT.md` for complete detail; summary below.

- **What's now real**: WebSocket admission for `collabType=1` (additive, mirrors the Document branch); a default-Grid-database atomic-creation REST route; JSON-mode persistence (new `databaseCollabDocuments`/`databaseCollabUpdates` in `storage.js`, same persist-before-ack/Rid-allocation/idempotency pattern as Document); add-field and rename-field support — the last of these required **no new server code at all**, since AppFlowy-Web's existing `dispatch.ts` performs them as ordinary Yjs CRDT updates over the same generic WebSocket protocol Document edits already use.
- **Two UI-blocking gaps found and fixed, only discoverable by actually driving a real browser**: the pre-existing collaboration-permission endpoint (`GET .../collab/{id}/permission?collab_type=`) only recognized Document pages. Extended additively to also recognize (a) a **space** id at `collab_type=0` (the sidebar's only entry point for picking a non-Document layout is gated on this), and (b) a **Database** id at `collab_type=1` (the Grid view's own field-menu UI is gated on this). Without both, Grid database creation was unreachable through the real UI even though the REST/WS contract itself was already correct — direct evidence that REST-contract correctness alone is not sufficient acceptance evidence for a UI-facing feature.
- **Still not done** (unchanged from Task 60's phase breakdown): rows, Postgres parity for the Database object (Phase 1b), additional views/Grid-settings (Phase 2), Board/Calendar/relations/query-engine (Phase 4), collaboration/recovery hardening specific to database objects (Phase 5). The FieldType 15-19 (Person/Rollup/CreatedBy/LastEditedBy/Formula) open decision from the Task 60 addendum above remains **unresolved** — Task 61 only ever created/edited `RichText` (0) fields, matching exactly what the real default-Grid and add-property UI actions use, and deliberately did not attempt to resolve the broader divergence.
- **Newly found, not previously tracked**: `GET /api/workspace/{id}/database` (the workspace-wide database-listing REST stub) remains the pre-existing empty-array stub — confirmed *not* required for Phase 1's create/discover/reopen workflow (discoverability runs through the pre-existing Folder-tree mechanism instead), but any future feature that reads this listing directly (e.g. a relation-field database picker, in scope for Phase 4) will need it implemented. `POST .../database/{id}/blob/diff` 404s (a protobuf blob-diff endpoint, unrelated to the core Yjs sync path) — confirmed non-blocking for Phase 1, relevance to later row/cell work unknown.
- **Next recommended step**: Phase 1b (Postgres parity for the Database object) or Phase 2 (views/Grid-settings), per Task 60's original ordering — **not** Phase 3 (rows) directly, since rows depend on DatabaseRow collab objects this task explicitly did not build.

### Task 62 addendum — minimum viable DatabaseRow lifecycle implemented (begins Phase 3, scoped to the minimum workflow)

Task 62 implemented the minimum viable slice of Phase 3 (DatabaseRow objects, row creation/ordering, the primary-field cell-edit path) ahead of Phase 1b/2 in strict sequencing terms, because the task brief specifically requested it next; this is a deliberate, explicit deviation from the "Phase 1b or Phase 2 next" recommendation above, not an accidental skip — recorded here so the historical reasoning stays intact. See `docs/TASK62_DATABASE_ROW_CONTRACT_AND_IMPLEMENTATION_REPORT.md` for complete detail; summary below.

- **What's now real**: a new atomic `POST .../v2/database/{databaseId}/row/default` REST route (row creation, discovered by tracing `createCloudRow()`/`prepareDefaultRowRequest()` in AppFlowy-Web's `create-row.ts` — not guessed from endpoint-naming conventions); WebSocket admission for `collabType=4` (additive, mirrors Task 61's Database branch exactly); JSON-mode persistence (new `databaseRowCollabDocuments`/`databaseRowCollabUpdates`/`atomicRowCreationRequests` in `storage.js`, same persist-before-ack/Rid-allocation/idempotency pattern); row-order insertion (`start`/`end`/`before`/`after`) performed atomically with row creation in one transaction, since the frontend's own `assertMembership()` requires both to be visible together; generic cell editing (writing a value into the primary "Name" field) — this last one required **no new server code at all**, exactly like Task 61's field add/rename finding, confirming the same pattern generalizes to row/cell content.
- **Row ordering/deletion/detail-page questions resolved, not left open**: `row_orders` lives on the parent Database's Y.Doc (per-view), never on the row itself; Phase 1's single-view-per-database constraint means multi-view ordering fan-out is unreachable and was not implemented. Soft-delete/restore and "remove from view" are **already fully functional today via Task 61's existing generic Database WS admission path** — confirmed, not assumed, that the real frontend never issues any server call to hard-delete a DatabaseRow collab object, so hard deletion is correctly and permanently out of scope. A row's detail/"peek" page is a separate, lazily-created `CollabType.Document` object (deterministic `uuidv5('document_id', rowId)` id) — confirmed not required by plain row creation, and not touched by this task.
- **One new, non-blocking, frontend-side observation found during real-browser verification, documented not silently worked around**: a pre-existing (unmodified) frontend `sync-outbox` IndexedDB write fails with a Dexie `NotFoundError` in the headless-Chromium test harness when applying the row-creation Database diff locally; the frontend's own existing fallback path handled it correctly in every run (data integrity was never compromised, confirmed by reload verification). See the full report §6b.
- **Still not done**: row templates/duplication (a separate, more advanced endpoint, confirmed distinct from `/row/default`), row-detail Document page creation/management, Postgres parity for DatabaseRow storage, multi-view row ordering, non-primary/typed-field cell editing beyond the generic-RichText path this task specifically verified (other FieldTypes' cell-data shapes were not individually re-verified this task).
- **Next recommended step**: Phase 1b (Postgres parity for both the Database and DatabaseRow objects now that both exist in JSON mode) is the most natural next step given this task's own schema was deliberately shaped as an obvious Postgres-mirror target; alternatively, row-detail Document page support if a concrete future feature's acceptance criteria require it (none of Task 61/62's own workflows did).

### Task 63 addendum — Phase 1b (PostgreSQL parity for Database and DatabaseRow) complete

Task 63 implemented the Phase 1b work Task 62's addendum recommended: full PostgreSQL storage parity for both the Database (Task 61) and DatabaseRow (Task 62) collab objects, including the atomic row-creation transaction's concurrency/rollback correctness. See `docs/TASK63_POSTGRES_DATABASE_AND_DATABASE_ROW_PARITY_REPORT.md` for complete detail; summary below.

- **What's now real**: migration `007_database_and_database_row_collab.sql` adds the Postgres tables mirroring JSON's `databaseCollabDocuments`/`databaseCollabUpdates`/`databaseRowCollabDocuments`/`databaseRowCollabUpdates`/`atomicRowCreationRequests`; `postgres-storage.js` implements `createAtomicDatabasePage`/`getDatabaseCollab`/`acceptDatabaseCollabUpdate`/`createAtomicDatabaseRow`/`getDatabaseRowCollab`/`acceptDatabaseRowCollabUpdate`; a new narrow `PostgresGenericObjectCollabRepository` reuses the already-generic `preparePageCollabUpdate` and the one shared RID allocator for both object kinds (no second RID/dedup system). The atomic row-creation transaction (idempotency claim → per-Database `FOR UPDATE` lock → Yjs mutation → row insert → parent-state update → receipt fill-in → commit) was proven via real fault injection at six checkpoints to roll back completely with no partial state, and under true concurrency (independent rows, identical-request races, conflicting-request-id races) to lose nothing and never duplicate.
- **A pre-existing defect, found and fixed as a necessary precondition, not scope creep**: `pages.parent_view_id`'s foreign key only ever allowed a space as a page's parent (migration 003); a Database's primary-view page is parented by its own container page (a page, not a space), so **Database creation could never have worked in Postgres mode at all** before this task fixed it. Also fixed: `pages.layout` was never selected/returned in Postgres mode at all, so every Postgres-mode page (not just Databases) rendered with the wrong Folder layout.
- **Two findings corrected an assumption in this task's own brief, with evidence**: (1) a **pre-existing, storage-mode-agnostic** Folder/UI gap — the workspace's Database-catalog route (`GET .../database`) is a hardcoded `[]` stub in both storage modes, which blocks opening a Database from any session that did not itself just create it (a fresh login, or a second real user's first open) — out of this task's storage-parity scope, documented with full evidence, not fixed. (2) This backend's real-time collaboration model broadcasts **nothing** to other connected peers except cursor/presence (`awarenessUpdate`) — not Document, Database, or DatabaseRow content edits, and not atomic row creation; every write is durable immediately but only observed by a peer on its own next `SyncRequest`. Task 62's "REST row creation doesn't broadcast" finding is the general rule for every write path in this system, not a special case.
- **Still not done**: the Database-catalog stub fix (see "Next recommended step"), everything already listed as out of scope by Tasks 61/62 (row templates, multi-view ordering, row-detail Document lifecycle, advanced field types, etc.) remains out of scope and untouched.
- **Next recommended step**: fix `GET /api/workspace/{id}/database` to return the workspace's real Database list (both storage modes already expose everything needed — list pages where `extra.is_database_container === true`). This is the actual blocker for reopening a Database after a fresh login and for genuine two-browser-context multi-client verification; it is a Folder/UI-completeness fix, not a storage task, and should be scoped/evidenced on its own before further Database feature work (Phase 2 views/Grid-settings) is built on top of it.

## Milestone 3 — Real sharing/permission enforcement

- **Objective**: replace the sharing-view stub with real per-document grants, invitations, and access revocation.
- **User-visible outcome**: a user can share a document with another workspace member and have that enforced.
- **Backend work**: authz model decision (role differentiation vs. per-doc ACL vs. both); invitation data model; grant/revoke endpoints; extend WS/HTTP authorization checks to consult the new grant model.
- **Frontend work**: largely already built (`SharePanel.tsx` et al.); wiring.
- **DB/migration impact**: new additive tables (invitations, grants); no destructive changes expected, but every existing document/workspace read/write authorization check needs to be revisited and tested against the new model to avoid regressing the current membership-only checks.
- **Dependencies**: should follow Milestone 2's schema work closely in time (both touch authorization plumbing) but is not strictly blocked by it — could be parallelized with a different task-runner.
- **Risks**: High — authorization regressions are a security risk, not just a feature gap; every change here needs explicit "unauthorized access still rejected" regression tests, matching this project's existing convention (e.g. Task 40's cross-workspace-denial tests).
- **Required tests**: grant/revoke CRUD; unauthorized-access-still-rejected regression for every existing route; WS authorization extension tests.
- **Browser acceptance criteria**: user A shares a doc with user B via the real Share UI; user B (separate browser session) can open it; revoke removes B's access, verified live.
- **Completion criteria**: per-document sharing works end-to-end with real two-user browser verification.

## Milestone 4 — Files/attachments

- **Objective**: real file/image upload and storage.
- **User-visible outcome**: images/files can be attached to documents and rows and persist.
- **Backend work**: choose and implement a storage backend (local disk with a size-capped directory is the simplest self-hosted-safe default; S3/MinIO-compatible as a configurable alternative); upload/download/delete endpoints; multipart upload for large files.
- **Frontend work**: already built (`UploadImage.tsx`, `file-api.ts`); wiring to the new endpoints.
- **DB/migration impact**: new metadata table (file ownership, size, mime type, workspace scoping for quota).
- **Dependencies**: storage-backend decision (Milestone 1-adjacent open design decision).
- **Risks**: Medium — disk-space/quota management if local-disk storage is chosen; path-traversal/content-type validation security risk if done carelessly.
- **Required tests**: upload/download/delete CRUD; quota enforcement; malicious-filename/path-traversal rejection.
- **Browser acceptance criteria**: upload an image into a document via the real UI, reload, image still renders.
- **Completion criteria**: file upload works end-to-end with real browser verification; database row file-cell attachment as a follow-up.

## Milestone 5 — Search/productivity (+ notifications, comments)

- **Objective**: a self-hosted-appropriate search (likely Postgres full-text, not vector/embedding-based) plus notifications and comments.
- **User-visible outcome**: users can search documents; see notifications; comment on pages/rows.
- **Backend work**: Postgres `tsvector`-based search index and query endpoint (explicitly scoped down from upstream's embedding-based hybrid search to avoid an external AI-key dependency); notification data model + endpoints; comment data model + endpoints (page/inline/row — three separate upstream subsystems, can be sequenced independently).
- **Frontend work**: already built for all three; wiring.
- **DB/migration impact**: new additive tables/indices.
- **Dependencies**: none blocking; can proceed independent of Milestones 2-4.
- **Risks**: Low-Medium; main risk is scope creep toward full semantic search, which should be explicitly rejected per the product's non-commercial-dependency constraint unless a later product decision says otherwise.
- **Required tests**: search relevance/ordering on a fixture corpus; notification CRUD; comment CRUD with authorization checks.
- **Browser acceptance criteria**: search finds a known document by text; a notification appears after a triggering action; a comment posts and persists.
- **Completion criteria**: keyword search + notifications + comments all independently browser-verified.

## Milestone 6 — Templates/offline template library

- **Objective**: resolve the "does an official template API exist" unknown, then build whichever path is confirmed feasible.
- **User-visible outcome**: users can start a new document from a template.
- **Backend work**: contingent on the above decision — either (a) build a self-hosted template-center clone (matching upstream's own `template.rs` shape) seeded with a bundled static set, or (b) if a genuine public AppFlowy template API is later confirmed to exist, a sync job for it. **Do not build (b) speculatively.**
- **Frontend work**: already built (`as-template/`); wiring.
- **DB/migration impact**: new additive tables (templates, categories).
- **Dependencies**: Milestone 4 (templates typically carry file/image assets).
- **Risks**: Low, contingent on not inventing an unverified external integration.
- **Required tests**: template CRUD; "create from template" produces a correct document copy.
- **Browser acceptance criteria**: pick a template from the real UI, create a document from it, content matches the template.
- **Completion criteria**: at least a static/offline template library works end-to-end.

## Milestone 7 — Integrations/AI

- **Objective**: decide whether to build AI chat support at all, and if so, as a strictly optional, self-hosted-key-configurable feature.
- **User-visible outcome**: either AI chat works with a user-supplied API key, or the UI gracefully indicates it's unavailable (not a broken/hanging feature).
- **Backend work**: a thin, optional proxy to a user-configured external LLM API (never a bundled/required key); explicit absence-of-key handling.
- **Frontend work**: mostly already built; needs a "not configured" state if not already handled gracefully.
- **DB/migration impact**: minimal (API-key config storage, scoped per-workspace/admin, encrypted at rest).
- **Dependencies**: none technical; a product decision gate (must not become a de facto commercial dependency).
- **Risks**: High if done carelessly (data egress to a third party, accidental seat-limit-like gating reintroduced) — must be explicitly reviewed against the project's non-negotiable constraint before any code is written.
- **Required tests**: graceful-degradation-without-key test; no outbound call occurs unless a key is explicitly configured.
- **Browser acceptance criteria**: with no key configured, "Ask AI" clearly indicates unavailability rather than hanging or erroring unhelpfully.
- **Completion criteria**: explicit product sign-off that the design respects the non-commercial-dependency constraint, then implementation.

## Milestone 8 — Production hardening/deployment

- **Objective**: rate limiting, structured logging/observability, deployment docs, upgrade/rollback guidance.
- **User-visible outcome**: none directly; operational safety.
- **Backend work**: rate limiting (at minimum on `/api/auth/*`); structured logger; deployment/runbook docs.
- **Frontend work**: none.
- **DB/migration impact**: none.
- **Dependencies**: none — rate limiting in particular can be pulled forward opportunistically ahead of this milestone's formal slot if a future task has spare scope.
- **Risks**: Low technically; the risk is purely in deferring it too long while the system is internet-exposed.
- **Required tests**: rate-limit-triggers-at-threshold test; log output sanity.
- **Browser acceptance criteria**: n/a.
- **Completion criteria**: rate limiting + structured logging in place; deployment doc published.

## Recommended single next concrete development task

**Fix the `postgres-storage.js` migration advisory-lock gap** (Milestone 1, first sub-item): add `pg_advisory_lock`/`pg_advisory_xact_lock` around the migration-apply step in `openPostgresStore`, with a new regression test proving two concurrent opens against a fresh disposable database no longer deadlock, then remove the `--test-concurrency=1` workaround from `package.json`'s `test:postgres` script and confirm the suite still passes concurrently.

**Why this, over starting Milestone 2 (database) directly:**
- It is the only item in this entire assessment that is a confirmed, reproducible **defect** in already-shipped code, not a missing feature — fixing defects before building more on top of the affected code matches this project's own established pattern (e.g. Task 51/55 fixed CORS defects before further UI verification continued).
- It is small, independently verifiable, and low-risk — consistent with the project's demonstrated preference for small, test-first, non-destructive increments across all 57 prior tasks.
- It removes a concurrency hazard before Milestone 2 adds new migrations, which will increase the number of migration-apply events during development/testing and therefore the exposure to this exact race.
- It requires no upfront product/design decision, unlike every Milestone 2/3 item, so it can start immediately without blocking on anyone's sign-off.

**Status update (Task 59/60/61, preserved here rather than rewritten above so the historical reasoning stays intact)**: the advisory-lock item recommended above was fixed by Task 59. Task 60 then produced the Milestone 2 discovery/design doc and five-phase plan (see the Task 60 addendum above). Task 61 implemented Phase 1 of that plan in full, with real-browser verification (see the Task 61 addendum above and `docs/APPFLOWY_TASK61_REPORT.md`). **The current recommended single next concrete development task is Phase 1b (PostgreSQL parity for the Database collab object) or Phase 2 (additional database views / Grid-specific per-view settings)** — not a re-read of this now-superseded recommendation, and not Phase 3 (rows) directly.

**Status update (Task 62)**: Task 62 implemented the minimum viable slice of Phase 3 (DatabaseRow creation/ordering/the primary-cell-edit path) directly, per its own explicit brief, ahead of the Phase 1b/2 recommendation immediately above (see the Task 62 addendum above for full reasoning and scope). **The current recommended single next concrete development task is Phase 1b — PostgreSQL parity for both the Database and DatabaseRow collab objects**, since both now exist in JSON mode with deliberately Postgres-mirror-shaped schemas and neither has Postgres parity yet; Phase 2 (additional views/Grid-settings) remains a reasonable alternative if a future task's brief specifically calls for it instead.

**Status update (Task 63)**: Task 63 completed Phase 1b in full (see the Task 63 addendum above and `docs/TASK63_POSTGRES_DATABASE_AND_DATABASE_ROW_PARITY_REPORT.md`). **The current recommended single next concrete development task is fixing the `GET /api/workspace/{id}/database` Database-catalog stub** (a pre-existing, storage-mode-agnostic Folder/UI gap discovered during Task 63's real-browser verification — see that task's report for the exact evidence), ahead of Phase 2 (additional views/Grid-settings), since it blocks reopening any Database from a session that did not itself just create it and is the actual blocker for genuine multi-client real-browser verification of Database/DatabaseRow collaboration.

### Task 64 addendum — the fresh-session Database discovery-and-open gap is fixed, real-browser-verified in both storage modes

Task 64 completed the item Task 63 recommended above, and one more it masked. See `docs/TASK64_DATABASE_CATALOG_AND_FRESH_SESSION_NAVIGATION_REPORT.md` for complete detail; summary below.

- **The `GET /api/workspace/{id}/database` catalog stub is fixed** in both storage modes: a new, shared, storage-mode-agnostic derivation (`database-catalog.js`) lists containers (`extra.is_database_container === true`, valid `database_id`) and pairs each with its Folder-child primary view, exposed via a new `store.listWorkspaceDatabaseCatalog(workspaceId)` method implemented once in `storage.js` and once in `postgres-storage.js`, with real `offset`/`limit` pagination and `has_more` in the route.
- **A second, previously-masked gap was found and fixed in the same cold-open path**: `GET .../page-view/{viewId}` (AppFlowy-Web's generic cold-fetch route for ANY view layout with no local cache) required a Document collab object, which a Database page never has — a fatal 404/"Page not found" for any session that hadn't already cached the Database locally from its own creation. Fixed to serve the Database collab's bytes when the page represents a Database. Fixing the catalog alone would NOT have made the primary acceptance outcome ("a user who did not create a Database can open it") actually work; both fixes together did.
- **Real-browser verification (register/create/two-rows/reload, a completely independent second browser context as a second real workspace member discovering and opening the Database it never created, a real backend-process restart, and regression checks) PASSED all 4 scenarios in BOTH JSON and PostgreSQL storage modes** — the first time this has been achievable, since Task 63's exact bug previously made the critical fresh-session scenario impossible to even attempt.
- **The current recommended single next concrete development task is Phase 2 (additional database views / Grid-specific per-view settings)**, or, if a future task's brief specifically calls for it, beginning the real-time content-broadcast work this and Task 63 both found is entirely absent for every collab type (Document, Database, DatabaseRow) — deliberately deferred again by this task, per its own explicit brief.

### Task 65 addendum — real-time collaboration architecture decision produced (investigation only, awaiting approval, no implementation)

Task 65 picked up exactly the deferred item the Task 64 addendum above named ("the real-time content-broadcast work this and Task 63 both found is entirely absent") and investigated it rigorously, per its own explicit brief, **without implementing anything** (mandatory stop condition). Full detail: `docs/TASK65_REALTIME_COLLABORATION_ARCHITECTURE_DECISION.md`, `docs/TASK65_UPSTREAM_COLLABORATION_ARCHITECTURE_AUDIT.md`, `docs/TASK65_UPSTREAM_VS_INDEPENDENT_BACKEND_GAP_ANALYSIS.md`.

- **Upstream's actual mechanism was traced at the function level** (both of AppFlowy-Cloud's two parallel realtime stacks — the legacy per-object "collaboration group" design and the current workspace-scoped actor design that AppFlowy-Web's real client and this backend's `/ws/v2` route both actually use). Upstream's "other clients see the change" step is always a maintained, live roster of currently-connected sessions, iterated and pushed to (minus the origin) whenever an accepted update becomes visible — never a client-must-poll-again design — mediated through Redis specifically because upstream targets horizontal multi-instance scale-out, which this backend does not currently claim to support.
- **Root cause, verified not assumed**: the frontend already applies any incoming `Update` frame for an open object unconditionally (no frontend change needed); the wire message shape needed is identical to what this backend already sends as a self-ack (no protocol change needed); the actual gap is that this backend's own `websocketPeers` registry — already correctly iterated for the sibling `awarenessUpdate` message type at four call sites in `server.js` — was never extended to the `Update`-admission path for any collab type. A scoped, mechanical omission, not a missing architectural concept.
- **Recommended fix (Option B, NOT yet approved or implemented)**: extend the exact same peer-fanout pattern already proven correct for awareness to content updates, for Document/Database/DatabaseRow alike. No Redis, no second process, no new dependency, no protocol or frontend change. Adopting any part of upstream's realtime service/schema (Option A) was re-examined and re-rejected, including for the live v2 stack this task additionally traced (previously only the legacy stack had been examined, in Task 60.5) — it remains just as hard-coupled to Redis and to AppFlowy-Cloud's own auth/workspace schema.
- **The current recommended single next concrete development task, if this decision is approved, is implementing Option B exactly as scoped in the decision document's §7** (three additive peer-fanout call sites in `server.js`, no storage/auth/protocol changes, plus new two-peer live-broadcast tests and a real two-browser-context verification) — ahead of Phase 2 (additional views/Grid-settings), since live collaboration visibility is a more fundamental product expectation. If not approved, Phase 2 remains the fallback next step, unchanged from the Task 64 addendum above.

### Task 66 addendum — Option B implemented, all 6 JSON/Postgres × Document/Database/DatabaseRow combos protocol-verified (BACKEND TESTED; real-browser verification not yet passing)

Task 66 implemented exactly the item the Task 65 addendum above approved for implementation, nothing more. Full detail: `docs/TASK66_REALTIME_CONTENT_UPDATE_FANOUT_IMPLEMENTATION_REPORT.md`.

- **Live collaboration now works at the protocol level** for all three WS `Update`-admission paths (Document, Database, DatabaseRow), in both JSON and PostgreSQL storage modes: an already-connected second peer receives an accepted update live, with no new `SyncRequest`, and converges with the sender — proven by decode-and-apply, not merely "a frame was sent". Implementation is three small, additive blocks in `server.js`, each reusing the exact bytes already sent as the sender's own ack, fanned out via the same `websocketPeers` registry/filter the pre-existing awareness relay already used safely. No Redis, no new process, no protocol/frontend change. **Real-browser verification did not yet pass** (a Playwright/ViewModal UI-interaction issue in the test script, isolated via direct server-side state checks to rule out a backend cause — see the implementation report §10) — status is Backend tested, not Complete.
- **The atomic REST row-creation endpoint (Task 62/63/64) still does not fan out** — confirmed unchanged, a deliberate scope boundary (not silently expanded into); whether it should is recorded as a separate, undecided product/scope question.
- **One pre-existing test needed updating, not weakening**, as a direct and expected consequence of the new behavior (two sockets on the same object now legitimately see a third frame each); see the implementation report §9a for the full reasoning. No baseline regressed.
- **The current recommended single next concrete development task** is Phase 2 (additional database views/Grid-settings), unchanged from the Task 64 addendum's fallback recommendation — or, if a future task's brief specifically calls for it, deciding the REST-row-creation-fan-out question flagged above.

### Task 67 addendum — authorization/REST/WebSocket security audit and hardening; the session-revocation gap Task 66 deferred is now closed (BACKEND TESTED; real-browser revocation scenario Blocked)

Task 67 was a dedicated security audit and hardening task, not a feature task, and explicitly picked up the one item Task 66 flagged and deferred as "a separate, larger authorization redesign." Full detail: `docs/TASK67_AUTHORIZATION_AND_WEBSOCKET_SECURITY_REPORT.md`.

- **The REST/storage authorization surface was audited (~20 routes) and found already consistently well-hardened** — every workspace-scoped collab lookup is scoped at the storage layer (never global-by-id), and every nested-resource creation route independently re-verifies its supplied parent belongs to the caller's own workspace server-side. No vulnerability was found there; this confirms, rather than contradicts, the discipline every prior Database/DatabaseRow task (61-64) already applied.
- **The one confirmed real gap was precisely Task 66's own flagged item**: an idle, receive-only WS peer stayed eligible for fan-out indefinitely after its membership was revoked, since the pre-existing per-message revalidation only fires on that socket's own next send. Fixed with a bounded periodic re-validation timer in `server.js` (not a "general authorization redesign" — no new ACL framework, broker, or identity provider was introduced), closing and de-registering such a peer within a documented, configurable window, independent of inbound traffic, with no added per-fan-out-send DB query.
- **Role model decision gate resolved with evidence**: no currently-implemented operation enforces anything beyond plain membership; this task did not invent role semantics, per its own explicit instruction not to do so absent demonstrated need.
- **25 new tests added (23 JSON + 2 Postgres), all Passed, proving the fix at the real protocol level in both storage modes; zero regressions** across all 8 pre-existing suites.
- **Real-browser verification of the revocation scenario specifically is Blocked** (3/3 distinct attempts, the same pre-existing `ViewModal`/Slate-editor focus-interception class of flakiness Task 66 already documented) — the security property itself remains proven at the real, non-mocked protocol level; this is a UI-automation limitation, not a backend defect.
- **The current recommended single next concrete development task** remains Phase 2 (additional database views/Grid-settings) or the REST-row-creation-fan-out decision, unchanged from the Task 66 addendum above — this task's scope was security hardening, not new product surface, and it does not change that recommendation.

### Task 68 addendum — collaboration recovery/reconnection investigation (BACKEND TESTED; real-browser restart scenario Blocked)

Task 68 investigated network interruption, backend restart, lost-ack/duplicate-replay, concurrent reconnection, offline outbox, and authorization-during-recovery across Document/Database/DatabaseRow in both storage modes. Full detail: `docs/TASK68_COLLABORATION_RECOVERY_AND_RECONNECTION_REPORT.md`.

- **No recovery defect was found — the existing contract was already correct.** Genuine Yjs state-vector diff responses (never a forced full replace), server-side content-digest dedup (never double-applies a lost-ack resend or true duplicate, always returns the same Rid), and Rid/dedup durability across a real process restart (newly verified in both storage modes, not just a file-reopen) were all already in place from prior tasks (41/44/46/59/63/66/67). No backend or frontend source change was needed or made.
- **AppFlowy-Web's own pre-existing `sync-outbox/index.ts`** (durable IndexedDB outbox, bounded HTTP-fallback retry, terminal-vs-transient auth classification) already satisfies this task's offline-recovery requirements without modification.
- **New dedicated recovery test suites added, all Passed**: `test:collaboration-recovery` 8/8 (JSON), 3 new Postgres recovery tests folded into `test:postgres` (now 49/49) — real process restart, real ungraceful disconnect/reconnect, real concurrent submissions, real authorization-during-recovery, all using real Yjs documents and a real running server, no mocks. Zero regressions across all 9 pre-existing suites.
- **One mechanical test-harness fix** (in scope, not product code): `test/screens/DocumentScreen.ts` had a pre-existing syntax defect (premature class-closing brace) that would prevent the file from parsing; fixed with no logic change.
- **Real-browser verification of backend-restart recovery is Blocked** (3/3 distinct attempts) — the same pre-existing `ViewModal`/navigation-timing fragility Tasks 66 and 67 already independently documented, now confirmed a third time. The recovery logic itself remains proven at the real protocol level via a genuine process restart, independent of browser UI automation.

### Task 69 addendum — Playwright browser-automation reliability root-caused and fixed (Test infrastructure verified); Task 66/67/68 statuses unchanged

Task 69 was a dedicated test-infrastructure task, not a feature task: investigate and fix the recurring real-browser verification failures Tasks 66, 67, and 68 each independently hit. Full detail: `docs/TASK69_PLAYWRIGHT_E2E_INFRASTRUCTURE_REPORT.md`.

- **Root cause found with live DOM evidence, not assumed**: the sidebar quick-add-document flow opens new Documents in a real, full-viewport, pointer-events-active `ViewModal` dialog (`AppBusinessLayer.openPageModal`) while the underlying full page also mounts behind it — this single mechanism fully explains the "sticky header intercepts clicks" / "couldn't find this content" / "DOM focus silently rejected" symptoms independently reported by all three prior tasks. A second, previously-undocumented defect (a center-click on a near-empty Slate body editor not reliably moving keyboard focus into it) was also found and fixed.
- **New, reusable, condition-based navigation infrastructure** (`test/helpers/navigation.ts`, `test/helpers/test-environment.ts`, `test/e2e/core-navigation.spec.ts`, `npm run test:e2e`) replaces the previously non-functional `test/screens/*.ts` harness for new coverage (two genuine defects found there beyond what Task 68's syntax fix reached: a module-scope syntax error in `backend-manager.ts`, and a route scheme/editor-selector set that referenced things this app does not actually have).
- **Stability demonstrated, not claimed from one run**: the new 7-scenario E2E suite passed 35/35 (7×5) across 5 consecutive full runs against fresh disposable backend+frontend+users, 0 failures/flaky/leaked processes.
- **Bounded re-verification (3-attempt cap)**: Task 68's Scenario B core restart/persistence/re-edit path now passes via real browser automation using the new infrastructure — genuinely closing the specific gap Task 68 reported Blocked. Its bonus second-context live-delivery leg and Tasks 66/67's full original scenarios were not completed this task (time/scope, not a new blocker); **all three tasks' statuses are left exactly as they were**, per this task's own explicit status-discipline instruction.
- **No AppFlowy-Web product source file was changed.** Full backend regression re-run fresh, matching every documented baseline exactly.
- **The current recommended single next concrete step**, if a future task picks it up, is using this now-proven infrastructure to finish Task 68's second-context leg and Task 66/67's full historical re-verifications — ahead of new feature work, since it directly closes three tasks' outstanding acceptance criteria at comparatively low cost.
- **The current recommended single next concrete development task** is unchanged: Phase 2 (additional database views/Grid-settings) or the REST-row-creation-fan-out decision. This task's scope was recovery/reconnection hardening, not new product surface.

## Task 70 addendum — historical Tasks 66/67/68 real-browser verification completed (3 workstreams, independent); Task 67 upgraded to Complete, Tasks 66/68 remain Backend tested on a specific, evidenced finding

Task 70 used Task 69's infrastructure to run all three historical
workstreams' outstanding browser scenarios in one coordinated effort (none
blocked the others). Full detail: `docs/TASK70_HISTORICAL_COLLABORATION_ACCEPTANCE_REPORT.md`.

- **Task 67 is upgraded to Complete**: two independent real browser contexts
  proved initial authorized access, membership revocation closing an
  already-open WebSocket (real network-level close-event evidence, within
  the documented ~15s periodic-revalidation window), a reconnection attempt
  hitting AppFlowy-Web's own explicit "No access to this page" screen plus
  repeated 403 responses, the owner remaining unaffected, and membership
  restoration requiring a genuinely fresh connection (not the old socket
  silently reactivating).
- **Tasks 66 and 68 remain Backend tested, deliberately not upgraded**: a
  genuine, reproducible finding was isolated across multiple diagnostic
  attempts -- an already-open second browser context's FIRST live content
  push after opening does not reliably re-render without a reload (the same
  content IS correctly available via a reload immediately afterwards, and
  live delivery was observed to succeed later in the same session after
  prior reload/activity), so the "no manual refresh" bar both tasks'
  original acceptance criteria require is not consistently met. This is
  reported as a genuine product/frontend finding (not fixed under this task,
  per its own scope boundary), not a test defect.
- **Database/DatabaseRow browser fan-out (Task 66) and offline+authorization
  (Task 67) remain explicitly NOT TESTED** at the browser level, reported as
  limitations rather than silently assumed covered by adjacent Document-level
  evidence.
- Two test-infrastructure root causes were found and fixed (additive only):
  Playwright restarts its worker process (re-running `beforeAll`) after any
  failing test in a file, which silently invalidates a deliberately-chained
  multi-scenario design unless a known-blocked check is recorded as a
  non-fatal annotation rather than a hard assertion; and the shared
  `typeIntoDocumentBody` helper's replace-not-append semantics wiped earlier
  markers when reused twice on the same document (fixed with an additive
  `appendIntoDocumentBody` helper).
- Full regression matches every documented baseline exactly (Postgres suites
  not re-run this session -- a permission-layer restriction blocked reading
  `DATABASE_URL`, reported rather than worked around). No AppFlowy-Web
  product source file was changed.
- **The current recommended single next concrete development task is
  unchanged**: Phase 2 (additional database views/Grid-settings) or the
  REST-row-creation-fan-out decision. If a future task instead continues
  this thread, the highest-value next step is root-causing the first-push
  live-render gap in AppFlowy-Web's own Yjs/editor binding (frontend source,
  out of this backend-focused task's scope) rather than re-attempting
  browser verification with the same infrastructure.

## Task 71 addendum — cold-start live-rendering root cause found and fixed in AppFlowy-Web (frontend); Tasks 66/68 can now be considered to meet their "no manual refresh" bar

Task 71 picked up exactly the thread Task 70 left for a future task:
root-causing the first-push live-render gap. Full detail:
`docs/TASK71_COLD_START_LIVE_RENDERING_REPORT.md`.

- **The real root cause was one layer earlier than hypothesized, and on the
  SENDER's side, not the receiver's.** Live instrumentation (WS frame
  listeners, Yjs doc/observer hooks, console tracing) proved the receiving
  browser's WebSocket never received the content-update frame at all in the
  failing runs — ruling out the originally-suspected Yjs-observer/editor-
  binding/React-render layers entirely. The actual defect: AppFlowy-Web's
  realtime-sync layer sends `update`/`awarenessUpdate` WebSocket frames
  without first guaranteeing the connection's single, server-side
  `websocket.objectId` binding slot (shared across every collab object
  multiplexed onto one socket -- Document, Database, DatabaseRow, inline-
  comment anchors, etc.) still belongs to that object. A sidebar/outline-
  prefetched sibling document's own SyncRequest can silently "steal" the
  slot; the next edit for the original document then gets force-closed by
  the server's own (correct) protocol enforcement (code 1008/1003), and
  only reaches the backend ~10s later via the HTTP `collab_full_sync_batch`
  fallback -- which, by design, is never fanned out live to other
  connected peers (confirmed by reading `server.js`: that endpoint calls
  the same persistence function the WebSocket path uses, which is why
  reload always worked, but has no `websocketPeers` broadcast loop at all).
- **Fix is frontend-only, minimal, and reuses the existing bind mechanism**:
  a "re-assert this object's own SyncRequest immediately before any other
  outgoing frame if another object's SyncRequest most recently won the
  slot" discipline, added at the single existing `context.emit` choke point
  (`AppFlowy-Web/src/components/ws/sync/useSyncContextLifecycle.ts`) plus
  one additional call site for the persistent outbox's direct-to-socket
  realtime send (`AppSyncLayer.tsx`). No WS message-type/shape change, no
  RID change, no backend change (temporary backend debug logging used only
  to investigate was added and then fully removed).
- **Verified 10/10** on the mandated independent cold-start session test,
  plus Task 70's own `historical-collaboration-acceptance.spec.ts` live-
  delivery checks (A1, A2, A3, B1, C1, C3) -- previously soft, non-fatal
  "live-delivery-BLOCKED" annotations precisely because this defect made
  them unreliable -- are now hard assertions, passing consistently across 4
  independent full-suite runs.
- **Full regression unchanged**: every backend suite re-run fresh and
  matched baseline; `test:postgres`/`test:parity` not re-run this session
  (the same "Credential Materialization" permission denial Task 70 hit,
  confirmed again rather than assumed) -- the fix is storage-mode-agnostic
  (frontend-only), so this does not bear on correctness. One pre-existing,
  unrelated flake (`B5. membership restoration requires a fresh
  connection`, already flagged intermittent by Task 70) was observed again
  under a different exact symptom and is not attributable to this fix.
- **This closes the specific, evidenced gap Tasks 66 and 68 were left
  "Backend tested" on.** Their own acceptance criteria did not otherwise
  require anything this task changed; a future task updating their status
  strings should cite this report plus the hardened
  `historical-collaboration-acceptance.spec.ts` evidence as the basis.
- **The current recommended single next concrete development task is
  unchanged**: Phase 2 (additional database views/Grid-settings) or the
  REST-row-creation-fan-out decision.

## Task 72 addendum — Phase 2 (additional database views) picked up and implemented; the recommendation this section has repeated since Task 64 is now satisfied

Task 72 investigated database view lifecycle/configuration end-to-end
(`docs/TASK72_DATABASE_VIEWS_DISCOVERY.md`,
`docs/TASK72_DATABASE_VIEWS_IMPLEMENTATION_REPORT.md`) and confirmed
exactly what this roadmap's repeated Phase-2 recommendation anticipated:
view CONFIGURATION (rename, filters, sorts, groups, field
visibility/ordering, layout settings) was already fully functional via
the existing generic Database WS admission path (Task 61) with zero
bespoke code, re-verified this task with new tests mutating a view's
`filters`/`groups` directly (not just fields). The one real gap --
creating an ADDITIONAL view in an existing database -- is now
implemented, in both JSON and PostgreSQL storage modes:
`POST /api/workspace/{id}/v2/page-view/database-view/default`, covering 8
of the 9 `DatabaseViewLayout` values (Form deliberately excluded, its
companion-view/public-submission semantics being a distinct, larger
feature). A real client-side contract bug (a missing receipt-field
requirement in AppFlowy-Web's own atomic-creation journal) was found via
real browser driving and fixed.

- **Regression**: full baseline suites all green (`npm test` 38/38,
  `test:database-collab` 13/13, `test:database-row-collab` 11/11,
  `test:database-catalog` 17/17, new `test:database-view-collab` 6/6,
  `test:realtime-fanout` 4/4, `test:security` 23/23,
  `test:collaboration-recovery` 8/8, `test:collab-conformance`
  6/0/2/5). Postgres was directly reachable this task (unlike Tasks
  70/71's sandbox restriction): `test:postgres` 52/52 (49 baseline + 3
  new), `test:parity` 2/2. Full `npx playwright test`: 18 passed / 1
  skipped / 1 failed (the already-known `B5` dev-server-contention flake,
  reconfirmed flaky in isolation, unrelated).
- **Real browser verification**: Scenario A (create a second view via the
  real "Add view" button) passed end-to-end, including the fix above. A
  genuine frontend-side rendering gap was found and reported, not fixed:
  the view-tabs switching UI did not render for a standalone database page
  in this checked-out frontend build, blocking UI-level exercise of
  rename/switch/multi-client-visual scenarios (the underlying capabilities
  remain proven at the real-WebSocket-protocol level instead). See the
  implementation report §10 for what a future investigation should check
  first.
- **The current recommended single next concrete development task**: the
  view-tabs rendering gap found above (§10 of the implementation report)
  if multi-view UI work continues; otherwise the REST-row-creation-fan-out
  decision this roadmap has also carried since Task 66, or Phase 3 (rows
  beyond the minimum viable lifecycle Task 62 already built, e.g. cell
  type coverage/relation fields) per Task 60's original phase plan.
