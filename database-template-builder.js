import * as Y from 'yjs';
import { DATABASE_COLLAB_VERSION, toUnixSecondsString } from './database-document.js';

export function unixSecondsString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.floor(value));
  return toUnixSecondsString(value);
}

// Plain JSON -> the Yjs shape used for editable-config leaves (filters, sorts,
// groups, field_settings, layout_settings, type_options): objects become
// Y.Map, arrays Y.Array, scalars pass through. Not applied to row_orders /
// field_orders, which database-document.js stores as plain {id,...} objects.
export function toYValue(value) {
  if (Array.isArray(value)) {
    const arr = new Y.Array();
    arr.push(value.map(toYValue));
    return arr;
  }
  if (value && typeof value === 'object') {
    const map = new Y.Map();
    for (const [k, v] of Object.entries(value)) map.set(k, toYValue(v));
    return map;
  }
  return value;
}

// The export's group_settings uses `ty` where database-document.js's
// buildDefaultBoardGroup uses `type`; every other key already matches.
export function buildGroupsArray(groupSettings) {
  const arr = new Y.Array();
  for (const g of groupSettings || []) {
    const map = new Y.Map();
    map.set('id', g.id);
    map.set('field_id', g.field_id);
    map.set('type', g.ty);
    map.set('content', g.content ?? '');
    map.set('groups', toYValue(g.groups ?? []));
    map.set('collapsed_group_ids', toYValue(g.collapsed_group_ids ?? []));
    arr.push([map]);
  }
  return arr;
}

// Builds a Database collab from plain-JSON `{fields, views}` (the shape of an
// AppFlowy export / our template library), remapping view ids and row ids.
export function buildDatabaseCollabFromTemplate({ databaseId, template, viewIdMap, rowIdMap, timestamp }) {
  const doc = new Y.Doc({ guid: databaseId });
  const data = doc.getMap('data');
  const database = new Y.Map();
  data.set('database', database);
  database.set('id', databaseId);

  const fields = new Y.Map();
  database.set('fields', fields);
  for (const f of template.fields || []) {
    const fmap = new Y.Map();
    fmap.set('id', f.id);
    fmap.set('name', f.name);
    fmap.set('ty', f.field_type);
    fmap.set('icon', f.icon ?? '');
    fmap.set('is_primary', !!f.is_primary);
    fmap.set('created_at', unixSecondsString(timestamp));
    fmap.set('last_modified', unixSecondsString(timestamp));
    const typeOption = new Y.Map();
    for (const [tyKey, opts] of Object.entries(f.type_options || {})) {
      typeOption.set(tyKey, toYValue(opts));
    }
    fmap.set('type_option', typeOption);
    fields.set(f.id, fmap);
  }

  const views = new Y.Map();
  database.set('views', views);
  let inlineViewId = null;
  for (const v of template.views || []) {
    const newViewId = viewIdMap.get(v.id);
    if (!newViewId) continue;
    if (v.is_inline) inlineViewId = newViewId;
    const view = new Y.Map();
    view.set('id', newViewId);
    view.set('database_id', databaseId);
    view.set('name', v.name);
    view.set('created_at', unixSecondsString(v.created_at || timestamp));
    view.set('modified_at', unixSecondsString(timestamp));
    view.set('layout', v.layout);
    view.set('layout_settings', toYValue(v.layout_settings ?? {}));
    view.set('filters', toYValue(v.filters ?? []));
    view.set('sorts', toYValue(v.sorts ?? []));
    view.set('field_settings', toYValue(v.field_settings ?? {}));
    const fieldOrders = new Y.Array();
    fieldOrders.push((v.field_orders || []).map((o) => ({ id: o.id })));
    view.set('field_orders', fieldOrders);
    const rowOrders = new Y.Array();
    rowOrders.push((v.row_orders || [])
      .map((o) => ({ id: rowIdMap.get(o.id), height: o.height }))
      .filter((o) => o.id));
    view.set('row_orders', rowOrders);
    view.set('calculations', new Y.Array());
    view.set('groups', buildGroupsArray(v.group_settings));
    view.set('is_inline', !!v.is_inline);
    view.set('embedded', !!v.embedded);
    views.set(newViewId, view);
  }
  if (!inlineViewId) {
    const first = (template.views || [])[0];
    inlineViewId = first ? viewIdMap.get(first.id) : null;
  }

  const metas = new Y.Map();
  database.set('metas', metas);
  metas.set('iid', inlineViewId);
  metas.set('schema_version', 1);

  const documentState = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.destroy();
  return { documentState, stateVector, collabVersion: DATABASE_COLLAB_VERSION, inlineViewId };
}
