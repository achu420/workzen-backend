// Backup and restore of everything this server keeps: the database (PostgreSQL dump, or the JSON state file), uploaded
// files, and the AI key secret. One .tar.gz per backup with a manifest of SHA-256 checksums that restore verifies
// before touching anything. Uses the system `tar`, and `pg_dump` / `pg_restore` for PostgreSQL.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ARCHIVE_PATTERN = /^backup-\d{8}-\d{6}\.tar\.gz$/;
const FORMAT = 1;

export async function sha256File(file) {
  const hash = createHash('sha256');

  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(target) {
  return stat(target).then(() => true, () => false);
}

async function listFiles(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(root, entry.name);

    if (entry.isDirectory()) files.push(...await listFiles(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files.sort();
}

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/**
 * @param {object} o
 * @param {string} o.outDir where the archive goes
 * @param {'json'|'postgres'} o.storage
 * @param {string} [o.databaseUrl] postgres only
 * @param {string} [o.dataFile] json only
 * @param {string} [o.filesDir] uploaded files (skipped when it does not exist)
 * @param {string} [o.secretFile] AI key secret file (skipped when the secret comes from AI_KEY_SECRET)
 * @param {number} [o.keep] keep only this many newest archives in outDir
 * @param {string} [o.pgBin] directory holding pg_dump
 */
export async function createBackup({ outDir, storage, databaseUrl, dataFile, filesDir, secretFile, keep = 0, now = new Date(), pgBin = '' }) {
  await mkdir(outDir, { recursive: true });
  const stage = await mkdtemp(path.join(os.tmpdir(), 'appflowy-backup-'));

  try {
    if (storage === 'postgres') {
      if (!databaseUrl) throw new Error('DATABASE_URL is required for a PostgreSQL backup');
      await run(path.join(pgBin, 'pg_dump'), ['--format=custom', '--no-owner', '--file', path.join(stage, 'db.dump'), '--dbname', databaseUrl], { maxBuffer: 1 << 26 });
    } else {
      if (!dataFile || !(await exists(dataFile))) throw new Error(`State file not found: ${dataFile}`);
      await copyFile(dataFile, path.join(stage, 'state.json'));
    }
    if (filesDir && await exists(filesDir)) await cp(filesDir, path.join(stage, 'files'), { recursive: true });
    if (secretFile && await exists(secretFile)) await copyFile(secretFile, path.join(stage, 'ai-key-secret'));
    const names = await listFiles(stage);
    const files = [];

    for (const name of names) files.push({ name, size: (await stat(path.join(stage, name))).size, sha256: await sha256File(path.join(stage, name)) });
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({ app: 'appflowy-independent', format: FORMAT, created_at: now.toISOString(), storage, files }, null, 2));
    const archive = path.join(outDir, `backup-${stamp(now)}.tar.gz`);

    await run('tar', ['-czf', archive, '-C', stage, '.']);
    await chmod(archive, 0o600);
    const removed = keep > 0 ? await prune(outDir, keep) : [];

    return { archive, storage, files: files.length, bytes: (await stat(archive)).size, removed };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function prune(outDir, keep) {
  const archives = (await readdir(outDir)).filter((name) => ARCHIVE_PATTERN.test(name)).sort();
  const old = archives.slice(0, Math.max(0, archives.length - keep));

  for (const name of old) await rm(path.join(outDir, name));
  return old;
}

/** Reads and verifies a backup without restoring it. Returns the extracted staging directory and manifest. */
export async function openBackup(archive) {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'appflowy-restore-'));

  try {
    await run('tar', ['-xzf', archive, '-C', stage]);
    const manifest = JSON.parse(await readFile(path.join(stage, 'manifest.json'), 'utf8'));

    if (manifest.app !== 'appflowy-independent' || manifest.format !== FORMAT) throw new Error('This is not a backup made by this tool');
    for (const file of manifest.files) {
      const full = path.join(stage, file.name);

      if (file.name.includes('..') || path.isAbsolute(file.name)) throw new Error(`Unsafe path in backup: ${file.name}`);
      if (!(await exists(full))) throw new Error(`Backup is missing ${file.name}`);
      if (await sha256File(full) !== file.sha256) throw new Error(`Checksum mismatch for ${file.name}: the backup is corrupt`);
    }
    return { stage, manifest };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Restores a verified backup over the given targets. Nothing is changed unless `confirm` is true, and the archive is
 * verified first. Stop the server before restoring. For PostgreSQL the target database must already exist.
 */
export async function restoreBackup({ archive, confirm = false, databaseUrl, dataFile, filesDir, secretFile, pgBin = '' }) {
  const { stage, manifest } = await openBackup(archive);

  try {
    if (!confirm) return { restored: false, manifest, reason: 'Pass confirm to overwrite the current data' };
    if (manifest.storage === 'postgres') {
      if (!databaseUrl) throw new Error('DATABASE_URL is required to restore a PostgreSQL backup');
      await run(path.join(pgBin, 'pg_restore'), ['--clean', '--if-exists', '--no-owner', '--exit-on-error', '--dbname', databaseUrl, path.join(stage, 'db.dump')], { maxBuffer: 1 << 26 });
    } else {
      if (!dataFile) throw new Error('DATA_FILE is required to restore a JSON backup');
      await mkdir(path.dirname(dataFile), { recursive: true });
      const next = `${dataFile}.restore-${process.pid}`;

      await copyFile(path.join(stage, 'state.json'), next);
      await chmod(next, 0o600);
      await rename(next, dataFile);
    }
    if (await exists(path.join(stage, 'files')) && filesDir) {
      await rm(filesDir, { recursive: true, force: true });
      await cp(path.join(stage, 'files'), filesDir, { recursive: true });
    }
    if (await exists(path.join(stage, 'ai-key-secret')) && secretFile) {
      await mkdir(path.dirname(secretFile), { recursive: true });
      await copyFile(path.join(stage, 'ai-key-secret'), secretFile);
      await chmod(secretFile, 0o600);
    }
    return { restored: true, manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** The same locations the server uses, derived from the same environment variables. */
export function locationsFromEnv(env = process.env) {
  const dataFile = path.resolve(env.DATA_FILE || './data/appflowy-independent.json');

  return {
    storage: env.STORAGE === 'postgres' ? 'postgres' : 'json',
    databaseUrl: env.DATABASE_URL,
    dataFile,
    filesDir: path.resolve(env.FILE_STORAGE_DIR || path.join(path.dirname(dataFile), 'files')),
    secretFile: env.AI_KEY_SECRET ? undefined : path.join(path.dirname(dataFile), '.ai-key-secret'),
    pgBin: env.PG_BIN || '',
  };
}
