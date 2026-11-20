-- Inline document comments (GET/POST/DELETE .../document/{view}/inline-comment*)
-- and per-user inbox notifications (GET/POST .../notifications*).
-- Comments are flat: a reply is a comment whose reply_comment_id is set. Delete
-- is soft (is_deleted) so replies and the anchor in the document stay valid.
CREATE TABLE IF NOT EXISTS inline_comments (
  comment_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  view_id uuid NOT NULL,
  block_id text,
  user_id uuid NOT NULL REFERENCES users(id),
  content text NOT NULL,
  reply_comment_id uuid,
  is_resolved boolean NOT NULL DEFAULT false,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS inline_comments_view_idx ON inline_comments(workspace_id, view_id, created_at, comment_id);

CREATE TABLE IF NOT EXISTS inline_comment_reactions (
  comment_id uuid NOT NULL REFERENCES inline_comments(comment_id) ON DELETE CASCADE,
  reaction_type text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (comment_id, reaction_type, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  view_id uuid,
  actor_uid bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_inbox_idx
  ON notifications(workspace_id, recipient_user_id, is_archived, created_at DESC, id);
