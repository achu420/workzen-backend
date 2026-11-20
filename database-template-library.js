import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates', 'databases');

let cache = null;

function load() {
  if (cache) return cache;
  const templates = new Map();
  let files = [];
  try {
    files = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const file of files) {
    const template = JSON.parse(readFileSync(path.join(TEMPLATE_DIR, file), 'utf8'));
    templates.set(template.template_id, template);
  }
  cache = templates;
  return cache;
}

export function listDatabaseTemplates() {
  return [...load().values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((t) => ({
    template_id: t.template_id,
    name: t.name,
    description: t.description,
    icon: t.icon ?? null,
    primary_layout: t.views[0]?.layout ?? 0,
    field_count: t.fields.length,
    row_count: t.rows.length,
    view_count: t.views.length,
    database_count: 1 + (t.related_databases?.length ?? 0),
    linked_databases: (t.related_databases ?? []).map((database) => database.name),
    category: t.category ?? null,
    categories: t.categories ?? [],
    author: t.author ?? null,
  }));
}

export function getDatabaseTemplate(templateId) {
  return typeof templateId === 'string' ? load().get(templateId) ?? null : null;
}
