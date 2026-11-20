#!/usr/bin/env node
// Usage: node scripts/restore.mjs <backup.tar.gz> [--yes]
// Without --yes it only verifies the archive and says what it holds. STOP THE SERVER before restoring.
import { locationsFromEnv, restoreBackup } from './backup-lib.mjs';

const [archive, ...rest] = process.argv.slice(2);

if (!archive) {
  console.error('Usage: node scripts/restore.mjs <backup.tar.gz> [--yes]');
  process.exit(2);
}
try {
  const result = await restoreBackup({ ...locationsFromEnv(), archive, confirm: rest.includes('--yes') });
  const { manifest } = result;

  console.log(`Backup verified: ${manifest.files.length} files, ${manifest.storage}, taken ${manifest.created_at}`);
  console.log(result.restored ? 'Restored. Start the server again.' : 'Nothing changed. Re-run with --yes to restore over the current data (stop the server first).');
} catch (error) {
  console.error(`Restore failed: ${error.message}`);
  process.exit(1);
}
