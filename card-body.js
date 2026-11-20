// One place that reads a card's body (the document of its row-detail page), shared by the per-card AI chat and the
// MCP card tools so both see exactly the same text.
//
// How the body is found, same as the web client (src/application/row-document/lifecycle.ts): the row document id is
// rowDocumentIdFromRowId(rowId) (UUIDv5 'document_id' of the row id) and that id is also the Folder page id of the
// "orphaned" row-detail page (no parent space; created lazily by POST /orphaned-view or the atomic row-document
// route, with `extra.row_document.source`). Its collab is a normal Document, read here with the same extractor the
// search index uses (every text block in document order: paragraphs, headings, lists, to-dos, quotes, callouts, code,
// toggles, table cells; link and mention text included).
//
// Never creates anything: a card whose body was never opened or typed has no row document, which is a normal result.
import { extractDocumentText } from './search-text.js';
import { rowDocumentIdFromRowId } from './page-document.js';

export const DEFAULT_CARD_BODY_CHARS = 12_000;

const NO_BODY = Object.freeze({ text: '', truncated: false, has_document: false });

/**
 * @returns {Promise<{text: string, truncated: boolean, has_document: boolean}>}
 *   text: plain body text (blocks joined by newlines), cut to `maxChars`;
 *   truncated: true when the body was longer than `maxChars`;
 *   has_document: true when the card has a row document (even an empty one);
 *   total_chars: full body length; next_offset: where to continue when truncated, else null.
 *   `offset` starts the returned slice that many characters into the body (for paging long bodies).
 */
export async function readCardBody({ store, workspaceId, databaseId, rowId, maxChars = DEFAULT_CARD_BODY_CHARS, offset = 0 }) {
  if (!store || !workspaceId || !rowId) return { ...NO_BODY };
  const documentPage = await store.getPage(rowDocumentIdFromRowId(rowId));

  if (!documentPage || documentPage.workspace_id !== workspaceId || documentPage.is_trashed) return { ...NO_BODY };
  // A row document that declares a different source database is not this card's body.
  const sourceDatabaseId = documentPage.extra?.row_document?.source?.database_id;

  if (databaseId && sourceDatabaseId && sourceDatabaseId !== databaseId) return { ...NO_BODY };
  const collab = await store.getPageCollab(workspaceId, documentPage.id);

  if (!collab) return { ...NO_BODY };
  const full = extractDocumentText(collab.doc_state).trim();
  const limit = Math.max(0, Math.floor(maxChars));
  const start = Math.min(full.length, Math.max(0, Math.floor(offset)));
  const end = Math.min(full.length, start + limit);
  const truncated = end < full.length;

  return { text: full.slice(start, end), truncated, has_document: true, total_chars: full.length, next_offset: truncated ? end : null };
}
