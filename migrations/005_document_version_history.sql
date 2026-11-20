-- Task 49B: PostgreSQL parity for document version history / restore
-- (Task 49A implemented this in JSON storage; this is the additive,
-- faithful Postgres port). Versions are append-only and tombstoned, never
-- physically deleted. Each version stores a complete, independently
-- reconstructable Yjs document state (not a delta).

CREATE TABLE IF NOT EXISTS collab_versions (
  version uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent uuid NULL,
  name text NULL,
  document_state bytea NOT NULL,
  kind text NOT NULL CHECK (kind IN ('named', 'before_restore')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint NULL,
  deleted_at timestamptz NULL,
  editors bigint[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS collab_versions_page_created_idx
  ON collab_versions(workspace_id, page_id, created_at);

CREATE TABLE IF NOT EXISTS restore_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  digest text NOT NULL,
  restored_version_id uuid NOT NULL REFERENCES collab_versions(version),
  before_restore_snapshot_version_id uuid NOT NULL REFERENCES collab_versions(version),
  resulting_restore_id uuid NOT NULL,
  actor bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS restore_events_page_created_idx
  ON restore_events(workspace_id, page_id, created_at DESC);
