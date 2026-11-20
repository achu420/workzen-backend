#!/usr/bin/env node
// Creates three test accounts (owner, admin, member) sharing one workspace, so a fresh install can be signed into
// and checked without opening sign-up. Safe to run again: existing test accounts get their documented password and
// role back (and are signed out), nothing else is touched.
//
// Usage: node scripts/seed.mjs [--allow-production] [--lock]
//   (no flag)           create the accounts, or reset them to the passwords below
//   --lock              give the test accounts random passwords and sign them out (run when testing is finished)
//   --allow-production  required when NODE_ENV=production: the passwords below are public
//
// Reads STORAGE, DATABASE_URL and DATA_FILE like the server does. With STORAGE=json stop the server first: it keeps
// the state in memory and would overwrite what this script writes.
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { openStore } from '../storage.js';
import { hashPassword, id } from '../auth.js';

export const TEST_WORKSPACE_NAME = 'Workzen Test Workspace';
export const TEST_ACCOUNTS = [
  { email: 'owner@workzen.test', password: 'Owner#Test2026', name: 'Test Owner', role: 'owner' },
  { email: 'admin@workzen.test', password: 'Admin#Test2026', name: 'Test Admin', role: 'admin' },
  { email: 'member@workzen.test', password: 'Member#Test2026', name: 'Test Member', role: 'member' },
];

const args = process.argv.slice(2);
const lock = args.includes('--lock');
const storage = process.env.STORAGE || 'json';
const dataFile = path.resolve(process.env.DATA_FILE || './data/appflowy-independent.json');
const now = () => new Date().toISOString();

if (process.env.NODE_ENV === 'production' && !lock && !args.includes('--allow-production')) {
  console.error('NODE_ENV=production: these test passwords are published in the deployment guide.');
  console.error('Re-run with --allow-production if you really want them on this server, and run --lock when done.');
  process.exit(1);
}

const store = await openStore(dataFile, { storage, databaseUrl: process.env.DATABASE_URL });

async function seed() {
  const [ownerAccount, ...otherAccounts] = TEST_ACCOUNTS;
  const created = [];

  // Same shape as POST /signup in server.js, so the web app treats these exactly like self-registered people.
  async function ensureUser(account, workspace) {
    const existing = await store.findUserByEmail(account.email);
    const passwordHash = await hashPassword(account.password);

    if (existing) {
      await store.updateUserPassword(existing.id, passwordHash);
      await store.updateUserProfile(existing.id, { name: account.name });
      return existing;
    }
    const user = { id: id(), uid: randomInt(1, 2 ** 48), email: account.email, password_hash: passwordHash, created_at: now() };

    if (workspace) {
      workspace.owner_id = user.id;
      await store.createUserWithWorkspace(user, workspace, { workspace_id: workspace.id, user_id: user.id, role: 'owner', created_at: now() });
    } else {
      await store.saveUser(user);
    }
    await store.updateUserProfile(user.id, { name: account.name });
    created.push(account.email);
    return user;
  }

  const newWorkspace = () => ({ id: id(), name: TEST_WORKSPACE_NAME, icon: '', database_storage_id: id(), created_at: now(), owner_id: null });
  const ownerExisted = Boolean(await store.findUserByEmail(ownerAccount.email));
  const owner = await ensureUser(ownerAccount, ownerExisted ? null : newWorkspace());
  let workspace = (await store.listWorkspaces(owner.id)).find((w) => w.name === TEST_WORKSPACE_NAME && w.owner_id === owner.id);

  if (!workspace) {
    workspace = { ...newWorkspace(), owner_id: owner.id };
    await store.createWorkspace(workspace, { workspace_id: workspace.id, user_id: owner.id, role: 'owner', created_at: now() });
  }
  for (const account of otherAccounts) {
    const user = await ensureUser(account, null);
    const membership = await store.getMembership(workspace.id, user.id);

    await store.saveMembership({ workspace_id: workspace.id, user_id: user.id, role: account.role, created_at: membership?.created_at ?? now() });
  }

  console.log(`Workspace "${TEST_WORKSPACE_NAME}": ${workspace.id}`);
  for (const account of TEST_ACCOUNTS) {
    const state = created.includes(account.email) ? 'created' : 'reset';

    console.log(`  ${account.role.padEnd(6)}  ${account.email.padEnd(20)}  ${account.password.padEnd(16)}(${state})`);
  }
  if (process.env.NODE_ENV === 'production') console.log('When testing is finished run: node scripts/seed.mjs --lock');
}

async function lockAccounts() {
  for (const account of TEST_ACCOUNTS) {
    const user = await store.findUserByEmail(account.email);

    if (!user) { console.log(`  ${account.email}: not present`); continue; }
    await store.updateUserPassword(user.id, await hashPassword(randomBytes(32).toString('base64url')));
    console.log(`  ${account.email}: locked (random password, signed out)`);
  }
}

try {
  if (lock) await lockAccounts();
  else await seed();
} catch (error) {
  console.error(`Seeding failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await store.close?.();
}
process.exit(process.exitCode ?? 0);
