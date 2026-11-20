import {
  buildPreview,
  extractDatabaseSchema,
  extractDocumentText,
  extractRowText,
  queryTerms,
  scoreSearchDocument,
  tokenize,
} from './search-text.js';

// Keeps the workspace search index in step with pages and database rows, and
// answers queries from it. The index lives behind three store methods
// (upsert/delete/query) so the JSON and Postgres modes share all of this logic.
//
// Updates are debounced per object: a collab update schedules a reindex that runs
// `delayMs` after the last change, so typing does not decode a document per
// keystroke. Permissions are NOT stored in the index; they are applied at query
// time from the live page tree (see buildReadableIndex).

const isViewPage = (page) => Boolean(page.extra?.database_id) && page.extra?.is_database_container !== true;

export function createSearchIndex(store, { delayMs = 1500, onError = (error) => console.error('search index', error) } = {}) {
  const timers = new Map();
  let chain = Promise.resolve();
  let ready = Promise.resolve();

  const pagesFor = async (workspaceId, databaseId) => {
    const pages = (await store.listPages(workspaceId)).filter((page) => page.extra?.database_id === databaseId);
    const container = pages.find((page) => page.extra?.is_database_container === true) ?? null;
    const views = pages
      .filter((page) => page.extra?.is_database_container !== true && !page.is_trashed)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || left.id.localeCompare(right.id));

    return { container, primaryView: views[0] ?? null };
  };

  async function indexPage(workspaceId, pageId) {
    const page = await store.getPage(pageId);

    if (!page || page.workspace_id !== workspaceId) {
      await store.deleteSearchDocuments(workspaceId, [pageId]);
      return;
    }
    if (isViewPage(page)) {
      await store.deleteSearchDocuments(workspaceId, [pageId]);
      return;
    }
    let content = '';

    if (page.extra?.is_database_container !== true) {
      const collab = await store.getPageCollab(workspaceId, pageId).catch(() => null);

      if (collab) content = extractDocumentText(collab.doc_state);
    }
    await store.upsertSearchDocuments([{
      workspace_id: workspaceId,
      object_id: page.id,
      kind: 'page',
      view_id: page.id,
      database_id: page.extra?.is_database_container === true ? page.extra.database_id ?? null : null,
      database_view_id: null,
      database_row_id: null,
      title: page.title ?? '',
      content,
      updated_at: page.updated_at ?? new Date().toISOString(),
    }]);
  }

  const rowDocument = (workspaceId, databaseId, primaryView, container, rowId, text) => {
    const lines = text.content.split('\n').filter(Boolean);

    return {
      workspace_id: workspaceId,
      object_id: rowId,
      kind: 'row',
      view_id: container?.id ?? null,
      database_id: databaseId,
      database_view_id: primaryView?.id ?? null,
      database_row_id: rowId,
      title: text.title || lines[0] || '',
      content: text.content,
      updated_at: new Date().toISOString(),
    };
  };

  async function indexDatabase(workspaceId, databaseId) {
    const collab = await store.getDatabaseCollab(workspaceId, databaseId);
    const existing = await store.listSearchDocumentRefs(workspaceId, { kind: 'row', databaseId });

    if (!collab) {
      await store.deleteSearchDocuments(workspaceId, existing.map((ref) => ref.object_id));
      return;
    }
    const schema = extractDatabaseSchema(collab.doc_state);
    const { container, primaryView } = await pagesFor(workspaceId, databaseId);
    const documents = [];

    for (const rowId of schema.rowIds) {
      const rowCollab = await store.getDatabaseRowCollab(workspaceId, rowId);
      const text = rowCollab && extractRowText(schema, rowCollab.doc_state);

      if (text && (text.title || text.content)) documents.push(rowDocument(workspaceId, databaseId, primaryView, container, rowId, text));
    }
    if (documents.length) await store.upsertSearchDocuments(documents);
    const keep = new Set(documents.map((doc) => doc.object_id));

    await store.deleteSearchDocuments(workspaceId, existing.map((ref) => ref.object_id).filter((id) => !keep.has(id)));
  }

  async function indexRow(workspaceId, rowId) {
    const rowCollab = await store.getDatabaseRowCollab(workspaceId, rowId);
    const databaseId = rowCollab && extractRowText({ fields: new Map() }, rowCollab.doc_state)?.databaseId;
    const collab = databaseId && await store.getDatabaseCollab(workspaceId, databaseId);

    if (!collab) {
      await store.deleteSearchDocuments(workspaceId, [rowId]);
      return;
    }
    const schema = extractDatabaseSchema(collab.doc_state);
    const text = schema.rowIds.includes(rowId) ? extractRowText(schema, rowCollab.doc_state) : null;

    if (!text || (!text.title && !text.content)) {
      await store.deleteSearchDocuments(workspaceId, [rowId]);
      return;
    }
    const { container, primaryView } = await pagesFor(workspaceId, databaseId);

    await store.upsertSearchDocuments([rowDocument(workspaceId, databaseId, primaryView, container, rowId, text)]);
  }

  const handlers = {
    page: indexPage,
    database: indexDatabase,
    row: indexRow,
    remove: (workspaceId, ids) => store.deleteSearchDocuments(workspaceId, ids),
  };

  function enqueue(job) {
    chain = chain.then(() => handlers[job.type](job.workspaceId, job.id)).catch(onError);
  }

  function schedule(type, workspaceId, id) {
    const key = `${type}:${workspaceId}:${typeof id === 'string' ? id : id.join(',')}`;
    const job = { type, workspaceId, id };
    const previous = timers.get(key);

    if (previous) clearTimeout(previous.timer);
    if (delayMs <= 0) {
      timers.delete(key);
      enqueue(job);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(key);
      enqueue(job);
    }, delayMs);

    timer.unref?.();
    timers.set(key, { timer, job });
  }

  /** Run every pending job now and wait for the queue to drain (tests, shutdown, scripts). */
  async function flush() {
    for (const { timer, job } of timers.values()) {
      clearTimeout(timer);
      enqueue(job);
    }
    timers.clear();
    await chain;
  }

  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

  /** Rebuild the whole index from current pages, rows and documents. Never throws. */
  async function backfill() {
    try {
      const workspaceIds = typeof store.listWorkspaceIds === 'function' ? await store.listWorkspaceIds() : [];

      for (const workspaceId of workspaceIds) {
        const pages = await store.listPages(workspaceId);
        const databaseIds = new Set();

        for (const page of pages) {
          await indexPage(workspaceId, page.id).catch(onError);
          if (page.extra?.is_database_container === true && page.extra.database_id) databaseIds.add(page.extra.database_id);
          await yieldToEventLoop();
        }
        for (const databaseId of databaseIds) {
          await indexDatabase(workspaceId, databaseId).catch(onError);
          await yieldToEventLoop();
        }
        const live = new Set(pages.map((page) => page.id));
        const stale = (await store.listSearchDocumentRefs(workspaceId, { kind: 'page' })).map((ref) => ref.object_id).filter((id) => !live.has(id));

        await store.deleteSearchDocuments(workspaceId, stale);
      }
    } catch (error) {
      onError(error);
    }
  }

  function startBackfill() {
    ready = backfill();
    return ready;
  }

  function wrap(name, after) {
    const original = store[name];

    if (typeof original !== 'function') return;
    store[name] = async function wrapped(...args) {
      const result = await original.apply(this, args);

      try {
        after(args, result);
      } catch (error) {
        onError(error);
      }
      return result;
    };
  }

  /** Wrap the store's mutating methods so every relevant change schedules a reindex. */
  function attach() {
    if (store.__searchIndexAttached) return;
    store.__searchIndexAttached = true;
    wrap('acceptPageCollabUpdate', ([p], r) => { if (!r?.duplicate) schedule('page', p.workspaceId, p.pageId); });
    wrap('acceptDatabaseCollabUpdate', ([p], r) => { if (!r?.duplicate) schedule('database', p.workspaceId, p.databaseId); });
    wrap('acceptDatabaseRowCollabUpdate', ([p], r) => { if (!r?.duplicate) schedule('row', p.workspaceId, p.rowId); });
    wrap('updatePageTitle', ([pageId, workspaceId]) => schedule('page', workspaceId, pageId));
    wrap('updatePageMetadata', ([pageId, workspaceId]) => schedule('page', workspaceId, pageId));
    wrap('createPage', ([page]) => schedule('page', page.workspace_id, page.id));
    wrap('createAtomicDocumentPage', ([page]) => schedule('page', page.workspace_id, page.id));
    wrap('createAtomicDatabasePage', ([container, , databaseId]) => {
      schedule('page', container.workspace_id, container.id);
      schedule('database', container.workspace_id, databaseId);
    });
    wrap('createDatabaseFromTemplate', ([p]) => {
      schedule('page', p.containerPage.workspace_id, p.containerPage.id);
      schedule('database', p.containerPage.workspace_id, p.databaseId);
    });
    wrap('createDocumentTreeFromTemplate', ([p]) => {
      for (const entry of p.entries) schedule('page', entry.page.workspace_id, entry.page.id);
    });
    wrap('createAtomicDatabaseRow', ([p]) => schedule('row', p.workspaceId, p.rowId));
    wrap('createSeededDatabaseRow', ([p]) => schedule('row', p.workspaceId, p.rowId));
    // Permanent delete: drop the page, and a database's rows with its container.
    const deletePermanently = store.deletePagePermanently;

    if (typeof deletePermanently === 'function') {
      store.deletePagePermanently = async function wrapped(pageId, workspaceId) {
        const page = await store.getPage(pageId);
        const deleted = await deletePermanently.call(this, pageId, workspaceId);

        try {
          if (deleted && page) {
            schedule('remove', workspaceId, [pageId]);
            if (page.extra?.is_database_container === true && page.extra.database_id) schedule('database', workspaceId, page.extra.database_id);
          }
        } catch (error) {
          onError(error);
        }
        return deleted;
      };
    }
  }

  return { attach, schedule, flush, backfill, startBackfill, whenReady: () => ready, indexPage, indexDatabase, indexRow };
}

/**
 * The pages a member may see, from the live tree: in this workspace, not trashed
 * (nor under a trashed ancestor), and rooted in a readable public space (or at
 * the workspace root / an orphaned row-document page, which membership covers).
 */
export async function buildReadableIndex(store, workspace, isReadableSpace) {
  const [pages, spaces] = await Promise.all([store.listPages(workspace.id), store.listSpaces(workspace.id)]);
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const spacesById = new Map(spaces.map((space) => [space.id, space]));
  const verdicts = new Map();
  const readable = (page) => {
    if (verdicts.has(page.id)) return verdicts.get(page.id);
    let current = page;
    let ok = true;

    for (let depth = 0; depth < 64 && ok; depth += 1) {
      if (current.is_trashed) {
        ok = false;
        break;
      }
      const parentId = current.parent_view_id;

      if (!parentId || parentId === workspace.id) break;
      const space = spacesById.get(parentId);

      if (space) {
        ok = isReadableSpace(space.permission);
        break;
      }
      current = pagesById.get(parentId);
      if (!current) ok = false;
    }
    verdicts.set(page.id, ok);
    return ok;
  };
  const readablePages = pages.filter(readable);
  const containers = new Map();

  for (const page of readablePages) {
    if (page.extra?.is_database_container === true && page.extra.database_id) containers.set(page.extra.database_id, page);
  }
  return { pagesById, readablePages, containers, isReadable: (pageId) => pagesById.has(pageId) && readable(pagesById.get(pageId)) };
}

const clampInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/** GET /api/search/{ws}/page: ranked, permission-filtered, paged hits. */
export async function searchWorkspace(store, workspace, readableIndex, params) {
  const terms = queryTerms(params.query ?? '');
  const limit = clampInteger(params.limit, 10, 1, 50);
  const offset = clampInteger(params.offset, 0, 0, 10_000);
  const previewSize = clampInteger(params.previewSize, 80, 20, 500);

  if (!terms.length) return { items: [], next_offset: null, has_more: false };
  const candidates = await store.querySearchDocuments(workspace.id, terms, { max: 500 });
  const hits = [];

  for (const doc of candidates) {
    const allowed = doc.kind === 'page' ? readableIndex.isReadable(doc.object_id) : readableIndex.containers.has(doc.database_id);
    const score = allowed ? scoreSearchDocument(doc, terms) : null;

    if (score !== null) hits.push({ doc, score });
  }
  hits.sort((left, right) => right.score - left.score || String(left.doc.title).localeCompare(String(right.doc.title)));
  const page = hits.slice(offset, offset + limit);
  const hasMore = hits.length > offset + limit;
  const items = page.map(({ doc, score }) => {
    const snippetSource = tokenize(doc.content).some((token) => terms.some((term) => token.startsWith(term))) ? doc.content : doc.content || doc.title;
    const preview = buildPreview(snippetSource, terms, previewSize);

    return {
      object_id: doc.object_id,
      workspace_id: workspace.id,
      score: Math.round(score * 1000) / 1000,
      content: preview,
      preview,
      ...(doc.kind === 'row'
        ? { database_id: doc.database_id, database_view_id: doc.database_view_id ?? null, database_row_id: doc.database_row_id ?? doc.object_id }
        : { database_id: doc.database_id ?? null }),
    };
  });

  return { items, next_offset: hasMore ? offset + limit : null, has_more: hasMore };
}

const MENTION_TITLES = { person: 'People', page: 'Pages', database: 'Databases', database_row: 'Rows', date: 'Dates' };

/** POST /api/workspace/{ws}/mentions/search: sections for the @ mention / page-reference panel. */
export async function searchMentions(store, workspace, readableIndex, { people, request }) {
  const terms = queryTerms(request.query ?? '');
  const limit = clampInteger(request.limit, 20, 1, 50);
  const include = new Set(Array.isArray(request.include) && request.include.length ? request.include : ['person', 'page', 'database', 'database_row', 'date']);
  const section = (kind, items) => ({ kind: { person: 'people', page: 'pages', database: 'databases', database_row: 'database_rows', date: 'dates' }[kind], title: MENTION_TITLES[kind], items, has_more: false, status: 'ready' });
  const matchesTitle = (title) => !terms.length || (() => {
    const tokens = tokenize(title);

    return terms.every((term) => tokens.some((token) => token.startsWith(term)));
  })();
  const byRecency = (left, right) => String(right.updated_at).localeCompare(String(left.updated_at));
  const sections = [];

  if (include.has('person')) {
    const items = people
      .filter((person) => matchesTitle(`${person.name} ${person.email}`))
      .slice(0, limit)
      .map((person) => ({
        kind: 'person',
        object_id: person.person_id,
        title: person.name,
        subtitle: person.email,
        ...(person.avatar_url ? { icon: person.avatar_url } : {}),
        mention: { type: 'person', person_id: person.person_id, person_name: person.name, page_id: request.context?.view_id ?? '' },
      }));

    sections.push(section('person', items));
  }
  const documents = readableIndex.readablePages.filter((page) => page.extra?.is_database_container !== true && !isViewPage(page) && !page.extra?.row_document);

  if (include.has('page')) {
    const items = documents.filter((page) => matchesTitle(page.title ?? '')).sort(byRecency).slice(0, limit).map((page) => ({
      kind: 'page', object_id: page.id, title: page.title ?? '', mention: { type: 'page', page_id: page.id },
    }));

    sections.push(section('page', items));
  }
  if (include.has('database')) {
    const containers = [...readableIndex.containers.values()].filter((page) => matchesTitle(page.title ?? '')).sort(byRecency).slice(0, limit);
    const items = [];

    for (const container of containers) {
      const views = readableIndex.readablePages
        .filter((page) => page.parent_view_id === container.id && isViewPage(page))
        .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
      const viewId = views[0]?.id;

      items.push({
        kind: 'database',
        object_id: container.id,
        title: container.title ?? '',
        database_id: container.extra.database_id,
        ...(viewId ? { database_view_id: viewId } : {}),
        mention: { type: 'database', database_id: container.extra.database_id, ...(viewId ? { database_view_id: viewId } : {}) },
      });
    }
    sections.push(section('database', items));
  }
  if (include.has('database_row')) {
    const filter = request.filter ?? {};
    const databaseIds = new Set(filter.database_ids ?? []);
    const viewIds = new Set(filter.database_view_ids ?? []);
    const rowIds = new Set(filter.database_row_ids ?? []);
    const candidates = terms.length ? await store.querySearchDocuments(workspace.id, terms, { max: 500 }) : [];
    const items = candidates
      .filter((doc) => doc.kind === 'row' && readableIndex.containers.has(doc.database_id) &&
        (!databaseIds.size || databaseIds.has(doc.database_id)) &&
        (!viewIds.size || viewIds.has(doc.database_view_id)) &&
        (!rowIds.size || rowIds.has(doc.object_id)))
      .map((doc) => ({ doc, score: scoreSearchDocument(doc, terms) }))
      .filter((entry) => entry.score !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ doc }) => ({
        kind: 'database_row',
        object_id: doc.object_id,
        title: doc.title,
        subtitle: readableIndex.containers.get(doc.database_id)?.title ?? '',
        database_id: doc.database_id,
        ...(doc.database_view_id ? { database_view_id: doc.database_view_id } : {}),
        database_row_id: doc.object_id,
        can_access_context: true,
        mention: {
          type: 'database_row',
          database_id: doc.database_id,
          ...(doc.database_view_id ? { database_view_id: doc.database_view_id } : {}),
          row_id: doc.object_id,
        },
      }));

    sections.push(section('database_row', items));
  }
  if (include.has('date')) {
    const day = 86_400_000;
    const items = [['today', 'Today', 0], ['tomorrow', 'Tomorrow', 1], ['yesterday', 'Yesterday', -1]]
      .filter(([, title]) => matchesTitle(title))
      .map(([id, title, offset]) => ({ kind: 'date', object_id: id, title, mention: { type: 'date', start: new Date(Date.now() + offset * day).toISOString() } }));

    sections.push(section('date', items));
  }
  return { sections };
}
