-- Supports POST /api/user/update (AppFlowy-Web's updateUserProfile(),
-- user-api.ts) -- lets a user set their display name and arbitrary
-- profile metadata (e.g. metadata.icon_url, read back by getCurrentUser()
-- as `avatar`). Previously missing entirely: GET /api/user/profile already
-- read user.name/user.metadata defensively (`?? null`/`?? {}`), but nothing
-- ever wrote them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS metadata jsonb;
