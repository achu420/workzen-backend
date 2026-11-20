// Workspace operations the web client calls for everyday editing but the original prototype never routed:
// page icon, move (drag and drop / "Move to"), duplicate, trash restore-all / empty, leave workspace, member
// removal, invite by email, rename a space, and the "no integrations" answer. Mounted from server.js like ai-routes.
//
// Authorization is the same membership model as the rest of the server; the few destructive workspace-level
// actions (empty trash, remove member) need an owner or admin.
import { createHash, randomUUID } from 'node:crypto';
import { addedToWorkspaceEmail, inviteEmail, testEmail } from './email-templates.js';

const ICON_VALUE_MAX = 2000;
const SUFFIX_MAX = 100;
const NAME_MAX = 200;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createWorkspaceOpsRoutes({ store, helpers }) {
  const { requireWorkspace, send, appFlowyResponse, error, body, now, validateUuid, pageSortKey, isSupportedPublicSpacePermission, mailer, publicBaseUrl } = helpers;
  const emailTestLog = new Map();
  const done = (res) => send(res, 200, appFlowyResponse(null));
  const isManager = (access) => ['owner', 'admin'].includes(access.membership.role);

  // Array request bodies (invite, remove members) are valid here; the shared body() reader accepts objects only.
  async function readJsonValue(req) {
    let raw = '';

    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 200_000) throw Object.assign(new Error('body too large'), { status: 413 });
    }
    req.rawBody = raw;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('invalid JSON body'), { status: 400 });
    }
  }

  const isDocumentPage = (page) => (page.layout ?? 0) === 0 && page.extra?.is_database_container !== true && !page.extra?.row_document;

  // A page can live under a Space or under another (non-trashed) document page of the same workspace.
  async function resolveParent(workspaceId, parentId) {
    if (!validateUuid(parentId)) return null;
    const space = await store.getSpace(parentId);

    if (space) return space.workspace_id === workspaceId && isSupportedPublicSpacePermission(space.permission) ? { kind: 'space', record: space } : null;
    const page = await store.getPage(parentId);

    if (!page || page.workspace_id !== workspaceId || page.is_trashed || !isDocumentPage(page)) return null;
    return { kind: 'page', record: page };
  }

  async function isDescendantOf(workspaceId, candidateId, ancestorId) {
    let cursor = candidateId;

    for (let guard = 0; cursor && guard < 64; guard += 1) {
      if (cursor === ancestorId) return true;
      const page = await store.getPage(cursor);

      if (!page || page.workspace_id !== workspaceId) return false;
      cursor = page.parent_view_id;
    }
    return false;
  }

  async function orderedSiblings(workspaceId, parentId, excludeId) {
    return (await store.listPages(workspaceId))
      .filter((page) => page.parent_view_id === parentId && !page.is_trashed && page.id !== excludeId)
      .sort((left, right) => pageSortKey(left) - pageSortKey(right) || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
  }

  // Key that puts a page directly after `prevId` (or first when null) among the given ordered siblings.
  function keyAfter(siblings, prevId) {
    if (!prevId) return siblings.length ? pageSortKey(siblings[0]) - 1000 : Date.now();
    const index = siblings.findIndex((page) => page.id === prevId);

    if (index < 0) return null;
    const prevKey = pageSortKey(siblings[index]);
    const next = siblings[index + 1];

    return next ? (prevKey + pageSortKey(next)) / 2 : prevKey + 1000;
  }

  async function handleMove(res, access, pageId, b) {
    const parentId = b.new_parent_view_id;
    const prevId = b.prev_view_id ?? null;

    if (!validateUuid(pageId) || !validateUuid(parentId) || (prevId !== null && !validateUuid(prevId))) {
      return error(res, 400, 'INVALID_INPUT', 'new_parent_view_id (and optional prev_view_id) must be valid view ids');
    }
    const page = await store.getPage(pageId);

    if (!page || page.workspace_id !== access.workspace.id || page.is_trashed) return error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
    const parent = await resolveParent(access.workspace.id, parentId);

    if (!parent) return error(res, 400, 'INVALID_PARENT', 'The destination must be a space or a document page in this workspace');
    if (page.id === parentId || await isDescendantOf(access.workspace.id, parentId, page.id)) {
      return error(res, 400, 'INVALID_PARENT', 'A page cannot be moved into itself or one of its own sub-pages');
    }
    if (page.extra?.row_document) return error(res, 400, 'INVALID_MOVE', 'A card document cannot be moved');
    const currentParent = page.parent_view_id ? await store.getPage(page.parent_view_id) : null;

    if (currentParent?.extra?.is_database_container === true && currentParent.id !== parentId) {
      return error(res, 400, 'INVALID_MOVE', 'A database view cannot be moved out of its database');
    }
    const siblings = await orderedSiblings(access.workspace.id, parentId, page.id);
    const sortKey = keyAfter(siblings, prevId);

    if (sortKey === null) return error(res, 400, 'INVALID_INPUT', 'prev_view_id is not a child of the destination');
    await store.movePage(page.id, access.workspace.id, { parent_view_id: parentId, sort_key: sortKey }, now());
    return done(res);
  }

  async function handleDuplicate(res, access, pageId, b) {
    const workspaceId = access.workspace.id;
    const source = validateUuid(pageId) ? await store.getPage(pageId) : null;

    if (!source || source.workspace_id !== workspaceId || source.is_trashed) return error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
    const suffix = typeof b.suffix === 'string' ? b.suffix : ' (Copy)';

    if (suffix.length > SUFFIX_MAX) return error(res, 400, 'INVALID_INPUT', 'suffix is too long');
    const parentId = b.parent_view_id ?? source.parent_view_id;
    const parent = await resolveParent(workspaceId, parentId);

    if (!parent) return error(res, 400, 'INVALID_PARENT', 'The destination must be a space or a document page in this workspace');
    const all = (await store.listPages(workspaceId)).filter((page) => !page.is_trashed);
    const includeChildren = b.include_children !== false;
    const subtree = [];
    const walk = (page) => {
      subtree.push(page);
      if (includeChildren) for (const child of all.filter((item) => item.parent_view_id === page.id)) walk(child);
    };

    walk(source);
    if (subtree.some((page) => !isDocumentPage(page))) {
      return error(res, 400, 'DUPLICATE_UNSUPPORTED', 'Only document pages can be duplicated for now; this page contains a database or card view');
    }
    const collabs = await Promise.all(subtree.map((page) => store.getPageCollab(workspaceId, page.id)));

    if (collabs.some((collab) => !collab)) return error(res, 409, 'SOURCE_NOT_READY', 'This page has not been opened yet; open it once and try again');
    const idMap = new Map(subtree.map((page) => [page.id, randomUUID()]));
    const baseMs = Date.now();
    const timestamp = now();
    const siblings = source.parent_view_id === parentId ? await orderedSiblings(workspaceId, parentId, null) : [];
    const sortKey = siblings.length ? keyAfter(siblings, source.id) : baseMs;
    const entries = subtree.map((page, index) => {
      const isRoot = index === 0;
      const collab = collabs[index];

      return {
        page: {
          id: idMap.get(page.id),
          workspace_id: workspaceId,
          parent_view_id: isRoot ? parentId : idMap.get(page.parent_view_id),
          title: isRoot ? `${page.title}${suffix}`.slice(0, NAME_MAX) : page.title,
          icon: page.icon ?? null,
          extra: page.extra ?? null,
          is_favorite: false,
          document: {},
          schema_version: 'appflowy-document-v1',
          creator_id: access.user.id,
          version: 1,
          created_at: new Date(baseMs + index).toISOString(),
          updated_at: timestamp,
          position: isRoot ? { kind: 'end', ...(sortKey ? { sort_key: sortKey } : {}) } : { kind: 'end' },
        },
        collab: { collabVersion: collab.collab_version, documentState: collab.doc_state, stateVector: collab.state_vector },
      };
    });
    const requestId = randomUUID();

    await store.createDocumentTreeFromTemplate({
      entries,
      request: { request_id: requestId, request_digest: createHash('sha256').update(JSON.stringify(entries.map((entry) => entry.page.id))).digest('hex') },
    });
    return done(res);
  }

  const INVITATION_DAYS = 14;

  async function handleInvite(res, access, req) {
    const list = await readJsonValue(req);

    if (!isManager(access)) return error(res, 403, 'MEMBER_MANAGE_FORBIDDEN', 'Only workspace owners and admins can invite people');
    if (!Array.isArray(list) || list.length === 0 || list.length > 50 || list.some((entry) => typeof entry?.email !== 'string')) {
      return error(res, 400, 'INVALID_INPUT', 'Send a list of up to 50 { email } entries');
    }
    const base = publicBaseUrl(req);
    const inviterName = access.user.name || access.user.email;
    const invited = [];
    const failures = [];

    for (const entry of list) {
      const email = entry.email.trim().toLowerCase();
      const user = await store.findUserByEmail(email);

      if (user) {
        if (!(await store.getMembership(access.workspace.id, user.id))) {
          await store.saveMembership({ workspace_id: access.workspace.id, user_id: user.id, role: 'member', created_at: now() });
          void mailer.send({ to: email, ...addedToWorkspaceEmail({ inviterName, workspaceName: access.workspace.name, url: `${base}/app/${access.workspace.id}` }) });
        }
        continue;
      }
      // No account yet: keep a pending invitation (creating the account with this address accepts it, even when
      // sign-up is otherwise closed) and e-mail them.
      await store.upsertWorkspaceInvitation({
        id: randomUUID(), workspace_id: access.workspace.id, email, role: 'member', invited_by: access.user.id,
        created_at: now(), expires_at: new Date(Date.now() + INVITATION_DAYS * 86_400_000).toISOString(),
      });
      invited.push(email);
      if (!mailer.enabled) continue;
      const sent = await mailer.send({ to: email, ...inviteEmail({ inviterName, workspaceName: access.workspace.name, signupUrl: `${base}/login?action=signUpPassword` }) });

      if (!sent.sent) failures.push(sent.reason === 'undeliverable_address' ? `${email} (not a real mailbox)` : `${email} (${sent.message ?? sent.reason})`);
    }
    if (invited.length && !mailer.enabled) {
      return error(res, 400, 'EMAIL_NOT_CONFIGURED', `Invitation saved for ${invited.join(', ')}, but this server cannot send e-mail yet. Tell them to create an account with that address and they will be added automatically.`);
    }
    if (failures.length) {
      return error(res, 400, 'EMAIL_FAILED', `Invitation saved, but the e-mail could not be delivered to: ${failures.join(', ')}. They can still create an account with that address and will be added automatically.`);
    }
    return done(res);
  }

  async function handleRemoveMembers(res, access, req) {
    const emails = await readJsonValue(req);

    if (!isManager(access)) return error(res, 403, 'MEMBER_MANAGE_FORBIDDEN', 'Only workspace owners and admins can remove members');
    if (!Array.isArray(emails) || emails.length === 0 || emails.length > 50 || emails.some((email) => typeof email !== 'string')) {
      return error(res, 400, 'INVALID_INPUT', 'Send a list of up to 50 email addresses');
    }
    const targets = [];

    for (const email of emails) {
      const user = await store.findUserByEmail(email.trim().toLowerCase());
      const membership = user ? await store.getMembership(access.workspace.id, user.id) : null;

      if (!membership) {
        const pending = (await store.listWorkspaceInvitations(access.workspace.id)).find((invitation) => invitation.email === email.trim().toLowerCase());

        if (pending) await store.deleteWorkspaceInvitation(access.workspace.id, pending.id);
        continue;
      }
      if (membership.role === 'owner') return error(res, 400, 'CANNOT_REMOVE_OWNER', 'The workspace owner cannot be removed');
      if (membership.role === 'admin' && access.membership.role !== 'owner') return error(res, 403, 'MEMBER_MANAGE_FORBIDDEN', 'Only the owner can remove an admin');
      targets.push(user);
    }
    for (const user of targets) await store.deleteMembership(access.workspace.id, user.id);
    return done(res);
  }

  // Spaces are all public (the one supported permission model), so these answers are derived, not stored.
  const accessLevel = (access) => (isManager(access) ? 50 : 30);
  const permissionResponse = (access, space) => ({
    space_id: space.id,
    permission: space.permission,
    current_user_access_level: accessLevel(access),
    can_manage_space: isManager(access),
    can_manage_members: false,
    can_invite_members: isManager(access),
    can_edit_sidebar: true,
    explicit_member_count: 0,
  });

  async function loadSpace(access, spaceId) {
    const space = validateUuid(spaceId) ? await store.getSpace(spaceId) : null;

    return space && space.workspace_id === access.workspace.id ? space : null;
  }

  // name / space_icon / space_icon_color, shared by PATCH /space/{id} and PATCH /spaces/{id}.
  function spaceChanges(b) {
    const changes = {};

    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > NAME_MAX) return { error: 'A valid space name is required' };
      changes.name = b.name.trim();
    }
    for (const [key, max] of [['space_icon', 500], ['space_icon_color', 128]]) {
      if (b[key] === undefined) continue;
      if (typeof b[key] !== 'string' || b[key].length > max) return { error: `${key} is invalid` };
      changes[key] = b[key];
    }
    return { changes };
  }

  async function handle({ req, res, url, parts, method }) {
    const [root, area, workspaceId, third, fourth, fifth] = parts;

    if (root !== 'api') return false;
    if (area === 'integrations' && method === 'GET' && workspaceId === 'connections' && parts.length === 3) {
      send(res, 200, appFlowyResponse({ connections: [] }), { 'cache-control': 'private, no-store' });
      return true;
    }
    if (area !== 'workspace' || !workspaceId) return false;

    const isPageView = third === 'page-view' && fourth && parts.length === 6;

    if (isPageView && method === 'POST' && ['update-icon', 'move', 'duplicate'].includes(fifth)) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      const b = await body(req);

      if (fifth === 'move') await handleMove(res, access, fourth, b);
      else if (fifth === 'duplicate') await handleDuplicate(res, access, fourth, b);
      else {
        const icon = b.icon ?? null;
        const valid = icon === null || (isPlainObject(icon) && typeof icon.value === 'string' && icon.value.length <= ICON_VALUE_MAX && (icon.ty === undefined || typeof icon.ty === 'number' || typeof icon.ty === 'string'));
        const page = valid && validateUuid(fourth) ? await store.getPage(fourth) : null;

        if (!valid) error(res, 400, 'INVALID_INPUT', 'icon must be null or { ty, value }');
        else if (!page || page.workspace_id !== access.workspace.id) error(res, 404, 'VIEW_NOT_FOUND', 'View not found');
        else {
          await store.updatePageMetadata(page.id, access.workspace.id, { icon }, now());
          done(res);
        }
      }
      return true;
    }
    if (third === 'delete-all-pages-from-trash' && method === 'POST' && parts.length === 4) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      if (!isManager(access)) { error(res, 403, 'TRASH_EMPTY_FORBIDDEN', 'Only workspace owners and admins can empty the trash'); return true; }
      for (const page of await store.listTrashedPages(access.workspace.id)) await store.deletePagePermanently(page.id, access.workspace.id);
      done(res);
      return true;
    }
    if (third === 'restore-all-pages-from-trash' && method === 'POST' && parts.length === 4) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      for (const page of await store.listTrashedPages(access.workspace.id)) await store.setPageTrashed(page.id, access.workspace.id, false, now());
      done(res);
      return true;
    }
    if (third === 'leave' && method === 'POST' && parts.length === 4) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      if (access.membership.role === 'owner') { error(res, 400, 'OWNER_CANNOT_LEAVE', 'The workspace owner cannot leave the workspace'); return true; }
      await store.deleteMembership(access.workspace.id, access.user.id);
      done(res);
      return true;
    }
    if (third === 'invite' && method === 'POST' && parts.length === 4) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (access) await handleInvite(res, access, req);
      return true;
    }
    if (third === 'member' && method === 'DELETE' && parts.length === 4) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (access) await handleRemoveMembers(res, access, req);
      return true;
    }
    if (third === 'email-status' && method === 'GET' && parts.length === 4) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      if (!isManager(access)) { error(res, 403, 'EMAIL_ADMIN_FORBIDDEN', 'Only workspace owners and admins can see e-mail settings'); return true; }
      send(res, 200, appFlowyResponse({ ...mailer.describe(), public_url: publicBaseUrl(req), connection: mailer.enabled ? await mailer.verify() : { ok: false, reason: 'not_configured' } }), { 'cache-control': 'private, no-store' });
      return true;
    }
    if (third === 'email-test' && method === 'POST' && parts.length === 4) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      if (!isManager(access)) { error(res, 403, 'EMAIL_ADMIN_FORBIDDEN', 'Only workspace owners and admins can send a test e-mail'); return true; }
      const b = await body(req);
      const to = typeof b.to === 'string' ? b.to.trim().toLowerCase() : access.user.email;
      const recent = (emailTestLog.get(access.user.id) ?? []).filter((time) => time > Date.now() - 3_600_000);

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || to.length > 320) { error(res, 400, 'INVALID_INPUT', 'to must be an e-mail address'); return true; }
      if (recent.length >= 5) { error(res, 429, 'TOO_MANY_TESTS', 'At most 5 test e-mails per hour'); return true; }
      emailTestLog.set(access.user.id, [...recent, Date.now()]);
      const result = await mailer.send({ to, ...testEmail({ workspaceName: access.workspace.name }) });

      if (result.sent) send(res, 200, appFlowyResponse({ sent: true, to }));
      else error(res, result.reason === 'not_configured' ? 400 : result.reason === 'undeliverable_address' ? 400 : 502, result.reason === 'not_configured' ? 'EMAIL_NOT_CONFIGURED' : result.reason === 'undeliverable_address' ? 'UNDELIVERABLE_ADDRESS' : 'EMAIL_FAILED', result.message ?? (result.reason === 'undeliverable_address' ? 'That address cannot receive e-mail (example/test domain).' : 'E-mail is not configured.'));
      return true;
    }
    if (third === 'space' && fourth && method === 'PATCH' && parts.length === 5) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      const b = await body(req);
      const space = await loadSpace(access, fourth);

      if (!space) { error(res, 404, 'SPACE_NOT_FOUND', 'Space not found'); return true; }
      if (!isManager(access)) { error(res, 403, 'SPACE_MANAGE_FORBIDDEN', 'Only workspace owners and admins can change a space'); return true; }
      const { changes, error: invalid } = spaceChanges(b);

      if (invalid) { error(res, 400, 'INVALID_SPACE', invalid); return true; }
      await store.updateSpace(space.id, access.workspace.id, changes);
      done(res);
      return true;
    }
    if (third === 'spaces' && method === 'GET' && parts.length === 4) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      const spaces = (await store.listSpaces(access.workspace.id)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

      send(res, 200, appFlowyResponse({
        spaces: spaces.map((space) => ({
          space_id: space.id,
          name: space.name,
          permission: space.permission,
          current_user_access_level: accessLevel(access),
          explicit_member_count: 0,
          is_explicit_member: false,
          can_leave: false,
        })),
      }), { 'cache-control': 'private, no-store' });
      return true;
    }
    if (third === 'spaces' && fourth && method === 'GET' && fifth === 'permission' && parts.length === 6) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      const space = await loadSpace(access, fourth);

      if (!space) error(res, 404, 'SPACE_NOT_FOUND', 'Space not found');
      else send(res, 200, appFlowyResponse(permissionResponse(access, space)), { 'cache-control': 'private, no-store' });
      return true;
    }
    if (third === 'spaces' && fourth && method === 'PATCH' && (parts.length === 5 || (parts.length === 6 && fifth === 'permission'))) {
      const access = await requireWorkspace(store, req, res, workspaceId);

      if (!access) return true;
      const b = await body(req);
      const space = await loadSpace(access, fourth);

      if (!space) { error(res, 404, 'SPACE_NOT_FOUND', 'Space not found'); return true; }
      const onlyPermission = parts.length === 6;
      const permission = onlyPermission ? b : b.permission;

      // Private and custom spaces do not exist here; the single public model may be re-sent but not changed.
      if (permission !== undefined && !isSupportedPublicSpacePermission(permission)) {
        error(res, 400, 'UNSUPPORTED_SPACE_PERMISSION', 'Only the public space permission is supported; private spaces are not available');
        return true;
      }
      if (!isManager(access)) { error(res, 403, 'SPACE_MANAGE_FORBIDDEN', 'Only workspace owners and admins can change a space'); return true; }
      if (!onlyPermission) {
        const { changes, error: invalid } = spaceChanges(b);

        if (invalid) { error(res, 400, 'INVALID_SPACE', invalid); return true; }
        await store.updateSpace(space.id, access.workspace.id, changes);
      }
      send(res, 200, appFlowyResponse(onlyPermission ? permissionResponse(access, space) : { view_id: space.id }));
      return true;
    }
    return false;
  }

  return { handle };
}
