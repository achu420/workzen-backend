import * as Y from 'yjs';

// Task 61 (Phase 1 Grid database foundation).
//
// Builds the initial Yjs state for a brand-new Database collab object
// (CollabType.Database = 1), matching the exact Y.Doc shape AppFlowy-Web's
// own dispatch/hydration code reads and writes (verified directly against
// the checked-out AppFlowy-Web source, not upstream Rust structs):
//
//   doc.getMap('data').get('database')            -> YDatabase (Y.Map)
//     .get('id')                                   -> database_id (string)
//     .get('fields')                                -> Y.Map<FieldId, YDatabaseField>
//     .get('views')                                 -> Y.Map<ViewId, YDatabaseView>
//     .get('metas')                                  -> Y.Map { iid, schema_version }
//
// See AppFlowy-Web src/application/types.ts (YjsEditorKey, YjsDatabaseKey,
// YDatabase/YDatabaseView/YDatabaseField/YDatabaseMetas) and
// src/application/services/js-services/http/created-page-hydration.ts
// (validateDatabase) for the exact keys this mirrors.
//
// Out of scope for Phase 1 (recorded for later tasks, not implemented here):
// relation/rollup/formula/person/created-by/last-edited-by field types, and
// Form's (layout=7) companion "Responses" view (see
// SUPPORTED_ADDITIONAL_VIEW_LAYOUTS below) -- every other DatabaseViewLayout
// is creatable both as a database's first/primary view and as an additional
// view, sharing the exact same view-construction recipe (buildView, below).

const DATABASE_VIEW_LAYOUT_GRID = 0; // DatabaseViewLayout.Grid (database.type.ts)
const FIELD_TYPE_RICH_TEXT = 0; // FieldType.RichText (database.type.ts) -- matches upstream RichText=0

// Every created_at/last_modified/modified_at value stored on a Yjs
// field/view/row is read back by AppFlowy-Web as a Unix-epoch-SECONDS
// string (e.g. YjsDatabaseKey.created_at is always written via
// `String(dayjs().unix())` -- see dispatch.ts's createField, row.ts's
// initialDatabaseRow, cell.clone.ts, etc.) and rendered with
// `dayjs.unix(Number(value))` (see utils/time.ts renderDate). An ISO-8601
// string here parses to NaN and renders as "Invalid Date" -- this was
// exactly that bug, not a display-only issue.
export const toUnixSecondsString = (isoTimestamp) => String(Math.floor(Date.parse(isoTimestamp) / 1000));

// The collab_version string returned alongside this doc's state and echoed
// by the /database/{id}/restore-state endpoint; AppFlowy-Web's
// verifyCreatedPage() requires both to report the identical string (see
// created-page-hydration.ts, `restore.version !== remote.version`).
export const DATABASE_COLLAB_VERSION = 'appflowy-database-v1';

/**
 * @param {object} params
 * @param {string} params.databaseId - the Database collab object's own id (YDatabase.id)
 * @param {string} params.viewId - the primary/inline view id (YDatabaseView.id, and metas.iid)
 * @param {string} params.name - the view's display name (as sent by the frontend's DATABASE_LAYOUTS default, e.g. "Grid")
 * @param {string} params.primaryFieldId - a stable id for the seeded primary (title) field
 * @param {string} params.timestamp - ISO timestamp used for created_at/last_modified/modified_at
 * @param {number} [params.layout] - DatabaseViewLayout for the primary view (default Grid=0); any
 *   value in SUPPORTED_ADDITIONAL_VIEW_LAYOUTS is valid here too -- see buildView.
 */
export function createInitialDatabaseCollab({ databaseId, viewId, name, primaryFieldId, timestamp, layout = DATABASE_VIEW_LAYOUT_GRID }) {
  const doc = new Y.Doc({ guid: databaseId });
  const data = doc.getMap('data');
  const database = new Y.Map();
  data.set('database', database);
  database.set('id', databaseId);

  const fields = new Y.Map();
  database.set('fields', fields);
  const primaryField = new Y.Map();
  primaryField.set('id', primaryFieldId);
  primaryField.set('name', 'Name');
  primaryField.set('ty', FIELD_TYPE_RICH_TEXT);
  primaryField.set('icon', '');
  primaryField.set('is_primary', true);
  primaryField.set('created_at', toUnixSecondsString(timestamp));
  primaryField.set('last_modified', toUnixSecondsString(timestamp));
  const primaryTypeOption = new Y.Map();
  primaryTypeOption.set(String(FIELD_TYPE_RICH_TEXT), new Y.Map());
  primaryField.set('type_option', primaryTypeOption);
  fields.set(primaryFieldId, primaryField);

  const views = new Y.Map();
  database.set('views', views);
  // Reuses the exact same per-layout view recipe (including the Board
  // default-group fallback) as addDatabaseView's additional-view path, so a
  // database's first/primary view is structurally indistinguishable from
  // one created later via "Add view" with the same layout -- see buildView.
  buildView(views, { viewId, databaseId, name, layout, embedded: false, isInline: true, timestamp, fields, sourceView: undefined });

  const metas = new Y.Map();
  database.set('metas', metas);
  metas.set('iid', viewId);
  metas.set('schema_version', 1);

  const documentState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.destroy();
  return { documentState, stateVector, collabVersion: DATABASE_COLLAB_VERSION };
}

// Task 72 (database views -- additional-view creation, the one confirmed
// backend gap found by this task's discovery; see
// docs/TASK72_DATABASE_VIEWS_DISCOVERY.md). AppFlowy-Web's real, reachable
// "Add view" UI (AddViewButton.tsx) offers every DatabaseViewLayout value
// EXCEPT nothing -- all nine are reachable -- but its own atomic-creation
// contract (create-default-view.ts) always sends a null `responses_view_id`
// except for Form (layout=7), which additionally requires the server to
// materialize a second, companion Grid "Responses" view with no stored
// cross-reference back to it (confirmed absent from the Yjs view shape;
// discoverable only via the Folder tree). Form's public-submission/
// companion-view semantics are a distinct, materially larger feature than
// "view lifecycle + configuration" and are deliberately out of this task's
// scope (see the discovery report's explicit scope decision) -- Form
// (layout=7) is therefore excluded from SUPPORTED_ADDITIONAL_VIEW_LAYOUTS
// and the server route rejects it with a clear 400, exactly like Task 61
// already rejected every non-Grid layout for the FIRST view in a database.
//
// FOLDER_LAYOUTS maps DatabaseViewLayout (database-internal view layout,
// database.type.ts: Grid=0, Board=1, Calendar=2, Chart=3, List=4,
// Gallery=5, Feed=6, Form=7, Timeline=8) to the Folder-side ViewLayout
// enum (types.ts: Document=0, Grid=1, Board=2, Calendar=3, AIChat=4,
// Chart=5, List=6, Gallery=7, Feed=8, Form=9, Timeline=10) -- confirmed
// directly against AppFlowy-Web's own opt-in server-interop test
// (default-database-view-creation.integration.test.ts: `createdFolder.layout
// === [1, 2, 3, 5, 6, 7, 8, 9, 10][layout]`), not inferred.
export const FOLDER_LAYOUTS = Object.freeze([1, 2, 3, 5, 6, 7, 8, 9, 10]);

// DatabaseViewLayout values this backend accepts for an ADDITIONAL view in
// an existing database (Form=7 excluded, see above) -- none of them require
// any backend-side query/filter/sort/group computation to create, only a
// correctly-shaped persisted Yjs config, matching the architecture
// constraint that query execution stays the frontend's responsibility. The
// SAME set is also valid for a database's FIRST/primary view (the
// "+ New page" sidebar menu's Document/Grid/Board/Calendar/Chart/List/
// Gallery/Feed/Timeline entries -- see server.js's page-view/database/default
// route), since buildView (above) builds both identically.
export const SUPPORTED_ADDITIONAL_VIEW_LAYOUTS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 8]);

const DATABASE_VIEW_LAYOUT_BOARD = 1;
// FieldType values AppFlowy-Web's own generateBoardGroup() (dispatch.ts)
// treats as "board-groupable": SingleSelect=3, MultiSelect=4, Checkbox=5
// (database.type.ts FieldType enum). Mirrored here only to PREFER a
// groupable field when one exists -- not required, see buildDefaultBoardGroup.
const BOARD_GROUPABLE_FIELD_TYPES = [3, 4, 5];

/** Deep-rebuilds a Yjs value (Y.Map/Y.Array, recursively) or a plain
 * JSON-safe value into a fresh, unattached copy. Yjs types cannot be shared
 * across two parents/docs, so cloning a view's filters/sorts/groups/
 * field_settings/field_orders/row_orders/layout_settings/calculations from
 * a source view requires rebuilding every nested Y.Map/Y.Array from
 * scratch -- this is the single generic helper that does that, used
 * identically for every one of those keys regardless of their content
 * (this function never interprets what a filter/sort/group MEANS, only
 * copies its persisted shape, consistent with query logic staying the
 * frontend's responsibility). */
function cloneYValue(value) {
  if (value instanceof Y.Map) {
    const copy = new Y.Map();
    value.forEach((v, k) => copy.set(k, cloneYValue(v)));
    return copy;
  }
  if (value instanceof Y.Array) {
    const copy = new Y.Array();
    copy.push(value.toArray().map((item) => cloneYValue(item)));
    return copy;
  }
  if (Array.isArray(value)) return value.map((item) => cloneYValue(item));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = cloneYValue(value[key]);
    return copy;
  }
  return value;
}

function buildDefaultFieldOrders(fields) {
  const orders = new Y.Array();
  if (fields) orders.push(Array.from(fields.keys()).map((fieldId) => ({ id: fieldId })));
  return orders;
}

// A Board view with no usable group configuration renders as a single,
// useless column -- AppFlowy-Web's own opt-in server-interop test
// (default-database-view-creation.integration.test.ts) explicitly requires
// a NEW Board view's `groups` to be non-empty, with a real field id and at
// least one group-column, straight from the creation response (its comment:
// "Older Web renders only persisted groups. Do not use its new fallback...").
// This mirrors AppFlowy-Web's own generateBoardGroup() (dispatch.ts) policy
// of PREFERRING a SingleSelect/MultiSelect/Checkbox field, but -- unlike
// that client-side function, which leaves `groups` empty when no such field
// exists -- always falls back to whatever field IS available (e.g. a
// brand-new database's primary RichText field) so the server's own recipe
// is self-sufficient, per the test's explicit intent. This does not compute
// or interpret any row grouping -- it only establishes one valid, non-empty
// default bucket, the same category of work as Task 61 seeding empty
// Y.Array/Y.Map placeholders of the correct type for filters/sorts.
function buildDefaultBoardGroup(fields) {
  if (!fields || fields.size === 0) return null;
  let chosenId;
  for (const key of fields.keys()) {
    const field = fields.get(key);
    if (BOARD_GROUPABLE_FIELD_TYPES.includes(Number(field.get('ty')))) {
      chosenId = key;
      break;
    }
  }
  if (!chosenId) {
    const first = fields.keys().next();
    if (first.done) return null;
    chosenId = first.value;
  }
  const field = fields.get(chosenId);
  const group = new Y.Map();
  group.set('id', chosenId);
  group.set('field_id', chosenId);
  group.set('type', Number(field.get('ty')));
  group.set('content', '{}');
  const columns = new Y.Array();
  const defaultColumn = new Y.Map();
  defaultColumn.set('id', 'No status');
  defaultColumn.set('visible', true);
  columns.push([defaultColumn]);
  group.set('groups', columns);
  group.set('collapsed_group_ids', new Y.Array());
  const groups = new Y.Array();
  groups.push([group]);
  return groups;
}

function hasUsableBoardGroup(fields, groups) {
  if (!groups || groups.length === 0) return false;
  const fieldId = groups.get(0) && groups.get(0).get('field_id');
  return !!fieldId && !!fields && fields.has(fieldId);
}

/**
 * Builds one view of ANY supported DatabaseViewLayout and attaches it to
 * `views` (a Database collab's already-integrated `views` Y.Map) -- the one
 * recipe shared by both createInitialDatabaseCollab (the database's first/
 * inline view) and addDatabaseView (every view after that), so a view is
 * structurally identical regardless of which of the two creation paths
 * produced it.
 *
 * When `sourceView` (an already-integrated YDatabaseView) is given, every
 * configuration key (filters/sorts/groups/field_settings/field_orders/
 * row_orders/layout_settings/calculations) is cloned from it, matching
 * AppFlowy-Web's own "duplicate view" semantics. `isInline`/`embedded` are
 * passed straight through (the inline/primary view is always
 * `is_inline: true, embedded: false`; every additional view is always
 * `is_inline: false`, with `embedded` as the caller specifies).
 *
 * @throws nothing -- caller (addDatabaseView) is responsible for resolving
 *   and validating sourceView before calling this.
 */
function buildView(views, { viewId, databaseId, name, layout, embedded, isInline, timestamp, fields, sourceView }) {
  // Decide whether the Board-default-group fallback is needed by reading
  // the SOURCE view's groups (already integrated into the doc, so reading
  // it is safe) BEFORE cloning -- not by reading the clone or the new,
  // still-detached `view`/`groups` afterward. Yjs only guarantees read
  // access (`.get()`/`.length`/etc.) on a Y.Map/Y.Array once it has been
  // integrated into a document via a `.set()` onto an already-integrated
  // parent; reading a freshly built, not-yet-attached structure is
  // unsupported (silently unreliable, not merely discouraged) until AFTER
  // it is attached. Every value below is therefore only ever WRITTEN
  // (`.set()`) before `view` itself is attached (`views.set(viewId, view)`)
  // and never READ back until after that attachment.
  const sourceGroups = sourceView && sourceView.get('groups');
  const needsDefaultBoardGroup = layout === DATABASE_VIEW_LAYOUT_BOARD && !hasUsableBoardGroup(fields, sourceGroups);

  const view = new Y.Map();
  view.set('id', viewId);
  view.set('database_id', databaseId);
  view.set('name', name);
  view.set('created_at', toUnixSecondsString(timestamp));
  view.set('modified_at', toUnixSecondsString(timestamp));
  view.set('layout', layout);
  view.set('layout_settings', (sourceView && cloneYValue(sourceView.get('layout_settings'))) || new Y.Map());
  view.set('filters', (sourceView && cloneYValue(sourceView.get('filters'))) || new Y.Array());
  view.set('sorts', (sourceView && cloneYValue(sourceView.get('sorts'))) || new Y.Array());
  view.set('field_settings', (sourceView && cloneYValue(sourceView.get('field_settings'))) || new Y.Map());
  view.set('field_orders', (sourceView && cloneYValue(sourceView.get('field_orders'))) || buildDefaultFieldOrders(fields));
  view.set('row_orders', (sourceView && cloneYValue(sourceView.get('row_orders'))) || new Y.Array());
  view.set('calculations', (sourceView && cloneYValue(sourceView.get('calculations'))) || new Y.Array());
  view.set('groups', needsDefaultBoardGroup ? new Y.Array() : ((sourceView && cloneYValue(sourceGroups)) || new Y.Array()));
  view.set('is_inline', !!isInline);
  view.set('embedded', !!embedded);

  views.set(viewId, view);

  if (needsDefaultBoardGroup) {
    const defaultGroups = buildDefaultBoardGroup(fields);
    if (defaultGroups) view.set('groups', defaultGroups);
  }
  return view;
}

/**
 * Mutates an already-decoded Database Y.Doc in place, adding one new view
 * to its `views` map via buildView (above) -- see that function's doc
 * comment for the shared view-shape contract.
 *
 * When `sourceViewId` resolves to a real view of this same database, its
 * configuration is cloned onto the new view (see buildView). When no
 * sourceViewId is given (the real "Add view" button's default, confirmed
 * from useAddDatabaseView), the database's own inline view (`metas.iid`) is
 * used as the implicit source instead of leaving the new view empty --
 * this is this task's own design decision (not an upstream-confirmed
 * requirement): a brand new Board/Calendar/etc. view that showed zero
 * existing rows by default would be surprising and not match ordinary
 * multi-view database UX, and nothing about doing this computes or
 * duplicates any FILTER/SORT/GROUP semantics, only the plain
 * row-membership/config snapshot already established by the chosen source
 * view.
 *
 * @throws {Error & {code: 'DATABASE_NOT_FOUND'|'VIEW_NOT_FOUND'}}
 */
export function addDatabaseView(doc, { viewId, databaseId, name, layout, embedded, sourceViewId, timestamp }) {
  const database = doc.getMap('data').get('database');
  if (!database || database.get('id') !== databaseId) {
    const error = new Error('Target Database collaboration object is missing its own data');
    error.code = 'DATABASE_NOT_FOUND';
    throw error;
  }
  const views = database.get('views');
  const fields = database.get('fields');
  const metas = database.get('metas');
  const inlineViewId = metas && metas.get('iid');
  if (sourceViewId && !views.has(sourceViewId)) {
    const error = new Error('source_view_id does not belong to this Database');
    error.code = 'VIEW_NOT_FOUND';
    throw error;
  }
  const resolvedSourceViewId = sourceViewId || inlineViewId;
  const sourceView = resolvedSourceViewId ? views.get(resolvedSourceViewId) : undefined;

  buildView(views, { viewId, databaseId, name, layout, embedded, isInline: false, timestamp, fields, sourceView });
}
