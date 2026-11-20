// Card service for the Light MCP integration: read, create, update, move, archive and restore
// the "cards" of an AppFlowy database (a card is a DatabaseRow Yjs collab; a Board is a database
// view whose columns are the options of a single-select grouping field).
//
// This module has no MCP/protocol knowledge. It talks to the existing store (storage.js /
// postgres-storage.js public methods only) and reports every persisted Yjs diff through an
// injected `broadcast` callback so the integration step can fan it out over the existing
// WebSocket subscription registry. See docs/LIGHT_MCP_ARCHITECTURE_REPORT.md for the contracts
// this was verified against.
import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { createInitialDatabaseRowCollab } from './database-row-document.js';
import { rowDocumentIdFromRowId } from './page-document.js';
import { readCardBody } from './card-body.js';
import { addRowComment, deleteRowComment, readRowComments, setRowCommentResolved } from './row-comments.js';
import { buildReadableIndex, searchWorkspace } from './search-index.js';

/**
 * Errors the MCP layer maps to tool errors (`isError: true`).
 * INVALID_INPUT   the request is malformed or contradicts itself (fix the arguments)
 * NOT_FOUND       database/card/view/column target does not exist in this workspace
 * AMBIGUOUS       a name matches several things (duplicate field or option names, several Boards)
 * CONFLICT        idempotency key reused with a different request
 * UNSUPPORTED     valid request the v1 service deliberately does not support
 * PARTIAL_FAILURE a multi-step mutation completed only partly; `details` says which part
 * FORBIDDEN       reserved for the caller's authorisation layer
 */
export class CardError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CardError';
    this.code = code;
    this.details = details ?? null;
  }
}

const FIELD = { text: 0, number: 1, date: 2, single: 3, multi: 4, checkbox: 5, url: 6 };
const WRITABLE_TYPES = new Set(Object.values(FIELD));
const TYPE_NAMES = {
  0: 'text', 1: 'number', 2: 'date', 3: 'single_select', 4: 'multi_select', 5: 'checkbox', 6: 'url', 7: 'checklist',
  8: 'last_edited_time', 9: 'created_time', 10: 'relation', 11: 'summary', 12: 'translate', 13: 'time', 14: 'media',
  15: 'person', 16: 'rollup', 17: 'created_by', 18: 'last_edited_by', 19: 'formula',
};
const LAYOUT_BOARD = 1;
const NO_STATUS = 'No status';
const DEFAULT_ROW_HEIGHT = 36;
const RICH_TEXT_FORMAT_VERSION = 1;
const MAX_TEXT = 10_000;
const MAX_TITLE = 1_000;
const MAX_URL = 2_048;
const MAX_RETRIES = 3;
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEmptyUpdate = (update) => update.byteLength === 2 && update[0] === 0 && update[1] === 0;
const lower = (value) => String(value ?? '').trim().toLowerCase();
const unixNow = (now) => String(Math.floor(now().getTime() / 1000));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function uuidFromHash(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

// ------------------------------------------------------------------ dates
// AppFlow-Web stores a date cell as unix seconds in `data` (+ include_time/is_range/end_timestamp)
// and renders it in the viewer's local zone (dayjs.unix(...).format). A date-only value therefore
// has no zone of its own; v1 pins date-only values to midnight in the service's `timeZone`
// (default UTC) and reads them back in the same zone, so a write/read round trip is exact.
function zoneOffsetMs(timeZone, epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));

  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

function zonedToUnixSeconds({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let epoch = guess - zoneOffsetMs(timeZone, guess);

  epoch = guess - zoneOffsetMs(timeZone, epoch);
  return Math.floor(epoch / 1000);
}

function formatDateValue(seconds, includeTime, timeZone) {
  if (includeTime) return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(seconds * 1000));
  const get = (type) => parts.find((part) => part.type === type)?.value;

  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseDateInput(value, timeZone, fieldName) {
  if (typeof value !== 'string') throw new CardError('INVALID_INPUT', `Field "${fieldName}" expects a date string: "YYYY-MM-DD" or an ISO 8601 date-time such as "2026-03-02T10:00:00Z".`);
  const text = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);

  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1).map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));

    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      throw new CardError('INVALID_INPUT', `Field "${fieldName}": "${text}" is not a real calendar date.`);
    }
    return { seconds: zonedToUnixSeconds({ year, month, day }, timeZone), includeTime: false };
  }
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(text);

  if (!dateTime) {
    throw new CardError('INVALID_INPUT', `Field "${fieldName}": "${text}" is not a supported date. Use "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm[:ss][Z|+HH:mm]".`);
  }
  const [year, month, day, hour, minute] = dateTime.slice(1, 6).map(Number);
  const second = dateTime[6] ? Number(dateTime[6]) : 0;
  const offset = dateTime[7];
  let seconds;

  if (offset) {
    const sign = offset === 'Z' ? 0 : (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(4, 6)) * 60);

    seconds = Math.floor(Date.UTC(year, month - 1, day, hour, minute, second) / 1000) - sign;
  } else {
    seconds = zonedToUnixSeconds({ year, month, day, hour, minute, second }, timeZone);
  }
  if (!Number.isFinite(seconds) || hour > 23 || minute > 59 || second > 59) throw new CardError('INVALID_INPUT', `Field "${fieldName}": "${text}" is not a valid time.`);
  return { seconds, includeTime: true };
}

// ------------------------------------------------------------------ yjs reading
function decode(state, guid) {
  const doc = new Y.Doc({ guid });

  Y.applyUpdate(doc, state);
  return doc;
}

function parseOptions(field, type) {
  const typeOption = field.get('type_option');
  const config = typeOption instanceof Y.Map ? typeOption.get(String(type)) : null;
  let content = config instanceof Y.Map ? config.get('content') : null;

  try {
    content = typeof content === 'string' ? JSON.parse(content) : null;
  } catch {
    content = null;
  }
  return (Array.isArray(content?.options) ? content.options : [])
    .filter((option) => option && typeof option.id === 'string' && typeof option.name === 'string')
    .map((option) => ({ id: option.id, name: option.name, color: typeof option.color === 'string' ? option.color : null }));
}

/** Everything cards.js needs from a Database collab, decoded once. */
function readDatabaseModel(docState, databaseId) {
  const doc = decode(docState, databaseId);

  try {
    const database = doc.getMap('data').get('database');

    if (!(database instanceof Y.Map) || database.get('id') !== databaseId) return null;
    const fieldMap = database.get('fields');
    const viewMap = database.get('views');
    const inlineViewId = database.get('metas') instanceof Y.Map ? database.get('metas').get('iid') ?? null : null;
    const views = [];
    const fields = [];

    if (viewMap instanceof Y.Map) {
      for (const [viewId, view] of viewMap.entries()) {
        if (!(view instanceof Y.Map)) continue;
        const orders = view.get('row_orders');
        const groups = view.get('groups');
        const first = groups instanceof Y.Array && groups.length > 0 ? groups.get(0) : null;
        const groupColumns = first instanceof Y.Map && first.get('groups') instanceof Y.Array
          ? first.get('groups').toArray().map((column) => (column instanceof Y.Map ? column.get('id') : column?.id)).filter((id) => typeof id === 'string')
          : [];

        views.push({
          id: viewId,
          name: String(view.get('name') ?? ''),
          layout: Number(view.get('layout')),
          isInline: view.get('is_inline') === true,
          createdAt: Number(view.get('created_at')) || 0,
          rowOrders: orders instanceof Y.Array ? orders.toArray().filter((entry) => entry && typeof entry.id === 'string').map((entry) => ({ id: entry.id, height: entry.height, is_deleted: entry.is_deleted === true })) : [],
          fieldOrder: view.get('field_orders') instanceof Y.Array ? view.get('field_orders').toArray().map((entry) => entry?.id).filter(Boolean) : [],
          group: first instanceof Y.Map ? { fieldId: first.get('field_id') ?? null, columns: groupColumns } : null,
        });
      }
    }
    if (fieldMap instanceof Y.Map) {
      for (const [fieldId, field] of fieldMap.entries()) {
        if (!(field instanceof Y.Map)) continue;
        const type = Number(field.get('ty'));

        fields.push({
          id: fieldId,
          name: String(field.get('name') ?? ''),
          type,
          typeName: TYPE_NAMES[type] ?? 'other',
          isPrimary: field.get('is_primary') === true,
          writable: WRITABLE_TYPES.has(type),
          options: type === FIELD.single || type === FIELD.multi ? parseOptions(field, type) : [],
        });
      }
    }
    const order = (views.find((view) => view.id === inlineViewId) ?? views[0])?.fieldOrder ?? [];

    fields.sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);

      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    });
    // created_at has one-second resolution and Yjs decodes map entries by client id, so ties need a stable key.
    views.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return {
      id: databaseId,
      fields,
      fieldsById: new Map(fields.map((field) => [field.id, field])),
      views,
      viewsById: new Map(views.map((view) => [view.id, view])),
      inlineViewId,
      primaryField: fields.find((field) => field.isPrimary) ?? null,
    };
  } finally {
    doc.destroy();
  }
}

function readRowState(rowState) {
  const doc = decode(rowState);

  try {
    const row = doc.getMap('data').get('data');

    if (!(row instanceof Y.Map)) return null;
    const cells = new Map();
    const cellMap = row.get('cells');

    if (cellMap instanceof Y.Map) {
      for (const [fieldId, cell] of cellMap.entries()) if (cell instanceof Y.Map) cells.set(fieldId, cell.toJSON());
    }
    return {
      id: row.get('id') ?? null,
      databaseId: row.get('database_id') ?? null,
      createdAt: Number(row.get('created_at')) || 0,
      lastModified: Number(row.get('last_modified')) || 0,
      cells,
    };
  } finally {
    doc.destroy();
  }
}

const isoFromSeconds = (seconds) => (seconds > 0 ? new Date(seconds * 1000).toISOString().replace('.000Z', 'Z') : null);

function optionByIdOrName(field, raw) {
  const value = String(raw ?? '').trim();

  return value ? field.options.find((option) => option.id === value) ?? field.options.find((option) => option.name === value) ?? null : null;
}

function readCellValue(field, cell, timeZone) {
  if (!cell) return null;
  const raw = cell.data;

  switch (field.type) {
    case FIELD.text:
    case FIELD.url:
      return typeof raw === 'string' && raw !== '' ? raw : null;
    case FIELD.number: {
      if (raw === '' || raw === null || raw === undefined) return null;
      const number = Number(raw);

      return Number.isFinite(number) ? number : String(raw);
    }
    case FIELD.date: {
      const start = Number(raw);

      if (!Number.isFinite(start) || start <= 0 || raw === '') return null;
      const includeTime = cell.include_time === true;
      const end = Number(cell.end_timestamp);

      return cell.is_range === true && Number.isFinite(end) && end > 0
        ? { start: formatDateValue(start, includeTime, timeZone), end: formatDateValue(end, includeTime, timeZone) }
        : formatDateValue(start, includeTime, timeZone);
    }
    case FIELD.single:
      return optionByIdOrName(field, raw)?.name ?? null;
    case FIELD.multi: {
      const names = String(raw ?? '').split(',').map((part) => optionByIdOrName(field, part)?.name).filter(Boolean);

      return names.length ? names : null;
    }
    case FIELD.checkbox:
      return ['yes', 'true', '1', 'checked', 'x', '[x]', 'on'].includes(lower(raw));
    default:
      return typeof raw === 'string' && raw !== '' ? raw : null;
  }
}

function boardsOf(model) {
  return model.views.filter((view) => view.layout === LAYOUT_BOARD).map((view) => {
    const fallback = model.fields.find((field) => [FIELD.single, FIELD.multi, FIELD.checkbox].includes(field.type));
    const fieldId = view.group?.fieldId && model.fieldsById.has(view.group.fieldId) ? view.group.fieldId : fallback?.id ?? null;

    return { view, groupField: fieldId ? model.fieldsById.get(fieldId) : null };
  });
}

/** Column id of a row for a single-select grouping field: the option id, or null for "No status". */
function columnOf(groupField, cell) {
  if (!groupField || groupField.type !== FIELD.single || !cell) return null;
  return optionByIdOrName(groupField, cell.data)?.id ?? null;
}

function rowArchived(model, rowId) {
  let seen = 0;

  for (const view of model.views) {
    for (const entry of view.rowOrders) {
      if (entry.id !== rowId) continue;
      seen += 1;
      if (!entry.is_deleted) return false;
    }
  }
  return seen > 0;
}

function rowKnown(model, rowId) {
  return model.views.some((view) => view.rowOrders.some((entry) => entry.id === rowId));
}

// ------------------------------------------------------------------ cursors
function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeCursor(cursor, expected) {
  let payload;

  try {
    payload = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new CardError('INVALID_INPUT', 'The cursor is not valid. Start again without a cursor.');
  }
  if (!isPlainObject(payload) || payload.v !== 1 || payload.d !== expected.databaseId || (payload.w ?? null) !== (expected.viewId ?? null) ||
      (payload.c ?? null) !== (expected.column ?? null) || (payload.q ?? null) !== (expected.query ?? null) || (payload.a ?? 'exclude') !== expected.archived) {
    throw new CardError('INVALID_INPUT', 'The cursor does not belong to this request. Start again without a cursor.');
  }
  return payload;
}

// ------------------------------------------------------------------ service
/**
 * @param {object} options
 * @param {object} options.store storage.js / postgres-storage.js store (public methods only)
 * @param {(event:{workspaceId:string,collabType:number,objectId:string,update:Uint8Array,beforeStateVector:Uint8Array|null,accepted:object|null})=>unknown} [options.broadcast]
 *   called AFTER a diff is persisted (collabType 1 = Database, 4 = DatabaseRow); failures are swallowed
 * @param {(args:{workspaceId:string,databaseId:string,query:string})=>Promise<string[]|null>} [options.searchRows]
 *   optional candidate provider (e.g. createIndexRowCandidates); candidates are always re-verified against live membership
 * @param {(permission:object)=>boolean} [options.isReadableSpace] default: space visibility is "public"
 * @param {string} [options.timeZone] IANA zone for date-only values (default UTC)
 */
export function createCardService({
  store,
  broadcast = async () => {},
  searchRows = null,
  isReadableSpace = (permission) => permission?.visibility === 'public',
  timeZone = 'UTC',
  now = () => new Date(),
  newId = () => randomUUID(),
  log = (...args) => console.error('cards', ...args),
} = {}) {
  if (!store) throw new Error('createCardService needs a store');

  async function emit(event) {
    try {
      await broadcast(event);
    } catch (error) {
      log('broadcast failed (the change is already persisted)', error?.message ?? error);
    }
  }

  async function readableIndex(workspaceId) {
    return buildReadableIndex(store, { id: workspaceId }, isReadableSpace);
  }

  async function loadDatabase(workspaceId, databaseId, index = null) {
    const readable = index ?? await readableIndex(workspaceId);
    const container = readable.containers.get(databaseId);

    if (!container) throw new CardError('NOT_FOUND', `Database "${databaseId}" was not found. Use list_databases to see the available databases.`);
    const collab = await store.getDatabaseCollab(workspaceId, databaseId);
    const model = collab ? readDatabaseModel(collab.doc_state, databaseId) : null;

    if (!model) throw new CardError('NOT_FOUND', `Database "${databaseId}" was not found.`);
    return { model, container, name: container.title || model.views[0]?.name || '', readable };
  }

  async function loadCardContext(workspaceId, cardId) {
    if (typeof cardId !== 'string' || !cardId) throw new CardError('INVALID_INPUT', 'card_id is required.');
    const rowCollab = await store.getDatabaseRowCollab(workspaceId, cardId);
    const row = rowCollab ? readRowState(rowCollab.doc_state) : null;

    if (!row || !row.databaseId) throw new CardError('NOT_FOUND', `Card "${cardId}" was not found.`);
    const context = await loadDatabase(workspaceId, row.databaseId).catch((error) => {
      if (error instanceof CardError) throw new CardError('NOT_FOUND', `Card "${cardId}" was not found.`);
      throw error;
    });

    if (!rowKnown(context.model, cardId)) throw new CardError('NOT_FOUND', `Card "${cardId}" was not found.`);
    return { ...context, row, rowCollab };
  }

  function toCard(context, row, board) {
    const { model, name } = context;
    const nameCount = new Map();

    for (const field of model.fields) nameCount.set(lower(field.name), (nameCount.get(lower(field.name)) ?? 0) + 1);
    const fields = {};

    for (const field of model.fields) {
      if (field.isPrimary) continue;
      const value = readCellValue(field, row.cells.get(field.id), timeZone);

      if (value === null || value === undefined) continue;
      fields[nameCount.get(lower(field.name)) > 1 ? `${field.name} [${field.id}]` : field.name] = value;
    }
    const primaryCell = model.primaryField ? row.cells.get(model.primaryField.id) : null;
    const hasBoard = Boolean(board?.groupField && board.groupField.type === FIELD.single);
    const columnId = hasBoard ? columnOf(board.groupField, row.cells.get(board.groupField.id)) : null;
    const column = hasBoard ? (columnId ? board.groupField.options.find((option) => option.id === columnId).name : NO_STATUS) : null;

    return {
      id: row.id,
      database_id: model.id,
      database_name: name,
      title: typeof primaryCell?.data === 'string' ? primaryCell.data : '',
      column,
      column_id: hasBoard ? columnId : null,
      fields,
      archived: rowArchived(model, row.id),
      created_at: isoFromSeconds(row.createdAt),
      updated_at: isoFromSeconds(row.lastModified),
    };
  }

  // -------------------------------------------------------------- field resolution
  function resolveField(model, name, { forWrite = false } = {}) {
    const wanted = String(name ?? '').trim();
    const byId = model.fieldsById.get(wanted);
    const matches = byId ? [byId] : model.fields.filter((field) => lower(field.name) === lower(wanted));

    if (matches.length === 0) {
      throw new CardError('INVALID_INPUT', `Unknown field "${wanted}". Fields: ${model.fields.map((field) => `"${field.name}"`).join(', ')}.`);
    }
    if (matches.length > 1) {
      throw new CardError('AMBIGUOUS', `Several fields are named "${wanted}": ${matches.map((field) => field.id).join(', ')}. Use a field id instead.`);
    }
    const field = matches[0];

    if (forWrite && !field.writable) {
      throw new CardError('UNSUPPORTED', `Field "${field.name}" has type ${field.typeName} which cannot be written in v1. Writable types: text, number, date, single_select, multi_select, checkbox, url.`);
    }
    return field;
  }

  function resolveOption(field, name) {
    const wanted = lower(name);
    const matches = field.options.filter((option) => lower(option.name) === wanted || option.id === String(name).trim());

    if (matches.length === 0) {
      throw new CardError('INVALID_INPUT', `"${name}" is not an option of "${field.name}". Valid options: ${field.options.map((option) => `"${option.name}"`).join(', ') || '(none)'}.`);
    }
    const byName = matches.filter((option) => lower(option.name) === wanted);

    if (byName.length > 1) throw new CardError('AMBIGUOUS', `Several options of "${field.name}" are named "${name}" (${byName.map((option) => option.id).join(', ')}). Rename one in AppFlowy first.`);
    return byName[0] ?? matches[0];
  }

  /** Converts one requested value to the stored cell data (and date extras); throws CardError when it is not representable. */
  function buildCellWrite(field, value) {
    const label = `Field "${field.name}"`;

    switch (field.type) {
      case FIELD.text: {
        if (value === null) return { data: '' };
        if (typeof value !== 'string') throw new CardError('INVALID_INPUT', `${label} expects text.`);
        if (value.length > MAX_TEXT) throw new CardError('INVALID_INPUT', `${label} is limited to ${MAX_TEXT} characters.`);
        return { data: value };
      }
      case FIELD.url: {
        if (value === null) return { data: '' };
        if (typeof value !== 'string' || value.length > MAX_URL) throw new CardError('INVALID_INPUT', `${label} expects a URL of at most ${MAX_URL} characters.`);
        if (/^\s*(javascript|data|vbscript):/i.test(value)) throw new CardError('INVALID_INPUT', `${label}: this URL scheme is not allowed.`);
        return { data: value };
      }
      case FIELD.number: {
        if (value === null || value === '') return { data: '' };
        const number = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

        if (!Number.isFinite(number)) throw new CardError('INVALID_INPUT', `${label} expects a number.`);
        return { data: String(number) };
      }
      case FIELD.checkbox: {
        if (typeof value !== 'boolean') throw new CardError('INVALID_INPUT', `${label} expects true or false.`);
        return { data: value ? 'Yes' : 'No' };
      }
      case FIELD.single: {
        if (value === null || value === '') return { data: '' };
        if (typeof value !== 'string') throw new CardError('INVALID_INPUT', `${label} expects an option name.`);
        return { data: resolveOption(field, value).id };
      }
      case FIELD.multi: {
        if (value === null) return { data: '' };
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new CardError('INVALID_INPUT', `${label} expects a list of option names.`);
        return { data: [...new Set(value.map((item) => resolveOption(field, item).id))].join(',') };
      }
      case FIELD.date: {
        if (value === null || value === '') return { data: '', date: { include_time: false, is_range: false, end_timestamp: '' } };
        if (isPlainObject(value)) throw new CardError('UNSUPPORTED', `${label}: date ranges are read-only in v1. Provide a single date.`);
        const parsed = parseDateInput(value, timeZone, field.name);

        return { data: String(parsed.seconds), date: { include_time: parsed.includeTime, is_range: false, end_timestamp: '' } };
      }
      default:
        throw new CardError('UNSUPPORTED', `${label} has type ${field.typeName} which cannot be written in v1.`);
    }
  }

  /** Splits title/fields into validated writes keyed by field id. */
  function planWrites(model, { title, fields }, { forbidFieldId = null } = {}) {
    if (fields !== undefined && fields !== null && !isPlainObject(fields)) throw new CardError('INVALID_INPUT', '`fields` must be an object of field name to value.');
    if (!model.primaryField) throw new CardError('UNSUPPORTED', 'This database has no title field.');
    const writes = new Map();
    const requested = Object.entries(fields ?? {});

    for (const [name, value] of requested) {
      const field = resolveField(model, name, { forWrite: true });

      if (writes.has(field.id)) throw new CardError('INVALID_INPUT', `Field "${field.name}" is given more than once.`);
      if (forbidFieldId && field.id === forbidFieldId) throw new CardError('INVALID_INPUT', `Field "${field.name}" is the Board column; use \`column\` instead of \`fields\` for it.`);
      writes.set(field.id, { field, value });
    }
    if (title !== undefined) {
      if (typeof title !== 'string' || title.length > MAX_TITLE) throw new CardError('INVALID_INPUT', `title must be a string of at most ${MAX_TITLE} characters.`);
      if (writes.has(model.primaryField.id)) throw new CardError('INVALID_INPUT', `Both \`title\` and \`fields\` set "${model.primaryField.name}" (the title field). Provide only one.`);
      if (model.primaryField.type !== FIELD.text) throw new CardError('UNSUPPORTED', 'The title field is not a text field, so the title cannot be written.');
      writes.set(model.primaryField.id, { field: model.primaryField, value: title });
    }
    return [...writes.values()].map(({ field, value }) => ({ field, write: buildCellWrite(field, value) }));
  }

  // -------------------------------------------------------------- yjs mutation helpers
  async function mutateObject({ workspaceId, objectId, collabType, load, accept, mutate }) {
    for (let attempt = 1; ; attempt += 1) {
      const collab = await load(workspaceId, objectId);

      if (!collab) throw new CardError('NOT_FOUND', `Collaboration object "${objectId}" was not found.`);
      const doc = decode(collab.doc_state, objectId);
      const before = Y.encodeStateVector(doc);
      let result;
      let payload;

      // Yjs always re-encodes the whole delete set, so an unchanged document with any tombstone is never
      // an "empty" update: ask the transaction whether it actually created or deleted anything.
      let touched = false;
      const onAfterTransaction = (transaction) => {
        if (transaction.deleteSet.clients.size > 0) touched = true;
        for (const [client, clock] of transaction.afterState) if ((transaction.beforeState.get(client) ?? 0) !== clock) touched = true;
      };

      try {
        doc.on('afterTransaction', onAfterTransaction);
        doc.transact(() => { result = mutate(doc); });
        payload = touched ? Y.encodeStateAsUpdate(doc, before) : null;
      } finally {
        doc.destroy();
      }
      if (!touched || isEmptyUpdate(payload)) return { result, changed: false, accepted: null };
      let accepted;

      try {
        accepted = await accept({ workspaceId, [collabType === 4 ? 'rowId' : 'databaseId']: objectId, flags: 0, payload, beforeStateVector: before });
      } catch (error) {
        if (error?.code === 'CONCURRENT_UPDATE' && attempt < MAX_RETRIES) continue;
        throw error;
      }
      await emit({ workspaceId, collabType, objectId, update: payload, beforeStateVector: before, accepted });
      return { result, changed: true, accepted };
    }
  }

  const mutateRow = (workspaceId, rowId, mutate) => mutateObject({
    workspaceId, objectId: rowId, collabType: 4,
    load: (ws, id) => store.getDatabaseRowCollab(ws, id),
    accept: (args) => store.acceptDatabaseRowCollabUpdate(args),
    mutate,
  });

  const mutateDatabase = (workspaceId, databaseId, mutate) => mutateObject({
    workspaceId, objectId: databaseId, collabType: 1,
    load: (ws, id) => store.getDatabaseCollab(ws, id),
    accept: (args) => store.acceptDatabaseCollabUpdate(args),
    mutate,
  });

  async function actorUid(userId) {
    if (!userId) return null;
    const user = await store.getUserById(userId).catch(() => null);
    const uid = user?.uid;

    return uid === undefined || uid === null ? null : String(uid);
  }

  /** Same shape and rules as AppFlowy-Web's writeCellToRow; returns whether anything changed. */
  function applyCellWrite(cellsMap, field, write, stamp) {
    let cell = cellsMap.get(field.id);
    const wantsDate = field.type === FIELD.date && write.date;

    if (!(cell instanceof Y.Map)) {
      if (write.data === '' && !wantsDate) return false;
      cell = new Y.Map();
      cell.set('created_at', stamp);
      cell.set('field_type', field.type);
      cell.set('data', write.data);
      cell.set('last_modified', stamp);
      if (wantsDate) {
        cell.set('end_timestamp', write.date.end_timestamp);
        cell.set('include_time', write.date.include_time);
        cell.set('is_range', write.date.is_range);
      }
      cellsMap.set(field.id, cell);
      return true;
    }
    const previous = cell.get('data');
    const sameData = String(previous ?? '') === write.data;
    const sameDate = !wantsDate || (cell.get('include_time') === write.date.include_time && cell.get('is_range') === write.date.is_range &&
      String(cell.get('end_timestamp') ?? '') === write.date.end_timestamp);

    if (sameData && sameDate && cell.get('field_type') === field.type) return false;
    if (field.type === FIELD.text || field.type === FIELD.url) guardRichText(cell, field);
    cell.set('data', write.data);
    if (cell.has('rich_text') && previous !== write.data) cell.delete('rich_text');
    if (wantsDate) {
      cell.set('end_timestamp', write.date.end_timestamp);
      cell.set('include_time', write.date.include_time);
      cell.set('is_range', write.date.is_range);
    }
    cell.set('field_type', field.type);
    if (cell.has('source_field_type')) cell.delete('source_field_type');
    cell.set('last_modified', stamp);
    return true;
  }

  // AppFlowy-Web refuses to change a text cell whose formatting needs a newer client (rich-text-guard.ts).
  function guardRichText(cell, field) {
    const raw = cell.get('rich_text');

    if (raw === undefined || raw === null || raw === '') return;
    let newer = typeof raw !== 'string';

    if (!newer) {
      try {
        const envelope = JSON.parse(raw);

        newer = isPlainObject(envelope) && envelope.text === cell.get('data') && typeof envelope.min_v === 'number' && envelope.min_v > RICH_TEXT_FORMAT_VERSION;
      } catch {
        newer = false;
      }
    }
    if (newer) throw new CardError('UNSUPPORTED', `Field "${field.name}" contains formatting written by a newer AppFlowy client and was left unchanged.`);
  }

  function touchRow(doc, uid, stamp) {
    const row = doc.getMap('data').get('data');

    row.set('last_modified', stamp);
    if (uid !== null) row.set('last_edited_by', uid);
  }

  // -------------------------------------------------------------- public API
  async function listDatabases({ workspaceId }) {
    const readable = await readableIndex(workspaceId);
    const result = [];

    for (const [databaseId, container] of readable.containers) {
      const collab = await store.getDatabaseCollab(workspaceId, databaseId);
      const model = collab ? readDatabaseModel(collab.doc_state, databaseId) : null;

      if (!model) continue;
      result.push({
        database_id: databaseId,
        name: container.title || model.views[0]?.name || '',
        workspace_id: workspaceId,
        views: model.views.map((view) => ({ view_id: view.id, name: view.name, layout: view.layout })),
        has_board: model.views.some((view) => view.layout === LAYOUT_BOARD),
        _created: container.created_at ?? '',
      });
    }
    return result.sort((a, b) => String(a._created).localeCompare(String(b._created)) || a.database_id.localeCompare(b.database_id)).map(({ _created, ...entry }) => entry);
  }

  async function readRows(workspaceId, rowIds) {
    const rows = new Map();

    for (const rowId of rowIds) {
      const collab = await store.getDatabaseRowCollab(workspaceId, rowId);
      const row = collab ? readRowState(collab.doc_state) : null;

      if (row && row.databaseId) rows.set(rowId, row);
    }
    return rows;
  }

  async function getDatabase({ workspaceId, databaseId }) {
    const context = await loadDatabase(workspaceId, databaseId);
    const { model, name } = context;
    const boards = [];

    for (const board of boardsOf(context.model)) {
      const live = board.view.rowOrders.filter((entry) => !entry.is_deleted).map((entry) => entry.id);
      const rows = await readRows(workspaceId, live);
      const entry = {
        view_id: board.view.id,
        name: board.view.name,
        group_field: board.groupField ? { id: board.groupField.id, name: board.groupField.name, type: board.groupField.typeName } : null,
        columns: [],
        has_no_status_column: false,
      };

      if (board.groupField?.type === FIELD.single) {
        const counts = new Map();

        for (const rowId of live) {
          const row = rows.get(rowId);

          if (!row) continue;
          const key = columnOf(board.groupField, row.cells.get(board.groupField.id));

          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        entry.columns = [
          { id: null, name: NO_STATUS, color: null, card_count: counts.get(null) ?? 0 },
          ...board.groupField.options.map((option) => ({ id: option.id, name: option.name, color: option.color, card_count: counts.get(option.id) ?? 0 })),
        ];
        entry.has_no_status_column = true;
      }
      boards.push(entry);
    }
    return {
      database_id: databaseId,
      name,
      title_field: model.primaryField ? { id: model.primaryField.id, name: model.primaryField.name } : null,
      fields: model.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.typeName,
        is_primary: field.isPrimary,
        writable: field.writable,
        ...(field.options.length ? { options: field.options } : {}),
      })),
      views: model.views.map((view) => ({ view_id: view.id, name: view.name, layout: view.layout })),
      boards,
    };
  }

  /** Picks the Board a request refers to. `needView` is true when ordering (a specific view) matters. */
  function pickBoard(model, viewId, { needView = false } = {}) {
    const boards = boardsOf(model);

    if (viewId) {
      const view = model.viewsById.get(viewId);

      if (!view) throw new CardError('NOT_FOUND', `View "${viewId}" does not belong to this database.`);
      if (view.layout !== LAYOUT_BOARD) throw new CardError('INVALID_INPUT', `View "${view.name}" is not a Board view.`);
      return boards.find((board) => board.view.id === viewId);
    }
    if (boards.length === 0) throw new CardError('INVALID_INPUT', 'This database has no Board view, so cards have no columns.');
    const fieldIds = new Set(boards.map((board) => board.groupField?.id ?? null));

    if (boards.length > 1 && (needView || fieldIds.size > 1)) {
      throw new CardError('AMBIGUOUS', `This database has several Board views (${boards.map((board) => `"${board.view.name}" ${board.view.id}`).join(', ')}). Pass view_id to choose one.`);
    }
    return boards[0];
  }

  function requireSelectBoard(board) {
    if (!board.groupField || board.groupField.type !== FIELD.single) {
      throw new CardError('UNSUPPORTED', `Board "${board.view.name}" is grouped by ${board.groupField ? `"${board.groupField.name}" (${board.groupField.typeName})` : 'no field'}. Only boards grouped by a single_select field are supported in v1.`);
    }
    return board;
  }

  function resolveColumn(board, column) {
    requireSelectBoard(board);
    const wanted = lower(column);
    const matches = board.groupField.options.filter((option) => lower(option.name) === wanted);

    if (matches.length > 1) throw new CardError('AMBIGUOUS', `Several columns are named "${column}" (${matches.map((option) => option.id).join(', ')}). Rename one in AppFlowy first.`);
    if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
    if (wanted === lower(NO_STATUS)) return { id: null, name: NO_STATUS };
    throw new CardError('INVALID_INPUT', `Unknown column "${column}". Columns: ${[NO_STATUS, ...board.groupField.options.map((option) => option.name)].map((name) => `"${name}"`).join(', ')}.`);
  }

  async function listCards({ workspaceId, databaseId, viewId = null, column = null, query = null, limit = PAGE_SIZE_DEFAULT, cursor = null, archived = 'exclude' }) {
    const context = await loadDatabase(workspaceId, databaseId);
    const { model } = context;
    const size = Math.min(PAGE_SIZE_MAX, Math.max(1, Number.isInteger(limit) ? limit : PAGE_SIZE_DEFAULT));

    if (!['exclude', 'only', 'include'].includes(archived)) throw new CardError('INVALID_INPUT', 'archived must be "exclude", "only" or "include".');
    const text = typeof query === 'string' && query.trim() ? query.trim().slice(0, 200) : null;
    const view = viewId ? model.viewsById.get(viewId) : (model.viewsById.get(model.inlineViewId) ?? model.views[0]);

    if (!view) throw new CardError('NOT_FOUND', `View "${viewId}" does not belong to this database.`);
    let board = null;
    let wantedColumn;

    if (column !== null && column !== undefined) {
      if (viewId && view.layout !== LAYOUT_BOARD) throw new CardError('INVALID_INPUT', `View "${view.name}" is not a Board view; columns only apply to Board views.`);
      board = pickBoard(model, view.layout === LAYOUT_BOARD ? view.id : null);
      wantedColumn = resolveColumn(board, column);
    } else if (view.layout === LAYOUT_BOARD) {
      board = boardsOf(model).find((candidate) => candidate.view.id === view.id);
    } else {
      board = boardsOf(model)[0] ?? null;
    }
    const expected = { databaseId, viewId: viewId ?? null, column: column === null || column === undefined ? null : lower(column), query: text, archived };
    const resume = cursor ? decodeCursor(cursor, expected) : null;
    const candidates = text && searchRows ? await searchRows({ workspaceId, databaseId, query: text }) : null;
    const candidateSet = Array.isArray(candidates) ? new Set(candidates) : null;
    const terms = text ? text.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const seen = new Set();
    const ordered = view.rowOrders.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      if (archived === 'exclude' && entry.is_deleted) return false;
      if (archived === 'only' && !entry.is_deleted) return false;
      return !candidateSet || candidateSet.has(entry.id);
    });
    let start = 0;

    if (resume) {
      const index = ordered.findIndex((entry) => entry.id === resume.r);

      start = index === -1 ? Math.min(Math.max(0, Number(resume.p) || 0), ordered.length) : index + 1;
    }
    const cards = [];
    let nextCursor = null;

    for (let position = start; position < ordered.length; position += 1) {
      const collab = await store.getDatabaseRowCollab(workspaceId, ordered[position].id);
      const row = collab ? readRowState(collab.doc_state) : null;

      if (!row || row.databaseId !== databaseId) continue;
      const card = toCard(context, row, board);

      if (wantedColumn && card.column_id !== wantedColumn.id) continue;
      if (terms.length) {
        const haystack = [card.title, ...Object.values(card.fields).map((value) => (Array.isArray(value) ? value.join(' ') : isPlainObject(value) ? `${value.start} ${value.end}` : String(value)))].join(' ').toLowerCase();

        if (!terms.every((term) => haystack.includes(term))) continue;
      }
      if (cards.length === size) {
        const last = cards[cards.length - 1];

        nextCursor = encodeCursor({ v: 1, d: databaseId, w: viewId ?? null, c: expected.column, q: text, a: archived, r: last.id, p: ordered.findIndex((entry) => entry.id === last.id) });
        break;
      }
      cards.push(card);
    }
    return { cards, next_cursor: nextCursor };
  }

  async function getCard({ workspaceId, cardId, includeBody = false, bodyOffset = 0, bodyMaxChars }) {
    const context = await loadCardContext(workspaceId, cardId);
    const card = toCard(context, context.row, boardsOf(context.model)[0] ?? null);

    if (!includeBody) return card;
    const body = await readCardBody({ store, workspaceId, databaseId: context.row.databaseId, rowId: cardId, offset: bodyOffset, ...(bodyMaxChars ? { maxChars: bodyMaxChars } : {}) });

    return {
      ...card, body: body.text, body_truncated: body.truncated, has_body_document: body.has_document,
      body_total_chars: body.total_chars ?? 0, body_next_offset: body.next_offset ?? null,
    };
  }

  async function createCard({ workspaceId, userId, databaseId, title, column = null, fields = {}, viewId = null, idempotencyKey, tokenId = null }) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200) {
      throw new CardError('INVALID_INPUT', 'idempotency_key is required: a unique string (1-200 characters) per intended card; reuse it only to retry the same request.');
    }
    if (typeof title !== 'string' || !title.trim()) throw new CardError('INVALID_INPUT', 'title is required.');
    const context = await loadDatabase(workspaceId, databaseId);
    const { model } = context;
    let board = null;
    let columnChoice = null;

    if (column !== null && column !== undefined) {
      board = pickBoard(model, viewId);
      columnChoice = resolveColumn(board, column);
    }
    const writes = planWrites(model, { title, fields }, { forbidFieldId: board?.groupField?.id ?? null });
    const stamp = unixNow(now);
    const cells = {};

    for (const { field, write } of writes) {
      if (write.data === '' && !write.date) continue;
      cells[field.id] = { created_at: stamp, field_type: field.type, data: write.data, last_modified: stamp };
      if (write.date) Object.assign(cells[field.id], write.date);
    }
    if (columnChoice?.id) cells[board.groupField.id] = { created_at: stamp, field_type: FIELD.single, data: columnChoice.id, last_modified: stamp };
    const principal = tokenId ?? userId ?? 'anonymous';
    const seed = `${workspaceId}|${principal}|${databaseId}|${idempotencyKey}`;
    const digest = sha256(stableJson({ database_id: databaseId, title, column: column ?? null, view_id: viewId ?? null, fields: fields ?? {} }));
    const rowId = uuidFromHash(`${seed}:row`);
    const timestamp = now().toISOString();
    const uid = await actorUid(userId);
    const rowCollab = createInitialDatabaseRowCollab({ rowId, databaseId, cells, height: DEFAULT_ROW_HEIGHT, visibility: true, timestamp, actorUid: uid ?? undefined });
    let created;

    try {
      created = await store.createSeededDatabaseRow({
        workspaceId, databaseId, rowId,
        positionViewIds: model.views.map((view) => view.id),
        position: { kind: 'end' },
        height: DEFAULT_ROW_HEIGHT,
        rowState: rowCollab.documentState,
        rowStateVector: rowCollab.stateVector,
        request: { request_id: uuidFromHash(`${seed}:request`), request_digest: digest, timestamp, update_batch_id: newId() },
      });
    } catch (error) {
      if (error?.code === 'REQUEST_ID_REUSED') throw new CardError('CONFLICT', 'This idempotency_key was already used for a different create_card request. Use a new key for a different card.');
      if (error?.code === 'ROW_EXISTS' || error?.code === 'ATOMIC_CREATION_INCOMPLETE') throw new CardError('CONFLICT', 'A card for this idempotency_key exists in an unexpected state; use a new key.');
      if (error?.code === 'DATABASE_NOT_FOUND') throw new CardError('NOT_FOUND', `Database "${databaseId}" was not found.`);
      throw error;
    }
    const replayed = created.outcome === 'already_applied';

    if (!replayed) {
      await emit({ workspaceId, collabType: 1, objectId: databaseId, update: created.database_update, beforeStateVector: null, accepted: created });
    }
    return { card: await getCard({ workspaceId, cardId: created.row_id }), replayed };
  }

  async function updateCard({ workspaceId, userId, cardId, title, fields }) {
    if (title === undefined && (fields === undefined || fields === null || Object.keys(fields).length === 0)) {
      throw new CardError('INVALID_INPUT', 'Provide `title` and/or at least one entry in `fields`.');
    }
    const context = await loadCardContext(workspaceId, cardId);
    if (rowArchived(context.model, cardId)) throw new CardError('INVALID_INPUT', 'This card is archived. Restore it with restore_card before changing it.');
    const writes = planWrites(context.model, { title, fields });
    const uid = await actorUid(userId);
    const stamp = unixNow(now);

    await mutateRow(workspaceId, cardId, (doc) => {
      const row = doc.getMap('data').get('data');
      const cells = row.get('cells');
      let changed = false;

      for (const { field, write } of writes) changed = applyCellWrite(cells, field, write, stamp) || changed;
      if (changed) touchRow(doc, uid, stamp);
    });
    return getCard({ workspaceId, cardId });
  }

  async function moveCard({ workspaceId, userId, cardId, column, viewId = null, beforeCardId = null }) {
    if (typeof column !== 'string' || !column.trim()) throw new CardError('INVALID_INPUT', 'column is required.');
    const context = await loadCardContext(workspaceId, cardId);
    if (rowArchived(context.model, cardId)) throw new CardError('INVALID_INPUT', 'This card is archived. Restore it with restore_card before changing it.');
    const { model } = context;
    const board = pickBoard(model, viewId, { needView: Boolean(beforeCardId) });
    const target = resolveColumn(board, column);
    const field = board.groupField;

    if (beforeCardId) {
      if (beforeCardId === cardId) throw new CardError('INVALID_INPUT', 'before_card_id cannot be the card being moved.');
      const entry = board.view.rowOrders.find((candidate) => candidate.id === beforeCardId && !candidate.is_deleted);

      if (!entry) throw new CardError('INVALID_INPUT', `before_card_id "${beforeCardId}" is not a card of this database's Board view "${board.view.name}".`);
      const beforeCollab = await store.getDatabaseRowCollab(workspaceId, beforeCardId);
      const beforeRow = beforeCollab ? readRowState(beforeCollab.doc_state) : null;

      if (!beforeRow || beforeRow.databaseId !== model.id) throw new CardError('INVALID_INPUT', `before_card_id "${beforeCardId}" does not belong to this database.`);
      if (columnOf(field, beforeRow.cells.get(field.id)) !== target.id) {
        throw new CardError('INVALID_INPUT', `before_card_id "${beforeCardId}" is not in column "${target.name}"; a card can only be placed before a card of its destination column.`);
      }
    }
    const uid = await actorUid(userId);
    const stamp = unixNow(now);
    const currentColumn = columnOf(field, context.row.cells.get(field.id));
    let columnChanged = false;

    if (currentColumn !== target.id) {
      const written = await mutateRow(workspaceId, cardId, (doc) => {
        const row = doc.getMap('data').get('data');
        const cells = row.get('cells');
        const applied = applyCellWrite(cells, field, { data: target.id ?? '' }, stamp);

        if (applied) touchRow(doc, uid, stamp);
        return applied;
      });

      columnChanged = written.changed;
    }
    let orderChanged = false;

    if (beforeCardId) {
      try {
        const reordered = await mutateDatabase(workspaceId, model.id, (doc) => reorderBefore(doc, board.view.id, cardId, beforeCardId));

        orderChanged = reordered.result === true;
      } catch (error) {
        const card = await getCard({ workspaceId, cardId }).catch(() => null);

        throw new CardError('PARTIAL_FAILURE', `The card was ${columnChanged ? `moved to "${target.name}"` : 'already in that column'} but its position in Board "${board.view.name}" could not be changed (${error?.message ?? 'storage error'}). Retry move_card with the same arguments to finish.`, {
          column_changed: columnChanged, order_changed: false, card,
        });
      }
    }
    return { card: await getCard({ workspaceId, cardId }), order_changed: orderChanged, column_changed: columnChanged };
  }

  /** Moves `cardId` to sit immediately before `beforeCardId` in one view's row_orders. Returns true when the order changed. */
  function reorderBefore(doc, viewId, cardId, beforeCardId) {
    const view = doc.getMap('data').get('database').get('views').get(viewId);
    const orders = view?.get('row_orders');

    if (!(orders instanceof Y.Array)) throw new CardError('NOT_FOUND', 'Board view row order not found.');
    const entries = orders.toArray();
    const sourceIndex = entries.findIndex((entry) => entry.id === cardId);
    const targetIndex = entries.findIndex((entry) => entry.id === beforeCardId);

    if (sourceIndex === -1 || targetIndex === -1) throw new CardError('NOT_FOUND', 'The card is not in this Board view.');
    if (sourceIndex + 1 === targetIndex) return false;
    const entry = entries[sourceIndex];

    orders.delete(sourceIndex);
    orders.insert(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, [entry]);
    return true;
  }

  function setTombstones(doc, rowId, deleted) {
    const views = doc.getMap('data').get('database').get('views');
    let touched = 0;

    for (const view of views.values()) {
      const orders = view instanceof Y.Map ? view.get('row_orders') : null;

      if (!(orders instanceof Y.Array)) continue;
      orders.toArray().forEach((entry, index) => {
        if (entry.id !== rowId || (entry.is_deleted === true) === deleted) return;
        const next = { id: entry.id, height: entry.height ?? DEFAULT_ROW_HEIGHT };

        if (deleted) next.is_deleted = true;
        orders.delete(index);
        orders.insert(index, [next]);
        touched += 1;
      });
    }
    return touched;
  }

  // -------------------------------------------------------------- comments (stored in the card's row document)
  async function listCardComments({ workspaceId, cardId }) {
    const context = await loadCardContext(workspaceId, cardId);
    const doc = decode(context.rowCollab.doc_state, cardId);

    try {
      return { card: { id: cardId, title: toCard(context, context.row, null).title }, comments: readRowComments(doc) };
    } finally {
      doc.destroy();
    }
  }

  async function addCardComment({ workspaceId, userId, cardId, content, replyToId = null }) {
    const text = typeof content === 'string' ? content.trim() : '';

    if (!text || text.length > 10_000) throw new CardError('INVALID_INPUT', 'content is required (at most 10000 characters).');
    const context = await loadCardContext(workspaceId, cardId);

    if (rowArchived(context.model, cardId)) throw new CardError('INVALID_INPUT', 'This card is archived. Restore it with restore_card before commenting.');
    const commentId = newId();
    let parent = null;

    await mutateRow(workspaceId, cardId, (doc) => {
      if (replyToId) {
        parent = readRowComments(doc).find((comment) => comment.id === replyToId) ?? null;
        if (!parent) throw new CardError('NOT_FOUND', `Comment "${replyToId}" was not found on this card. Use list_comments to see the thread.`);
      }
      addRowComment(doc, { id: commentId, parentId: parent ? (parent.parent_id ?? parent.id) : null, content: text, authorId: userId, now });
    });
    return { comment_id: commentId, card_id: cardId, card_title: toCard(context, context.row, null).title, parent_author_id: parent?.author_id ?? null, reply_to_id: parent ? (parent.parent_id ?? parent.id) : null };
  }

  async function resolveCardComment({ workspaceId, userId, cardId, commentId, resolved }) {
    const context = await loadCardContext(workspaceId, cardId);
    let existed = false;
    let changed = false;

    await mutateRow(workspaceId, cardId, (doc) => {
      existed = readRowComments(doc).some((comment) => comment.id === commentId);
      if (existed) changed = setRowCommentResolved(doc, { id: commentId, resolved, userId, now });
    });
    if (!existed) throw new CardError('NOT_FOUND', `Comment "${commentId}" was not found on this card. Use list_comments to see the thread.`);
    return { card_id: cardId, card_title: toCard(context, context.row, null).title, comment_id: commentId, resolved, changed };
  }

  /** Removes one comment (what undoing an agent's comment does). Refuses when someone has replied to it since. */
  async function deleteCardComment({ workspaceId, cardId, commentId, refuseIfReplies = true }) {
    await loadCardContext(workspaceId, cardId);
    let removed = false;

    await mutateRow(workspaceId, cardId, (doc) => {
      const all = readRowComments(doc);

      if (refuseIfReplies && all.some((comment) => comment.parent_id === commentId)) throw new CardError('CONFLICT', 'People have replied to this comment, so it was left alone.');
      removed = deleteRowComment(doc, commentId);
    });
    return { removed };
  }

  async function rowDocumentPage(workspaceId, cardId) {
    const page = await store.getPage(rowDocumentIdFromRowId(cardId));

    return page && page.workspace_id === workspaceId ? page : null;
  }

  async function setArchived({ workspaceId, cardId, confirm, archive }) {
    if (confirm !== true) throw new CardError('INVALID_INPUT', `${archive ? 'archive_card' : 'restore_card'} requires confirm: true.`);
    const context = await loadCardContext(workspaceId, cardId);

    if (rowArchived(context.model, cardId) === archive) {
      const page = await rowDocumentPage(workspaceId, cardId);

      if (!page || Boolean(page.is_trashed) === archive) return getCard({ workspaceId, cardId });
    }
    await mutateDatabase(workspaceId, context.model.id, (doc) => setTombstones(doc, cardId, archive));
    const page = await rowDocumentPage(workspaceId, cardId);

    if (page && Boolean(page.is_trashed) !== archive) {
      try {
        await store.setPageTrashed(page.id, workspaceId, archive, now().toISOString());
      } catch (error) {
        throw new CardError('PARTIAL_FAILURE', `The card was ${archive ? 'archived' : 'restored'} but its detail page could not be ${archive ? 'moved to' : 'restored from'} the trash (${error?.message ?? 'storage error'}). Retry to finish.`, { card_changed: true, page_changed: false });
      }
    }
    return getCard({ workspaceId, cardId });
  }

  return {
    listDatabases,
    getDatabase,
    listCards,
    getCard,
    createCard,
    updateCard,
    moveCard,
    listCardComments,
    addCardComment,
    resolveCardComment,
    deleteCardComment,
    archiveCard: (args) => setArchived({ ...args, archive: true }),
    restoreCard: (args) => setArchived({ ...args, archive: false }),
  };
}

/**
 * Candidate provider backed by the workspace search index (search-index.js): returns the row ids of
 * `databaseId` that match `query`, or null when the index cannot answer (the service then scans the
 * database's rows directly).
 */
export function createIndexRowCandidates(store, { isReadableSpace = (permission) => permission?.visibility === 'public' } = {}) {
  return async ({ workspaceId, databaseId, query }) => {
    if (typeof store.querySearchDocuments !== 'function') return null;
    const readable = await buildReadableIndex(store, { id: workspaceId }, isReadableSpace);
    const ids = [];

    for (let offset = 0; offset < 500; offset += 50) {
      const result = await searchWorkspace(store, { id: workspaceId }, readable, { query, limit: 50, offset });

      for (const item of result.items) if (item.database_id === databaseId && item.database_row_id) ids.push(item.database_row_id);
      if (!result.has_more) break;
    }
    return ids;
  };
}
