// Agent (MCP) tokens and the activity trail, for the people who own them.
//
// Any workspace member can create tokens for their OWN agents (a token = this person's access on this workspace; the
// name should say which agent, e.g. "Achal's Claude Code"). Members see and revoke their own tokens; owners and admins
// see and revoke everyone's. EVERY member can read the activity trail (it is the answer to "whose agent did that?") and
// can undo an agent's change when the card is still as the agent left it.
//
// Tokens are accepted only on /mcp (see agent-auth.js); nothing here accepts one.
import { randomUUID } from 'node:crypto';
import { AGENT_TOKEN_ID_PATTERN, generateAgentToken } from './agent-auth.js';
import { CardError } from './cards.js';
import { runAsActor } from './actor-context.js';

const MAX_ACTIVE_PER_PERSON = 10;
const MAX_ACTIVE_PER_WORKSPACE = 100;

// Paging cursor "created_at|id" (newest first): a plain timestamp still works but can skip rows that share it.
export const makeCursor = (row) => `${row.created_at}|${row.id}`;
export function parseCursor(value) {
  if (!value) return null;
  const [at, id = null] = String(value).split('|');

  return Number.isNaN(Date.parse(at)) || (id !== null && !/^[0-9a-f-]{36}$/i.test(id)) ? null : { at, id };
}

const isActive = (row) => !row.revoked && !(row.expires_at && Date.parse(row.expires_at) <= Date.now());

export class UndoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sameJson = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/**
 * Reverses one recorded agent write. Refuses (409 CHANGED_SINCE) when the card is no longer as the agent left it, so an
 * undo never overwrites somebody's later edit. Runs as the person who clicked undo.
 */
// Maps a comment/card service refusal onto what the person sees in the activity list.
function commentUndoError(error) {
  if (error?.code === 'CONFLICT') return new UndoError(409, 'CHANGED_SINCE', error.message);
  if (error?.code === 'NOT_FOUND') return new UndoError(404, 'COMMENT_NOT_FOUND', 'That comment (or the page or card it was on) no longer exists.');
  return error;
}

async function undoCommentChange({ cards, pageComments, workspaceId, userId, undo }) {
  const onPage = undo.target === 'page';

  try {
    if (undo.type === 'delete_comment') {
      if (onPage) await pageComments.deleteComment({ workspaceId, userId, pageId: undo.page_id, commentId: undo.comment_id });
      else await cards.deleteCardComment({ workspaceId, cardId: undo.card_id, commentId: undo.comment_id });
      return;
    }
    // Reopen / resolve again, but only when the thread is still as the agent left it.
    const listed = onPage ? await pageComments.listComments({ workspaceId, pageId: undo.page_id }) : await cards.listCardComments({ workspaceId, cardId: undo.card_id });
    const thread = listed.comments.find((comment) => comment.id === undo.comment_id);

    if (!thread) throw new UndoError(404, 'COMMENT_NOT_FOUND', 'That comment no longer exists.');
    if (Boolean(thread.is_resolved) !== undo.expect_resolved) throw new UndoError(409, 'CHANGED_SINCE', 'The thread was resolved or reopened again after the agent changed it, so it was left alone.');
    if (onPage) await pageComments.resolveComment({ workspaceId, pageId: undo.page_id, commentId: undo.comment_id, resolved: undo.resolved });
    else await cards.resolveCardComment({ workspaceId, userId, cardId: undo.card_id, commentId: undo.comment_id, resolved: undo.resolved });
  } catch (error) {
    throw commentUndoError(error);
  }
}

export async function undoAgentChange({ cards, store, workspaceId, userId, undo, pageComments = null }) {
  if (undo.type === 'delete_comment' || undo.type === 'set_comment_resolved') return undoCommentChange({ cards, pageComments, workspaceId, userId, undo });
  if (undo.type === 'restore_page_version') {
    const page = await store.getPage(undo.page_id);
    const collab = page && page.workspace_id === workspaceId ? await store.getPageCollab(workspaceId, undo.page_id) : null;

    if (!collab) throw new UndoError(404, 'PAGE_NOT_FOUND', 'That page no longer exists.');
    if (Buffer.from(collab.state_vector).toString('base64') !== undo.expect_state_vector) {
      throw new UndoError(409, 'CHANGED_SINCE', "The page was edited after the agent's addition, so it was left alone. Restore the saved version from the page's version history if you still want to go back.");
    }
    const user = await store.getUserById(userId);

    try {
      await store.restorePageCollabVersion({ workspaceId, pageId: undo.page_id, versionId: undo.version, actorUid: user ? Number(user.uid) : null });
    } catch (error) {
      if (error?.code === 'VERSION_NOT_FOUND' || error?.code === 'VERSION_DELETED') throw new UndoError(409, 'RESTORE_POINT_GONE', 'The saved restore point no longer exists.');
      throw error;
    }
    return;
  }
  if (undo.type === 'trash_page') {
    const page = await store.getPage(undo.page_id);

    if (!page || page.workspace_id !== workspaceId) throw new UndoError(404, 'PAGE_NOT_FOUND', 'That page no longer exists.');
    if (!page.is_trashed) await store.setPageTrashed(page.id, workspaceId, true, new Date().toISOString());
    return;
  }
  const current = await cards.getCard({ workspaceId, cardId: undo.card_id }).catch((error) => {
    if (error?.code === 'NOT_FOUND') throw new UndoError(404, 'CARD_NOT_FOUND', 'That card no longer exists.');
    throw error;
  });
  const changedSince = (what) => new UndoError(409, 'CHANGED_SINCE', `${what} was changed after the agent's edit, so it was left alone. Review the card and fix it by hand.`);

  if (undo.type === 'update_card') {
    if (undo.title !== undefined && current.title !== undo.expect_title) throw changedSince('The title');
    for (const [name, value] of Object.entries(undo.expect_fields ?? {})) {
      if (!sameJson(current.fields?.[name], value)) throw changedSince(`"${name}"`);
    }
    await cards.updateCard({ workspaceId, userId, cardId: undo.card_id, ...(undo.title !== undefined ? { title: undo.title } : {}), ...(undo.fields ? { fields: undo.fields } : {}) });
  } else if (undo.type === 'move_card') {
    if ((current.column ?? 'No status') !== undo.expect_column) throw changedSince('The column');
    await cards.moveCard({ workspaceId, userId, cardId: undo.card_id, column: undo.column, ...(undo.view_id ? { viewId: undo.view_id } : {}) });
  } else if (undo.type === 'archive_card') {
    await cards.archiveCard({ workspaceId, userId, cardId: undo.card_id, confirm: true });
  } else if (undo.type === 'restore_card') {
    await cards.restoreCard({ workspaceId, userId, cardId: undo.card_id, confirm: true });
  } else {
    throw new UndoError(400, 'NOT_UNDOABLE', 'This kind of change cannot be undone automatically.');
  }
}

export function createAgentRoutes({ store, cards, pageComments = null, helpers }) {
  const { requireWorkspace, send, appFlowyResponse, body, now } = helpers;
  const fail = (res, status, code, message) => send(res, status, { code: status, message, error: { code, message } });
  const isManager = (access) => ['owner', 'admin'].includes(access.membership.role);

  async function ownersById(workspaceId) {
    const members = await store.listWorkspaceMembers(workspaceId);

    return new Map(members.map(({ user }) => [user.id, { user_id: user.id, name: user.name || user.email, email: user.email }]));
  }

  const publicToken = (row, owners, viewerId) => ({
    id: row.id,
    name: row.name,
    scope: row.scope,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    expires_at: row.expires_at ?? null,
    revoked: !!row.revoked,
    expired: !!row.expires_at && Date.parse(row.expires_at) <= Date.now(),
    owner: owners.get(row.user_id) ?? { user_id: row.user_id, name: 'Former member', email: null },
    owned_by_me: row.user_id === viewerId,
  });

  const publicActivity = (row, owners) => ({
    id: row.id,
    token_id: row.token_id,
    agent: row.token_name,
    owner: owners.get(row.user_id) ?? { user_id: row.user_id, name: 'Former member', email: null },
    tool: row.tool,
    kind: row.kind,
    target_type: row.target_type,
    target_id: row.target_id,
    target_title: row.target_title,
    summary: row.summary,
    ok: row.ok,
    error_code: row.error_code,
    created_at: row.created_at,
    can_undo: row.ok && row.kind === 'write' && !!row.undo && !row.undone_at,
    undone: !!row.undone_at,
    undone_at: row.undone_at ?? null,
  });

  async function handleTokens(access, req, res, tokenId, method, owners) {
    const viewerId = access.user.id;

    if (method === 'GET') {
      const rows = (await store.listAgentTokens(access.workspace.id)).filter((row) => isManager(access) || row.user_id === viewerId);

      return send(res, 200, appFlowyResponse({ tokens: rows.map((row) => publicToken(row, owners, viewerId)), can_manage_all: isManager(access) }), { 'cache-control': 'private, no-store' });
    }
    if (method === 'DELETE') {
      const existing = AGENT_TOKEN_ID_PATTERN.test(tokenId ?? '') ? await store.getAgentToken(tokenId) : null;

      if (!existing || existing.workspace_id !== access.workspace.id || (!isManager(access) && existing.user_id !== viewerId)) {
        return fail(res, 404, 'AGENT_TOKEN_NOT_FOUND', 'Agent token not found');
      }
      const revoked = await store.revokeAgentToken(access.workspace.id, tokenId, now());

      return revoked ? send(res, 200, appFlowyResponse({ id: revoked.id, revoked: true })) : fail(res, 404, 'AGENT_TOKEN_NOT_FOUND', 'Agent token not found');
    }
    const input = await body(req);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const days = input.expires_in_days ?? null;

    if (Object.keys(input).some((key) => !['name', 'scope', 'expires_in_days'].includes(key))) return fail(res, 400, 'INVALID_INPUT', 'Unsupported fields in agent token request');
    if (name.length < 1 || name.length > 80) return fail(res, 400, 'INVALID_INPUT', 'name must be 1 to 80 characters');
    if (!['read', 'write'].includes(input.scope)) return fail(res, 400, 'INVALID_INPUT', "scope must be 'read' or 'write'");
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) return fail(res, 400, 'INVALID_INPUT', 'expires_in_days must be a whole number from 1 to 365, or null');
    const active = (await store.listAgentTokens(access.workspace.id)).filter(isActive);

    if (active.filter((row) => row.user_id === viewerId).length >= MAX_ACTIVE_PER_PERSON) {
      return fail(res, 400, 'TOO_MANY_AGENT_TOKENS', `You already have ${MAX_ACTIVE_PER_PERSON} active agent tokens. Revoke one you no longer use first.`);
    }
    if (active.length >= MAX_ACTIVE_PER_WORKSPACE) return fail(res, 400, 'TOO_MANY_AGENT_TOKENS', 'This workspace already has too many active agent tokens.');
    const issued = generateAgentToken();
    const createdAt = now();
    const created = await store.createAgentToken({
      id: issued.id,
      workspace_id: access.workspace.id,
      user_id: viewerId,
      name,
      token_hash: issued.hash,
      scope: input.scope,
      created_at: createdAt,
      expires_at: days === null ? null : new Date(Date.parse(createdAt) + days * 86400000).toISOString(),
    });

    return send(res, 200, appFlowyResponse({
      id: created.id, name: created.name, scope: created.scope, token: issued.token, created_at: created.created_at, expires_at: created.expires_at ?? null,
    }), { 'cache-control': 'no-store' });
  }

  async function handleActivity(access, req, res, url, parts, method, owners) {
    const params = url.searchParams;

    if (parts.length === 4 && method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number.parseInt(params.get('limit') ?? '50', 10) || 50));
      const before = params.get('before');
      const kind = params.get('kind');

      const cursor = parseCursor(before);

      if (before && !cursor) return fail(res, 400, 'INVALID_INPUT', 'before must be a timestamp or a cursor returned by this API');
      if (kind && !['read', 'write'].includes(kind)) return fail(res, 400, 'INVALID_INPUT', "kind must be 'read' or 'write'");
      const okParam = params.get('ok');
      const result = await store.listAgentActivity(access.workspace.id, {
        limit, before: cursor?.at ?? null, beforeId: cursor?.id ?? null, kind: kind || null, tokenId: params.get('token_id') || null, userId: params.get('user_id') || null,
        ok: okParam === 'true' ? true : okParam === 'false' ? false : null,
      });
      const entries = result.entries.map((row) => publicActivity(row, owners));

      return send(res, 200, appFlowyResponse({ entries, has_more: result.has_more, next_before: result.has_more ? makeCursor(result.entries.at(-1)) : null }), { 'cache-control': 'private, no-store' });
    }
    if (parts.length === 6 && parts[5] === 'undo' && method === 'POST') {
      const entry = await store.getAgentActivity(access.workspace.id, parts[4]);

      if (!entry) return fail(res, 404, 'ACTIVITY_NOT_FOUND', 'Activity entry not found');
      if (entry.undone_at) return fail(res, 409, 'ALREADY_UNDONE', 'This change was already undone.');
      if (!entry.ok || entry.kind !== 'write' || !entry.undo) return fail(res, 400, 'NOT_UNDOABLE', 'This entry cannot be undone.');
      try {
        await runAsActor({ userId: access.user.id }, () => undoAgentChange({ cards, store, workspaceId: access.workspace.id, userId: access.user.id, undo: entry.undo, pageComments: pageComments?.() ?? null }));
      } catch (error) {
        if (error instanceof UndoError) return fail(res, error.status, error.code, error.message);
        if (error instanceof CardError) return fail(res, error.code === 'NOT_FOUND' ? 404 : 400, error.code, error.message);
        throw error;
      }
      await store.markAgentActivityUndone(access.workspace.id, entry.id, access.user.id, now());
      return send(res, 200, appFlowyResponse({ id: entry.id, undone: true }));
    }
    return false;
  }

  async function handle({ req, res, url, parts, method }) {
    if (parts[0] !== 'api' || parts[1] !== 'workspace' || !parts[2]) return false;
    const isTokens = parts[3] === 'agent-tokens' && ((parts.length === 4 && ['GET', 'POST'].includes(method)) || (parts.length === 5 && method === 'DELETE'));
    const isActivity = parts[3] === 'agent-activity' && ((parts.length === 4 && method === 'GET') || (parts.length === 6 && parts[5] === 'undo' && method === 'POST'));

    if (!isTokens && !isActivity) return false;
    const access = await requireWorkspace(store, req, res, parts[2]);

    if (!access) return true;
    const owners = await ownersById(access.workspace.id);

    if (isTokens) await handleTokens(access, req, res, parts[4], method, owners);
    else await handleActivity(access, req, res, url, parts, method, owners);
    return true;
  }

  return { handle, newActivityId: randomUUID };
}
