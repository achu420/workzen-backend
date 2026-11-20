// Backup and restore: a real server's data (accounts, pages, uploaded files, AI key secret) survives being wiped and
// restored into a fresh server; corrupt or foreign archives are refused before anything changes.
import baseTest, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startServer } from '../server.js';
import { createBackup, openBackup, restoreBackup } from '../scripts/backup-lib.mjs';

const run = promisify(execFile);
const test = baseTest;
const PASSWORD = 'Correct horse 456';
let root;

before(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-backup-')); });
after(async () => { await rm(root, { recursive: true, force: true }); });

async function boot(dataFile, extra = {}) {
  const running = await startServer({ folderChangedDelayMs: 600000, host: '127.0.0.1', port: 0, file: dataFile, ...extra });
  const base = `http://127.0.0.1:${running.address.port}`;
  const call = async (method, route, payload, token, raw) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: raw ?? (payload === undefined ? undefined : JSON.stringify(payload)),
    });

    return response;
  };
  const stop = async () => { running.server.closeAllConnections?.(); await new Promise((resolve) => running.server.close(resolve)); await running.app.store.close?.(); };

  return { call, stop, running };
}

async function seed(dir) {
  const dataFile = path.join(dir, 'state.json');
  const { call, stop } = await boot(dataFile);
  const session = await (await call('POST', '/signup', { email: 'backup@example.test', password: PASSWORD })).json();
  const token = session.access_token;
  const workspaceId = (await (await call('GET', '/api/user/workspace', undefined, token)).json()).data.visiting_workspace.workspace_id;
  const spaceId = crypto.randomUUID();

  await call('POST', `/api/workspace/${workspaceId}/spaces`, { name: 'Kept', view_id: spaceId, permission: { visibility: 'public', owner_access_level: 50, member_default_access_level: 30, everyone_else_access_level: null, invite_policy: 'owners_only', sidebar_edit_policy: 'owners_only', invite_link_enabled: false, security: { disable_guests: false, disable_public_links: false, disable_export: false } } }, token);
  const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256));
  const parent = crypto.randomUUID();
  const upload = await (await call('PUT', `/api/file_storage/${workspaceId}/v1/blob/${parent}`, undefined, token, bytes)).json();

  await stop();
  await writeFile(path.join(dir, '.ai-key-secret'), 'a'.repeat(64), { mode: 0o600 });
  return { dataFile, workspaceId, spaceId, parent, fileId: upload.data.file_id, bytes, secret: 'a'.repeat(64) };
}

test('backup then restore into an empty location brings back accounts, pages, files and the AI secret', async () => {
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');

  await mkdir(source, { recursive: true });
  const seeded = await seed(source);
  const result = await createBackup({ outDir: path.join(root, 'out'), storage: 'json', dataFile: seeded.dataFile, filesDir: path.join(source, 'files'), secretFile: path.join(source, '.ai-key-secret') });

  assert.match(path.basename(result.archive), /^backup-\d{8}-\d{6}\.tar\.gz$/);
  const { manifest, stage } = await openBackup(result.archive);

  await rm(stage, { recursive: true, force: true });
  assert.deepEqual(manifest.files.map((file) => file.name).filter((name) => !name.startsWith('files/')).sort(), ['ai-key-secret', 'state.json']);
  assert.equal(manifest.files.filter((file) => file.name.startsWith('files/')).length, 2, 'the upload and its metadata');

  const refused = await restoreBackup({ archive: result.archive, dataFile: path.join(target, 'state.json'), filesDir: path.join(target, 'files'), secretFile: path.join(target, '.ai-key-secret') });

  assert.equal(refused.restored, false);
  assert.deepEqual(await readdir(root).then((names) => names.includes('target')), false, 'nothing is written without confirm');

  const done = await restoreBackup({ archive: result.archive, confirm: true, dataFile: path.join(target, 'state.json'), filesDir: path.join(target, 'files'), secretFile: path.join(target, '.ai-key-secret') });

  assert.equal(done.restored, true);
  assert.equal(await readFile(path.join(target, '.ai-key-secret'), 'utf8'), seeded.secret);
  const { call, stop } = await boot(path.join(target, 'state.json'));

  try {
    const login = await call('POST', '/api/auth/login', { email: 'backup@example.test', password: PASSWORD });

    assert.equal(login.status, 200, 'the account exists in the restored data');
    const token = (await login.json()).access_token;
    const tree = (await (await call('GET', `/api/workspace/${seeded.workspaceId}/view/${seeded.workspaceId}?depth=1`, undefined, token)).json()).data;

    assert.deepEqual(tree.children.map((child) => child.name), ['Kept']);
    const file = await call('GET', `/api/file_storage/${seeded.workspaceId}/v1/blob/${seeded.parent}/${seeded.fileId}`, undefined, token);

    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), seeded.bytes);
  } finally {
    await stop();
  }
});

test('a corrupt, tampered or foreign archive is refused before anything is restored', async () => {
  const dir = path.join(root, 'tamper');

  await mkdir(dir, { recursive: true });
  const seeded = await seed(dir);
  const { archive } = await createBackup({ outDir: path.join(root, 'tamper-out'), storage: 'json', dataFile: seeded.dataFile, filesDir: path.join(dir, 'files') });
  // Tamper: unpack, change the state, repack with the original manifest.
  const unpacked = path.join(root, 'unpacked');

  await mkdir(unpacked, { recursive: true });
  await run('tar', ['-xzf', archive, '-C', unpacked]);
  await writeFile(path.join(unpacked, 'state.json'), '{"tampered":true}');
  const tampered = path.join(root, 'tampered.tar.gz');

  await run('tar', ['-czf', tampered, '-C', unpacked, '.']);
  await assert.rejects(openBackup(tampered), /Checksum mismatch for state\.json/);
  await assert.rejects(restoreBackup({ archive: tampered, confirm: true, dataFile: path.join(root, 'never.json') }), /Checksum mismatch/);
  assert.equal((await readdir(root)).includes('never.json'), false);
  // A tarball that is not one of ours, and a missing file listed in the manifest.
  await mkdir(path.join(root, 'foreign'), { recursive: true });
  await writeFile(path.join(root, 'foreign', 'manifest.json'), JSON.stringify({ app: 'something-else', format: 1, files: [] }));
  await run('tar', ['-czf', path.join(root, 'foreign.tar.gz'), '-C', path.join(root, 'foreign'), '.']);
  await assert.rejects(openBackup(path.join(root, 'foreign.tar.gz')), /not a backup made by this tool/);
  await rm(path.join(unpacked, 'state.json'));
  await copyFile(seeded.dataFile, path.join(unpacked, 'state.json'));
  await rm(path.join(unpacked, 'files'), { recursive: true, force: true });
  const missing = path.join(root, 'missing.tar.gz');

  await run('tar', ['-czf', missing, '-C', unpacked, '.']);
  await assert.rejects(openBackup(missing), /Checksum mismatch|missing/);
});

test('retention keeps only the newest N archives and never deletes anything else', async () => {
  const dir = path.join(root, 'retention');

  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'state.json');

  await writeFile(file, '{}');
  await writeFile(path.join(root, 'retention-out-note.txt'), 'x');
  const out = path.join(root, 'retention-out');

  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'notes.txt'), 'keep me');
  const made = [];

  for (let day = 1; day <= 4; day += 1) {
    made.push((await createBackup({ outDir: out, storage: 'json', dataFile: file, keep: 2, now: new Date(Date.UTC(2026, 10, day, 12, 0, 0)) })).archive);
  }
  assert.deepEqual((await readdir(out)).sort(), [path.basename(made[2]), path.basename(made[3]), 'notes.txt'].sort());
});

test('a missing state file is an error, not an empty backup', async () => {
  await assert.rejects(createBackup({ outDir: path.join(root, 'none-out'), storage: 'json', dataFile: path.join(root, 'does-not-exist.json') }), /State file not found/);
  await assert.rejects(createBackup({ outDir: path.join(root, 'none-out'), storage: 'postgres' }), /DATABASE_URL is required/);
});

const pgConfigured = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);

baseTest('PostgreSQL: dump, restore into a second database, same data', { skip: pgConfigured ? false : 'needs RUN_POSTGRES_TESTS=1 and DATABASE_URL' }, async () => {
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const copyName = `restore_${crypto.randomUUID().replace(/-/g, '')}`;
  const copyUrl = new URL(process.env.DATABASE_URL);

  copyUrl.pathname = `/${copyName}`;
  await admin.connect();
  const dir = path.join(root, 'pg');

  await mkdir(dir, { recursive: true });
  const running = await boot(path.join(dir, 'state.json'), { storage: 'postgres', databaseUrl: process.env.DATABASE_URL });

  try {
    const email = `pg-backup-${crypto.randomUUID()}@example.test`;

    assert.equal((await running.call('POST', '/signup', { email, password: PASSWORD })).status, 200);
    const pgBin = process.env.PG_BIN || '';
    const result = await createBackup({ outDir: path.join(dir, 'out'), storage: 'postgres', databaseUrl: process.env.DATABASE_URL, pgBin });

    await admin.query(`CREATE DATABASE ${copyName}`);
    assert.equal((await restoreBackup({ archive: result.archive, confirm: true, databaseUrl: copyUrl.toString(), pgBin })).restored, true);
    const copy = new pg.Client({ connectionString: copyUrl.toString() });

    await copy.connect();
    try {
      assert.equal((await copy.query('SELECT count(*)::int AS n FROM users WHERE email=$1', [email])).rows[0].n, 1);
      const original = await admin.query('SELECT count(*)::int AS n FROM users');
      const restored = await copy.query('SELECT count(*)::int AS n FROM users');

      assert.equal(restored.rows[0].n, original.rows[0].n);
    } finally {
      await copy.end();
    }
  } finally {
    await running.stop();
    await admin.query(`DROP DATABASE IF EXISTS ${copyName} WITH (FORCE)`);
    await admin.end();
  }
});
