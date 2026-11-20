// Tells connected clients that the Folder tree (sidebar pages, database views) changed.
//
// The web client only rebuilds its outline when it receives a FolderChanged notification;
// until now only the rename routes sent one, so a page, database or database view created
// in one tab (or by an agent) stayed invisible, or showed as an unselectable tab, until a
// manual refresh. The hook lives at the store layer, like the search index, so every route
// and service that changes the page tree is covered without touching each call site.
// Bursts (a template creating many pages, several quick renames) coalesce into one event.

const isHiddenRowDocument = (page) => Boolean(page) && page.parent_view_id == null && Boolean(page.extra?.row_document);

export function createFolderNotifier(store, { send, delayMs = 150, onError = (error) => console.error('folder notifier failed', error) } = {}) {
  const pending = new Map();

  function flushWorkspace(workspaceId) {
    const timer = pending.get(workspaceId);

    if (timer === undefined) return;
    clearTimeout(timer);
    pending.delete(workspaceId);
    try {
      send(workspaceId);
    } catch (error) {
      onError(error);
    }
  }

  function notify(workspaceId) {
    if (!workspaceId || pending.has(workspaceId)) return;
    const timer = setTimeout(() => flushWorkspace(workspaceId), delayMs);

    timer.unref?.();
    pending.set(workspaceId, timer);
  }

  /** Send anything still waiting (tests, shutdown). */
  function flush() {
    for (const workspaceId of [...pending.keys()]) flushWorkspace(workspaceId);
  }

  function wrap(name, after, { withPage = false } = {}) {
    const original = store[name];

    if (typeof original !== 'function') return;
    store[name] = async function wrapped(...args) {
      let before = null;

      if (withPage) {
        try { before = await store.getPage(args[0]); } catch { before = null; }
      }
      const result = await original.apply(this, args);

      try {
        after(args, result, before);
      } catch (error) {
        onError(error);
      }
      return result;
    };
  }

  const applied = (result) => result?.outcome !== 'already_applied';
  const visiblePage = (workspaceId, result, before) => Boolean(result) && !isHiddenRowDocument(before);

  function attach() {
    if (store.__folderNotifierAttached) return;
    store.__folderNotifierAttached = true;
    wrap('createSpace', ([space]) => notify(space.workspace_id));
    wrap('createPage', ([page]) => { if (!isHiddenRowDocument(page)) notify(page.workspace_id); });
    wrap('createAtomicDocumentPage', ([page], result) => { if (applied(result) && !isHiddenRowDocument(page)) notify(page.workspace_id); });
    wrap('createAtomicDatabasePage', ([container], result) => { if (applied(result)) notify(container.workspace_id); });
    wrap('createAtomicDatabaseView', ([params], result) => { if (applied(result)) notify(params.workspaceId); });
    wrap('createDatabaseFromTemplate', ([params], result) => { if (applied(result)) notify(params.containerPage.workspace_id); });
    wrap('createDocumentTreeFromTemplate', ([params], result) => { if (applied(result)) notify(params.entries[0]?.page.workspace_id); });
    // Metadata that shows in the sidebar, and removal/restoration of pages.
    wrap('updatePage', ([, workspaceId], result, before) => { if (visiblePage(workspaceId, result, before)) notify(workspaceId); }, { withPage: true });
    wrap('updatePageTitle', ([, workspaceId], result, before) => { if (visiblePage(workspaceId, result ?? true, before)) notify(workspaceId); }, { withPage: true });
    wrap('updatePageMetadata', ([, workspaceId], result, before) => { if (visiblePage(workspaceId, result ?? true, before)) notify(workspaceId); }, { withPage: true });
    wrap('setPageTrashed', ([, workspaceId], result, before) => { if (visiblePage(workspaceId, result, before)) notify(workspaceId); }, { withPage: true });
    wrap('deletePagePermanently', ([, workspaceId], result, before) => { if (visiblePage(workspaceId, result, before)) notify(workspaceId); }, { withPage: true });
  }

  return { notify, flush, attach, pendingCount: () => pending.size };
}
