CREATE TABLE IF NOT EXISTS spaces (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  space_icon text NOT NULL DEFAULT '',
  space_icon_color text NOT NULL DEFAULT '',
  permission jsonb NOT NULL,
  creator_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS spaces_workspace_idx ON spaces(workspace_id, created_at, id);
