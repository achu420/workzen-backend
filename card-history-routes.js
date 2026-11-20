// Card history for the web app: list what changed on a card, and restore an entry.
//   GET  /api/workspace/{ws}/card-history/{rowId}?limit&before
//   POST /api/workspace/{ws}/card-history/{rowId}/{entryId}/restore
// Anyone in the workspace can read a card's history and restore a change (everyone can edit cards anyway).
import { CardError } from './cards.js';
import { RestoreError } from './card-history.js';
import { makeCursor, parseCursor } from './agent-routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOWN_CHARS = 400;

const shorten = (value) => {
  if (typeof value === 'string') return value.length > SHOWN_CHARS ? `${value.slice(0, SHOWN_CHARS)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(shorten);
  return value;
};

export function createCardHistoryRoutes({ store, cards, cardHistory, helpers }) {
  const { requireWorkspace, send, appFlowyResponse, now } = helpers;
  const fail = (res, status, code, message) => send(res, status, { code, message, error: { code, message } });

  async function handle({ req, res, url, parts, method }) {
    if (parts[0] !== 'api' || parts[1] !== 'workspace' || !parts[2] || parts[3] !== 'card-history' || !parts[4]) return false;
    const isList = parts.length === 5 && method === 'GET';
    const isRestore = parts.length === 7 && parts[6] === 'restore' && method === 'POST';

    if (!isList && !isRestore) return false;
    const access = await requireWorkspace(store, req, res, parts[2]);

    if (!access) return true;
    const rowId = parts[4];
    const card = UUID.test(rowId) ? await cards.getCard({ workspaceId: access.workspace.id, cardId: rowId }).catch((error) => {
      if (error instanceof CardError) return null;
      throw error;
    }) : null;

    if (!card) { fail(res, 404, 'CARD_NOT_FOUND', 'Card not found'); return true; }
    if (isList) {
      const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20));
      const before = url.searchParams.get('before');

      const cursor = parseCursor(before);

      if (before && !cursor) { fail(res, 400, 'INVALID_INPUT', 'before must be a timestamp or a cursor returned by this API'); return true; }
      const page = await store.listCardHistory(access.workspace.id, rowId, { limit, before: cursor?.at ?? null, beforeId: cursor?.id ?? null });
      const members = new Map((await store.listWorkspaceMembers(access.workspace.id)).map(({ user }) => [user.id, { user_id: user.id, name: user.name || user.email, email: user.email }]));
      const entries = page.entries.map((entry) => ({
        id: entry.id,
        created_at: entry.created_at,
        title: entry.title,
        actors: (entry.actor_user_ids?.length ? entry.actor_user_ids : [entry.actor_user_id]).filter(Boolean).map((id) => members.get(id) ?? { user_id: id, name: 'Former member', email: null }),
        via: entry.via ?? null,
        changes: entry.changes.map((change) => ({ kind: change.kind, field: change.field, before: shorten(change.before), after: shorten(change.after), restorable: Boolean(change.restorable) })),
        can_restore: !entry.restored_at && entry.changes.some((change) => change.restorable),
        restored: Boolean(entry.restored_at),
        restored_at: entry.restored_at ?? null,
      }));

      send(res, 200, appFlowyResponse({ entries, has_more: page.has_more, next_before: page.has_more ? makeCursor(page.entries.at(-1)) : null }), { 'cache-control': 'private, no-store' });
      return true;
    }
    const entry = UUID.test(parts[5]) ? await store.getCardHistory(access.workspace.id, parts[5]) : null;

    if (!entry || entry.row_id !== rowId) { fail(res, 404, 'HISTORY_NOT_FOUND', 'History entry not found'); return true; }
    try {
      await cardHistory.restore({ workspaceId: access.workspace.id, userId: access.user.id, entry });
    } catch (error) {
      if (error instanceof RestoreError) { fail(res, error.status, error.code, error.message); return true; }
      if (error instanceof CardError) { fail(res, error.code === 'NOT_FOUND' ? 404 : 400, error.code, error.message); return true; }
      throw error;
    }
    send(res, 200, appFlowyResponse({ id: entry.id, restored: true, at: now() }));
    return true;
  }

  return { handle };
}
