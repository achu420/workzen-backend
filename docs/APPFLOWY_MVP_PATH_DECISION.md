# First persisted page: MVP path decision

**Date:** 2026-10-28  
**Scope:** Compare only the three requested routes. This is a product/engineering decision, not a synchronization implementation plan.

## Recommendation

**Recommend Option C — narrow the MVP to an independently owned, first-party page editor backed by the existing backend.**

This is the shortest credible path to an actual editable page with persistence. It reuses functioning authentication, membership checks, workspace bootstrap, JSON page CRUD, optimistic versions, and restart-persistence tests. It avoids claiming that JSON CRUD is AppFlowy collaboration.

This is an **explicit product trade-off**: the first working page would be in a small independent editor, not in AppFlowy-Web, and it would not demonstrate AppFlowy Yjs/WebSocket compatibility. Do not start that implementation or change the project's acceptance criteria without product-owner approval of this pivot. The original AppFlowy-Web goal remains the longer-term direction unless the owner accepts the trade-off.

## Option A — Implement the current frontend collaboration protocol

**Reuse**

- Backend password authentication, sessions, authorization, workspace provisioning, and folder outline.
- Existing page JSON CRUD as a potential separate metadata surface, but not as the editor's collaboration store.
- `yjs`, `protobufjs`, offline v1/v2 fixtures, pure offline repository behavior, and PostgreSQL collab tables/repository.
- Current Web source for client request shapes and valid page document structure.

**Major missing components**

- A persisted workspace-database collab object and relationships for the startup path (`collab_type=2`), plus the atomic page creation and folder/collab graph required to create a real page in the current client.
- Authenticated collab-state reads and the page-view response backed by correct, durable binary Yjs data.
- A WebSocket upgrade/server that authenticates and authorizes requests, decodes the current protobuf frames, performs state-vector reconciliation, and handles awareness/access messages.
- A verified server policy for `Rid` allocation/resume, durable update admission, duplicate/retry behavior, response/fan-out timing, restore/version fencing, and restart/reconnect.
- Current Web HTTP full-sync batch support and its durable result/retirement contract, even if a small happy path initially stays below the realtime frame limit.
- Browser-level edit, persistence, reconnect, restart, and authorization tests. Existing PostgreSQL collab storage is not a network adapter and has not established those wire semantics.

**Known vs. unresolved**

- Known: current Web requests workspace-database collab state; Web page creation uses a client-generated view ID; page documents use an AppFlowy-specific Yjs map/block/text structure; the collab read and page-view response shapes; the WebSocket URL and client `SyncRequest`/`Update` envelope; v1/v2 Yjs updates and client state-vector behavior.
- Unresolved: workspace database bootstrap bytes/schema as a server-owned record; whether rendering completes before a full successful sync; server response sequence and manifest policy; `Rid` ordering and cursor replay; realtime durable acknowledgement; duplicate admission and HTTP/WebSocket convergence; restore and compaction transitions. Seven conformance vectors remain pending.

**Rough effort in milestones**

At least **6–9 substantial implementation milestones**, preceded by a server-contract evidence gate: workspace database + atomic page graph; binary storage integration; collab/page-view reads; authenticated WebSocket handshake; manifest/read exchange; durable write admission and cursor/ack behavior; reconnect/restart; HTTP batch fallback and restore/version handling; end-to-end authorization and browser proof. The exact count could grow when unresolved server behavior is established. This is not a small endpoint task.

**Evidence required for success**

The actual checked-out Web client must open a persisted page, complete its initial collab and socket exchange, edit unique text, receive the real server's durable outcome, and reopen after disconnect and backend restart with that exact text. Tests must also prove unauthorized reads/writes fail, duplicate retry is safe, and the HTTP lane (if used) agrees with realtime state. A fixture round-trip or HTTP 200 is not sufficient.

**Licensing and maintenance**

The checked-out AppFlowy-Web and AppFlowy source repositories identify AGPL-3.0. Reusing or modifying their frontend code requires a deliberate license-compliance review, including source obligations for a network-served modified frontend. This is not a legal conclusion. Independently implementing a compatible protocol still carries ongoing work to track frontend protocol changes. Existing source fixtures are test artifacts, not permission to misrepresent compatibility.

## Option B — Find a smaller, verifiable compatibility target

**Reuse**

- The historical report identifies Web commit `3ff072838202a4d47f0fa6683b4179fd0ad5fb4f` as a plausible older candidate: its core collaboration protobuf fields and legacy `web-update` request shape have source-level overlap with archived Cloud commit `c5bcfd33edd46ced4a9b4fdb7ddb3bbf8c0326da`.
- Some archived Cloud code and tests can inform a narrowly isolated compatibility test; the current backend's auth/workspace/page JSON functionality is still reusable only if a replacement backend is independently implemented.

**Major missing components**

- There is no end-to-end proof that the historical frontend and archived Cloud actually authenticate, open, edit, persist, and reopen a page. The prior attempt was **BLOCKED**, not passed or failed, because a safe isolated runtime could not be established.
- For the independent backend product, the older frontend still needs a compatible persisted page/folder service, binary collab storage, WebSocket server, authorization, and restart behavior. Running archived Cloud would not deliver an independently controlled backend.
- No local evidence identifies a supported AppFlowy client mode that avoids collaboration or permits page editing over the existing JSON CRUD APIs.
- Choosing an old UI/protocol line adds compatibility and security maintenance: pinning source/dependencies, checking browser and auth APIs, and deciding how long to carry a divergent client.

**Known vs. unresolved**

- Known: the candidate has meaningful source-level protobuf and legacy HTTP-shape overlap with the archived Cloud revision.
- Unresolved: complete REST compatibility, actual browser operation, whether production page synchronization uses `web-update`, and durable edit/reopen behavior. Source-shape similarity and a matching message name do not establish this.
- Cloud `c5bcfd3` does not match the current Web batch `/full-sync/batch`, restore-aware fields, or newer causal-vector contract.

**Rough effort in milestones**

To establish whether this target is usable: **2–4 gated milestones** (isolated exact-revision build/runtime; auth/page-open; edit and server persistence; reconnect/reopen). The prior environment blocker may require substantial infrastructure work. If the goal remains an independent server rather than archived Cloud, expect a separate **4–7+ protocol/backend milestones** after the candidate passes; passing a Cloud test would not remove that work.

**Evidence required for success**

Use immutable exact source snapshots and isolated dependencies; demonstrate a browser edit reaching only the isolated test server, durable storage, restart/reopen, and repeatable tests. Then separately prove the independent backend implements that same exercised legacy path. No end-to-end proof currently exists.

**Licensing and maintenance**

The reviewed Web and archived Cloud revisions are AGPL-3.0. AGPL use is possible subject to its terms, not automatically disallowed; distribution/network deployment obligations and notices require legal review. Cloud is archived and its own documentation cautions against treating it as the latest supported self-hosted server. A historical frontend is also a maintenance fork, not a verified supported compatibility mode.

## Option C — Narrow the MVP to a first-party page editor

**Reuse**

- Existing password login/session validation and logout.
- Membership-scoped workspace bootstrap and authorization.
- Existing authenticated native page routes: create/list at `/api/workspaces/{workspaceId}/pages`, read/update at `/api/pages/{pageId}`.
- JSON persistence and optimistic `expected_version` checks. Existing backend regression tests include CRUD, cross-workspace denial, and data surviving reopening the app with the same isolated file.
- Current frontend may be used as reference for product requirements, but the minimal editor can be a small independent UI and need not import AppFlowy code.

**Major missing components**

- A minimal browser UI to sign in, list/select the user's workspace and pages, create a page, edit text, save, and reopen.
- A simple editor/document schema and clear UI states for save/error/conflict. The API currently stores JSON, not an AppFlowy Yjs document.
- Browser-to-backend integration tests using isolated JSON data and real reload/restart verification.
- Product approval to accept a separate first-party page experience for the MVP.

**Known vs. unresolved**

- Known: the server already supports authenticated JSON page create/list/read/update, checks workspace membership, checks ownership through the page's workspace, persists data, and uses optimistic versions.
- Unresolved: no browser editor currently exercises those endpoints; desired formatting, offline behavior, and collaboration expectations for the narrowed product still need a small product definition. This route makes no AppFlowy protocol claim.

**Rough effort in milestones**

**2–3 implementation milestones**: choose the minimal page/editor schema and UI surface; build the authenticated page list/create/edit/save flow against existing APIs; prove reload/restart persistence and authorization in a browser. If product later requires concurrent editing or AppFlowy-Web, that is a separate project scope, not implicit follow-on work.

**Evidence required for success**

In the first-party browser UI, create a page and enter unique text; verify the exact authenticated request and response, reload or restart only the isolated backend, reopen the page, and confirm the exact text. Verify another user's workspace is denied and stale versions surface a conflict instead of silently overwriting. State clearly that this proves the independent JSON page workflow only.

**Licensing and maintenance**

A first-party UI written independently can avoid importing AppFlowy AGPL code, but dependency licenses still need review. Avoid copying AppFlowy implementation code or assets without an approved compliance basis. The editor will be intentionally simpler and require less AppFlowy protocol tracking, but it does not provide AppFlowy-Web feature parity.

## Decision

Option A most directly serves the original frontend goal, but is longest and still blocked on key server semantics. Option B is not currently a verified shortcut and does not avoid implementing a backend if independence remains mandatory. Option C is the only route with a short, concrete persistence path already supported by tested backend APIs; it is recommended only as an explicit MVP product pivot, never as a claim of AppFlowy compatibility.

**Recommended option:** Option C, conditional on explicit product-owner approval of the UI/product trade-off.

**Single next implementation task:** build a minimal first-party browser page editor that uses the existing authenticated workspace and JSON page APIs, with no AppFlowy-Web or Yjs/WebSocket integration.

**What it will demonstrate:** a real user can create and edit a page in the independent UI, save it to the independent backend, and reopen the same persisted text after reload/restart, while unauthorized access is rejected. It will not demonstrate AppFlowy-Web compatibility or collaborative editing.
