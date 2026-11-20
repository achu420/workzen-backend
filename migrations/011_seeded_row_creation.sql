-- Task 79: idempotency ledger for the "seeded" template-row-creation path
-- (POST /v2/database/{databaseId}/row, AppFlowy-Web's submit-template-row.ts
-- for a template with no embedded databases). Mirrors
-- atomic_row_creation_requests, plus an optional document_id since this
-- path may publish the row's Document alongside it in the same request.
CREATE TABLE IF NOT EXISTS seeded_row_creation_requests (
  request_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  database_id uuid NOT NULL,
  request_digest text NOT NULL,
  row_id uuid NOT NULL,
  document_id uuid,
  update_batch_id uuid,
  database_update bytea,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS seeded_row_creation_requests_database_idx
  ON seeded_row_creation_requests(workspace_id, database_id, created_at);
