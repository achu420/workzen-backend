// Card templates ("row templates"): a database can hold named templates for new cards, one of them the default that the
// app applies to every card created from the "+ New" button. They live in the Database collab's `metas` map, in the
// same format AppFlowy Desktop and AppFlowy-Web use (AppFlowy-Web src/application/database-yjs/template/storage.ts and
// codec.ts): one `row_template_v2:<id>` JSON entry per template, plus a `row_templates` JSON array projection and its
// sha256 (`row_templates_projection_sha256`), and `default_row_template` naming the default template id.
//
// A template's body (`doc_data`) is a frozen document encoded as Desktop's DocumentDataPB protobuf, not Yjs; the
// schema below is the same small descriptor AppFlowy-Web uses (template/document.ts).
import { createHash, randomUUID } from 'node:crypto';
import protobuf from 'protobufjs/light.js';
import { exportDocumentFor, hasText } from './page-writer.js';

const TEMPLATE_PREFIX = 'row_template_v2:';
const PROJECTION_KEY = 'row_templates';
const PROJECTION_HASH_KEY = 'row_templates_projection_sha256';
const DEFAULT_KEY = 'default_row_template';

const DocumentDataPB = protobuf.Root.fromJSON({
  nested: {
    DocumentDataPB: { fields: { page_id: { type: 'string', id: 1 }, blocks: { keyType: 'string', type: 'BlockPB', id: 2 }, meta: { type: 'MetaPB', id: 3 } } },
    BlockPB: {
      fields: {
        id: { type: 'string', id: 1 }, ty: { type: 'string', id: 2 }, data: { type: 'string', id: 3 }, parent_id: { type: 'string', id: 4 },
        children_id: { type: 'string', id: 5 }, external_id: { type: 'string', id: 6 }, external_type: { type: 'string', id: 7 },
      },
    },
    MetaPB: { fields: { children_map: { keyType: 'string', type: 'ChildrenPB', id: 1 }, text_map: { keyType: 'string', type: 'string', id: 2 } } },
    ChildrenPB: { fields: { children: { rule: 'repeated', type: 'string', id: 1 } } },
  },
}).lookupType('DocumentDataPB');

/** Parsed markdown-lite blocks -> the template body bytes (`doc_data`). */
export function encodeTemplateBody(blocks) {
  const rootId = `tpl${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const exported = exportDocumentFor(blocks, rootId);
  const snapshot = {
    page_id: rootId,
    blocks: Object.fromEntries(Object.entries(exported.blocks).map(([id, block]) => [id, {
      id, ty: block.ty, data: JSON.stringify(block.data ?? {}), parent_id: block.parent ?? '', children_id: block.children ?? '',
      external_id: block.external_id ?? '', external_type: block.external_type ?? '',
    }])),
    meta: {
      children_map: Object.fromEntries(Object.entries(exported.meta.children_map).map(([id, children]) => [id, { children }])),
      text_map: exported.meta.text_map,
    },
  };

  return Array.from(DocumentDataPB.encode(snapshot).finish());
}

/** Template body bytes -> a block tree ({ty, data, delta?, children?}), the shape page-writer appends. */
export function decodeTemplateBody(bytes) {
  if (!Array.isArray(bytes) || !bytes.length) return [];
  const snapshot = DocumentDataPB.toObject(DocumentDataPB.decode(Uint8Array.from(bytes)), { defaults: true });
  const childrenOf = (block) => snapshot.meta?.children_map?.[block?.children_id]?.children ?? [];
  const parse = (json, fallback) => { try { return JSON.parse(json); } catch { return fallback; } };
  const toBlock = (id, depth) => {
    const block = snapshot.blocks?.[id];

    if (!block || depth > 16) return null;
    const out = { ty: block.ty, data: parse(block.data, {}) };

    if (hasText(out)) out.delta = block.external_id ? parse(snapshot.meta?.text_map?.[block.external_id] ?? '[]', []) : [];
    const children = childrenOf(block).map((child) => toBlock(child, depth + 1)).filter(Boolean);

    if (children.length) out.children = children;
    return out;
  };

  return childrenOf(snapshot.blocks?.[snapshot.page_id]).map((id) => toBlock(id, 0)).filter(Boolean);
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && typeof value.template_id === 'string';

/** The templates stored in a database's `metas` (a Y.Map), merged exactly like AppFlowy-Web's readTemplateRecords. */
export function readRowTemplates(metas) {
  const json = typeof metas?.get(PROJECTION_KEY) === 'string' ? metas.get(PROJECTION_KEY) : '';
  const parsed = parseJson(json);
  const projection = Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  const hash = metas?.get(PROJECTION_HASH_KEY);
  const defaultId = typeof metas?.get(DEFAULT_KEY) === 'string' ? metas.get(DEFAULT_KEY) : null;

  if (typeof hash === 'string' && hash !== sha256Hex(json)) return { templates: projection, defaultId };
  const entries = new Map();

  metas?.forEach((value, key) => {
    if (!key.startsWith(TEMPLATE_PREFIX) || typeof value !== 'string') return;
    const id = key.slice(TEMPLATE_PREFIX.length);
    const entry = parseJson(value);

    if (entry === null || (isRecord(entry) && entry.template_id === id)) entries.set(id, entry);
  });
  const merged = [];

  for (const template of projection) {
    const updated = entries.get(template.template_id);

    entries.delete(template.template_id);
    if (updated !== null) merged.push(updated ?? template);
  }
  for (const id of [...entries.keys()].sort()) if (entries.get(id)) merged.push(entries.get(id));
  return { templates: merged, defaultId };
}

/**
 * Adds or replaces one template (matched by name, case-insensitively) and optionally makes it the default. Call inside
 * the database transaction. Returns { template_id, replaced }.
 */
export function writeRowTemplate(metas, { name, blocks, makeDefault = true, nowMs = Date.now() }) {
  const { templates } = readRowTemplates(metas);
  const existing = templates.find((template) => String(template.name).trim().toLowerCase() === name.trim().toLowerCase());
  const record = {
    template_id: existing?.template_id ?? randomUUID(),
    name: name.trim(),
    doc_view_id: '',
    doc_data: encodeTemplateBody(blocks),
    is_document_empty: blocks.length === 0,
    embedded_databases: [],
    default_cells: existing?.default_cells ?? [],
    icon: existing?.icon ?? '',
    cover: existing?.cover ?? '',
    created_at_ms: existing?.created_at_ms ?? nowMs,
    updated_at_ms: nowMs,
  };
  const next = existing ? templates.map((template) => (template.template_id === record.template_id ? record : template)) : [...templates, record];
  const json = JSON.stringify(next);

  metas.set(`${TEMPLATE_PREFIX}${record.template_id}`, JSON.stringify(record));
  metas.set(PROJECTION_KEY, json);
  metas.set(PROJECTION_HASH_KEY, sha256Hex(json));
  if (makeDefault) metas.set(DEFAULT_KEY, record.template_id);
  return { template_id: record.template_id, replaced: Boolean(existing) };
}

/**
 * Root block ids a card body copied from one of this database's templates can carry: the root of each frozen body
 * (`doc_data`) and, for templates whose body lives in a separate document (`doc_view_id`), that document's root.
 */
export function templateRootIds(metas, pageIdOfDocument) {
  const roots = new Set();

  for (const template of readRowTemplates(metas).templates) {
    if (Array.isArray(template.doc_data) && template.doc_data.length) {
      try {
        roots.add(DocumentDataPB.decode(Uint8Array.from(template.doc_data)).page_id);
      } catch {
        // An unreadable body cannot be the source of a new card's body.
      }
    }
    if (typeof template.doc_view_id === 'string' && template.doc_view_id) roots.add(pageIdOfDocument(template.doc_view_id));
  }
  roots.delete('');
  return roots;
}

/** The default template's body blocks, or null when the database has no default template with a body. */
export function defaultTemplateBlocks(metas) {
  const { templates, defaultId } = readRowTemplates(metas);
  const template = defaultId ? templates.find((candidate) => candidate.template_id === defaultId) : null;

  if (!template || template.is_document_empty) return null;
  const blocks = decodeTemplateBody(template.doc_data);

  return blocks.length ? { name: template.name, blocks } : null;
}
