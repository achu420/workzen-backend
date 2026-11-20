-- Card (database row) history: who changed which fields of a card, with the values before and after, so a person can
-- see what happened and put the old values back. One row per burst of edits (the server groups edits made close
-- together by the same people), capped per card.
CREATE TABLE IF NOT EXISTS card_history (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  database_id text NOT NULL,
  row_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  actor_user_id uuid,
  actor_user_ids uuid[] NOT NULL DEFAULT '{}',
  via text,
  changes jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  restored_at timestamptz,
  restored_by uuid
);
CREATE INDEX IF NOT EXISTS card_history_row_idx ON card_history(workspace_id, row_id, created_at DESC, id);
