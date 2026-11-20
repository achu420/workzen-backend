import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates', 'documents');

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

const countPages = (node) => 1 + (node.children ?? []).reduce((n, child) => n + countPages(child), 0);

export function listDocumentTemplates() {
  return [...load().values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((t) => ({
    template_id: t.template_id,
    name: t.name,
    description: t.description,
    icon: t.icon ?? null,
    page_count: countPages(t.pages),
    embedded_database_count: (t.embedded_databases ?? []).length,
    category: t.category ?? null,
    categories: t.categories ?? [],
    author: t.author ?? null,
  }));
}

export function getDocumentTemplate(templateId) {
  return typeof templateId === 'string' ? load().get(templateId) ?? null : null;
}
