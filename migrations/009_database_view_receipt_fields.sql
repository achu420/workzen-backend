-- Task 72 (follow-up within the same task): AppFlowy-Web's own atomic-
-- creation journal (journal.ts validateAtomicCreationReceipt, 'database-view'
-- case) requires the creation receipt to carry the same "diff update" shape
-- already used for row creation (database_update/update_batch_id) -- this
-- was discovered only by driving the real browser (the HTTP contract alone,
-- verified via AppFlowy-Web's own opt-in server-interop test, did not
-- surface it, since that test never exercises the client-side receipt
-- validator). Purely additive columns on the table migration 008 created
-- earlier in this same task; no data has been produced against the old
-- shape (only disposable, this-task test fixtures).
ALTER TABLE atomic_view_creation_requests ADD COLUMN IF NOT EXISTS database_update bytea;
ALTER TABLE atomic_view_creation_requests ADD COLUMN IF NOT EXISTS update_batch_id uuid;
