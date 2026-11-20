#!/usr/bin/env node
// Usage: node scripts/backup.mjs [--out ./backups] [--keep 14]
// Reads STORAGE, DATABASE_URL, DATA_FILE, FILE_STORAGE_DIR, AI_KEY_SECRET (and PG_BIN for pg_dump) like the server does.
import { createBackup, locationsFromEnv } from './backup-lib.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

try {
  const locations = locationsFromEnv();
  const result = await createBackup({ ...locations, outDir: option('--out', './backups'), keep: Number(option('--keep', 0)) });

  console.log(`Backup written: ${result.archive} (${result.files} files, ${result.bytes} bytes, ${result.storage})`);
  if (result.removed.length) console.log(`Removed old backups: ${result.removed.join(', ')}`);
  if (process.env.AI_KEY_SECRET) console.log('Note: AI_KEY_SECRET comes from the environment and is NOT in this backup. Store it separately.');
} catch (error) {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
}
