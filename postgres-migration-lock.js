// Task 59: PostgreSQL advisory-lock helper protecting migration DDL from
// concurrent execution by independent backend processes against the same
// database.
//
// WHY a session-level advisory lock (pg_advisory_lock/pg_advisory_unlock),
// not a transaction-level one (pg_advisory_xact_lock):
// The migration critical section in postgres-storage.js needs to run
// several independently committed transactions (one per still-pending
// migration file, so a failure in file N does not roll back files that
// already committed and were recorded as applied -- see runMigrations()).
// A transaction-level advisory lock is released automatically at the next
// COMMIT/ROLLBACK, so it cannot span multiple commits; it would release
// after the first migration file's transaction and let a second process
// in mid-critical-section. A session-level lock, explicitly acquired and
// released on one dedicated client held for the whole critical section,
// is the only option that actually covers "acquire lock -> recheck state
// -> run pending migrations -> release lock" as one atomic-with-respect-
// to-other-processes unit. All migration DDL in migrations/*.sql is plain
// CREATE TABLE/ALTER TABLE/CREATE [UNIQUE] INDEX/DO-block statements -- no
// CREATE INDEX CONCURRENTLY, VACUUM, or other statement that cannot run
// inside a transaction -- so there is no technical blocker to this choice
// either way; session-level is chosen purely because of the multi-commit
// shape of the critical section.
//
// WHY a deterministic hash of the database name, not a random/PID-based
// key: the same logical database must always map to the same lock key
// across process restarts (otherwise two processes could use different
// keys and never actually contend). We ask Postgres for current_database()
// on the connection actually being initialized (not by parsing the
// connection string) so the key always reflects the database Postgres
// itself thinks we're in. Postgres advisory locks are already scoped to
// the connected database internally (a lock number taken by a session
// connected to database A can never conflict with the same number taken
// by a session connected to database B, and a session can only reach
// locks within the Postgres cluster it is connected to), so folding the
// database name into the key is an extra safety/debuggability measure, not
// strictly required for correctness -- but it does mean two different
// logical databases never share a key even if that scoping assumption
// ever changed, and it makes the key legible in logs/pg_locks for
// diagnosis. We hash with SHA-256 (a real deterministic hash, not V8's
// object/string hashing, which is not guaranteed stable across process
// restarts or Node versions) and fold the first 8 bytes into a signed
// 64-bit BigInt, which is exactly the range pg_advisory_lock(bigint)
// accepts.
import { createHash } from 'node:crypto';

const SIGNED_64_BIT_MODULUS = 1n << 64n;
const SIGNED_64_BIT_MAX = (1n << 63n) - 1n;

/** Deterministically derive a Postgres bigint advisory-lock key from a
 * logical database name. Same name -> same key, always; different names
 * -> different keys (SHA-256 collision probability is negligible). Never
 * include credentials or full connection strings in the hashed input. */
export function deriveMigrationLockKey(databaseName, { namespace = 'appflowy-backend-migration' } = {}) {
  if (!databaseName) throw new Error('deriveMigrationLockKey requires a non-empty database name');
  const digest = createHash('sha256').update(`${namespace}:${databaseName}`).digest();
  let value = digest.readBigUInt64BE(0);
  if (value > SIGNED_64_BIT_MAX) value -= SIGNED_64_BIT_MODULUS; // reinterpret top bit as sign, matching Postgres's signed int8
  return value;
}

/** Acquire the session-level advisory lock on `client`, which MUST be a
 * single dedicated client (not a pool) held for the entire critical
 * section -- session-level advisory locks live on the connection/session,
 * not on any particular transaction. Uses a bounded pg_try_advisory_lock
 * retry loop rather than the blocking pg_advisory_lock: a blocking wait
 * has no way to report progress or give up, so a wedged or abnormally
 * slow peer (e.g. a process that is itself stuck, not just slow) would
 * hang every other process's startup silently and indefinitely. The
 * try-lock loop gives a documented, configurable ceiling and a clear,
 * actionable error instead. */
export async function acquireAdvisoryLock(client, lockKey, { timeoutMs = 30000, pollIntervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const keyText = lockKey.toString();
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [keyText]);
    if (rows[0].locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the PostgreSQL migration advisory lock (key=${keyText}). ` +
        'Another process is likely still applying migrations, or a prior process left the lock held unexpectedly long. ' +
        'This is a startup-time failure only: no migration DDL has been executed by this process.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** Release the session-level advisory lock explicitly. Session-level
 * advisory locks are also released automatically by Postgres when the
 * owning session/connection terminates (crash, kill -9, network loss), so
 * a lock can never be held forever by a dead process -- but normal
 * operation must still release explicitly and promptly so a live,
 * well-behaved process doesn't make its peers wait out a full session
 * lifetime. */
export async function releaseAdvisoryLock(client, lockKey) {
  const keyText = lockKey.toString();
  const { rows } = await client.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [keyText]);
  if (!rows[0].unlocked) {
    throw new Error(`pg_advisory_unlock reported the migration lock (key=${keyText}) was not held by this session`);
  }
}
