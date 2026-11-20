-- Agent (MCP) tokens: workspace-scoped, revocable credentials accepted ONLY on the
-- /mcp endpoint. Only the SHA-256 of the secret part is stored.
CREATE TABLE IF NOT EXISTS agent_tokens (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('read', 'write')),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked boolean NOT NULL DEFAULT false,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_tokens_workspace_idx ON agent_tokens(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_tokens_user_idx ON agent_tokens(user_id);
