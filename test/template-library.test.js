// Every template in the library (built-in and imported from appflowy.com/templates) must instantiate into a real,
// working database or document: right number of fields, views, rows and card bodies, readable through the same card
// and page code the agents and the web app use. Runs against the JSON store and, when configured, PostgreSQL.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { account, rawRow, startCardsEnv } from './helpers/cards-env.js';
import { eachStorageMode, mcpOk, mintToken } from './helpers/mcp-live-env.js';
import { extractDocumentText } from '../search-text.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const load = (kind) => readdirSync(path.join(DIR, kind)).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(path.join(DIR, kind, name), 'utf8')));
const databases = load('databases');
const documents = load('documents');
const textOf = (document) => {
  const doc = new Y.Doc();
  const out = new Map();

  for (const [id, block] of Object.entries(document.blocks)) out.set(id, block);
  doc.destroy();
  return [...out.values()].filter((block) => block.external_id && document.meta.text_map[block.external_id]).map((block) => JSON.parse(document.meta.text_map[block.external_id]).map((op) => op.insert).join('')).join('\n').trim();
};

test('the library holds the imported AppFlowy templates alongside the built-in ones', () => {
  assert.ok(databases.length >= 20, `${databases.length} database templates`);
  assert.ok(documents.length >= 20, `${documents.length} document templates`);
  const ids = [...databases, ...documents].map((template) => template.template_id);

  assert.equal(new Set(ids).size, ids.length, 'template ids are unique across the library');
  for (const builtIn of ['tasks', 'projects', 'epics', 'opportunities', 'weekly-to-do-list', 'product-spec']) assert.ok(ids.includes(builtIn), builtIn);
  const imported = [...databases, ...documents].filter((template) => template.source_url);

  assert.ok(imported.length >= 30, `${imported.length} imported templates`);
  for (const template of imported) {
    assert.match(template.source_url, /^https:\/\/appflowy\.com\//, template.name);
    assert.ok(template.category && template.author, `${template.name} keeps its category and author`);
  }
});

const FORMULA = 19;
const REFERENCE = /prop\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
const linkedSets = databases.filter((template) => template.related_databases?.length);

test('imported templates carry nothing that would dangle in another workspace', () => {
  for (const template of databases) {
    // The template's own database and the ones it links to form one closed set.
    const set = [template, ...(template.related_databases ?? [])];
    const byRef = new Map(set.map((database) => [database.database_id ?? '__primary__', database]));

    assert.equal(byRef.size, set.length, `${template.name}: databases are told apart by id`);
    for (const database of set) {
      const label = `${template.name}/${database.name ?? 'main'}`;
      const types = new Set(database.fields.map((field) => field.field_type));
      const ids = new Set(database.fields.map((field) => field.id));
      const rowIds = new Set(database.rows.map((row) => row.id));

      for (const dropped of [13, 14]) assert.ok(!types.has(dropped), `${label} has no file/media field (${dropped})`);
      assert.equal(database.fields.filter((field) => field.is_primary).length, 1, `${label} has one title field`);
      for (const row of database.rows) for (const id of Object.keys(row.cells)) assert.ok(ids.has(id), `${label}: cell for a missing field`);
      for (const view of database.views) {
        assert.notEqual(view.layout, 7, `${label} has no form view`);
        for (const order of view.field_orders) assert.ok(ids.has(order.id), `${label}/${view.name}: field order entry`);
        for (const order of view.row_orders) assert.ok(rowIds.has(order.id), `${label}/${view.name}: row order entry`);
      }
      for (const field of database.fields) {
        const options = field.type_options?.[field.field_type] ?? {};

        if (field.field_type === 10) {
          const target = byRef.get(options.database_id);

          assert.ok(target, `${label}: relation "${field.name}" points at a database inside the template`);
          const targetRows = new Set(target.rows.map((row) => row.id));

          for (const row of database.rows) {
            for (const related of row.cells[field.id]?.data ?? []) assert.ok(targetRows.has(related), `${label}: relation cell names a row that is not in "${target.name ?? 'main'}"`);
          }
        }
        if (field.field_type === 16) {
          const relation = database.fields.find((candidate) => candidate.id === options.relation_field_id);
          const target = relation && byRef.get(relation.type_options?.[10]?.database_id);

          assert.ok(relation?.field_type === 10, `${label}: rollup "${field.name}" sits on a relation field`);
          assert.ok(target?.fields.some((candidate) => candidate.id === options.target_field_id), `${label}: rollup "${field.name}" reads a field that exists in the linked database`);
        }
        if (field.field_type === FORMULA) {
          for (const match of String(options.expression ?? '').matchAll(REFERENCE)) {
            assert.ok(database.fields.some((candidate) => candidate.id === match[1] || candidate.name === match[1]), `${label}: formula "${field.name}" reads existing field "${match[1]}"`);
          }
        }
      }
    }
  }
  for (const template of documents.filter((candidate) => candidate.source_url)) {
    const blocks = Object.values(template.pages.document.blocks);

    for (const block of blocks.filter((candidate) => ['image', 'file'].includes(candidate.ty))) {
      assert.ok(!/appflowy\.(cloud|com)|file_storage/i.test(String(block.data.url ?? '')), `${template.name}: no upload hosted on AppFlowy`);
    }
    assert.ok(!blocks.some((block) => block.ty === 'pdf'), `${template.name} has no PDF block`);
    // Every database block of a page has its database in the template, and nothing else is left dangling.
    const embeddedBlocks = blocks.filter((block) => ['calendar', 'grid', 'board', 'chart', 'list', 'gallery'].includes(block.ty));
    const provided = new Set((template.embedded_databases ?? []).map((embed) => embed.block_id));

    for (const block of embeddedBlocks) assert.ok(provided.has(block.id), `${template.name}: database block ${block.id} comes with its database`);
    for (const embed of template.embedded_databases ?? []) {
      assert.ok(embeddedBlocks.some((block) => block.id === embed.block_id), `${template.name}: embedded database belongs to a block of the page`);
      assert.ok(embed.database.views.length > 0 && embed.database.fields.length > 0, `${template.name}: embedded database has fields and views`);
    }
  }
});

test('the library includes pages that embed databases', () => {
  const embedding = documents.filter((template) => template.embedded_databases?.length).map((template) => template.name);

  for (const expected of ['User Interview', 'Fundraising tracker']) assert.ok(embedding.includes(expected), expected);
});

test('the library includes linked-database templates whose relations, rollups and formulas survived', () => {
  const names = linkedSets.map((template) => template.name);

  for (const expected of ['Project Completion Tracker', 'Project Expense Tracker', 'Project Progress Tracker', 'Product Development Tracker', 'Project Management', 'HR Team Project Tracker']) assert.ok(names.includes(expected), expected);
  const completion = databases.find((template) => template.name === 'Project Completion Tracker');
  const types = completion.fields.map((field) => field.field_type);

  assert.ok(types.includes(10) && types.includes(16) && types.includes(FORMULA), 'relation, rollup and formulas are all there');
  assert.ok(completion.rows.some((row) => (row.cells.tasks?.data ?? []).length > 0), 'projects are linked to tasks');
});

eachStorageMode('template library instantiation', (mode) => {
  let env, owner, agent;

  before(async () => {
    env = await startCardsEnv({ storage: mode, serverOptions: { searchIndexDelayMs: 0 } });
    owner = await account(env, `tpl-owner-${mode}`);
    agent = await mintToken(env, owner, { scope: 'read', name: 'Template checker' });
  });
  after(async () => { await env?.stop(); });

  test('the catalogs list every template with its category and counts', async () => {
    const dbCatalog = (await env.api('GET', '/api/template-catalog/database', undefined, owner.token)).body.data.templates;
    const docCatalog = (await env.api('GET', '/api/template-catalog/document', undefined, owner.token)).body.data.templates;

    assert.equal(dbCatalog.length, databases.length);
    assert.equal(docCatalog.length, documents.length);
    const bug = dbCatalog.find((template) => template.template_id === 'bug-tracker');

    assert.equal(bug.name, 'Bug Tracker');
    assert.ok(bug.category && bug.categories.includes(bug.category) && /Robin/.test(bug.author), 'category and author come through the catalog');
    assert.ok(bug.field_count > 0 && bug.row_count > 0);
  });

  test('every database template becomes a working database: fields, views, rows and card bodies', async () => {
    for (const template of databases) {
      const created = await env.api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/database/from-template`, {
        schema_version: 'v1', request_id: crypto.randomUUID(), template_id: template.template_id, parent_view_id: owner.spaceId, position: { kind: 'end' },
      }, owner.token);

      assert.equal(created.status, 200, `${template.name}: ${JSON.stringify(created.body)}`);
      const result = created.body.data.result;

      assert.equal(result.row_ids.length, template.rows.length, `${template.name}: rows`);
      assert.equal(result.view_ids.length, template.views.length, `${template.name}: views`);
      const collab = await env.store.getDatabaseCollab(owner.workspaceId, result.database_id);
      const doc = new Y.Doc();

      Y.applyUpdate(doc, collab.doc_state);
      const database = doc.getMap('data').get('database');

      assert.equal(database.get('fields').size, template.fields.length, `${template.name}: fields`);
      assert.equal(database.get('views').size, template.views.length, `${template.name}: view documents`);
      doc.destroy();
      // Read back through the card service: titles match the template's title cells, and bodies are readable.
      const primary = template.fields.find((field) => field.is_primary);
      const wanted = template.rows.filter((row) => row.visibility !== false).map((row) => String(row.cells[primary.id]?.data ?? ''));
      const listed = await mcpOk(env, agent.token, 'list_cards', { database_id: result.database_id, limit: 100 });

      assert.equal(listed.cards.length, wanted.length, `${template.name}: cards listed`);
      assert.deepEqual(listed.cards.map((card) => card.title).sort(), [...wanted].sort(), `${template.name}: card titles`);
      for (const row of template.rows.filter((candidate) => candidate.document)) {
        const index = template.rows.indexOf(row);
        const rowId = result.row_ids[index];
        const card = (await mcpOk(env, agent.token, 'get_card', { card_id: rowId })).card;
        const expected = textOf(row.document);

        assert.equal(card.has_body_document, true, `${template.name}: card ${index} has a body`);
        assert.ok(expected.length > 0, `${template.name}: template body has text`);
        const flat = card.body.replace(/\s+/g, ' ');
        const lines = expected.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 3);

        assert.ok(lines.length > 0 && lines.every((line) => flat.includes(line.slice(0, 200))) || card.body_truncated, `${template.name}: card ${index} body text`);
      }
    }
  });

  test('every linked-database template is created as a connected set: relations point at the new databases and rows', async () => {
    for (const template of linkedSets) {
      const created = await env.api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/database/from-template`, {
        schema_version: 'v1', request_id: crypto.randomUUID(), template_id: template.template_id, parent_view_id: owner.spaceId, position: { kind: 'end' },
      }, owner.token);

      assert.equal(created.status, 200, `${template.name}: ${JSON.stringify(created.body)}`);
      const primary = created.body.data;
      const linked = primary.related;

      assert.equal(linked.length, template.related_databases.length, `${template.name}: linked databases created`);
      const sets = [{ source: template, ...primary.result ?? primary }, ...linked.map((entry, index) => ({ source: template.related_databases[index], ...entry }))];
      const allDatabaseIds = new Set(sets.map((entry) => entry.database_id));
      const allRowIds = new Set(sets.flatMap((entry) => entry.row_ids));

      assert.equal(allDatabaseIds.size, sets.length, `${template.name}: every database has its own id`);
      for (const entry of sets) {
        assert.ok(entry.view_id && entry.view_ids.length === entry.source.views.length, `${template.name}/${entry.source.name ?? 'main'}: views`);
        const collab = await env.store.getDatabaseCollab(owner.workspaceId, entry.database_id);
        const doc = new Y.Doc();

        Y.applyUpdate(doc, collab.doc_state);
        const fields = doc.getMap('data').get('database').get('fields').toJSON();

        doc.destroy();
        for (const field of Object.values(fields).filter((candidate) => candidate.ty === 10)) {
          const target = field.type_option['10'].database_id;

          assert.ok(allDatabaseIds.has(target) && target !== undefined, `${template.name}: relation "${field.name}" points at a database created by this request`);
          assert.ok(!sets.some((other) => other.source.database_id && other.source.database_id === target), 'and not at an id from the template file');
        }
        for (const rowId of entry.row_ids) {
          const row = await rawRow(env, owner.workspaceId, rowId);

          assert.equal(row.database_id, entry.database_id);
          for (const [fieldId, cell] of Object.entries(row.cells)) {
            if (cell.field_type !== 10) continue;
            assert.ok(Array.isArray(cell.data), `${template.name}: relation cell of ${fieldId} is an array`);
            for (const related of cell.data) assert.ok(allRowIds.has(related), `${template.name}: relation cell names a row created by this request`);
          }
        }
        // The service the agents use reads every one of these databases, relation cells included.
        const listed = await mcpOk(env, agent.token, 'list_cards', { database_id: entry.database_id, limit: 100 });

        assert.equal(listed.cards.length, entry.source.rows.filter((row) => row.visibility !== false).length, `${template.name}/${entry.source.name ?? 'main'}: cards`);
      }
      // A replay of the same request creates nothing new and answers with the same ids.
    }
  });

  test('replaying a linked-template request is idempotent', async () => {
    const template = linkedSets[0];
    const request = { schema_version: 'v1', request_id: crypto.randomUUID(), template_id: template.template_id, parent_view_id: owner.spaceId, position: { kind: 'end' } };
    const url = `/api/workspace/${owner.workspaceId}/v2/page-view/database/from-template`;
    const first = await env.api('POST', url, request, owner.token);
    const again = await env.api('POST', url, request, owner.token);

    assert.equal(first.status, 200);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.outcome, 'already_applied');
    assert.deepEqual(again.body.data.related.map((entry) => entry.database_id), first.body.data.related.map((entry) => entry.database_id));
    assert.equal(again.body.data.database_id, first.body.data.database_id);
  });

  test('every document template becomes a page with its text', async () => {
    for (const template of documents) {
      const created = await env.api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/from-template`, {
        schema_version: 'v1', request_id: crypto.randomUUID(), template_id: template.template_id, parent_view_id: owner.spaceId, position: { kind: 'end' },
      }, owner.token);

      assert.equal(created.status, 200, `${template.name}: ${JSON.stringify(created.body)}`);
      const pageId = created.body.data.result.view_id;
      const collab = await env.store.getPageCollab(owner.workspaceId, pageId);
      const text = extractDocumentText(collab.doc_state);

      assert.ok(text.length > 20, `${template.name}: page has text`);
      const flat = text.replace(/\s+/g, ' ');
      const lines = textOf(template.pages.document).split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 3);
      const missing = lines.filter((line) => !flat.includes(line));

      assert.ok(missing.length <= Math.ceil(lines.length * 0.05), `${template.name}: ${missing.length} of ${lines.length} lines missing, e.g. ${JSON.stringify(missing.slice(0, 2))}`);
    }
  });

  test('a page with embedded databases gets them as children, and its blocks point at them', async () => {
    for (const template of documents.filter((candidate) => candidate.embedded_databases?.length)) {
      const created = await env.api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/from-template`, {
        schema_version: 'v1', request_id: crypto.randomUUID(), template_id: template.template_id, parent_view_id: owner.spaceId, position: { kind: 'end' },
      }, owner.token);

      assert.equal(created.status, 200, `${template.name}: ${JSON.stringify(created.body)}`);
      const pageId = created.body.data.result.view_id;
      const made = created.body.data.embedded_databases;

      assert.equal(made.length, template.embedded_databases.length, `${template.name}: embedded databases created`);
      const collab = await env.store.getPageCollab(owner.workspaceId, pageId);
      const doc = new Y.Doc();

      Y.applyUpdate(doc, collab.doc_state);
      const blocks = doc.getMap('data').get('document').get('blocks');

      for (const [index, embed] of template.embedded_databases.entries()) {
        const data = JSON.parse(blocks.get(embed.block_id).get('data'));

        assert.equal(data.database_id, made[index].database_id, `${template.name}: block points at the new database`);
        assert.equal(data.parent_id, pageId, `${template.name}: block names its page`);
        assert.ok(data.view_id && data.view_ids.includes(data.view_id) && made[index].view_ids.includes(data.view_id), `${template.name}: block shows one of the new views`);
        assert.ok(!JSON.stringify(data).includes(embed.database.database_id), 'no id from the template file is left in the block');
        // The database is a child page of the document, flagged as embedded, and readable by the card service.
        const container = await env.store.getPage(made[index].view_id);

        assert.equal(container.parent_view_id, pageId, `${template.name}: database sits under the page`);
        assert.equal(container.extra.embedded, true);
        const shown = await env.store.getPage(data.view_id);

        assert.equal(shown.extra.embedded, true, `${template.name}: the shown view is flagged embedded`);
        const listed = await mcpOk(env, agent.token, 'list_cards', { database_id: made[index].database_id, limit: 100 });

        assert.equal(listed.cards.length, embed.database.rows.filter((row) => row.visibility !== false).length, `${template.name}: embedded database rows`);
      }
      doc.destroy();
      // A replay creates nothing new.
      const again = await env.api('POST', `/api/workspace/${owner.workspaceId}/v2/page-view/document/from-template`, JSON.parse(JSON.stringify({
        schema_version: 'v1', request_id: created.body.data.request_id, template_id: template.template_id, parent_view_id: owner.spaceId, position: { kind: 'end' },
      })), owner.token);

      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.data.embedded_databases[0].database_id, made[0].database_id);
    }
  });
});
