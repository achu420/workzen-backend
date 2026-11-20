// Task 59: regression coverage for the PostgreSQL migration advisory lock
// that replaces the unprotected, reapply-on-every-call migration DDL
// Task 56/58 identified as a concurrency defect (two independent backend
// processes initializing against the same database could hang/deadlock;
// reproduced for Task 59 with two real OS processes -- see
// docs/APPFLOWY_TASK59_REPORT.md for the full reproduction transcript).
//
// These tests use the real `pg` driver and a real, disposable PostgreSQL
// database (RUN_POSTGRES_TESTS=1 + DATABASE_URL, same gate as the other
// postgres test files). Nothing about Postgres or the `pg` driver is
// mocked anywhere in this file, including the failure-path tests: every
// failure is a genuine error raised by a real Postgres server (a real
// unique-constraint violation, a real lock-acquisition timeout against a
// real held lock, a real session termination), not a simulated one.
//
// Fresh, disposable sibling databases are created and dropped per test
// (via CREATE DATABASE/DROP DATABASE on the same disposable Postgres
// instance DATABASE_URL points at) so each test can exercise genuinely
// fresh-database migration behavior without interfering with the other
// postgres test files' shared DATABASE_URL database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import pg from 'pg';
import { openPostgresStore } from '../postgres-storage.js';
// Every migration file shipped in migrations/ must be applied and tracked exactly once. Derived from the
// directory (not hard-coded) so adding a migration does not break these tests; a file missing from
// MIGRATION_FILES would show up as a count mismatch.
const ALL_MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();

import { deriveMigrationLockKey, acquireAdvisoryLock, releaseAdvisoryLock } from '../postgres-migration-lock.js';

const { Client } = pg;
const configured = process.env.RUN_POSTGRES_TESTS === '1' && process.env.DATABASE_URL;

function urlForDatabase(databaseName) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withAdminClient(fn, connectionString = process.env.DATABASE_URL) {
  const client = new Client({ connectionString });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function createDisposableDatabase(prefix) {
  const name = `${prefix}_${randomUUID().replace(/-/g, '')}`;
  await withAdminClient((client) => client.query(`CREATE DATABASE ${name}`));
  return name;
}

async function dropDisposableDatabase(name) {
  await withAdminClient((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

// --- Lock identity: pure function, no Postgres connection needed, but
// gated the same as the rest of this file for consistency with the other
// postgres suites and because later assertions in this block do use a
// real connection to confirm the derived key is actually usable. ---
test('migration lock key derivation is deterministic, distinct per database, and within Postgres bigint range', { skip: !configured }, async () => {
  const keyA1 = deriveMigrationLockKey('appflowy_task59_dbname_a');
  const keyA2 = deriveMigrationLockKey('appflowy_task59_dbname_a');
  const keyB = deriveMigrationLockKey('appflowy_task59_dbname_b');
  assert.equal(keyA1, keyA2, 'same database name must always produce the same key');
  assert.notEqual(keyA1, keyB, 'different database names must produce different keys');
  const INT8_MIN = -(2n ** 63n), INT8_MAX = 2n ** 63n - 1n;
  for (const key of [keyA1, keyB]) assert.ok(key >= INT8_MIN && key <= INT8_MAX, `key ${key} must fit in a signed bigint`);
  assert.throws(() => deriveMigrationLockKey(''), /non-empty/);
  // Confirm Postgres itself accepts the derived key for both lock functions.
  await withAdminClient(async (client) => {
    await acquireAdvisoryLock(client, keyA1, { timeoutMs: 2000 });
    await releaseAdvisoryLock(client, keyA1);
  });
});

// --- Concurrent initialization: two and three independent sessions ---
test('two concurrent real connections contend for the same migration lock; only one holds it at a time', { skip: !configured }, async () => {
  const key = deriveMigrationLockKey(`appflowy_task59_contend_${randomUUID()}`);
  const clientA = new Client({ connectionString: process.env.DATABASE_URL });
  const clientB = new Client({ connectionString: process.env.DATABASE_URL });
  await clientA.connect();
  await clientB.connect();
  try {
    const pidA = (await clientA.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const pidB = (await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.notEqual(pidA, pidB, 'the two clients must be genuinely distinct Postgres backend sessions');

    await acquireAdvisoryLock(clientA, key, { timeoutMs: 2000 });
    // B must NOT be able to acquire immediately -- try-lock should report false.
    const immediateAttempt = await clientB.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key.toString()]);
    assert.equal(immediateAttempt.rows[0].locked, false, 'second session must not acquire the lock while the first holds it');

    const bWaitStart = Date.now();
    const bAcquire = acquireAdvisoryLock(clientB, key, { timeoutMs: 5000, pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const releasedAt = Date.now();
    await releaseAdvisoryLock(clientA, key);
    await bAcquire;
    const bAcquiredAt = Date.now();
    assert.ok(bAcquiredAt >= releasedAt, 'B must only acquire the lock after A released it');
    assert.ok(bAcquiredAt - bWaitStart >= 250, 'B must have genuinely waited, not raced past A');
    await releaseAdvisoryLock(clientB, key);
  } finally { await clientA.end(); await clientB.end(); }
});

test('two independent openPostgresStore() calls against the same fresh database serialize migration and both succeed without duplicate application', { skip: !configured }, async () => {
  const dbName = await createDisposableDatabase('appflowy_task59_concurrent2');
  try {
    const url = urlForDatabase(dbName);
    const [storeA, storeB] = await Promise.all([openPostgresStore(url), openPostgresStore(url)]);
    try {
      const migrations = await storeA.pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
      assert.deepEqual(migrations.rows.map((r) => r.filename), ALL_MIGRATIONS);
      const tables = await storeA.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
      assert.ok(tables.rows.some((r) => r.table_name === 'users'));
      assert.ok(tables.rows.some((r) => r.table_name === 'schema_migrations'));
    } finally { await storeA.close(); await storeB.close(); }
  } finally { await dropDisposableDatabase(dbName); }
});

test('three concurrent openPostgresStore() initializers against a fresh database all succeed with migrations applied exactly once', { skip: !configured }, async () => {
  const dbName = await createDisposableDatabase('appflowy_task59_concurrent3');
  try {
    const url = urlForDatabase(dbName);
    const stores = await Promise.all([openPostgresStore(url), openPostgresStore(url), openPostgresStore(url)]);
    try {
      const migrations = await stores[0].pool.query('SELECT filename, count(*) AS n FROM schema_migrations GROUP BY filename');
      assert.equal(migrations.rows.length, ALL_MIGRATIONS.length, `exactly ${ALL_MIGRATIONS.length} distinct migration files tracked`);
      for (const row of migrations.rows) assert.equal(Number(row.n), 1, `migration ${row.filename} must be recorded exactly once`);
    } finally { await Promise.all(stores.map((s) => s.close())); }
  } finally { await dropDisposableDatabase(dbName); }
});

test('a slow first initializer forces a genuinely concurrent second initializer to wait, then recheck, before completing', { skip: !configured }, async () => {
  const dbName = await createDisposableDatabase('appflowy_task59_overlap');
  const previousDelay = process.env.POSTGRES_MIGRATION_TEST_DELAY_MS;
  process.env.POSTGRES_MIGRATION_TEST_DELAY_MS = '400'; // see runMigrations() test-only hook in postgres-storage.js
  try {
    const url = urlForDatabase(dbName);
    const startA = Date.now();
    const firstPromise = openPostgresStore(url);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let A win the race to acquire the lock
    const startB = Date.now();
    const [storeA, storeB] = await Promise.all([firstPromise, openPostgresStore(url)]);
    const finishB = Date.now();
    try {
      assert.ok(finishB - startB >= 300, `second initializer should have waited for the first's held lock (waited ${finishB - startB}ms)`);
      const migrations = await storeA.pool.query('SELECT filename FROM schema_migrations');
      assert.equal(migrations.rows.length, ALL_MIGRATIONS.length, 'migrations applied exactly once despite the overlap');
    } finally { await storeA.close(); await storeB.close(); }
    void startA;
  } finally {
    if (previousDelay === undefined) delete process.env.POSTGRES_MIGRATION_TEST_DELAY_MS; else process.env.POSTGRES_MIGRATION_TEST_DELAY_MS = previousDelay;
    await dropDisposableDatabase(dbName);
  }
});

// --- Failure / recovery ---
test('lock acquisition timeout produces a clear, bounded error, and does not block the holder', { skip: !configured }, async () => {
  const key = deriveMigrationLockKey(`appflowy_task59_timeout_${randomUUID()}`);
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  const waiter = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect(); await waiter.connect();
  try {
    await acquireAdvisoryLock(holder, key, { timeoutMs: 2000 });
    const start = Date.now();
    await assert.rejects(
      acquireAdvisoryLock(waiter, key, { timeoutMs: 300, pollIntervalMs: 50 }),
      /Timed out after 300ms waiting for the PostgreSQL migration advisory lock/
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 280 && elapsed < 2000, `timeout must be bounded by the configured value (took ${elapsed}ms)`);
  } finally { await releaseAdvisoryLock(holder, key).catch(() => {}); await holder.end(); await waiter.end(); }
});

test('releasing a lock not held by the session reports an error instead of silently succeeding', { skip: !configured }, async () => {
  const key = deriveMigrationLockKey(`appflowy_task59_release_unheld_${randomUUID()}`);
  await withAdminClient(async (client) => {
    await assert.rejects(releaseAdvisoryLock(client, key), /was not held by this session/);
  });
});

test('terminating a session that holds the lock (connection loss) releases it; no permanent lock remains', { skip: !configured }, async () => {
  const key = deriveMigrationLockKey(`appflowy_task59_connloss_${randomUUID()}`);
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  // Destroying the socket below makes pg emit a real 'error' event on
  // the client for the now-dead connection; swallow it deliberately --
  // we are intentionally simulating a crashed process, so there is no
  // one left to handle that error, and that is exactly what we are
  // testing recovers safely.
  holder.on('error', () => {});
  await holder.connect();
  await acquireAdvisoryLock(holder, key, { timeoutMs: 2000 });
  // Simulate connection loss: destroy the underlying socket directly
  // (not a graceful client.end()) so Postgres observes an abrupt
  // disconnect, exactly like a crashed/killed process -- the scenario
  // session-level advisory locks are specifically designed to survive
  // without leaking the lock forever.
  holder.connection.stream.destroy();
  await new Promise((resolve) => setTimeout(resolve, 300)); // let Postgres notice the dead socket

  const second = new Client({ connectionString: process.env.DATABASE_URL });
  await second.connect();
  try {
    await acquireAdvisoryLock(second, key, { timeoutMs: 5000, pollIntervalMs: 100 });
    await releaseAdvisoryLock(second, key);
  } finally { await second.end(); }
});

test('a genuine migration SQL failure (real Postgres unique-violation) rolls back, releases the lock, leaves no misleading success record, and a corrected retry succeeds', { skip: !configured }, async () => {
  const dbName = await createDisposableDatabase('appflowy_task59_failure');
  try {
    const url = urlForDatabase(dbName);
    const store = await openPostgresStore(url);
    const userId = randomUUID();
    await store.saveUser({ id: userId, uid: 1, email: `task59-${randomUUID()}@example.test`, password_hash: 'x', created_at: new Date() });

    // Drop the unique partial index that migration 001_initial.sql
    // creates, so inserting colliding data below is possible, and then
    // seed two sessions with the SAME non-null refresh_token_hash. When
    // migration 001 is forced to be reconsidered "pending" further down
    // and reapplied, its real `CREATE UNIQUE INDEX IF NOT EXISTS
    // sessions_refresh_token_hash_idx ...` statement will try to rebuild
    // exactly this index over genuinely duplicate data and Postgres will
    // raise a real 23505 unique_violation -- nothing here is mocked or
    // simulated.
    await store.pool.query('DROP INDEX sessions_refresh_token_hash_idx');
    const now = new Date();
    await store.pool.query(
      'INSERT INTO sessions(token_hash,user_id,created_at,expires_at,refresh_token_hash) VALUES ($1,$2,$3,$4,$5),($6,$2,$3,$4,$5)',
      [randomUUID(), userId, now, now, 'duplicate-refresh-hash', randomUUID()]
    );
    // Force migration 001 to be reconsidered "pending" -- models a
    // genuine partial-migration-tracking state (e.g. an upgrade from a
    // pre-Task-59 database, or a tracking row that never got written).
    await store.pool.query("DELETE FROM schema_migrations WHERE filename='001_initial.sql'");
    await store.close();

    const lockKey = deriveMigrationLockKey(dbName);
    await assert.rejects(openPostgresStore(url), (error) => {
      assert.match(error.message, /001_initial\.sql/);
      assert.match(error.message, /PostgreSQL initialization failed/);
      return true;
    });

    // The lock must be released despite the failure: a fresh connection
    // TO THE SAME DISPOSABLE DATABASE (advisory locks are scoped per
    // connected database, so this must check the database the failure
    // actually happened in, not the shared base DATABASE_URL database)
    // can acquire it immediately.
    await withAdminClient(async (client) => {
      await acquireAdvisoryLock(client, lockKey, { timeoutMs: 1000 });
      await releaseAdvisoryLock(client, lockKey);
    }, url);

    // No misleading success record for the failed migration; the others
    // that were already applied remain recorded. Pool checked out for
    // the failed attempt is not left leaked: a fresh connection to the
    // same disposable database is immediately obtainable here.
    await withAdminClient(async (client) => {
      const rows = (await client.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map((r) => r.filename);
      assert.ok(!rows.includes('001_initial.sql'), '001_initial.sql must NOT be recorded as applied after failing');
      assert.deepEqual(rows, ALL_MIGRATIONS.filter((name) => name !== '001_initial.sql'));
    }, url);

    // Retry after fixing the real underlying problem must succeed.
    await withAdminClient((client) => client.query("DELETE FROM sessions WHERE refresh_token_hash='duplicate-refresh-hash'"), url);
    const recovered = await openPostgresStore(url);
    try {
      const rows = (await recovered.pool.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map((r) => r.filename);
      assert.deepEqual(rows, ALL_MIGRATIONS);
    } finally { await recovered.close(); }
  } finally { await dropDisposableDatabase(dbName); }
});

test('reopening an already-fully-migrated database is a fast no-op recheck and leaves no advisory lock behind', { skip: !configured }, async () => {
  const dbName = await createDisposableDatabase('appflowy_task59_reopen');
  try {
    const url = urlForDatabase(dbName);
    const first = await openPostgresStore(url);
    await first.close();
    const second = await openPostgresStore(url);
    try {
      const locks = await second.pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'");
      assert.equal(locks.rows[0].n, 0, 'no advisory lock should remain held after a successful init');
      const rows = (await second.pool.query('SELECT filename FROM schema_migrations')).rows;
      assert.equal(rows.length, ALL_MIGRATIONS.length);
    } finally { await second.close(); }
  } finally { await dropDisposableDatabase(dbName); }
});
