// Task 64: shared, storage-mode-agnostic logic for deriving the workspace
// Database catalog (`GET /api/workspace/{workspaceId}/database`) from the
// SAME `pages` records both storage backends already maintain -- no second
// Database registry is introduced. This file is imported by BOTH storage.js
// (JSON mode) and postgres-storage.js (PostgreSQL mode) so the derivation
// rule is defined exactly once and the two modes cannot drift apart.
//
// Rule (verified against Task 61's createAtomicDatabasePage in server.js):
// a Database is represented in the Folder tree by exactly two page records
// in Phase 1:
//   - a "container" page: `extra.is_database_container === true` and
//     `extra.database_id` set to the Database collab's id. This is the
//     sidebar entry a user clicks to open the Database.
//   - a "primary view" page: a Folder-tree CHILD of the container
//     (`parent_view_id === container.id`) whose `extra.database_id` matches
//     the container's `extra.database_id`. This is the Database's own
//     inline/primary Grid view, referenced by the Database collab's
//     `view_id` (see database-document.js / createInitialDatabaseCollab).
// Container and primary-view ids are NOT interchangeable (Task 61/63
// finding) -- the catalog reports both, tagged via `is_container`, exactly
// matching AppFlowy-Web's `WorkspaceDatabaseWithViews`/`WorkspaceDatabaseViewItem`
// contract (src/application/services/services.type.ts) and its
// `getDatabaseContainerView`/`getDatabasePrimaryView` helpers
// (src/application/services/js-services/workspace-database-catalog.ts).
//
// Malformed-metadata handling (deliberate, documented choice -- see Task 64
// report): a container page with a missing/invalid `database_id` is
// EXCLUDED from the catalog (it cannot be a usable Database entry), but
// this never affects any other, well-formed container -- each container is
// evaluated independently. A container with no matching primary-view page
// (e.g. partial/corrupted data) is still INCLUDED, with only its single
// `is_container: true` view -- consistent with "don't silently disappear
// valid entries" while still being honest that the entry cannot currently
// be opened (AppFlowy-Web's `getDatabaseContainerEntries` already handles a
// missing primary view by excluding that one entry from the openable list,
// without needing the backend to hide it from the raw catalog). A candidate
// primary-view page whose `extra.database_id` does NOT match its parent
// container's `database_id` is never selected as that container's primary
// view (protects against cross-database id confusion from corrupted data).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function orderKey(page) {
  return `${page.created_at ?? ''}\u0000${page.id ?? ''}`;
}

function toViewItem(page, isContainer) {
  return {
    view_id: page.id,
    // Only Grid (Folder ViewLayout.Grid = 1) is ever assigned to a Database
    // container/primary-view page in Phase 1 (see server.js
    // createAtomicDatabasePage); `?? 1` is a defensive fallback, never
    // observed in practice since both pages are always created with
    // `layout: 1`.
    layout: page.layout ?? 1,
    is_container: isContainer,
    // Phase 1 only ever creates non-embedded Grid databases
    // (`database.embedded === false` is enforced at creation time in
    // server.js) -- there is no embedded-database data model to report.
    embedded: false,
    name: page.title ?? '',
    icon: page.icon ?? null,
    parent_view_id: page.parent_view_id ?? null,
  };
}

/**
 * Derive the workspace Database catalog from an already workspace-scoped
 * list of page records (as returned by `store.listPages(workspaceId)` in
 * either storage backend). Pure and synchronous -- callers own the actual
 * (storage-mode-specific) fetch of `pages`.
 *
 * Returns entries sorted by the container page's `(created_at, id)` so
 * repeated calls against unchanged data are stably ordered in both storage
 * modes, matching the `created_at` tie-broken-by-`id` convention already
 * used elsewhere in server.js (e.g. its Folder-tree `/view` route).
 */
export function buildDatabaseCatalogFromPages(pages) {
  const safePages = Array.isArray(pages) ? pages.filter((p) => isPlainObject(p)) : [];

  const containers = safePages
    .filter((p) => isPlainObject(p.extra) && p.extra.is_database_container === true && isValidId(p.extra.database_id))
    .sort((a, b) => orderKey(a).localeCompare(orderKey(b)));

  return containers.map((container) => {
    const databaseId = container.extra.database_id;
    const primaryCandidates = safePages
      .filter((p) =>
        p.id !== container.id &&
        p.parent_view_id === container.id &&
        isPlainObject(p.extra) &&
        p.extra.database_id === databaseId)
      .sort((a, b) => orderKey(a).localeCompare(orderKey(b)));

    const views = [toViewItem(container, true)];
    if (primaryCandidates.length > 0) {
      views.push(toViewItem(primaryCandidates[0], false));
    }

    return { database_id: databaseId, views };
  });
}
