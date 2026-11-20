-- Task 72: PostgreSQL storage parity for createAtomicDatabaseView (the one
-- confirmed backend gap found by this task's discovery -- see
-- docs/TASK72_DATABASE_VIEWS_DISCOVERY.md): creating an additional view
-- (Grid/Board/Calendar/etc.) inside an EXISTING Database collab object.
-- Purely additive, same convention as migration 007 (Task 63): a dedicated
-- idempotency table mirroring JSON mode's separate
-- `s.atomicViewCreationRequests` collection (its own request_id namespace,
-- distinct from both Document/Database page creation and row creation --
-- view creation has its own namespace in JSON mode too).
CREATE TABLE IF NOT EXISTS atomic_view_creation_requests (
  request_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  database_id uuid NOT NULL,
  request_digest text NOT NULL,
  view_id uuid NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS atomic_view_creation_requests_database_idx
  ON atomic_view_creation_requests(workspace_id, database_id, created_at);
