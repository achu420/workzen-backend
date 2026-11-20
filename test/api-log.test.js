// The API log is for debugging, so it must stay readable and bounded: oversized bodies are cut, secrets are
// redacted, and the file rotates instead of growing for ever. Runs the real server as a child process because the log
// location and limits are process-level settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function withServer(env, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'appflowy-independent-log-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_FILE: path.join(dir, 'state.json'), API_LOG_FILE: path.join(dir, 'api.log'), ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const base = await new Promise((resolve, reject) => {
    let out = '';

    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /listening on (http:\/\/\S+)/.exec(out);

      if (match) resolve(match[1]);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });

  try {
    await run({ base, dir, logFile: path.join(dir, 'api.log') });
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

const post = (base, route, payload) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test('failed requests are logged with bodies cut to a readable size and secrets redacted', async () => {
  await withServer({}, async ({ base, logFile }) => {
    const response = await post(base, '/api/auth/login', { email: 'someone@example.test', password: 'hunter2-secret', note: 'x'.repeat(20_000) });

    assert.equal(response.status, 401);
    await settle();
    const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const entry = lines.find((line) => line.path === '/api/auth/login');

    assert.equal(entry.status, 401);
    assert.ok(JSON.stringify(entry).length < 9000, `line was ${JSON.stringify(entry).length} chars`);
    assert.match(entry.request_body, /\[truncated \d+ chars\]$/);
    assert.doesNotMatch(JSON.stringify(entry), /hunter2-secret/);
    assert.match(entry.request_body, /"password":"\[redacted\]"/);
  });
});

test('the log rotates at the size limit and keeps a bounded number of files', async () => {
  await withServer({ API_LOG_MAX_BYTES: '4000', API_LOG_KEEP: '3' }, async ({ base, dir }) => {
    for (let i = 0; i < 60; i += 1) await post(base, '/api/auth/login', { email: `user${i}@example.test`, password: 'x' });
    await settle();
    const files = (await readdir(dir)).filter((name) => name.startsWith('api.log')).sort();

    assert.deepEqual(files, ['api.log', 'api.log.1', 'api.log.2', 'api.log.3'].slice(0, files.length));
    assert.ok(files.length >= 3, `expected rotated files, got ${files}`);
    assert.ok(files.length <= 4, 'older files are dropped');
    for (const name of files) assert.ok((await readFile(path.join(dir, name), 'utf8')).length < 4000 + 2000, `${name} stays near the limit`);
  });
});
