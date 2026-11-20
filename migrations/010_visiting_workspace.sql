-- Supports PUT /api/workspace/{id}/open (AppFlowy-Web's workspace-api.ts
-- openWorkspace(), called by the workspace switcher immediately after
-- switching to or creating a workspace). Tracks which workspace a user most
-- recently opened so GET /api/user/workspace's visiting_workspace reflects
-- the switch instead of always reporting the user's first-ever workspace.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS last_visited_at timestamptz;
