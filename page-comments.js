// Lets agents read and write the inline comments on a document page, the same comments people make in the editor.
//
// A comment thread is anchored to a piece of text: the comment row lives in the comments table, and the text carries a
// `comment-ids` attribute naming it (that is how the web client finds and highlights it; a comment whose text has no
// such attribute is not shown in the page's comment panel). So starting a thread needs a `quote`: text copied from
// one paragraph of the page. Replies need no quote. The attribute is added with an ordinary page update, so live
// editors see the highlight at once.
import * as Y from 'yjs';

export const COMMENT_MAX_CHARS = 10_000;
export const COMMENT_IDS_KEY = 'comment-ids';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);

export class CommentError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details ?? null;
  }
}

/** [{insert, attributes}] for a Y.Text on Yjs 14 (getContent().children, `format`) and older builds (toDelta). */
function opsOf(text) {
  const raw = typeof text.getContent === 'function' ? [...text.getContent().children] : text.toDelta();

  return raw.filter((op) => op.insert !== undefined).map((op) => ({ insert: op.insert, attributes: op.format ?? op.attributes ?? null }));
}

const idsOf = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : typeof value === 'string' && value ? [value] : []);

/** [{blockId, text: Y.Text}] in page order (parents before their children, siblings in order). */
function textBlocksInOrder(doc) {
  const document = doc.getMap('data').get('document');
  const blocks = document?.get('blocks');
  const meta = document?.get('meta');
  const rootId = document?.get('page_id');
  const result = [];

  if (!blocks || !meta || !rootId) return result;
  const visit = (blockId, depth) => {
    const block = blocks.get(blockId);

    if (!block || depth > 64) return;
    const textId = block.get('external_id');
    const text = textId ? meta.get('text_map')?.get(textId) : null;

    if (text instanceof Y.Text) result.push({ blockId, text });
    const children = meta.get('children_map')?.get(block.get('children'));

    if (children) for (const childId of children.toArray()) visit(childId, depth + 1);
  };

  visit(rootId, 0);
  return result;
}

/** comment id -> {block_id, quote} for every anchored span in the page. */
export function readAnchors(docState, pageId) {
  const doc = new Y.Doc({ guid: pageId });
  const anchors = new Map();

  try {
    Y.applyUpdate(doc, docState);
    for (const { blockId, text } of textBlocksInOrderSafe(doc)) {
      for (const op of opsOf(text)) {
        for (const commentId of idsOf(op.attributes?.[COMMENT_IDS_KEY])) {
          const existing = anchors.get(commentId);

          if (existing) existing.quote += String(op.insert);
          else anchors.set(commentId, { block_id: blockId, quote: String(op.insert) });
        }
      }
    }
  } finally {
    doc.destroy();
  }
  return anchors;
}

function textBlocksInOrderSafe(doc) {
  try {
    return textBlocksInOrder(doc);
  } catch {
    return [];
  }
}

/** Adds `commentId` to the comment-ids of every character of [start, end) of `text`, keeping other comments' ids. */
function anchorRange(text, start, end, commentId) {
  let offset = 0;

  for (const op of opsOf(text)) {
    const length = typeof op.insert === 'string' ? op.insert.length : 1;
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + length);

    if (from < to) {
      const merged = [...new Set([...idsOf(op.attributes?.[COMMENT_IDS_KEY]), commentId])];

      text.format(from, to - from, { [COMMENT_IDS_KEY]: merged });
    }
    offset += length;
  }
}

/** Takes `commentId` out of the comment-ids of the page's text; returns whether anything changed. */
function removeAnchor(doc, commentId) {
  let changed = false;

  for (const { text } of textBlocksInOrderSafe(doc)) {
    let offset = 0;

    for (const op of opsOf(text)) {
      const length = typeof op.insert === 'string' ? op.insert.length : 1;
      const ids = idsOf(op.attributes?.[COMMENT_IDS_KEY]);

      if (ids.includes(commentId)) {
        const rest = ids.filter((id) => id !== commentId);

        text.format(offset, length, { [COMMENT_IDS_KEY]: rest.length ? rest : null });
        changed = true;
      }
      offset += length;
    }
  }
  return changed;
}

export function createPageComments({ store, broadcast = async () => {}, broadcastCommentChanged = () => {}, notify = async () => {}, isReadableSpace, newId, now = () => new Date().toISOString() }) {
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

  async function commentablePage(workspaceId, pageId) {
    const page = isUuid(pageId) ? await store.getPage(pageId) : null;

    if (!page || page.workspace_id !== workspaceId || page.is_trashed) throw new CommentError('NOT_FOUND', 'Page not found.');
    const space = await governingSpace(workspaceId, page);

    if (!space || !isReadableSpace(space.permission)) throw new CommentError('NOT_FOUND', 'Page not found.');
    if (!isDocument(page)) throw new CommentError('NOT_A_PAGE', 'Comments here are for document pages. For a card, pass card_id instead.');
    return page;
  }

  async function allComments(workspaceId, pageId) {
    const comments = [];

    for (let offset = 0; offset < 2000; offset += 200) {
      const result = await store.listInlineComments(workspaceId, pageId, { offset, limit: 200 });

      comments.push(...result.comments);
      if (!result.has_more) break;
    }
    return comments;
  }

  async function listComments({ workspaceId, pageId }) {
    const page = await commentablePage(workspaceId, pageId);
    const comments = await allComments(workspaceId, page.id);
    const collab = await store.getPageCollab(workspaceId, page.id);
    const anchors = collab ? readAnchors(collab.doc_state, page.id) : new Map();

    return {
      page: { id: page.id, title: page.title },
      comments: comments.filter((comment) => !comment.is_deleted).map((comment) => ({
        id: comment.comment_id,
        parent_id: comment.reply_comment_id ?? null,
        content: comment.content,
        author_id: comment.user_id,
        created_at: comment.created_at,
        is_resolved: Boolean(comment.is_resolved),
        quote: anchors.get(comment.reply_comment_id ?? comment.comment_id)?.quote ?? null,
      })),
    };
  }

  /**
   * New thread (`quote` required) or reply (`replyToId`). `content` is stored as given; the caller adds any
   * "via <agent>" prefix. Returns what the audit trail and notifications need.
   */
  async function addComment({ workspaceId, userId, pageId, content, quote = null, replyToId = null }) {
    const text = typeof content === 'string' ? content.trim() : '';

    if (!text || text.length > COMMENT_MAX_CHARS) throw new CommentError('INVALID_INPUT', `content is required (at most ${COMMENT_MAX_CHARS} characters).`);
    const page = await commentablePage(workspaceId, pageId);
    let parent = null;
    let blockId = null;
    let anchorUpdate = null;

    if (replyToId) {
      parent = isUuid(replyToId) ? await store.getInlineComment(workspaceId, page.id, replyToId) : null;
      if (!parent || parent.is_deleted) throw new CommentError('NOT_FOUND', `Comment "${replyToId}" was not found on this page. Use list_comments to see the thread.`);
      blockId = parent.block_id ?? null;
    } else {
      if (typeof quote !== 'string' || !quote.trim()) {
        throw new CommentError('INVALID_INPUT', 'A new comment thread needs `quote`: text copied exactly from one paragraph of the page (use read_page). To answer an existing thread pass `reply_to` instead.');
      }
    }
    const commentId = newId();

    if (!replyToId) {
      const collab = await store.getPageCollab(workspaceId, page.id);

      if (!collab) throw new CommentError('NOT_READY', 'This page has not been opened yet; open it once in the app and try again.');
      const doc = new Y.Doc({ guid: page.id });

      try {
        Y.applyUpdate(doc, collab.doc_state);
        const wanted = quote.trim();
        const hit = textBlocksInOrder(doc).map((entry) => ({ ...entry, index: entry.text.toString().indexOf(wanted) })).find((entry) => entry.index >= 0);

        if (!hit) throw new CommentError('QUOTE_NOT_FOUND', 'That quote was not found in any single paragraph of the page. Copy it exactly (same spelling and case) from read_page, from one paragraph.');
        const before = Y.encodeStateVector(doc);

        doc.transact(() => anchorRange(hit.text, hit.index, hit.index + wanted.length, commentId));
        blockId = hit.blockId;
        anchorUpdate = { update: Y.encodeStateAsUpdate(doc, before), before, collab };
      } finally {
        doc.destroy();
      }
    }
    if (anchorUpdate) {
      const accepted = await store.acceptPageCollabUpdate({
        workspaceId, pageId: page.id, flags: 0, payload: anchorUpdate.update, beforeStateVector: anchorUpdate.before,
        collabVersion: anchorUpdate.collab.collab_version, restoreId: anchorUpdate.collab.restore_id ?? null, actorUserId: userId,
      });

      await broadcast({ workspaceId, collabType: 0, objectId: page.id, update: anchorUpdate.update, accepted }).catch(() => undefined);
    }
    const stamp = now();

    await store.createInlineComment({
      comment_id: commentId, workspace_id: workspaceId, view_id: page.id, block_id: blockId, user_id: userId,
      content: text, reply_comment_id: parent ? parent.comment_id : null, created_at: stamp, updated_at: stamp,
    });
    broadcastCommentChanged(workspaceId, page.id);
    await Promise.resolve(notify({ workspaceId, actorUserId: userId, page, commentId, blockId, parentUserId: parent?.user_id ?? null })).catch(() => undefined);
    return { comment_id: commentId, page_id: page.id, page_title: page.title, reply_to_id: parent?.comment_id ?? null, block_id: blockId };
  }

  async function commentOf(workspaceId, pageId, commentId) {
    const page = await commentablePage(workspaceId, pageId);
    const comment = isUuid(commentId) ? await store.getInlineComment(workspaceId, page.id, commentId) : null;

    if (!comment || comment.is_deleted) throw new CommentError('NOT_FOUND', `Comment "${commentId}" was not found on this page. Use list_comments to see the thread.`);
    return { page, comment };
  }

  async function resolveComment({ workspaceId, pageId, commentId, resolved }) {
    const { page, comment } = await commentOf(workspaceId, pageId, commentId);
    const was = Boolean(comment.is_resolved);

    if (was !== resolved) {
      await store.setInlineCommentResolved(workspaceId, page.id, comment.comment_id, resolved, now());
      broadcastCommentChanged(workspaceId, page.id);
    }
    return { page_id: page.id, page_title: page.title, comment_id: comment.comment_id, resolved, was_resolved: was, changed: was !== resolved };
  }

  // Best effort: the comment is already gone, so a page that cannot be updated just keeps a stale highlight.
  async function dropHighlight(workspaceId, page, commentId, userId) {
    try {
      const collab = await store.getPageCollab(workspaceId, page.id);

      if (!collab) return;
      const doc = new Y.Doc({ guid: page.id });

      try {
        Y.applyUpdate(doc, collab.doc_state);
        const before = Y.encodeStateVector(doc);

        if (!removeAnchor(doc, commentId)) return;
        const update = Y.encodeStateAsUpdate(doc, before);
        const accepted = await store.acceptPageCollabUpdate({
          workspaceId, pageId: page.id, flags: 0, payload: update, beforeStateVector: before,
          collabVersion: collab.collab_version, restoreId: collab.restore_id ?? null, actorUserId: userId,
        });

        await broadcast({ workspaceId, collabType: 0, objectId: page.id, update, accepted }).catch(() => undefined);
      } finally {
        doc.destroy();
      }
    } catch {
      // see above
    }
  }

  /** Removes one comment (what undoing an agent's comment does). Refuses when someone has replied to it since. */
  async function deleteComment({ workspaceId, userId = null, pageId, commentId, refuseIfReplies = true }) {
    const { page, comment } = await commentOf(workspaceId, pageId, commentId);

    if (refuseIfReplies && (await allComments(workspaceId, page.id)).some((other) => !other.is_deleted && other.reply_comment_id === comment.comment_id)) {
      throw new CommentError('CONFLICT', 'People have replied to this comment, so it was left alone.');
    }
    await store.softDeleteInlineComment(workspaceId, page.id, comment.comment_id, now());
    if (!comment.reply_comment_id) await dropHighlight(workspaceId, page, comment.comment_id, userId);
    broadcastCommentChanged(workspaceId, page.id);
    return { removed: true };
  }

  return { listComments, addComment, resolveComment, deleteComment };
}
