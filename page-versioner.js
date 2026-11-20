// Automatic document history. Whenever a page is edited the server remembers who touched it; once the page has been
// quiet for a few minutes (or has been edited for ten minutes straight) it saves a version of the whole document,
// credited to the people who edited it since the last one. People can then browse and restore it from the page's
// version history without ever having pressed "save version".
//
// Only the newest `keepAuto` automatic versions per page are kept visible; versions someone saved by hand, and the
// "before restore" safety copies, are never touched. Versions identical to the previous one are not stored.
import * as Y from 'yjs';

export function createPageVersioner(store, { quietMs = 3 * 60_000, maxMs = 10 * 60_000, keepAuto = 100, now = Date.now, onError = (error) => console.warn('[versions]', error?.message) } = {}) {
  const pending = new Map();

  const keyOf = (workspaceId, pageId) => `${workspaceId}:${pageId}`;

  async function uidsOf(userIds) {
    const uids = [];

    for (const userId of userIds) {
      const user = userId ? await store.getUserById(userId) : null;
      const uid = user ? Number(user.uid) : NaN;

      if (Number.isSafeInteger(uid) && !uids.includes(uid)) uids.push(uid);
    }
    return uids;
  }

  async function snapshot(entry) {
    const { workspaceId, pageId } = entry;
    const collab = await store.getPageCollab(workspaceId, pageId);

    if (!collab) return null;
    const versions = await store.listPageCollabVersions(workspaceId, pageId, {});

    if (versions === null) return null;
    const latest = versions.filter((version) => !version.deleted_at).at(-1);
    const current = new Y.Doc();

    Y.applyUpdate(current, collab.doc_state);
    try {
      if (latest) {
        const previous = new Y.Doc();

        Y.applyUpdate(previous, Uint8Array.from(latest.document_state));
        const unchanged = Buffer.from(Y.encodeStateVector(previous)).equals(Buffer.from(Y.encodeStateVector(current)));

        previous.destroy();
        if (unchanged) return null;
      }
      const editors = await uidsOf([...entry.editors]);
      const created = await store.createPageCollabVersion(workspaceId, pageId, {
        name: null,
        documentState: Y.encodeStateAsUpdate(current),
        actorUid: editors.at(-1) ?? null,
        kind: 'auto',
        editors,
      });

      await store.pruneAutoPageVersions?.(workspaceId, pageId, keepAuto);
      return created;
    } finally {
      current.destroy();
    }
  }

  async function fire(key) {
    const entry = pending.get(key);

    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    try {
      await snapshot(entry);
    } catch (error) {
      onError(error);
    }
  }

  /** A page was edited by `userId` (may be null for system edits). */
  function touch(workspaceId, pageId, userId) {
    const key = keyOf(workspaceId, pageId);
    const at = now();
    const entry = pending.get(key) ?? { workspaceId, pageId, editors: new Set(), firstAt: at, timer: null };

    if (userId) {
      entry.editors.delete(userId);
      entry.editors.add(userId); // most recent editor last
    }
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void fire(key), Math.max(0, Math.min(quietMs, entry.firstAt + maxMs - at)));
    entry.timer.unref?.();
    pending.set(key, entry);
  }

  function attach() {
    if (store.__pageVersionerAttached) return;
    store.__pageVersionerAttached = true;
    const original = store.acceptPageCollabUpdate;

    if (typeof original !== 'function') return;
    store.acceptPageCollabUpdate = async function wrapped(...args) {
      const result = await original.apply(this, args);

      try {
        if (!result?.duplicate && args[0]?.pageId) touch(args[0].workspaceId, args[0].pageId, args[0].actorUserId ?? null);
      } catch (error) {
        onError(error);
      }
      return result;
    };
  }

  /** Saves everything still waiting (used when the server shuts down and by tests). */
  async function flush() {
    await Promise.all([...pending.keys()].map((key) => fire(key)));
  }

  function close() {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  }

  return { attach, touch, flush, close, pendingCount: () => pending.size };
}
