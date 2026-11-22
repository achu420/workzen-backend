// Database schema for agents: create a database with its fields (and a Board, and a card template), and change an
// existing database's properties: rename it, add fields, rename fields, add or rename select options, change a
// formula's expression or a rollup's calculation, and set the template new cards start from.
//
// Deliberately never: delete a field, change a field's type, remove a select option or re-point a relation. Each of
// those destroys values on every card, and agent tokens are shared by the whole team.
//
// Fields are written in exactly the shapes AppFlowy-Web creates them (database-yjs/dispatch.ts createField,
// fields/relation/utils.ts, fields/rollup/utils.ts), so the app reads, edits and computes them like its own. Two-way
// relations get their reciprocal field in the related database, as the web's useUpdateRelationTypeOption does.
// Rollups and formulas are computed by the app; this module only stores their configuration.
import { createHash, randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import { CardError } from './cards.js';
import { markdownBlocks } from './page-writer.js';
import { writeRowTemplate } from './row-template.js';

export const FIELD_TYPES = {
  text: 0, number: 1, date: 2, select: 3, multi_select: 4, checkbox: 5, url: 6, checklist: 7, last_edited_time: 8, created_time: 9,
  relation: 10, person: 15, rollup: 16, created_by: 17, last_edited_by: 18, formula: 19,
};
const TYPE_NAME = Object.fromEntries(Object.entries(FIELD_TYPES).map(([name, code]) => [code, name]));
const T = FIELD_TYPES;

// CalculationType (database.type.ts). `list` / `unique_list` show the related values instead of a number.
export const ROLLUP_CALCULATIONS = {
  average: 0, max: 1, median: 2, min: 3, sum: 4, count: 5, count_empty: 6, count_not_empty: 7, count_checked: 13, count_unchecked: 14,
  percent_empty: 15, percent_not_empty: 16, count_unique: 17, count_values: 18, percent_checked: 19, percent_unchecked: 20, percent_values: 21,
  list: 5, unique_list: 5,
};
const ROLLUP_SHOW_AS = { list: 1, unique_list: 2 }; // RollupDisplayMode; anything else is Calculated (0)
const NEEDS_VALUES = new Set(['count_values', 'percent_values']); // the only calculations that use condition_value
export const OPTION_COLORS = ['Purple', 'Pink', 'LightPink', 'Orange', 'Yellow', 'Lime', 'Green', 'Aqua', 'Blue', 'Cream', 'Mint', 'Sky', 'Lilac', 'Pearl'];
const NUMBER_FORMATS = { number: 0, usd: 1, eur: 4, percent: 36 }; // NumberFormat (number.type.ts)
const LAYOUT_GRID = 0;
const LAYOUT_BOARD = 1;
const VISIBLE = 0; // FieldVisibility.AlwaysShown
const HIDE_WHEN_EMPTY = 1; // FieldVisibility.HideWhenEmpty: what library Boards use for card properties
export const MAX_FIELDS = 60;

const nanoid = (length) => randomBytes(length * 2).toString('base64url').replace(/[-_]/g, '').slice(0, length).padEnd(length, 'x');
const lower = (value) => String(value ?? '').trim().toLowerCase();
const unixNow = (now) => String(Math.floor(now().getTime() / 1000));

function invalid(message) {
  return new CardError('INVALID_INPUT', message);
}

// ------------------------------------------------------------ type options
function selectOptions(spec, existing = []) {
  const taken = new Set(existing.map((option) => lower(option.name)));
  const added = [];

  for (const [index, raw] of (spec ?? []).entries()) {
    const name = typeof raw === 'string' ? raw.trim() : String(raw?.name ?? '').trim();
    const color = typeof raw === 'object' && raw?.color ? OPTION_COLORS.find((candidate) => lower(candidate) === lower(raw.color)) : null;

    if (!name || name.length > 100) throw invalid('Each option needs a name of 1-100 characters.');
    if (typeof raw === 'object' && raw?.color && !color) throw invalid(`Unknown option color "${raw.color}". Colors: ${OPTION_COLORS.join(', ')}.`);
    if (taken.has(lower(name))) throw invalid(`The option "${name}" is listed twice.`);
    taken.add(lower(name));
    added.push({ id: nanoid(4), name, color: color ?? OPTION_COLORS[(existing.length + index) % OPTION_COLORS.length] });
  }
  return added;
}

/** prop("Field name") -> prop("<field id>"): the storage form (formula/schema.ts toStorageExpression). */
function storageExpression(expression, fieldsByName, fieldsById) {
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 4000) throw invalid('A formula needs an expression of 1-4000 characters.');
  let depth = 0;
  let quoted = false;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];

    if (char === '\\' && quoted) { index += 1; continue; }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '(') depth += 1;
    else if (!quoted && char === ')' && (depth -= 1) < 0) break;
  }
  if (quoted || depth !== 0) throw invalid('The formula expression has unbalanced quotes or parentheses.');
  return expression.replace(/prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g, (whole, ref) => {
    const name = ref.replace(/\\(.)/g, '$1');
    const field = fieldsById.get(name) ?? fieldsByName.get(lower(name));

    if (!field) throw invalid(`The formula refers to prop("${name}"), but there is no such field. Fields: ${[...fieldsByName.values()].map((candidate) => `"${candidate.name}"`).join(', ')}.`);
    return `prop("${field.id}")`;
  });
}

/**
 * One field spec -> { id, name, type, typeOption } (plain JSON). `scope` resolves names: own fields of the database
 * being written (including the ones added in the same call), and the related databases' models.
 */
function buildField(spec, id, scope) {
  const type = T[spec.type];
  const name = String(spec.name ?? '').trim();

  if (type === undefined) throw invalid(`Unknown field type "${spec.type}". Types: ${Object.keys(T).join(', ')}.`);
  if (!name || name.length > 200) throw invalid('Each field needs a name of 1-200 characters.');
  const extra = Object.keys(spec).filter((key) => !['name', 'type', ...ALLOWED_KEYS[spec.type]].includes(key));

  if (extra.length) throw invalid(`Field "${name}" (${spec.type}) does not take: ${extra.join(', ')}.`);
  switch (type) {
    case T.number: {
      const format = NUMBER_FORMATS[spec.number_format ?? 'number'];

      if (format === undefined) throw invalid(`Field "${name}": number_format is one of ${Object.keys(NUMBER_FORMATS).join(', ')}.`);
      return { id, name, type, typeOption: { format, scale: 0, symbol: 'RUB', name: 'Number' } };
    }
    case T.date:
      return { id, name, type, typeOption: { time_format: 1, date_format: 3, include_time: spec.include_time === true } };
    case T.select:
    case T.multi_select:
      return { id, name, type, typeOption: { content: JSON.stringify({ disable_color: false, options: selectOptions(spec.options) }) } };
    case T.url:
      return { id, name, type, typeOption: { url: '', content: '' } };
    case T.person:
      return { id, name, type, typeOption: { is_single_select: spec.one_person_only === true, fill_with_creator: false, disable_notification: false, persons: '[]' } };
    case T.relation:
      return { id, name, type, typeOption: relationOption(name, spec.relation, scope), reciprocal: reciprocalSpec(name, spec.relation, scope) };
    case T.rollup:
      return { id, name, type, typeOption: rollupOption(name, spec.rollup, scope) };
    case T.formula:
      return { id, name, type, typeOption: { expression: storageExpression(spec.formula?.expression, scope.fieldsByName, scope.fieldsById), format: 0 } };
    default:
      return { id, name, type, typeOption: {} };
  }
}

const ALLOWED_KEYS = {
  text: [], number: ['number_format'], date: ['include_time'], select: ['options'], multi_select: ['options'], checkbox: [], url: [], checklist: [],
  last_edited_time: [], created_time: [], created_by: [], last_edited_by: [], person: ['one_person_only'], relation: ['relation'], rollup: ['rollup'], formula: ['formula'],
};

function relationTarget(name, relation, scope) {
  const databaseId = relation?.database_id === 'self' ? scope.databaseId : relation?.database_id;

  if (typeof databaseId !== 'string' || !databaseId) throw invalid(`Relation "${name}" needs relation.database_id (from list_databases, or "self" to link cards of this database).`);
  if (databaseId !== scope.databaseId && !scope.related.has(databaseId)) throw invalid(`Relation "${name}": database "${databaseId}" was not found.`);
  return databaseId;
}

function relationOption(name, relation, scope) {
  const databaseId = relationTarget(name, relation, scope);
  const twoWay = relation?.two_way !== false && databaseId !== scope.databaseId;

  return {
    database_id: databaseId,
    is_two_way: twoWay,
    source_limit: relation?.one_card_only ? 1 : 0,
    target_limit: twoWay && relation?.reciprocal_one_card_only ? 1 : 0,
    ...(twoWay ? { reciprocal_field_name: String(relation?.reciprocal_name ?? scope.databaseName ?? name).trim().slice(0, 200) || name } : {}),
  };
}

/** What the reciprocal field in the related database will be (filled in with ids once both are known). */
function reciprocalSpec(name, relation, scope) {
  const databaseId = relationTarget(name, relation, scope);

  if (relation?.two_way === false || databaseId === scope.databaseId) return null;
  const reciprocalName = String(relation?.reciprocal_name ?? scope.databaseName ?? name).trim().slice(0, 200) || name;
  const target = scope.related.get(databaseId);
  const ownId = scope.idFor(`reciprocal:${name}`); // a retried create_database finds the field it already added

  if (target.fields.some((field) => lower(field.name) === lower(reciprocalName) && field.id !== ownId)) {
    throw invalid(`Relation "${name}": the database "${target.name}" already has a field named "${reciprocalName}". Pass relation.reciprocal_name to name the field it gets.`);
  }
  return { id: ownId, databaseId, name: reciprocalName, oneOnly: relation?.reciprocal_one_card_only === true, otherOneOnly: relation?.one_card_only === true };
}

function rollupOption(name, rollup, scope) {
  const relationField = scope.fieldsByName.get(lower(rollup?.relation));

  if (!relationField || relationField.type !== T.relation) throw invalid(`Rollup "${name}": rollup.relation must name a relation field of this database.`);
  const target = relationField.relationDatabaseId === scope.databaseId ? { name: scope.databaseName, fields: [...scope.fieldsByName.values()] } : scope.related.get(relationField.relationDatabaseId);

  if (!target) throw invalid(`Rollup "${name}": the database "${rollup.relation}" links to was not found.`);
  const targetField = target.fields.find((field) => lower(field.name) === lower(rollup?.target)) ?? target.fields.find((field) => field.id === rollup?.target);

  if (!targetField) throw invalid(`Rollup "${name}": "${rollup?.target}" is not a field of "${target.name}". Fields: ${target.fields.map((field) => `"${field.name}"`).join(', ')}.`);
  const calculation = rollup?.calculation ?? 'count';

  if (!(calculation in ROLLUP_CALCULATIONS)) throw invalid(`Rollup "${name}": calculation is one of ${Object.keys(ROLLUP_CALCULATIONS).join(', ')}.`);
  let condition = '';

  if (NEEDS_VALUES.has(calculation)) {
    const values = Array.isArray(rollup?.values) ? rollup.values : [];
    const ids = values.map((value) => {
      const option = (targetField.options ?? []).find((candidate) => lower(candidate.name) === lower(value));

      if (!option) throw invalid(`Rollup "${name}": "${value}" is not an option of "${targetField.name}". Options: ${(targetField.options ?? []).map((candidate) => `"${candidate.name}"`).join(', ') || '(none)'}.`);
      return option.id;
    });

    if (!ids.length) throw invalid(`Rollup "${name}": ${calculation} needs rollup.values (the option names to count).`);
    condition = ids.length > 1 ? JSON.stringify(ids) : ids[0]; // rollup/condition.ts writeRollupCondition
  } else if (rollup?.values !== undefined) {
    throw invalid(`Rollup "${name}": rollup.values only applies to count_values and percent_values.`);
  }
  return {
    relation_field_id: relationField.id,
    target_field_id: targetField.id,
    calculation_type: ROLLUP_CALCULATIONS[calculation],
    show_as: ROLLUP_SHOW_AS[calculation] ?? 0,
    condition_value: condition,
  };
}

// --------------------------------------------------------------- yjs writes
function toYValue(value) {
  if (Array.isArray(value)) { const array = new Y.Array(); array.push(value.map(toYValue)); return array; }
  if (value && typeof value === 'object') { const map = new Y.Map(); for (const [key, item] of Object.entries(value)) map.set(key, toYValue(item)); return map; }
  return value;
}

function fieldMap(def, stamp) {
  const field = new Y.Map();
  const typeOptions = new Y.Map();

  field.set('name', def.name);
  field.set('id', def.id);
  field.set('ty', def.type);
  field.set('created_at', stamp);
  field.set('last_modified', stamp);
  field.set('is_primary', false);
  field.set('icon', '');
  typeOptions.set(String(def.type), toYValue(def.typeOption));
  field.set('type_option', typeOptions);
  return field;
}

/** Adds a field to the database and to every view (database-yjs/dispatch.ts useNewPropertyDispatch). */
function insertField(database, def, stamp) {
  database.get('fields').set(def.id, fieldMap(def, stamp));
  for (const view of database.get('views').values()) {
    if (!(view instanceof Y.Map)) continue;
    const orders = view.get('field_orders');
    const settings = view.get('field_settings');

    if (orders instanceof Y.Array && !orders.toArray().some((entry) => entry?.id === def.id)) orders.push([{ id: def.id }]);
    if (settings instanceof Y.Map && !settings.get(def.id)) {
      settings.set(def.id, toYValue({ visibility: Number(view.get('layout')) === LAYOUT_BOARD ? HIDE_WHEN_EMPTY : VISIBLE, wrap: false, width: 150 }));
    }
  }
}

function typeOptionMap(field) {
  return field.get('type_option')?.get(String(field.get('ty')));
}

function readOptions(field) {
  try {
    return JSON.parse(typeOptionMap(field)?.get('content') ?? '{}').options ?? [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ service
/**
 * @param {object} deps
 * @param {object} deps.cards the card service (its loadDatabase / mutateDatabase)
 * @param {(args:object)=>Promise<{database_id:string, view_id:string, container_id:string, replayed:boolean}>} deps.createDatabaseContainer
 *   creates a database from template JSON under a parent (server.js: the same path library templates use)
 * @param {(args:{workspaceId:string, containerId:string, name:string})=>Promise<void>} deps.renameContainer
 */
export function createDatabaseSchemaService({ cards, createDatabaseContainer, renameContainer, now = () => new Date() }) {
  /** Names (lower case) and ids -> field summaries of a loaded model, in the shape the builders read. */
  function summarize(model) {
    return model.fields.map((field) => ({ id: field.id, name: field.name, type: field.type, options: field.options, relationDatabaseId: field.relation?.databaseId ?? null }));
  }

  /** Models of the databases new relations link to, and of those the database's existing relations link to (rollups read them). */
  async function relatedModels(workspaceId, specs, existingModel = null) {
    const related = new Map();
    const targets = [
      ...specs.map((spec) => (spec?.type === 'relation' ? spec.relation?.database_id : null)),
      ...(existingModel?.fields ?? []).map((field) => field.relation?.databaseId ?? null),
    ];

    for (const databaseId of targets) {
      if (!databaseId || databaseId === 'self' || databaseId === existingModel?.id || related.has(databaseId)) continue;
      const loaded = await cards.loadDatabase(workspaceId, databaseId).catch(() => null);

      if (loaded) related.set(databaseId, { id: databaseId, name: loaded.name, fields: summarize(loaded.model) });
    }
    return related;
  }

  /** Field specs -> built defs, ids assigned first so formulas and rollups can refer to fields added in the same call. */
  function buildFields(specs, scope) {
    const defs = [];

    for (const spec of specs) {
      if (scope.fieldsByName.has(lower(spec?.name))) throw invalid(`There is already a field named "${spec.name}".`);
      const entry = { id: scope.idFor(`field:${lower(spec?.name)}`), name: String(spec?.name ?? '').trim(), type: T[spec?.type], options: [], relationDatabaseId: null };

      if (spec?.type === 'relation') entry.relationDatabaseId = spec.relation?.database_id === 'self' ? scope.databaseId : spec.relation?.database_id ?? null;
      if (spec?.type === 'select' || spec?.type === 'multi_select') entry.pending = spec;
      scope.fieldsByName.set(lower(entry.name), entry);
      scope.fieldsById.set(entry.id, entry);
      defs.push({ spec, entry });
    }
    // Options first: a rollup counting option values of a sibling select needs that select's option ids.
    for (const { spec, entry } of defs) {
      if (!entry.pending) continue;
      entry.def = buildField(spec, entry.id, scope);
      entry.options = JSON.parse(entry.def.typeOption.content).options;
    }
    return defs.map(({ spec, entry }) => entry.def ?? buildField(spec, entry.id, scope));
  }

  /** Writes each two-way relation's reciprocal field into its related database, then points the source at it. */
  async function addReciprocals(workspaceId, databaseId, defs, stamp) {
    const done = [];

    for (const def of defs.filter((candidate) => candidate.reciprocal)) {
      const { id: reciprocalId, databaseId: targetId, name, oneOnly, otherOneOnly } = def.reciprocal;

      await cards.mutateDatabase(workspaceId, targetId, (doc) => {
        const database = doc.getMap('data').get('database');

        if (database.get('fields').get(reciprocalId)) return;
        insertField(database, {
          id: reciprocalId, name, type: T.relation,
          typeOption: { database_id: databaseId, is_two_way: true, reciprocal_field_id: def.id, reciprocal_field_name: def.name, source_limit: oneOnly ? 1 : 0, target_limit: otherOneOnly ? 1 : 0 },
        }, stamp);
      });
      def.typeOption.reciprocal_field_id = reciprocalId;
      done.push({ field: def.name, database_id: targetId, reciprocal_field: name });
    }
    return done;
  }

  async function createDatabase({ workspaceId, userId, parentId, name, titleField = 'Name', fields = [], board = null, cardTemplate = null, idempotencyKey }) {
    const title = String(name ?? '').trim();

    if (!title || title.length > 200) throw invalid('name is required (at most 200 characters).');
    if (!Array.isArray(fields) || fields.length > MAX_FIELDS) throw invalid(`fields must be a list of at most ${MAX_FIELDS} fields.`);
    const specs = fields;
    const requestId = idempotencyUuid(`create_database:${workspaceId}:${idempotencyKey}`);
    const databaseId = idempotencyUuid(`${requestId}:database`);
    const scope = {
      databaseId, databaseName: title, fieldsByName: new Map(), fieldsById: new Map(), related: await relatedModels(workspaceId, specs),
      // Ids derive from the idempotency key, so a retry after a partial failure rebuilds exactly the same fields.
      idFor: (label) => idempotencyUuid(`${requestId}:${label}`).replace(/-/g, '').slice(0, 6),
    };
    const primary = { id: scope.idFor('field:__title__'), name: String(titleField ?? 'Name').trim().slice(0, 200) || 'Name', type: T.text, options: [] };

    scope.fieldsByName.set(lower(primary.name), primary);
    scope.fieldsById.set(primary.id, primary);
    const defs = buildFields(specs, scope);
    const groupField = board ? defs.find((def) => lower(def.name) === lower(board.group_by)) : null;

    if (board && (!groupField || groupField.type !== T.select)) throw invalid('board.group_by must name one of the new select fields (its options become the Board columns).');
    const blocks = cardTemplate ? markdownBlocks(cardTemplate.content) : null;
    const template = databaseTemplate({ title, primary, defs, board, groupField });

    // Reciprocal fields go into the related databases first (they need this database's id, which is fixed by the
    // idempotency key), so the new database's relation fields can point back at them.
    const stamp = unixNow(now);
    const existing = await cards.loadDatabase(workspaceId, databaseId).catch(() => null);

    if (existing) {
      return { database_id: databaseId, name: existing.name, replayed: true, reciprocal_fields: [], fields: summarize(existing.model).map(publicField) };
    }
    // Sets each relation's reciprocal_field_id; the template's type_options are these same objects.
    const reciprocals = await addReciprocals(workspaceId, databaseId, defs, stamp);
    const created = await createDatabaseContainer({ workspaceId, userId, parentId, template, requestId, databaseId });

    if (blocks) {
      await cards.mutateDatabase(workspaceId, databaseId, (doc) => {
        const database = doc.getMap('data').get('database');

        writeRowTemplate(database.get('metas'), { name: cardTemplate.name ?? 'Default', blocks, makeDefault: true, nowMs: now().getTime() });
      });
    }
    const loaded = await cards.loadDatabase(workspaceId, databaseId);

    return {
      database_id: databaseId, name: loaded.name, container_id: created.container_id, replayed: Boolean(created.replayed),
      fields: summarize(loaded.model).map(publicField), reciprocal_fields: reciprocals, card_template: blocks ? (cardTemplate.name ?? 'Default') : null,
      views: loaded.model.views.map((view) => ({ view_id: view.id, name: view.name, layout: view.layout === LAYOUT_BOARD ? 'board' : 'grid' })),
    };
  }

  function publicField(field) {
    return { id: field.id, name: field.name, type: TYPE_NAME[field.type] ?? 'other', ...(field.options?.length ? { options: field.options.map((option) => option.name) } : {}) };
  }

  /** Template JSON (database-template-builder.js shape) for a new database: a Grid, and a Board when asked. */
  function databaseTemplate({ title, primary, defs, board, groupField }) {
    const all = [{ id: primary.id, name: primary.name, type: T.text, typeOption: {}, primary: true }, ...defs];
    const settings = (layout) => Object.fromEntries(all.map((def) => [def.id, { visibility: layout === LAYOUT_BOARD && !def.primary ? HIDE_WHEN_EMPTY : VISIBLE, wrap: false, width: 150 }]));
    // Views are listed by created_at: the Board (when there is one) first, then the Grid.
    const seconds = Math.floor(now().getTime() / 1000);
    const views = [{ id: 'grid', name: 'Grid', layout: LAYOUT_GRID, created_at: seconds + 1, layout_settings: {}, filters: [], sorts: [], group_settings: [], field_orders: all.map((def) => ({ id: def.id })), row_orders: [], field_settings: settings(LAYOUT_GRID) }];

    if (board) {
      const options = JSON.parse(groupField.typeOption.content).options;

      views.unshift({
        id: 'board', name: String(board.name ?? 'Board').trim() || 'Board', layout: LAYOUT_BOARD, created_at: seconds,
        layout_settings: { [LAYOUT_BOARD]: { hide_ungrouped_column: false, collapse_hidden_groups: true } },
        filters: [], sorts: [],
        group_settings: [{ id: `g:${nanoid(6)}`, field_id: groupField.id, ty: T.select, content: '', groups: [{ id: groupField.id, visible: true }, ...options.map((option) => ({ id: option.id, visible: true }))], collapsed_group_ids: [] }],
        field_orders: all.map((def) => ({ id: def.id })), row_orders: [], field_settings: settings(LAYOUT_BOARD),
      });
    }
    return {
      name: title,
      fields: all.map((def) => ({ id: def.id, name: def.name, field_type: def.type, is_primary: Boolean(def.primary), type_options: { [def.type]: def.typeOption } })),
      views,
      rows: [],
    };
  }

  // ---------------------------------------------------------------- updates
  async function updateDatabase({ workspaceId, userId, databaseId, name, operations = [] }) {
    if (name === undefined && !operations.length) throw invalid('Pass `name` and/or at least one operation.');
    if (operations.length > 40) throw invalid('At most 40 operations per call.');
    const loaded = await cards.loadDatabase(workspaceId, databaseId);
    const specs = operations.filter((op) => op.op === 'add_field').map((op) => {
      if (!op.new_field || typeof op.new_field !== 'object') throw invalid('add_field needs new_field (a field definition, as in create_database).');
      return op.new_field;
    });
    const scope = {
      databaseId, databaseName: loaded.name, fieldsByName: new Map(), fieldsById: new Map(), related: await relatedModels(workspaceId, specs, loaded.model),
      idFor: () => nanoid(6),
    };

    for (const field of summarize(loaded.model)) { scope.fieldsByName.set(lower(field.name), field); scope.fieldsById.set(field.id, field); }
    if (loaded.model.fields.length + specs.length > MAX_FIELDS) throw invalid(`A database can have at most ${MAX_FIELDS} fields here.`);
    // Everything is validated before anything is written, so a bad operation changes nothing.
    const defs = buildFields(specs, scope);
    const existing = (fieldName, op) => {
      const field = scope.fieldsByName.get(lower(fieldName)) ?? scope.fieldsById.get(fieldName);

      if (!field || defs.some((def) => def.id === field.id)) throw invalid(`${op}: "${fieldName}" is not an existing field of "${loaded.name}".`);
      return field;
    };
    const plan = [];
    const done = [];
    let defIndex = 0;

    for (const op of operations) {
      switch (op.op) {
        case 'add_field': {
          const def = defs[defIndex++];

          plan.push((database, stamp) => insertField(database, def, stamp));
          done.push(`Added ${TYPE_NAME[def.type]} field "${def.name}"`);
          break;
        }
        case 'rename_field': {
          const field = existing(op.field, 'rename_field');
          const next = String(op.new_name ?? '').trim();

          if (!next || next.length > 200) throw invalid('rename_field: new_name must be 1-200 characters.');
          if (lower(next) !== lower(field.name) && scope.fieldsByName.has(lower(next))) throw invalid(`rename_field: there is already a field named "${next}".`);
          plan.push((database, stamp) => { const map = database.get('fields').get(field.id); map.set('name', next); map.set('last_modified', stamp); });
          done.push(`Renamed field "${field.name}" to "${next}"`);
          break;
        }
        case 'add_options': {
          const field = existing(op.field, 'add_options');

          if (field.type !== T.select && field.type !== T.multi_select) throw invalid(`add_options: "${field.name}" is not a select field.`);
          const added = selectOptions(op.options, field.options);

          if (!added.length) throw invalid('add_options: options is empty.');
          plan.push((database, stamp) => {
            const map = database.get('fields').get(field.id);
            const content = JSON.parse(typeOptionMap(map)?.get('content') ?? '{"options":[]}');

            typeOptionMap(map).set('content', JSON.stringify({ disable_color: false, ...content, options: [...(content.options ?? []), ...added] }));
            map.set('last_modified', stamp);
            addBoardColumns(database, field.id, added);
          });
          done.push(`Added option${added.length === 1 ? '' : 's'} ${added.map((option) => `"${option.name}"`).join(', ')} to "${field.name}"`);
          break;
        }
        case 'rename_option': {
          const field = existing(op.field, 'rename_option');
          const option = (field.options ?? []).find((candidate) => lower(candidate.name) === lower(op.option));
          const next = String(op.new_name ?? '').trim();

          if (!option) throw invalid(`rename_option: "${op.option}" is not an option of "${field.name}".`);
          if (!next || next.length > 100) throw invalid('rename_option: new_name must be 1-100 characters.');
          if (field.options.some((candidate) => candidate.id !== option.id && lower(candidate.name) === lower(next))) throw invalid(`rename_option: "${field.name}" already has an option "${next}".`);
          const color = op.color === undefined ? null : OPTION_COLORS.find((candidate) => lower(candidate) === lower(op.color));

          if (op.color !== undefined && !color) throw invalid(`rename_option: unknown color "${op.color}". Colors: ${OPTION_COLORS.join(', ')}.`);
          plan.push((database, stamp) => {
            const map = database.get('fields').get(field.id);
            const content = JSON.parse(typeOptionMap(map)?.get('content') ?? '{"options":[]}');

            content.options = (content.options ?? []).map((candidate) => (candidate.id === option.id ? { ...candidate, name: next, ...(color ? { color } : {}) } : candidate));
            typeOptionMap(map).set('content', JSON.stringify(content));
            map.set('last_modified', stamp);
          });
          done.push(`Renamed option "${option.name}" of "${field.name}" to "${next}"`);
          break;
        }
        case 'set_formula': {
          const field = existing(op.field, 'set_formula');

          if (field.type !== T.formula) throw invalid(`set_formula: "${field.name}" is not a formula field.`);
          const expression = storageExpression(op.expression, scope.fieldsByName, scope.fieldsById);

          plan.push((database, stamp) => { const map = database.get('fields').get(field.id); typeOptionMap(map).set('expression', expression); map.set('last_modified', stamp); });
          done.push(`Changed the formula of "${field.name}"`);
          break;
        }
        case 'set_rollup': {
          const field = existing(op.field, 'set_rollup');

          if (field.type !== T.rollup) throw invalid(`set_rollup: "${field.name}" is not a rollup field.`);
          const option = rollupOption(field.name, op.rollup, scope);

          plan.push((database, stamp) => {
            const map = database.get('fields').get(field.id);

            for (const [key, value] of Object.entries(option)) typeOptionMap(map).set(key, value);
            map.set('last_modified', stamp);
          });
          done.push(`Changed the rollup "${field.name}"`);
          break;
        }
        case 'set_card_template': {
          const blocks = markdownBlocks(op.content);
          const templateName = String(op.name ?? 'Default').trim() || 'Default';

          plan.push((database) => {
            if (!(database.get('metas') instanceof Y.Map)) database.set('metas', new Y.Map());
            writeRowTemplate(database.get('metas'), { name: templateName, blocks, makeDefault: op.default !== false, nowMs: now().getTime() });
          });
          done.push(`Set the card template "${templateName}"${op.default === false ? '' : ' (used for new cards)'}`);
          break;
        }
        default:
          throw invalid(`Unknown operation "${op.op}". Operations: add_field, rename_field, add_options, rename_option, set_formula, set_rollup, set_card_template. Fields are never deleted or retyped here.`);
      }
    }
    const title = name === undefined ? null : String(name).trim();

    if (title !== null && (!title || title.length > 200)) throw invalid('name must be 1-200 characters.');
    const stamp = unixNow(now);
    const reciprocals = await addReciprocals(workspaceId, databaseId, defs, stamp);

    if (plan.length) {
      await cards.mutateDatabase(workspaceId, databaseId, (doc) => {
        const database = doc.getMap('data').get('database');

        for (const step of plan) step(database, stamp);
      });
    }
    if (title !== null && title !== loaded.name) {
      await renameContainer({ workspaceId, containerId: loaded.container.id, name: title });
      done.unshift(`Renamed the database "${loaded.name}" to "${title}"`);
    }
    const after = await cards.loadDatabase(workspaceId, databaseId);

    return { database_id: databaseId, name: after.name, previous_name: loaded.name, changes: done, reciprocal_fields: reciprocals, fields: summarize(after.model).map(publicField) };
  }

  /** New options of a Board's grouping field become visible columns, as the app does when an option is added. */
  function addBoardColumns(database, fieldId, options) {
    for (const view of database.get('views').values()) {
      const group = view instanceof Y.Map ? view.get('groups')?.get?.(0) : null;

      if (!(group instanceof Y.Map) || group.get('field_id') !== fieldId || !(group.get('groups') instanceof Y.Array)) continue;
      group.get('groups').push(options.map((option) => toYValue({ id: option.id, visible: true })));
    }
  }

  return { createDatabase, updateDatabase };
}

function idempotencyUuid(seed) {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
