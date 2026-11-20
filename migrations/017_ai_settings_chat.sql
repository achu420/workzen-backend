-- Bring-your-own-key AI: per-workspace provider settings (the API key is stored
-- encrypted, AES-256-GCM, never in clear text) and persisted AI chats.
CREATE TABLE IF NOT EXISTS ai_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  key_enc jsonb,
  model text,
  enabled_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL,
  updated_by uuid
);

CREATE TABLE IF NOT EXISTS ai_chats (
  chat_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  rag_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  full_workspace boolean NOT NULL DEFAULT false,
  web_search_enabled boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_chats_workspace_idx ON ai_chats(workspace_id);

CREATE SEQUENCE IF NOT EXISTS ai_chat_message_id_seq;
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  message_id bigint PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES ai_chats(chat_id) ON DELETE CASCADE,
  author_type integer NOT NULL,
  author_uuid text NOT NULL DEFAULT '',
  content text NOT NULL,
  reply_message_id bigint,
  meta_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_chat_messages_chat_idx ON ai_chat_messages(chat_id, message_id);
