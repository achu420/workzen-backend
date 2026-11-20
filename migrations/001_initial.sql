CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  uid bigint NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE SEQUENCE IF NOT EXISTS users_uid_migration_seq;
ALTER TABLE users ADD COLUMN IF NOT EXISTS uid bigint;
UPDATE users SET uid = nextval('users_uid_migration_seq') WHERE uid IS NULL;
ALTER TABLE users ALTER COLUMN uid SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_uid_idx ON users(uid);
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  icon text NOT NULL DEFAULT '',
  database_storage_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id)
);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT '';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS database_storage_id uuid;
UPDATE workspaces SET database_storage_id = id WHERE database_storage_id IS NULL;
ALTER TABLE workspaces ALTER COLUMN database_storage_id SET NOT NULL;
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS pages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  document jsonb NOT NULL,
  schema_version text NOT NULL,
  creator_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
DO $$
BEGIN
  ALTER TABLE pages ADD CONSTRAINT pages_id_workspace_key UNIQUE (id, workspace_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  refresh_token_hash text,
  refresh_expires_at timestamptz
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refresh_token_hash text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refresh_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
CREATE INDEX IF NOT EXISTS pages_workspace_idx ON pages(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_token_hash_idx ON sessions(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE workspaces ADD CONSTRAINT workspaces_id_database_storage_key UNIQUE (id, database_storage_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS workspace_database_collabs (
  workspace_id uuid PRIMARY KEY,
  object_id uuid NOT NULL,
  doc_state bytea NOT NULL,
  FOREIGN KEY (workspace_id, object_id)
    REFERENCES workspaces(id, database_storage_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collab_documents (
  workspace_id uuid NOT NULL,
  page_id uuid NOT NULL,
  collab_version text NOT NULL,
  restore_id text,
  document_state bytea NOT NULL,
  state_vector bytea NOT NULL,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, page_id),
  FOREIGN KEY (page_id, workspace_id) REFERENCES pages(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collab_updates (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  page_id uuid NOT NULL,
  payload_digest text NOT NULL,
  message_key text,
  flags integer NOT NULL CHECK (flags IN (0, 1)),
  payload bytea NOT NULL,
  before_state_vector bytea,
  collab_version text NOT NULL,
  restore_id text,
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id, page_id, payload_digest),
  UNIQUE (workspace_id, page_id, message_key),
  FOREIGN KEY (page_id, workspace_id) REFERENCES pages(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS collab_updates_page_idx ON collab_updates(workspace_id, page_id, id);
