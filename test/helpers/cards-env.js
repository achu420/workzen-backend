// Fixtures for the card service tests: a real test server (JSON storage) whose store is handed to
// cards.js directly, databases built through the existing HTTP routes, and raw Yjs readers/writers
// so assertions look at the persisted collab documents rather than at the service's own output.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import pg from 'pg';
import { startServer } from '../../server.js';
import { openStore } from '../../storage.js';

export const id = () => randomUUID();
const ORIGINAL_RESTORE_ID = '00000000-0000-0000-0000-000000000000';

/** True when a real PostgreSQL is configured for tests (same gate as the other postgres test files). */
export const postgresConfigured = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);

function databaseUrl(name) {
  const url = new URL(process.env.DATABASE_URL);

  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin(fn) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/**
 * Boots a real test server. `storage: 'postgres'` creates a disposable database on DATABASE_URL (migrated by
 * the server's own runner) and drops it on stop(); the default is the JSON store.
 */
export async function startCardsEnv({ storage = process.env.CARDS_TEST_STORAGE ?? 'json', serverOptions = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-cards-'));
  const file = path.join(dir, 'state.json');
  let dbName = null;

  if (storage === 'postgres') {
    assert.ok(postgresConfigured, 'postgres mode needs RUN_POSTGRES_TESTS=1 and DATABASE_URL');
    dbName = `cards_${randomUUID().replace(/-/g, '')}`;
    await withAdmin((client) => client.query(`CREATE DATABASE ${dbName}`));
  }
  const serverConfig = () => ({
    host: '127.0.0.1', port: 0, devKey: 'test-key',
    ...(storage === 'postgres' ? { storage: 'postgres', databaseUrl: databaseUrl(dbName) } : { file }),
    ...serverOptions,
  });
  const closeServer = async (running) => {
    await new Promise((resolve) => { running.server.closeAllConnections?.(); running.server.close(resolve); });
    await running.app.store.close?.();
  };
  const env = { dir, file, storage, serverOptions };

  function attach(running) {
    env.running = running;
    env.base = `http://127.0.0.1:${running.address.port}`;
    env.store = running.app.store;
  }

  env.api = async (method, route, payload, token) => {
    const response = await fetch(`${env.base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  attach(await startServer(serverConfig()));
  /** Stops the server and starts a new one on the same data (JSON file / same PostgreSQL database). */
  env.restart = async () => {
    await closeServer(env.running);
    attach(await startServer(serverConfig()));
  };
  /**
   * A second, independent store over the SAME data (what a restarted process would load): a copy of the JSON
   * state file, or a fresh connection pool on the same PostgreSQL database.
   */
  env.opened = [];
  env.reopenStore = async (label = 'reopened') => {
    let reopened;

    if (storage === 'postgres') reopened = await openStore(file, { storage: 'postgres', databaseUrl: databaseUrl(dbName) });
    else {
      const copy = path.join(dir, `${label}.json`);

      await copyFile(file, copy);
      reopened = await openStore(copy, {});
    }
    env.opened.push(reopened);
    return reopened;
  };
  env.stop = async () => {
    for (const reopened of env.opened) await reopened.close?.();
    await closeServer(env.running);
    if (dbName) await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  };
  return env;
}

/** A registered user with their own workspace and one public space. */
export async function account(env, label) {
  const email = `${label}@example.test`;

  assert.equal((await env.api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const login = (await env.api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body;
  const token = login.access_token;
  const workspaceId = (await env.api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;
  const spaceId = id();
  const space = await env.api('POST', `/api/workspace/${workspaceId}/spaces`, {
    name: 'Space', view_id: spaceId,
    permission: {
      visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null,
      invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false,
      security: { disable_guests: false, disable_public_links: false, disable_export: false },
    },
  }, token);

  assert.equal(space.status, 200);
  const user = await env.store.getUserByEmail(email);

  return { email, token, workspaceId, spaceId, userId: user.id, uid: String(user.uid) };
}

export async function createTemplateDatabase(env, acct, templateId, name) {
  const response = await env.api('POST', `/api/workspace/${acct.workspaceId}/v2/page-view/database/from-template`, {
    schema_version: 'v1', request_id: id(), template_id: templateId, parent_view_id: acct.spaceId, position: { kind: 'end' }, ...(name ? { name } : {}),
  }, acct.token);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const result = response.body.data.result;

  return { containerId: result.view_id, databaseId: result.database_id, viewIds: result.view_ids, rowIds: result.row_ids };
}

/** An empty Grid database (one text field "Name", no rows). */
export async function createBlankDatabase(env, acct, name = 'Blank') {
  const databaseId = id();
  const containerId = id();
  const viewId = id();
  const response = await env.api('POST', `/api/workspace/${acct.workspaceId}/v2/page-view/database/default`, {
    schema_version: 'v1', request_id: id(), parent_view_id: acct.spaceId, name, position: { kind: 'start' }, container_id: containerId,
    database: { database_id: databaseId, view_id: viewId, name: 'Grid', layout: 0, embedded: false, responses_view_id: null, initial_row_ids: [], timezone_id: null },
  }, acct.token);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { containerId, databaseId, viewIds: [viewId], rowIds: [] };
}

export async function addBoardView(env, acct, { databaseId, containerId, name = 'Board', sourceViewId = null }) {
  const viewId = id();
  const response = await env.api('POST', `/api/workspace/${acct.workspaceId}/v2/page-view/database-view/default`, {
    schema_version: 'v1', request_id: id(), database_restore_id: ORIGINAL_RESTORE_ID,
    view: { database_id: databaseId, view_id: viewId, parent_view_id: containerId, source_view_id: sourceViewId, name, layout: 1, embedded: false, responses_view_id: null, timezone_id: null },
    position: { kind: 'end' }, icon: null, extra: null,
  }, acct.token);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  return viewId;
}

/** Applies `mutate(doc)` to a stored collab the way a browser would: diff accepted through the store. */
async function acceptDiff(env, kind, workspaceId, objectId, mutate) {
  const load = kind === 'row' ? env.store.getDatabaseRowCollab : env.store.getDatabaseCollab;
  const accept = kind === 'row' ? env.store.acceptDatabaseRowCollabUpdate : env.store.acceptDatabaseCollabUpdate;
  const collab = await load(workspaceId, objectId);
  const doc = new Y.Doc({ guid: objectId });

  Y.applyUpdate(doc, collab.doc_state);
  const before = Y.encodeStateVector(doc);

  doc.transact(() => mutate(doc));
  const payload = Y.encodeStateAsUpdate(doc, before);

  doc.destroy();
  return accept({ workspaceId, [kind === 'row' ? 'rowId' : 'databaseId']: objectId, flags: 0, payload, beforeStateVector: before });
}

export const humanEditDatabase = (env, workspaceId, databaseId, mutate) => acceptDiff(env, 'database', workspaceId, databaseId, (doc) => mutate(doc.getMap('data').get('database'), doc));
export const humanEditRow = (env, workspaceId, rowId, mutate) => acceptDiff(env, 'row', workspaceId, rowId, (doc) => mutate(doc.getMap('data').get('data'), doc));

/** Adds a field the way the web does (a Database-doc write) and returns its id. */
export async function addField(env, workspaceId, databaseId, { fieldId = id(), name, type, options }) {
  await humanEditDatabase(env, workspaceId, databaseId, (database) => {
    const field = new Y.Map();

    field.set('id', fieldId);
    field.set('name', name);
    field.set('ty', type);
    field.set('icon', '');
    field.set('is_primary', false);
    field.set('created_at', '1');
    field.set('last_modified', '1');
    const typeOption = new Y.Map();
    const config = new Y.Map();

    if (options) config.set('content', JSON.stringify({ options, disable_color: false }));
    typeOption.set(String(type), config);
    field.set('type_option', typeOption);
    database.get('fields').set(fieldId, field);
    for (const view of database.get('views').values()) view.get('field_orders').push([{ id: fieldId }]);
  });
  return fieldId;
}

/** What choosing "group by <field>" in a Board does: one group entry on the view. */
export async function setBoardGroupField(env, workspaceId, databaseId, viewId, fieldId) {
  await humanEditDatabase(env, workspaceId, databaseId, (database) => {
    const view = database.get('views').get(viewId);
    const field = database.get('fields').get(fieldId);
    const group = new Y.Map();
    const columns = new Y.Array();
    const noStatus = new Y.Map();

    noStatus.set('id', fieldId);
    noStatus.set('visible', true);
    columns.push([noStatus]);
    group.set('id', fieldId);
    group.set('field_id', fieldId);
    group.set('type', Number(field.get('ty')));
    group.set('content', '');
    group.set('groups', columns);
    group.set('collapsed_group_ids', new Y.Array());
    const groups = new Y.Array();

    groups.push([group]);
    view.set('groups', groups);
  });
}

export const KITCHEN = {
  status: 'f_status', labels: 'f_labels', reviewed: 'f_reviewed', link: 'f_link', due: 'f_due', points: 'f_points', notes: 'f_notes', relation: 'f_relation', priority: 'f_priority',
};

/**
 * "Kitchen sink" database: a blank database (title field "Name") plus every writable field type, a
 * read-only Relation field, a second single-select (Priority) and a Board grouped by Status.
 * Built with the same Database-doc writes the web performs (see addField / setBoardGroupField).
 */
export async function createKitchenSink(env, acct, name = 'Kitchen') {
  const base = await createBlankDatabase(env, acct, name);
  const { databaseId, containerId } = base;
  const ws = acct.workspaceId;

  await addField(env, ws, databaseId, { fieldId: KITCHEN.status, name: 'Status', type: 3, options: [{ id: 'o_todo', name: 'Todo', color: 'Pink' }, { id: 'o_doing', name: 'Doing', color: 'Yellow' }, { id: 'o_done', name: 'Done', color: 'Green' }] });
  await addField(env, ws, databaseId, { fieldId: KITCHEN.priority, name: 'Priority', type: 3, options: [{ id: 'p_high', name: 'High', color: 'Red' }, { id: 'p_low', name: 'Low', color: 'Blue' }] });
  await addField(env, ws, databaseId, { fieldId: KITCHEN.labels, name: 'Labels', type: 4, options: [{ id: 'l_bug', name: 'Bug', color: 'Red' }, { id: 'l_ui', name: 'UI', color: 'Blue' }, { id: 'l_ops', name: 'Ops', color: 'Gray' }] });
  await addField(env, ws, databaseId, { fieldId: KITCHEN.reviewed, name: 'Reviewed', type: 5 });
  await addField(env, ws, databaseId, { fieldId: KITCHEN.link, name: 'Link', type: 6 });
  await addField(env, ws, databaseId, { fieldId: KITCHEN.due, name: 'Due', type: 2 });
  await addField(env, ws, databaseId, { fieldId: KITCHEN.points, name: 'Points', type: 1 });
  await addField(env, ws, databaseId, { fieldId: KITCHEN.notes, name: 'Notes', type: 0 });
  await addField(env, ws, databaseId, { fieldId: KITCHEN.relation, name: 'Related', type: 10 });
  const boardViewId = await addBoardView(env, acct, { databaseId, containerId, name: 'Board' });

  await setBoardGroupField(env, ws, databaseId, boardViewId, KITCHEN.status);
  return { ...base, boardViewId, gridViewId: base.viewIds[0] };
}

// ---------------------------------------------------------------- raw readers
export async function readDatabaseDoc(env, workspaceId, databaseId) {
  const collab = await env.store.getDatabaseCollab(workspaceId, databaseId);
  const doc = new Y.Doc({ guid: databaseId });

  Y.applyUpdate(doc, collab.doc_state);
  return { doc, database: doc.getMap('data').get('database') };
}

export async function rowOrdersOf(env, workspaceId, databaseId, viewId) {
  const { doc, database } = await readDatabaseDoc(env, workspaceId, databaseId);

  try {
    return database.get('views').get(viewId).get('row_orders').toArray();
  } finally {
    doc.destroy();
  }
}

export async function rawRow(env, workspaceId, rowId) {
  const collab = await env.store.getDatabaseRowCollab(workspaceId, rowId);
  const doc = new Y.Doc({ guid: rowId });

  Y.applyUpdate(doc, collab.doc_state);
  try {
    return doc.getMap('data').get('data').toJSON();
  } finally {
    doc.destroy();
  }
}

/** A recording broadcast callback; `failing` makes every call reject. */
export function recorder({ failing = false } = {}) {
  const events = [];
  const broadcast = async (event) => {
    events.push(event);
    if (failing) throw new Error('peer send failed');
  };

  return { events, broadcast };
}

/** Decodes a broadcast diff on top of a base state so tests can assert on what a peer would see. */
export function applyDiff(baseState, update) {
  const doc = new Y.Doc();

  if (baseState) Y.applyUpdate(doc, baseState);
  Y.applyUpdate(doc, update);
  return doc;
}
