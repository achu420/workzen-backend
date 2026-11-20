// Lets an agent write documents: create a page, or append to one. Text is plain "markdown-lite" (headings, bullets,
// numbered items, to-dos, quotes, code fences, dividers and **bold** / *italic* / `code` / [links](https://...)),
// turned into the same blocks the editor makes, so people see and edit it like anything typed by hand.
//
// Appending first saves the page's current state as a named version ("Before <agent>'s edit"), so a person can look
// at the page's version history and restore it. Everything goes through the normal storage path, so live editors see
// the change immediately and search is updated.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { buildDocumentCollabFromTemplate } from './document-template-builder.js';
import { rowDocumentIdFromRowId } from './page-document.js';

export const MAX_CONTENT_CHARS = 50_000;
export const MAX_BLOCKS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

class WriteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ----------------------------------------------------------------- parsing
/** "text **bold** and `code` and [a link](https://x.io)" -> [{insert, attributes?}] */
export function parseInline(text) {
  const ops = [];
  const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|(?<![\p{L}\p{N}])_([^_\s][^_]*)_(?![\p{L}\p{N}]))/gu;
  let last = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) ops.push({ insert: text.slice(last, match.index) });
    if (match[2] ?? match[3]) ops.push({ insert: match[2] ?? match[3], attributes: { bold: true } });
    else if (match[4]) ops.push({ insert: match[4], attributes: { code: true } });
    else if (match[5]) ops.push(SAFE_LINK.test(match[6]) ? { insert: match[5], attributes: { href: match[6] } } : { insert: match[0] });
    else ops.push({ insert: match[7] ?? match[8], attributes: { italic: true } });
    last = match.index + match[0].length;
  }
  if (last < text.length) ops.push({ insert: text.slice(last) });
  return ops.filter((op) => op.insert.length > 0);
}

/** @returns {{ty: string, data: object, delta: object[]}[]} */
export function parseMarkdownLite(content) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let fence = null;

  for (const raw of lines) {
    if (fence) {
      if (/^\s*```\s*$/.test(raw)) {
        blocks.push({ ty: 'code', data: { language: fence.language }, delta: fence.lines.length ? [{ insert: fence.lines.join('\n') }] : [] });
        fence = null;
      } else fence.lines.push(raw);
      continue;
    }
    const open = /^\s*```\s*([\w+#.-]*)\s*$/.exec(raw);

    if (open) { fence = { language: open[1] || 'plain', lines: [] }; continue; }
    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) continue;
    let m;

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) blocks.push({ ty: 'divider', data: {}, delta: [] });
    else if ((m = /^\s*#{1,6}\s+(.*)$/.exec(line))) blocks.push({ ty: 'heading', data: { level: Math.min(3, /^\s*(#+)/.exec(line)[1].length) }, delta: parseInline(m[1]) });
    else if ((m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line))) blocks.push({ ty: 'todo_list', data: { checked: m[1] !== ' ' }, delta: parseInline(m[2]) });
    else if ((m = /^\s*[-*+•]\s+(.*)$/.exec(line))) blocks.push({ ty: 'bulleted_list', data: {}, delta: parseInline(m[1]) });
    else if ((m = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line))) blocks.push({ ty: 'numbered_list', data: { number: Number(m[1]) }, delta: parseInline(m[2]) });
    else if ((m = /^\s*>\s?(.*)$/.exec(line))) blocks.push({ ty: 'quote', data: {}, delta: parseInline(m[1]) });
    else blocks.push({ ty: 'paragraph', data: {}, delta: parseInline(line.trim()) });
  }
  if (fence) blocks.push({ ty: 'code', data: { language: fence.language }, delta: fence.lines.length ? [{ insert: fence.lines.join('\n') }] : [] });
  return blocks;
}

function checkContent(content) {
  if (typeof content !== 'string' || !content.trim()) throw new WriteError('INVALID_INPUT', 'content is required.');
  if (content.length > MAX_CONTENT_CHARS) throw new WriteError('INVALID_INPUT', `content is too long (at most ${MAX_CONTENT_CHARS} characters).`);
  const blocks = parseMarkdownLite(content);

  if (!blocks.length) throw new WriteError('INVALID_INPUT', 'content has nothing to write.');
  if (blocks.length > MAX_BLOCKS) throw new WriteError('INVALID_INPUT', `content has too many lines (at most ${MAX_BLOCKS} blocks).`);
  return blocks;
}

const shortId = () => randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);

/** The plain-JSON document shape the template builder understands, for a page that does not exist yet. */
function exportDocumentFor(blocks, rootId) {
  const rootChildren = shortId();
  const exported = { page_id: rootId, blocks: {}, meta: { children_map: { [rootChildren]: [] }, text_map: {} } };

  exported.blocks[rootId] = { id: rootId, ty: 'page', parent: '', children: rootChildren, external_id: null, external_type: null, data: {} };
  for (const block of blocks) {
    const id = shortId();
    const children = shortId();
    const textId = shortId();

    exported.blocks[id] = { id, ty: block.ty, parent: rootId, children, external_id: block.ty === 'divider' ? null : textId, external_type: block.ty === 'divider' ? null : 'text', data: block.data };
    exported.meta.children_map[children] = [];
    exported.meta.children_map[rootChildren].push(id);
    if (block.ty !== 'divider') exported.meta.text_map[textId] = JSON.stringify(block.delta);
  }
  return exported;
}

function appendBlocksToDoc(doc, blocks) {
  const document = doc.getMap('data').get('document');
  const blockMap = document.get('blocks');
  const meta = document.get('meta');
  const rootId = document.get('page_id');
  const rootChildren = meta.get('children_map').get(blockMap.get(rootId).get('children'));

  doc.transact(() => {
    for (const block of blocks) {
      const id = shortId();
      const childrenId = shortId();
      const textId = shortId();
      const map = new Y.Map();

      map.set('id', id);
      map.set('ty', block.ty);
      map.set('parent', rootId);
      map.set('children', childrenId);
      map.set('external_id', block.ty === 'divider' ? null : textId);
      map.set('external_type', block.ty === 'divider' ? null : 'text');
      map.set('data', JSON.stringify(block.data));
      blockMap.set(id, map);
      meta.get('children_map').set(childrenId, new Y.Array());
      if (block.ty !== 'divider') {
        const text = new Y.Text();

        meta.get('text_map').set(textId, text);
        let offset = 0;

        for (const op of block.delta) {
          text.insert(offset, op.insert, op.attributes);
          offset += op.insert.length;
        }
      }
      rootChildren.push([id]);
    }
  });
}

// ------------------------------------------------------------------ writer
export function createPageWriter({ store, broadcast = async () => {}, isReadableSpace, cards = null, ensureRowDocument = null, now = () => new Date().toISOString() }) {
  async function governingSpace(workspaceId, page) {
    let cursor = page.parent_view_id;

    for (let guard = 0; cursor && guard < 64; guard += 1) {
      const space = await store.getSpace(cursor);

      if (space) return space.workspace_id === workspaceId ? space : null;
      const parent = await store.getPage(cursor);

      if (!parent || parent.workspace_id !== workspaceId || parent.is_trashed) return null;
      cursor = parent.parent_view_id;
    }
    return null;
  }

  const isDocument = (page) => (page.layout ?? 0) === 0 && page.extra?.is_database_container !== true && !page.extra?.database_id && !page.extra?.row_document;

  async function writablePage(workspaceId, pageId) {
    const page = isUuid(pageId) ? await store.getPage(pageId) : null;

    if (!page || page.workspace_id !== workspaceId || page.is_trashed) throw new WriteError('NOT_FOUND', 'Page not found.');
    const space = await governingSpace(workspaceId, page);

    if (!space || !isReadableSpace(space.permission)) throw new WriteError('NOT_FOUND', 'Page not found.');
    if (!isDocument(page)) throw new WriteError('NOT_A_PAGE', 'Only document pages can be written to (not databases, cards or chats).');
    return page;
  }

  async function createPage({ workspaceId, userId, parentId, title, content = '', idempotencyKey }) {
    const name = typeof title === 'string' ? title.trim() : '';

    if (!name || name.length > 200) throw new WriteError('INVALID_INPUT', 'title is required (at most 200 characters).');
    const blocks = content ? checkContent(content) : [];
    const space = isUuid(parentId) ? await store.getSpace(parentId) : null;
    const parentPage = space ? null : (isUuid(parentId) ? await store.getPage(parentId) : null);

    if (space) {
      if (space.workspace_id !== workspaceId || !isReadableSpace(space.permission)) throw new WriteError('NOT_FOUND', 'Parent space or page not found.');
    } else if (!parentPage || parentPage.workspace_id !== workspaceId || parentPage.is_trashed || !isDocument(parentPage) || !(await governingSpace(workspaceId, parentPage))) {
      throw new WriteError('NOT_FOUND', 'Parent space or page not found (pages can go in a space or under a document page).');
    }
    const requestId = idempotencyKey
      ? (() => { const h = createHash('sha256').update(`create_page:${workspaceId}:${idempotencyKey}`).digest(); h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80; const x = h.subarray(0, 16).toString('hex'); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`; })()
      : randomUUID();
    const pageId = requestId; // replays of one idempotency key resolve to one page
    const stamp = now();
    const collab = buildDocumentCollabFromTemplate({ documentId: pageId, document: exportDocumentFor(blocks, 'template-root'), pageIdMap: new Map() });
    const digest = createHash('sha256').update(JSON.stringify({ parentId, name, content })).digest('hex');
    let created;

    try {
      created = await store.createDocumentTreeFromTemplate({
        entries: [{
          page: {
            id: pageId, workspace_id: workspaceId, parent_view_id: parentId, title: name, icon: null, extra: null, is_favorite: false, document: {},
            schema_version: 'appflowy-document-v1', creator_id: userId, version: 1, created_at: stamp, updated_at: stamp, position: { kind: 'end' },
          },
          collab,
        }],
        request: { request_id: requestId, request_digest: digest },
      });
    } catch (error) {
      if (error.code === 'REQUEST_ID_REUSED') throw new WriteError('IDEMPOTENCY_CONFLICT', 'That idempotency_key was already used with different arguments.');
      throw error;
    }
    return { page_id: created.result?.view_id ?? pageId, title: name, blocks: blocks.length, replayed: created.outcome === 'already_applied' };
  }

  // Shared by pages and card bodies: save a restore point, append the blocks, fan the update out.
  async function appendBlocks({ workspaceId, userId, page, blocks, agentName }) {
    const collab = await store.getPageCollab(workspaceId, page.id);

    if (!collab) throw new WriteError('NOT_READY', 'This page has not been opened yet; open it once in the app and try again.');
    const user = await store.getUserById(userId);
    const actorUid = user && Number.isSafeInteger(Number(user.uid)) ? Number(user.uid) : null;
    const doc = new Y.Doc({ guid: page.id });

    Y.applyUpdate(doc, collab.doc_state);
    const restorePoint = await store.createPageCollabVersion(workspaceId, page.id, {
      name: `Before ${String(agentName).slice(0, 60)}'s edit`,
      documentState: Y.encodeStateAsUpdate(doc),
      actorUid,
    });
    const beforeVector = Y.encodeStateVector(doc);

    appendBlocksToDoc(doc, blocks);
    const update = Y.encodeStateAsUpdate(doc, beforeVector);
    const accepted = await store.acceptPageCollabUpdate({
      workspaceId, pageId: page.id, flags: 0, payload: update, beforeStateVector: beforeVector,
      collabVersion: collab.collab_version, restoreId: collab.restore_id ?? null, actorUserId: userId,
    });

    const afterVector = accepted.stateVector ? null : Y.encodeStateVector(doc);

    doc.destroy();
    await broadcast({ workspaceId, collabType: 0, objectId: page.id, update, accepted }).catch(() => undefined);
    return {
      page_id: page.id, title: page.title, blocks: blocks.length, restore_point: restorePoint?.name ?? null,
      // What undoing needs: the saved version to go back to, and what the page must still look like (nobody edited since).
      restore_version: restorePoint?.version ?? null,
      after_state_vector: Buffer.from(accepted.stateVector ?? afterVector).toString('base64'),
    };
  }

  async function appendToPage({ workspaceId, userId, pageId, content, agentName = 'an agent' }) {
    const blocks = checkContent(content);
    const page = await writablePage(workspaceId, pageId);

    return appendBlocks({ workspaceId, userId, page, blocks, agentName });
  }

  /** Adds text to the end of a card's body (the document of its detail page), creating that document if the card never had one. */
  async function appendToCardBody({ workspaceId, userId, cardId, content, agentName = 'an agent' }) {
    if (!cards || !ensureRowDocument) throw new WriteError('UNSUPPORTED', 'Writing card bodies is not available on this server.');
    const blocks = checkContent(content);
    const card = await cards.getCard({ workspaceId, cardId });

    if (card.archived) throw new WriteError('INVALID_INPUT', 'This card is archived. Restore it with restore_card before changing it.');
    const ensured = await ensureRowDocument({ workspaceId, databaseId: card.database_id, rowId: cardId, actorUserId: userId });

    if (ensured?.error || !ensured?.collab) throw new WriteError('NOT_READY', 'The card body could not be opened. Open the card once in the app and try again.');
    const page = await store.getPage(rowDocumentIdFromRowId(cardId));

    if (!page || page.workspace_id !== workspaceId || page.is_trashed) throw new WriteError('NOT_FOUND', 'Card body not found.');
    const written = await appendBlocks({ workspaceId, userId, page, blocks, agentName });

    return { ...written, card_id: cardId, title: card.title };
  }

  return { createPage, appendToPage, appendToCardBody };
}

export { WriteError };
