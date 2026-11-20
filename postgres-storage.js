import { createAiPostgresStorage } from './ai-storage.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { createPostgresPageCollabRepository, createPostgresDatabaseCollabRepository, createPostgresDatabaseRowCollabRepository } from './postgres-collab-repository.js';
import { deriveMigrationLockKey, acquireAdvisoryLock, releaseAdvisoryLock } from './postgres-migration-lock.js';
import { buildDatabaseCatalogFromPages } from './database-catalog.js';
import { addDatabaseView } from './database-document.js';

const migrationDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// Task 59: migration files are kept as an ORDERED list of (name, sql) pairs
// instead of being concatenated into one string. This lets runMigrations()
// below record and recheck, per file, which migrations have actually been
// applied (see schema_migrations) instead of blindly re-sending the full
// DDL text on every openPostgresStore() call.
const MIGRATION_FILES = ['001_initial.sql', '002_spaces.sql', '003_atomic_document_creation.sql', '004_document_sync_admission.sql', '005_document_version_history.sql', '006_favorites_trash.sql', '007_database_and_database_row_collab.sql', '008_database_view_creation.sql', '009_database_view_receipt_fields.sql', '010_visiting_workspace.sql', '011_seeded_row_creation.sql', '012_user_profile.sql', '013_recent_pages.sql', '014_notifications_comments.sql', '015_invite_codes_member_profile.sql', '016_search.sql', '017_ai_settings_chat.sql', '018_ai_card_chats.sql', '019_agent_tokens.sql', '020_workspace_invitations.sql', '021_agent_activity.sql', '022_auto_versions.sql', '023_card_history.sql'];

// Task 63 test-only instrumentation (same convention as Task 59's
// POSTGRES_MIGRATION_TEST_DELAY_MS env-var hook above): lets regression
// tests deterministically prove that createAtomicDatabaseRow's multi-step
// Postgres transaction rolls back completely -- no partial row, no partial
// row_orders mutation, no success-indicating idempotency receipt -- no
// matter which step fails. A no-op unless a test sets `.throwAt` to one of
// the checkpoint names used below. NEVER set in production.
export const postgresAtomicRowCreationTestHooks = { throwAt: null };
function maybeThrowTestFault(checkpoint) {
  if (postgresAtomicRowCreationTestHooks.throwAt === checkpoint) {
    const injected = new Error(`Task 63 injected test fault at checkpoint: ${checkpoint}`);
    injected.code = 'TEST_INJECTED_FAULT';
    throw injected;
  }
}
const migrationSqlByFile = new Map(await Promise.all(MIGRATION_FILES.map(async (file) => [file, await readFile(path.join(migrationDirectory, file), 'utf8')])));

// Minimal, evidence-justified tracking table: before Task 59, there was no
// record of which migrations had run, so every openPostgresStore() call
// blindly resent the entire migration DDL text on the same connection that
// a concurrent process could also be using, with no coordination at all
// (Task 56/58's confirmed defect; reproduced for Task 59 by two real OS
// processes racing against a fresh database -- see
// docs/APPFLOWY_TASK59_REPORT.md). All existing migration statements are
// already idempotent (CREATE ... IF NOT EXISTS / DO-blocks with exception
// handlers), so this table is not required for correctness of the DDL
// itself -- it exists so the post-lock-acquisition "recheck" step has a
// real state to inspect instead of re-running (and re-sending over the
// wire) every statement from every migration file on every process start.
const SCHEMA_MIGRATIONS_BOOTSTRAP_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

/** Run any migration files not yet recorded in schema_migrations, in
 * order, each in its own transaction. Must be called only while the
 * caller holds the migration advisory lock on `client`.
 *
 * Per-file transactions (rather than one big transaction, which is what
 * the pre-Task-59 code effectively got from Postgres's simple-query
 * protocol implicitly wrapping an un-BEGIN'd multi-statement string) mean
 * that if file N fails, files before it stay committed and correctly
 * recorded as applied, and file N's own partial DDL is rolled back and
 * is NOT recorded -- so a failed migration can never leave a misleading
 * "success" row behind. */
async function runMigrations(client) {
  await client.query(SCHEMA_MIGRATIONS_BOOTSTRAP_SQL);
  // Recheck actual state under the lock -- do not trust any state read
  // before the lock was acquired, since another process could have
  // changed it while we were waiting.
  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.filename));
  // Task 59 test-only instrumentation: when set, holds the migration
  // advisory lock open for this many extra milliseconds after the state
  // recheck but before executing any pending migration file, purely so
  // regression tests (and the Part G multi-process verification
  // harness) can deterministically observe one process holding the
  // lock while a second, concurrently-started process is forced to
  // wait for it. Natural timing (migrations normally take well under
  // 100ms) is too fast to reliably observe the overlap otherwise.
  // Read fresh on every call (not hoisted to a module-level constant)
  // so tests can toggle it per-process environment at runtime. NEVER
  // set in production -- absent the env var this is a no-op (0ms).
  const testDelayMs = Number(process.env.POSTGRES_MIGRATION_TEST_DELAY_MS) || 0;
  if (testDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testDelayMs));
  for (const file of MIGRATION_FILES) {
    if (applied.has(file)) continue;
    await client.query('BEGIN');
    try {
      await client.query(migrationSqlByFile.get(file));
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`PostgreSQL migration ${file} failed: ${error.message}`);
    }
  }
}

function rowInlineComment(row) {
  return {
    comment_id: row.comment_id, workspace_id: row.workspace_id, view_id: row.view_id, block_id: row.block_id ?? null,
    user_id: row.user_id, content: row.content, reply_comment_id: row.reply_comment_id ?? null,
    is_resolved: row.is_resolved, is_deleted: row.is_deleted,
    created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
  };
}
function rowNotification(row) {
  return {
    id: row.id, workspace_id: row.workspace_id, recipient_user_id: row.recipient_user_id, type: row.type, view_id: row.view_id ?? null,
    actor_uid: row.actor_uid === null || row.actor_uid === undefined ? null : Number(row.actor_uid),
    metadata: row.metadata ?? {}, is_read: row.is_read, is_archived: row.is_archived,
    created_at: new Date(row.created_at).toISOString(), read_at: row.read_at ? new Date(row.read_at).toISOString() : null,
  };
}
function rowUser(row) { return { id: row.id, uid: Number(row.uid), email: row.email, password_hash: row.password_hash, created_at: new Date(row.created_at).toISOString(), name: row.name ?? null, metadata: row.metadata ?? {} }; }
function rowWorkspace(row) { return { id: row.id, name: row.name, icon: row.icon, database_storage_id: row.database_storage_id, created_at: new Date(row.created_at).toISOString(), owner_id: row.owner_id }; }
function rowMembership(row) { return { workspace_id: row.workspace_id, user_id: row.user_id, role: row.role, created_at: new Date(row.created_at).toISOString(), profile: row.profile ?? null }; }
function rowAgentToken(row) {
  const iso = (value) => (value ? new Date(value).toISOString() : null);

  return { id: row.id, workspace_id: row.workspace_id, user_id: row.user_id, name: row.name, token_hash: row.token_hash, scope: row.scope, created_at: new Date(row.created_at).toISOString(), last_used_at: iso(row.last_used_at), expires_at: iso(row.expires_at), revoked: !!row.revoked, revoked_at: iso(row.revoked_at) };
}
function rowInviteCode(row) { return { workspace_id: row.workspace_id, code: row.code, created_by: row.created_by ?? null, created_at: new Date(row.created_at).toISOString(), expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null }; }
function rowPage(row) { return { id: row.id, workspace_id: row.workspace_id, parent_view_id: row.parent_view_id ?? undefined, title: row.title, icon: row.icon ?? null, extra: row.extra ?? null, is_favorite: row.is_favorite ?? false, is_pinned: row.is_pinned ?? true, favorited_at: row.favorited_at ? new Date(row.favorited_at).toISOString() : null, is_trashed: row.is_trashed ?? false, trashed_at: row.trashed_at ? new Date(row.trashed_at).toISOString() : null, position: row.position ?? undefined, document: row.document, schema_version: row.schema_version, creator_id: row.creator_id, version: row.version, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(), ...(row.layout == null ? {} : { layout: row.layout }) }; }
// Task 63: `layout` added so a Postgres-created Database's Folder-tree
// container/primary-view page entries (server.js createAtomicDatabasePage
// caller) round-trip their Folder ViewLayout.Grid=1 value exactly like JSON
// mode's plain JS field does -- see server.js's `page.layout ?? 0` reads.
// Omitted from the returned object (via the spread above) when NULL/absent,
// matching JSON mode's pages, which simply never have the key at all for
// ordinary Document pages, so `page.layout ?? 0` behaves identically either
// way and no existing Document test asserting on page shape is affected.
const PAGE_COLUMNS = 'id,workspace_id,parent_view_id,title,icon,extra,is_favorite,is_pinned,favorited_at,is_trashed,trashed_at,position,document,schema_version,creator_id,version,created_at,updated_at,layout';
function rowAgentActivity(row) {
  return {
    id: row.id, workspace_id: row.workspace_id, token_id: row.token_id, token_name: row.token_name, user_id: row.user_id, scope: row.scope, tool: row.tool, kind: row.kind,
    target_type: row.target_type, target_id: row.target_id, target_title: row.target_title, summary: row.summary, ok: row.ok, error_code: row.error_code, duration_ms: row.duration_ms,
    undo: row.undo ?? null, undone_at: row.undone_at ? new Date(row.undone_at).toISOString() : null, undone_by: row.undone_by, created_at: new Date(row.created_at).toISOString(),
  };
}
function rowCardHistory(row) {
  return {
    id: row.id, workspace_id: row.workspace_id, database_id: row.database_id, row_id: row.row_id, title: row.title, actor_user_id: row.actor_user_id,
    actor_user_ids: row.actor_user_ids ?? [], via: row.via, changes: row.changes, created_at: new Date(row.created_at).toISOString(),
    restored_at: row.restored_at ? new Date(row.restored_at).toISOString() : null, restored_by: row.restored_by,
  };
}
function rowInvitation(row) {
  return { id: row.id, workspace_id: row.workspace_id, email: row.email, role: row.role, invited_by: row.invited_by, created_at: new Date(row.created_at).toISOString(), expires_at: new Date(row.expires_at).toISOString(), accepted_at: row.accepted_at ? new Date(row.accepted_at).toISOString() : null };
}
function rowSpace(row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    space_icon: row.space_icon,
    space_icon_color: row.space_icon_color,
    permission: row.permission,
    creator_id: row.creator_id,
    created_at: new Date(row.created_at).toISOString(),
  };
}
function rowSession(row) {
  return {
    user_id: row.user_id,
    created_at: new Date(row.created_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    refresh_token_hash: row.refresh_token_hash ?? undefined,
    refresh_expires_at: row.refresh_expires_at ? new Date(row.refresh_expires_at).toISOString() : undefined,
  };
}

function repository(pool) {
  const withClient = async (fn) => { const client = await pool.connect(); try { return await fn(client); } finally { client.release(); } };
  return {
    kind: 'postgres', state: { schema_version: 1 }, pool,
    updateUserPassword: (userId, passwordHash, keepSessionHash = null) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const r = await c.query('UPDATE users SET password_hash=$2 WHERE id=$1 RETURNING id', [userId, passwordHash]);

        if (r.rowCount) await c.query('DELETE FROM sessions WHERE user_id=$1 AND ($2::text IS NULL OR token_hash<>$2)', [userId, keepSessionHash]);
        await c.query('COMMIT');
        return r.rowCount > 0;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    }),
    getUserByEmail: (email) => withClient(async (c) => { const r = await c.query('SELECT id,uid,email,password_hash,created_at,name,metadata FROM users WHERE email=$1', [email]); return r.rows[0] ? rowUser(r.rows[0]) : null; }),
    getUserById: (id) => withClient(async (c) => { const r = await c.query('SELECT id,uid,email,password_hash,created_at,name,metadata FROM users WHERE id=$1', [id]); return r.rows[0] ? rowUser(r.rows[0]) : null; }),
    // Postgres counterpart of storage.js's updateUserProfile.
    updateUserProfile: (id, { name, metadata }) => withClient(async (c) => {
      const assignments = [];
      const values = [id];

      if (name !== undefined) { values.push(name); assignments.push(`name=$${values.length}`); }
      if (metadata !== undefined) { values.push(JSON.stringify(metadata)); assignments.push(`metadata=$${values.length}::jsonb`); }
      if (!assignments.length) {
        const existing = await c.query('SELECT id,uid,email,password_hash,created_at,name,metadata FROM users WHERE id=$1', [id]);

        return existing.rows[0] ? rowUser(existing.rows[0]) : null;
      }

      const r = await c.query(`UPDATE users SET ${assignments.join(',')} WHERE id=$1 RETURNING id,uid,email,password_hash,created_at,name,metadata`, values);

      return r.rows[0] ? rowUser(r.rows[0]) : null;
    }),
    getSession: (hash) => withClient(async (c) => { const r = await c.query('SELECT user_id,created_at,expires_at,refresh_token_hash,refresh_expires_at FROM sessions WHERE token_hash=$1', [hash]); return r.rows[0] ? rowSession(r.rows[0]) : null; }),
    getSessionByRefreshHash: (hash) => withClient(async (c) => {
      const r = await c.query('SELECT token_hash,user_id,created_at,expires_at,refresh_token_hash,refresh_expires_at FROM sessions WHERE refresh_token_hash=$1', [hash]);
      return r.rows[0] ? { access_token_hash: r.rows[0].token_hash, ...rowSession(r.rows[0]) } : null;
    }),
    saveUser: (u) => withClient((c) => c.query('INSERT INTO users(id,uid,email,password_hash,created_at) VALUES($1,$2,$3,$4,$5)', [u.id, u.uid, u.email, u.password_hash, u.created_at])),
    createUserWithWorkspace: (u, w, m) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('INSERT INTO users(id,uid,email,password_hash,created_at) VALUES($1,$2,$3,$4,$5)', [u.id, u.uid, u.email, u.password_hash, u.created_at]);
        await c.query('INSERT INTO workspaces(id,name,icon,database_storage_id,created_at,owner_id) VALUES($1,$2,$3,$4,$5,$6)', [w.id, w.name, w.icon, w.database_storage_id, w.created_at, w.owner_id]);
        await c.query('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,$4)', [m.workspace_id, m.user_id, m.role, m.created_at]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }),
    saveSession: (hash, s) => withClient((c) => c.query('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,refresh_token_hash,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6)', [hash, s.user_id, s.created_at, s.expires_at, s.refresh_token_hash ?? null, s.refresh_expires_at ?? null])),
    revokeSession: (hash) => withClient((c) => c.query('DELETE FROM sessions WHERE token_hash=$1', [hash])),
    rotateSession: (oldAccessHash, newAccessHash, expectedRefreshHash, s) => withClient(async (c) => {
      const r = await c.query(
        'UPDATE sessions SET token_hash=$1,created_at=$2,expires_at=$3,refresh_token_hash=$4,refresh_expires_at=$5 WHERE token_hash=$6 AND refresh_token_hash=$7 AND refresh_expires_at > $2',
        [newAccessHash, s.created_at, s.expires_at, s.refresh_token_hash, s.refresh_expires_at, oldAccessHash, expectedRefreshHash]
      );
      return r.rowCount === 1;
    }),
    createWorkspace: (w, m) => withClient(async (c) => { await c.query('BEGIN'); try { await c.query('INSERT INTO workspaces(id,name,icon,database_storage_id,created_at,owner_id) VALUES($1,$2,$3,$4,$5,$6)', [w.id, w.name, w.icon, w.database_storage_id, w.created_at, w.owner_id]); await c.query('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,$4)', [m.workspace_id, m.user_id, m.role, m.created_at]); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } }),
    listWorkspaces: (uid) => withClient(async (c) => (await c.query('SELECT w.id,w.name,w.icon,w.database_storage_id,w.created_at,w.owner_id FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at', [uid])).rows.map(rowWorkspace)),
    listWorkspaceBootstrapRows: (uid) => withClient(async (c) => (await c.query(
      'SELECT w.id,w.name,w.icon,w.database_storage_id,w.created_at,w.owner_id,m.role,(SELECT count(*)::integer FROM memberships all_members WHERE all_members.workspace_id=w.id) AS member_count FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY m.last_visited_at DESC NULLS LAST, w.created_at, w.id',
      [uid]
    )).rows.map((row) => ({
      workspace: rowWorkspace(row),
      membership: rowMembership({ workspace_id: row.id, user_id: uid, role: row.role, created_at: row.created_at }),
      member_count: row.member_count,
    }))),
    markWorkspaceVisited: (uid, workspaceId) => withClient((c) => c.query(
      'UPDATE memberships SET last_visited_at=now() WHERE user_id=$1 AND workspace_id=$2',
      [uid, workspaceId]
    )),
    getWorkspace: (id) => withClient(async (c) => { const r = await c.query('SELECT id,name,icon,database_storage_id,created_at,owner_id FROM workspaces WHERE id=$1', [id]); return r.rows[0] ? rowWorkspace(r.rows[0]) : null; }),
    createSpace: (s) => withClient((c) => c.query(
      'INSERT INTO spaces(id,workspace_id,name,space_icon,space_icon_color,permission,creator_id,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
      [s.id, s.workspace_id, s.name, s.space_icon, s.space_icon_color, JSON.stringify(s.permission), s.creator_id, s.created_at]
    )),
    listSpaces: (wid) => withClient(async (c) => (await c.query(
      'SELECT id,workspace_id,name,space_icon,space_icon_color,permission,creator_id,created_at FROM spaces WHERE workspace_id=$1 ORDER BY created_at,id',
      [wid]
    )).rows.map(rowSpace)),
    getSpace: (id) => withClient(async (c) => {
      const r = await c.query(
        'SELECT id,workspace_id,name,space_icon,space_icon_color,permission,creator_id,created_at FROM spaces WHERE id=$1',
        [id]
      );
      return r.rows[0] ? rowSpace(r.rows[0]) : null;
    }),
    getOrCreateWorkspaceDatabaseCollab: (workspaceId, objectId, initialDocState) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const workspace = await c.query('SELECT database_storage_id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
        if (!workspace.rowCount || workspace.rows[0].database_storage_id !== objectId) {
          await c.query('COMMIT');
          return null;
        }
        await c.query(
          'INSERT INTO workspace_database_collabs(workspace_id,object_id,doc_state) VALUES($1,$2,$3) ON CONFLICT (workspace_id) DO NOTHING',
          [workspaceId, objectId, Buffer.from(initialDocState)]
        );
        const result = await c.query(
          'SELECT object_id,doc_state FROM workspace_database_collabs WHERE workspace_id=$1 AND object_id=$2',
          [workspaceId, objectId]
        );
        if (!result.rowCount) throw new Error('Stored workspace database collaboration object does not match workspace');
        await c.query('COMMIT');
        return { object_id: result.rows[0].object_id, doc_state: new Uint8Array(result.rows[0].doc_state) };
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    }),
    getMembership: (wid, uid) => withClient(async (c) => { const r = await c.query('SELECT workspace_id,user_id,role,created_at,profile FROM memberships WHERE workspace_id=$1 AND user_id=$2', [wid, uid]); return r.rows[0] ? rowMembership(r.rows[0]) : null; }),
    saveMembership: (m) => withClient((c) => c.query('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,user_id) DO UPDATE SET role=EXCLUDED.role', [m.workspace_id, m.user_id, m.role, m.created_at])),
    // Task 79: Postgres counterpart of storage.js's listWorkspaceMembers.
    listWorkspaceMembers: (wid) => withClient(async (c) => {
      const r = await c.query(
        `SELECT m.workspace_id,m.user_id,m.role,m.created_at,m.profile,u.id AS u_id,u.uid AS u_uid,u.email AS u_email,u.password_hash AS u_password_hash,u.created_at AS u_created_at,u.name AS u_name,u.metadata AS u_metadata
         FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1`,
        [wid]
      );

      return r.rows.map((row) => ({
        membership: rowMembership(row),
        user: rowUser({ id: row.u_id, uid: row.u_uid, email: row.u_email, password_hash: row.u_password_hash, created_at: row.u_created_at, name: row.u_name, metadata: row.u_metadata }),
      }));
    }),
    // Task 79: Postgres counterpart of storage.js's addRecentPages.
    addRecentPages: (wid, uid, viewIds) => withClient(async (c) => {
      if (!viewIds.length) return;
      const existing = await c.query('SELECT recent_view_ids FROM memberships WHERE workspace_id=$1 AND user_id=$2', [wid, uid]);
      const previous = existing.rows[0]?.recent_view_ids ?? [];
      const merged = [...viewIds, ...previous.filter((id) => !viewIds.includes(id))].slice(0, 50);

      await c.query('UPDATE memberships SET recent_view_ids=$3::jsonb WHERE workspace_id=$1 AND user_id=$2', [wid, uid, JSON.stringify(merged)]);
    }),
    // --- Workspace search index (migration 016); mirrors storage.js. Not exercised without DATABASE_URL. ---
    upsertSearchDocuments: (docs) => withClient(async (c) => {
      for (const doc of docs) {
        await c.query(
          `INSERT INTO search_documents(workspace_id,object_id,kind,view_id,database_id,database_view_id,database_row_id,title,content,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (workspace_id,object_id) DO UPDATE SET kind=EXCLUDED.kind,view_id=EXCLUDED.view_id,database_id=EXCLUDED.database_id,
             database_view_id=EXCLUDED.database_view_id,database_row_id=EXCLUDED.database_row_id,title=EXCLUDED.title,content=EXCLUDED.content,updated_at=EXCLUDED.updated_at`,
          [doc.workspace_id, doc.object_id, doc.kind, doc.view_id ?? null, doc.database_id ?? null, doc.database_view_id ?? null, doc.database_row_id ?? null, doc.title ?? '', doc.content ?? '', doc.updated_at]
        );
      }
    }),
    deleteSearchDocuments: (wid, objectIds) => withClient(async (c) => {
      if (objectIds.length) await c.query('DELETE FROM search_documents WHERE workspace_id=$1 AND object_id = ANY($2::uuid[])', [wid, objectIds]);
    }),
    listSearchDocumentRefs: (wid, { kind, databaseId } = {}) => withClient(async (c) => (await c.query(
      'SELECT object_id,kind,database_id FROM search_documents WHERE workspace_id=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::uuid IS NULL OR database_id=$3)',
      [wid, kind ?? null, databaseId ?? null]
    )).rows.map((row) => ({ object_id: row.object_id, kind: row.kind, database_id: row.database_id ?? null }))),
    // `terms` are alphanumeric tokens from search-text.js tokenize(); each becomes a prefix term.
    querySearchDocuments: (wid, terms, { max = 500 } = {}) => withClient(async (c) => {
      const tsquery = terms.map((term) => String(term).replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).map((term) => `${term}:*`).join(' & ');

      if (!tsquery) return [];
      const r = await c.query(
        `SELECT object_id,kind,view_id,database_id,database_view_id,database_row_id,title,content,updated_at,workspace_id
         FROM search_documents, to_tsquery('simple', $2) q
         WHERE workspace_id=$1 AND to_tsvector('simple', title || ' ' || content) @@ q
         ORDER BY ts_rank(to_tsvector('simple', title || ' ' || content), q) DESC LIMIT $3`,
        [wid, tsquery, max]
      );

      return r.rows.map((row) => ({ ...row, updated_at: new Date(row.updated_at).toISOString() }));
    }),
    listWorkspaceIds: () => withClient(async (c) => (await c.query('SELECT id FROM workspaces')).rows.map((row) => row.id)),
    getRecentPages: (wid, uid) => withClient(async (c) => (await c.query('SELECT recent_view_ids FROM memberships WHERE workspace_id=$1 AND user_id=$2', [wid, uid])).rows[0]?.recent_view_ids ?? []),
    // Workspace invite codes + per-workspace member profile (migration 015); mirrors storage.js.
    getWorkspaceInviteCode: (wid) => withClient(async (c) => {
      const r = await c.query('SELECT workspace_id,code,created_by,created_at,expires_at FROM workspace_invite_codes WHERE workspace_id=$1 AND (expires_at IS NULL OR expires_at > now())', [wid]);

      return r.rows[0] ? rowInviteCode(r.rows[0]) : null;
    }),
    findWorkspaceInviteCodeByCode: (code) => withClient(async (c) => {
      const r = await c.query('SELECT workspace_id,code,created_by,created_at,expires_at FROM workspace_invite_codes WHERE code=$1 AND (expires_at IS NULL OR expires_at > now())', [code]);

      return r.rows[0] ? rowInviteCode(r.rows[0]) : null;
    }),
    setWorkspaceInviteCode: ({ workspaceId, code, createdBy, createdAt, expiresAt }) => withClient((c) => c.query(
      `INSERT INTO workspace_invite_codes(workspace_id,code,created_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (workspace_id) DO UPDATE SET code=EXCLUDED.code,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at,expires_at=EXCLUDED.expires_at`,
      [workspaceId, code, createdBy, createdAt, expiresAt ?? null]
    )),
    deleteWorkspaceInviteCode: (wid) => withClient((c) => c.query('DELETE FROM workspace_invite_codes WHERE workspace_id=$1', [wid])),
    updateMembershipProfile: (wid, uid, profile) => withClient(async (c) => {
      const r = await c.query('UPDATE memberships SET profile=$3::jsonb WHERE workspace_id=$1 AND user_id=$2 RETURNING workspace_id,user_id,role,created_at,profile', [wid, uid, JSON.stringify(profile)]);

      return r.rows[0] ? rowMembership(r.rows[0]) : null;
    }),
    // Agent (MCP) tokens (migration 019); mirrors storage.js.
    // --- E-mail invitations (migration 020) ---
    upsertWorkspaceInvitation: (invitation) => withClient(async (client) => {
      const r = await client.query(
        `INSERT INTO workspace_invitations(id,workspace_id,email,role,invited_by,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (workspace_id, email) WHERE accepted_at IS NULL
         DO UPDATE SET role=EXCLUDED.role, invited_by=EXCLUDED.invited_by, created_at=EXCLUDED.created_at, expires_at=EXCLUDED.expires_at
         RETURNING *`,
        [invitation.id, invitation.workspace_id, invitation.email, invitation.role, invitation.invited_by, invitation.created_at, invitation.expires_at],
      );

      return rowInvitation(r.rows[0]);
    }),
    listWorkspaceInvitations: (workspaceId) => withClient(async (client) => (
      await client.query('SELECT * FROM workspace_invitations WHERE workspace_id=$1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at, id', [workspaceId])
    ).rows.map(rowInvitation)),
    findOpenInvitationsByEmail: (email) => withClient(async (client) => (
      await client.query('SELECT * FROM workspace_invitations WHERE email=$1 AND accepted_at IS NULL AND expires_at > now()', [email])
    ).rows.map(rowInvitation)),
    acceptWorkspaceInvitation: (id, at) => withClient(async (client) => (await client.query('UPDATE workspace_invitations SET accepted_at=$2 WHERE id=$1 AND accepted_at IS NULL', [id, at])).rowCount > 0),
    deleteWorkspaceInvitation: (workspaceId, id) => withClient(async (client) => (await client.query('DELETE FROM workspace_invitations WHERE id=$1 AND workspace_id=$2', [id, workspaceId])).rowCount > 0),
    // --- Agent activity trail (migration 021) ---
    recordAgentActivity: (row) => withClient(async (client) => {
      const r = await client.query(
        `INSERT INTO agent_activity(id,workspace_id,token_id,token_name,user_id,scope,tool,kind,target_type,target_id,target_title,summary,ok,error_code,duration_ms,undo,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17) RETURNING *`,
        [row.id, row.workspace_id, row.token_id, row.token_name, row.user_id, row.scope, row.tool, row.kind, row.target_type ?? null, row.target_id ?? null, row.target_title ?? null, row.summary, row.ok, row.error_code ?? null, row.duration_ms ?? null, row.undo ? JSON.stringify(row.undo) : null, row.created_at],
      );

      if (Math.random() < 0.01) await client.query("DELETE FROM agent_activity WHERE created_at < now() - interval '180 days'");
      return rowAgentActivity(r.rows[0]);
    }),
    getAgentActivity: (workspaceId, id) => withClient(async (client) => {
      const r = await client.query('SELECT * FROM agent_activity WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);

      return r.rows[0] ? rowAgentActivity(r.rows[0]) : null;
    }),
    listAgentActivity: (workspaceId, { limit = 50, before = null, beforeId = null, tokenId = null, userId = null, kind = null, ok = null } = {}) => withClient(async (client) => {
      const r = await client.query(
        `SELECT * FROM agent_activity WHERE workspace_id=$1 AND ($2::timestamptz IS NULL OR created_at < $2 OR ($8::uuid IS NOT NULL AND created_at = $2 AND id < $8)) AND ($3::text IS NULL OR token_id=$3)
           AND ($4::uuid IS NULL OR user_id=$4) AND ($5::text IS NULL OR kind=$5) AND ($6::boolean IS NULL OR ok=$6)
         ORDER BY created_at DESC, id DESC LIMIT $7`,
        [workspaceId, before, tokenId, userId, kind, ok, limit + 1, beforeId],
      );

      return { entries: r.rows.slice(0, limit).map(rowAgentActivity), has_more: r.rows.length > limit };
    }),
    markAgentActivityUndone: (workspaceId, id, userId, at) => withClient(async (client) => (
      await client.query('UPDATE agent_activity SET undone_at=$4, undone_by=$3 WHERE id=$1 AND workspace_id=$2 AND undone_at IS NULL', [id, workspaceId, userId, at])
    ).rowCount > 0),
    // --- Card history (migration 023) ---
    recordCardHistory: (entry) => withClient(async (client) => {
      const r = await client.query(
        `INSERT INTO card_history(id,workspace_id,database_id,row_id,title,actor_user_id,actor_user_ids,via,changes,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9::jsonb,$10) RETURNING *`,
        [entry.id, entry.workspace_id, entry.database_id, entry.row_id, entry.title ?? '', entry.actor_user_id ?? null, entry.actor_user_ids ?? [], entry.via ?? null, JSON.stringify(entry.changes), entry.created_at],
      );

      await client.query(
        `DELETE FROM card_history WHERE id IN (SELECT id FROM card_history WHERE workspace_id=$1 AND row_id=$2 ORDER BY created_at DESC, id DESC OFFSET 200)`,
        [entry.workspace_id, entry.row_id],
      );
      return rowCardHistory(r.rows[0]);
    }),
    getCardHistory: (workspaceId, id) => withClient(async (client) => {
      const r = await client.query('SELECT * FROM card_history WHERE id=$1 AND workspace_id=$2', [id, workspaceId]);

      return r.rows[0] ? rowCardHistory(r.rows[0]) : null;
    }),
    listCardHistory: (workspaceId, rowId, { limit = 30, before = null, beforeId = null } = {}) => withClient(async (client) => {
      const r = await client.query(
        `SELECT * FROM card_history WHERE workspace_id=$1 AND row_id=$2 AND ($3::timestamptz IS NULL OR created_at < $3 OR ($5::uuid IS NOT NULL AND created_at = $3 AND id < $5)) ORDER BY created_at DESC, id DESC LIMIT $4`,
        [workspaceId, rowId, before, limit + 1, beforeId],
      );

      return { entries: r.rows.slice(0, limit).map(rowCardHistory), has_more: r.rows.length > limit };
    }),
    markCardHistoryRestored: (workspaceId, id, userId, at) => withClient(async (client) => (
      await client.query('UPDATE card_history SET restored_at=$4, restored_by=$3 WHERE id=$1 AND workspace_id=$2 AND restored_at IS NULL', [id, workspaceId, userId, at])
    ).rowCount > 0),
    createAgentToken: (row) => withClient(async (c) => {
      const r = await c.query(
        `INSERT INTO agent_tokens(id,workspace_id,user_id,name,token_hash,scope,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id,workspace_id,user_id,name,token_hash,scope,created_at,last_used_at,expires_at,revoked,revoked_at`,
        [row.id, row.workspace_id, row.user_id, row.name, row.token_hash, row.scope, row.created_at, row.expires_at ?? null]
      );

      return rowAgentToken(r.rows[0]);
    }),
    getAgentToken: (tokenId) => withClient(async (c) => {
      const r = await c.query('SELECT id,workspace_id,user_id,name,token_hash,scope,created_at,last_used_at,expires_at,revoked,revoked_at FROM agent_tokens WHERE id=$1', [tokenId]);

      return r.rows[0] ? rowAgentToken(r.rows[0]) : null;
    }),
    listAgentTokens: (workspaceId) => withClient(async (c) => {
      const r = await c.query('SELECT id,workspace_id,user_id,name,token_hash,scope,created_at,last_used_at,expires_at,revoked,revoked_at FROM agent_tokens WHERE workspace_id=$1 ORDER BY created_at DESC, id DESC', [workspaceId]);

      return r.rows.map(rowAgentToken);
    }),
    revokeAgentToken: (workspaceId, tokenId, at) => withClient(async (c) => {
      const r = await c.query(
        `UPDATE agent_tokens SET revoked=true, revoked_at=COALESCE(revoked_at,$3) WHERE workspace_id=$1 AND id=$2
         RETURNING id,workspace_id,user_id,name,token_hash,scope,created_at,last_used_at,expires_at,revoked,revoked_at`,
        [workspaceId, tokenId, at]
      );

      return r.rows[0] ? rowAgentToken(r.rows[0]) : null;
    }),
    touchAgentToken: (tokenId, at) => withClient((c) => c.query('UPDATE agent_tokens SET last_used_at=$2 WHERE id=$1', [tokenId, at])),
    // --- Inline comments + inbox notifications (migration 014); mirrors storage.js ---
    createInlineComment: (c) => withClient(async (client) => {
      const r = await client.query(
        `INSERT INTO inline_comments(comment_id,workspace_id,view_id,block_id,user_id,content,reply_comment_id,is_resolved,is_deleted,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,false,false,
           GREATEST($8::timestamptz, COALESCE((SELECT max(created_at) FROM inline_comments WHERE workspace_id=$2 AND view_id=$3) + interval '1 millisecond', $8::timestamptz)),
           GREATEST($9::timestamptz, $8::timestamptz)) RETURNING *`,
        [c.comment_id, c.workspace_id, c.view_id, c.block_id ?? null, c.user_id, c.content, c.reply_comment_id ?? null, c.created_at, c.updated_at]
      );
      return rowInlineComment(r.rows[0]);
    }),
    getInlineComment: (workspaceId, viewId, commentId) => withClient(async (client) => {
      const r = await client.query('SELECT * FROM inline_comments WHERE comment_id=$1 AND workspace_id=$2 AND view_id=$3', [commentId, workspaceId, viewId]);
      return r.rows[0] ? rowInlineComment(r.rows[0]) : null;
    }),
    listInlineComments: (workspaceId, viewId, { offset = 0, limit = 100 } = {}) => withClient(async (client) => {
      const r = await client.query(
        'SELECT * FROM inline_comments WHERE workspace_id=$1 AND view_id=$2 ORDER BY created_at, comment_id OFFSET $3 LIMIT $4',
        [workspaceId, viewId, offset, limit + 1]
      );
      return { comments: r.rows.slice(0, limit).map(rowInlineComment), has_more: r.rows.length > limit };
    }),
    softDeleteInlineComment: (workspaceId, viewId, commentId, updatedAt) => withClient(async (client) => {
      const r = await client.query(
        'UPDATE inline_comments SET is_deleted=true, updated_at=$4 WHERE comment_id=$1 AND workspace_id=$2 AND view_id=$3 RETURNING *',
        [commentId, workspaceId, viewId, updatedAt]
      );
      return r.rows[0] ? rowInlineComment(r.rows[0]) : null;
    }),
    setInlineCommentResolved: (workspaceId, viewId, commentId, isResolved, updatedAt) => withClient(async (client) => {
      const r = await client.query(
        'UPDATE inline_comments SET is_resolved=$4, updated_at=$5 WHERE comment_id=$1 AND workspace_id=$2 AND view_id=$3 RETURNING *',
        [commentId, workspaceId, viewId, isResolved, updatedAt]
      );
      return r.rows[0] ? rowInlineComment(r.rows[0]) : null;
    }),
    listInlineCommentReactions: (workspaceId, viewId, commentId = null) => withClient(async (client) => {
      const r = await client.query(
        `SELECT r.comment_id, r.reaction_type, r.user_id, r.created_at
         FROM inline_comment_reactions r JOIN inline_comments c ON c.comment_id = r.comment_id
         WHERE c.workspace_id=$1 AND c.view_id=$2 AND ($3::uuid IS NULL OR r.comment_id=$3::uuid)
         ORDER BY r.created_at, r.reaction_type, r.user_id`,
        [workspaceId, viewId, commentId]
      );
      return r.rows.map((row) => ({ comment_id: row.comment_id, reaction_type: row.reaction_type, user_id: row.user_id, created_at: new Date(row.created_at).toISOString() }));
    }),
    addInlineCommentReaction: (reaction) => withClient((client) => client.query(
      'INSERT INTO inline_comment_reactions(comment_id,reaction_type,user_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [reaction.comment_id, reaction.reaction_type, reaction.user_id, reaction.created_at]
    )),
    removeInlineCommentReaction: (reaction) => withClient((client) => client.query(
      'DELETE FROM inline_comment_reactions WHERE comment_id=$1 AND reaction_type=$2 AND user_id=$3',
      [reaction.comment_id, reaction.reaction_type, reaction.user_id]
    )),
    createNotification: (n) => withClient(async (client) => {
      const r = await client.query(
        `INSERT INTO notifications(id,workspace_id,recipient_user_id,type,view_id,actor_uid,metadata,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
        [n.id, n.workspace_id, n.recipient_user_id, n.type, n.view_id ?? null, n.actor_uid ?? null, JSON.stringify(n.metadata ?? {}), n.created_at]
      );
      return rowNotification(r.rows[0]);
    }),
    listNotifications: (workspaceId, userId, { unreadOnly = false, archived = false, offset = 0, limit = 50 } = {}) => withClient(async (client) => {
      const r = await client.query(
        `SELECT * FROM notifications
         WHERE workspace_id=$1 AND recipient_user_id=$2 AND is_archived=$3 AND ($4::boolean = false OR is_read = false)
         ORDER BY created_at DESC, id DESC OFFSET $5 LIMIT $6`,
        [workspaceId, userId, archived, unreadOnly, offset, limit + 1]
      );
      return { notifications: r.rows.slice(0, limit).map(rowNotification), has_more: r.rows.length > limit };
    }),
    countUnreadNotifications: (workspaceId, userId) => withClient(async (client) => {
      const r = await client.query(
        'SELECT count(*)::int AS n FROM notifications WHERE workspace_id=$1 AND recipient_user_id=$2 AND is_read=false AND is_archived=false',
        [workspaceId, userId]
      );
      return r.rows[0].n;
    }),
    markNotificationsRead: (workspaceId, userId, ids, readAt) => withClient((client) => client.query(
      `UPDATE notifications SET is_read=true, read_at=$4
       WHERE workspace_id=$1 AND recipient_user_id=$2 AND is_read=false AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [workspaceId, userId, ids, readAt]
    )),
    archiveNotifications: (workspaceId, userId, ids) => withClient((client) => client.query(
      `UPDATE notifications SET is_archived=true
       WHERE workspace_id=$1 AND recipient_user_id=$2 AND is_archived=false AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [workspaceId, userId, ids]
    )),
    // Task 67: PostgreSQL parity for storage.js's deleteMembership -- same
    // dev/test-only revocation helper and security-test usage.
    deleteMembership: (wid, uid) => withClient((c) => c.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [wid, uid])),
    findUserByEmail: (email) => withClient(async (c) => { const r = await c.query('SELECT id,uid,email,password_hash,created_at,name,metadata FROM users WHERE email=$1', [email]); return r.rows[0] ? rowUser(r.rows[0]) : null; }),
    // Task 64: persists the same optional Folder-tree fields (parent_view_id,
    // icon, extra, is_favorite, position, layout) JSON mode's `createPage`
    // already keeps verbatim on the plain JS object it stores -- a latent
    // JSON/PostgreSQL parity gap discovered while writing Task 64's catalog
    // tests (this generic method previously persisted only 9 columns,
    // silently dropping the rest). Unobserved before now because this
    // method's only production caller, POST /api/workspaces/{id}/pages,
    // never sets those fields; Task 64's catalog tests are the first callers
    // that need a plain page row with `extra`/`layout`/`parent_view_id` set
    // without going through the Database-specific atomic-creation path.
    createPage: (p) => withClient((c) => c.query(
      `INSERT INTO pages(id,workspace_id,parent_view_id,title,icon,extra,is_favorite,position,document,schema_version,creator_id,version,created_at,updated_at,layout)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
      [p.id, p.workspace_id, p.parent_view_id ?? null, p.title, p.icon != null ? JSON.stringify(p.icon) : null,
        p.extra != null ? JSON.stringify(p.extra) : null, p.is_favorite === true, p.position != null ? JSON.stringify(p.position) : null,
        JSON.stringify(p.document), p.schema_version, p.creator_id, p.version, p.created_at, p.updated_at, p.layout ?? null],
    )),
    createAtomicDocumentPage: (page, collab, request) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const inserted = await c.query(
          `INSERT INTO atomic_creation_requests(request_id,workspace_id,request_digest,page_id,created_at)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT (request_id) DO NOTHING`,
          [request.request_id, page.workspace_id, request.request_digest, page.id, page.created_at]
        );
        if (!inserted.rowCount) {
          const existing = await c.query(
            'SELECT workspace_id,request_digest,page_id FROM atomic_creation_requests WHERE request_id=$1 FOR UPDATE',
            [request.request_id]
          );
          const record = existing.rows[0];
          if (!record || record.workspace_id !== page.workspace_id || record.request_digest !== request.request_digest || record.page_id !== page.id) {
            const error = new Error('Atomic request_id was already used for a different request');
            error.code = 'REQUEST_ID_REUSED';
            throw error;
          }
          const persisted = await c.query(
            `SELECT 1 FROM pages p JOIN collab_documents d ON d.workspace_id=p.workspace_id AND d.page_id=p.id
             WHERE p.id=$1 AND p.workspace_id=$2`,
            [page.id, page.workspace_id]
          );
          if (!persisted.rowCount) {
            const error = new Error('Atomic creation record is incomplete');
            error.code = 'ATOMIC_CREATION_INCOMPLETE';
            throw error;
          }
          await c.query('COMMIT');
          return { outcome: 'already_applied', result: { view_id: page.id, database_id: null } };
        }
        await c.query(
          `INSERT INTO pages(id,workspace_id,parent_view_id,title,icon,extra,is_favorite,position,document,schema_version,creator_id,version,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)`,
          [page.id, page.workspace_id, page.parent_view_id, page.title, JSON.stringify(page.icon), JSON.stringify(page.extra), page.is_favorite, JSON.stringify(page.position), JSON.stringify(page.document), page.schema_version, page.creator_id, page.version, page.created_at, page.updated_at]
        );
        await c.query(
          `INSERT INTO collab_documents(workspace_id,page_id,collab_version,restore_id,document_state,state_vector,generation,updated_at)
           VALUES($1,$2,$3,NULL,$4,$5,0,$6)`,
          [page.workspace_id, page.id, collab.collabVersion, Buffer.from(collab.documentState), Buffer.from(collab.stateVector), page.created_at]
        );
        await c.query('COMMIT');
        return { outcome: 'applied', result: { view_id: page.id, database_id: null } };
      } catch (error) {
        await c.query('ROLLBACK');
        if (error.code === '23505') error.code = 'PAGE_EXISTS';
        throw error;
      }
    }),
    getPageCollab: async (workspaceId, pageId) => {
      const state = await createPostgresPageCollabRepository(pool).load({ workspaceId, pageId });
      return state ? {
        object_id: state.pageId,
        doc_state: state.documentState,
        state_vector: state.stateVector,
        version: 0,
        collab_version: state.collabVersion,
        restore_id: state.restoreId ?? null,
        last_message_id: state.lastMessageId,
      } : null;
    },
    acceptPageCollabUpdate: (params) => createPostgresPageCollabRepository(pool).acceptUpdate(params),

    // --- Task 63: Database collab object (CollabType.Database = 1),
    // PostgreSQL parity for Task 61's JSON implementation. ---
    //
    // Mirrors storage.js's createAtomicDatabasePage exactly: the SAME
    // request_id namespace as Document page creation (atomic_creation_requests,
    // now carrying an added nullable database_id column -- see migration 007),
    // one transaction, idempotent replay, PAGE_EXISTS/DATABASE_EXISTS on a
    // genuine conflict.
    createAtomicDatabasePage: (containerPage, primaryViewPage, databaseId, collab, request) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const inserted = await c.query(
          `INSERT INTO atomic_creation_requests(request_id,workspace_id,request_digest,page_id,database_id,created_at)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (request_id) DO NOTHING`,
          [request.request_id, containerPage.workspace_id, request.request_digest, containerPage.id, databaseId, containerPage.created_at]
        );
        if (!inserted.rowCount) {
          const existing = await c.query(
            'SELECT workspace_id,request_digest,page_id,database_id FROM atomic_creation_requests WHERE request_id=$1 FOR UPDATE',
            [request.request_id]
          );
          const record = existing.rows[0];
          if (!record || record.workspace_id !== containerPage.workspace_id || record.request_digest !== request.request_digest || record.page_id !== containerPage.id) {
            const error = new Error('Atomic request_id was already used for a different request');
            error.code = 'REQUEST_ID_REUSED';
            throw error;
          }
          const persisted = await c.query(
            `SELECT 1 FROM pages p1 JOIN pages p2 ON p2.workspace_id = p1.workspace_id
             JOIN database_collab_documents d ON d.workspace_id = p1.workspace_id AND d.database_id = $3
             WHERE p1.id=$1 AND p2.id=$2 AND p1.workspace_id=$4`,
            [containerPage.id, primaryViewPage.id, record.database_id, containerPage.workspace_id]
          );
          if (!persisted.rowCount) {
            const error = new Error('Atomic creation record is incomplete');
            error.code = 'ATOMIC_CREATION_INCOMPLETE';
            throw error;
          }
          await c.query('COMMIT');
          return { outcome: 'already_applied', result: { view_id: containerPage.id, database_id: record.database_id } };
        }
        await c.query(
          `INSERT INTO pages(id,workspace_id,parent_view_id,title,icon,extra,is_favorite,position,document,schema_version,creator_id,version,created_at,updated_at,layout)
           VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
          [containerPage.id, containerPage.workspace_id, containerPage.parent_view_id, containerPage.title, JSON.stringify(containerPage.icon ?? null), JSON.stringify(containerPage.extra ?? null), !!containerPage.is_favorite, JSON.stringify(containerPage.position ?? null), JSON.stringify(containerPage.document ?? {}), 'v1', containerPage.creator_id, containerPage.version, containerPage.created_at, containerPage.updated_at, containerPage.layout ?? null]
        );
        await c.query(
          `INSERT INTO pages(id,workspace_id,parent_view_id,title,icon,extra,is_favorite,position,document,schema_version,creator_id,version,created_at,updated_at,layout)
           VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
          [primaryViewPage.id, primaryViewPage.workspace_id, primaryViewPage.parent_view_id, primaryViewPage.title, JSON.stringify(primaryViewPage.icon ?? null), JSON.stringify(primaryViewPage.extra ?? null), !!primaryViewPage.is_favorite, JSON.stringify(primaryViewPage.position ?? null), JSON.stringify(primaryViewPage.document ?? {}), 'v1', primaryViewPage.creator_id, primaryViewPage.version, primaryViewPage.created_at, primaryViewPage.updated_at, primaryViewPage.layout ?? null]
        );
        await c.query(
          `INSERT INTO database_collab_documents(workspace_id,database_id,collab_version,restore_id,document_state,state_vector,generation,last_message_id_timestamp,last_message_id_counter,updated_at)
           VALUES($1,$2,$3,NULL,$4,$5,0,0,0,$6)`,
          [containerPage.workspace_id, databaseId, collab.collabVersion, Buffer.from(collab.documentState), Buffer.from(collab.stateVector), containerPage.created_at]
        );
        await c.query('UPDATE atomic_creation_requests SET database_id=$2 WHERE request_id=$1', [request.request_id, databaseId]);
        await c.query('COMMIT');
        return { outcome: 'applied', result: { view_id: containerPage.id, database_id: databaseId } };
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch {}
        if (error.code === '23505') error.code = String(error.constraint || '').includes('database_collab_documents') ? 'DATABASE_EXISTS' : 'PAGE_EXISTS';
        throw error;
      }
    }),
    // Mirrors storage.js's createDocumentTreeFromTemplate: every page of a
    // document template tree + its Document collab, atomically, sharing
    // createAtomicDocumentPage's atomic_creation_requests ledger.
    createDocumentTreeFromTemplate: ({ entries, request }) => withClient(async (c) => {
      const root = entries[0].page;
      const result = { view_id: root.id, database_id: null, view_ids: entries.map((e) => e.page.id) };
      await c.query('BEGIN');
      try {
        const inserted = await c.query(
          `INSERT INTO atomic_creation_requests(request_id,workspace_id,request_digest,page_id,created_at)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT (request_id) DO NOTHING`,
          [request.request_id, root.workspace_id, request.request_digest, root.id, root.created_at]
        );
        if (!inserted.rowCount) {
          const existing = await c.query(
            'SELECT workspace_id,request_digest,page_id FROM atomic_creation_requests WHERE request_id=$1 FOR UPDATE',
            [request.request_id]
          );
          const record = existing.rows[0];
          if (!record || record.workspace_id !== root.workspace_id || record.request_digest !== request.request_digest || record.page_id !== root.id) {
            const error = new Error('Atomic request_id was already used for a different request');
            error.code = 'REQUEST_ID_REUSED';
            throw error;
          }
          const persisted = await c.query(
            `SELECT count(*)::int AS n FROM pages p JOIN collab_documents d ON d.workspace_id=p.workspace_id AND d.page_id=p.id
             WHERE p.workspace_id=$1 AND p.id = ANY($2::uuid[])`,
            [root.workspace_id, entries.map((e) => e.page.id)]
          );
          if (persisted.rows[0].n !== entries.length) {
            const error = new Error('Atomic creation record is incomplete');
            error.code = 'ATOMIC_CREATION_INCOMPLETE';
            throw error;
          }
          await c.query('COMMIT');
          return { outcome: 'already_applied', result };
        }
        for (const { page, collab } of entries) {
          await c.query(
            `INSERT INTO pages(id,workspace_id,parent_view_id,title,icon,extra,is_favorite,position,document,schema_version,creator_id,version,created_at,updated_at)
             VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)`,
            [page.id, page.workspace_id, page.parent_view_id, page.title, JSON.stringify(page.icon), JSON.stringify(page.extra), page.is_favorite, JSON.stringify(page.position), JSON.stringify(page.document), page.schema_version, page.creator_id, page.version, page.created_at, page.updated_at]
          );
          await c.query(
            `INSERT INTO collab_documents(workspace_id,page_id,collab_version,restore_id,document_state,state_vector,generation,updated_at)
             VALUES($1,$2,$3,NULL,$4,$5,0,$6)`,
            [page.workspace_id, page.id, collab.collabVersion, Buffer.from(collab.documentState), Buffer.from(collab.stateVector), page.created_at]
          );
        }
        await c.query('COMMIT');
        return { outcome: 'applied', result };
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch {}
        if (error.code === '23505') error.code = 'PAGE_EXISTS';
        throw error;
      }
    }),
    // Mirrors storage.js's createDatabaseFromTemplate: container page + one
    // page per view + Database collab + every sample row collab, atomically,
    // sharing createAtomicDatabasePage's atomic_creation_requests ledger.
    createDatabaseFromTemplate: ({ containerPage, viewPages, databaseId, collab, rows, rowDocuments = [], request }) => withClient(async (c) => {
      const result = { view_id: containerPage.id, database_id: databaseId, view_ids: viewPages.map((p) => p.id), row_ids: rows.map((r) => r.rowId) };
      await c.query('BEGIN');
      try {
        const inserted = await c.query(
          `INSERT INTO atomic_creation_requests(request_id,workspace_id,request_digest,page_id,database_id,created_at)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (request_id) DO NOTHING`,
          [request.request_id, containerPage.workspace_id, request.request_digest, containerPage.id, databaseId, containerPage.created_at]
        );
        if (!inserted.rowCount) {
          const existing = await c.query(
            'SELECT workspace_id,request_digest,page_id FROM atomic_creation_requests WHERE request_id=$1 FOR UPDATE',
            [request.request_id]
          );
          const record = existing.rows[0];
          if (!record || record.workspace_id !== containerPage.workspace_id || record.request_digest !== request.request_digest || record.page_id !== containerPage.id) {
            const error = new Error('Atomic request_id was already used for a different request');
            error.code = 'REQUEST_ID_REUSED';
            throw error;
          }
          const persisted = await c.query(
            `SELECT 1 FROM pages p JOIN database_collab_documents d ON d.workspace_id = p.workspace_id AND d.database_id = $2
             WHERE p.id=$1 AND p.workspace_id=$3`,
            [containerPage.id, databaseId, containerPage.workspace_id]
          );
          if (!persisted.rowCount) {
            const error = new Error('Atomic creation record is incomplete');
            error.code = 'ATOMIC_CREATION_INCOMPLETE';
            throw error;
          }
          await c.query('COMMIT');
          return { outcome: 'already_applied', result };
        }
        for (const page of [containerPage, ...viewPages]) {
          await c.query(
            `INSERT INTO pages(id,workspace_id,parent_view_id,title,icon,extra,is_favorite,position,document,schema_version,creator_id,version,created_at,updated_at,layout)
             VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
            [page.id, page.workspace_id, page.parent_view_id, page.title, JSON.stringify(page.icon ?? null), JSON.stringify(page.extra ?? null), !!page.is_favorite, JSON.stringify(page.position ?? null), JSON.stringify(page.document ?? {}), 'v1', page.creator_id, page.version, page.created_at, page.updated_at, page.layout ?? null]
          );
        }
        await c.query(
          `INSERT INTO database_collab_documents(workspace_id,database_id,collab_version,restore_id,document_state,state_vector,generation,last_message_id_timestamp,last_message_id_counter,updated_at)
           VALUES($1,$2,$3,NULL,$4,$5,0,0,0,$6)`,
          [containerPage.workspace_id, databaseId, collab.collabVersion, Buffer.from(collab.documentState), Buffer.from(collab.stateVector), containerPage.created_at]
        );
        for (const row of rows) {
          await c.query(
            `INSERT INTO database_row_collab_documents(workspace_id,row_id,database_id,collab_version,restore_id,document_state,state_vector,generation,last_message_id_timestamp,last_message_id_counter,updated_at)
             VALUES($1,$2,$3,NULL,NULL,$4,$5,0,0,0,$6)`,
            [containerPage.workspace_id, row.rowId, databaseId, Buffer.from(row.documentState), Buffer.from(row.stateVector), containerPage.created_at]
          );
        }
        // Card bodies: the row's detail-page document (an "orphaned" page, see ensureRowDocumentPage in server.js).
        for (const { page, collab: bodyCollab } of rowDocuments) {
          await c.query(
            `INSERT INTO pages(id,workspace_id,parent_view_id,title,icon,extra,is_favorite,position,document,schema_version,creator_id,version,created_at,updated_at)
             VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)`,
            [page.id, page.workspace_id, page.parent_view_id, page.title, JSON.stringify(page.icon ?? null), JSON.stringify(page.extra ?? null), !!page.is_favorite, JSON.stringify(page.position ?? null), JSON.stringify(page.document ?? {}), page.schema_version, page.creator_id, page.version, page.created_at, page.updated_at]
          );
          await c.query(
            `INSERT INTO collab_documents(workspace_id,page_id,collab_version,restore_id,document_state,state_vector,generation,updated_at)
             VALUES($1,$2,$3,NULL,$4,$5,0,$6)`,
            [page.workspace_id, page.id, bodyCollab.collabVersion, Buffer.from(bodyCollab.documentState), Buffer.from(bodyCollab.stateVector), page.created_at]
          );
        }
        await c.query('COMMIT');
        return { outcome: 'applied', result };
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch {}
        if (error.code === '23505') error.code = String(error.constraint || '').includes('database_collab_documents') || String(error.constraint || '').includes('database_row') ? 'DATABASE_EXISTS' : 'PAGE_EXISTS';
        throw error;
      }
    }),
    getDatabaseCollab: async (workspaceId, databaseId) => {
      const state = await createPostgresDatabaseCollabRepository(pool).load({ workspaceId, objectId: databaseId });
      return state ? {
        object_id: state.database_id,
        doc_state: state.documentState,
        state_vector: state.stateVector,
        version: 0,
        collab_version: state.collabVersion,
        last_message_id: state.lastMessageId,
      } : null;
    },
    acceptDatabaseCollabUpdate: ({ workspaceId, databaseId, ...rest }) =>
      createPostgresDatabaseCollabRepository(pool).acceptUpdate({ workspaceId, objectId: databaseId, ...rest }),

    // --- Task 72: additional database-view creation, PostgreSQL parity for
    // this task's JSON implementation (storage.js createAtomicDatabaseView).
    // Same transactional shape as createAtomicDatabaseRow below: claim the
    // request_id via an INSERT-as-mutex into a dedicated idempotency table,
    // lock the parent Database row FOR UPDATE, mutate a decoded copy of its
    // Yjs state in-process (addDatabaseView, database-document.js -- the
    // exact same helper JSON mode uses, so the two storage modes can never
    // diverge on the actual view-construction logic), then persist the new
    // Database document_state and the new Folder-tree page row together,
    // all inside one transaction. `database_update`/`update_batch_id` are
    // required by AppFlowy-Web's own atomic-creation journal receipt
    // validator (discovered via real-browser verification, see migration
    // 009's comment) -- the claim row is inserted with `database_update`
    // NULL and filled in by an UPDATE right before COMMIT, same pattern as
    // createAtomicDatabaseRow below.
    createAtomicDatabaseView: ({ workspaceId, databaseId, viewId, sourceViewId, layout, name, embedded, timestamp, page, request }) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const claim = await c.query(
          `INSERT INTO atomic_view_creation_requests(request_id,workspace_id,database_id,request_digest,view_id,update_batch_id,database_update,created_at)
           VALUES($1,$2,$3,$4,$5,$6,NULL,$7) ON CONFLICT (request_id) DO NOTHING`,
          [request.request_id, workspaceId, databaseId, request.request_digest, viewId, request.update_batch_id, timestamp]
        );
        if (!claim.rowCount) {
          const existing = await c.query(
            'SELECT workspace_id,database_id,request_digest,view_id,update_batch_id,database_update FROM atomic_view_creation_requests WHERE request_id=$1 FOR UPDATE',
            [request.request_id]
          );
          const record = existing.rows[0];
          if (!record || record.workspace_id !== workspaceId || record.request_digest !== request.request_digest || record.database_id !== databaseId) {
            const error = new Error('Atomic request_id was already used for a different request');
            error.code = 'REQUEST_ID_REUSED';
            throw error;
          }
          const persisted = await c.query('SELECT 1 FROM pages WHERE id=$1 AND workspace_id=$2', [record.view_id, workspaceId]);
          if (!persisted.rowCount || record.database_update === null) {
            const error = new Error('Atomic view creation record is incomplete');
            error.code = 'ATOMIC_CREATION_INCOMPLETE';
            throw error;
          }
          await c.query('COMMIT');
          return {
            outcome: 'already_applied', view_id: record.view_id,
            database_update: new Uint8Array(record.database_update), update_batch_id: record.update_batch_id,
          };
        }

        const dbRow = await c.query(
          'SELECT document_state, generation FROM database_collab_documents WHERE workspace_id=$1 AND database_id=$2 FOR UPDATE',
          [workspaceId, databaseId]
        );
        if (!dbRow.rowCount) {
          const error = new Error('Parent Database collaboration object not found');
          error.code = 'DATABASE_NOT_FOUND';
          throw error;
        }
        const currentGeneration = dbRow.rows[0].generation;

        const doc = new Y.Doc({ guid: databaseId });
        let diffUpdate, newDocumentState, newStateVector;
        try {
          Y.applyUpdate(doc, new Uint8Array(dbRow.rows[0].document_state));
          const beforeStateVector = Y.encodeStateVector(doc);
          addDatabaseView(doc, { viewId, databaseId, name, layout, embedded, sourceViewId, timestamp });
          diffUpdate = Y.encodeStateAsUpdate(doc, beforeStateVector);
          newDocumentState = Y.encodeStateAsUpdate(doc);
          newStateVector = Y.encodeStateVector(doc);
        } finally {
          doc.destroy();
        }

        const dbUpdate = await c.query(
          `UPDATE database_collab_documents SET document_state=$3,state_vector=$4,generation=generation+1,updated_at=$5
           WHERE workspace_id=$1 AND database_id=$2 AND generation=$6`,
          [workspaceId, databaseId, Buffer.from(newDocumentState), Buffer.from(newStateVector), timestamp, currentGeneration]
        );
        if (!dbUpdate.rowCount) {
          const error = new Error('Parent Database generation changed during view creation');
          error.code = 'CONCURRENT_UPDATE';
          throw error;
        }

        const pageInsert = await c.query(
          `INSERT INTO pages(id,workspace_id,parent_view_id,title,icon,extra,is_favorite,position,document,schema_version,creator_id,version,created_at,updated_at,layout)
           VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
          [page.id, page.workspace_id, page.parent_view_id, page.title, JSON.stringify(page.icon ?? null), JSON.stringify(page.extra ?? null), !!page.is_favorite, JSON.stringify(page.position ?? null), JSON.stringify(page.document ?? {}), 'v1', page.creator_id, page.version, page.created_at, page.updated_at, page.layout ?? null]
        );
        if (!pageInsert.rowCount) {
          const error = new Error('Page ID already exists');
          error.code = 'PAGE_EXISTS';
          throw error;
        }

        await c.query('UPDATE atomic_view_creation_requests SET database_update=$2 WHERE request_id=$1', [request.request_id, Buffer.from(diffUpdate)]);

        await c.query('COMMIT');
        return { outcome: 'applied', view_id: viewId, database_update: diffUpdate, update_batch_id: request.update_batch_id };
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch {}
        if (error.code === '23505') error.code = 'PAGE_EXISTS';
        throw error;
      }
    }),

    // --- Task 63: DatabaseRow atomic creation (CollabType.DatabaseRow = 4),
    // PostgreSQL parity for Task 62's JSON implementation. ---
    //
    // A single genuine Postgres transaction. Idempotency "claim" (step 1)
    // uses the same upsert-as-mutex pattern as createAtomicDocumentPage /
    // createAtomicDatabasePage above: the initial INSERT's unique-index
    // conflict check is what safely serializes two truly concurrent
    // requests sharing the same request_id (Postgres makes the second
    // INSERT wait for the first transaction to commit or roll back before
    // it can determine ON CONFLICT). The parent Database row is then locked
    // FOR UPDATE for the rest of the transaction -- a per-Database row lock,
    // not a global lock -- which is what serializes two DIFFERENT concurrent
    // row-creation requests against the SAME Database (so row_orders
    // mutations are never lost) while leaving unrelated Databases
    // (different database_id) completely unaffected.
    //
    // database_update (the Database Yjs diff returned to the creating
    // client) is only known after the in-transaction Y.Doc mutation below,
    // so the claim row is inserted with it NULL and filled in by an UPDATE
    // right before COMMIT -- still inside the same transaction, so a crash
    // or injected fault at ANY point rolls back the claim row too (no
    // success-indicating idempotency receipt can ever survive a failed
    // transaction).
    createAtomicDatabaseRow: ({ workspaceId, databaseId, rowId, sourceViewId, position, rowCollab, request }) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const claim = await c.query(
          `INSERT INTO atomic_row_creation_requests(request_id,workspace_id,database_id,request_digest,row_id,update_batch_id,database_update,created_at)
           VALUES($1,$2,$3,$4,$5,$6,NULL,$7) ON CONFLICT (request_id) DO NOTHING`,
          [request.request_id, workspaceId, databaseId, request.request_digest, rowId, request.update_batch_id, request.timestamp]
        );
        if (!claim.rowCount) {
          const existing = await c.query(
            'SELECT workspace_id,database_id,request_digest,row_id,update_batch_id,database_update FROM atomic_row_creation_requests WHERE request_id=$1 FOR UPDATE',
            [request.request_id]
          );
          const record = existing.rows[0];
          if (!record || record.workspace_id !== workspaceId || record.request_digest !== request.request_digest || record.database_id !== databaseId) {
            const error = new Error('Atomic request_id was already used for a different request');
            error.code = 'REQUEST_ID_REUSED';
            throw error;
          }
          const rowExists = await c.query('SELECT 1 FROM database_row_collab_documents WHERE workspace_id=$1 AND row_id=$2', [workspaceId, record.row_id]);
          if (!rowExists.rowCount || record.database_update === null) {
            const error = new Error('Atomic row creation record is incomplete');
            error.code = 'ATOMIC_CREATION_INCOMPLETE';
            throw error;
          }
          await c.query('COMMIT');
          return { outcome: 'already_applied', row_id: record.row_id, database_update: new Uint8Array(record.database_update), update_batch_id: record.update_batch_id };
        }

        maybeThrowTestFault('after_claim');

        const dbRow = await c.query(
          'SELECT document_state, generation FROM database_collab_documents WHERE workspace_id=$1 AND database_id=$2 FOR UPDATE',
          [workspaceId, databaseId]
        );
        if (!dbRow.rowCount) {
          const error = new Error('Parent Database collaboration object not found');
          error.code = 'DATABASE_NOT_FOUND';
          throw error;
        }
        const currentGeneration = dbRow.rows[0].generation;

        maybeThrowTestFault('after_parent_loaded');

        const doc = new Y.Doc({ guid: databaseId });
        let diffUpdate, newDocumentState, newStateVector;
        try {
          Y.applyUpdate(doc, new Uint8Array(dbRow.rows[0].document_state));
          const beforeStateVector = Y.encodeStateVector(doc);
          const database = doc.getMap('data').get('database');
          const views = database && database.get('views');
          const view = views && views.get(sourceViewId);
          if (!database || database.get('id') !== databaseId || !view) {
            const error = new Error('source_view_id does not belong to this Database');
            error.code = 'VIEW_NOT_FOUND';
            throw error;
          }
          const rowOrders = view.get('row_orders');
          const currentOrders = rowOrders.toArray();
          let insertIndex = currentOrders.length;
          if (position.kind === 'start') {
            insertIndex = 0;
          } else if (position.kind === 'after') {
            const anchor = currentOrders.findIndex((o) => o.id === position.row_id);
            insertIndex = anchor === -1 ? currentOrders.length : anchor + 1;
          } else if (position.kind === 'before') {
            const anchor = currentOrders.findIndex((o) => o.id === position.row_id);
            insertIndex = anchor === -1 ? currentOrders.length : anchor;
          }
          rowOrders.insert(insertIndex, [{ id: rowId, height: request.height }]);
          diffUpdate = Y.encodeStateAsUpdate(doc, beforeStateVector);
          newDocumentState = Y.encodeStateAsUpdate(doc);
          newStateVector = Y.encodeStateVector(doc);
        } finally {
          doc.destroy();
        }

        maybeThrowTestFault('after_row_order_mutation');

        const rowInsert = await c.query(
          `INSERT INTO database_row_collab_documents(workspace_id,row_id,database_id,collab_version,restore_id,document_state,state_vector,generation,last_message_id_timestamp,last_message_id_counter,updated_at)
           VALUES($1,$2,$3,NULL,NULL,$4,$5,0,0,0,$6) ON CONFLICT (workspace_id,row_id) DO NOTHING`,
          [workspaceId, rowId, databaseId, Buffer.from(rowCollab.documentState), Buffer.from(rowCollab.stateVector), request.timestamp]
        );
        if (!rowInsert.rowCount) {
          const error = new Error('Row ID already exists');
          error.code = 'ROW_EXISTS';
          throw error;
        }

        maybeThrowTestFault('after_row_doc_inserted');

        const dbUpdate = await c.query(
          `UPDATE database_collab_documents SET document_state=$3,state_vector=$4,generation=generation+1,updated_at=$5
           WHERE workspace_id=$1 AND database_id=$2 AND generation=$6`,
          [workspaceId, databaseId, Buffer.from(newDocumentState), Buffer.from(newStateVector), request.timestamp, currentGeneration]
        );
        if (!dbUpdate.rowCount) {
          const error = new Error('Parent Database generation changed during row creation');
          error.code = 'CONCURRENT_UPDATE';
          throw error;
        }

        maybeThrowTestFault('before_receipt_insert');

        await c.query('UPDATE atomic_row_creation_requests SET database_update=$2 WHERE request_id=$1', [request.request_id, Buffer.from(diffUpdate)]);

        maybeThrowTestFault('before_commit');

        await c.query('COMMIT');
        return { outcome: 'applied', row_id: rowId, database_update: diffUpdate, update_batch_id: request.update_batch_id };
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch {}
        if (error.code === '23505') error.code = 'ROW_EXISTS';
        throw error;
      }
    }),
    // Task 79: Postgres counterpart of storage.js's createSeededDatabaseRow --
    // the "seeded" template-row-creation path, generalized to every view in
    // positionViewIds and an optional Document page, both pre-built and
    // handed over already-encoded by the client.
    createSeededDatabaseRow: ({
      workspaceId, databaseId, rowId, positionViewIds, position, height,
      rowState, rowStateVector, documentPage, request,
    }) => withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const claim = await c.query(
          `INSERT INTO seeded_row_creation_requests(request_id,workspace_id,database_id,request_digest,row_id,document_id,update_batch_id,database_update,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8) ON CONFLICT (request_id) DO NOTHING`,
          [request.request_id, workspaceId, databaseId, request.request_digest, rowId, documentPage?.id ?? null, request.update_batch_id, request.timestamp]
        );

        if (!claim.rowCount) {
          const existing = await c.query(
            'SELECT workspace_id,database_id,request_digest,row_id,document_id,update_batch_id,database_update FROM seeded_row_creation_requests WHERE request_id=$1 FOR UPDATE',
            [request.request_id]
          );
          const record = existing.rows[0];

          if (!record || record.workspace_id !== workspaceId || record.request_digest !== request.request_digest || record.database_id !== databaseId) {
            const error = new Error('Atomic request_id was already used for a different request');

            error.code = 'REQUEST_ID_REUSED';
            throw error;
          }
          const rowExists = await c.query('SELECT 1 FROM database_row_collab_documents WHERE workspace_id=$1 AND row_id=$2', [workspaceId, record.row_id]);

          if (!rowExists.rowCount || record.database_update === null) {
            const error = new Error('Atomic row creation record is incomplete');

            error.code = 'ATOMIC_CREATION_INCOMPLETE';
            throw error;
          }
          await c.query('COMMIT');
          return {
            outcome: 'already_applied', row_id: record.row_id, document_id: record.document_id,
            database_update: new Uint8Array(record.database_update), update_batch_id: record.update_batch_id,
          };
        }

        const dbRow = await c.query(
          'SELECT document_state, generation FROM database_collab_documents WHERE workspace_id=$1 AND database_id=$2 FOR UPDATE',
          [workspaceId, databaseId]
        );

        if (!dbRow.rowCount) {
          const error = new Error('Parent Database collaboration object not found');

          error.code = 'DATABASE_NOT_FOUND';
          throw error;
        }
        const currentGeneration = dbRow.rows[0].generation;
        const doc = new Y.Doc({ guid: databaseId });
        let diffUpdate, newDocumentState, newStateVector;

        try {
          Y.applyUpdate(doc, new Uint8Array(dbRow.rows[0].document_state));
          const beforeStateVector = Y.encodeStateVector(doc);
          const database = doc.getMap('data').get('database');
          const views = database && database.get('views');

          if (!database || database.get('id') !== databaseId) {
            const error = new Error('position_view_ids do not belong to this Database');

            error.code = 'VIEW_NOT_FOUND';
            throw error;
          }
          for (const viewId of positionViewIds) {
            const view = views.get(viewId);

            if (!view) {
              const error = new Error('position_view_ids do not belong to this Database');

              error.code = 'VIEW_NOT_FOUND';
              throw error;
            }

            const rowOrders = view.get('row_orders');
            const currentOrders = rowOrders.toArray();
            let insertIndex = currentOrders.length;

            if (position.kind === 'start') {
              insertIndex = 0;
            } else if (position.kind === 'after') {
              const anchor = currentOrders.findIndex((o) => o.id === position.row_id);

              insertIndex = anchor === -1 ? currentOrders.length : anchor + 1;
            } else if (position.kind === 'before') {
              const anchor = currentOrders.findIndex((o) => o.id === position.row_id);

              insertIndex = anchor === -1 ? currentOrders.length : anchor;
            }

            rowOrders.insert(insertIndex, [{ id: rowId, height }]);
          }

          diffUpdate = Y.encodeStateAsUpdate(doc, beforeStateVector);
          newDocumentState = Y.encodeStateAsUpdate(doc);
          newStateVector = Y.encodeStateVector(doc);
        } finally {
          doc.destroy();
        }

        const rowInsert = await c.query(
          `INSERT INTO database_row_collab_documents(workspace_id,row_id,database_id,collab_version,restore_id,document_state,state_vector,generation,last_message_id_timestamp,last_message_id_counter,updated_at)
           VALUES($1,$2,$3,NULL,NULL,$4,$5,0,0,0,$6) ON CONFLICT (workspace_id,row_id) DO NOTHING`,
          [workspaceId, rowId, databaseId, Buffer.from(rowState), Buffer.from(rowStateVector), request.timestamp]
        );

        if (!rowInsert.rowCount) {
          const error = new Error('Row ID already exists');

          error.code = 'ROW_EXISTS';
          throw error;
        }

        if (documentPage) {
          await c.query(
            `INSERT INTO pages(id,workspace_id,parent_view_id,title,icon,extra,is_favorite,position,document,schema_version,creator_id,version,created_at,updated_at)
             VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)`,
            [documentPage.id, documentPage.page.workspace_id, documentPage.page.parent_view_id, documentPage.page.title,
              JSON.stringify(documentPage.page.icon), JSON.stringify(documentPage.page.extra), documentPage.page.is_favorite,
              JSON.stringify(documentPage.page.position), JSON.stringify(documentPage.page.document), documentPage.page.schema_version,
              documentPage.page.creator_id, documentPage.page.version, documentPage.page.created_at, documentPage.page.updated_at]
          );
          await c.query(
            `INSERT INTO collab_documents(workspace_id,page_id,collab_version,restore_id,document_state,state_vector,generation,updated_at)
             VALUES($1,$2,$3,NULL,$4,$5,0,$6)`,
            [workspaceId, documentPage.id, documentPage.collab.collabVersion, Buffer.from(documentPage.collab.documentState),
              Buffer.from(documentPage.collab.stateVector), request.timestamp]
          );
        }

        const dbUpdate = await c.query(
          `UPDATE database_collab_documents SET document_state=$3,state_vector=$4,generation=generation+1,updated_at=$5
           WHERE workspace_id=$1 AND database_id=$2 AND generation=$6`,
          [workspaceId, databaseId, Buffer.from(newDocumentState), Buffer.from(newStateVector), request.timestamp, currentGeneration]
        );

        if (!dbUpdate.rowCount) {
          const error = new Error('Parent Database generation changed during row creation');

          error.code = 'CONCURRENT_UPDATE';
          throw error;
        }

        await c.query('UPDATE seeded_row_creation_requests SET database_update=$2 WHERE request_id=$1', [request.request_id, Buffer.from(diffUpdate)]);
        await c.query('COMMIT');
        return {
          outcome: 'applied', row_id: rowId, document_id: documentPage?.id ?? null,
          database_update: diffUpdate, update_batch_id: request.update_batch_id,
        };
      } catch (error) {
        try { await c.query('ROLLBACK'); } catch {}
        if (error.code === '23505') error.code = 'ROW_EXISTS';
        throw error;
      }
    }),
    // Task 79: Postgres counterpart of storage.js's ensureHiddenDatabaseRow --
    // same semantics (never touches row_orders, idempotent by row identity
    // alone since rowId is a stable client-committed UUID).
    ensureHiddenDatabaseRow: ({ workspaceId, databaseId, rowId, rowCollab, timestamp }) => withClient(async (c) => {
      const existing = await c.query('SELECT 1 FROM database_row_collab_documents WHERE workspace_id=$1 AND row_id=$2', [workspaceId, rowId]);
      if (existing.rowCount) return { created: false };
      const database = await c.query('SELECT 1 FROM database_collab_documents WHERE workspace_id=$1 AND database_id=$2', [workspaceId, databaseId]);
      if (!database.rowCount) {
        const notFoundError = new Error('Parent Database collaboration object not found');
        notFoundError.code = 'DATABASE_NOT_FOUND';
        throw notFoundError;
      }
      const inserted = await c.query(
        `INSERT INTO database_row_collab_documents(workspace_id,row_id,database_id,collab_version,restore_id,document_state,state_vector,generation,last_message_id_timestamp,last_message_id_counter,updated_at)
         VALUES($1,$2,$3,NULL,NULL,$4,$5,0,0,0,$6) ON CONFLICT (workspace_id,row_id) DO NOTHING`,
        [workspaceId, rowId, databaseId, Buffer.from(rowCollab.documentState), Buffer.from(rowCollab.stateVector), timestamp]
      );
      return { created: inserted.rowCount > 0 };
    }),
    getDatabaseRowCollab: async (workspaceId, rowId) => {
      const state = await createPostgresDatabaseRowCollabRepository(pool).load({ workspaceId, objectId: rowId });
      return state ? {
        object_id: state.row_id,
        doc_state: state.documentState,
        state_vector: state.stateVector,
        version: 0,
        collab_version: state.collabVersion,
        last_message_id: state.lastMessageId,
      } : null;
    },
    acceptDatabaseRowCollabUpdate: ({ workspaceId, rowId, ...rest }) =>
      createPostgresDatabaseRowCollabRepository(pool).acceptUpdate({ workspaceId, objectId: rowId, ...rest }),
    // Task 79: Postgres counterpart of storage.js's getDatabaseRowWorkspaceId.
    getDatabaseRowWorkspaceId: (rowId) => withClient(async (c) => {
      const r = await c.query('SELECT workspace_id FROM database_row_collab_documents WHERE row_id=$1', [rowId]);

      return r.rows[0]?.workspace_id ?? null;
    }),

    listPages: (wid) => withClient(async (c) => (await c.query(`SELECT ${PAGE_COLUMNS} FROM pages WHERE workspace_id=$1 ORDER BY created_at`, [wid])).rows.map(rowPage)),
    // Task 64: same derivation as JSON mode (storage.js), reusing the exact
    // same `pages` rows/columns `listPages` above already selects -- no new
    // migration, no second Database registry. See database-catalog.js.
    listWorkspaceDatabaseCatalog: (wid) => withClient(async (c) =>
      buildDatabaseCatalogFromPages((await c.query(`SELECT ${PAGE_COLUMNS} FROM pages WHERE workspace_id=$1`, [wid])).rows.map(rowPage))),
    getPage: (id) => withClient(async (c) => { const r = await c.query(`SELECT ${PAGE_COLUMNS} FROM pages WHERE id=$1`, [id]); return r.rows[0] ? rowPage(r.rows[0]) : null; }),
    updatePage: (id, wid, expected, changes) => withClient(async (c) => { const r = await c.query('UPDATE pages SET title=$4, document=$5::jsonb, version=version+1, updated_at=$6 WHERE id=$1 AND workspace_id=$2 AND version=$3 RETURNING id,workspace_id,title,document,schema_version,creator_id,version,created_at,updated_at', [id, wid, expected, changes.title, JSON.stringify(changes.document), changes.updated_at]); return r.rows[0] ? rowPage(r.rows[0]) : null; }),
    updatePageTitle: (id, wid, title, updatedAt) => withClient(async (c) => { const r = await c.query('UPDATE pages SET title=$3, updated_at=$4 WHERE id=$1 AND workspace_id=$2 RETURNING id,workspace_id,title,created_at,updated_at', [id, wid, title, updatedAt]); return r.rows[0] ? rowPage(r.rows[0]) : null; }),
    // Task 79: Postgres counterpart of storage.js's updatePageMetadata.
    // `changes` only carries keys the caller actually sent, so the SET
    // clause is built dynamically rather than always writing every column
    // (there is no `is_locked` column in this schema yet -- that field is
    // accepted but not persisted, same as in JSON mode's omission risk is
    // avoided by simply not claiming to support it server-side either).
    updatePageMetadata: (id, wid, changes, updatedAt) => withClient(async (c) => {
      const assignments = ['updated_at=$3'];
      const values = [id, wid, updatedAt];

      if ('title' in changes) { values.push(changes.title); assignments.push(`title=$${values.length}`); }
      if ('icon' in changes) { values.push(JSON.stringify(changes.icon)); assignments.push(`icon=$${values.length}::jsonb`); }
      if ('extra' in changes) { values.push(JSON.stringify(changes.extra)); assignments.push(`extra=$${values.length}::jsonb`); }
      const r = await c.query(`UPDATE pages SET ${assignments.join(',')} WHERE id=$1 AND workspace_id=$2 RETURNING ${PAGE_COLUMNS}`, values);

      return r.rows[0] ? rowPage(r.rows[0]) : null;
    }),
    movePage: (id, wid, { parent_view_id: parentViewId, sort_key: sortKey }, updatedAt) => withClient(async (c) => {
      const r = await c.query(
        `UPDATE pages SET parent_view_id=$3, position=COALESCE(position,'{"kind":"end"}'::jsonb) || jsonb_build_object('sort_key', $4::float8), updated_at=$5 WHERE id=$1 AND workspace_id=$2 RETURNING ${PAGE_COLUMNS}`,
        [id, wid, parentViewId, sortKey, updatedAt],
      );

      return r.rows[0] ? rowPage(r.rows[0]) : null;
    }),
    updateSpace: (id, wid, changes) => withClient(async (c) => {
      const assignments = [];
      const values = [id, wid];

      for (const key of ['name', 'space_icon', 'space_icon_color']) {
        if (key in changes) { values.push(changes[key]); assignments.push(`${key}=$${values.length}`); }
      }
      if (!assignments.length) { const r = await c.query('SELECT * FROM spaces WHERE id=$1 AND workspace_id=$2', values); return r.rows[0] ? rowSpace(r.rows[0]) : null; }
      const r = await c.query(`UPDATE spaces SET ${assignments.join(',')} WHERE id=$1 AND workspace_id=$2 RETURNING *`, values);

      return r.rows[0] ? rowSpace(r.rows[0]) : null;
    }),
    setPageFavorite: (id, wid, isFavorite, isPinned, updatedAt) => withClient(async (c) => { const r = await c.query(`UPDATE pages SET is_favorite=$3, is_pinned=$4, favorited_at=CASE WHEN $3 THEN $5::timestamptz ELSE NULL END WHERE id=$1 AND workspace_id=$2 RETURNING ${PAGE_COLUMNS}`, [id, wid, !!isFavorite, !!isPinned, updatedAt]); return r.rows[0] ? rowPage(r.rows[0]) : null; }),
    listFavoritePages: (wid) => withClient(async (c) => (await c.query(`SELECT ${PAGE_COLUMNS} FROM pages WHERE workspace_id=$1 AND is_favorite AND NOT is_trashed ORDER BY favorited_at DESC`, [wid])).rows.map(rowPage)),
    setPageTrashed: (id, wid, isTrashed, updatedAt) => withClient(async (c) => { const r = await c.query(`UPDATE pages SET is_trashed=$3, trashed_at=CASE WHEN $3 THEN $4::timestamptz ELSE NULL END WHERE id=$1 AND workspace_id=$2 RETURNING ${PAGE_COLUMNS}`, [id, wid, !!isTrashed, updatedAt]); return r.rows[0] ? rowPage(r.rows[0]) : null; }),
    listTrashedPages: (wid) => withClient(async (c) => (await c.query(`SELECT ${PAGE_COLUMNS} FROM pages WHERE workspace_id=$1 AND is_trashed ORDER BY trashed_at DESC`, [wid])).rows.map(rowPage)),
    deletePagePermanently: (id, wid) => withClient(async (c) => { const r = await c.query('DELETE FROM pages WHERE id=$1 AND workspace_id=$2', [id, wid]); return r.rowCount > 0; }),

    // --- Task 49B: document version history / restore (PostgreSQL parity
    // for Task 49A's JSON implementation; see postgres-collab-repository.js) ---
    listPageCollabVersions: (workspaceId, pageId, opts) => createPostgresPageCollabRepository(pool).listVersions(workspaceId, pageId, opts),
    getPageCollabVersion: (workspaceId, pageId, versionId) => createPostgresPageCollabRepository(pool).getVersion(workspaceId, pageId, versionId),
    createPageCollabVersion: (workspaceId, pageId, params) => createPostgresPageCollabRepository(pool).createVersion(workspaceId, pageId, params),
    pruneAutoPageVersions: (workspaceId, pageId, keep) => createPostgresPageCollabRepository(pool).pruneAutoVersions(workspaceId, pageId, keep),
    tombstonePageCollabVersion: (workspaceId, pageId, versionId) => createPostgresPageCollabRepository(pool).tombstoneVersion(workspaceId, pageId, versionId),
    restorePageCollabVersion: (params) => createPostgresPageCollabRepository(pool).restoreVersion(params),
  };
}

// Task 59: openPostgresStore() is the production entry point that can be,
// and in real deployments will be, called by multiple independent backend
// processes starting up concurrently against the SAME database (e.g.
// a rolling deploy, multiple replicas, or a crash-restart racing a still-
// shutting-down instance). Before Task 59 this function reapplied the
// entire migration DDL text on every call with no coordination between
// processes at all. Reproduced for Task 59: two real, independent OS
// processes calling this function concurrently against the same fresh
// database -- one completed in ~140ms, the other's connection finished
// executing on the Postgres server (confirmed idle via pg_stat_activity)
// but its Node client never returned, hanging indefinitely until killed.
// See docs/APPFLOWY_TASK59_REPORT.md for full reproduction evidence.
//
// The fix: a dedicated client (NOT a pool query, which could be served by
// a different backend connection per call and so could never hold a
// session-level lock consistently) acquires a Postgres session-level
// advisory lock keyed deterministically off the database identity before
// touching any schema at all, rechecks migration state under that lock,
// runs only what is actually still pending, and explicitly releases the
// lock before the client is returned to the pool -- in that order, so
// that an initialization failure never leaves either the lock held by a
// supposedly-done process or a pool client checked out forever (pool.end()
// waits for all checked-out clients to be released before resolving; a
// prior version of this function called pool.end() from inside the catch
// block while still awaiting a `finally` that had not yet run, which is
// the same class of ordering bug and could itself hang -- fixed here by
// releasing the lock and the client before ever calling pool.end()).
export async function openPostgresStore(databaseUrl = process.env.DATABASE_URL, options = {}) {
  if (!databaseUrl) throw new Error('STORAGE=postgres requires DATABASE_URL; refusing to fall back to JSON');
  let Pool;
  try { ({ Pool } = await import('pg')); } catch { throw new Error('STORAGE=postgres requires the pg package. Run npm install in this isolated project; no fallback is performed.'); }
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });
  const client = await pool.connect();
  const timeoutMs = options.migrationLockTimeoutMs ?? (Number(process.env.POSTGRES_MIGRATION_LOCK_TIMEOUT_MS) || 30000);
  let lockKey = null;
  let lockHeld = false;
  try {
    // Ask Postgres itself for the database identity of the connection we
    // actually got, rather than parsing databaseUrl -- robust to any URL
    // form (socket, alias, search path tricks) and never logs credentials.
    const { rows } = await client.query('SELECT current_database() AS name');
    lockKey = deriveMigrationLockKey(rows[0].name);
    await acquireAdvisoryLock(client, lockKey, { timeoutMs });
    lockHeld = true;
    await runMigrations(client);
  } catch (error) {
    if (lockHeld) {
      try { await releaseAdvisoryLock(client, lockKey); }
      catch (releaseError) { console.error('PostgreSQL migration advisory lock release failed during error handling:', releaseError.message); }
    }
    client.release();
    await pool.end();
    throw new Error(`PostgreSQL initialization failed: ${error.message}`);
  }
  // Success path: release the lock and return the client to the pool
  // BEFORE handing back the repository, so no caller can ever observe a
  // "successful" store while the migration lock is still held.
  try {
    await releaseAdvisoryLock(client, lockKey);
  } catch (releaseError) {
    client.release();
    await pool.end();
    throw new Error(`PostgreSQL initialization failed: failed to release migration advisory lock: ${releaseError.message}`);
  }
  client.release();
  return { ...repository(pool), ...createAiPostgresStorage(pool), collab: createPostgresPageCollabRepository(pool), close: () => pool.end() };
}
