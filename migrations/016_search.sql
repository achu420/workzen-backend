-- Workspace search index (GET /api/search/{ws}/page, POST .../mentions/search).
-- One row per searchable object: a page (title + extracted body text) or a
-- database row (primary cell as title, all cell text as content). Maintained by
-- search-index.js; permissions are applied at query time, not stored here.
CREATE TABLE IF NOT EXISTS search_documents (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('page', 'row')),
  view_id uuid,
  database_id uuid,
  database_view_id uuid,
  database_row_id uuid,
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, object_id)
);
CREATE INDEX IF NOT EXISTS search_documents_database_idx ON search_documents(workspace_id, database_id) WHERE database_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS search_documents_fts_idx ON search_documents USING GIN (to_tsvector('simple', title || ' ' || content));
