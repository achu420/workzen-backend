import { spawn, ChildProcess } from 'child_process';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Task 69 test-environment lifecycle helper.
 *
 * Every real-browser E2E run needs: a disposable backend (own port, own
 * JSON data file), a disposable frontend dev server pointed at it (via a
 * temporarily-rewritten `AppFlowy-Web/.env.local`, backed up/restored
 * byte-for-byte with an MD5 check), and teardown that stops ONLY the
 * processes this helper started -- never anything already listening on a
 * "familiar" port. This mirrors the discipline already proven correct in
 * the Task 66/67/68 evidence scripts, productized into a reusable helper
 * instead of being re-implemented ad hoc per script.
 */

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const FRONTEND_DIR = path.resolve(BACKEND_DIR, '..', 'AppFlowy-Web');
const ENV_LOCAL_PATH = path.join(FRONTEND_DIR, '.env.local');

/**
 * Task 77.2 hardening (recommended by the Task 77.1 report, §11.1a).
 *
 * `startTestEnvironment` rewrites `.env.local` and `stopTestEnvironment`
 * restores it from a per-run backup in that run's evidence dir. When a
 * Playwright worker is killed before teardown, the restore never runs and
 * `.env.local` is left pointing at a now-dead disposable test backend. The
 * NEXT run then backed up that already-poisoned file as its "original" and
 * restored it faithfully -- permanently losing the user's real config. Task
 * 77.1 hit exactly this and had to reconstruct the value by hand from older
 * evidence backups.
 *
 * The fix: keep ONE canonical pristine copy outside any per-run directory,
 * written only from a config that does not itself look like a disposable
 * test config, and prefer it whenever the live file looks poisoned. If the
 * live file looks poisoned and no pristine copy exists, fail loudly rather
 * than silently canonizing a dead port.
 */
const PRISTINE_ENV_BACKUP_PATH = path.join(__dirname, '.env.local.pristine');

/**
 * A disposable backend always listens on 127.0.0.1 in the 19000-19499 range
 * (see findFreePort below), which a real developer config never points at.
 */
function looksLikeDisposableTestConfig(content: string): boolean {
  return /APPFLOWY_BASE_URL=\s*(?:http:\/\/)?(?:127\.0\.0\.1|localhost):19\d{3}/.test(content);
}

/**
 * Resolves the authoritative pre-test `.env.local` contents and keeps the
 * canonical pristine copy up to date. Returns the bytes that teardown must
 * restore.
 */
async function resolveOriginalEnvLocal(): Promise<Buffer> {
  const live = await readFile(ENV_LOCAL_PATH);
  let pristine: Buffer | null = null;
  try {
    pristine = await readFile(PRISTINE_ENV_BACKUP_PATH);
  } catch {
    pristine = null;
  }

  if (looksLikeDisposableTestConfig(live.toString())) {
    if (!pristine) {
      throw new Error(
        `AppFlowy-Web/.env.local points at a disposable test backend and no pristine backup exists at ` +
          `${PRISTINE_ENV_BACKUP_PATH}. A previous test run was very likely killed before teardown. ` +
          `Restore .env.local to the real development configuration by hand before running E2E tests, ` +
          `so it can be canonized safely.`,
      );
    }
    // The live file is a leftover from a killed run; the pristine copy wins.
    await writeFile(ENV_LOCAL_PATH, pristine);
    return pristine;
  }

  // The live file is a genuine config -- (re)canonize it.
  if (!pristine || md5(pristine) !== md5(live)) {
    await writeFile(PRISTINE_ENV_BACKUP_PATH, live);
  }
  return live;
}

export interface TestEnvironment {
  backendPort: number;
  frontendPort: number;
  backendUrl: string;
  frontendUrl: string;
  dataFile: string;
  devKey: string;
  backendProcess: ChildProcess;
  frontendProcess: ChildProcess;
  envBackupMd5: string;
  evidenceDir: string;
  storage: 'json' | 'postgres';
  databaseUrl?: string;
}

function md5(buf: Buffer | string): string {
  return createHash('md5').update(buf).digest('hex');
}

async function findFreePort(startFrom: number): Promise<number> {
  for (let port = startFrom; port < startFrom + 500; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`No free port found starting at ${startFrom}`);
}

async function waitHealthy(url: string, attempts = 30): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitFrontendReady(url: string, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 304) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function startTestEnvironment(
  evidenceDir: string,
  label = 'task69',
  options: { storage?: 'json' | 'postgres'; databaseUrl?: string } = {},
): Promise<TestEnvironment> {
  const backendPort = await findFreePort(19000 + Math.floor(Math.random() * 500));
  const frontendPort = await findFreePort(14000 + Math.floor(Math.random() * 500));
  const devKey = `${label}-dev-key`;
  const tmpDir = await mkdtemp(path.join(tmpdir(), `appflowy-${label}-`));
  const dataFile = path.join(tmpDir, 'data.json');
  const storage = options.storage ?? 'json';

  // Task 77.2: resolve the authoritative original (and keep the canonical
  // pristine copy current) instead of trusting whatever the live file holds,
  // which a previously-killed worker may have left pointing at a dead port.
  const original = await resolveOriginalEnvLocal();
  const envBackupMd5 = md5(original);
  await writeFile(path.join(evidenceDir, 'env.local.backup'), original);

  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://localhost:${frontendPort}`;

  const envContent =
    [
      `APPFLOWY_BASE_URL=${backendUrl}`,
      `APPFLOWY_GOTRUE_BASE_URL=${backendUrl}`,
      `APPFLOWY_WS_BASE_URL=ws://127.0.0.1:${backendPort}/ws/v2`,
    ].join('\n') + '\n';
  await writeFile(ENV_LOCAL_PATH, envContent);

  const backendProcess = spawn('node', ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(backendPort),
      STORAGE: storage,
      DATA_FILE: dataFile,
      ...(storage === 'postgres' ? { DATABASE_URL: options.databaseUrl } : {}),
      DEV_TEST_KEY: devKey,
      CORS_ALLOWED_ORIGINS: `http://localhost:${frontendPort},http://127.0.0.1:${frontendPort}`,
    },
    stdio: 'ignore',
  });

  const backendHealthy = await waitHealthy(backendUrl);
  if (!backendHealthy) {
    backendProcess.kill();
    throw new Error(`Backend did not become healthy on port ${backendPort}`);
  }

  const frontendProcess = spawn('node_modules/.bin/vite', ['--port', String(frontendPort), '--strictPort'], {
    cwd: FRONTEND_DIR,
    env: { ...process.env, PORT: String(frontendPort) },
    stdio: 'ignore',
  });

  const frontendReady = await waitFrontendReady(frontendUrl);
  if (!frontendReady) {
    backendProcess.kill();
    frontendProcess.kill();
    throw new Error(`Frontend did not become ready on port ${frontendPort}`);
  }

  return {
    backendPort,
    frontendPort,
    backendUrl,
    frontendUrl,
    dataFile,
    devKey,
    backendProcess,
    frontendProcess,
    envBackupMd5,
    evidenceDir,
    storage,
    databaseUrl: options.databaseUrl,
  };
}

/**
 * Task 77.3 hardening.
 *
 * Found live in this task: a plain `childProcess.kill()` (SIGTERM) on the
 * disposable backend/vite processes this helper spawns reliably leaves them
 * running during a REAL end-to-end Playwright run -- confirmed by 12/12 of
 * this task's own full-suite runs each leaking exactly the 2 processes they
 * started (verified via `ps`, well after the run's own `npx playwright
 * test` CLI process had exited), even though an isolated spawn+kill() of
 * the same commands in a standalone Node script terminates immediately.
 * Left running, these accumulate real memory/CPU pressure across a working
 * session (this task observed 150+ matching processes and heavy swap
 * compression at its worst), which is itself a plausible contributor to
 * backgrounded-tab interaction flakiness in later tests (see
 * ensureGridInteractive in the Task 77.1 spec). Never diagnosed exactly WHY
 * SIGTERM alone doesn't take effect in-process (no SIGTERM/SIGINT handler
 * exists in server.js, so this is not a graceful-shutdown hang); the
 * pragmatic, safe fix is to confirm death and escalate to SIGKILL rather
 * than trust a single signal silently "worked".
 */
async function killConfirmed(proc: ChildProcess, graceMs = 1500): Promise<void> {
  if (proc.pid == null) return;
  const isAlive = () => {
    try {
      process.kill(proc.pid as number, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    proc.kill('SIGTERM');
  } catch {
    /* already exited */
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isAlive()) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isAlive()) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
}

export async function stopTestEnvironment(env: TestEnvironment): Promise<{ envRestored: boolean }> {
  // Stop ONLY the two processes this helper started -- confirmed dead, not
  // merely signaled (see killConfirmed's comment).
  await killConfirmed(env.backendProcess);
  await killConfirmed(env.frontendProcess);

  await copyFile(path.join(env.evidenceDir, 'env.local.backup'), ENV_LOCAL_PATH);
  const restored = await readFile(ENV_LOCAL_PATH);
  const envRestored = md5(restored) === env.envBackupMd5;

  try {
    await rm(path.dirname(env.dataFile), { recursive: true, force: true });
  } catch {
    /* best-effort cleanup of disposable temp dir */
  }

  return { envRestored };
}

/**
 * Task 70 addition: stop ONLY the test-owned backend process and start a
 * brand-new one against the SAME port and SAME disposable data file (or
 * same DATABASE_URL in Postgres mode, if ever wired up here), to exercise
 * a genuine process-boundary restart as a test fixture -- mirroring the
 * discipline already proven in test/collaboration-recovery.test.js (real
 * `server.close()` + fresh `startServer()`) and in the Task 68/69 browser
 * evidence scripts (docs/task69-evidence/task68-scenario-b-reverify.mjs),
 * now folded into the reusable helper instead of re-implemented ad hoc.
 * Mutates and returns the SAME TestEnvironment object with a fresh
 * `backendProcess`.
 */
export async function restartBackend(env: TestEnvironment): Promise<TestEnvironment> {
  await killConfirmed(env.backendProcess);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const backendProcess = spawn('node', ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(env.backendPort),
      STORAGE: env.storage,
      DATA_FILE: env.dataFile,
      ...(env.storage === 'postgres' ? { DATABASE_URL: env.databaseUrl } : {}),
      DEV_TEST_KEY: env.devKey,
      CORS_ALLOWED_ORIGINS: `http://localhost:${env.frontendPort},http://127.0.0.1:${env.frontendPort}`,
    },
    stdio: 'ignore',
  });

  const healthy = await waitHealthy(env.backendUrl);
  if (!healthy) {
    backendProcess.kill();
    throw new Error(`Restarted backend did not become healthy on port ${env.backendPort}`);
  }

  env.backendProcess = backendProcess;
  return env;
}

export async function registerTestUser(env: TestEnvironment, emailPrefix: string, password: string): Promise<string> {
  const email = `${emailPrefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const resp = await fetch(`${env.backendUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (resp.status !== 201) {
    throw new Error(`Registration failed for ${email}: ${resp.status} ${await resp.text()}`);
  }
  return email;
}
