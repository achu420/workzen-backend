// Loads KEY=value lines from a private env file into process.env, without overriding anything already set.
// Looks for ENV_FILE, else ./.env next to where the server is started. Import this FIRST in server.js so that every
// later module sees the values. Comments (#) and blank lines are ignored; surrounding quotes are removed.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function parseEnv(text) {
  const values = {};

  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);

    if (!match || line.trimStart().startsWith('#')) continue;
    let value = match[2];

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export function loadEnvFile(file = process.env.ENV_FILE || path.resolve('.env'), env = process.env) {
  let text;

  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const loaded = [];

  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

// Test runs never read the private file, so a developer's real SMTP settings can't leak into a test.
if (!process.env.NODE_TEST_CONTEXT) loadEnvFile();
