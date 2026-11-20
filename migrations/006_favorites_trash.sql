-- Task 53: back the favorite/trash sidebar endpoints with real page state.
-- is_favorite already exists (migration 002) but was never read or written by
-- any route; this adds the remaining fields needed for both features and for
-- honest round-tripping of favorited_at / trashed_at timestamps.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS is_pinned boolean NOT NULL DEFAULT true;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS favorited_at timestamptz;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS is_trashed boolean NOT NULL DEFAULT false;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
CREATE INDEX IF NOT EXISTS pages_workspace_favorite_idx ON pages(workspace_id, is_favorite) WHERE is_favorite;
CREATE INDEX IF NOT EXISTS pages_workspace_trashed_idx ON pages(workspace_id, is_trashed) WHERE is_trashed;
