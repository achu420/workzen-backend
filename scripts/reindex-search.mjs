#!/usr/bin/env node
// Rebuilds the workspace search index from current pages, documents and database rows.
//
// Usage: node scripts/reindex-search.mjs [--data-file <path>] [--storage json|postgres]
//   --data-file  JSON state file (default: $DATA_FILE or ./data/appflowy-independent.json)
//   --storage    json (default: $STORAGE or json) or postgres (uses $DATABASE_URL)
//
// With STORAGE=postgres the index is a table (search_documents), so this repairs or
// seeds it. In JSON mode the index only lives in server memory and is rebuilt on every
// start, so this is a dry run that reports what would be indexed.
import path from 'node:path';
import { openStore } from '../storage.js';
import { createSearchIndex } from '../search-index.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  return out;
}

const args = parseArgs(process.argv.slice(2));
const storage = args.storage || process.env.STORAGE || 'json';
const dataFile = path.resolve(args['data-file'] || process.env.DATA_FILE || './data/appflowy-independent.json');
const errors = [];
const store = await openStore(dataFile, { storage, databaseUrl: process.env.DATABASE_URL });
const index = createSearchIndex(store, { delayMs: 0, onError: (error) => errors.push(error) });

await index.backfill();
for (const workspaceId of await store.listWorkspaceIds()) {
  const refs = await store.listSearchDocumentRefs(workspaceId);
  const pages = refs.filter((ref) => ref.kind === 'page').length;

  console.log(`${workspaceId}: ${pages} pages, ${refs.length - pages} database rows indexed`);
}
if (storage === 'json') console.log('JSON mode keeps the index in memory only; the server rebuilds it on start.');
if (errors.length) {
  console.error(`${errors.length} object(s) could not be indexed; first error:`, errors[0]);
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
