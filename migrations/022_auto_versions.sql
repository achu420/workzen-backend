-- Automatic document versions ("auto"): the server saves a snapshot after someone edits a page and goes quiet, so
-- history exists without anyone pressing "save version".
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'collab_versions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE collab_versions DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE collab_versions ADD CONSTRAINT collab_versions_kind_check CHECK (kind IN ('named', 'before_restore', 'auto'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
