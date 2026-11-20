import * as Y from 'yjs';
import { toUnixSecondsString } from './database-document.js';

// Task 62 (minimum viable DatabaseRow lifecycle, CollabType.DatabaseRow = 4).
//
// Builds the initial Yjs state for a brand-new DatabaseRow collab object,
// matching the exact Y.Doc shape AppFlowy-Web's own row.ts/create-row.ts
// code reads and writes (verified directly against the checked-out
// AppFlowy-Web source, not upstream Rust structs):
//
//   doc.getMap('data')                              -> root shared map
//     .get('data')  (YjsEditorKey.database_row, which is a *second* enum
//                    alias for the same raw string 'data' as the root map's
//                    own name -- see AppFlowy-Web src/application/types.ts
//                    YjsEditorKey: `data_section = 'data'` and
//                    `database_row = 'data'`. This is intentional upstream
//                    aliasing, not a bug: the row's *root* Y.Doc map is
//                    named "data", and the row object itself lives under
//                    the key "data" *inside* that map.)
//                                                     -> YDatabaseRow (Y.Map)
//       .get('id')                                    -> row_id (string)
//       .get('database_id')                           -> parent database_id
//       .get('visibility')                             -> boolean
//       .get('height')                                 -> number
//       .get('created_at'/'last_modified')              -> ISO timestamp
//       .get('created_by'/'last_edited_by')              -> actor uid (string, optional)
//       .get('cells')                                    -> Y.Map<FieldId, Y.Map>
//     .get('meta')                                      -> Y.Map (row page metadata:
//                    icon/cover/document-emptiness, keyed by per-row UUIDv5
//                    ids -- see AppFlowy-Web row_meta.ts/const.ts. Left
//                    EMPTY here: Phase 1 does not persist presentation
//                    (icon_url/cover) content into this map (see Task 62
//                    report); an empty map is the same safe default
//                    AppFlowy-Web itself treats as "document empty" when a
//                    meta key is absent, and every row-meta consumer in the
//                    frontend expects a real Y.Map (even if empty) at this
//                    key, not `undefined`.)
//
// See AppFlowy-Web src/application/database-yjs/row.ts (initialDatabaseRow)
// for the exact shape this mirrors.
//
// Out of scope for Phase 1 (recorded for later tasks, not implemented here):
// row detail Document pages (separate CollabType.Document object, derived
// id = uuidv5('document_id', rowId) -- see row-template-graph.ts), row
// templates/duplication, presentation (icon/cover) persistence, relation
// fields, formula/rollup cells.

/**
 * @param {object} params
 * @param {string} params.rowId - the DatabaseRow collab object's own id
 * @param {string} params.databaseId - the parent Database's id
 * @param {Record<string, Record<string, unknown>>} params.cells - field_id -> cell properties (JSON-safe scalars/objects only)
 * @param {number} params.height - row height (AppFlowy-Web default is 36)
 * @param {boolean} params.visibility
 * @param {string} params.timestamp - ISO timestamp used for created_at/last_modified
 * @param {string|number} [params.actorUid] - creating user's uid, stored as created_by/last_edited_by
 */
export function createInitialDatabaseRowCollab({ rowId, databaseId, cells, height, visibility, timestamp, actorUid }) {
  const doc = new Y.Doc({ guid: rowId });
  const root = doc.getMap('data');
  const row = new Y.Map();
  root.set('data', row);

  row.set('id', rowId);
  row.set('database_id', databaseId);
  row.set('visibility', visibility);
  row.set('height', height);
  row.set('created_at', toUnixSecondsString(timestamp));
  row.set('last_modified', toUnixSecondsString(timestamp));
  if (actorUid !== undefined && actorUid !== null) {
    row.set('created_by', String(actorUid));
    row.set('last_edited_by', String(actorUid));
  }

  const cellsMap = new Y.Map();
  row.set('cells', cellsMap);
  for (const [fieldId, cellData] of Object.entries(cells || {})) {
    const cell = new Y.Map();
    for (const [key, value] of Object.entries(cellData || {})) {
      // A relation cell keeps its related row ids in a Y.Array (that is what the web app reads back).
      if (key === 'data' && Array.isArray(value)) {
        const items = new Y.Array();

        items.push(value);
        cell.set(key, items);
      } else cell.set(key, value);
    }
    cellsMap.set(fieldId, cell);
  }

  // Empty but present -- see the module comment above.
  root.set('meta', new Y.Map());

  const documentState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.destroy();
  return { documentState, stateVector };
}
