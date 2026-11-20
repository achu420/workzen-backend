-- Task 63: PostgreSQL storage parity for the Database (Task 61) and
-- DatabaseRow (Task 62) collaboration objects, which previously existed only
-- in JSON storage. Purely additive: no existing table is altered in a way
-- that changes existing Document behaviour, and no existing row is touched.
--
-- Schema mirrors the existing Document pattern (collab_documents /
-- collab_updates) as closely as the generic Yjs-update-prep code
-- (preparePageCollabUpdate in postgres-collab-repository.js) already assumes,
-- so the same generic repository logic can be reused for all three object
-- kinds (Document, Database, DatabaseRow) without a second independent RID
-- or dedup implementation.

-- Folder-tree sidebar/view entries (`pages` rows) for a Database's container
-- and primary/inline view never previously carried a Folder `layout` value
-- in PostgreSQL (server.js reads `page.layout ?? 0` directly off the stored
-- row). Without this column, every page created in PostgreSQL mode reads
-- back as layout=0 (Document), so a Postgres-created Database's Folder
-- sidebar entries would be indistinguishable from a plain Document -- a real
-- parity bug relative to JSON mode, where `layout` is just a free JS field.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS layout integer;

-- Pre-existing defect discovered while implementing Task 63 (not introduced
-- by it): migration 003 declared `parent_view_id uuid REFERENCES spaces(id)`,
-- which only ever allows a page's parent to be a SPACE. JSON storage never
-- enforced this -- a page's parent_view_id can already legitimately be
-- ANOTHER PAGE's id there (ordinary nested sub-pages; see
-- test/backend.test.js's "Child page" fixture, parent_view_id: parentPage.id)
-- -- but PostgreSQL mode had no code path that actually exercised a
-- page-parented-by-page write until now: a Database's primary/inline view
-- page is parented by the Database's OWN container page (server.js
-- createAtomicDatabasePage caller: primaryViewPage.parent_view_id =
-- containerId), which is a page id, not a space id, and the old FK rejected
-- every such insert with a foreign-key violation -- Database creation could
-- never have worked in PostgreSQL mode at all before this fix. Postgres
-- cannot express "references EITHER spaces(id) OR pages(id)" as a single
-- column FK; the correct, minimal fix is to drop the overly-narrow
-- constraint and rely on the same application-level validation JSON storage
-- already uses (requireWorkspace/getSpace checks in server.js, plus the
-- atomic-creation transactions that insert a page and its real parent
-- together). No existing code relies on ON DELETE CASCADE from spaces to
-- pages (no space-deletion code path exists in this backend yet), so
-- dropping it changes no currently-reachable behavior.
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_parent_view_id_fkey;

-- `atomic_creation_requests` already exists (migration 003) and already
-- parity-covers createAtomicDocumentPage()'s idempotency contract. JSON
-- mode's createAtomicDatabasePage() stores its result in the SAME
-- `s.atomicCreationRequests` collection as Document page creation (just with
-- an added `database_id` field) rather than a second collection -- mirrored
-- here as an added nullable column instead of a second table, so there is
-- exactly one request_id namespace for both Document and Database atomic
-- creation, exactly like JSON.
ALTER TABLE atomic_creation_requests ADD COLUMN IF NOT EXISTS database_id uuid;

-- --- Database collab object (CollabType.Database = 1) ---
CREATE TABLE IF NOT EXISTS database_collab_documents (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  database_id uuid NOT NULL,
  collab_version text NOT NULL,
  restore_id text,
  document_state bytea NOT NULL,
  state_vector bytea NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  last_message_id_timestamp bigint NOT NULL DEFAULT 0 CHECK (last_message_id_timestamp >= 0),
  last_message_id_counter bigint NOT NULL DEFAULT 0 CHECK (last_message_id_counter BETWEEN 0 AND 4294967295),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, database_id)
);

CREATE TABLE IF NOT EXISTS database_collab_updates (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  database_id uuid NOT NULL,
  payload_digest text NOT NULL,
  message_key text,
  flags integer NOT NULL CHECK (flags IN (0, 1)),
  payload bytea NOT NULL,
  before_state_vector bytea,
  collab_version text NOT NULL,
  restore_id text,
  created_at timestamptz NOT NULL,
  message_id_timestamp bigint,
  message_id_counter bigint,
  UNIQUE (workspace_id, database_id, payload_digest),
  UNIQUE (workspace_id, database_id, message_key),
  FOREIGN KEY (workspace_id, database_id) REFERENCES database_collab_documents(workspace_id, database_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS database_collab_updates_idx ON database_collab_updates(workspace_id, database_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS database_collab_updates_rid_key
  ON database_collab_updates(workspace_id, message_id_timestamp, message_id_counter)
  WHERE message_id_timestamp IS NOT NULL AND message_id_counter IS NOT NULL;

-- --- DatabaseRow collab object (CollabType.DatabaseRow = 4) ---
-- collab_version/restore_id are intentionally nullable (and always stored
-- NULL) -- the frontend contract requires DatabaseRow reads to report
-- `collab_version: null` (no independent row versioning), matching JSON
-- storage's databaseRowCollabDocuments records exactly.
CREATE TABLE IF NOT EXISTS database_row_collab_documents (
  workspace_id uuid NOT NULL,
  row_id uuid NOT NULL,
  database_id uuid NOT NULL,
  collab_version text,
  restore_id text,
  document_state bytea NOT NULL,
  state_vector bytea NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  last_message_id_timestamp bigint NOT NULL DEFAULT 0 CHECK (last_message_id_timestamp >= 0),
  last_message_id_counter bigint NOT NULL DEFAULT 0 CHECK (last_message_id_counter BETWEEN 0 AND 4294967295),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, row_id),
  FOREIGN KEY (workspace_id, database_id) REFERENCES database_collab_documents(workspace_id, database_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS database_row_collab_documents_database_idx ON database_row_collab_documents(workspace_id, database_id);

CREATE TABLE IF NOT EXISTS database_row_collab_updates (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  row_id uuid NOT NULL,
  payload_digest text NOT NULL,
  message_key text,
  flags integer NOT NULL CHECK (flags IN (0, 1)),
  payload bytea NOT NULL,
  before_state_vector bytea,
  collab_version text,
  restore_id text,
  created_at timestamptz NOT NULL,
  message_id_timestamp bigint,
  message_id_counter bigint,
  UNIQUE (workspace_id, row_id, payload_digest),
  UNIQUE (workspace_id, row_id, message_key),
  FOREIGN KEY (workspace_id, row_id) REFERENCES database_row_collab_documents(workspace_id, row_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS database_row_collab_updates_idx ON database_row_collab_updates(workspace_id, row_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS database_row_collab_updates_rid_key
  ON database_row_collab_updates(workspace_id, message_id_timestamp, message_id_counter)
  WHERE message_id_timestamp IS NOT NULL AND message_id_counter IS NOT NULL;

-- --- Atomic row-creation idempotency (Task 62's createAtomicDatabaseRow) ---
-- A dedicated table, mirroring JSON mode's separate `s.atomicRowCreationRequests`
-- collection (distinct from `s.atomicCreationRequests` used by Document/Database
-- page creation) -- row creation has its own request_id namespace in JSON
-- mode, so it gets its own table here rather than being folded into
-- atomic_creation_requests.
--
-- `database_update` is nullable and filled in by an UPDATE statement AFTER
-- the parent Database mutation is computed inside the SAME transaction as
-- the initial claiming INSERT below -- the initial INSERT (with
-- database_update NULL) is what lets Postgres's own unique-index conflict
-- resolution serialize two truly concurrent requests sharing the same
-- request_id (the second one's INSERT blocks on the first's uncommitted row
-- and only proceeds once the first commits or rolls back), without needing
-- a second, separate advisory lock.
CREATE TABLE IF NOT EXISTS atomic_row_creation_requests (
  request_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  database_id uuid NOT NULL,
  request_digest text NOT NULL,
  row_id uuid NOT NULL,
  update_batch_id uuid,
  database_update bytea,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS atomic_row_creation_requests_database_idx
  ON atomic_row_creation_requests(workspace_id, database_id, created_at);
