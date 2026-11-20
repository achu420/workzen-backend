#!/usr/bin/env node
// Regenerates templates/documents/*.json from an AppFlowy workspace export
// (the same unzipped export import-template-workspace.mjs reads).
//
// Usage: node scripts/build-document-template-library.mjs [--export ./docs/Templates] [--out ./templates/documents]
//
// Each top-level page of the export's "Pages" space becomes one template: a
// recursive `pages` tree ({id, name, icon, document, children}) holding the
// page and its sub-pages. References that would dangle once copied into
// another workspace are neutralised here:
//   - uploaded image/file blocks (url pointing at the export's local_files)
//     are blanked to an empty placeholder block,
//   - page mentions whose target is outside the template become plain text
//     (the target's title); in-template mentions are kept and remapped to the
//     new page ids at instantiation time (document-template-builder.js),
//   - date-mention reminder ids are removed (no reminder system here).
// Sub-pages with no document (embedded databases) are skipped.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TEMPLATE_META = {
  'Weekly To-Do List': { template_id: 'weekly-to-do-list', description: 'Plan your week with a simple checklist.' },
  'Product Spec Example': { template_id: 'product-spec', description: 'An example product spec: problem, goals, solution and timeline.' },
  'Effective 1:1 Meeting': { template_id: 'one-on-one-meeting', description: 'Agenda and notes for productive 1:1 meetings.' },
  'Press Release Template': { template_id: 'press-release', description: 'A working-backwards press release with a PR & FAQs sub-page.' },
  'Write a Doc': { template_id: 'write-a-doc', description: 'A guide and outline for writing clear documents.' },
  'Simple Startup Company Home': { template_id: 'startup-company-home', description: 'A company home page with onboarding, values and company story sub-pages.' },
  'Product One Pager Template': { template_id: 'product-one-pager', description: 'Summarise a product on a single page.' },
  'Event Planning SOP': { template_id: 'event-planning-sop', description: 'A standard operating procedure for planning events.' },
  'Internal Customer Onboarding Checklist': { template_id: 'customer-onboarding-checklist', description: 'A checklist for onboarding a new customer, with a welcome email sub-page.' },
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  return out;
}

function parseExtra(view) {
  try { return view.extra ? JSON.parse(view.extra) ?? {} : {}; } catch { return {}; }
}

async function loadDocument(exportDir, viewId) {
  try {
    return JSON.parse(await readFile(path.join(exportDir, 'collab_jsons', 'documents', `${viewId}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exportDir = path.resolve(args.export || './docs/Templates');
  const outDir = path.resolve(args.out || './templates/documents');
  const views = JSON.parse(await readFile(path.join(exportDir, 'relation_map.json'), 'utf8')).views;
  const pagesSpace = Object.values(views).find((v) => parseExtra(v).is_space && v.name === 'Pages');
  if (!pagesSpace) throw new Error('No "Pages" space in export');

  const report = { blanked_uploads: [], externalised_mentions: [], dropped_mentions: [], reminders_stripped: 0, skipped_subpages: [] };

  // Only pages that will actually be created count as "in template"; a mention
  // of a skipped sub-page (e.g. an embedded database) becomes plain text.
  const collectIds = async (viewId, acc) => {
    if (!(await loadDocument(exportDir, viewId))) return acc;
    acc.add(viewId);
    for (const child of views[viewId].children) await collectIds(child, acc);
    return acc;
  };

  function neutraliseDocument(doc, treeIds, pageName) {
    for (const block of Object.values(doc.blocks)) {
      const data = block.data ?? {};
      if (block.ty === 'image' && data.url) {
        report.blanked_uploads.push(`${pageName}: image ${data.url}`);
        block.data = { ...data, url: '' };
      } else if (block.ty === 'file' && data.url) {
        report.blanked_uploads.push(`${pageName}: file ${data.url}`);
        block.data = { ...data, url: '', name: null, url_type: 0 };
      }
    }
    for (const [textId, raw] of Object.entries(doc.meta.text_map)) {
      let delta;
      try { delta = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(delta)) continue;
      const next = [];
      for (const op of delta) {
        const mention = op.attributes?.mention;
        if (mention?.type === 'page' && !treeIds.has(mention.page_id)) {
          const title = views[mention.page_id]?.name;
          if (title) {
            report.externalised_mentions.push(`${pageName}: "${title}"`);
            next.push({ insert: title });
          } else {
            report.dropped_mentions.push(`${pageName}: ${mention.page_id}`);
          }
          continue;
        }
        if (mention?.type === 'date' && (mention.reminder_id || mention.reminder_option)) {
          const { reminder_id: _id, reminder_option: _option, ...rest } = mention;
          report.reminders_stripped += 1;
          next.push({ ...op, attributes: { ...op.attributes, mention: rest } });
          continue;
        }
        next.push(op);
      }
      doc.meta.text_map[textId] = JSON.stringify(next);
    }
  }

  async function buildTree(viewId, treeIds) {
    const view = views[viewId];
    const document = await loadDocument(exportDir, viewId);
    if (!document) {
      report.skipped_subpages.push(`${view.name} (${viewId.slice(0, 8)}): no document (database or empty)`);
      return null;
    }
    neutraliseDocument(document, treeIds, view.name);
    const children = [];
    for (const childId of view.children) {
      const child = await buildTree(childId, treeIds);
      if (child) children.push(child);
    }
    return { id: viewId, name: view.name, icon: view.icon ? { ty: view.icon.ty, value: view.icon.value } : null, document, children };
  }

  await mkdir(outDir, { recursive: true });
  let order = 0;
  for (const rootId of pagesSpace.children) {
    const root = views[rootId];
    const meta = TEMPLATE_META[root.name];
    if (!meta) {
      console.warn(`skip "${root.name}": no template metadata`);
      continue;
    }
    const tree = await buildTree(rootId, await collectIds(rootId, new Set()));
    const countPages = (node) => 1 + node.children.reduce((n, c) => n + countPages(c), 0);
    const template = {
      template_id: meta.template_id,
      order: order++,
      name: root.name,
      description: meta.description,
      icon: tree.icon,
      pages: tree,
    };
    await writeFile(path.join(outDir, `${meta.template_id}.json`), `${JSON.stringify(template, null, 2)}\n`);
    console.log(`${meta.template_id}: ${countPages(tree)} page(s)`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (order === 0) throw new Error('No templates written');
}

main().catch((error) => { console.error(error); process.exit(1); });
