#!/usr/bin/env node
// Regenerates templates/databases/*.json from an AppFlowy workspace export
// (the same unzipped export import-template-workspace.mjs reads).
//
// Usage: node scripts/build-template-library.mjs [--export ./docs/Templates] [--out ./templates/databases]
//
// Each template is a standalone database. The export's four databases are
// cross-linked through two-way Relation fields (and Rollups over them), which
// would dangle once cloned alone, so those fields are stripped everywhere
// (fields, per-view field_orders/field_settings, row cells).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FIELD_TYPE_RELATION = 10;
const FIELD_TYPE_ROLLUP = 16;

const TEMPLATE_META = {
  '01_opportunities': { template_id: 'opportunities', order: 0, name: 'Opportunities', description: 'Score and prioritise customer opportunities with evidence, stage and owner.' },
  '02_projects': { template_id: 'projects', order: 1, name: 'Projects', description: 'Track projects by status, risk, owner and delivery dates.' },
  '03_epics': { template_id: 'epics', order: 2, name: 'Epics', description: 'Break projects into epics and follow their progress.' },
  '04_tasks': { template_id: 'tasks', order: 3, name: 'Tasks', description: 'A task tracker with status, priority and assignees.' },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  return out;
}

function parseIcon(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { ty: raw.ty, value: raw.value };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exportDir = path.resolve(args.export || './docs/Templates');
  const outDir = path.resolve(args.out || './templates/databases');
  const relationMap = JSON.parse(await readFile(path.join(exportDir, 'relation_map.json'), 'utf8'));
  const dbDir = path.join(exportDir, 'collab_jsons', 'databases');

  const databaseById = new Map();
  for (const file of (await readdir(dbDir)).filter((f) => f.endsWith('.json')).sort()) {
    const json = JSON.parse(await readFile(path.join(dbDir, file), 'utf8'));
    if (!databaseById.has(json.database_id)) databaseById.set(json.database_id, json);
  }

  await mkdir(outDir, { recursive: true });
  let written = 0;
  for (const container of Object.values(relationMap.views)) {
    let extra = null;
    try { extra = container.extra ? JSON.parse(container.extra) : null; } catch { extra = null; }
    if (!extra?.is_database_container) continue;
    const meta = TEMPLATE_META[container.name];
    const source = databaseById.get(extra.database_id);
    if (!meta || !source) {
      console.warn(`skip container "${container.name}": ${meta ? 'database JSON missing' : 'no template metadata'}`);
      continue;
    }

    const dropped = new Set(source.fields.filter((f) => f.field_type === FIELD_TYPE_RELATION || f.field_type === FIELD_TYPE_ROLLUP).map((f) => f.id));
    const fields = source.fields.filter((f) => !dropped.has(f.id));
    const views = source.views.map((v) => ({
      ...v,
      name: relationMap.views[v.id]?.name ?? v.name,
      field_orders: (v.field_orders || []).filter((o) => !dropped.has(o.id)),
      field_settings: Object.fromEntries(Object.entries(v.field_settings || {}).filter(([id]) => !dropped.has(id))),
    }));
    for (const v of views) {
      const refs = [...(v.filters || []), ...(v.sorts || []), ...(v.group_settings || [])].map((x) => x.field_id);
      if (refs.some((id) => dropped.has(id))) throw new Error(`view "${v.name}" of "${container.name}" references a stripped field`);
    }
    // Rows may also carry orphan cells for fields deleted from the database;
    // keep only cells whose field survives.
    const fieldIds = new Set(fields.map((f) => f.id));
    const rows = source.rows.map((r) => ({
      id: r.id,
      height: r.height ?? 60,
      visibility: r.visibility !== false,
      cells: Object.fromEntries(Object.entries(r.cells || {}).filter(([id]) => fieldIds.has(id))),
    }));

    const template = {
      template_id: meta.template_id,
      order: meta.order,
      name: meta.name,
      description: meta.description,
      icon: parseIcon(container.icon),
      fields,
      views,
      rows,
    };
    await writeFile(path.join(outDir, `${meta.template_id}.json`), `${JSON.stringify(template, null, 2)}\n`);
    console.log(`${meta.template_id}: ${fields.length} fields (stripped ${dropped.size}), ${views.length} views, ${rows.length} rows`);
    written += 1;
  }
  if (written === 0) throw new Error('No templates written');
}

main().catch((error) => { console.error(error); process.exit(1); });
