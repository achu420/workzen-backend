# Light MCP v1 - Architecture report (Phase 0 inspection + Phase 1 card service)

Status of this report: Phase 0 (inspection) complete. Phase 1 (`cards.js`) implemented and verified on JSON storage only.
**PostgreSQL is not verified by this phase** (see section 11).

> **Update after integration and acceptance (2026-11-13):** the statements below describe the state at the end of Phase 1 and are kept as written. Since then: the shared-file changes in section 10 were handled in the Integration phase (see the decision table in `LIGHT_MCP_IMPLEMENTATION_REPORT.md`), `broadcastCollabUpdate` and the real WebSocket delivery are done and tested, PostgreSQL parity was verified on a real PostgreSQL 16 (card service 30/30, live 6/6, e2e 11/11, full suite 484/484), and acceptance with a real browser and a real MCP client (MCP Inspector CLI) is recorded in `LIGHT_MCP_ACCEPTANCE_REPORT.md`. One interface mismatch found in acceptance (`group_field` vs `grouping_field` in the `get_database` text) is fixed. Files owned by this phase: `cards.js`, `test/cards-service.test.js`,
`test/cards-concurrency.test.js`, `test/helpers/cards-env.js`, this report. No shared file was edited.

Evidence classes used below: *static* (read the code), *real Yjs + JSON persistence* (tests run real Yjs documents through the real
store acceptance path on a real test server with JSON storage).

---

## 1. Repository and concurrent-work state (Phase 0)

| Item | Finding (static) |
|---|---|
| Backend `AppFlowy-Independent-Backend` | **Not a Git repository.** No Git status exists for it; "pre-existing changes" there cannot be listed by Git. Files that other work added/changed recently are listed below by modification time. |
| Web `AppFlowy-Web` | Git repo. At inspection: 59 modified, 37 untracked files (earlier this session: templates, multi-select, AI settings, card chat, agent-token panel, etc.). Untracked ones relevant here: `AISettingsPanel.tsx`, `AgentAccessPanel.tsx`, `agent-tokens-api.ts`, `agent-tokens.ts`, their tests. Nothing was modified by this phase. |
| Card-chat (concurrent) | Backend: `ai-card-chat.js`, `test/ai-card-chat.test.js`, changes in `ai-routes.js`/`ai-storage.js`; web card-chat UI. Not touched. |
| MCP protocol module (concurrent) | `mcp.js`, `mcp-tools.js`, `scripts/mcp-stdio-shim.mjs`, `test/mcp-*.test.js`, `test/helpers/mcp-test-kit.js`. They define their own `CardError` in `mcp-tools.js`; integration must import the one from `cards.js` (same codes, `details` field, `column_changed`/`order_changed` detail keys). |
| Postgres validation (concurrent) | Scratch cluster helpers under the session scratchpad `pg/`; recent edits to `postgres-storage.js` and `test/postgres-migration-lock.test.js`/`postgres-row-document.test.js`. Not touched; no Postgres run was started by this phase. |

## 2. Reuse targets - verified contracts (static)

All store methods below exist with the same names in `storage.js` (JSON) and `postgres-storage.js` (Postgres). Line numbers are current at writing.

| Target | Where | Real contract | How `cards.js` uses it |
|---|---|---|---|
| `store.listPages(ws)` | storage.js:400 | workspace-scoped page records incl. `is_trashed`, `extra`, `parent_view_id` | via `buildReadableIndex` |
| `store.listWorkspaceDatabaseCatalog(ws)` | storage.js:406 | `buildDatabaseCatalogFromPages`: container + first child only, **does not exclude trashed containers**, ignores extra views | **not used** (listing is built from `buildReadableIndex` + the Database collab so all views and trash/permission are honoured) |
| `buildReadableIndex(store, {id}, isReadableSpace)` | search-index.js:276 | walks page ancestry to a space; trashed page/ancestor => unreadable; `containers: Map(databaseId -> container page)` | database discovery and access check for every operation |
| `searchWorkspace(...)` | search-index.js:322 | ranked hits, `database_row_id`/`database_id` on row hits, needs `querySearchDocuments` | exported helper `createIndexRowCandidates`; candidates are **always re-verified** against live `row_orders` |
| `extractDatabaseSchema` | search-text.js:86 | fields map with option **names only** (no colours), types 3/4 only; `rowIds` union across views | **not used**: `cards.js` has its own decoder that keeps colours, all types, per-view order and group config |
| `store.getDatabaseCollab(ws, id)` | storage.js:874 | `{doc_state, state_vector, collab_version,...}` or null (workspace-scoped) | model read |
| `store.getDatabaseRowCollab(ws, id)` | storage.js:1401 | same shape, workspace-scoped (a row of another workspace is null) | card read, cross-workspace isolation |
| `store.acceptDatabaseRowCollabUpdate({workspaceId,rowId,flags,payload,beforeStateVector,...})` | storage.js:1422 | queue-serialised (`databaseRowCollabUpdateQueue`), `preparePageCollabUpdate` applies the diff on the stored state; rejects a diff whose before-vector is not covered (`MISSING_CAUSAL_STATE`), unresolved deps; **dedupes by payload digest** (`status:'duplicate'`); Postgres adds `CONCURRENT_UPDATE` (generation check) | every card cell write (diff recipe + retry on `CONCURRENT_UPDATE`) |
| `store.acceptDatabaseCollabUpdate(...)` | storage.js:887 | same contract for the Database doc | reorder, archive, restore |
| `store.createSeededDatabaseRow({workspaceId,databaseId,rowId,positionViewIds,position,height,rowState,rowStateVector,documentPage?,request})` | storage.js:1202 | one atomic `mutate`: inserts the row collab and a `{id,height}` entry into **every** `positionViewIds` view's `row_orders` (positions `start`/`end`/`after`/`before`), optionally a row-document page; ledger `seededRowCreationRequests[request_id]`; replay returns `already_applied` + stored `database_update`; mismatch => `REQUEST_ID_REUSED` | `create_card` |
| Seeded ledger semantics | storage.js:1211-1234, migration 011 | **key scope = `request_id` globally** (not per workspace); mismatch if workspace, `request_digest` or database differs; a replay is detected before any validation; row missing under an existing key => `ATOMIC_CREATION_INCOMPLETE` | idempotency design, section 7 |
| `deriveUuid(requestId,label)` | server.js:337 | sha256 -> UUID-shaped id; **not exported** | duplicated as `uuidFromHash` in `cards.js` (see section 10) |
| `createInitialDatabaseRowCollab` | database-row-document.js | builds the row doc: row map (`id,database_id,visibility,height,created_at,last_modified` unix-second strings, `created_by/last_edited_by`), `cells` from plain JSON, empty `meta` | new card body |
| `rowDocumentIdFromRowId` | page-document.js:33 | `uuidV5('document_id', rowId)`; row-detail page id | archive/restore of the detail page |
| `store.setPageTrashed(pageId, ws, isTrashed, at)` / `store.getPage` | storage.js:458 / 407 | page trash flag | archive/restore of the detail page |
| `store.getUserById` | storage.js:39 | user with numeric `uid` | row attribution (`created_by`/`last_edited_by` = `String(uid)`) |
| WS registry / broadcast | server.js:3280 `websocketPeers`, 3377 `subscriptionKey(ws,type,id)`, 3306 `broadcastToWorkspace`, 3317 `pushToUser` | closure-private inside `createApp`; no helper broadcasts a server-originated collab update | `cards.js` takes a `broadcast` callback; the closure helper is a required shared-file change (section 10) |
| Search-index hooks | search-index.js:225-246 | monkey-patch `store.acceptDatabaseRowCollabUpdate`, `acceptDatabaseCollabUpdate`, `createAtomicDatabaseRow`, `createSeededDatabaseRow` | works automatically because `cards.js` always calls `store.method(...)` at call time (never a saved reference) |

## 3. Frontend contracts that the service matches (static, AppFlowy-Web `src/application/database-yjs`)

* **Cell write** `dispatch/cell.ts:213 writeCellToRow`: a new cell is `created_at = String(unix s)`, `field_type`, `data`, `last_modified`
  (+ date keys); an existing cell sets `data`, deletes `rich_text` when the text changed, sets `field_type` (`cell.field-type.ts:83`
  also deletes `source_field_type`), `last_modified`. `cells.set(fieldId, cell)`. Row attribution after a write: `attribution.ts:35 touchRowAttribution`
  (`last_modified`, `last_edited_by`). `cards.js` writes exactly these keys. (Note: `select-option/utils.ts:9 createSelectOptionCell` writes `created_at`
  in **milliseconds** and an `id` key - inconsistent with `cell.ts`; the service uses the `cell.ts` shape.)
* **Select:** `data` = option id; **multi-select:** option ids joined with `,`. Reading (`group.ts:617 groupBySelectOption`) matches a stored
  value to an option by **id or name** and sends everything else - empty, unknown, even the field id - to the "No status" group.
* **Checkbox:** written as `'Yes'`/`'No'` (`CheckboxCell.tsx`); read via `fields/text/utils.ts:57 parseCheckboxValue` (accepts yes/true/1/checked/x/[x]/on).
* **Number:** `data` is the numeric string. **URL/Text:** plain string `data`.
* **Date** (`cell.parse.ts:343`, `dispatch/cell.ts:75 updateDateCell`): `data` = unix seconds string, optional `end_timestamp`, `include_time`, `is_range`,
  `reminder_id`. Rendering is `dayjs.unix(ts).format(...)` (`utils/time.ts:5`) = **viewer's local zone**, so date-only has no zone of its own.
* **Rich text guard** `fields/text/rich-text-guard.ts:49 checkExistingCellWrite` + `rich-text.ts:25 RICH_TEXT_FORMAT_VERSION = 1`: a text cell whose
  `rich_text` envelope needs a newer client (`min_v > 1`, not stale) is never changed. Replicated minimally in `guardRichText`.
* **Title:** the field with `is_primary: true` (server default name "Name", but never assumed).
* **Board grouping:** `view.groups[0].field_id`; columns are the option ids, plus an ungrouped column whose id is the **field id**
  (`group.ts:545 getGroupCellData` returns undefined for it). Server-seeded Boards write the literal `'No status'` as the ungrouped column id
  (database-document.js `buildDefaultBoardGroup`). `cards.js` ignores the persisted column list, derives columns from the options and treats both
  representations (and any unmatched stored value) as "No status".
* **Moving a card** (`dispatch/row.ts:157 useMoveCardDispatch`): writes only the grouping cell (select: replaces the start column id with the finish id -
  the web can therefore store the field id for "No status"), then `reorderRow` (`row.ts:101`) on the **active view's** `row_orders`. Caution: the web's
  parameter `beforeRowId` means "place **after** this row" (`targetIndex = indexOf(beforeRowId)+1`; undefined => top). The service's `beforeCardId` means
  literally "place immediately **before** this card"; omitted => no reordering.

## 4. Atomicity across DatabaseRow and Database objects (static + tested)

* No store method updates a row collab and a Database collab in one transaction except row **creation** (`createSeededDatabaseRow`/`createAtomicDatabaseRow`
  do both inside one `mutate`/transaction). Updates go through two different queues (`databaseRowCollabUpdateQueue`, `databaseCollabUpdateQueue`) and, in
  Postgres, two different transactions. The web itself performs a card move as two separate Yjs updates (row doc, then Database doc) sent over the socket.
* **Decision (move_card):** write the cell first, then the order. A failure of step 1 changes nothing (plain error). A failure of step 2 is **not
  compensated** (reverting the cell could overwrite a concurrent edit of the same cell) and is reported as `CardError PARTIAL_FAILURE` with
  `details {column_changed, order_changed:false, card}` and the instruction to retry; `move_card` is idempotent, so a retry finishes the job (tested with fault
  injection: the Database accept throws; retry completes). Never reports success on half.
* Archive/restore touch only the Database doc (one object => atomic) plus the optional detail-page trash flag (separate store call; failure => `PARTIAL_FAILURE`
  with `details {card_changed:true, page_changed:false}`).

## 5. Archive and restore semantics (static)

* Web soft delete (`dispatch/row-lifecycle.ts:27 setRowOrdersDeleted`, `:71 softDeleteRowsInDatabase`): in **every** view, every `row_orders` entry
  with the row id is replaced in place (delete+insert at the same index) with `{id, height, is_deleted:true}`; restore replaces it with `{id, height}`.
  Position is preserved. (`removeRowsFromDatabase`, `:79`, is the hard delete - never used by MCP.)
* When the web deletes a row (`dispatch/row.ts:444 useTrashAwareDeleteRowsDispatch`): a row whose document has content, **or whose row-document page exists
  on the server**, is soft-deleted and its detail page is moved to the Trash via `PageService.moveToTrash` (so Trash can restore it); a row **without** a
  document is hard-removed from `row_orders`.
* **MCP decision:** archive is *always* the tombstone (never the hard delete). In addition, if the row-detail page (`rowDocumentIdFromRowId`) exists in this
  workspace, it is moved to / restored from the trash with `store.setPageTrashed` (parity with the web). MCP archive does **not** create a row document
  page. Consequence (limitation): an archived card **without** a detail page does not appear in the app's Trash; it can only be restored with
  `restore_card` (the id comes from the agent's earlier call, or from `archived: 'only'`).
* An entry state is "archived" when **every** entry for the row has `is_deleted`; mixed states count as live; archive/restore normalise all entries.
  Editing or moving an archived card is rejected (restore first).

## 6. Implemented interface

`createCardService({ store, broadcast?, searchRows?, isReadableSpace?, timeZone='UTC', now?, newId?, log? })`. All methods take one object; `workspaceId` is
trusted but every method re-verifies the database/card belongs to it (a foreign id is `NOT_FOUND`, never a leak).

| Method | Notes |
|---|---|
| `listDatabases({workspaceId})` | readable (non-trashed, public-space) databases that have a container page |
| `getDatabase({workspaceId, databaseId})` | title field, fields (`type` names, `writable`, options with colours), views, `boards[]` with `group_field`, `columns[{id|null,name,color,card_count}]` (always a "No status" column, `id: null`), `has_no_status_column` |
| `listCards({workspaceId, databaseId, viewId?, column?, query?, limit=25 (1-100), cursor?, archived='exclude'|'only'|'include'})` | see section 8 |
| `getCard({workspaceId, cardId})` | works for archived cards |
| `createCard({workspaceId, userId, databaseId, title, column?, fields?, viewId?, idempotencyKey, tokenId?})` -> `{card, replayed}` | section 7 |
| `updateCard({workspaceId, userId, cardId, title?, fields?})` -> `Card` | diff-based; no-op writes nothing and broadcasts nothing |
| `moveCard({workspaceId, userId, cardId, column, viewId?, beforeCardId?})` -> `{card, order_changed, column_changed}` | section 4 |
| `archiveCard / restoreCard({workspaceId, userId, cardId, confirm})` -> `Card` | `confirm` must be `true`; idempotent |

`Card = {id, database_id, database_name, title, column, column_id, fields, archived, created_at, updated_at}`. `column` is the display name of the **first
Board** (by view created-time, ties by id) grouped by a single-select (`'No status'` when unset; `null` when the database has no such Board). `fields` omits
empty values; duplicate field names are disambiguated as `Name [fieldId]`. Value types: text/url string, number, checkbox boolean, date string, single-select
option name, multi-select name[], date range `{start,end}` (read-only), other types best-effort string.

`CardError(code, message, details)`: `INVALID_INPUT`, `NOT_FOUND`, `AMBIGUOUS`, `CONFLICT`, `UNSUPPORTED`, `PARTIAL_FAILURE`, `FORBIDDEN` (reserved for the caller's
authorisation layer). Unknown/storage errors are rethrown unchanged (e.g. `CONCURRENT_UPDATE` after 3 attempts).

`broadcast({workspaceId, collabType (1 Database | 4 DatabaseRow), objectId, update (Yjs diff just persisted), beforeStateVector|null, accepted})`: called after
persistence, awaited, failures swallowed and logged. For `create_card` it fires once (`collabType 1`, `update` = the row-order diff, `beforeStateVector: null`,
`accepted` = the seeded-creation result, which has **no `messageId`**); a replay broadcasts nothing. `update_card` fires one row event; `move_card` fires row
then Database; archive/restore fire one Database event.

Additional rules implemented: writable types = text, number, date, single-select, multi-select, checkbox, URL (+ the title); everything else `UNSUPPORTED`;
option and column names match case-insensitively; unknown names list the valid ones; duplicates are `AMBIGUOUS`; options are never created; `title` and a
`fields` entry for the title field together are `INVALID_INPUT`; `column` plus the grouping field in `fields` is `INVALID_INPUT`; URLs with
`javascript:`/`data:`/`vbscript:` schemes are rejected; sizes capped (title 1,000, text 10,000, URL 2,048). Boards grouped by multi-select, checkbox, text, number
are `UNSUPPORTED` for `column`/`move` in v1. Several Boards: `column` operations need `viewId` unless all Boards share the grouping field; ordering always needs
`viewId` when more than one Board exists.

## 7. Idempotency (create_card)

Reuses the seeded-row ledger (no new system). `request_id` and `row_id` are derived from `sha256(workspaceId|tokenId||userId|databaseId|idempotencyKey)`;
`request_digest` = sha256 of the canonical payload `{database_id,title,column,view_id,fields}`. Same key + same payload => original card, `replayed:true`, no
broadcast. Same key + different payload => `CONFLICT` (ledger `REQUEST_ID_REUSED`). Different principal (token/user) => independent key space. Four
simultaneous identical requests create exactly one row (the atomic-creation queue serialises them). Replay survives a store restart (ledger is in the persisted
state; tested by loading a copy of the saved file). Unverified here: Postgres ledger (`seeded_row_creation_requests`, same semantics by reading its code).

## 8. Pagination

Opaque base64url cursor `{v, d: databaseId, w: viewId|null, c: column, q: query, a: archived, r: lastCardId, p: positionOfLast}`, rejected with `INVALID_INPUT` when any
of those do not match the new request. Order = the chosen view's `row_orders` (default: the inline/primary view), archived filtered per `archived`. Resume: after
`r` when it is still in the filtered list; if it moved/was archived/was removed, continue from position `p` (the slot it occupied). **Limitations under
concurrent reordering:** a card moved *earlier* than the cursor between pages is not seen again (skipped), a card moved *later* can be seen twice, and an
insert before the cursor shifts the window; no snapshot isolation. Text `query`: every whitespace-separated term must be a case-insensitive substring of the title or
a field value (scan of the database's rows - always fresh); an optional `searchRows` candidate provider (search index) narrows the scan but its ids are verified
against live membership; `null` from the provider falls back to the scan. Cost: O(rows) row reads per page when filtering by column or query.

## 9. Dates and time zones

Date-only input `YYYY-MM-DD` is stored as midnight **in the service `timeZone`** (default `UTC`), `include_time:false`; read back in the same zone. ISO date-time with
offset/`Z` is exact; without offset it is read in the service zone; `include_time:true`; read back as UTC `...Z`. Ranges are read-only (`{start,end}`); writing a single
date over a range clears `is_range`/`end_timestamp`. Because AppFlowy-Web renders in the viewer's local zone, a viewer whose zone differs from `timeZone` can see a
date-only value on the adjacent day - the service never silently shifts it, and `timeZone` should be set to the workspace's zone by the integration layer.
Tested with `America/Los_Angeles` including the 2026-03-08 DST jump.

## 10. Required shared-file changes (not made by this phase)

1. **`server.js` - add `broadcastCollabUpdate`** inside `createApp` beside `broadcastToWorkspace` (~3306) and pass it to `createCardService`:
   ```js
   async function broadcastCollabUpdate({ workspaceId, collabType, objectId, update, accepted }) {
     const frame = encodeMessage({ collabMessage: { objectId, collabType, update: {
       ...(accepted?.messageId ? { messageId: accepted.messageId } : {}), flags: 0, payload: update,
       ...(accepted?.collabVersion ? { version: accepted.collabVersion } : {}) } } });
     const key = subscriptionKey(workspaceId, collabType, objectId);   // multi-object subscription key (Task 77.2)
     for (const peer of websocketPeers) {
       if (peer.readyState === 1 && peer.workspaceId === workspaceId && peer.subscriptions?.has(key)) {
         try { peer.send(frame, { binary: true }); } catch (error) { console.error('collab fan-out failed', error); }
       }
     }
   }
   ```
2. **`server.js` - pass the real space-permission check:** `createCardService({ store, broadcast: broadcastCollabUpdate, isReadableSpace: isSupportedPublicSpacePermission, timeZone })`.
   The service default (`visibility === 'public'`) is deliberately weaker; `isSupportedPublicSpacePermission` is not exported from `server.js` (line 477).
3. **Optional:** export `deriveUuid` (server.js:337) from a small util instead of the local copy `uuidFromHash` (tiny duplication, noted).
4. **Optional (archive UX):** export `ensureRowDocumentPage` (server.js ~503) and call it from archive so an archived card always has a detail page and therefore
   appears in the app's Trash (today only `restore_card` can bring back an archived card that never had a detail page).
5. **MCP module:** use `CardError` from `cards.js`; consider an `include_archived` argument on `list_cards` (the service already supports `archived`), and note
   `create_card`/`move_card` accept an optional `viewId` in the service (not in the frozen tool schema; ambiguity otherwise surfaces as `AMBIGUOUS`).

## 11. Test classification (this phase)

| Group | Evidence class | Result |
|---|---|---|
| Discovery, access scope, trashed/unreadable databases | real Yjs + JSON persistence | **Passed** |
| Listing: paging, cursors, filters, search candidates, typed reads | real Yjs + JSON persistence | **Passed** |
| create_card: web-shaped cells, every view, validation, ambiguity | real Yjs + JSON persistence | **Passed** |
| create_card idempotency: replay, mismatch, principal scope, restart (ledger from a saved copy) | real Yjs + JSON persistence | **Passed** |
| update_card incl. rich-text guard, dates/time zones | real Yjs + JSON persistence | **Passed** |
| move_card: column, order, validation, multi-Board, unsupported grouping, No status, fault injection between the two writes | real Yjs + JSON persistence | **Passed** |
| archive/restore across views, detail-page trash coupling, partial failure | real Yjs + JSON persistence | **Passed** |
| Broadcast contract (recording callback, failing peer) | real Yjs + callback fake | **Passed** (no WebSocket involved) |
| Concurrency: stale-snapshot browser edit vs service on different cells, simultaneous, same cell, Database row-order, create vs reorder, parallel service calls, `CONCURRENT_UPDATE` retry | real Yjs + JSON persistence | **Passed** (30 tests in the two files) |
| Real WebSocket delivery to open browsers | - | *Superseded:* **Passed** in Phase 2 / Integration and in acceptance |
| PostgreSQL persistence / parity | - | *Superseded:* **Passed** on real PostgreSQL 16 in the Integration phase (30/30 card tests) and re-confirmed in acceptance (132/132 MCP/card/token tests; full suite 484/484) |
| Full backend regression suite | see the final message of this task | recorded below |

## 12. Known limitations

* Postgres unverified for this module; the Postgres seeded ledger and `setPageTrashed` were read, not run.
* Pagination has no snapshot isolation (section 8); filtering/search scan rows (O(rows) per page).
* An archived card without a detail page is invisible to the app's Trash (section 5).
* Ordering has the "no snapshot" caveat and `before` semantics differ from the web's internal `beforeRowId` naming (section 3).
* Date-only values depend on the configured `timeZone` (section 9).
* Only single-select Boards support `column`/`move` in v1; adding select options, checklist/relation/person writes and date ranges are out of scope.
* `card.column` uses the first Board; databases with several differently grouped Boards report the first one's column.
