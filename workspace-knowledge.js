// "What does this workspace know?": the one place that searches, reads and summarises workspace content for the things
// that answer questions about it (the AI chat and the MCP agent tools). Everything is permission filtered the same way
// as the web app's own search: a page, database or card is visible only when it lives in a space the person can read and
// not under anything trashed.
import { buildReadableIndex } from './search-index.js';
import { buildPreview, extractDocumentText, queryTerms, scoreSearchDocument, tokenize } from './search-text.js';

const STOPWORDS = new Set(('the and for are but not you all any can had her was one our out has his how its may new now old see two way who did get let put say she too use '
  + 'what when where which who whom whose why will with would about above after again also been before being below between both could does doing down during each '
  + 'from further have having here into just like more most only other over same should some such than that their them then there these they this those through '
  + 'under until very were while your our ours mine please tell show give find list want need know look make made does any else').split(/\s+/));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);

const NON_PAGE_LAYOUTS = new Set([4]); // AI chat pages

const clamp = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/**
 * Words worth searching for in a natural-language question: filler words are dropped BEFORE the cap, so the cap keeps
 * eight meaningful words rather than the first eight words of the sentence.
 */
export function keywordsOf(query) {
  const all = [...new Set(tokenize(String(query ?? '')))];
  const words = all.filter((word) => word.length >= 3 && !STOPWORDS.has(word));

  return (words.length ? words : all).slice(0, 8);
}

export function createWorkspaceKnowledge({ store, isReadableSpace, cards }) {
  const index = (workspaceId) => buildReadableIndex(store, { id: workspaceId }, isReadableSpace);

  async function pathOf(workspaceId, page, readable, spacesById) {
    const names = [];
    let cursor = page.parent_view_id;

    for (let guard = 0; cursor && cursor !== workspaceId && guard < 16; guard += 1) {
      const space = spacesById.get(cursor);

      if (space) { names.unshift(space.name); break; }
      const parent = readable.pagesById.get(cursor);

      if (!parent) break;
      names.unshift(parent.title);
      cursor = parent.parent_view_id;
    }
    return names.join(' / ');
  }

  const kindOf = (page) => {
    if (page.extra?.is_database_container === true || (page.extra?.database_id && page.extra?.is_database_container !== true)) return 'database';
    if (page.extra?.row_document) return 'card_body';
    if (NON_PAGE_LAYOUTS.has(page.layout)) return 'chat';
    return 'page';
  };

  /**
   * Ranked, permission-filtered hits with titles, paths and snippets.
   * mode 'all': every word must appear (as a prefix); 'any': a hit needs only one word, ranked by how many it has
   * (for natural-language questions where requiring every word finds nothing).
   * `pageIds` (optional Set) narrows DOCUMENT hits to those pages; databases and cards are never narrowed.
   */
  async function search({ workspaceId, query, limit = 8, snippetChars = 300, mode = 'all', pageIds = null, types = null }) {
    const terms = mode === 'any' ? keywordsOf(query) : queryTerms(query ?? '');

    if (!terms.length) return { terms, hits: [] };
    const readable = await index(workspaceId);
    const spaces = await store.listSpaces(workspaceId);
    const spacesById = new Map(spaces.map((space) => [space.id, space]));
    const candidates = new Map();

    if (mode === 'any') {
      for (const term of terms) {
        for (const doc of await store.querySearchDocuments(workspaceId, [term], { max: 300 })) {
          const key = `${doc.kind}:${doc.object_id}`;
          const entry = candidates.get(key) ?? { doc, matched: new Set() };

          entry.matched.add(term);
          candidates.set(key, entry);
        }
      }
    } else {
      for (const doc of await store.querySearchDocuments(workspaceId, terms, { max: 500 })) candidates.set(`${doc.kind}:${doc.object_id}`, { doc, matched: new Set(terms) });
    }
    const scored = [];

    for (const { doc, matched } of candidates.values()) {
      const isPage = doc.kind === 'page';
      const allowed = isPage ? readable.isReadable(doc.object_id) : readable.containers.has(doc.database_id);

      if (!allowed) continue;
      const page = isPage ? readable.pagesById.get(doc.object_id) : null;
      const type = isPage ? kindOf(page) : 'card';

      if (type === 'chat' || type === 'card_body') continue;
      if (pageIds && type === 'page' && !pageIds.has(doc.object_id)) continue;
      if (types && !types.includes(type)) continue;
      const base = scoreSearchDocument(doc, [...matched]);

      if (base === null) continue;
      scored.push({ doc, page, type, matched, score: base + (mode === 'any' ? 20 * matched.size : 0) });
    }
    scored.sort((a, b) => b.score - a.score || String(a.doc.title).localeCompare(String(b.doc.title)));
    const hits = [];

    for (const { doc, page, type, matched, score } of scored.slice(0, clamp(limit, 8, 1, 50))) {
      const container = type === 'card' || type === 'database' ? readable.containers.get(doc.database_id ?? page?.extra?.database_id) : null;
      const source = tokenize(doc.content).some((token) => [...matched].some((term) => token.startsWith(term))) ? doc.content : doc.content || doc.title;
      const base = {
        type,
        id: type === 'card' ? (doc.database_row_id ?? doc.object_id) : type === 'database' ? (doc.database_id ?? page.extra.database_id) : doc.object_id,
        title: doc.title || (type === 'card' ? 'Untitled card' : 'Untitled'),
        snippet: buildPreview(source, [...matched], clamp(snippetChars, 300, 40, 1500)),
        score: Math.round(score * 100) / 100,
      };

      if (type === 'page') hits.push({ ...base, path: await pathOf(workspaceId, page, readable, spacesById), view_id: doc.object_id });
      else {
        const containerPage = container ?? null;

        hits.push({
          ...base,
          database_id: doc.database_id ?? page?.extra?.database_id ?? null,
          database_name: containerPage?.title ?? null,
          database_view_id: doc.database_view_id ?? null,
          path: containerPage ? await pathOf(workspaceId, containerPage, readable, spacesById) : '',
          ...(type === 'card' ? { row_id: doc.database_row_id ?? doc.object_id } : {}),
        });
      }
    }
    return { terms, hits };
  }

  /** A page's text, paged. Throws {code:'NOT_FOUND'|'NOT_A_PAGE'} for anything that is not a readable document. */
  async function readPage({ workspaceId, pageId, offset = 0, maxChars = 6000 }) {
    const fail = (code, message) => Object.assign(new Error(message), { code });
    const page = isUuid(pageId) ? await store.getPage(pageId) : null;

    if (!page || page.workspace_id !== workspaceId) throw fail('NOT_FOUND', 'Page not found.');
    const readable = await index(workspaceId);

    if (!readable.isReadable(page.id)) throw fail('NOT_FOUND', 'Page not found.');
    const kind = kindOf(page);

    if (kind === 'database') throw fail('NOT_A_PAGE', 'This is a database, not a document. Use list_databases / list_cards to read its cards.');
    if (kind === 'card_body') throw fail('NOT_A_PAGE', "This is a card's detail page. Read it with get_card.");
    if (kind === 'chat') throw fail('NOT_A_PAGE', 'This is an AI chat, not a document.');
    const collab = await store.getPageCollab(workspaceId, page.id);
    const full = collab ? extractDocumentText(collab.doc_state).trim() : '';
    const start = Math.min(full.length, Math.max(0, clamp(offset, 0, 0, Number.MAX_SAFE_INTEGER)));
    const end = Math.min(full.length, start + clamp(maxChars, 6000, 200, 12_000));
    const spacesById = new Map((await store.listSpaces(workspaceId)).map((space) => [space.id, space]));

    return {
      id: page.id,
      title: page.title,
      path: await pathOf(workspaceId, page, readable, spacesById),
      text: full.slice(start, end),
      total_chars: full.length,
      truncated: end < full.length,
      next_offset: end < full.length ? end : null,
      has_content: full.length > 0,
      updated_at: page.updated_at ?? null,
      parent_id: page.parent_view_id ?? null,
    };
  }

  /** The tree an agent navigates by: spaces, then pages under a space or page. */
  async function listPages({ workspaceId, parentId = null, limit = 100 }) {
    const readable = await index(workspaceId);
    const spaces = (await store.listSpaces(workspaceId)).filter((space) => isReadableSpace(space.permission)).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const childrenOf = (id) => readable.readablePages.filter((page) => page.parent_view_id === id && kindOf(page) !== 'card_body' && kindOf(page) !== 'chat')
      .sort((a, b) => (a.position?.sort_key ?? Date.parse(a.created_at)) - (b.position?.sort_key ?? Date.parse(b.created_at)) || a.id.localeCompare(b.id));
    const describe = (page) => ({
      id: page.id,
      title: page.title,
      type: kindOf(page) === 'database' ? 'database' : 'page',
      has_children: childrenOf(page.id).length > 0,
      updated_at: page.updated_at ?? null,
      ...(kindOf(page) === 'database' ? { database_id: page.extra?.database_id ?? null } : {}),
    });

    if (!parentId) return { parent: null, items: spaces.slice(0, limit).map((space) => ({ id: space.id, title: space.name, type: 'space', has_children: childrenOf(space.id).length > 0 })) };
    const space = spaces.find((candidate) => candidate.id === parentId);
    const page = space || !isUuid(parentId) ? null : readable.pagesById.get(parentId);

    if (!space && !(page && readable.isReadable(page.id))) throw Object.assign(new Error('Space or page not found.'), { code: 'NOT_FOUND' });
    const children = childrenOf(parentId).filter((child) => {
      // A database's own views are not separate pages for an agent.
      const parentPage = page;

      return !(parentPage?.extra?.is_database_container === true && child.extra?.database_id);
    });

    return {
      parent: space ? { id: space.id, title: space.name, type: 'space' } : { id: page.id, title: page.title, type: kindOf(page) === 'database' ? 'database' : 'page' },
      items: children.slice(0, limit).map(describe),
    };
  }

  /**
   * A compact table of cards across every readable database, for questions about tasks, deadlines, risks and plans.
   * Not exhaustive: newest-changed cards first, capped per database and overall.
   */
  async function cardDigest({ workspaceId, maxChars = 9000, perDatabase = 40, maxDatabases = 12 }) {
    if (!cards) return { text: '', cards: 0, truncated: false };
    const databases = (await cards.listDatabases({ workspaceId })).slice(0, maxDatabases);
    const lines = [];
    let count = 0;
    let truncated = false;
    let used = 0;

    for (const database of databases) {
      const page = await cards.listCards({ workspaceId, databaseId: database.database_id, limit: perDatabase }).catch(() => null);

      if (!page?.cards?.length) continue;
      const header = `## Database "${database.name}"${page.next_cursor ? ` (first ${page.cards.length} cards shown)` : ''}`;

      if (used + header.length > maxChars) { truncated = true; break; }
      lines.push(header);
      used += header.length;
      for (const card of page.cards) {
        const fields = Object.entries(card.fields ?? {}).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : typeof value === 'object' && value ? `${value.start ?? ''}${value.end ? `..${value.end}` : ''}` : String(value)}`.slice(0, 48)).join('; ');
        const line = `- ${card.title}${card.column ? ` | ${card.column}` : ''}${fields ? ` | ${fields}` : ''}`.slice(0, 260);

        if (used + line.length > maxChars) { truncated = true; break; }
        lines.push(line);
        used += line.length;
        count += 1;
      }
      if (truncated) break;
    }
    return { text: lines.join('\n'), cards: count, truncated };
  }

  return { search, readPage, listPages, cardDigest, readableIndex: index };
}
