-- E-mail invitations: a pending offer to join a workspace, addressed to an e-mail that may not have an account yet.
-- Creating an account with that address (even when sign-up is otherwise closed) accepts it.
CREATE TABLE IF NOT EXISTS workspace_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_open_idx ON workspace_invitations(workspace_id, email) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_invitations_email_idx ON workspace_invitations(email) WHERE accepted_at IS NULL;
