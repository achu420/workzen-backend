-- Supports POST /api/workspace/{id}/add-recent-pages (AppFlowy-Web's
-- addRecentPages(), workspace-api.ts). Per-user, per-workspace list --
-- memberships already has that exact composite key, so this rides along
-- on the existing row rather than needing a new table.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS recent_view_ids jsonb;
