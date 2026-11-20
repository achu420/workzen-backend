# Task 72 — Database views discovery report (Phase 1)

Read-only discovery, re-verified this task against the CURRENT state of both repos (not assumed from Tasks 60/61's reports, though both are corroborated). Evidence classes used throughout: **confirmed (current backend source)**, **confirmed (current frontend source)**, **confirmed (automated test, this task)**, **confirmed (upstream/frontend's own opt-in interop test)**, or **recommendation**.

## 0. Executive summary

AppFlowy-Web already has a deep, real (not stubbed) implementation of database view configuration — names, layout/type, field visibility/ordering, filters, sorts, grouping, layout-specific settings — and ALL of it is expressed as ordinary Yjs mutations on the SAME `Database` collab object (`collabType=1`) that Task 61 already wired real-time WS admission for. Task 61's generic admission path (proven in Task 61's own tests to admit arbitrary field add/rename with zero bespoke server code) extends to view-config mutations with equally zero bespoke server code, because the admission path has no awareness of what changed inside the Yjs document — it validates/persists/acks/fans-out an opaque Yjs diff for one `object_id`, regardless of whether that diff represents a field rename, a filter addition, a view rename, or a group reorder. This was re-confirmed this task with a new automated test (`test/database-view-collab.test.js`) that mutates a VIEW's `filters`/`groups` (not a field) over the same WS path and proves persistence, independence across two views, and live two-peer fan-out.

**The one confirmed, concrete backend gap**: creating an ADDITIONAL view inside an EXISTING database (the second/third/Nth view — e.g. "click + Add view → Board" on a database that already has a Grid view) has **no backend route at all**. This is not new: Task 60's original audit already flagged `POST .../v2/page-view/database-view/default` as "missing," and Task 61 explicitly recorded "multiple views per database: not implemented" as a known limitation (§8 of its report). Nothing in Tasks 62–71 touched this — they built DatabaseRow, Postgres parity, catalog/cold-fetch fixes, fan-out, security, recovery, E2E infra, and a WS-binding fix, none of which create a second view. Re-checking `server.js` directly this task (`grep` for `database-view`, `v2/page-view`) confirms the route is still absent as of this task's start.

Everything else investigated in Phase 1 — rename, delete, filters, sorts, grouping, field visibility/ordering, layout settings, multi-view independence of config, persistence across reload/restart, JSON/Postgres parity for existing Database state — was found to already work via existing infrastructure (generic Yjs admission, Task 66 fan-out, Task 71's binding fix, Task 63 Postgres parity, Task 68 reconnection). **Scope is accordingly narrow**: implement one new atomic-creation route (+ its storage-layer support in both JSON and Postgres modes), verify everything else continues to work once a second view actually exists to test against.

## 1. Current architecture (confirmed, current source)

### 1.1 Backend (`AppFlowy-Independent-Backend`)

- `server.js` implements real-time WS admission for `collabType=1` (Database) since Task 61: a per-connection `syncRequest`/`update`/`awarenessUpdate` branch structurally identical to the Document (`collabType=0`) branch — same manifest/ack framing, same persist-before-ack ordering (`store.acceptDatabaseCollabUpdate`), same peer fan-out loop keyed on `peer.objectId === databaseId` (confirmed at `server.js` ~2100-2158, unchanged by this task except for one new HTTP route).
- `database-document.js` builds the initial Yjs shape for a brand-new Database object (`createInitialDatabaseCollab`): one seeded primary RichText field, one inline Grid view with EVERY required key present as the correct, empty Y type (`filters`, `sorts`, `groups`, `calculations`: `Y.Array`; `layout_settings`, `field_settings`: `Y.Map`; `field_orders`, `row_orders`: `Y.Array` of plain `{id}`/`{id,height}` entries).
- `storage.js` / `postgres-storage.js` persist the Database object as one opaque Yjs-encoded blob per storage mode (`databaseCollabDocuments` table/collection), with a generic `preparePageCollabUpdate` validate/apply helper shared with Document — the SAME code path handles any Yjs diff for any of these object kinds; nothing in it inspects field/view semantics.
- Only TWO Database-related HTTP routes existed before this task: `POST .../v2/page-view/database/default` (create the database + its one primary view, Task 61) and `GET .../database/{id}/restore-state` (always "no restore has happened," Task 61). `GET .../database` (workspace catalog) was fixed in Task 64. No route existed for creating a SECOND view in an existing database.

### 1.2 Frontend (`AppFlowy-Web`) — real, reachable call paths traced (not assumed from filenames)

- **View creation UI is genuinely reachable**: `src/components/database/components/tabs/AddViewButton.tsx` renders a "+" button in the Grid/Board toolbar offering Grid, Board, Calendar, Timeline, Chart, Form builder, List, Gallery, Feed — all nine `DatabaseViewLayout` values. Selecting one calls `useAddDatabaseView()` (`src/application/database-yjs/dispatch.ts:2951`), which resolves the correct Folder parent/position and calls `createDefaultDatabaseView()` (`src/application/database-yjs/creation/create-default-view.ts`).
- `createDefaultDatabaseView()` is an atomic-creation client: it POSTs `{schema_version, request_id, database_restore_id, view:{database_id, view_id, parent_view_id, source_view_id, name, layout, embedded, responses_view_id, timezone_id}, position, icon, extra}` to `POST /api/workspace/{id}/v2/page-view/database-view/default` (`src/application/services/js-services/http/atomic-creation-api.ts:11`: `'database-view': 'database-view/default'`), then polls/reads back the resulting Database + Folder state until it observes the new view consistently — **the client never sends filter/sort/group/field-setting content itself**; it only sends identity + placement. This is confirmed directly by a frontend unit test's own assertion: `expect(JSON.stringify(options.request)).not.toMatch(/encoded_collab|doc_state|field_settings|layout_settings|filters|group_settings/)` (`default-database-view-creation.test.ts`).
- **The server therefore owns the new view's entire recipe** — exactly the same division of responsibility Task 61 already established for the FIRST view (`page-view/database/default`), just extended to the Nth view.
- A **legacy** route (`POST .../page-view/{viewId}/database-view`, `page-api.ts:createDatabaseView`) also exists in the frontend's HTTP client layer but has **no call site anywhere in reachable UI code** (confirmed by `grep` across `src/`: only its own definition file references it). Per this task's explicit instruction not to implement unreachable paths, this legacy route is correctly left unimplemented.
- **View configuration** (rename, filters, sorts, groups, field visibility/ordering, layout settings, delete) is implemented as **pure Yjs mutation + the pre-existing generic page-rename/trash routes**, confirmed by reading the actual dispatch code:
  - `useUpdateDatabaseView` (rename): `updatePage?.(viewId, payload)` (existing generic Folder-side page-rename, already implemented since early tasks) + `view.set('name', name)` (plain Yjs mutation, admitted generically).
  - `useDeleteView`: Folder-side trash (existing generic route) + `views.delete(viewId)` (plain Yjs mutation).
  - `useUpdateDatabaseLayout` (switch an EXISTING view's layout): entirely local Yjs mutation, including the client's OWN `generateBoardGroup()` fallback for Board — no server call except for Form/Chart, which that same function explicitly routes through "Add view" instead (`"Use Add view to create Form or Chart views"`), confirming Form/Chart creation-after-the-fact is not a separate server contract either.
  - Filters/sorts/grouping/field-settings editors throughout `dispatch.ts` (`dispatch/sort-filter.ts`, `dispatch/group.ts`, `dispatch/field.ts`): all plain `Y.Map`/`Y.Array` CRUD on the view's own sub-keys, synced via the existing generic WS/HTTP full-sync path. No REST endpoint exists or is called for any of this.
- **Frontend-only `FieldType` divergence** (values 15-19: Person/Rollup/CreatedBy/LastEditedBy/Formula) remains unresolved and **out of scope** for this task — it concerns cell/field semantics, not views, and Task 61 already correctly deferred it.

### 1.3 Upstream data model confirmation (re-checked, matches Task 60's finding)

Views are embedded substructures inside the Database collab doc's `views` map, not separate collab objects (`"there are no physical collab object for the database view"` — upstream comment, re-confirmed). Each view carries its own `row_orders`, `filters`, `sorts`, `groups`, `field_settings`, `field_orders`, `layout_settings` — all per-view, not per-database. This backend's `database-document.js` shape already matches this exactly (Task 61), and the Nth-view creation gap is purely "no route constructs a SECOND entry in this same map," not a data-model gap.

## 2. The confirmed gap, precisely specified

### 2.1 Contract (confirmed directly from AppFlowy-Web's own opt-in server-interop test)

`src/application/database-yjs/__tests__/default-database-view-creation.integration.test.ts` — gated behind `APPFLOWY_ATOMIC_INTEROP_FIXTURE` (an opt-in contract test against a real server, skipped by default, **not** part of the frontend's 805/805 unit-test baseline) — specifies, parametrized over ALL nine `DatabaseViewLayout` values (0-8):

- `POST /api/workspace/{id}/v2/page-view/database-view/default` with the request shape above; response `{result:{view_id}}` on first call, `{outcome:'already_applied'}` on an identical replay (same `request_id` + body).
- The new view's `layout` must equal the requested layout; its `filters`/`row_orders`/`field_settings` (Grid) must be **cloned from `source_view_id`** (not left empty) when one is given.
- For **Board** (layout=1) specifically: `groups` must be **non-empty**, with a real `field_id` (present in `database.fields`) and at least one nested group-column — explicitly required even when the database has only a non-groupable field, with the comment "Older Web renders only persisted groups. Do not use its new fallback... to make an incomplete server recipe pass" (i.e. this must be a server-side guarantee, not something the client's own lazy fallback is relied on to paper over).
- The Folder-side child page's `layout` must follow `FOLDER_LAYOUTS = [1,2,3,5,6,7,8,9,10]` (DatabaseViewLayout index → Folder ViewLayout value — same mapping Task 61 already uses for the first view, just not previously extracted into a reusable constant).
- For **Form** (layout=7) specifically: a second, companion Grid "Responses" view must also be created, with no stored cross-reference back to it anywhere in the Yjs shape (discoverable only via the Folder tree) — a materially different, larger feature (public-submission semantics) than plain view lifecycle/config.

### 2.2 Scope decision: Form (layout=7) excluded

Per the task's explicit instruction to flag — not silently implement — reachable-but-disproportionate scope, **Form view creation is deliberately rejected (400)** this task. Its "Responses" companion-view/public-submission semantics are a distinct, materially larger feature than "database view lifecycle + configuration" (the stated headline of this task) and are not needed to satisfy Scenarios A-E. All EIGHT other layouts (Grid, Board, Calendar, Chart, List, Gallery, Feed, Timeline) are implemented, since they require no additional server machinery beyond the generic "build a correctly-shaped view entry, optionally cloned from a source view" recipe, and are all genuinely reachable from the real `AddViewButton` UI.

### 2.3 Why this is a real, load-bearing gap (not inventable work)

Without this route, `AddViewButton`'s "Add view" action fails outright for every layout (confirmed: the frontend's own creation flow polls the Folder tree for up to 30s waiting for the new view's Folder+Database entries to appear, then throws) — this blocks Scenario A ("create another supported view") and, transitively, Scenario C (multi-view independence, which requires a second view to exist) and the config-persistence half of Scenario B for any view beyond the first.

## 3. Everything else: already works (verified, not assumed)

| Capability | Frontend mechanism | Backend requirement | Status |
|---|---|---|---|
| View rename | `updatePage()` (generic page-rename) + `view.set('name', ...)` | Existing generic routes + generic Yjs admission | **Already works** — no new code |
| View delete | Generic trash route + `views.delete(viewId)` | Existing generic routes + generic Yjs admission | **Already works** |
| Filters (single/multiple) | Pure Yjs `Y.Array` CRUD on `view.filters` | Generic Yjs admission | **Already works** — proven this task for a NEW view's filters, not just a field |
| Sorts (single/multiple) | Pure Yjs `Y.Array` CRUD on `view.sorts` | Generic Yjs admission | **Already works** (same mechanism, not independently re-tested since structurally identical to filters) |
| Grouping | Pure Yjs CRUD on `view.groups`, client-computed default via `generateBoardGroup()` for a layout SWITCH | Generic Yjs admission (+ this task's server-side default for CREATION) | **Already works** for mutation; creation-time default was the one piece needing new server code (§2.1) |
| Field visibility/ordering (per view) | Pure Yjs CRUD on `view.field_settings`/`view.field_orders` | Generic Yjs admission | **Already works** |
| Layout settings (Calendar/Gallery/Board/List/Timeline-specific) | Pure Yjs CRUD on `view.layout_settings` | Generic Yjs admission | **Already works** (left as empty `Y.Map` at creation, same pattern Task 61 established for filters/sorts) |
| Multi-view independence | Each view is its own `Y.Map` entry; no shared sub-structure between views | None (data-model property) | **Already true** — proven this task (mutating one view's `groups` leaves the sibling view's `groups`/`filters` untouched) |
| Persistence across reload/restart | Existing `databaseCollabDocuments`/`database_collab_documents` persistence | None | **Already works** — proven this task for a database with TWO views and independently-configured content |
| JSON/Postgres parity for Database state | Existing parallel storage implementations | None for existing state | **Already works** (unaffected by this task except for the new route, see §4) |
| Live collaboration fan-out for a view-config change | Existing per-`object_id` peer broadcast (Task 66), WS-binding fix (Task 71, frontend) | None | **Already works** — proven this task with a NEW view's rename, not a field, fanning out live to an already-connected peer with matching `messageId` |

## 4. Backend/Postgres/collaboration behavior for the ONE new capability (view creation)

- **Not** a query/filter/sort/group computation — the server only decides the new view's STARTING configuration (clone-from-source or empty-of-correct-type), never evaluates or renders anything. This stays inside the architecture boundary the task brief sets ("query execution/rendering stays the frontend's responsibility").
- **Not** a new collab object, protocol message shape, or fan-out path — it is one more HTTP atomic-creation route (same envelope/idempotency convention as `page-view/database/default` and `v2/database/{id}/row/default`) that mutates the EXISTING Database object's `views` map in place and adds one ordinary Folder-tree page row, through the EXISTING `store.*` pattern.
- **One pre-existing architectural characteristic this surfaced, not introduced by this task**: HTTP atomic-creation routes (database creation, row creation, and now view creation) do **not** themselves push a live WS fan-out frame to already-connected peers — only WS-originated `update` messages do. A peer with the database already open will see a newly-created ROW or VIEW only after its next resync/reconnect, not instantly. This is a pre-existing trait (confirmed identical for Task 62's row creation, re-checked this task: no fan-out code exists near its route either) — not a regression, and out of scope to change per the task's "don't change fan-out ordering" constraint. **Config changes to an existing view** (rename/filter/sort/group edits, the actual subject of Scenario D) go through the ordinary WS `update` path and DO fan out live, as proven in §3's table.

## 5. Recommended implementation scope (Phase 2 classification)

| Capability | Classification |
|---|---|
| Create an additional view (Grid/Board/Calendar/Chart/List/Gallery/Feed/Timeline) in an existing database | **Backend protocol/persistence gap — implement** |
| Create a Form view + companion Responses view | **Unsupported (out of scope)** — reject with a clear error, do not silently ignore |
| Rename/delete a view | Already supported (no change) |
| Filters/sorts/grouping/field visibility/ordering/layout settings content | Frontend-only responsibility, already synced generically (no change) |
| Multi-view independence | Already supported (data-model property, no change) |
| Live collaboration fan-out for config changes | Already supported (no change) |
| Live fan-out for the CREATION event itself (HTTP atomic-creation routes broadcasting to already-open peers) | Out of scope — pre-existing architectural trait shared with row creation, not touched |

No new query engine, no new collab protocol message, no new storage abstraction. JSON and Postgres both get the new route (parity requirement), following the exact `store.*`/transaction patterns Tasks 61-63 established.
