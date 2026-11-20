// Card (database row) comments. They live in the row's own Yjs document, exactly where the web app keeps them
// (data.comment: a map of comment id -> map, see AppFlowy-Web application/database-yjs/row_comment.ts), so people and
// agents see the same thread. These are pure helpers over a decoded row Y.Doc; storage and fan-out stay in cards.js.
import * as Y from 'yjs';

const unixNow = (now) => Math.floor(now().getTime() / 1000);

function commentsRoot(doc) {
  return doc.getMap('data').get('comment') ?? null;
}

/** @returns {{id, parent_id, content, author_id, created_at, updated_at, is_resolved, resolved_by, resolved_at}[]} oldest first */
export function readRowComments(doc) {
  const root = commentsRoot(doc);
  const comments = [];

  if (!root) return comments;
  root.forEach((map, key) => {
    if (!(map instanceof Y.Map)) return;
    comments.push({
      id: map.get('id') || key,
      parent_id: map.get('parent_comment_id') || null,
      content: String(map.get('content') ?? ''),
      author_id: String(map.get('author_id') ?? ''),
      created_at: Number(map.get('created_at') ?? 0),
      updated_at: Number(map.get('updated_at') ?? 0),
      is_resolved: Boolean(map.get('is_resolved')),
      resolved_by: map.get('resolved_by') || null,
      resolved_at: Number(map.get('resolved_at') ?? 0) || null,
    });
  });
  return comments.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}

export function addRowComment(doc, { id, parentId = null, content, authorId, now = () => new Date() }) {
  const data = doc.getMap('data');
  let root = data.get('comment');
  const stamp = unixNow(now);

  if (!root) {
    root = new Y.Map();
    data.set('comment', root);
  }
  const map = new Y.Map();

  map.set('id', id);
  map.set('parent_comment_id', parentId || '');
  map.set('content', content);
  map.set('author_id', authorId);
  map.set('created_at', stamp);
  map.set('updated_at', stamp);
  map.set('is_resolved', false);
  map.set('resolved_by', '');
  map.set('resolved_at', 0);
  map.set('reactions', '{}');
  map.set('attachments', '[]');
  root.set(id, map);
}

/** Returns false when the comment does not exist or is already in that state. */
export function setRowCommentResolved(doc, { id, resolved, userId, now = () => new Date() }) {
  const map = commentsRoot(doc)?.get(id);

  if (!(map instanceof Y.Map) || Boolean(map.get('is_resolved')) === resolved) return false;
  const stamp = unixNow(now);

  map.set('is_resolved', resolved);
  map.set('resolved_by', resolved ? userId : '');
  map.set('resolved_at', resolved ? stamp : 0);
  map.set('updated_at', stamp);
  return true;
}

export function deleteRowComment(doc, id) {
  const root = commentsRoot(doc);

  if (!root?.has(id)) return false;
  root.delete(id);
  return true;
}
