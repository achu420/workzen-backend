import * as Y from 'yjs';

// Plain-text extraction and ranking for workspace search. Everything here is
// pure (no storage access) so it can be shared by the JSON and Postgres modes.

export const MAX_INDEX_TEXT = 200_000;

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

export function tokenize(text) {
  return typeof text === 'string' ? (text.toLowerCase().match(TOKEN_PATTERN) ?? []) : [];
}

function capText(text) {
  return text.length > MAX_INDEX_TEXT ? text.slice(0, MAX_INDEX_TEXT) : text;
}

function plainValue(value) {
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.AbstractType) return value.toJSON();
  return value;
}

function deltaText(text) {
  if (!(text instanceof Y.Text)) return '';
  // Yjs 14 exposes ops as getContent().children ({insert, format}); older builds use toDelta() ({insert, attributes}).
  const ops = typeof text.getContent === 'function' ? text.getContent().children : text.toDelta();
  let out = '';

  for (const op of ops ?? []) {
    const attributes = op.format ?? op.attributes;

    // Mentions are stored as a placeholder character carrying the target in an attribute.
    if (typeof op.insert === 'string' && !attributes?.mention) out += op.insert;
  }
  return out;
}

/** Document body text: every text block under the page root, in reading order, one block per line. */
export function extractDocumentText(docState) {
  const doc = new Y.Doc();

  try {
    Y.applyUpdate(doc, docState);
    const document = doc.getMap('data').get('document');

    if (!(document instanceof Y.Map)) return '';
    const blocks = document.get('blocks');
    const meta = document.get('meta');
    const childrenMap = meta instanceof Y.Map ? meta.get('children_map') : null;
    const textMap = meta instanceof Y.Map ? meta.get('text_map') : null;
    const rootId = document.get('page_id');

    if (!(blocks instanceof Y.Map) || !(childrenMap instanceof Y.Map) || !(textMap instanceof Y.Map) || typeof rootId !== 'string') return '';
    const lines = [];
    const seen = new Set();
    let size = 0;
    const visit = (blockId, depth) => {
      if (seen.has(blockId) || depth > 64 || size > MAX_INDEX_TEXT) return;
      seen.add(blockId);
      const block = blocks.get(blockId);

      if (!(block instanceof Y.Map)) return;
      const externalId = block.get('external_id');
      const line = block.get('external_type') === 'text' && typeof externalId === 'string' ? deltaText(textMap.get(externalId)).trim() : '';

      if (line) {
        lines.push(line);
        size += line.length + 1;
      }
      const childIds = childrenMap.get(block.get('children'));

      if (childIds instanceof Y.Array) {
        for (const childId of childIds.toArray()) visit(childId, depth + 1);
      }
    };

    visit(rootId, 0);
    return capText(lines.join('\n'));
  } finally {
    doc.destroy();
  }
}

/** Fields (type, primary flag, select option names) and the live row ids of a Database collab. */
export function extractDatabaseSchema(docState) {
  const doc = new Y.Doc();

  try {
    Y.applyUpdate(doc, docState);
    const database = doc.getMap('data').get('database');
    const schema = { databaseId: null, fields: new Map(), rowIds: [], primaryFieldId: null };

    if (!(database instanceof Y.Map)) return schema;
    schema.databaseId = database.get('id') ?? null;
    const fields = database.get('fields');

    if (fields instanceof Y.Map) {
      for (const [fieldId, field] of fields.entries()) {
        if (!(field instanceof Y.Map)) continue;
        const type = Number(field.get('ty'));
        const options = new Map();

        if (type === 3 || type === 4) {
          const typeOption = field.get('type_option');
          const config = typeOption instanceof Y.Map ? typeOption.get(String(type)) : null;
          let content = config instanceof Y.Map ? config.get('content') : null;

          try {
            content = typeof content === 'string' ? JSON.parse(content) : null;
          } catch {
            content = null;
          }
          for (const option of Array.isArray(content?.options) ? content.options : []) {
            if (option && typeof option.id === 'string' && typeof option.name === 'string') options.set(option.id, option.name);
          }
        }
        const isPrimary = field.get('is_primary') === true;

        schema.fields.set(fieldId, { type, name: String(field.get('name') ?? ''), isPrimary, options });
        if (isPrimary) schema.primaryFieldId = fieldId;
      }
    }
    const views = database.get('views');
    const rowIds = new Set();

    if (views instanceof Y.Map) {
      for (const view of views.values()) {
        const orders = view instanceof Y.Map ? view.get('row_orders') : null;

        if (!(orders instanceof Y.Array)) continue;
        for (const order of orders.toArray()) {
          if (order && typeof order.id === 'string' && order.is_deleted !== true) rowIds.add(order.id);
        }
      }
    }
    schema.rowIds = [...rowIds];
    return schema;
  } finally {
    doc.destroy();
  }
}

function cellText(field, cell) {
  const value = plainValue(cell.get('data'));

  if (value === null || value === undefined || value === '') return '';
  switch (field.type) {
    case 2: {
      const seconds = Number(value);

      return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : '';
    }
    case 3:
    case 4:
      return String(value).split(',').map((id) => id.trim()).filter(Boolean).map((id) => field.options.get(id) ?? '').filter(Boolean).join(', ');
    case 0:
    case 1:
    case 6:
      return String(value);
    default:
      return typeof value === 'string' ? value : '';
  }
}

const FIELD_TYPE_NAMES = { 0: 'text', 1: 'number', 2: 'date', 3: 'single select', 4: 'multi select', 5: 'checkbox', 6: 'url', 7: 'checklist' };

function formatTimestamp(seconds, withTime) {
  const iso = new Date(seconds * 1000).toISOString();

  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
}

// Display text for one cell, keeping what search drops: checkbox state, dates with their time and range,
// checklist progress. Select ids become option names.
function cellDisplayText(field, cell) {
  const value = plainValue(cell.get('data'));

  if (field.type === 5) return ['yes', 'true', '1'].includes(String(value ?? '').toLowerCase()) ? 'yes' : 'no';
  if (value === null || value === undefined || value === '') return '';
  if (field.type === 2) {
    const start = Number(value);

    if (!Number.isFinite(start) || start <= 0) return '';
    const withTime = plainValue(cell.get('include_time')) === true;
    const end = Number(plainValue(cell.get('end_timestamp')));

    return plainValue(cell.get('is_range')) === true && Number.isFinite(end) && end > 0
      ? `${formatTimestamp(start, withTime)} to ${formatTimestamp(end, withTime)}`
      : formatTimestamp(start, withTime);
  }
  if (field.type === 7) {
    try {
      const checklist = JSON.parse(String(value));
      const selected = new Set(Array.isArray(checklist.selected_option_ids) ? checklist.selected_option_ids : []);

      return (Array.isArray(checklist.options) ? checklist.options : []).map((option) => `${selected.has(option.id) ? '[x]' : '[ ]'} ${option.name}`).join(', ');
    } catch {
      return '';
    }
  }
  return cellText(field, cell);
}

/**
 * Every field of one row in schema order with a display value: `{rowId, databaseId, fields:[{fieldId, name, type,
 * typeName, isPrimary, text}]}`. `text` is '' for an empty cell. Used for the per-card AI context.
 */
export function extractRowFields(schema, rowDocState) {
  const doc = new Y.Doc();

  try {
    Y.applyUpdate(doc, rowDocState);
    const row = doc.getMap('data').get('data');

    if (!(row instanceof Y.Map)) return null;
    const cells = row.get('cells');
    const fields = [];

    for (const [fieldId, field] of schema.fields.entries()) {
      const cell = cells instanceof Y.Map ? cells.get(fieldId) : null;

      fields.push({
        fieldId,
        name: field.name,
        type: field.type,
        typeName: FIELD_TYPE_NAMES[field.type] ?? 'other',
        isPrimary: field.isPrimary,
        text: cell instanceof Y.Map ? cellDisplayText(field, cell).trim() : '',
      });
    }
    fields.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    return { rowId: row.get('id') ?? null, databaseId: row.get('database_id') ?? null, fields };
  } finally {
    doc.destroy();
  }
}

/** Row text: the primary cell as the title and every readable cell as content. */
export function extractRowText(schema, rowDocState) {
  const doc = new Y.Doc();

  try {
    Y.applyUpdate(doc, rowDocState);
    const row = doc.getMap('data').get('data');

    if (!(row instanceof Y.Map)) return null;
    const cells = row.get('cells');
    const parts = [];
    let title = '';

    if (cells instanceof Y.Map) {
      for (const [fieldId, cell] of cells.entries()) {
        const field = schema.fields.get(fieldId);

        if (!field || !(cell instanceof Y.Map)) continue;
        const text = cellText(field, cell).trim();

        if (!text) continue;
        if (field.isPrimary) title = text;
        parts.push(text);
      }
    }
    return { rowId: row.get('id') ?? null, databaseId: row.get('database_id') ?? null, title, content: capText(parts.join('\n')) };
  } finally {
    doc.destroy();
  }
}

export function queryTerms(query) {
  return [...new Set(tokenize(query))].slice(0, 8);
}

/**
 * Score one indexed document for the query terms, or null when it does not match.
 * Every term must be a token prefix; title matches outrank body matches, then
 * term frequency, then recency (a tiebreaker only).
 */
export function scoreSearchDocument(doc, terms, now = Date.now()) {
  const titleTokens = tokenize(doc.title);
  const bodyTokens = tokenize(doc.content);
  let titleHits = 0;
  let bodyHits = 0;

  for (const term of terms) {
    const inTitle = titleTokens.filter((token) => token.startsWith(term)).length;
    const inBody = bodyTokens.filter((token) => token.startsWith(term)).length;

    if (!inTitle && !inBody) return null;
    titleHits += inTitle;
    bodyHits += inBody;
  }
  const exactTitle = terms.length > 0 && titleTokens.join(' ') === terms.join(' ') ? 1 : 0;
  const ageDays = Math.max(0, (now - Date.parse(doc.updated_at || 0)) / 86_400_000);
  const recency = Number.isFinite(ageDays) ? 1 / (1 + ageDays) : 0;

  return 10 * Math.min(titleHits, 3) + 5 * exactTitle + Math.min(bodyHits, 10) + recency;
}

/** A short snippet of `text` around the first query-term match, with ellipses where it was cut. */
export function buildPreview(text, terms, size) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const max = Number.isFinite(size) && size > 0 ? Math.min(Math.floor(size), 500) : 80;

  if (clean.length <= max) return clean;
  const lower = clean.toLowerCase();
  const positions = terms.map((term) => lower.search(new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'))).filter((index) => index >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, Math.min(first - Math.floor(max / 4), clean.length - max));
  const end = Math.min(clean.length, start + max);

  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`;
}
