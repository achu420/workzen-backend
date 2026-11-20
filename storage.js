import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { preparePageCollabUpdate } from './postgres-collab-repository.js';
import { buildDatabaseCatalogFromPages } from './database-catalog.js';
import { addDatabaseView } from './database-document.js';
import { createAiJsonStorage } from './ai-storage.js';
import { scoreSearchDocument } from './search-text.js';

export const emptyState = () => ({ schema_version: 1, users: {}, workspaces: {}, memberships: {}, spaces: {}, pages: {}, sessions: {}, workspaceDatabaseCollabs: {}, pageCollabDocuments: {}, pageCollabUpdates: {}, workspaceRids: {}, atomicCreationRequests: {}, pageCollabVersions: {}, pageCollabRestoreEvents: {}, databaseCollabDocuments: {}, databaseCollabUpdates: {}, databaseRowCollabDocuments: {}, databaseRowCollabUpdates: {}, atomicRowCreationRequests: {}, atomicViewCreationRequests: {}, seededRowCreationRequests: {}, recentPages: {}, inlineComments: {}, inlineCommentReactions: {}, notifications: {} });

export async function openStore(file, options = {}) {
  if (options.storage === 'postgres') {
    const { openPostgresStore } = await import('./postgres-storage.js');
    return openPostgresStore(options.databaseUrl);
  }
  await mkdir(path.dirname(file), { recursive: true });
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = emptyState();
    await persist(file, state);
  }
  for (const key of Object.keys(emptyState())) if (state[key] === undefined) state[key] = {};
  const knownUids = new Set(Object.values(state.users).map((user) => Number(user.uid)).filter(Number.isSafeInteger));
  let migratedUsers = false;
  for (const user of Object.values(state.users)) {
    if (Number.isSafeInteger(user.uid) && user.uid > 0) continue;
    let uid;
    do { uid = randomInt(1, 2 ** 48); } while (knownUids.has(uid));
    user.uid = uid;
    knownUids.add(uid);
    migratedUsers = true;
  }
  if (migratedUsers) await persist(file, state);
  const store = { kind: 'json', file, state, atomicCreationQueue: Promise.resolve(), pageCollabUpdateQueue: Promise.resolve(), databaseCollabUpdateQueue: Promise.resolve(), atomicRowCreationQueue: Promise.resolve(), databaseRowCollabUpdateQueue: Promise.resolve(), atomicViewCreationQueue: Promise.resolve() };
  store.getUserByEmail = async (email) => Object.values(store.state.users).find((u) => u.email === email) || null;
  store.getUserById = async (id) => store.state.users[id] || null;
  // Supports POST /api/user/update.
  store.updateUserPassword = async (userId, passwordHash, keepSessionHash = null) => mutate(store, (s) => {
    const user = s.users[userId];

    if (!user) return null;
    user.password_hash = passwordHash;
    // A password change signs every other device out; the session that made the change stays.
    for (const [hash, session] of Object.entries(s.sessions)) {
      if (session.user_id === userId && hash !== keepSessionHash) delete s.sessions[hash];
    }
    return user;
  });
  store.updateUserProfile = async (id, { name, metadata }) => mutate(store, (s) => {
    const user = s.users[id];

    if (!user) return null;
    if (name !== undefined) user.name = name;
    if (metadata !== undefined) user.metadata = metadata;
    return user;
  });
  store.getSession = async (hash) => store.state.sessions[hash] || null;
  store.getSessionByRefreshHash = async (refreshHash) => {
    const entry = Object.entries(store.state.sessions).find(([, session]) => session.refresh_token_hash === refreshHash);
    return entry ? { access_token_hash: entry[0], ...entry[1] } : null;
  };
  store.saveUser = async (user) => mutate(store, (s) => { s.users[user.id] = user; });
  store.createUserWithWorkspace = async (user, workspace, membership) => mutate(store, (s) => {
    if (Object.values(s.users).some((candidate) => candidate.uid === user.uid)) {
      const error = new Error('User ID already exists');
      error.code = 'UID_EXISTS';
      throw error;
    }
    s.users[user.id] = user;
    s.workspaces[workspace.id] = workspace;
    s.memberships[`${membership.workspace_id}:${membership.user_id}`] = membership;
  });
  store.saveSession = async (hash, session) => mutate(store, (s) => { s.sessions[hash] = session; });
  store.revokeSession = async (hash) => mutate(store, (s) => { delete s.sessions[hash]; });
  store.rotateSession = async (oldAccessHash, newAccessHash, expectedRefreshHash, session) => mutate(store, (s) => {
    const current = s.sessions[oldAccessHash];
    if (!current || current.refresh_token_hash !== expectedRefreshHash || current.refresh_expires_at <= new Date().toISOString() || s.sessions[newAccessHash]) return false;
    delete s.sessions[oldAccessHash];
    s.sessions[newAccessHash] = session;
    return true;
  });
  store.createWorkspace = async (workspace, membership) => mutate(store, (s) => { s.workspaces[workspace.id] = workspace; s.memberships[`${membership.workspace_id}:${membership.user_id}`] = membership; });
  store.listWorkspaces = async (userId) => Object.values(store.state.workspaces).filter((w) => store.state.memberships[`${w.id}:${userId}`]);
  // Supports PUT /api/workspace/{id}/open -- tracks which workspace a user
  // most recently switched to, so GET /api/user/workspace's
  // visiting_workspace reflects the switch instead of always reporting the
  // user's first-ever (insertion-order) workspace. Mirrors Postgres mode's
  // `last_visited_at` column/ORDER BY exactly (see migrations/010).
  store.markWorkspaceVisited = async (userId, workspaceId) => mutate(store, (s) => {
    const membership = s.memberships[`${workspaceId}:${userId}`];
    if (membership) membership.last_visited_at = new Date().toISOString();
  });
  store.listWorkspaceBootstrapRows = async (userId) => Object.values(store.state.workspaces)
    .filter((workspace) => store.state.memberships[`${workspace.id}:${userId}`])
    .map((workspace) => ({
      workspace,
      membership: store.state.memberships[`${workspace.id}:${userId}`],
      member_count: Object.values(store.state.memberships).filter((membership) => membership.workspace_id === workspace.id).length,
    }))
    .sort((a, b) => (b.membership.last_visited_at ?? '').localeCompare(a.membership.last_visited_at ?? ''));
  store.getWorkspace = async (workspaceId) => store.state.workspaces[workspaceId] || null;
  store.createSpace = async (space) => mutate(store, (s) => {
    if (s.spaces[space.id]) {
      const error = new Error('Space ID already exists');
      error.code = 'SPACE_EXISTS';
      throw error;
    }
    s.spaces[space.id] = space;
  });
  store.listSpaces = async (workspaceId) => Object.values(store.state.spaces).filter((space) => space.workspace_id === workspaceId);
  store.getSpace = async (spaceId) => store.state.spaces[spaceId] || null;
  store.getOrCreateWorkspaceDatabaseCollab = async (workspaceId, objectId, initialDocState) => {
    const workspace = store.state.workspaces[workspaceId];
    if (!workspace || workspace.database_storage_id !== objectId) return null;
    const existing = store.state.workspaceDatabaseCollabs[workspaceId];
    if (existing && existing.object_id !== objectId) {
      const error = new Error('Stored workspace database collaboration object does not match workspace');
      error.code = 'WORKSPACE_DATABASE_COLLAB_ID_MISMATCH';
      throw error;
    }
    if (existing) return { object_id: existing.object_id, doc_state: new Uint8Array(existing.doc_state) };
    const collab = { object_id: objectId, doc_state: Array.from(initialDocState) };
    await mutate(store, (s) => { s.workspaceDatabaseCollabs[workspaceId] = collab; });
    return { object_id: collab.object_id, doc_state: new Uint8Array(collab.doc_state) };
  };
  store.getMembership = async (workspaceId, userId) => store.state.memberships[`${workspaceId}:${userId}`] || null;
  // Task 79: supports GET /mentionable-person (the @-mention list is every
  // member of the workspace).
  store.listWorkspaceMembers = async (workspaceId) => Object.values(store.state.memberships)
    .filter((m) => m.workspace_id === workspaceId)
    .map((membership) => ({ membership, user: store.state.users[membership.user_id] }))
    .filter((row) => row.user);
  // Task 79: supports POST /add-recent-pages. Per-user, most-recent-first,
  // capped so an active user's list can't grow without bound.
  store.addRecentPages = async (workspaceId, userId, viewIds) => mutate(store, (s) => {
    if (!viewIds.length) return;
    const key = `${workspaceId}:${userId}`;
    const existing = s.recentPages[key] ?? [];
    const merged = [...viewIds, ...existing.filter((id) => !viewIds.includes(id))];

    s.recentPages[key] = merged.slice(0, 50);
  });
  // --- Workspace search index ---
  // Held in memory only: search-index.js rebuilds it on every start (backfill),
  // so it never bloats or slows writes to the persisted state file.
  const searchDocs = new Map();
  store.upsertSearchDocuments = async (docs) => { for (const doc of docs) searchDocs.set(`${doc.workspace_id}:${doc.object_id}`, { ...doc }); };
  store.deleteSearchDocuments = async (workspaceId, objectIds) => { for (const objectId of objectIds) searchDocs.delete(`${workspaceId}:${objectId}`); };
  store.listSearchDocumentRefs = async (workspaceId, { kind, databaseId } = {}) => [...searchDocs.values()]
    .filter((doc) => doc.workspace_id === workspaceId && (!kind || doc.kind === kind) && (!databaseId || doc.database_id === databaseId))
    .map((doc) => ({ object_id: doc.object_id, kind: doc.kind, database_id: doc.database_id ?? null }));
  store.querySearchDocuments = async (workspaceId, terms, { max = 500 } = {}) => [...searchDocs.values()]
    .filter((doc) => doc.workspace_id === workspaceId && scoreSearchDocument(doc, terms) !== null)
    .slice(0, max)
    .map((doc) => ({ ...doc }));
  store.listWorkspaceIds = async () => Object.keys(store.state.workspaces);
  store.getRecentPages = async (workspaceId, userId) => [...(store.state.recentPages?.[`${workspaceId}:${userId}`] ?? [])];
  // Workspace invite codes: one active code per workspace (a new code replaces the old one).
  // The map is created lazily so older state files need no migration.
  const liveInviteCode = (row) => (row && (!row.expires_at || row.expires_at > new Date().toISOString()) ? { ...row } : null);
  store.getWorkspaceInviteCode = async (workspaceId) => liveInviteCode(store.state.workspaceInviteCodes?.[workspaceId]);
  store.findWorkspaceInviteCodeByCode = async (code) => liveInviteCode(Object.values(store.state.workspaceInviteCodes ?? {}).find((row) => row.code === code));
  store.setWorkspaceInviteCode = async ({ workspaceId, code, createdBy, createdAt, expiresAt }) => mutate(store, (s) => {
    s.workspaceInviteCodes ??= {};
    s.workspaceInviteCodes[workspaceId] = { workspace_id: workspaceId, code, created_by: createdBy, created_at: createdAt, expires_at: expiresAt ?? null };
  });
  store.deleteWorkspaceInviteCode = async (workspaceId) => mutate(store, (s) => { if (s.workspaceInviteCodes) delete s.workspaceInviteCodes[workspaceId]; });
  // Per-workspace member profile (name/avatar/cover/description), stored on the membership.
  store.updateMembershipProfile = async (workspaceId, userId, profile) => mutate(store, (s) => {
    const membership = s.memberships[`${workspaceId}:${userId}`];

    if (!membership) return null;
    membership.profile = profile;
    return membership;
  });
  // Agent (MCP) tokens. The map is created lazily so older state files need no migration.
  const agentTokenRow = (row) => (row ? { ...row } : null);
  // --- E-mail invitations (see migration 020): pending offers to join a workspace, keyed by e-mail ---
  const openInvitation = (row) => row && !row.accepted_at && row.expires_at > new Date().toISOString();
  store.upsertWorkspaceInvitation = async (invitation) => mutate(store, (s) => {
    s.workspaceInvitations ??= {};
    const existing = Object.values(s.workspaceInvitations).find((row) => !row.accepted_at && row.workspace_id === invitation.workspace_id && row.email === invitation.email);
    const next = existing ? { ...existing, role: invitation.role, invited_by: invitation.invited_by, created_at: invitation.created_at, expires_at: invitation.expires_at } : { accepted_at: null, ...invitation };

    s.workspaceInvitations[next.id] = next;
    return { ...next };
  });
  store.listWorkspaceInvitations = async (workspaceId) => Object.values(store.state.workspaceInvitations ?? {})
    .filter((row) => row.workspace_id === workspaceId && openInvitation(row))
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
    .map((row) => ({ ...row }));
  store.findOpenInvitationsByEmail = async (email) => Object.values(store.state.workspaceInvitations ?? {})
    .filter((row) => row.email === email && openInvitation(row))
    .map((row) => ({ ...row }));
  store.acceptWorkspaceInvitation = async (id, at) => mutate(store, (s) => {
    const row = s.workspaceInvitations?.[id];

    if (!row || row.accepted_at) return false;
    row.accepted_at = at;
    return true;
  });
  store.deleteWorkspaceInvitation = async (workspaceId, id) => mutate(store, (s) => {
    const row = s.workspaceInvitations?.[id];

    if (!row || row.workspace_id !== workspaceId) return false;
    delete s.workspaceInvitations[id];
    return true;
  });
  // Paging cursor over rows ordered newest first by (created_at, id): rows tied on created_at are not skipped.
  const olderThan = (row, before, beforeId) => !before || row.created_at < before || (beforeId !== null && row.created_at === before && row.id < beforeId);
  // --- Agent activity trail (migration 021) ---
  const AGENT_ACTIVITY_MAX = 20_000;
  store.recordAgentActivity = async (row) => mutate(store, (s) => {
    s.agentActivity ??= {};
    s.agentActivity[row.id] = { undo: null, undone_at: null, undone_by: null, error_code: null, ...row };
    const ids = Object.keys(s.agentActivity);

    if (ids.length > AGENT_ACTIVITY_MAX) {
      const oldest = ids.map((id) => s.agentActivity[id]).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, ids.length - AGENT_ACTIVITY_MAX);

      for (const entry of oldest) delete s.agentActivity[entry.id];
    }
    return { ...s.agentActivity[row.id] };
  });
  store.getAgentActivity = async (workspaceId, id) => {
    const row = store.state.agentActivity?.[id];

    return row && row.workspace_id === workspaceId ? { ...row } : null;
  };
  store.listAgentActivity = async (workspaceId, { limit = 50, before = null, beforeId = null, tokenId = null, userId = null, kind = null, ok = null } = {}) => {
    const rows = Object.values(store.state.agentActivity ?? {})
      .filter((row) => row.workspace_id === workspaceId && olderThan(row, before, beforeId) && (!tokenId || row.token_id === tokenId) &&
        (!userId || row.user_id === userId) && (!kind || row.kind === kind) && (ok === null || row.ok === ok))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

    return { entries: rows.slice(0, limit).map((row) => ({ ...row })), has_more: rows.length > limit };
  };
  store.markAgentActivityUndone = async (workspaceId, id, userId, at) => mutate(store, (s) => {
    const row = s.agentActivity?.[id];

    if (!row || row.workspace_id !== workspaceId || row.undone_at) return false;
    row.undone_at = at;
    row.undone_by = userId;
    return true;
  });
  // --- Card history (migration 023) ---
  const CARD_HISTORY_KEEP = 200;
  store.recordCardHistory = async (entry) => mutate(store, (s) => {
    s.cardHistory ??= {};
    s.cardHistory[entry.id] = { restored_at: null, restored_by: null, via: null, ...entry };
    const mine = Object.values(s.cardHistory).filter((row) => row.workspace_id === entry.workspace_id && row.row_id === entry.row_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

    for (const old of mine.slice(CARD_HISTORY_KEEP)) delete s.cardHistory[old.id];
    return { ...s.cardHistory[entry.id] };
  });
  store.getCardHistory = async (workspaceId, id) => {
    const row = store.state.cardHistory?.[id];

    return row && row.workspace_id === workspaceId ? { ...row } : null;
  };
  store.listCardHistory = async (workspaceId, rowId, { limit = 30, before = null, beforeId = null } = {}) => {
    const rows = Object.values(store.state.cardHistory ?? {})
      .filter((row) => row.workspace_id === workspaceId && row.row_id === rowId && olderThan(row, before, beforeId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

    return { entries: rows.slice(0, limit).map((row) => ({ ...row })), has_more: rows.length > limit };
  };
  store.markCardHistoryRestored = async (workspaceId, id, userId, at) => mutate(store, (s) => {
    const row = s.cardHistory?.[id];

    if (!row || row.workspace_id !== workspaceId || row.restored_at) return false;
    row.restored_at = at;
    row.restored_by = userId;
    return true;
  });
  store.createAgentToken = async (row) => mutate(store, (s) => {
    s.agentTokens ??= {};
    s.agentTokens[row.id] = { last_used_at: null, expires_at: null, revoked: false, revoked_at: null, ...row };
    return agentTokenRow(s.agentTokens[row.id]);
  });
  store.getAgentToken = async (tokenId) => agentTokenRow(store.state.agentTokens?.[tokenId]);
  store.listAgentTokens = async (workspaceId) => Object.values(store.state.agentTokens ?? {})
    .filter((row) => row.workspace_id === workspaceId)
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
    .map(agentTokenRow);
  store.revokeAgentToken = async (workspaceId, tokenId, at) => mutate(store, (s) => {
    const row = s.agentTokens?.[tokenId];

    if (!row || row.workspace_id !== workspaceId) return null;
    if (!row.revoked) { row.revoked = true; row.revoked_at = at; }
    return agentTokenRow(row);
  });
  store.touchAgentToken = async (tokenId, at) => mutate(store, (s) => {
    const row = s.agentTokens?.[tokenId];

    if (row) row.last_used_at = at;
  });
  // --- Inline comments + inbox notifications (migration 014 in Postgres mode) ---
  const byCreated = (left, right) => left.created_at.localeCompare(right.created_at) || (left.comment_id ?? left.id).localeCompare(right.comment_id ?? right.id);
  // Comments on one page are ordered by creation time, so two created in the same millisecond must not tie (the
  // comment id used as a tie-break is random): a new comment is always at least 1 ms after the page's newest.
  store.createInlineComment = async (comment) => mutate(store, (s) => {
    let createdAt = comment.created_at;

    for (const other of Object.values(s.inlineComments)) {
      if (other.workspace_id === comment.workspace_id && other.view_id === comment.view_id && other.created_at >= createdAt) {
        createdAt = new Date(Date.parse(other.created_at) + 1).toISOString();
      }
    }
    s.inlineComments[comment.comment_id] = { is_resolved: false, is_deleted: false, ...comment, created_at: createdAt, updated_at: comment.updated_at < createdAt ? createdAt : comment.updated_at };
    return s.inlineComments[comment.comment_id];
  });
  store.getInlineComment = async (workspaceId, viewId, commentId) => {
    const comment = store.state.inlineComments[commentId];
    return comment && comment.workspace_id === workspaceId && comment.view_id === viewId ? { ...comment } : null;
  };
  store.listInlineComments = async (workspaceId, viewId, { offset = 0, limit = 100 } = {}) => {
    const all = Object.values(store.state.inlineComments)
      .filter((comment) => comment.workspace_id === workspaceId && comment.view_id === viewId)
      .sort(byCreated);

    return { comments: all.slice(offset, offset + limit).map((comment) => ({ ...comment })), has_more: all.length > offset + limit };
  };
  store.softDeleteInlineComment = async (workspaceId, viewId, commentId, updatedAt) => mutate(store, (s) => {
    const comment = s.inlineComments[commentId];
    if (!comment || comment.workspace_id !== workspaceId || comment.view_id !== viewId) return null;
    comment.is_deleted = true;
    comment.updated_at = updatedAt;
    return { ...comment };
  });
  store.setInlineCommentResolved = async (workspaceId, viewId, commentId, isResolved, updatedAt) => mutate(store, (s) => {
    const comment = s.inlineComments[commentId];
    if (!comment || comment.workspace_id !== workspaceId || comment.view_id !== viewId) return null;
    comment.is_resolved = isResolved;
    comment.updated_at = updatedAt;
    return { ...comment };
  });
  store.listInlineCommentReactions = async (workspaceId, viewId, commentId = null) => Object.values(store.state.inlineCommentReactions)
    .filter((reaction) => {
      const comment = store.state.inlineComments[reaction.comment_id];
      return comment && comment.workspace_id === workspaceId && comment.view_id === viewId && (!commentId || reaction.comment_id === commentId);
    })
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map((reaction) => ({ ...reaction }));
  store.addInlineCommentReaction = async (reaction) => mutate(store, (s) => {
    const key = `${reaction.comment_id}:${reaction.reaction_type}:${reaction.user_id}`;
    if (!s.inlineCommentReactions[key]) s.inlineCommentReactions[key] = { ...reaction };
  });
  store.removeInlineCommentReaction = async ({ comment_id: commentId, reaction_type: reactionType, user_id: userId }) => mutate(store, (s) => {
    delete s.inlineCommentReactions[`${commentId}:${reactionType}:${userId}`];
  });
  store.createNotification = async (notification) => mutate(store, (s) => {
    s.notifications[notification.id] = { is_read: false, is_archived: false, read_at: null, ...notification };
    return { ...s.notifications[notification.id] };
  });
  const inboxFor = (workspaceId, userId) => Object.values(store.state.notifications)
    .filter((n) => n.workspace_id === workspaceId && n.recipient_user_id === userId);
  store.listNotifications = async (workspaceId, userId, { unreadOnly = false, archived = false, offset = 0, limit = 50 } = {}) => {
    const all = inboxFor(workspaceId, userId)
      .filter((n) => n.is_archived === archived && (!unreadOnly || !n.is_read))
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));

    return { notifications: all.slice(offset, offset + limit).map((n) => ({ ...n })), has_more: all.length > offset + limit };
  };
  store.countUnreadNotifications = async (workspaceId, userId) => inboxFor(workspaceId, userId).filter((n) => !n.is_read && !n.is_archived).length;
  // `ids` null means "every notification of this user in the workspace".
  store.markNotificationsRead = async (workspaceId, userId, ids, readAt) => mutate(store, (s) => {
    for (const n of Object.values(s.notifications)) {
      if (n.workspace_id !== workspaceId || n.recipient_user_id !== userId || n.is_read) continue;
      if (ids && !ids.includes(n.id)) continue;
      n.is_read = true;
      n.read_at = readAt;
    }
  });
  store.archiveNotifications = async (workspaceId, userId, ids) => mutate(store, (s) => {
    for (const n of Object.values(s.notifications)) {
      if (n.workspace_id !== workspaceId || n.recipient_user_id !== userId || n.is_archived) continue;
      if (ids && !ids.includes(n.id)) continue;
      n.is_archived = true;
    }
  });
  store.saveMembership = async (membership) => mutate(store, (s) => { s.memberships[`${membership.workspace_id}:${membership.user_id}`] = membership; });
  // Task 67: revoke a user's workspace membership. Used by the dev/test-only
  // DELETE /api/workspaces/:id/test-members endpoint (mirrors the existing
  // POST test-members helper's gating) and exercised directly by the Task 67
  // security test suite to prove WS admission/revalidation and REST
  // authorization both react correctly once membership is gone.
  store.deleteMembership = async (workspaceId, userId) => mutate(store, (s) => { delete s.memberships[`${workspaceId}:${userId}`]; });
  store.findUserByEmail = async (email) => Object.values(store.state.users).find((u) => u.email === email) || null;
  store.createPage = async (page) => mutate(store, (s) => { s.pages[page.id] = page; });
  store.createAtomicDocumentPage = (page, collab, request) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
      const previous = s.atomicCreationRequests[request.request_id];
      if (previous) {
        if (previous.workspace_id !== page.workspace_id || previous.request_digest !== request.request_digest || previous.page_id !== page.id) {
          const error = new Error('Atomic request_id was already used for a different request');
          error.code = 'REQUEST_ID_REUSED';
          throw error;
        }
        if (!s.pages[page.id] || !s.pageCollabDocuments[page.id]) {
          const error = new Error('Atomic creation record is incomplete');
          error.code = 'ATOMIC_CREATION_INCOMPLETE';
          throw error;
        }
        return { outcome: 'already_applied', result: { view_id: page.id, database_id: null } };
      }
      if (s.pages[page.id]) {
        const error = new Error('Page ID already exists');
        error.code = 'PAGE_EXISTS';
        throw error;
      }
      s.pages[page.id] = page;
      s.pageCollabDocuments[page.id] = {
        workspace_id: page.workspace_id,
        page_id: page.id,
        collab_version: collab.collabVersion,
        restore_id: null,
        document_state: Array.from(collab.documentState),
        state_vector: Array.from(collab.stateVector),
        generation: 0,
        last_message_id: { timestamp: 0, counter: 0 },
        updated_at: page.created_at,
      };
      s.atomicCreationRequests[request.request_id] = {
        workspace_id: page.workspace_id,
        request_digest: request.request_digest,
        page_id: page.id,
      };
      return { outcome: 'applied', result: { view_id: page.id, database_id: null } };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.atomicCreationQueue.then(operation);
    store.atomicCreationQueue = pending.catch(() => {});
    return pending;
  };
  store.getPageCollab = async (workspaceId, pageId) => {
    const row = store.state.pageCollabDocuments[pageId];
    if (!row || row.workspace_id !== workspaceId || store.state.pages[pageId]?.workspace_id !== workspaceId) return null;
    return {
      object_id: pageId,
      doc_state: new Uint8Array(row.document_state),
      state_vector: new Uint8Array(row.state_vector),
      version: 0,
      collab_version: row.collab_version,
      restore_id: row.restore_id ?? null,
      last_message_id: { ...(row.last_message_id || { timestamp: 0, counter: 0 }) },
    };
  };
  store.acceptPageCollabUpdate = ({ workspaceId, pageId, flags, payload, beforeStateVector, collabVersion, restoreId, messageKey }) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
          const page = s.pages[pageId];
          const row = s.pageCollabDocuments[pageId];
          if (!page || page.workspace_id !== workspaceId || !row || row.workspace_id !== workspaceId) {
            const error = new Error('Collaboration document or page not found');
            error.code = 'COLLAB_DOCUMENT_NOT_FOUND';
            throw error;
          }
          const prepared = preparePageCollabUpdate({
            objectId: pageId,
            documentState: row.document_state,
            flags,
            payload,
            beforeStateVector,
            collabVersion,
            expectedCollabVersion: row.collab_version,
            restoreId,
            expectedRestoreId: row.restore_id,
          });
          const payloadDigest = createHash('sha256').update(Buffer.from(payload)).digest('hex');
          const updates = s.pageCollabUpdates[pageId] || (s.pageCollabUpdates[pageId] = []);
          const existing = updates.find((item) => item.payload_digest === payloadDigest ||
            (messageKey && item.message_key === messageKey));
          if (existing) {
            return {
              status: 'duplicate',
              duplicate: true,
              durable: true,
              acknowledged: true,
              messageId: { ...existing.message_id },
              documentState: new Uint8Array(row.document_state),
              stateVector: new Uint8Array(row.state_vector),
              generation: row.generation,
              collabVersion: row.collab_version,
              restoreId: row.restore_id,
              lastMessageId: { ...row.last_message_id },
            };
          }
          const previousRid = s.workspaceRids[workspaceId] || { timestamp: 0, counter: 0 };
          let timestamp = Math.max(Date.now(), previousRid.timestamp);
          let counter = timestamp === previousRid.timestamp ? previousRid.counter + 1 : 0;
          if (counter > 0xffff_ffff) {
            timestamp += 1;
            counter = 0;
          }
          const messageId = { timestamp, counter };
          s.workspaceRids[workspaceId] = { ...messageId };
          row.document_state = Array.from(prepared.documentState);
          row.state_vector = Array.from(prepared.stateVector);
          row.generation += 1;
          row.last_message_id = { ...messageId };
          row.updated_at = new Date().toISOString();
          updates.push({
            payload_digest: payloadDigest,
            message_key: messageKey || null,
            message_id: { ...messageId },
          });
          return {
            status: 'applied',
            duplicate: false,
            durable: true,
            acknowledged: true,
            messageId,
            documentState: new Uint8Array(row.document_state),
            stateVector: new Uint8Array(row.state_vector),
            generation: row.generation,
            collabVersion: row.collab_version,
            restoreId: row.restore_id,
            lastMessageId: { ...row.last_message_id },
          };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.pageCollabUpdateQueue.then(operation);
    store.pageCollabUpdateQueue = pending.catch(() => {});
    return pending;
  };
  store.listPages = async (workspaceId) => Object.values(store.state.pages).filter((p) => p.workspace_id === workspaceId);
  // Task 64: real workspace Database catalog, replacing server.js's
  // previously hardcoded `{ databases: [], has_more: false }` stub. Derived
  // from the SAME page records `listPages` above already exposes -- no
  // second Database registry. See database-catalog.js for the derivation
  // rule and its malformed-metadata handling.
  store.listWorkspaceDatabaseCatalog = async (workspaceId) => buildDatabaseCatalogFromPages(await store.listPages(workspaceId));
  store.getPage = async (pageId) => store.state.pages[pageId] || null;
  store.updatePage = async (pageId, workspaceId, expectedVersion, changes) => {
    const page = store.state.pages[pageId];
    if (!page || page.workspace_id !== workspaceId || page.version !== expectedVersion) return null;
    await mutate(store, () => { page.title = changes.title; page.document = changes.document; page.version += 1; page.updated_at = changes.updated_at; });
    return page;
  };
  store.updatePageTitle = async (pageId, workspaceId, title, updatedAt) => {
    const page = store.state.pages[pageId];
    if (!page || page.workspace_id !== workspaceId) return null;
    await mutate(store, () => { page.title = title; page.updated_at = updatedAt; });
    return page;
  };

  // Task 79: PATCH /page-view/{id} (updatePage() in page-api.ts) -- renames a
  // page and/or replaces its icon/extra/is_locked in one request. `changes`
  // only ever carries keys the caller actually sent (UpdatePagePayload's
  // optional fields); `extra` is a full replacement, not a server-side
  // merge -- the client already merges with the existing view's extra
  // before calling this (see syncTemplateViewMetadata, DatabaseTemplateButton.tsx).
  store.updatePageMetadata = async (pageId, workspaceId, changes, updatedAt) => {
    const page = store.state.pages[pageId];

    if (!page || page.workspace_id !== workspaceId) return null;
    await mutate(store, () => {
      if ('title' in changes) page.title = changes.title;
      if ('icon' in changes) page.icon = changes.icon;
      if ('extra' in changes) page.extra = changes.extra;
      if ('is_locked' in changes) page.is_locked = changes.is_locked;
      page.updated_at = updatedAt;
    });
    return page;
  };

  // Sidebar drag and drop / "Move to": re-parents a page and records where it sits among its new siblings.
  // Siblings are ordered by position.sort_key when present, else by created_at (see groupPagesByParent).
  store.movePage = async (pageId, workspaceId, { parent_view_id: parentViewId, sort_key: sortKey }, updatedAt) => {
    const page = store.state.pages[pageId];

    if (!page || page.workspace_id !== workspaceId) return null;
    await mutate(store, () => {
      page.parent_view_id = parentViewId;
      page.position = { ...(page.position ?? { kind: 'end' }), sort_key: sortKey };
      page.updated_at = updatedAt;
    });
    return page;
  };
  store.updateSpace = async (spaceId, workspaceId, changes) => {
    const space = store.state.spaces[spaceId];

    if (!space || space.workspace_id !== workspaceId) return null;
    await mutate(store, () => {
      for (const key of ['name', 'space_icon', 'space_icon_color']) if (key in changes) space[key] = changes[key];
    });
    return space;
  };

  // --- Favorites and trash (Task 53, JSON storage) ---
  // Additive fields on the existing page record, mirroring the pattern used
  // for version history (Task 49A): no new top-level collections, just
  // optional fields that default to "not favorited" / "not trashed" when
  // absent so existing pages and existing tests are unaffected.
  store.setPageFavorite = async (pageId, workspaceId, isFavorite, isPinned, updatedAt) => {
    const page = store.state.pages[pageId];
    if (!page || page.workspace_id !== workspaceId) return null;
    await mutate(store, () => {
      page.is_favorite = !!isFavorite;
      page.is_pinned = !!isPinned;
      page.favorited_at = isFavorite ? updatedAt : null;
    });
    return page;
  };
  store.listFavoritePages = async (workspaceId) => Object.values(store.state.pages)
    .filter((p) => p.workspace_id === workspaceId && p.is_favorite && !p.is_trashed);
  store.setPageTrashed = async (pageId, workspaceId, isTrashed, updatedAt) => {
    const page = store.state.pages[pageId];
    if (!page || page.workspace_id !== workspaceId) return null;
    await mutate(store, () => {
      page.is_trashed = !!isTrashed;
      page.trashed_at = isTrashed ? updatedAt : null;
    });
    return page;
  };
  store.listTrashedPages = async (workspaceId) => Object.values(store.state.pages)
    .filter((p) => p.workspace_id === workspaceId && p.is_trashed);
  store.deletePagePermanently = async (pageId, workspaceId) => {
    const page = store.state.pages[pageId];
    if (!page || page.workspace_id !== workspaceId) return false;
    await mutate(store, (s) => {
      delete s.pages[pageId];
      delete s.pageCollabDocuments[pageId];
      delete s.pageCollabUpdates[pageId];
      delete s.pageCollabVersions[pageId];
    });
    return true;
  };

  // --- Document version history / restore (Task 49A, JSON storage only) ---
  // Versions are append-only and tombstoned (never physically deleted) per
  // product decision. Each version stores a full, independently
  // reconstructable Yjs document state (not a delta), so preview/restore
  // never need to replay prior updates.
  const pageRow = (workspaceId, pageId) => {
    const page = store.state.pages[pageId];
    const row = store.state.pageCollabDocuments[pageId];
    if (!page || page.workspace_id !== workspaceId || !row || row.workspace_id !== workspaceId) return null;
    return { page, row };
  };

  store.listPageCollabVersions = async (workspaceId, pageId, { since } = {}) => {
    const found = pageRow(workspaceId, pageId);
    if (!found) return null;
    const all = store.state.pageCollabVersions[pageId] || [];
    return all
      .filter((v) => !v.deleted_at)
      .filter((v) => !since || new Date(v.created_at).getTime() > since)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((v) => ({ ...v }));
  };

  store.getPageCollabVersion = async (workspaceId, pageId, versionId) => {
    const found = pageRow(workspaceId, pageId);
    if (!found) return null;
    const version = (store.state.pageCollabVersions[pageId] || []).find((v) => v.version === versionId);
    if (!version) return null;
    return { ...version };
  };

  // Creates a named, user-requested snapshot. documentState must already be a
  // full reconstructable Yjs state (the HTTP layer validates this by
  // replaying it into an empty Y.Doc before calling here).
  store.createPageCollabVersion = async (workspaceId, pageId, { name, documentState, actorUid, kind = 'named', editors }) => {
    const found = pageRow(workspaceId, pageId);
    if (!found) return null;
    return mutate(store, (s) => {
      const versions = s.pageCollabVersions[pageId] || (s.pageCollabVersions[pageId] = []);
      const latest = versions.filter((v) => !v.deleted_at).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
      const entry = {
        version: randomUUID(),
        parent: latest ? latest.version : null,
        name: name || null,
        document_state: Array.from(documentState),
        created_at: new Date().toISOString(),
        created_by: actorUid ?? null,
        deleted_at: null,
        editors: editors ?? (actorUid != null ? [actorUid] : []),
        kind,
      };
      versions.push(entry);
      return { ...entry };
    });
  };

  // Keeps the newest `keep` automatic versions of a page; older ones are hidden (tombstoned) and removed for good
  // after 30 days. Named and before-restore versions are never touched.
  store.pruneAutoPageVersions = async (workspaceId, pageId, keep) => {
    if (!pageRow(workspaceId, pageId)) return 0;
    return mutate(store, (s) => {
      const versions = s.pageCollabVersions[pageId] || [];
      const live = versions.filter((v) => v.kind === 'auto' && !v.deleted_at).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const stamp = new Date().toISOString();
      let hidden = 0;

      for (const version of live.slice(keep)) { version.deleted_at = stamp; hidden += 1; }
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();

      s.pageCollabVersions[pageId] = versions.filter((v) => !(v.kind === 'auto' && v.deleted_at && v.deleted_at < cutoff));
      return hidden;
    });
  };

  store.tombstonePageCollabVersion = async (workspaceId, pageId, versionId) => mutate(store, (s) => {
    const found = pageRow(workspaceId, pageId);
    if (!found) return { status: 'not_found' };
    const version = (s.pageCollabVersions[pageId] || []).find((v) => v.version === versionId);
    if (!version) return { status: 'not_found' };
    if (version.deleted_at) return { status: 'already_deleted' };
    version.deleted_at = new Date().toISOString();
    return { status: 'deleted' };
  });

  // Restores a document to a previously stored version. This is a distinct
  // administrative operation from ordinary collaborative updates: it does
  // NOT allocate a workspace Rid (Task 46's per-workspace message id), but it
  // IS serialized on the same queue as updates so concurrent restores/updates
  // use the same single-writer ordering (first durable write wins).
  //
  // Idempotency: the frontend contract (collab-api.ts revertCollabVersion)
  // carries no request/idempotency key, so duplicate-detection is designed
  // here: a digest of (pageId, targetVersionId) is compared against the most
  // recently *applied* restore for this page. If it matches and no other
  // mutation has happened since (row.restore_id still equals the result of
  // that last restore), the request is treated as a retry of the same
  // restore and the previously computed result is returned unchanged rather
  // than creating a second before-restore snapshot / restore event / restore
  // generation. A genuinely new restore to the same version, issued after
  // other activity, is allowed to proceed as a fresh restore.
  store.restorePageCollabVersion = ({ workspaceId, pageId, versionId, actorUid }) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
          const page = s.pages[pageId];
          const row = s.pageCollabDocuments[pageId];
          if (!page || page.workspace_id !== workspaceId || !row || row.workspace_id !== workspaceId) {
            const error = new Error('Collaboration document or page not found');
            error.code = 'COLLAB_DOCUMENT_NOT_FOUND';
            throw error;
          }
          const digest = createHash('sha256').update(`${pageId}:${versionId}`).digest('hex');
          const events = s.pageCollabRestoreEvents[pageId] || (s.pageCollabRestoreEvents[pageId] = []);
          const lastEvent = events.at(-1);
          if (lastEvent && lastEvent.digest === digest && lastEvent.resulting_restore_id === row.restore_id) {
            return {
              status: 'duplicate',
              duplicate: true,
              documentState: new Uint8Array(row.document_state),
              stateVector: new Uint8Array(row.state_vector),
              collabVersion: row.collab_version,
              restoreId: row.restore_id,
            };
          }
          const versions = s.pageCollabVersions[pageId] || (s.pageCollabVersions[pageId] = []);
          const target = versions.find((v) => v.version === versionId);
          if (!target) {
            const error = new Error('Target version not found');
            error.code = 'VERSION_NOT_FOUND';
            throw error;
          }
          if (target.deleted_at) {
            const error = new Error('Target version has been deleted');
            error.code = 'VERSION_DELETED';
            throw error;
          }
          // Decision 3: every restore creates an implicit before-restore
          // snapshot of the document's current (pre-restore) full state.
          const latestForParent = versions.filter((v) => !v.deleted_at).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
          const beforeRestoreSnapshot = {
            version: randomUUID(),
            parent: latestForParent ? latestForParent.version : null,
            name: null,
            document_state: Array.from(row.document_state),
            created_at: new Date().toISOString(),
            created_by: actorUid ?? null,
            deleted_at: null,
            editors: actorUid != null ? [actorUid] : [],
            kind: 'before_restore',
          };
          versions.push(beforeRestoreSnapshot);
          // Decision 4: restore preserves document identity (pageId/object
          // id, workspace, collab_version are untouched below).
          row.document_state = Array.from(target.document_state);
          // The restored full state is self-describing; recompute the state
          // vector from it so future updates diff against the real content
          // rather than a stale vector.
          row.state_vector = computeStateVectorFromDocumentState(row.document_state);
          // Decision 5/6: advance the restore generation. Existing fencing in
          // acceptPageCollabUpdate() rejects any update whose restoreId no
          // longer matches this value.
          const newRestoreId = randomUUID();
          row.restore_id = newRestoreId;
          row.generation += 1;
          row.updated_at = new Date().toISOString();
          events.push({
            digest,
            restored_version_id: versionId,
            before_restore_snapshot_version_id: beforeRestoreSnapshot.version,
            resulting_restore_id: newRestoreId,
            actor: actorUid ?? null,
            created_at: row.updated_at,
          });
          return {
            status: 'applied',
            duplicate: false,
            documentState: new Uint8Array(row.document_state),
            stateVector: new Uint8Array(row.state_vector),
            collabVersion: row.collab_version,
            restoreId: newRestoreId,
          };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.pageCollabUpdateQueue.then(operation);
    store.pageCollabUpdateQueue = pending.catch(() => {});
    return pending;
  };

  // --- Task 61: Database collab object (CollabType.Database = 1), JSON storage ---
  // Mirrors the Document (`createAtomicDocumentPage` / `getPageCollab` /
  // `acceptPageCollabUpdate`) pattern exactly -- same persist-before-ack
  // ordering via `mutate`, same per-workspace Rid allocator
  // (`s.workspaceRids`), same payload-digest/messageKey idempotency shape.
  // Document code paths above are untouched; this is strictly additive.
  //
  // `containerPage` is the Folder-tree sidebar entry for the database
  // (`request.container_id`); `primaryViewPage` is the Folder-tree child
  // entry for the database's own primary/inline view
  // (`request.database.view_id`) -- AppFlowy-Web's validateDatabase()
  // requires both to exist as real Folder pages. Both are ordinary records
  // in `s.pages`, reusing the existing Folder/view-listing machinery; they
  // intentionally have no `pageCollabDocuments` entry (they are not
  // Document collab objects), so collabType=0 admission continues to reject
  // them exactly like it rejects any other non-Document object id.
  store.createAtomicDatabasePage = (containerPage, primaryViewPage, databaseId, collab, request) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
          const previous = s.atomicCreationRequests[request.request_id];
          if (previous) {
            if (previous.workspace_id !== containerPage.workspace_id || previous.request_digest !== request.request_digest || previous.page_id !== containerPage.id) {
              const error = new Error('Atomic request_id was already used for a different request');
              error.code = 'REQUEST_ID_REUSED';
              throw error;
            }
            if (!s.pages[containerPage.id] || !s.pages[primaryViewPage.id] || !s.databaseCollabDocuments[databaseId]) {
              const error = new Error('Atomic creation record is incomplete');
              error.code = 'ATOMIC_CREATION_INCOMPLETE';
              throw error;
            }
            return { outcome: 'already_applied', result: { view_id: containerPage.id, database_id: previous.database_id ?? databaseId } };
          }
          if (s.pages[containerPage.id]) {
            const error = new Error('Page ID already exists');
            error.code = 'PAGE_EXISTS';
            throw error;
          }
          if (s.pages[primaryViewPage.id]) {
            const error = new Error('Page ID already exists');
            error.code = 'PAGE_EXISTS';
            throw error;
          }
          if (s.databaseCollabDocuments[databaseId]) {
            const error = new Error('Database ID already exists');
            error.code = 'DATABASE_EXISTS';
            throw error;
          }
          s.pages[containerPage.id] = containerPage;
          s.pages[primaryViewPage.id] = primaryViewPage;
          s.databaseCollabDocuments[databaseId] = {
            workspace_id: containerPage.workspace_id,
            database_id: databaseId,
            collab_version: collab.collabVersion,
            restore_id: null,
            document_state: Array.from(collab.documentState),
            state_vector: Array.from(collab.stateVector),
            generation: 0,
            last_message_id: { timestamp: 0, counter: 0 },
            updated_at: containerPage.created_at,
          };
          s.atomicCreationRequests[request.request_id] = {
            workspace_id: containerPage.workspace_id,
            request_digest: request.request_digest,
            page_id: containerPage.id,
            database_id: databaseId,
          };
          return { outcome: 'applied', result: { view_id: containerPage.id, database_id: databaseId } };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.atomicCreationQueue.then(operation);
    store.atomicCreationQueue = pending.catch(() => {});
    return pending;
  };

  // Creates a whole database from a template in one step: the Folder container
  // page, one Folder page per database view, the Database collab, and every
  // sample row's DatabaseRow collab. Shares createAtomicDatabasePage's request
  // ledger (atomicCreationRequests), so idempotency/replay semantics match.
  store.createDatabaseFromTemplate = ({ containerPage, viewPages, databaseId, collab, rows, rowDocuments = [], request }) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
          const result = { view_id: containerPage.id, database_id: databaseId, view_ids: viewPages.map((p) => p.id), row_ids: rows.map((r) => r.rowId) };
          const previous = s.atomicCreationRequests[request.request_id];
          if (previous) {
            if (previous.workspace_id !== containerPage.workspace_id || previous.request_digest !== request.request_digest || previous.page_id !== containerPage.id) {
              const error = new Error('Atomic request_id was already used for a different request');
              error.code = 'REQUEST_ID_REUSED';
              throw error;
            }
            if (!s.pages[containerPage.id] || !s.databaseCollabDocuments[databaseId]) {
              const error = new Error('Atomic creation record is incomplete');
              error.code = 'ATOMIC_CREATION_INCOMPLETE';
              throw error;
            }
            return { outcome: 'already_applied', result };
          }
          if ([containerPage, ...viewPages, ...rowDocuments.map((entry) => entry.page)].some((page) => s.pages[page.id])) {
            const error = new Error('Page ID already exists');
            error.code = 'PAGE_EXISTS';
            throw error;
          }
          if (s.databaseCollabDocuments[databaseId] || rows.some((r) => s.databaseRowCollabDocuments[r.rowId])) {
            const error = new Error('Database ID already exists');
            error.code = 'DATABASE_EXISTS';
            throw error;
          }
          for (const page of [containerPage, ...viewPages]) s.pages[page.id] = page;
          s.databaseCollabDocuments[databaseId] = {
            workspace_id: containerPage.workspace_id,
            database_id: databaseId,
            collab_version: collab.collabVersion,
            restore_id: null,
            document_state: Array.from(collab.documentState),
            state_vector: Array.from(collab.stateVector),
            generation: 0,
            last_message_id: { timestamp: 0, counter: 0 },
            updated_at: containerPage.created_at,
          };
          for (const row of rows) {
            s.databaseRowCollabDocuments[row.rowId] = {
              workspace_id: containerPage.workspace_id,
              database_id: databaseId,
              collab_version: null,
              restore_id: null,
              document_state: Array.from(row.documentState),
              state_vector: Array.from(row.stateVector),
              generation: 0,
              last_message_id: { timestamp: 0, counter: 0 },
              updated_at: containerPage.created_at,
            };
          }
          // Card bodies: the row's detail-page document (an "orphaned" page, see ensureRowDocumentPage in server.js).
          for (const { page, collab: bodyCollab } of rowDocuments) {
            s.pages[page.id] = page;
            s.pageCollabDocuments[page.id] = {
              workspace_id: page.workspace_id,
              page_id: page.id,
              collab_version: bodyCollab.collabVersion,
              restore_id: null,
              document_state: Array.from(bodyCollab.documentState),
              state_vector: Array.from(bodyCollab.stateVector),
              generation: 0,
              last_message_id: { timestamp: 0, counter: 0 },
              updated_at: page.created_at,
            };
          }
          s.atomicCreationRequests[request.request_id] = {
            workspace_id: containerPage.workspace_id,
            request_digest: request.request_digest,
            page_id: containerPage.id,
            database_id: databaseId,
          };
          return { outcome: 'applied', result };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.atomicCreationQueue.then(operation);
    store.atomicCreationQueue = pending.catch(() => {});
    return pending;
  };

  // Creates a document template's whole page tree (root + sub-pages) in one
  // step. `entries` is [{ page, collab }] parents-before-children, the first
  // being the root. Shares createAtomicDocumentPage's request ledger.
  store.createDocumentTreeFromTemplate = ({ entries, request }) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
          const root = entries[0].page;
          const result = { view_id: root.id, database_id: null, view_ids: entries.map((e) => e.page.id) };
          const previous = s.atomicCreationRequests[request.request_id];
          if (previous) {
            if (previous.workspace_id !== root.workspace_id || previous.request_digest !== request.request_digest || previous.page_id !== root.id) {
              const error = new Error('Atomic request_id was already used for a different request');
              error.code = 'REQUEST_ID_REUSED';
              throw error;
            }
            if (entries.some((e) => !s.pages[e.page.id] || !s.pageCollabDocuments[e.page.id])) {
              const error = new Error('Atomic creation record is incomplete');
              error.code = 'ATOMIC_CREATION_INCOMPLETE';
              throw error;
            }
            return { outcome: 'already_applied', result };
          }
          if (entries.some((e) => s.pages[e.page.id])) {
            const error = new Error('Page ID already exists');
            error.code = 'PAGE_EXISTS';
            throw error;
          }
          for (const { page, collab } of entries) {
            s.pages[page.id] = page;
            s.pageCollabDocuments[page.id] = {
              workspace_id: page.workspace_id,
              page_id: page.id,
              collab_version: collab.collabVersion,
              restore_id: null,
              document_state: Array.from(collab.documentState),
              state_vector: Array.from(collab.stateVector),
              generation: 0,
              last_message_id: { timestamp: 0, counter: 0 },
              updated_at: page.created_at,
            };
          }
          s.atomicCreationRequests[request.request_id] = {
            workspace_id: root.workspace_id,
            request_digest: request.request_digest,
            page_id: root.id,
          };
          return { outcome: 'applied', result };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.atomicCreationQueue.then(operation);
    store.atomicCreationQueue = pending.catch(() => {});
    return pending;
  };

  store.getDatabaseCollab = async (workspaceId, databaseId) => {
    const row = store.state.databaseCollabDocuments[databaseId];
    if (!row || row.workspace_id !== workspaceId) return null;
    return {
      object_id: databaseId,
      doc_state: new Uint8Array(row.document_state),
      state_vector: new Uint8Array(row.state_vector),
      version: 0,
      collab_version: row.collab_version,
      last_message_id: { ...(row.last_message_id || { timestamp: 0, counter: 0 }) },
    };
  };

  store.acceptDatabaseCollabUpdate = ({ workspaceId, databaseId, flags, payload, beforeStateVector, collabVersion, restoreId, messageKey }) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
          const row = s.databaseCollabDocuments[databaseId];
          if (!row || row.workspace_id !== workspaceId) {
            const error = new Error('Collaboration document or database not found');
            error.code = 'COLLAB_DOCUMENT_NOT_FOUND';
            throw error;
          }
          const prepared = preparePageCollabUpdate({
            objectId: databaseId,
            documentState: row.document_state,
            flags,
            payload,
            beforeStateVector,
            collabVersion,
            expectedCollabVersion: row.collab_version,
            restoreId,
            expectedRestoreId: row.restore_id,
          });
          const payloadDigest = createHash('sha256').update(Buffer.from(payload)).digest('hex');
          const updates = s.databaseCollabUpdates[databaseId] || (s.databaseCollabUpdates[databaseId] = []);
          const existing = updates.find((item) => item.payload_digest === payloadDigest ||
            (messageKey && item.message_key === messageKey));
          if (existing) {
            return {
              status: 'duplicate',
              duplicate: true,
              durable: true,
              acknowledged: true,
              messageId: { ...existing.message_id },
              documentState: new Uint8Array(row.document_state),
              stateVector: new Uint8Array(row.state_vector),
              generation: row.generation,
              collabVersion: row.collab_version,
              restoreId: row.restore_id,
              lastMessageId: { ...row.last_message_id },
            };
          }
          const previousRid = s.workspaceRids[workspaceId] || { timestamp: 0, counter: 0 };
          let timestamp = Math.max(Date.now(), previousRid.timestamp);
          let counter = timestamp === previousRid.timestamp ? previousRid.counter + 1 : 0;
          if (counter > 0xffff_ffff) {
            timestamp += 1;
            counter = 0;
          }
          const messageId = { timestamp, counter };
          s.workspaceRids[workspaceId] = { ...messageId };
          row.document_state = Array.from(prepared.documentState);
          row.state_vector = Array.from(prepared.stateVector);
          row.generation += 1;
          row.last_message_id = { ...messageId };
          row.updated_at = new Date().toISOString();
          updates.push({
            payload_digest: payloadDigest,
            message_key: messageKey || null,
            message_id: { ...messageId },
          });
          return {
            status: 'applied',
            duplicate: false,
            durable: true,
            acknowledged: true,
            messageId,
            documentState: new Uint8Array(row.document_state),
            stateVector: new Uint8Array(row.state_vector),
            generation: row.generation,
            collabVersion: row.collab_version,
            restoreId: row.restore_id,
            lastMessageId: { ...row.last_message_id },
          };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.databaseCollabUpdateQueue.then(operation);
    store.databaseCollabUpdateQueue = pending.catch(() => {});
    return pending;
  };

  // --- Task 72: additional database-view creation (the one confirmed
  // backend gap found by Task 72's discovery -- see
  // docs/TASK72_DATABASE_VIEWS_DISCOVERY.md). Mirrors
  // createAtomicDatabaseRow's shape exactly: its own idempotency table
  // (atomicViewCreationRequests, a separate request_id namespace from both
  // Document/Database page creation and row creation, same reasoning as
  // Task 61/62's own queue splits), one in-place mutation of the EXISTING
  // Database collab object's `views` map (via addDatabaseView,
  // database-document.js), plus one new Folder-tree page row for the
  // view's own sidebar/tab entry -- both durable before this resolves, same
  // persist-before-ack discipline as every other atomic creation route in
  // this file.
  //
  // AppFlowy-Web's own atomic-creation journal (journal.ts
  // validateAtomicCreationReceipt, 'database-view' case) requires the
  // receipt's `result` to carry `database_id`, `database_restore_id`,
  // `view_ids` (an array), `database_version` (null or a UUID),
  // `update_batch_id` (a UUID), and `database_update_v1` (a non-empty
  // base64 Yjs diff) -- discovered via real-browser verification (a
  // same-shape-as-`row/default` response was NOT sufficient; the client
  // throws `AtomicCreationPendingError` client-side if any of these are
  // missing/malformed, even though the HTTP call itself succeeds). The
  // diff is computed exactly like row creation's `database_update`: the
  // Yjs update from the state BEFORE this view was added to the state
  // AFTER, so the creating client can merge it locally without a second
  // round trip.
  store.createAtomicDatabaseView = ({ workspaceId, databaseId, viewId, sourceViewId, layout, name, embedded, timestamp, page, request }) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
          const previous = s.atomicViewCreationRequests[request.request_id];
          if (previous) {
            if (previous.workspace_id !== workspaceId || previous.request_digest !== request.request_digest || previous.database_id !== databaseId) {
              const reusedError = new Error('Atomic request_id was already used for a different request');
              reusedError.code = 'REQUEST_ID_REUSED';
              throw reusedError;
            }
            if (!s.pages[previous.view_id]) {
              const incompleteError = new Error('Atomic view creation record is incomplete');
              incompleteError.code = 'ATOMIC_CREATION_INCOMPLETE';
              throw incompleteError;
            }
            return {
              outcome: 'already_applied',
              view_id: previous.view_id,
              database_update: Uint8Array.from(previous.database_update),
              update_batch_id: previous.update_batch_id,
            };
          }

          const databaseRow = s.databaseCollabDocuments[databaseId];
          if (!databaseRow || databaseRow.workspace_id !== workspaceId) {
            const notFoundError = new Error('Parent Database collaboration object not found');
            notFoundError.code = 'DATABASE_NOT_FOUND';
            throw notFoundError;
          }
          if (s.pages[viewId]) {
            const existsError = new Error('Page ID already exists');
            existsError.code = 'PAGE_EXISTS';
            throw existsError;
          }

          const doc = new Y.Doc({ guid: databaseId });
          let diffUpdate;
          try {
            Y.applyUpdate(doc, Uint8Array.from(databaseRow.document_state));
            const beforeStateVector = Y.encodeStateVector(doc);
            addDatabaseView(doc, { viewId, databaseId, name, layout, embedded, sourceViewId, timestamp });
            diffUpdate = Y.encodeStateAsUpdate(doc, beforeStateVector);
            databaseRow.document_state = Array.from(Y.encodeStateAsUpdate(doc));
            databaseRow.state_vector = Array.from(Y.encodeStateVector(doc));
            databaseRow.generation += 1;
            databaseRow.updated_at = timestamp;
          } finally {
            doc.destroy();
          }

          s.pages[viewId] = page;
          s.atomicViewCreationRequests[request.request_id] = {
            workspace_id: workspaceId,
            request_digest: request.request_digest,
            database_id: databaseId,
            view_id: viewId,
            database_update: Array.from(diffUpdate),
            update_batch_id: request.update_batch_id,
          };
          return { outcome: 'applied', view_id: viewId, database_update: diffUpdate, update_batch_id: request.update_batch_id };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.atomicViewCreationQueue.then(operation);
    store.atomicViewCreationQueue = pending.catch(() => {});
    return pending;
  };

  // --- Task 62: DatabaseRow (CollabType.DatabaseRow = 4) minimum viable
  // lifecycle. Contract verified against AppFlowy-Web
  // src/application/database-yjs/creation/create-row.ts (createCloudRow)
  // and src/application/services/js-services/http/atomic-row-creation-api.ts
  // (postDefaultRowCreation -> POST .../v2/database/{databaseId}/row/default).
  //
  // Row creation must atomically (a) create the new DatabaseRow collab
  // object and (b) insert {id, height} into the parent Database's single
  // Phase-1 inline Grid view's row_orders -- AppFlowy-Web's own
  // assertMembership()/assertRow() (create-row.ts) require both to be
  // durably visible together before it treats the row as created. Uses its
  // own dedicated queue (atomicRowCreationQueue), distinct from
  // atomicCreationQueue (Document/Database page creation) and
  // databaseCollabUpdateQueue (ordinary Database Yjs updates, e.g. field
  // rename), so none of the three contend with each other -- same
  // reasoning as Task 61's databaseCollabUpdateQueue split from
  // pageCollabUpdateQueue.
  store.createAtomicDatabaseRow = ({ workspaceId, databaseId, rowId, sourceViewId, position, rowCollab, request }) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
          const previous = s.atomicRowCreationRequests[request.request_id];
          if (previous) {
            if (previous.workspace_id !== workspaceId || previous.request_digest !== request.request_digest || previous.database_id !== databaseId) {
              const reusedError = new Error('Atomic request_id was already used for a different request');
              reusedError.code = 'REQUEST_ID_REUSED';
              throw reusedError;
            }
            if (!s.databaseRowCollabDocuments[previous.row_id]) {
              const incompleteError = new Error('Atomic row creation record is incomplete');
              incompleteError.code = 'ATOMIC_CREATION_INCOMPLETE';
              throw incompleteError;
            }
            return {
              outcome: 'already_applied',
              row_id: previous.row_id,
              database_update: Uint8Array.from(previous.database_update),
              update_batch_id: previous.update_batch_id,
            };
          }

          const databaseRow = s.databaseCollabDocuments[databaseId];
          if (!databaseRow || databaseRow.workspace_id !== workspaceId) {
            const notFoundError = new Error('Parent Database collaboration object not found');
            notFoundError.code = 'DATABASE_NOT_FOUND';
            throw notFoundError;
          }
          if (s.databaseRowCollabDocuments[rowId]) {
            const existsError = new Error('Row ID already exists');
            existsError.code = 'ROW_EXISTS';
            throw existsError;
          }

          const doc = new Y.Doc({ guid: databaseId });
          let diffUpdate;
          try {
            Y.applyUpdate(doc, Uint8Array.from(databaseRow.document_state));
            const beforeStateVector = Y.encodeStateVector(doc);
            const database = doc.getMap('data').get('database');
            const views = database && database.get('views');
            const view = views && views.get(sourceViewId);
            if (!database || database.get('id') !== databaseId || !view) {
              const viewError = new Error('source_view_id does not belong to this Database');
              viewError.code = 'VIEW_NOT_FOUND';
              throw viewError;
            }
            const rowOrders = view.get('row_orders');
            const currentOrders = rowOrders.toArray();
            let insertIndex = currentOrders.length;
            if (position.kind === 'start') {
              insertIndex = 0;
            } else if (position.kind === 'after') {
              const anchor = currentOrders.findIndex((o) => o.id === position.row_id);
              insertIndex = anchor === -1 ? currentOrders.length : anchor + 1;
            } else if (position.kind === 'before') {
              const anchor = currentOrders.findIndex((o) => o.id === position.row_id);
              insertIndex = anchor === -1 ? currentOrders.length : anchor;
            }
            rowOrders.insert(insertIndex, [{ id: rowId, height: request.height }]);
            diffUpdate = Y.encodeStateAsUpdate(doc, beforeStateVector);
            databaseRow.document_state = Array.from(Y.encodeStateAsUpdate(doc));
            databaseRow.state_vector = Array.from(Y.encodeStateVector(doc));
            databaseRow.generation += 1;
            databaseRow.updated_at = request.timestamp;
          } finally {
            doc.destroy();
          }

          s.databaseRowCollabDocuments[rowId] = {
            workspace_id: workspaceId,
            database_id: databaseId,
            collab_version: null,
            restore_id: null,
            document_state: Array.from(rowCollab.documentState),
            state_vector: Array.from(rowCollab.stateVector),
            generation: 0,
            last_message_id: { timestamp: 0, counter: 0 },
            updated_at: request.timestamp,
          };

          s.atomicRowCreationRequests[request.request_id] = {
            workspace_id: workspaceId,
            request_digest: request.request_digest,
            database_id: databaseId,
            row_id: rowId,
            database_update: Array.from(diffUpdate),
            update_batch_id: request.update_batch_id,
          };

          return { outcome: 'applied', row_id: rowId, database_update: diffUpdate, update_batch_id: request.update_batch_id };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.atomicRowCreationQueue.then(operation);
    store.atomicRowCreationQueue = pending.catch(() => {});
    return pending;
  };

  // Task 79: the "seeded" template-row-creation path (AppFlowy-Web's
  // submit-template-row.ts, POST /v2/database/{databaseId}/row) -- the
  // simple case of prepareTemplateRowGraph for a template with no embedded
  // databases: exactly one row plus (optionally) its one document, both
  // already fully built client-side and handed over pre-encoded, instead of
  // reconstructed server-side from loose cell/field data the way
  // createAtomicDatabaseRow above does. Unlike that function, this inserts
  // the row into every one of positionViewIds (every view the template's
  // anchor row is visible in), not just one, and optionally publishes an
  // orphaned Document page alongside it in the same atomic commit.
  store.createSeededDatabaseRow = ({
    workspaceId, databaseId, rowId, positionViewIds, position, height,
    rowState, rowStateVector, documentPage, request,
  }) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);

      try {
        return await mutate(store, (s) => {
          const previous = s.seededRowCreationRequests[request.request_id];

          if (previous) {
            if (previous.workspace_id !== workspaceId || previous.request_digest !== request.request_digest || previous.database_id !== databaseId) {
              const reusedError = new Error('Atomic request_id was already used for a different request');

              reusedError.code = 'REQUEST_ID_REUSED';
              throw reusedError;
            }
            if (!s.databaseRowCollabDocuments[previous.row_id]) {
              const incompleteError = new Error('Atomic row creation record is incomplete');

              incompleteError.code = 'ATOMIC_CREATION_INCOMPLETE';
              throw incompleteError;
            }

            return {
              outcome: 'already_applied',
              row_id: previous.row_id,
              document_id: previous.document_id,
              database_update: Uint8Array.from(previous.database_update),
              update_batch_id: previous.update_batch_id,
            };
          }

          const databaseRow = s.databaseCollabDocuments[databaseId];

          if (!databaseRow || databaseRow.workspace_id !== workspaceId) {
            const notFoundError = new Error('Parent Database collaboration object not found');

            notFoundError.code = 'DATABASE_NOT_FOUND';
            throw notFoundError;
          }
          if (s.databaseRowCollabDocuments[rowId]) {
            const existsError = new Error('Row ID already exists');

            existsError.code = 'ROW_EXISTS';
            throw existsError;
          }
          if (documentPage && s.pages[documentPage.id]) {
            const existsError = new Error('Row-page document already exists');

            existsError.code = 'PAGE_EXISTS';
            throw existsError;
          }

          const doc = new Y.Doc({ guid: databaseId });
          let diffUpdate;

          try {
            Y.applyUpdate(doc, Uint8Array.from(databaseRow.document_state));
            const beforeStateVector = Y.encodeStateVector(doc);
            const database = doc.getMap('data').get('database');
            const views = database && database.get('views');

            if (!database || database.get('id') !== databaseId) {
              const viewError = new Error('position_view_ids do not belong to this Database');

              viewError.code = 'VIEW_NOT_FOUND';
              throw viewError;
            }
            for (const viewId of positionViewIds) {
              const view = views.get(viewId);

              if (!view) {
                const viewError = new Error('position_view_ids do not belong to this Database');

                viewError.code = 'VIEW_NOT_FOUND';
                throw viewError;
              }

              const rowOrders = view.get('row_orders');
              const currentOrders = rowOrders.toArray();
              let insertIndex = currentOrders.length;

              if (position.kind === 'start') {
                insertIndex = 0;
              } else if (position.kind === 'after') {
                const anchor = currentOrders.findIndex((o) => o.id === position.row_id);

                insertIndex = anchor === -1 ? currentOrders.length : anchor + 1;
              } else if (position.kind === 'before') {
                const anchor = currentOrders.findIndex((o) => o.id === position.row_id);

                insertIndex = anchor === -1 ? currentOrders.length : anchor;
              }

              rowOrders.insert(insertIndex, [{ id: rowId, height }]);
            }

            diffUpdate = Y.encodeStateAsUpdate(doc, beforeStateVector);
            databaseRow.document_state = Array.from(Y.encodeStateAsUpdate(doc));
            databaseRow.state_vector = Array.from(Y.encodeStateVector(doc));
            databaseRow.generation += 1;
            databaseRow.updated_at = request.timestamp;
          } finally {
            doc.destroy();
          }

          s.databaseRowCollabDocuments[rowId] = {
            workspace_id: workspaceId,
            database_id: databaseId,
            collab_version: null,
            restore_id: null,
            document_state: Array.from(rowState),
            state_vector: Array.from(rowStateVector),
            generation: 0,
            last_message_id: { timestamp: 0, counter: 0 },
            updated_at: request.timestamp,
          };

          if (documentPage) {
            s.pages[documentPage.id] = documentPage.page;
            s.pageCollabDocuments[documentPage.id] = {
              workspace_id: workspaceId,
              page_id: documentPage.id,
              collab_version: documentPage.collab.collabVersion,
              restore_id: null,
              document_state: Array.from(documentPage.collab.documentState),
              state_vector: Array.from(documentPage.collab.stateVector),
              generation: 0,
              last_message_id: { timestamp: 0, counter: 0 },
              updated_at: request.timestamp,
            };
          }

          s.seededRowCreationRequests[request.request_id] = {
            workspace_id: workspaceId,
            request_digest: request.request_digest,
            database_id: databaseId,
            row_id: rowId,
            document_id: documentPage?.id ?? null,
            database_update: Array.from(diffUpdate),
            update_batch_id: request.update_batch_id,
          };

          return {
            outcome: 'applied',
            row_id: rowId,
            document_id: documentPage?.id ?? null,
            database_update: diffUpdate,
            update_batch_id: request.update_batch_id,
          };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.atomicRowCreationQueue.then(operation);

    store.atomicRowCreationQueue = pending.catch(() => {});
    return pending;
  };

  // Task 79: a hidden row (a database template's row) is never inserted
  // into any view's row_orders -- its only membership proof is the
  // Database's own metas.row_templates registration (see
  // row-source-readiness.ts's hasCurrentRowDocumentSource on the client).
  // Unlike createAtomicDatabaseRow above, this never touches row_orders and
  // is idempotent by row identity alone: rowId is itself a stable,
  // collision-free identity (a UUIDv4 the client already committed to
  // locally), so creating the same placeholder twice is a harmless no-op.
  store.ensureHiddenDatabaseRow = ({ workspaceId, databaseId, rowId, rowCollab, timestamp }) => {
    const operation = async () => mutate(store, (s) => {
      if (s.databaseRowCollabDocuments[rowId]) return { created: false };
      const database = s.databaseCollabDocuments[databaseId];
      if (!database || database.workspace_id !== workspaceId) {
        const notFoundError = new Error('Parent Database collaboration object not found');
        notFoundError.code = 'DATABASE_NOT_FOUND';
        throw notFoundError;
      }
      s.databaseRowCollabDocuments[rowId] = {
        workspace_id: workspaceId,
        database_id: databaseId,
        collab_version: null,
        restore_id: null,
        document_state: Array.from(rowCollab.documentState),
        state_vector: Array.from(rowCollab.stateVector),
        generation: 0,
        last_message_id: { timestamp: 0, counter: 0 },
        updated_at: timestamp,
      };
      return { created: true };
    });
    const pending = store.atomicRowCreationQueue.then(operation);
    store.atomicRowCreationQueue = pending.catch(() => {});
    return pending;
  };

  store.getDatabaseRowCollab = async (workspaceId, rowId) => {
    const row = store.state.databaseRowCollabDocuments[rowId];
    if (!row || row.workspace_id !== workspaceId) return null;
    return {
      object_id: rowId,
      doc_state: new Uint8Array(row.document_state),
      state_vector: new Uint8Array(row.state_vector),
      version: 0,
      collab_version: row.collab_version,
      last_message_id: { ...(row.last_message_id || { timestamp: 0, counter: 0 }) },
    };
  };

  // Task 79: distinguishes "this row id exists, just in a different
  // workspace" (a cross-workspace access attempt -- must still be rejected)
  // from "this row id has never existed anywhere" (a client legitimately
  // subscribing ahead of its own imminent, same-workspace creation) for the
  // WS DatabaseRow admission branch, which cannot tell those apart from
  // getDatabaseRowCollab's workspace-scoped null alone.
  store.getDatabaseRowWorkspaceId = async (rowId) => store.state.databaseRowCollabDocuments[rowId]?.workspace_id ?? null;

  store.acceptDatabaseRowCollabUpdate = ({ workspaceId, rowId, flags, payload, beforeStateVector, collabVersion, restoreId, messageKey }) => {
    const operation = async () => {
      const previousState = structuredClone(store.state);
      try {
        return await mutate(store, (s) => {
          const row = s.databaseRowCollabDocuments[rowId];
          if (!row || row.workspace_id !== workspaceId) {
            const notFoundError = new Error('Collaboration document or row not found');
            notFoundError.code = 'COLLAB_DOCUMENT_NOT_FOUND';
            throw notFoundError;
          }
          const prepared = preparePageCollabUpdate({
            objectId: rowId,
            documentState: row.document_state,
            flags,
            payload,
            beforeStateVector,
            collabVersion,
            expectedCollabVersion: row.collab_version,
            restoreId,
            expectedRestoreId: row.restore_id,
          });
          const payloadDigest = createHash('sha256').update(Buffer.from(payload)).digest('hex');
          const updates = s.databaseRowCollabUpdates[rowId] || (s.databaseRowCollabUpdates[rowId] = []);
          const existing = updates.find((item) => item.payload_digest === payloadDigest ||
            (messageKey && item.message_key === messageKey));
          if (existing) {
            return {
              status: 'duplicate',
              duplicate: true,
              durable: true,
              acknowledged: true,
              messageId: { ...existing.message_id },
              documentState: new Uint8Array(row.document_state),
              stateVector: new Uint8Array(row.state_vector),
              generation: row.generation,
              collabVersion: row.collab_version,
              restoreId: row.restore_id,
              lastMessageId: { ...row.last_message_id },
            };
          }
          const previousRid = s.workspaceRids[workspaceId] || { timestamp: 0, counter: 0 };
          let timestamp = Math.max(Date.now(), previousRid.timestamp);
          let counter = timestamp === previousRid.timestamp ? previousRid.counter + 1 : 0;
          if (counter > 0xffff_ffff) {
            timestamp += 1;
            counter = 0;
          }
          const messageId = { timestamp, counter };
          s.workspaceRids[workspaceId] = { ...messageId };
          row.document_state = Array.from(prepared.documentState);
          row.state_vector = Array.from(prepared.stateVector);
          row.generation += 1;
          row.last_message_id = { ...messageId };
          row.updated_at = new Date().toISOString();
          updates.push({
            payload_digest: payloadDigest,
            message_key: messageKey || null,
            message_id: { ...messageId },
          });
          return {
            status: 'applied',
            duplicate: false,
            durable: true,
            acknowledged: true,
            messageId,
            documentState: new Uint8Array(row.document_state),
            stateVector: new Uint8Array(row.state_vector),
            generation: row.generation,
            collabVersion: row.collab_version,
            restoreId: row.restore_id,
            lastMessageId: { ...row.last_message_id },
          };
        });
      } catch (error) {
        store.state = previousState;
        throw error;
      }
    };
    const pending = store.databaseRowCollabUpdateQueue.then(operation);
    store.databaseRowCollabUpdateQueue = pending.catch(() => {});
    return pending;
  };

  Object.assign(store, createAiJsonStorage(store, mutate));
  return store;
}

// Recomputes a Yjs state vector from a full document state (used after
// restore, since the stored version's own state vector was captured at
// snapshot time and the active row's vector must reflect the state actually
// installed).
function computeStateVectorFromDocumentState(documentStateArray) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Uint8Array.from(documentStateArray));
    return Array.from(Y.encodeStateVector(doc));
  } finally {
    doc.destroy();
  }
}

export async function persist(file, state) {
  // Concurrent calls (separate update queues -- page/database/row/view
  // creation -- all persist to the same file independently) must never
  // share a temp path: if two writes land on the same `${file}.tmp-<pid>`,
  // the second rename can ENOENT because the first already moved that path
  // away, which previously surfaced as a crashed WebSocket admission or an
  // unlogged 500 on unrelated REST endpoints (e.g. move-to-trash).
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function mutate(store, fn) {
  const result = await fn(store.state);
  if (store.persist) await store.persist(store.state);
  else await persist(store.file, store.state);
  return result;
}
