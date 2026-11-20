// A database template can be one database, or a set of databases linked by relation fields (the template's own
// database plus its `related_databases`). Instantiating the set needs every database, view and row to get a new id,
// with the links between them rewritten to those new ids: a relation field's `database_id`, and the related row ids in
// each relation cell. Field ids stay as they are (they only mean something inside one database, and rollups and
// formulas refer to them by id).
const RELATION = 10;
const PRIMARY_REF = '__primary__';

export const databaseRef = (database) => database.database_id ?? PRIMARY_REF;

/**
 * @param template the library template (primary database at the top level)
 * @param derive (label) => uuid: deterministic per request, so a replayed request resolves to the same ids. The primary
 *   database keeps the plain labels ('database', 'container', 'view:<id>', 'row:<id>'); linked ones are prefixed.
 */
export function planTemplateDatabases(template, derive) {
  const entries = [{ database: template, primary: true }, ...(template.related_databases ?? []).map((database) => ({ database, primary: false }))];

  return entries.map(({ database, primary }) => {
    const tag = primary ? '' : `rel:${databaseRef(database)}:`;

    return {
      database,
      primary,
      ref: databaseRef(database),
      databaseId: derive(`${tag}database`),
      containerId: derive(`${tag}container`),
      viewIdMap: new Map(database.views.map((view) => [view.id, derive(`${tag}view:${view.id}`)])),
      rowIdMap: new Map(database.rows.map((row) => [row.id, derive(`${tag}row:${row.id}`)])),
    };
  });
}

/** The plan's database with relation fields and relation cells pointing at the new ids of the whole set. */
export function relinkTemplateDatabase(plan, plans) {
  const byRef = new Map(plans.map((candidate) => [candidate.ref, candidate]));
  const targetOf = (field) => byRef.get(field.type_options?.[RELATION]?.database_id);
  const relations = new Map(plan.database.fields.filter((field) => field.field_type === RELATION).map((field) => [field.id, targetOf(field)]));

  if (!relations.size) return plan.database;
  return {
    ...plan.database,
    fields: plan.database.fields.map((field) => (field.field_type !== RELATION ? field : {
      ...field,
      type_options: { ...field.type_options, [RELATION]: { ...field.type_options[RELATION], database_id: relations.get(field.id)?.databaseId ?? field.type_options[RELATION].database_id } },
    })),
    rows: plan.database.rows.map((row) => ({
      ...row,
      cells: Object.fromEntries(Object.entries(row.cells).map(([fieldId, cell]) => {
        const target = relations.get(fieldId);

        if (!target || cell?.field_type !== RELATION) return [fieldId, cell];
        return [fieldId, { ...cell, data: (Array.isArray(cell.data) ? cell.data : []).map((rowId) => target.rowIdMap.get(rowId)).filter(Boolean) }];
      })),
    })),
  };
}
