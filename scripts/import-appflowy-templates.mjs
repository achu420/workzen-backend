#!/usr/bin/env node
// Pulls the templates listed on https://appflowy.com/templates into this backend's template library
// (templates/databases, templates/documents), so they show up under "Templates" in the new-page menu.
//
// The website is a front for AppFlowy's public template service: GET /api/template-center/template lists them and each
// one is a *published view* whose blob (GET /api/workspace/published/{namespace}/{name}/blob) is the real content -
// the Yjs collab of a document, or a JSON bundle of the database collab + one collab per row. Nothing is scraped from
// HTML. We decode those collabs and write them in the plain-JSON shape the library already uses (see
// build-template-library.mjs / database-template-builder.js / document-template-builder.js).
//
// What cannot be carried over is skipped or trimmed, and reported:
//   * databases: databases linked by relations are followed and imported together (up to 8; "related_databases");
//     relations to anything that cannot be imported, rollups and formulas built on them, media/file fields (the files
//     live on AppFlowy's servers) and Form views are removed; a template that loses too much of itself is skipped;
//   * documents: images and files hosted on AppFlowy's servers are blanked to empty placeholders (as in the rest of
//     the library); PDFs, person mentions and reminders are removed; sub-pages and databases embedded in a page are
//     imported with it ("embedded_databases") unless the source copy cannot be read.
//   * card bodies (the document of a card's detail page) are imported, under the same document rules.
// Templates already in the library (same name or id) are left alone. --force refreshes only templates this script
// imported earlier (they carry a `source_url`); it never touches the hand-built ones.
//
// Usage: node scripts/import-appflowy-templates.mjs [--source https://beta.appflowy.cloud] [--cache <dir>]
//          [--only <text in the name>] [--dry-run] [--force]
// Needs network access to the source. --cache keeps the downloaded blobs so a re-run does not fetch again.
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { rowDocumentIdFromRowId } from '../page-document.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELD = { text: 0, number: 1, date: 2, single: 3, multi: 4, checkbox: 5, url: 6, checklist: 7, lastEdited: 8, createdAt: 9, relation: 10, summary: 11, translate: 12, file: 13, media: 14, time: 15, rollup: 16, formula: 19 };
const DROPPED_FIELD_TYPES_ALWAYS = new Set([FIELD.file, FIELD.media]);
const FORM_LAYOUT = 7;
// DatabaseViewLayout -> the name a new view gets in the app; some sources leave views named "Untitled".
const DEFAULT_VIEW_NAMES = { 0: 'Grid', 1: 'Board', 2: 'Calendar', 3: 'Chart', 4: 'List', 5: 'Gallery', 6: 'Feed', 8: 'Timeline' };
const EMBEDDED_DATABASE_BLOCKS = new Set(['calendar', 'grid', 'board', 'linked_view', 'database', 'chart', 'gallery', 'list']);
const UNSUPPORTED_BLOCKS = new Set(['pdf']);
// Uploads live on the source's servers: like the rest of the library they become empty placeholder blocks.
const UPLOAD_BLOCKS = new Set(['image', 'file']);
const PERSON_LIKE_MENTIONS = new Set(['person', 'page', 'childPage']);
// A database template keeps at least this share of its non-title fields, or it is not worth importing.
const MIN_KEPT_FIELD_SHARE = 0.6;

function parseArgs(argv) {
  const args = { flags: new Set() };

  for (let i = 0; i < argv.length; i += 1) {
    if (['--dry-run', '--force'].includes(argv[i])) args.flags.add(argv[i].slice(2));
    else if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return args;
}

const slugify = (name) => String(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const normalName = (name) => slugify(name).replace(/-template$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseIcon(raw) {
  if (!raw) return null;
  try {
    const icon = typeof raw === 'string' ? JSON.parse(raw) : raw;

    return icon && typeof icon === 'object' && 'ty' in icon && 'value' in icon ? { ty: icon.ty, value: icon.value } : null;
  } catch {
    return null;
  }
}

/** [{insert, attributes}] for a Y.Text on Yjs 14 (getContent().children / format) and older builds (toDelta). */
function opsOf(text) {
  const raw = typeof text.getContent === 'function' ? [...text.getContent().children] : text.toDelta();

  return raw.filter((op) => op.insert !== undefined).map((op) => ({ insert: op.insert, attributes: op.format ?? op.attributes ?? null }));
}

// ------------------------------------------------------------------ database
// Yjs hands back 64-bit integers (timestamps) as BigInt, which JSON cannot carry.
const plain = (value) => JSON.parse(JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? Number(item) : item)));

// The views to keep: the ones the source published. An embedded database is published under the id of the page that
// embeds it, which may not be one of its views; then every view that is not the hidden inline one, else all of them.
// For an embedded database the published view is kept first, followed by the other views that have a name.
function usableViewIds(bundle, db, embedded) {
  const all = Object.values(db.views ?? {});
  const published = (bundle.visible_database_view_ids ?? []).filter((id) => db.views?.[id]);

  if (embedded && published.length) return [...published, ...all.filter((view) => !published.includes(view.id) && !view.is_inline && String(view.name ?? '').trim()).map((view) => view.id)];
  if (published.length) return published;
  const shown = all.filter((view) => !view.is_inline).map((view) => view.id);

  return shown.length ? shown : all.map((view) => view.id);
}

/** One published database, decoded but not yet trimmed (trimming needs the whole group of linked databases). */
function parseDatabase(bundle, meta, { embedded = false } = {}) {
  const database = new Y.Doc();

  Y.applyUpdate(database, Uint8Array.from(bundle.database_collab));
  const db = plain(database.getMap('data').toJSON().database);

  database.destroy();
  const rows = [];

  for (const [rowId, bytes] of Object.entries(bundle.database_row_collabs ?? {})) {
    const doc = new Y.Doc();

    Y.applyUpdate(doc, Uint8Array.from(bytes));
    const row = plain(doc.getMap('data').toJSON().data);

    doc.destroy();
    if (row) rows.push({ id: rowId, height: row.height ?? 60, visibility: row.visibility !== false, cells: row.cells ?? {} });
  }
  return {
    id: db.id,
    name: meta?.view?.name ?? '',
    icon: parseIcon(meta?.view?.icon),
    db,
    fields: Object.values(db.fields ?? {}),
    visibleViewIds: usableViewIds(bundle, db, embedded),
    rows,
    bodies: bundle.database_row_document_collabs ?? {},
    relations: bundle.database_relations ?? {},
  };
}

const referencesOf = (field) => [...String(field.type_option?.[FIELD.formula]?.expression ?? '').matchAll(/prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map((match) => match[1].replace(/\\(.)/g, '$1'));

/**
 * Decides, for the whole group of linked databases, which fields cannot be kept, to a fixed point: media/file fields;
 * relations to a database outside the group; rollups whose relation or target field is gone; formulas that read a
 * removed field. Returns Map(databaseId -> Set(fieldId)).
 */
function droppedFields(group) {
  const byId = new Map(group.map((entry) => [entry.id, entry]));
  const dropped = new Map(group.map((entry) => [entry.id, new Set()]));
  const gone = (databaseId, fieldId) => !byId.has(databaseId) || !byId.get(databaseId).fields.some((field) => field.id === fieldId) || dropped.get(databaseId).has(fieldId);

  for (let changed = true; changed;) {
    changed = false;
    for (const entry of group) {
      const mine = dropped.get(entry.id);
      const byRef = new Map([...entry.fields.map((field) => [field.name, field]), ...entry.fields.map((field) => [field.id, field])]);

      for (const field of entry.fields) {
        if (mine.has(field.id)) continue;
        let drop = DROPPED_FIELD_TYPES_ALWAYS.has(field.ty);
        const options = field.type_option?.[field.ty] ?? {};

        if (field.ty === FIELD.relation) drop = !byId.has(options.database_id);
        if (field.ty === FIELD.rollup) {
          const relation = entry.fields.find((candidate) => candidate.id === options.relation_field_id);

          drop = !relation || relation.ty !== FIELD.relation || mine.has(relation.id) || gone(relation.type_option?.[FIELD.relation]?.database_id, options.target_field_id);
        }
        if (field.ty === FIELD.formula) drop = referencesOf(field).some((ref) => !byRef.has(ref) || mine.has(byRef.get(ref).id));
        if (drop) { mine.add(field.id); changed = true; }
      }
    }
  }
  return dropped;
}

/** Turns one parsed database into the library shape, with the group's drops applied. */
function finishDatabase(entry, group, dropped, label) {
  const notes = [];
  const mine = dropped.get(entry.id);
  const primary = entry.fields.find((field) => field.is_primary);

  if (!primary) return { skip: 'no title field' };
  const secondary = entry.fields.filter((field) => !field.is_primary);
  const kept = secondary.filter((field) => !mine.has(field.id));

  if (mine.size) notes.push(`${label}removed ${mine.size} field(s) that depend on files or databases outside the template`);
  if (secondary.length && (kept.length < 1 || kept.length / secondary.length < MIN_KEPT_FIELD_SHARE)) {
    return { skip: `${label}only ${kept.length} of ${secondary.length} fields would survive (it relies on files or databases that cannot be imported)` };
  }
  const mentionsDropped = (value) => { const text = JSON.stringify(value ?? null); return [...mine].some((id) => text.includes(`"${id}"`)); };
  const views = [];

  for (const viewId of entry.visibleViewIds) {
    const view = entry.db.views[viewId];

    if (view.layout === FORM_LAYOUT) { notes.push(`${label}left out form view "${view.name}"`); continue; }
    if (mentionsDropped(view.groups) || mentionsDropped(view.layout_settings)) { notes.push(`${label}left out view "${view.name}" (it uses a removed field)`); continue; }
    views.push({
      id: view.id,
      database_id: entry.db.id,
      name: !view.name || /^untitled$/i.test(view.name.trim()) ? (DEFAULT_VIEW_NAMES[view.layout] ?? 'View') : view.name,
      layout: view.layout,
      layout_settings: view.layout_settings ?? {},
      filters: (view.filters ?? []).filter((filter) => !mentionsDropped(filter)),
      sorts: (view.sorts ?? []).filter((sort) => !mentionsDropped(sort)),
      group_settings: view.groups ?? [],
      row_orders: view.row_orders ?? [],
      field_orders: (view.field_orders ?? []).filter((order) => !mine.has(order.id)),
      field_settings: Object.fromEntries(Object.entries(view.field_settings ?? {}).filter(([id]) => !mine.has(id))),
      is_inline: false,
      embedded: false,
      created_at: view.created_at || 0,
    });
  }
  if (!views.length) return { skip: `${label}no usable view` };
  const fields = entry.fields.filter((field) => !mine.has(field.id)).map((field) => ({
    id: field.id,
    name: field.name,
    field_type: field.ty,
    icon: field.icon ?? '',
    type_options: field.type_option ?? {},
    is_primary: Boolean(field.is_primary),
  }));
  const fieldIds = new Set(fields.map((field) => field.id));
  const rowIds = new Set(entry.rows.map((row) => row.id));
  const rowIdsOf = (databaseId) => new Set(group.find((candidate) => candidate.id === databaseId)?.rows.map((row) => row.id) ?? []);
  const relationTargets = new Map(fields.filter((field) => field.field_type === FIELD.relation).map((field) => [field.id, rowIdsOf(field.type_options?.[FIELD.relation]?.database_id)]));
  const rows = entry.rows.map((row) => ({
    id: row.id,
    height: row.height,
    visibility: row.visibility,
    cells: Object.fromEntries(Object.entries(row.cells).filter(([id]) => fieldIds.has(id)).map(([id, cell]) => (
      relationTargets.has(id) ? [id, { ...cell, data: (Array.isArray(cell.data) ? cell.data : []).filter((rowId) => relationTargets.get(id).has(rowId)) }] : [id, cell]
    ))),
  }));

  for (const view of views) view.row_orders = view.row_orders.filter((order) => rowIds.has(order.id));
  // Card bodies: the document of a row's detail page. The bundle keys a body by the id of its document, which is
  // derived from the row id.
  let bodies = 0;

  for (const [documentId, bytes] of Object.entries(entry.bodies)) {
    const row = rows.find((candidate) => rowDocumentIdFromRowId(candidate.id) === documentId);

    if (!row) continue;
    const body = extractDocument(Uint8Array.from(bytes));

    if (body.skip) { notes.push(`${label}left out a card body (${body.skip})`); continue; }
    if (!body.hasText) continue; // an opened but empty body is the same as none
    row.document = body.document;
    bodies += 1;
  }
  if (bodies) notes.push(`${label}${bodies} card body(ies) included`);
  return { database: { database_id: entry.id, fields, views, rows }, notes };
}

const MAX_LINKED_DATABASES = 8;
const GENERIC_DATABASE_NAMES = new Set(['grid', 'list', 'board', 'table', 'calendar', 'by status', 'untitled', '']);

/** Follows relation fields from the root database to every database it links to, through the published copies. */
async function collectGroup(root, rootMeta, loadPublished, options = {}) {
  const group = [parseDatabase(root, rootMeta, options)];
  const known = new Map([[group[0].id, true]]);
  const viewOfDatabase = new Map(Object.entries(group[0].relations));

  for (let index = 0; index < group.length; index += 1) {
    const targets = group[index].fields.filter((field) => field.ty === FIELD.relation).map((field) => field.type_option?.[FIELD.relation]?.database_id).filter(Boolean);

    for (const target of targets) {
      if (known.has(target)) continue;
      known.set(target, false);
      const viewId = viewOfDatabase.get(target) ?? group.map((entry) => entry.relations[target]).find(Boolean);

      if (!viewId) continue;
      const published = await loadPublished(viewId).catch(() => null);

      if (!published?.bundle) continue;
      const parsed = parseDatabase(published.bundle, published.meta);

      if (parsed.id !== target) continue;
      known.set(target, true);
      for (const [databaseId, otherView] of Object.entries(parsed.relations)) if (!viewOfDatabase.has(databaseId)) viewOfDatabase.set(databaseId, otherView);
      group.push(parsed);
      if (group.length > MAX_LINKED_DATABASES) return { group, tooMany: true };
    }
  }
  return { group };
}

function convertDatabaseGroup(allDatabases, listing) {
  const leftOut = [];
  let group = allDatabases;

  // A linked database that turns out unusable is dropped from the group and everything is worked out again, so the
  // fields that pointed at it go too (including rollups and formulas built on them).
  for (;;) {
    const dropped = droppedFields(group);
    const finished = group.map((entry, index) => finishDatabase(entry, group, dropped, index === 0 ? '' : `linked database "${entry.name || entry.id.slice(0, 8)}": `));

    if (finished[0].skip) return { skip: finished[0].skip };
    const unusable = finished.findIndex((result, index) => index > 0 && result.skip);

    if (unusable > 0) {
      leftOut.push(finished[unusable].skip);
      group = group.filter((_, index) => index !== unusable);
      continue;
    }
    const notes = [...leftOut.map((reason) => `left out ${reason}`), ...finished[0].notes];
    const related = [];

    for (let index = 1; index < group.length; index += 1) {
      const label = String(group[index].name ?? '').trim();

      related.push({
        ...finished[index].database,
        name: GENERIC_DATABASE_NAMES.has(label.toLowerCase()) ? `${listing.name} - ${label || 'Data'}` : label,
        icon: group[index].icon,
      });
      notes.push(...finished[index].notes);
    }
    return { template: { ...finished[0].database, ...(related.length ? { related_databases: related } : {}) }, notes };
  }
}

// ------------------------------------------------------------------ document
function extractDocument(docState, { allowEmbeds = false } = {}) {
  const doc = new Y.Doc();

  Y.applyUpdate(doc, docState);
  const root = doc.getMap('data').get('document');
  const blocks = root?.get('blocks');
  const rootId = root?.get('page_id');
  const childrenMap = root?.get('meta')?.get('children_map');
  const textMap = root?.get('meta')?.get('text_map');

  if (!blocks || !childrenMap || !textMap || !rootId) return { skip: 'not a document' };
  const notes = [];
  const types = new Set([...blocks.values()].map((block) => block.get('ty')));
  const embedded = [...types].filter((type) => EMBEDDED_DATABASE_BLOCKS.has(type));

  if (embedded.length && !allowEmbeds) return { skip: `embeds a database (${embedded.join(', ')})` };
  const out = { page_id: rootId, blocks: {}, meta: { children_map: {}, text_map: {} } };
  const removedBlocks = new Set();
  const blanked = new Set();
  const blockUrl = (block) => { try { return String(JSON.parse(block.get('data') || '{}').url ?? ''); } catch { return ''; } };
  const hostedByAppFlowy = (url) => /appflowy\.(cloud|com|io)|file_storage/i.test(url) || url === '';

  for (const [id, block] of blocks.entries()) {
    const type = block.get('ty');

    if (UNSUPPORTED_BLOCKS.has(type)) removedBlocks.add(id);
    else if (UPLOAD_BLOCKS.has(type) && hostedByAppFlowy(blockUrl(block))) blanked.add(id);
  }
  if (removedBlocks.size) notes.push(`removed ${removedBlocks.size} PDF block(s)`);
  if (blanked.size) notes.push(`blanked ${blanked.size} image/file upload(s) hosted on AppFlowy's servers`);
  // A removed block takes its children with it.
  const isRemoved = (id, seen = new Set()) => {
    if (removedBlocks.has(id)) return true;
    const parent = blocks.get(id)?.get('parent');

    return Boolean(parent) && parent !== rootId && !seen.has(id) && isRemoved(parent, seen.add(id));
  };

  for (const [id, block] of blocks.entries()) {
    if (id !== rootId && isRemoved(id)) continue;
    let data = {};

    try { data = JSON.parse(block.get('data') || '{}'); } catch { data = {}; }
    if (blanked.has(id)) data = { ...data, url: '' };
    out.blocks[id] = {
      id, ty: block.get('ty'), parent: block.get('parent') ?? '', children: block.get('children'),
      external_id: block.get('external_id') ?? null, external_type: block.get('external_type') ?? null, data,
    };
  }
  for (const [childrenId, array] of childrenMap.entries()) {
    out.meta.children_map[childrenId] = array.toArray().filter((childId) => out.blocks[childId]);
  }
  for (const block of Object.values(out.blocks)) {
    if (!block.external_id || !textMap.has(block.external_id)) continue;
    const ops = opsOf(textMap.get(block.external_id))
      .filter((op) => !(op.attributes?.mention && PERSON_LIKE_MENTIONS.has(op.attributes.mention.type)))
      .map((op) => (op.attributes?.mention?.type === 'date' ? { ...op, attributes: { ...op.attributes, mention: { ...op.attributes.mention, reminder_id: undefined } } } : op));

    out.meta.text_map[block.external_id] = JSON.stringify(ops.map((op) => (op.attributes && Object.keys(op.attributes).length ? { insert: op.insert, attributes: op.attributes } : { insert: op.insert })));
  }
  doc.destroy();
  const hasText = Object.values(out.meta.text_map).some((delta) => JSON.parse(delta).some((op) => String(op.insert).trim()));

  const embeds = Object.values(out.blocks).filter((block) => EMBEDDED_DATABASE_BLOCKS.has(block.ty)).map((block) => ({ block_id: block.id, ty: block.ty, view_id: block.data.view_id ?? block.data.view_ids?.[0] ?? null, view_ids: block.data.view_ids ?? (block.data.view_id ? [block.data.view_id] : []) }));

  return { document: out, notes, hasText, embeds };
}

async function convertDocument(docState, listing, meta, loadPublished) {
  const extracted = extractDocument(docState, { allowEmbeds: true });

  if (extracted.skip) return extracted;
  const notes = [...extracted.notes];
  const subDocuments = (meta.child_views ?? []).filter((child) => child.layout === 0);
  const children = [];

  for (const child of subDocuments) {
    const published = await loadPublished(child.view_id, { raw: true }).catch(() => null);

    if (!published?.state) return { skip: `sub-page "${child.name}" could not be fetched` };
    const sub = await convertDocument(published.state, { view_id: child.view_id, name: child.name }, published.meta, loadPublished);

    if (sub.skip) return { skip: `sub-page "${child.name}": ${sub.skip}` };
    if (sub.template.embedded_databases) return { skip: `sub-page "${child.name}" embeds a database` };
    children.push(sub.template.pages);
    notes.push(...sub.notes.map((note) => `sub-page "${child.name}": ${note}`));
  }
  const embeddedDatabases = [];

  for (const embed of extracted.embeds) {
    const reason = `embedded ${embed.ty} "${embed.view_id?.slice(0, 8) ?? '?'}"`;
    const published = embed.view_id ? await loadPublished(embed.view_id).catch(() => null) : null;

    if (!published?.bundle) return { skip: `${reason} is not published on the source` };
    let converted;

    try {
      const { group, tooMany } = await collectGroup(published.bundle, published.meta, loadPublished, { embedded: true });

      converted = tooMany ? { skip: `links to more than ${MAX_LINKED_DATABASES} databases` } : convertDatabaseGroup(group, { name: listing.name });
    } catch (error) {
      return { skip: `${reason} could not be read (${String(error.message).slice(0, 60)})` };
    }
    if (converted.skip) return { skip: `${reason}: ${converted.skip}` };
    embeddedDatabases.push({
      block_id: embed.block_id,
      name: String(published.meta?.view?.name ?? '').trim() || listing.name,
      icon: parseIcon(published.meta?.view?.icon),
      view_ids: embed.view_ids,
      database: converted.template,
    });
    notes.push(`embedded database "${published.meta?.view?.name ?? ''}" included (${converted.template.rows.length} rows${converted.template.related_databases ? `, ${converted.template.related_databases.length} linked database(s)` : ''})`);
    notes.push(...converted.notes);
  }
  return {
    template: {
      pages: { id: listing.view_id, name: listing.name, icon: parseIcon(meta.view?.icon), document: extracted.document, children },
      ...(embeddedDatabases.length ? { embedded_databases: embeddedDatabases } : {}),
    },
    notes,
  };
}

// ---------------------------------------------------------------------- main
async function existingLibrary(dir) {
  const ids = new Set();
  const names = new Set();
  const imported = new Set();

  for (const kind of ['databases', 'documents']) {
    for (const file of (await readdir(path.join(dir, kind)).catch(() => [])).filter((name) => name.endsWith('.json'))) {
      const template = JSON.parse(await readFile(path.join(dir, kind, file), 'utf8'));

      ids.add(template.template_id);
      names.add(normalName(template.name));
      if (template.source_url) imported.add(template.template_id);
    }
  }
  return { ids, names, imported };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = (args.source ?? 'https://beta.appflowy.cloud').replace(/\/+$/, '');
  const dir = path.join(ROOT, 'templates');
  const cacheDir = args.cache ? path.resolve(args.cache) : null;
  const dry = args.flags.has('dry-run');
  const force = args.flags.has('force');
  const get = async (url, asBuffer = false) => {
    const response = await fetch(url, { headers: { 'user-agent': 'tracker-template-import/1.0' } });

    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    return asBuffer ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
  const cached = async (key, make) => {
    if (cacheDir) {
      try { return await readFile(path.join(cacheDir, key)); } catch { /* not cached yet */ }
    }
    const value = await make();

    if (cacheDir) { await mkdir(cacheDir, { recursive: true }); await writeFile(path.join(cacheDir, key), value); }
    return value;
  };

  const base = `${source}/api/workspace`;
  // A published view by id (used to follow relations to the databases a template links to).
  const loadPublished = async (viewId, options = {}) => {
    const info = JSON.parse(await cached(`${viewId}.info.json`, async () => Buffer.from(JSON.stringify(await get(`${base}/published-info/${viewId}`))))).data;
    const meta = JSON.parse(await cached(`${viewId}.meta.json`, async () => Buffer.from(JSON.stringify(await get(`${base}/v1/published/${info.namespace}/${info.publish_name}`))))).data;
    const blob = await cached(`${viewId}.blob`, async () => { await sleep(250); return get(`${base}/published/${info.namespace}/${info.publish_name}/blob`, true); });

    return { meta, bundle: blob[0] === 0x7b ? JSON.parse(blob.toString()) : null, state: blob[0] === 0x7b ? null : blob };
  };
  const listing = (await get(`${source}/api/template-center/template`)).data.templates;
  const library = await existingLibrary(dir);
  const report = [];
  let order = 100;

  for (const entry of listing) {
    if (args.only && !entry.name.toLowerCase().includes(String(args.only).toLowerCase())) continue;
    const { namespace, publish_name: publishName } = entry.publish_info ?? {};
    const id = slugify(entry.name);
    const say = (status, detail = '') => report.push(`${status.padEnd(8)} ${entry.name}${detail ? ` - ${detail}` : ''}`);

    if (!namespace || !publishName) { say('skipped', 'not published'); continue; }
    const taken = library.ids.has(id) || library.names.has(normalName(entry.name));

    if (taken && !(force && library.imported.has(id))) { say('exists', 'already in the library'); continue; }
    try {
      const meta = (await cached(`${entry.view_id}.meta.json`, async () => Buffer.from(JSON.stringify(await get(`${base}/v1/published/${namespace}/${publishName}`))))).toString();
      const blob = await cached(`${entry.view_id}.blob`, async () => { await sleep(250); return get(`${base}/published/${namespace}/${publishName}/blob`, true); });
      const info = JSON.parse(meta).data ?? {};

      if (blob.length < 200) { say('skipped', 'empty or broken on the source'); continue; }
      const isDatabase = blob[0] === 0x7b;
      let converted;

      if (isDatabase) {
        const { group, tooMany } = await collectGroup(JSON.parse(blob.toString()), info, loadPublished);

        converted = tooMany ? { skip: `links to more than ${MAX_LINKED_DATABASES} databases` } : convertDatabaseGroup(group, entry);
      } else converted = await convertDocument(blob, entry, info, loadPublished);

      if (converted.skip) { say('skipped', converted.skip); continue; }
      const common = {
        template_id: id,
        order: order += 1,
        name: entry.name,
        description: entry.description ?? '',
        icon: parseIcon(info.view?.icon),
        category: entry.categories?.find((category) => category.id === entry.primary_category_id)?.name ?? entry.categories?.[0]?.name ?? null,
        categories: (entry.categories ?? []).map((category) => category.name),
        author: entry.creator?.name ?? null,
        source_url: entry.view_url ?? null,
      };
      const template = { ...common, ...converted.template };
      const kind = isDatabase ? 'databases' : 'documents';

      if (!dry) {
        await mkdir(path.join(dir, kind), { recursive: true });
        await writeFile(path.join(dir, kind, `${id}.json`), `${JSON.stringify(template, null, 2)}\n`);
      }
      library.ids.add(id);
      library.names.add(normalName(entry.name));
      library.imported.add(id);
      say(dry ? 'would add' : 'added', `${isDatabase ? `database: ${template.fields.length} fields, ${template.views.length} views, ${template.rows.length} rows${template.related_databases ? `, plus ${template.related_databases.length} linked database(s): ${template.related_databases.map((database) => `${database.name} (${database.rows.length} rows)`).join(', ')}` : ''}` : 'document'}${converted.notes.length ? ` (${converted.notes.join('; ')})` : ''}`);
    } catch (error) {
      say('failed', error.message);
    }
  }
  console.log(report.join('\n'));
  console.log(`\n${report.filter((line) => line.startsWith('added') || line.startsWith('would')).length} added, ${report.filter((line) => line.startsWith('skipped')).length} skipped, ${report.filter((line) => line.startsWith('exists')).length} already there, ${report.filter((line) => line.startsWith('failed')).length} failed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
