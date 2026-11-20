ALTER TABLE pages ADD COLUMN IF NOT EXISTS parent_view_id uuid REFERENCES spaces(id) ON DELETE CASCADE;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS icon jsonb;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS extra jsonb;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS position jsonb;

CREATE TABLE IF NOT EXISTS atomic_creation_requests (
  request_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_digest text NOT NULL,
  page_id uuid NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS atomic_creation_requests_workspace_idx
  ON atomic_creation_requests(workspace_id, created_at);
