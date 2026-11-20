ALTER TABLE collab_documents
  ADD COLUMN IF NOT EXISTS last_message_id_timestamp bigint NOT NULL DEFAULT 0 CHECK (last_message_id_timestamp >= 0),
  ADD COLUMN IF NOT EXISTS last_message_id_counter bigint NOT NULL DEFAULT 0 CHECK (last_message_id_counter BETWEEN 0 AND 4294967295);

ALTER TABLE collab_updates
  ADD COLUMN IF NOT EXISTS message_id_timestamp bigint,
  ADD COLUMN IF NOT EXISTS message_id_counter bigint;

CREATE UNIQUE INDEX IF NOT EXISTS collab_updates_workspace_rid_key
  ON collab_updates(workspace_id, message_id_timestamp, message_id_counter)
  WHERE message_id_timestamp IS NOT NULL AND message_id_counter IS NOT NULL;

CREATE TABLE IF NOT EXISTS collab_workspace_rids (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  timestamp bigint NOT NULL CHECK (timestamp >= 0),
  counter bigint NOT NULL CHECK (counter BETWEEN 0 AND 4294967295)
);
