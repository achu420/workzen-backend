#!/usr/bin/env node
// One-off importer for an AppFlowy workspace export (the shape produced by
// AppFlowy's own "export workspace" feature: metadata.json/relation_map.json
// plus collab_jsons/{documents,databases}/*.json) into this backend's JSON
// storage file, as a brand-new workspace owned by an existing user.
//
// This exists because "Import workspace -> Import from AppFlowy" (the
// official self-hosted Templates Store workflow) needs a presigned-upload +
// async-job pipeline this backend has never implemented. Given an already
// *unzipped* export on disk, this script skips that whole pipeline and
// inserts the resulting pages/databases/rows/documents directly into the
// store, by hand-building the same Yjs collab shapes the rest of this
// codebase already builds for organic (HTTP-driven) creation -- see
// page-document.js, database-document.js, database-row-document.js.
//
// Usage:
//   node scripts/import-template-workspace.mjs --user <email> --export <dir> [--workspace-name "Templates"] [--data-file <path>]
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { openStore, mutate } from '../storage.js';
import { createInitialPageCollab, pageIdFromDocumentId, rowDocumentIdFromRowId } from '../page-document.js';
import { createInitialDatabaseRowCollab } from '../database-row-document.js';
import { buildDatabaseCollabFromTemplate } from '../database-template-builder.js';
import { buildDocumentCollabFromTemplate } from '../document-template-builder.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      out[key] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const SUPPORTED_SPACE_PERMISSION = Object.freeze({
  visibility: 'public',
  owner_access_level: 50,
  member_default_access_level: 30,
  everyone_else_access_level: null,
  invite_policy: 'owners_only',
  sidebar_edit_policy: 'owners_only',
  invite_link_enabled: false,
  security: { disable_guests: false, disable_public_links: false, disable_export: false },
});

// Folder-side ViewLayout -> Database-internal DatabaseViewLayout, the
// inverse of database-document.js's own FOLDER_LAYOUTS mapping. Not needed
// in this script (the export's database-json view.layout values are already
// DatabaseViewLayout-numbered -- verified directly against the export), kept
// only for documentation of that fact.
// const FOLDER_TO_DB_LAYOUT = { 1: 0, 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7, 10: 8 };

async function loadJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userEmail = args.user;
  const exportDir = args.export;
  const workspaceName = args['workspace-name'] || 'Templates';
  const dataFile = args['data-file'] ? path.resolve(args['data-file']) : undefined;

  if (!userEmail || !exportDir) {
    console.error('Usage: node scripts/import-template-workspace.mjs --user <email> --export <dir> [--workspace-name "Templates"] [--data-file <path>]');
    process.exit(1);
  }

  const resolvedExportDir = path.resolve(exportDir);
  const relationMap = await loadJsonIfExists(path.join(resolvedExportDir, 'relation_map.json'));
  if (!relationMap) {
    console.error(`No relation_map.json found under ${resolvedExportDir}`);
    process.exit(1);
  }

  const store = await openStore(dataFile || path.resolve(process.env.DATA_FILE || './data/appflowy-independent.json'), {
    storage: process.env.STORAGE || 'json',
    databaseUrl: process.env.DATABASE_URL,
  });

  const user = await store.getUserByEmail(userEmail);
  if (!user) {
    console.error(`No user found with email ${userEmail}`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const views = relationMap.views || {};
  const workspaceOldId = relationMap.workspace_id;

  // --- Pass 1: assign new ids for every view, up front, so parent lookups
  // never depend on processing order. ---
  const newWorkspaceId = randomUUID();
  const viewIdMap = new Map(); // old view_id -> new id (space id or page id)
  for (const oldId of Object.keys(views)) viewIdMap.set(oldId, randomUUID());
  const resolveParent = (oldParentId) => (oldParentId === workspaceOldId ? newWorkspaceId : (viewIdMap.get(oldParentId) ?? newWorkspaceId));

  // --- Pass 2: load every collab_jsons/databases/*.json once, deduped by
  // database_id (the export duplicates the same database body once per
  // view_id filename -- confirmed during discovery). ---
  const databasesDir = path.join(resolvedExportDir, 'collab_jsons', 'databases');
  const { readdir } = await import('node:fs/promises');
  let databaseFiles;
  try { databaseFiles = await readdir(databasesDir); } catch { databaseFiles = []; }
  const databaseByOldId = new Map(); // old database_id -> parsed json
  for (const file of databaseFiles) {
    const json = await loadJsonIfExists(path.join(databasesDir, file));
    if (json && json.database_id && !databaseByOldId.has(json.database_id)) databaseByOldId.set(json.database_id, json);
  }
  const databaseIdMap = new Map(); // old database_id -> new id
  for (const oldDatabaseId of databaseByOldId.keys()) databaseIdMap.set(oldDatabaseId, randomUUID());

  // old row_id -> new row_id, across every database.
  const rowIdMap = new Map();
  for (const json of databaseByOldId.values()) {
    for (const row of json.rows || []) rowIdMap.set(row.id, randomUUID());
  }

  const summary = {
    spaces: 0, documentPages: 0, databaseContainers: 0, databaseViews: 0, databases: 0, rows: 0,
    rowDocuments: 0, skippedRowDocuments: 0, skippedViewsNoHandler: 0,
  };

  await mutate(store, (s) => {
    // Workspace + ownership.
    s.workspaces[newWorkspaceId] = {
      id: newWorkspaceId,
      name: workspaceName,
      icon: '',
      database_storage_id: randomUUID(),
      created_at: timestamp,
      owner_id: user.id,
    };
    s.memberships[`${newWorkspaceId}:${user.id}`] = {
      workspace_id: newWorkspaceId,
      user_id: user.id,
      role: 'owner',
      created_at: timestamp,
    };

    // --- Spaces (top-level views with extra.is_space === true) ---
    for (const [oldId, view] of Object.entries(views)) {
      let extra = null;
      try { extra = view.extra ? JSON.parse(view.extra) : null; } catch { extra = null; }
      if (!extra || extra.is_space !== true) continue;
      const newId = viewIdMap.get(oldId);
      s.spaces[newId] = {
        id: newId,
        workspace_id: newWorkspaceId,
        name: view.name,
        space_icon: extra.space_icon ?? '',
        space_icon_color: extra.space_icon_color ?? '',
        permission: SUPPORTED_SPACE_PERMISSION,
        creator_id: user.id,
        created_at: timestamp,
      };
      summary.spaces += 1;
    }

    // --- Databases: build each Yjs collab once per unique database_id. ---
    for (const [oldDatabaseId, json] of databaseByOldId.entries()) {
      const newDatabaseId = databaseIdMap.get(oldDatabaseId);
      const built = buildDatabaseCollabFromTemplate({ databaseId: newDatabaseId, template: json, viewIdMap, rowIdMap, timestamp });
      s.databaseCollabDocuments[newDatabaseId] = {
        workspace_id: newWorkspaceId,
        database_id: newDatabaseId,
        collab_version: built.collabVersion,
        restore_id: null,
        document_state: Array.from(built.documentState),
        state_vector: Array.from(built.stateVector),
        generation: 0,
        last_message_id: { timestamp: 0, counter: 0 },
        updated_at: timestamp,
      };
      summary.databases += 1;

      // Rows: each row is its own DatabaseRow collab object, independent of
      // the Database collab's row_orders (already populated above).
      for (const row of json.rows || []) {
        const newRowId = rowIdMap.get(row.id);
        const rowCollab = createInitialDatabaseRowCollab({
          rowId: newRowId,
          databaseId: newDatabaseId,
          cells: row.cells || {},
          height: row.height ?? 36,
          visibility: row.visibility !== false,
          timestamp,
          actorUid: user.uid,
        });
        s.databaseRowCollabDocuments[newRowId] = {
          workspace_id: newWorkspaceId,
          database_id: newDatabaseId,
          collab_version: null,
          restore_id: null,
          document_state: Array.from(rowCollab.documentState),
          state_vector: Array.from(rowCollab.stateVector),
          generation: 0,
          last_message_id: { timestamp: 0, counter: 0 },
          updated_at: timestamp,
        };
        summary.rows += 1;
      }
    }

    // --- Folder-tree pages: every non-space view. ---
    for (const [oldId, view] of Object.entries(views)) {
      let extra = null;
      try { extra = view.extra ? JSON.parse(view.extra) : null; } catch { extra = null; }
      if (extra && extra.is_space === true) continue; // handled above
      const newId = viewIdMap.get(oldId);
      const newParentId = resolveParent(view.parent_id);

      if (extra && extra.is_database_container === true && databaseIdMap.has(extra.database_id)) {
        s.pages[newId] = {
          id: newId,
          workspace_id: newWorkspaceId,
          parent_view_id: newParentId,
          title: view.name,
          icon: view.icon ?? null,
          extra: { is_database_container: true, database_id: databaseIdMap.get(extra.database_id) },
          layout: view.layout ?? 1,
          is_favorite: false,
          document: {},
          schema_version: 'appflowy-document-v1',
          creator_id: user.id,
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          position: { kind: 'end' },
        };
        summary.databaseContainers += 1;
        continue;
      }

      if (extra && extra.database_id && databaseIdMap.has(extra.database_id)) {
        s.pages[newId] = {
          id: newId,
          workspace_id: newWorkspaceId,
          parent_view_id: newParentId,
          title: view.name,
          icon: view.icon ?? null,
          extra: { database_id: databaseIdMap.get(extra.database_id) },
          layout: view.layout ?? 1,
          is_favorite: false,
          document: {},
          schema_version: 'appflowy-document-v1',
          creator_id: user.id,
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          position: { kind: 'end' },
        };
        summary.databaseViews += 1;
        continue;
      }

      // Plain Document page -- look for a matching collab_jsons/documents/{oldId}.json.
      summary.documentPages += 1;
      const docJsonPath = path.join(resolvedExportDir, 'collab_jsons', 'documents', `${oldId}.json`);
      const page = {
        id: newId,
        workspace_id: newWorkspaceId,
        parent_view_id: newParentId,
        title: view.name,
        icon: view.icon ?? null,
        extra: extra && !extra.is_space ? extra : null,
        is_favorite: false,
        document: {},
        schema_version: 'appflowy-document-v1',
        creator_id: user.id,
        version: 1,
        created_at: timestamp,
        updated_at: timestamp,
        position: { kind: 'end' },
      };
      s.pages[newId] = page;

      // loadJsonIfExists is async; this synchronous mutate callback can't
      // await, so document bodies are attached in a second, synchronous
      // sub-pass below using a pre-loaded cache -- see docCache usage.
    }

    return null;
  });

  // --- Document bodies (plain pages + row-documents) need an async file
  // read per file, so they're attached in a second store.mutate pass after
  // pre-reading every file synchronously-available-by-then. ---
  await mutate(store, async (s) => {
    for (const [oldId, view] of Object.entries(views)) {
      let extra = null;
      try { extra = view.extra ? JSON.parse(view.extra) : null; } catch { extra = null; }
      if (extra && (extra.is_space === true || extra.is_database_container === true || extra.database_id)) continue;
      const newId = viewIdMap.get(oldId);
      if (!s.pages[newId]) continue;
      const docJson = await loadJsonIfExists(path.join(resolvedExportDir, 'collab_jsons', 'documents', `${oldId}.json`));
      const built = docJson ? buildDocumentCollabFromTemplate({ documentId: newId, document: docJson, pageIdMap: viewIdMap }) : createInitialPageCollab(newId);
      s.pageCollabDocuments[newId] = {
        workspace_id: newWorkspaceId,
        page_id: newId,
        collab_version: built.collabVersion,
        restore_id: null,
        document_state: Array.from(built.documentState),
        state_vector: Array.from(built.stateVector),
        generation: 0,
        last_message_id: { timestamp: 0, counter: 0 },
        updated_at: timestamp,
      };
    }

    // --- Row-documents: for every imported row whose old row-document
    // (rowDocumentIdFromRowId(oldRowId)) is present in the export, publish
    // it as an orphaned Document page under the row's NEW derived id. Rows
    // with no exported row-document (including the 3 EXPORT_WARNINGS
    // "unregistered_row_document" cases) are left alone -- the existing
    // ensureRowDocumentPage lazy-creation path handles them on first open.
    const inlineViewIdByDatabase = new Map();
    for (const [oldDatabaseId, json] of databaseByOldId.entries()) {
      const inline = (json.views || []).find((v) => v.is_inline) || (json.views || [])[0];
      if (inline) inlineViewIdByDatabase.set(oldDatabaseId, viewIdMap.get(inline.id));
    }
    for (const [oldDatabaseId, json] of databaseByOldId.entries()) {
      const newDatabaseId = databaseIdMap.get(oldDatabaseId);
      const newInlineViewId = inlineViewIdByDatabase.get(oldDatabaseId);
      for (const row of json.rows || []) {
        const newRowId = rowIdMap.get(row.id);
        const oldRowDocId = rowDocumentIdFromRowId(row.id);
        const rowDocJson = await loadJsonIfExists(path.join(resolvedExportDir, 'collab_jsons', 'documents', `${oldRowDocId}.json`));
        if (!rowDocJson) { summary.skippedRowDocuments += 1; continue; }
        const newRowDocId = rowDocumentIdFromRowId(newRowId);
        const built = buildDocumentCollabFromTemplate({ documentId: newRowDocId, document: rowDocJson, pageIdMap: viewIdMap });
        s.pages[newRowDocId] = {
          id: newRowDocId,
          workspace_id: newWorkspaceId,
          parent_view_id: null,
          title: '',
          icon: null,
          extra: { row_document: { source: { database_id: newDatabaseId, database_view_id: newInlineViewId, row_id: newRowId } } },
          is_favorite: false,
          document: {},
          schema_version: 'appflowy-document-v1',
          creator_id: user.id,
          version: 1,
          created_at: timestamp,
          updated_at: timestamp,
          position: { kind: 'start' },
        };
        s.pageCollabDocuments[newRowDocId] = {
          workspace_id: newWorkspaceId,
          page_id: newRowDocId,
          collab_version: built.collabVersion,
          restore_id: null,
          document_state: Array.from(built.documentState),
          state_vector: Array.from(built.stateVector),
          generation: 0,
          last_message_id: { timestamp: 0, counter: 0 },
          updated_at: timestamp,
        };
        summary.rowDocuments += 1;
      }
    }
    return null;
  });

  console.log('Import complete.');
  console.log(`  workspace_id: ${newWorkspaceId}`);
  console.log(`  owner: ${userEmail} (${user.id})`);
  console.log('  counts:', summary);
}

main().catch((error) => {
  console.error('Import failed:', error);
  process.exit(1);
});
