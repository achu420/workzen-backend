// Card history: a readable record of who changed which fields of a card, and a way to put the old values back.
//
// Every accepted change to a card's row document (a person typing in the browser, or an agent through MCP) starts or
// extends a short window per card. When the card has been quiet for a moment the server compares the card as it was
// before the window with the card now, and stores one entry: who (everyone who edited, the last one credited; the agent's
// name when an agent did it), the title, and the field values before and after. Nothing is stored for edits that
// changed nothing. Restoring an entry puts the old values back, but only if the card still looks the way that entry
// left it, so it never overwrites someone's later edit.
import { currentActor, runAsActor } from './actor-context.js';

const MAX_RESTORABLE_CHARS = 10_000;
const SIMPLE_VALUE = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value) || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export class RestoreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The part of a card that history tracks. */
export function snapshotOf(card) {
  return { title: card.title ?? '', fields: { ...(card.fields ?? {}) }, archived: Boolean(card.archived), database_id: card.database_id ?? null };
}

/** Changes between two snapshots: the title, each field whose value differs, and archived state. */
export function diffSnapshots(before, after) {
  const changes = [];
  const restorable = (a, b) => SIMPLE_VALUE(a) && SIMPLE_VALUE(b) && JSON.stringify(a ?? null).length <= MAX_RESTORABLE_CHARS && JSON.stringify(b ?? null).length <= MAX_RESTORABLE_CHARS;

  if (before.title !== after.title) changes.push({ kind: 'title', field: 'Title', before: before.title, after: after.title, restorable: true });
  for (const name of [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])]) {
    const was = before.fields[name] ?? null;
    const now = after.fields[name] ?? null;

    if (!same(was, now)) changes.push({ kind: 'field', field: name, before: was, after: now, restorable: restorable(was, now) });
  }
  if (before.archived !== after.archived) changes.push({ kind: 'archived', field: 'Archived', before: before.archived, after: after.archived, restorable: true });
  return changes;
}

export function createCardHistory({ store, cards, quietMs = 15_000, maxMs = 60_000, now = () => new Date().toISOString(), onError = (error) => console.warn('[card-history]', error?.message) }) {
  const pending = new Map();
  const keyOf = (workspaceId, rowId) => `${workspaceId}:${rowId}`;

  const snapshot = async (workspaceId, rowId) => {
    try {
      return snapshotOf(await cards.getCard({ workspaceId, cardId: rowId }));
    } catch {
      return null; // not a card (hidden template row, deleted, ...): nothing to track
    }
  };

  async function record(entry) {
    const after = await snapshot(entry.workspaceId, entry.rowId);
    const before = await entry.beforePromise;

    if (!before || !after) return null;
    const changes = diffSnapshots(before, after);

    if (!changes.length) return null;
    const editors = [...entry.editors];

    return store.recordCardHistory({
      id: crypto.randomUUID(), workspace_id: entry.workspaceId, database_id: after.database_id ?? before.database_id ?? '', row_id: entry.rowId, title: after.title,
      actor_user_id: editors.at(-1) ?? null, actor_user_ids: editors, via: entry.via, changes, created_at: now(),
    });
  }

  async function fire(key) {
    const entry = pending.get(key);

    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    try {
      await record(entry);
    } catch (error) {
      onError(error);
    }
  }

  function arm(key, entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void fire(key), Math.max(0, Math.min(quietMs, entry.firstAt + maxMs - Date.now())));
    entry.timer.unref?.();
  }

  // Opens (or joins) this card's window and waits until the "before" picture is taken.
  async function begin(workspaceId, rowId) {
    const key = keyOf(workspaceId, rowId);
    let entry = pending.get(key);

    if (!entry) {
      // The card as it is BEFORE this window's first change is applied.
      entry = { workspaceId, rowId, editors: new Set(), via: null, firstAt: Date.now(), timer: null, beforePromise: snapshot(workspaceId, rowId) };
      pending.set(key, entry);
    }
    await entry.beforePromise; // every change in the window waits for the "before" picture to be taken first
    return entry;
  }

  function end(entry, userId, via) {
    if (userId) { entry.editors.delete(userId); entry.editors.add(userId); }
    if (via) entry.via = via;
    arm(keyOf(entry.workspaceId, entry.rowId), entry);
  }

  function attach() {
    if (store.__cardHistoryAttached) return;
    store.__cardHistoryAttached = true;
    const original = store.acceptDatabaseRowCollabUpdate;

    if (typeof original !== 'function') return;
    store.acceptDatabaseRowCollabUpdate = async function wrapped(...args) {
      const params = args[0] ?? {};
      const actor = currentActor();
      let entry = null;

      try {
        entry = await begin(params.workspaceId, params.rowId);
      } catch (error) {
        onError(error);
      }
      const result = await original.apply(this, args);

      try {
        if (entry && !result?.duplicate) end(entry, params.actorUserId ?? actor?.userId ?? null, actor?.via ?? null);
      } catch (error) {
        onError(error);
      }
      return result;
    };
    // Archiving and restoring a card are card-service operations (agents, undo): note them as a change of the card.
    for (const method of ['archiveCard', 'restoreCard']) {
      const service = cards[method];

      if (typeof service !== 'function') continue;
      cards[method] = async function wrappedCardMethod(args, ...rest) {
        const actor = currentActor();
        let entry = null;

        try {
          entry = await begin(args.workspaceId, args.cardId);
        } catch (error) {
          onError(error);
        }
        const result = await service.call(this, args, ...rest);

        try {
          if (entry) end(entry, args.userId ?? actor?.userId ?? null, actor?.via ?? null);
        } catch (error) {
          onError(error);
        }
        return result;
      };
    }
  }

  /** Saves every waiting window now (graceful shutdown and tests). */
  async function flush() {
    await Promise.all([...pending.keys()].map((key) => fire(key)));
  }

  function close() {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  }

  /** Puts an entry's old values back. Throws RestoreError (404/409/400) instead of touching a card that moved on. */
  async function restore({ workspaceId, userId, entry }) {
    if (entry.restored_at) throw new RestoreError(409, 'ALREADY_RESTORED', 'This change was already restored.');
    const current = await cards.getCard({ workspaceId, cardId: entry.row_id }).then(snapshotOf).catch((error) => {
      if (error?.code === 'NOT_FOUND') throw new RestoreError(404, 'CARD_NOT_FOUND', 'That card no longer exists.');
      throw error;
    });
    const changes = entry.changes.filter((change) => change.restorable);

    if (!changes.length) throw new RestoreError(400, 'NOT_RESTORABLE', 'This change cannot be restored automatically.');
    const moved = changes.filter((change) => {
      const now = change.kind === 'title' ? current.title : change.kind === 'archived' ? current.archived : current.fields[change.field] ?? null;

      return !same(now, change.after);
    });

    if (moved.length) {
      throw new RestoreError(409, 'CHANGED_SINCE', `${moved.map((change) => `"${change.field}"`).join(', ')} ${moved.length === 1 ? 'was' : 'were'} changed after this edit, so nothing was touched. Review the card and fix it by hand.`);
    }
    const archived = changes.find((change) => change.kind === 'archived');
    const title = changes.find((change) => change.kind === 'title');
    const fields = Object.fromEntries(changes.filter((change) => change.kind === 'field').map((change) => [change.field, change.before]));

    await runAsActor({ userId, via: null }, async () => {
      // An archived card cannot be edited: bring it back first, or archive it only after the other values are restored.
      if (archived && archived.before === false) await cards.restoreCard({ workspaceId, userId, cardId: entry.row_id, confirm: true });
      if (title || Object.keys(fields).length) await cards.updateCard({ workspaceId, userId, cardId: entry.row_id, ...(title ? { title: title.before } : {}), ...(Object.keys(fields).length ? { fields } : {}) });
      if (archived && archived.before === true) await cards.archiveCard({ workspaceId, userId, cardId: entry.row_id, confirm: true });
    });
    await store.markCardHistoryRestored(workspaceId, entry.id, userId, now());
  }

  return { attach, flush, close, restore, pendingCount: () => pending.size };
}
