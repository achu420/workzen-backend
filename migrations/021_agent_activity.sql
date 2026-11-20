-- What every agent token read or changed: who (token and its owner), what (tool, target, human summary), whether it
-- worked, and for writes the data needed to undo it. Names are copied in so the trail survives renames and revocation.
CREATE TABLE IF NOT EXISTS agent_activity (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_id text NOT NULL,
  token_name text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  tool text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('read', 'write')),
  target_type text,
  target_id text,
  target_title text,
  summary text NOT NULL,
  ok boolean NOT NULL,
  error_code text,
  duration_ms integer,
  undo jsonb,
  undone_at timestamptz,
  undone_by uuid,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_activity_workspace_idx ON agent_activity(workspace_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS agent_activity_token_idx ON agent_activity(token_id, created_at DESC);
