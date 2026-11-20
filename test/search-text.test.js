import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { buildDocumentCollabFromTemplate } from '../document-template-builder.js';
import { buildDatabaseCollabFromTemplate } from '../database-template-builder.js';
import { createInitialDatabaseRowCollab } from '../database-row-document.js';
import { getDatabaseTemplate } from '../database-template-library.js';
import {
  buildPreview, extractDatabaseSchema, extractDocumentText, extractRowText, MAX_INDEX_TEXT, queryTerms, scoreSearchDocument, tokenize,
} from '../search-text.js';

// A small hand-built Document so ordering, nesting, mentions and caps can be asserted exactly.
function makeDocument(tree) {
  const doc = new Y.Doc();
  const document = new Y.Map();
  const blocks = new Y.Map();
  const meta = new Y.Map();
  const childrenMap = new Y.Map();
  const textMap = new Y.Map();
  let counter = 0;

  doc.getMap('data').set('document', document);
  document.set('blocks', blocks);
  document.set('meta', meta);
  meta.set('children_map', childrenMap);
  meta.set('text_map', textMap);
  const addBlock = (node, parentId) => {
    const id = `b${counter += 1}`;
    const block = new Y.Map();
    const childrenId = `c${id}`;

    block.set('id', id);
    block.set('parent', parentId);
    block.set('children', childrenId);
    if (node.segments) {
      const text = new Y.Text();

      textMap.set(`t${id}`, text);
      node.segments.forEach(([insert, attributes]) => text.insert(text.length, insert, attributes));
      block.set('external_id', `t${id}`);
      block.set('external_type', 'text');
    }
    blocks.set(id, block);
    const childIds = new Y.Array();

    childrenMap.set(childrenId, childIds);
    childIds.push((node.children ?? []).map((child) => addBlock(child, id)));
    return id;
  };

  document.set('page_id', addBlock({ children: tree }, ''));
  return Y.encodeStateAsUpdate(doc);
}

test('document text is read in order, nested blocks included, mention placeholders skipped', () => {
  const state = makeDocument([
    { segments: [['Roadmap overview']] },
    { segments: [['Owner '], ['@', { mention: { type: 'page', page_id: 'x' } }], [' signs off', { bold: true }]], children: [{ segments: [['nested detail']] }] },
    { children: [{ segments: [['grandchild only']] }] },
  ]);

  assert.equal(extractDocumentText(state), 'Roadmap overview\nOwner  signs off\nnested detail\ngrandchild only');
});

test('document extraction is safe on empty or foreign documents and caps its size', () => {
  assert.equal(extractDocumentText(Y.encodeStateAsUpdate(new Y.Doc())), '');
  assert.ok(extractDocumentText(makeDocument([{ segments: [['x'.repeat(MAX_INDEX_TEXT + 5000)]] }])).length <= MAX_INDEX_TEXT);
});

test('a real template document yields its text', () => {
  const tree = JSON.parse(readFileSync(new URL('../templates/documents/product-spec.json', import.meta.url), 'utf8')).pages;
  const built = buildDocumentCollabFromTemplate({ documentId: randomUUID(), document: tree.document, pageIdMap: new Map() });
  const text = extractDocumentText(built.documentState);
  const firstDelta = Object.values(tree.document.meta.text_map).map((raw) => JSON.parse(raw)).flat().find((op) => typeof op.insert === 'string' && op.insert.trim().length > 4);

  assert.ok(text.length > 100, 'template body is non-trivial');
  assert.ok(text.includes(firstDelta.insert.trim()), `expected "${firstDelta.insert.trim()}" in the extracted text`);
});

function tasksDatabase() {
  const template = getDatabaseTemplate('tasks');
  const databaseId = randomUUID();
  const viewIdMap = new Map(template.views.map((view) => [view.id, randomUUID()]));
  const rowIdMap = new Map(template.rows.map((row) => [row.id, randomUUID()]));
  const database = buildDatabaseCollabFromTemplate({ databaseId, template, viewIdMap, rowIdMap, timestamp: new Date().toISOString() });
  const rows = template.rows.map((row) => ({
    source: row,
    rowId: rowIdMap.get(row.id),
    state: createInitialDatabaseRowCollab({ rowId: rowIdMap.get(row.id), databaseId, cells: row.cells, height: row.height, visibility: row.visibility, timestamp: new Date().toISOString() }).documentState,
  }));

  return { template, databaseId, database, rows };
}

test('database schema lists fields, the primary field, select options and live row ids', () => {
  const { template, database, rows } = tasksDatabase();
  const schema = extractDatabaseSchema(database.documentState);
  const primary = template.fields.find((field) => field.is_primary);
  const status = template.fields.find((field) => field.name === 'Status');

  assert.equal(schema.fields.size, template.fields.length);
  assert.equal(schema.primaryFieldId, primary.id);
  assert.equal(schema.rowIds.length, rows.length);
  assert.ok([...schema.fields.get(status.id).options.values()].includes('In progress'));
});

test('a row resolves select option names and uses the primary cell as its title', () => {
  const { template, database, rows } = tasksDatabase();
  const schema = extractDatabaseSchema(database.documentState);
  const status = template.fields.find((field) => field.name === 'Status');
  const primary = template.fields.find((field) => field.is_primary);
  const row = rows.find((candidate) => candidate.source.cells[status.id]?.data);
  const text = extractRowText(schema, row.state);
  const optionName = schema.fields.get(status.id).options.get(row.source.cells[status.id].data);

  assert.equal(text.rowId, row.rowId);
  assert.equal(text.title, row.source.cells[primary.id].data);
  assert.ok(optionName, 'status option id maps to a name');
  assert.ok(text.content.includes(optionName), `content should include "${optionName}", not the option id`);
  assert.ok(!text.content.includes(row.source.cells[status.id].data) || optionName.includes(row.source.cells[status.id].data));
});

test('rows marked deleted in every view are not listed', () => {
  const { database } = tasksDatabase();
  const doc = new Y.Doc();

  Y.applyUpdate(doc, database.documentState);
  const views = doc.getMap('data').get('database').get('views');
  const [firstId] = extractDatabaseSchema(database.documentState).rowIds;

  for (const view of views.values()) {
    const orders = view.get('row_orders');
    const entries = orders.toArray();

    orders.delete(0, entries.length);
    orders.push(entries.map((entry) => (entry.id === firstId ? { ...entry, is_deleted: true } : entry)));
  }
  const schema = extractDatabaseSchema(Y.encodeStateAsUpdate(doc));

  assert.ok(!schema.rowIds.includes(firstId));
  assert.equal(schema.rowIds.length, 27);
});

test('tokenizing, matching and ranking', () => {
  assert.deepEqual(tokenize('TSK-001: Plan Q3 roadmap!'), ['tsk', '001', 'plan', 'q3', 'roadmap']);
  assert.deepEqual(queryTerms('  Road  road MAP '), ['road', 'map']);

  const doc = (title, content, updated = '2026-01-01T00:00:00Z') => ({ title, content, updated_at: updated });
  const prefix = scoreSearchDocument(doc('Tasks board', ''), ['tas']);
  const bodyOnly = scoreSearchDocument(doc('Weekly notes', 'all tasks done'), ['tas']);

  assert.ok(prefix > bodyOnly, 'a title hit outranks a body hit');
  assert.equal(scoreSearchDocument(doc('Tasks', 'nothing'), ['tas', 'missing']), null, 'every term must match');
  assert.equal(scoreSearchDocument(doc('Subtasks', ''), ['tas']), null, 'matching is by token prefix, not substring');
  assert.ok(scoreSearchDocument(doc('Plan', 'plan plan plan'), ['plan']) > scoreSearchDocument(doc('Plan', 'plan'), ['plan']), 'more occurrences score higher');
  assert.ok(scoreSearchDocument(doc('Plan', '', '2026-11-12T00:00:00Z'), ['plan'], Date.parse('2026-11-12T00:00:00Z')) >
    scoreSearchDocument(doc('Plan', '', '2020-01-01T00:00:00Z'), ['plan'], Date.parse('2026-11-12T00:00:00Z')), 'recent wins ties');
});

test('previews centre on the first match and mark what was cut', () => {
  const text = `${'lorem ipsum '.repeat(40)}the quarterly budget review${' dolor sit'.repeat(40)}`;
  const preview = buildPreview(text, ['budget'], 80);

  assert.ok(preview.includes('budget'));
  assert.ok(preview.startsWith('…') && preview.endsWith('…'));
  assert.ok(preview.length <= 84);
  assert.equal(buildPreview('short text', ['short'], 80), 'short text');
});
