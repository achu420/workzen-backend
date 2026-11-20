-- Workspace invite links (GET/POST/DELETE /api/workspace/{id}/invite-code,
-- POST /api/workspace/join-by-invite-code, GET /api/invite-code-info): one
-- active code per workspace, optionally expiring.
CREATE TABLE IF NOT EXISTS workspace_invite_codes (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz
);

-- Per-workspace member profile (PUT /api/workspace/{id}/update-member-profile):
-- name, avatar_url, cover_image_url, custom_image_url, description. Rides on the
-- existing membership row like recent_view_ids (migration 013).
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS profile jsonb;
