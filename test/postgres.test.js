import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server.js';

const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;
test('PostgreSQL end-to-end isolated persistence and concurrency', { skip: !configured }, async () => {
  const apps = [];
  const start = async () => { const running = await startServer({ folderChangedDelayMs: 600000, storage: 'postgres', databaseUrl: process.env.DATABASE_URL, port: 0, host: '127.0.0.1', devKey: 'task15-key', environment: 'test' }); apps.push(running); return running; };
  const first = await start();
  const base = (running) => `http://127.0.0.1:${running.address.port}`;
  const api = async (running, method, route, payload, token, headers = {}) => { const response = await fetch(`${base(running)}${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) }); const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null }; };
  const aliceEmail = `task15-alice-${randomUUID()}@example.test`; const bobEmail = `task15-bob-${randomUUID()}@example.test`;
  try {
    const pool = first.app.store.pool;
    const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','sessions','workspaces','memberships','pages','workspace_database_collabs') ORDER BY table_name")).rows.map((r) => r.table_name);
    for (const table of ['memberships', 'pages', 'sessions', 'users', 'workspaces', 'workspace_database_collabs']) assert.ok(tables.includes(table));
    let r = await api(first, 'POST', '/api/auth/register', { email: aliceEmail, password: 'Correct horse 123' }); assert.equal(r.status, 201);
    r = await api(first, 'POST', '/api/auth/register', { email: aliceEmail, password: 'Correct horse 123' }); assert.equal(r.status, 409);
    r = await api(first, 'POST', '/api/auth/register', { email: bobEmail, password: 'Correct horse 456' }); assert.equal(r.status, 201);
    r = await api(first, 'POST', '/api/auth/login', { email: aliceEmail, password: 'Correct horse 123' }); assert.equal(r.status, 200); const alice = r.body.access_token;
    r = await api(first, 'POST', '/api/auth/login', { email: bobEmail, password: 'Correct horse 456' }); assert.equal(r.status, 200); const bob = r.body.access_token;
    r = await api(first, 'GET', '/api/auth/me', undefined, alice); assert.equal(r.status, 200);
    r = await api(first, 'POST', '/api/workspaces', { name: 'Task 15 isolated workspace' }, alice); assert.equal(r.status, 201); const workspace = r.body.workspace;
    r = await api(first, 'GET', `/api/workspaces/${workspace.id}`, undefined, bob); assert.equal(r.status, 403);
    const collabRoute = `/api/workspace/v1/${workspace.id}/collab/${workspace.database_storage_id}?collab_type=2`;
    r = await api(first, 'GET', collabRoute, undefined, bob); assert.equal(r.status, 403);
    r = await api(first, 'POST', `/api/workspaces/${workspace.id}/test-members`, { email: bobEmail, role: 'member' }, alice, { 'x-development-key': 'task15-key' }); assert.equal(r.status, 201);
    r = await api(first, 'GET', `/api/workspaces/${workspace.id}`, undefined, bob); assert.equal(r.status, 200);
    r = await api(first, 'GET', collabRoute, undefined, alice); assert.equal(r.status, 200); assert.equal(r.body.data.object_id, workspace.database_storage_id); const workspaceDatabaseState = r.body.data.doc_state;
    r = await api(first, 'GET', collabRoute, undefined, bob); assert.equal(r.status, 200); assert.deepEqual(r.body.data.doc_state, workspaceDatabaseState);
    r = await api(first, 'POST', `/api/workspaces/${workspace.id}/pages`, { title: 'Initial', document: { data: { document: { page_id: 'task15-page' } } } }, alice); assert.equal(r.status, 201); const page = r.body.page;
    r = await api(first, 'GET', `/api/pages/${page.id}`, undefined, bob); assert.equal(r.status, 200);
    r = await api(first, 'PUT', `/api/pages/${page.id}`, { expected_version: 99, title: 'bad', document: {} }, alice); assert.equal(r.status, 409);
    const second = await start();
    r = await api(second, 'GET', collabRoute, undefined, alice); assert.equal(r.status, 200); assert.deepEqual(r.body.data.doc_state, workspaceDatabaseState);
    const concurrent = await Promise.all([
      api(first, 'PUT', `/api/pages/${page.id}`, { expected_version: 1, title: 'winner-a', document: { winner: 'a' } }, alice),
      api(second, 'PUT', `/api/pages/${page.id}`, { expected_version: 1, title: 'winner-b', document: { winner: 'b' } }, bob),
    ]);
    assert.deepEqual(concurrent.map((x) => x.status).sort(), [200, 409]);
    const winner = concurrent.find((x) => x.status === 200).body.page;
    assert.equal(winner.version, 2);
    r = await api(second, 'GET', `/api/pages/${page.id}`, undefined, alice); assert.equal(r.status, 200); assert.equal(r.body.page.version, 2); assert.equal(r.body.page.title, winner.title);
    const fkError = await pool.query('BEGIN').then(async () => { try { await pool.query('INSERT INTO pages(id,workspace_id,title,document,schema_version,creator_id,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())', [randomUUID(), randomUUID(), 'invalid', '{}', 'v1', randomUUID(), 1]); await pool.query('COMMIT'); return false; } catch (e) { await pool.query('ROLLBACK'); return e.code === '23503'; } });
    assert.equal(fkError, true);
    const rollbackId = randomUUID(); await pool.query('BEGIN'); try { await pool.query('INSERT INTO workspaces(id,name,created_at,owner_id) VALUES($1,$2,NOW(),$3)', [rollbackId, 'rolled back', randomUUID()]); assert.fail('foreign-key insert should fail'); } catch { await pool.query('ROLLBACK'); }
    assert.equal((await pool.query('SELECT 1 FROM workspaces WHERE id=$1', [rollbackId])).rowCount, 0);
    for (const running of apps) { await running.app.store.close(); await new Promise((resolve) => running.server.close(resolve)); } apps.length = 0;
    const restarted = await start(); r = await api(restarted, 'GET', `/api/pages/${page.id}`, undefined, alice); assert.equal(r.status, 200); assert.equal(r.body.page.version, 2); assert.equal(r.body.page.title, winner.title);
    r = await api(restarted, 'GET', collabRoute, undefined, alice); assert.equal(r.status, 200); assert.deepEqual(r.body.data.doc_state, workspaceDatabaseState);
  } finally { for (const running of apps) { await running.app.store.close(); await new Promise((resolve) => running.server.close(resolve)); } }
});
