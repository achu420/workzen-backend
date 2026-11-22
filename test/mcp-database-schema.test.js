// create_database / update_database, and relation + person card values. Real HTTP server, real agent tokens. Builds
// the NOVIMI work-tracking structure (EPIC -> Tasks -> test cases) the way an agent would, then checks the stored Yjs
// shapes against what AppFlowy-Web reads, two-way link upkeep, card templates, and the "never destructive" rules.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { account, rawRow, readDatabaseDoc, startCardsEnv } from './helpers/cards-env.js';
import { COLLAB, eachStorageMode, mcpOk, mcpTool, mintToken, openViewer } from './helpers/mcp-live-env.js';
import { parseMarkdownLite } from '../page-writer.js';
import { decodeTemplateBody, encodeTemplateBody, readRowTemplates } from '../row-template.js';

describe('markdown-lite pipe tables', () => {
  test('a pipe table becomes table -> rows -> cells -> paragraph, padded to the widest row', () => {
    const [table, after] = parseMarkdownLite('| # | Step | Expected |\n|---|------|----------|\n| 1 | Open the app | Sign-in screen is shown |\n| 2 | Tap **Sign in** |\nAfter');

    assert.equal(table.ty, 'simple_table');
    assert.deepEqual(table.data, { enable_header_row: true });
    assert.equal(table.children.length, 3, 'the separator row is not a row');
    assert.ok(table.children.every((row) => row.ty === 'simple_table_row' && row.children.length === 3), 'every row has three cells');
    assert.deepEqual(table.children[1].children.map((cell) => cell.children[0].delta.map((op) => op.insert).join('')), ['1', 'Open the app', 'Sign-in screen is shown']);
    assert.deepEqual(table.children[2].children[1].children[0].delta[1], { insert: 'Sign in', attributes: { bold: true } });
    assert.equal(table.children[2].children[2].children[0].delta.length, 0, 'a missing cell is an empty paragraph');
    assert.equal(after.ty, 'paragraph');
  });

  test('empty list items (template placeholders) stay list items; a dash inside text does not', () => {
    const blocks = parseMarkdownLite('-\n1.\n- [ ]\n-5 degrees');

    assert.deepEqual(blocks.map((block) => block.ty), ['bulleted_list', 'numbered_list', 'todo_list', 'paragraph']);
    assert.ok(blocks.slice(0, 3).every((block) => block.delta.length === 0));
  });

  test('a template body survives the Desktop protobuf encoding unchanged', () => {
    const blocks = parseMarkdownLite('## Steps\n| Step | Expected |\n|---|---|\n| Open | Shown |\n- [ ] done');

    assert.deepEqual(decodeTemplateBody(encodeTemplateBody(blocks)), blocks);
  });
});

eachStorageMode('MCP database schema tools', (mode) => {
  let env, owner, member, write, read;
  let epics, tasks, testCases;
  let created = 0;
  const key = (label) => `${label}-${mode}-${(created += 1)}-key`;
  const call = (name, args, token = write.token) => mcpTool(env, token, name, args);
  const ok = (name, args, token = write.token) => mcpOk(env, token, name, args);
  const errorOf = (response) => (response.result?.isError ? response.result.content[0].text : null);
  const fieldsOf = async (databaseId) => {
    const { doc, database } = await readDatabaseDoc(env, owner.workspaceId, databaseId);

    try {
      return Object.fromEntries([...database.get('fields').values()].map((field) => [field.get('name'), { id: field.get('id'), ty: field.get('ty'), option: field.get('type_option').get(String(field.get('ty')))?.toJSON() ?? {} }]));
    } finally {
      doc.destroy();
    }
  };
  const options = (field) => JSON.parse(field.option.content).options;

  before(async () => {
    env = await startCardsEnv({ storage: mode });
    owner = await account(env, `schema-owner-${mode}`);
    member = await account(env, `schema-member-${mode}`);
    // The member joins the owner's workspace through the invite-code flow (person fields list workspace members).
    const { code } = (await env.api('POST', `/api/workspace/${owner.workspaceId}/invite-code`, {}, owner.token)).body.data;

    assert.equal((await env.api('POST', '/api/workspace/join-by-invite-code', { code }, member.token)).status, 200);
    write = await mintToken(env, owner, { scope: 'write', name: "Achal's Claude Code" });
    read = await mintToken(env, owner, { scope: 'read', name: "Achal's Cursor" });
  });
  after(async () => { await env?.stop(); });

  test('create_database: EPIC with selects, person, date, a Board and a card template with a table', async () => {
    const epicKey = key('epic');

    epics = await ok('create_database', {
      parent_id: owner.spaceId, name: 'EPIC', title_field: 'Epic name', idempotency_key: epicKey,
      fields: [
        { name: 'Epic ID', type: 'text' },
        { name: 'Status', type: 'select', options: ['Not started', 'In progress', 'Done', { name: 'On hold', color: 'Orange' }] },
        { name: 'Phase', type: 'select', options: ['1 Core Platform', '2 AI Tools', '3 Media AI', '4 Optimisation'] },
        { name: 'Priority', type: 'select', options: ['P0', 'P1', 'P2', 'P3'] },
        { name: 'Owner', type: 'person', one_person_only: true },
        { name: 'Target date', type: 'date' },
        { name: 'Created at', type: 'created_time' },
        { name: 'Created by', type: 'created_by' },
      ],
      board: { group_by: 'Status' },
      card_template: { name: 'Epic', content: '## Goal\nWhat this epic delivers and why\n## In scope\n- \n## Out of scope\n- \n## Requirement document\n| Document | Link |\n|---|---|\n| Requirement | |' },
    });

    assert.equal(epics.name, 'EPIC');
    assert.equal(epics.replayed, false);
    assert.deepEqual(epics.views.map((view) => view.layout), ['board', 'grid']);
    const fields = await fieldsOf(epics.database_id);

    assert.equal(fields['Epic name'].ty, 0);
    assert.deepEqual(options(fields.Status).map((option) => option.name), ['Not started', 'In progress', 'Done', 'On hold']);
    assert.equal(options(fields.Status)[3].color, 'Orange');
    assert.equal(new Set(options(fields.Status).map((option) => option.id)).size, 4, 'option ids are unique');
    assert.deepEqual(fields.Owner.option, { is_single_select: true, fill_with_creator: false, disable_notification: false, persons: '[]' }, 'person type option as createField writes it');
    assert.deepEqual([fields['Created at'].ty, fields['Created by'].ty], [9, 17]);
    // The Board is grouped by Status, one column per option plus "No status" (the field id itself).
    const { doc, database } = await readDatabaseDoc(env, owner.workspaceId, epics.database_id);
    const board = [...database.get('views').values()].find((view) => view.get('layout') === 1);
    const group = board.get('groups').get(0);

    assert.equal(group.get('field_id'), fields.Status.id);
    assert.deepEqual(group.get('groups').toArray().map((entry) => entry.get('id')), [fields.Status.id, ...options(fields.Status).map((option) => option.id)]);
    // The card template, in the format the web's template store reads: entry + projection + matching sha256 + default id.
    const metas = database.get('metas');
    const projection = metas.get('row_templates');

    assert.equal(metas.get('row_templates_projection_sha256'), createHash('sha256').update(projection).digest('hex'));
    const { templates, defaultId } = readRowTemplates(metas);

    assert.equal(templates.length, 1);
    assert.equal(defaultId, templates[0].template_id);
    assert.equal(templates[0].name, 'Epic');
    assert.equal(templates[0].is_document_empty, false);
    assert.deepEqual(decodeTemplateBody(templates[0].doc_data).map((block) => block.ty), ['heading', 'paragraph', 'heading', 'bulleted_list', 'heading', 'bulleted_list', 'heading', 'simple_table']);
    doc.destroy();
    const again = await ok('create_database', { parent_id: owner.spaceId, name: 'EPIC', title_field: 'Epic name', idempotency_key: epicKey, fields: [] });

    assert.equal(again.database_id, epics.database_id, 'the same idempotency key returns the same database');
    assert.equal(again.replayed, true);
  });

  test('create_database: Tasks links to EPIC two-way, to itself one-way, with a helper formula', async () => {
    tasks = await ok('create_database', {
      parent_id: owner.spaceId, name: 'Tasks', idempotency_key: key('tasks'),
      fields: [
        { name: 'Task ID', type: 'text' },
        { name: 'Type', type: 'select', options: ['Story', 'Tech task', 'Research', 'Bug', 'Design/UX', 'Chore'] },
        { name: 'Epic', type: 'relation', relation: { database_id: epics.database_id, one_card_only: true, reciprocal_name: 'Tasks' } },
        { name: 'Parent story', type: 'relation', relation: { database_id: 'self', one_card_only: true } },
        { name: 'Status', type: 'select', options: ['Backlog', 'To do', 'In progress', 'In review', 'In QA', 'Done', 'Blocked'] },
        { name: 'Assignee', type: 'person' },
        { name: 'Story points', type: 'number' },
        { name: 'Platform', type: 'multi_select', options: ['Android', 'iOS', 'Web', 'Admin', 'Backend'] },
        { name: 'Requirement link', type: 'url' },
        { name: 'Done points', type: 'formula', formula: { expression: 'if(prop("Status") == "Done", prop("Story points"), 0)' } },
      ],
      board: { group_by: 'Status', name: 'Sprint board' },
    });
    assert.deepEqual(tasks.reciprocal_fields, [{ field: 'Epic', database_id: epics.database_id, reciprocal_field: 'Tasks' }]);
    const taskFields = await fieldsOf(tasks.database_id);
    const epicFields = await fieldsOf(epics.database_id);

    assert.deepEqual(taskFields.Epic.option, {
      database_id: epics.database_id, is_two_way: true, source_limit: 1, target_limit: 0, reciprocal_field_name: 'Tasks', reciprocal_field_id: epicFields.Tasks.id,
    });
    assert.deepEqual(epicFields.Tasks.option, {
      database_id: tasks.database_id, is_two_way: true, reciprocal_field_id: taskFields.Epic.id, reciprocal_field_name: 'Epic', source_limit: 0, target_limit: 1,
    }, 'the reciprocal field points back, as useUpdateRelationTypeOption creates it');
    assert.deepEqual(taskFields['Parent story'].option, { database_id: tasks.database_id, is_two_way: false, source_limit: 1, target_limit: 0 }, 'a self relation is one-way');
    assert.equal(taskFields['Done points'].option.expression, `if(prop("${taskFields.Status.id}") == "Done", prop("${taskFields['Story points'].id}"), 0)`, 'formulas are stored with field ids');
    // The reciprocal column is visible in every EPIC view.
    const { doc, database } = await readDatabaseDoc(env, owner.workspaceId, epics.database_id);

    for (const view of database.get('views').values()) assert.ok(view.get('field_orders').toArray().some((entry) => entry.id === epicFields.Tasks.id));
    doc.destroy();
  });

  test('update_database: EPIC gets point rollups and a progress formula; bad operations change nothing', async () => {
    const before = await fieldsOf(epics.database_id);
    const refused = await call('update_database', { database_id: epics.database_id, operations: [
      { op: 'add_field', new_field: { name: 'Total points', type: 'rollup', rollup: { relation: 'Tasks', target: 'Story points', calculation: 'sum' } } },
      { op: 'add_field', new_field: { name: 'Broken', type: 'formula', formula: { expression: 'prop("Nope") + 1' } } },
    ] });

    assert.match(errorOf(refused), /prop\("Nope"\).*no such field/);
    assert.deepEqual(Object.keys(await fieldsOf(epics.database_id)).sort(), Object.keys(before).sort(), 'the valid first operation was not applied either');
    const updated = await ok('update_database', { database_id: epics.database_id, operations: [
      { op: 'add_field', new_field: { name: 'Total points', type: 'rollup', rollup: { relation: 'Tasks', target: 'Story points', calculation: 'sum' } } },
      { op: 'add_field', new_field: { name: 'Done points', type: 'rollup', rollup: { relation: 'Tasks', target: 'Done points', calculation: 'sum' } } },
      { op: 'add_field', new_field: { name: 'Progress %', type: 'formula', formula: { expression: 'if(prop("Total points") == 0, 0, round(prop("Done points") / prop("Total points") * 100))' } } },
      { op: 'add_field', new_field: { name: 'Done tasks', type: 'rollup', rollup: { relation: 'Tasks', target: 'Status', calculation: 'count_values', values: ['Done'] } } },
    ] });

    assert.equal(updated.changes.length, 4);
    const epicFields = await fieldsOf(epics.database_id);
    const taskFields = await fieldsOf(tasks.database_id);

    assert.deepEqual(epicFields['Total points'].option, { relation_field_id: epicFields.Tasks.id, target_field_id: taskFields['Story points'].id, calculation_type: 4, show_as: 0, condition_value: '' });
    assert.equal(epicFields['Done points'].option.target_field_id, taskFields['Done points'].id, 'a rollup can sum a formula of the linked cards');
    assert.equal(epicFields['Done tasks'].option.condition_value, options(taskFields.Status).find((option) => option.name === 'Done').id, 'one value is stored unquoted (writeRollupCondition)');
    assert.match(epicFields['Progress %'].option.expression, new RegExp(`prop\\("${epicFields['Total points'].id}"\\)`));
  });

  test('create_database + update_database: test cases under Tasks, QA rollups and status formula on Tasks', async () => {
    testCases = await ok('create_database', {
      parent_id: owner.spaceId, name: 'test cases', idempotency_key: key('tc'),
      fields: [
        { name: 'TC ID', type: 'text' },
        { name: 'Task', type: 'relation', relation: { database_id: tasks.database_id, one_card_only: true, reciprocal_name: 'test cases' } },
        { name: 'Epic', type: 'rollup', rollup: { relation: 'Task', target: 'Epic', calculation: 'list' } },
        { name: 'Run status', type: 'select', options: ['Not run', 'Pass', 'Fail', 'Blocked', 'Skipped'] },
        { name: 'Bug', type: 'relation', relation: { database_id: tasks.database_id, two_way: false } },
      ],
    });
    const tcFields = await fieldsOf(testCases.database_id);

    assert.equal(tcFields.Epic.option.show_as, 1, '"list" shows the linked values');
    assert.equal(tcFields.Bug.option.is_two_way, false);
    assert.equal(testCases.reciprocal_fields.length, 1, 'only the two-way relation adds a field to Tasks');
    await ok('update_database', { database_id: tasks.database_id, operations: [
      { op: 'add_field', new_field: { name: 'Tests total', type: 'rollup', rollup: { relation: 'test cases', target: 'TC ID', calculation: 'count' } } },
      { op: 'add_field', new_field: { name: 'Tests passed', type: 'rollup', rollup: { relation: 'test cases', target: 'Run status', calculation: 'count_values', values: ['Pass'] } } },
      { op: 'add_field', new_field: { name: 'Tests failed', type: 'rollup', rollup: { relation: 'test cases', target: 'Run status', calculation: 'count_values', values: ['Fail'] } } },
      { op: 'add_field', new_field: { name: 'QA status', type: 'formula', formula: { expression: 'ifs(prop("Tests total") == 0, "No tests", prop("Tests failed") > 0, "Failing", prop("Tests passed") == prop("Tests total"), "All passed", "Testing")' } } },
      { op: 'set_card_template', name: 'Story', content: '## User story\nAs a ..., I want ..., so that ...\n## Acceptance criteria\n1. \n## Technical notes\n## Out of scope' },
    ] });
    const taskFields = await fieldsOf(tasks.database_id);

    assert.equal(taskFields['Tests total'].option.relation_field_id, taskFields['test cases'].id);
    assert.ok(!/prop\("Tests/.test(taskFields['QA status'].option.expression), 'every reference became an id');
  });

  test('update_database renames, adds and renames options (the Board gets the new column), sets a formula', async () => {
    const updated = await ok('update_database', { database_id: tasks.database_id, name: 'Work items', operations: [
      { op: 'rename_field', field: 'Task ID', new_name: 'Key' },
      { op: 'add_options', field: 'Status', options: ['Won\'t do'] },
      { op: 'rename_option', field: 'Type', option: 'Chore', new_name: 'Maintenance', color: 'Blue' },
      { op: 'set_formula', field: 'Done points', expression: 'if(prop("Status") == "Done" or prop("Status") == "In QA", prop("Story points"), 0)' },
    ] });

    assert.equal(updated.name, 'Work items');
    assert.equal(updated.previous_name, 'Tasks');
    const fields = await fieldsOf(tasks.database_id);

    assert.ok(fields.Key && !fields['Task ID']);
    assert.equal(options(fields.Type).find((option) => option.name === 'Maintenance').color, 'Blue');
    const wontDo = options(fields.Status).find((option) => option.name === 'Won\'t do');
    const { doc, database } = await readDatabaseDoc(env, owner.workspaceId, tasks.database_id);
    const board = [...database.get('views').values()].find((view) => view.get('layout') === 1);

    assert.ok(board.get('groups').get(0).get('groups').toArray().some((entry) => entry.get('id') === wontDo.id), 'new option is a Board column');
    doc.destroy();
    const listed = await ok('list_databases', {}, read.token);

    assert.ok(listed.databases.some((entry) => entry.database_id === tasks.database_id && entry.name === 'Work items'));
    await ok('update_database', { database_id: tasks.database_id, name: 'Tasks' });
  });

  test('destructive changes are refused: no delete, no retype, no option removal, and read-only tokens cannot write', async () => {
    const before = await fieldsOf(tasks.database_id);

    for (const op of [{ op: 'delete_field', field: 'Key' }, { op: 'change_type', field: 'Key' }, { op: 'remove_option', field: 'Status', option: 'Done' }]) {
      const response = await call('update_database', { database_id: tasks.database_id, operations: [op] });

      assert.ok(errorOf(response), JSON.stringify(op));
    }
    assert.match(errorOf(await call('update_database', { database_id: tasks.database_id, operations: [{ op: 'add_field', new_field: { name: 'Status', type: 'text' } }] })), /already a field named "Status"/);
    assert.match(errorOf(await call('update_database', { database_id: tasks.database_id, name: 'X' }, read.token)), /read-only/);
    assert.match(errorOf(await call('create_database', { parent_id: owner.spaceId, name: 'X', idempotency_key: key('ro') }, read.token)), /read-only/);
    assert.match(errorOf(await call('create_database', { parent_id: tasks.database_id, name: 'X', idempotency_key: key('bad-parent') })), /Parent not found/);
    assert.match(errorOf(await call('create_database', { parent_id: owner.spaceId, name: 'X', idempotency_key: key('bad-rollup'), fields: [{ name: 'R', type: 'rollup', rollup: { relation: 'Nope', target: 'x', calculation: 'sum' } }] })), /relation field/);
    assert.deepEqual(await fieldsOf(tasks.database_id), before, 'nothing changed');
  });

  test('cards: relation and person values, both sides of two-way links, displacement, and the card template', async () => {
    const epicA = await ok('create_card', { database_id: epics.database_id, title: 'Sign-in', idempotency_key: key('epic-a'), fields: { 'Epic ID': 'EP-01', Owner: [owner.email] } });
    const epicB = await ok('create_card', { database_id: epics.database_id, title: 'Payments', idempotency_key: key('epic-b'), use_template: false });

    assert.equal(epicA.template, 'Epic', 'the default template was applied');
    assert.equal(epicB.template, null);
    const epicCard = await ok('get_card', { card_id: epicA.card.id }, read.token);

    assert.match(epicCard.card.body, /Goal\nWhat this epic delivers and why\nIn scope/);
    assert.match(epicCard.card.body, /Document\nLink\nRequirement/, 'the template table is in the body');
    assert.deepEqual(epicCard.card.fields.Owner, [owner.email], 'a member without a profile name reads back as their email');
    // Someone has the epic open: the task's link back must reach them live.
    const viewer = await openViewer(env, owner, [{ collabType: COLLAB.row, objectId: epicA.card.id }]);
    let story;

    try {
      story = await ok('create_card', { database_id: tasks.database_id, title: 'Google sign-in', idempotency_key: key('story'), fields: { Type: 'Story', Epic: [epicA.card.id], 'Story points': 5, Assignee: [member.email] } });
      assert.equal(story.template, 'Story');
      assert.deepEqual(story.card.fields.Epic, [epicA.card.id]);
      await viewer.waitUntil(() => {
        const cells = viewer.doc(COLLAB.row, epicA.card.id).getMap('data').get('data').get('cells').toJSON();

        return Object.values(cells).some((cell) => Array.isArray(cell.data) && cell.data.includes(story.card.id));
      });
    } finally {
      viewer.close();
    }
    const epicFields = await fieldsOf(epics.database_id);

    assert.deepEqual((await rawRow(env, owner.workspaceId, epicA.card.id)).cells[epicFields.Tasks.id].data, [story.card.id], 'the epic lists its task (reciprocal side)');
    assert.equal((await rawRow(env, owner.workspaceId, epicA.card.id)).cells[epicFields.Tasks.id].field_type, 10);
    const linked = await ok('get_card', { card_id: story.card.id }, read.token);

    assert.deepEqual(linked.card.links.Epic, [{ id: epicA.card.id, title: 'Sign-in' }]);
    assert.equal(linked.card.fields.Assignee.length, 1);
    // Moving the task to another epic: one card only, so the first epic loses it.
    await ok('update_card', { card_id: story.card.id, fields: { Epic: [epicB.card.id] } });
    assert.deepEqual((await rawRow(env, owner.workspaceId, epicA.card.id)).cells[epicFields.Tasks.id].data, []);
    assert.deepEqual((await rawRow(env, owner.workspaceId, epicB.card.id)).cells[epicFields.Tasks.id].data, [story.card.id]);
    // Linking from the epic's side (Tasks holds many) moves the task's single Epic link, and the old epic drops it.
    const second = await ok('create_card', { database_id: tasks.database_id, title: 'Apple sign-in', idempotency_key: key('story-2'), fields: { Epic: epicB.card.id } });

    await ok('update_card', { card_id: epicA.card.id, fields: { Tasks: [second.card.id] } });
    assert.deepEqual((await rawRow(env, owner.workspaceId, second.card.id)).cells[(await fieldsOf(tasks.database_id)).Epic.id].data, [epicA.card.id]);
    assert.deepEqual((await rawRow(env, owner.workspaceId, epicB.card.id)).cells[epicFields.Tasks.id].data, [story.card.id], 'epic B no longer lists the moved task');
    // Bad values.
    assert.match(errorOf(await call('update_card', { card_id: story.card.id, fields: { Epic: [epicA.card.id, epicB.card.id] } })), /one card only/);
    assert.match(errorOf(await call('update_card', { card_id: story.card.id, fields: { Epic: [story.card.id] } })), /not a card of "EPIC"/);
    assert.match(errorOf(await call('update_card', { card_id: story.card.id, fields: { Assignee: ['nobody@example.test'] } })), /not a member/);
    assert.match(errorOf(await call('update_card', { card_id: story.card.id, fields: { 'Done points': 3 } })), /Workzen computes it/);
  });
});
