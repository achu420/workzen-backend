# Task 65, Stage 1 — Upstream Real-Time Collaboration Architecture Audit

**Scope**: read-only investigation. No application code was changed in either repo. This document records, with file/line/function references, how upstream AppFlowy-Cloud actually distributes a Yjs update from one client to other connected clients, and how AppFlowy-Web's client actually consumes what the server sends. It supersedes informal assumptions from Tasks 63/64 with direct source evidence.

Evidence classes used throughout, explicitly labeled: **verified source behavior** (read the actual function body), **inference** (reasoned from adjacent code, not itself executed/traced), **unverified** (plausible but not confirmed), **limitation** (could not be checked in this environment).

---

## 0. Critical preliminary finding: upstream ships TWO parallel realtime stacks, and the one AppFlowy-Web actually uses is NOT the one most naturally found first

`AppFlowy-Cloud/services/appflowy-collaborate/src/` contains two independent, fully-wired realtime implementations, both instantiated by the live server in `AppFlowy-Cloud/src/application.rs`:

1. **The legacy/"v1" stack** — `rt_server.rs` (`CollaborationServer`), `group/{manager.rs,cmd.rs,state.rs,group_init.rs}` (`GroupManager`/`CollabGroup`, one Tokio task per **collab object**), `actix_ws/*`. Routed at `/ws/v1` and the older `/{token}/{device_id}` path (`AppFlowy-Cloud/src/api/ws.rs:31,40-64,66-106`). Comment at `ws.rs:38`: *"This function will not be used after the 0.5.0 of the client."*
2. **The current/"v2" stack** — `ws2/actors/{server.rs,session.rs,workspace.rs}` (`WsServer`/`Workspace`/`WsSession`) plus `collab/collab_manager.rs` (`CollabManager`). Routed at `/ws/v2/{workspace_id}` (`ws.rs:32,108-160`).

**Verified source behavior**: `AppFlowy-Web`'s real WebSocket client connects to `ws://.../ws/v2/{workspaceId}/?clientId=...&deviceId=...&token=...` (confirmed in Task 60.5's audit of `AppFlowy-Web/src/components/ws/useAppflowyWebSocket.ts`, re-confirmed this task by the URL literally matching `ws_scope()`'s `/v2/{workspace_id}` resource at `ws.rs:32`). **This means the architecturally relevant upstream mechanism for this task is the v2/`ws2`/`CollabManager`/`Workspace`-actor stack, not the v1 group/Redis-stream-per-object stack.** Both are documented below because both are real, shipped code and the v1 design is instructive (it is the direct ancestor of the v2 design and shares its core idea), but **Stage 2/3's comparison is grounded in v2**, since that is what the paired frontend (and, by extension, this independent backend, which mirrors AppFlowy-Web's real wire contract) actually speaks.

A second potential concern — a wire-format mismatch between the pinned `AppFlowy-Web` checkout and this `AppFlowy-Cloud` checkout's v2 protocol — was checked and **ruled out**: `AppFlowy-Cloud/libs/appflowy-proto/src/client_message.rs`'s `ClientMessage` enum (`Manifest`/`Update`/`AwarenessUpdate`) is a Rust-ergonomic wrapper that serializes via `pb::Message::encode_to_vec()`/`decode()` — i.e. it **is** the same `protobuf` wire format as `AppFlowy-Web/src/proto/messages.proto`'s `collab.CollabMessage` oneof (`SyncRequest`/`Update`/`AwarenessUpdate`/`AccessChanged`), not a different (e.g. bincode) encoding (`client_message.rs:126-137,141-196`). This also matches this independent backend's own `collab-protocol.js` oneof (`syncRequest|update|awarenessUpdate|accessChanged`, `collab-protocol.js:38`) field-for-field, re-confirming Task 60.5's finding.

---

## 1. The v2 (live) mechanism: workspace-scoped actor + Redis stream, not per-document groups

### 1.1 Topology

```
 Client A (tab/device)                 Client B (tab/device, same workspace)
      |  WS /ws/v2/{workspaceId}              |  WS /ws/v2/{workspaceId}
      v                                        v
 WsSession(A) ------\                    /------ WsSession(B)
                     \                  /
                      v                v
                  single Workspace actor (one per workspace_id,
                  spawned on first Join, auto-terminated 60s after
                  the last session Leaves)
                      |        ^
            publish_update()   | StreamHandler<UpdateStreamMessage>
                      |        | (subscribed in Workspace::started())
                      v        |
              CollabManager.publish_update()
                      |
                      v
         Redis Stream, keyed PER WORKSPACE (not per object):
         UpdateStreamMessage::stream_key(&workspace_id)
                      |
          (same stream is read back by the SAME Workspace actor
           instance that just wrote to it, and by every other
           server process's Workspace actor for this workspace)
```

- **One actor per workspace, not per collab object.** `Workspace` (`ws2/actors/workspace.rs:31-43`) holds `sessions_by_client_id: HashMap<ClientID, WorkspaceSessionHandle>` — every connected session (tab/device) for that workspace, regardless of which object(s) it has open. `WsServer` (`ws2/actors/server.rs:20-25,39-51`) lazily creates one `Workspace` actor per `workspace_id` on first `Join`/`WsInput`/`PublishUpdate`, each running on its own actix `Arbiter` from a round-robin pool (`ArbiterPool`, `server.rs:269-302`).
- **Verified**: `Workspace::started()` (`workspace.rs:345-363`) subscribes to exactly one Redis stream per workspace (`update_streams_key = UpdateStreamMessage::stream_key(&self.workspace_id)`, `workspace.rs:347-352`) and one awareness stream (`workspace_awareness_stream`, `workspace.rs:353-357`) — both scoped to the whole workspace, carrying every object's traffic.

### 1.2 Update admission (client → server)

**Verified source behavior**, `workspace.rs:173-205` (`Workspace::hande_ws_input`, `InputMessage::Update` arm):
1. Empty updates are dropped (`is_empty_update`, `workspace.rs:174-177,922-926`).
2. Write permission is checked **per session, per object**, with a 5-minute TTL cache (`sender.can_write_collab(&store, &msg.object_id)`, `workspace.rs:180-191`, cache impl `workspace.rs:819-851`). On failure the update is silently dropped (no error frame to the client).
3. `store.publish_update(workspace_id, object_id, collab_type, &msg.sender, update)` is called (`workspace.rs:193-201`) → `CollabManager::publish_update` (`collab/collab_manager.rs:239-278`), which **does not touch any in-memory Y.Doc and does not broadcast directly**. It XADDs the update to the workspace's Redis stream via `UpdateStreamMessage::prepare_command(...).query_async(...)` (`collab_manager.rs:255-266`) and returns a server-assigned `Rid` parsed from the Redis command's reply (`collab_manager.rs:267`).
4. **There is no acknowledgement sent back to the submitting client.** `hande_ws_input`'s `Update` arm (`workspace.rs:173-205`) only logs on error; nothing is sent to `msg.sender`'s own `WsSession`. The `ClientMessage`/`ServerMessage` protobuf schema (`appflowy-proto/src/{client_message.rs,server_message.rs}`, cross-checked against `AppFlowy-Web/src/proto/messages.proto`) has **no ack/CollabAck message type at all** — only `Manifest`, `Update`, `AwarenessUpdate`, `AccessChanges`/`AccessChanged`. This is architecturally consistent with Yjs being local-first: the client already applied its own edit to its local `Y.Doc` optimistically before sending (confirmed in Stage 1.4 below) and does not need a round-trip to consider the edit "applied."

### 1.3 Distribution to other clients (the actual broadcast mechanism)

**Verified source behavior**, `workspace.rs:394-461` (`impl StreamHandler<anyhow::Result<UpdateStreamMessage>> for Workspace`):
1. The `Workspace` actor itself is the Redis-stream consumer (it subscribed in `started()`). Every message that lands on the workspace's Redis stream — regardless of which session originally wrote it, and regardless of whether that session is attached to *this* `Workspace` actor instance (relevant in a multi-process deployment) — triggers this handler.
2. `self.sessions_by_client_id.values()` (the live roster of every session currently joined to this workspace, across every open object) is filtered to **exclude the origin** (`s.collab_origin != msg.sender`, `workspace.rs:423-428`) — i.e. every other connected session, not a per-object subscriber list.
3. For each remaining session, a **per-object read-permission check** runs again (`session.can_read_collab(&store, &object_id)`, `workspace.rs:437`), and only if it passes does the actor send `WsOutput{ ServerMessage::Update{...} }` directly to that session's `Addr<WsSession>` (`workspace.rs:438-446`), which the session actor turns into a binary WS frame (`session.rs:189-201`).
4. **This is the entire "other clients see the change" mechanism.** There is no per-object subscriber-registration step distinct from "is this session joined to the workspace and does it have read permission on this specific object" — the workspace-wide session roster plus a per-send permission check *is* the fan-out list.
5. Awareness updates follow an exactly parallel path through a **separate** Redis awareness stream (`AwarenessGossip`/`AwarenessStreamUpdate`), handled by `impl StreamHandler<(ObjectId, Arc<AwarenessStreamUpdate>)> for Workspace` (`workspace.rs:464-489`) — same "iterate all other joined sessions, skip the origin, send" shape (`workspace.rs:475-487`), just without the read-permission check.

**Key structural fact for Stage 2/3**: the origin-exclusion and the broadcast loop are the *same kind of code* for Update and for AwarenessUpdate (two near-identical `StreamHandler` impls, `workspace.rs:394-461` vs `464-489`) — upstream did not invent a different mechanism for content vs. presence; it is the same "loop over other joined sessions, skip sender, send" pattern applied twice.

### 1.4 Reconnect / catch-up (not the live-broadcast path, but adjacent)

**Verified source behavior**, `Workspace::publish_collabs_created_since` (`workspace.rs:222-324`), invoked from `Handler<Join>` when the joining session supplies a `last_message_id` (`workspace.rs:491-538`):
- Fetches collabs created in the workspace since that timestamp (`store.get_collabs_created_since`, `workspace.rs:239-287`) and sends their full doc-state as `ServerMessage::Update` frames, then fetches `store.get_workspace_updates(&workspace_id, last_message_id)` (incremental updates since that Rid, `workspace.rs:289-321`) and sends each as `ServerMessage::Update` too, **per-session read-permission gated** (`workspace.rs:249-260,299-311`).
- This is upstream's catch-up mechanism for a client that was offline/disconnected — distinct from, and in addition to, a client's own per-object `Manifest`/state-vector exchange (`InputMessage::Manifest`, `workspace.rs:96-172`), which is the direct analogue of this independent backend's `SyncRequest`/state-vector handshake.

### 1.5 Persistence timing relative to the live broadcast

**Verified source behavior**: persistence to the durable store (Postgres-backed `CollabCache`/`af_collab`, per Task 60.5 §3) is **not** part of the request/broadcast path at all in v2. `Workspace` schedules a periodic `Snapshot` message every 60s (`Workspace::SNAPSHOT_INTERVAL`, `workspace.rs:46,358`) and on actor shutdown (`workspace.rs:376-383`), which calls `store.snapshot_workspace(workspace_id, up_to)` (`workspace.rs:613-634`) — i.e. **durability to the long-term store is asynchronous and decoupled from both the (nonexistent) ack and the broadcast.** The only "durability" an update has at broadcast time is "it is in the Redis stream," which is itself not guaranteed-durable unless Redis's own persistence (AOF/RDB) is configured — this is a real, acknowledged upstream design trade-off (optimize for low broadcast latency and horizontal scalability; tolerate a bounded data-loss window on Redis failure before the next periodic snapshot), not an oversight.

---

## 2. The v1 (legacy) mechanism, for context: collaboration groups + Redis stream per object

Not the live path for `/ws/v2`, but documented because it is real, shipped code, structurally the direct ancestor of v2's design, and useful for understanding why upstream's `Rid` field is explicitly commented "Redis stream message Id" (Task 60.5 finding, re-confirmed: `AppFlowy-Web/src/proto/messages.proto` + `appflowy-proto`'s `Rid` type).

**Verified source behavior**:
- One **collaboration group** (`CollabGroup`, `group/group_init.rs:49-78`) is created **per collab object** on first access (`GroupManager::create_group`, `group/manager.rs:106-159`), holding `subscribers: DashMap<RealtimeUser, Subscription>` (`group_init.rs:61`) — the direct-per-object analogue of v2's workspace-wide session roster.
- A client's update is routed to the owning object's group via a per-object Tokio task (`GroupCommandRunner`, `group/cmd.rs:61-134`, spawned on demand in `CollaborationServer::create_group_if_not_exist`, `rt_server.rs:289-316`), which forwards the raw message into the sending user's own per-user broadcast channel (`ClientMessageRouter.stream_tx`, `client/client_msg_router.rs:27-45`), filtered back down to the one object by a per-(user,object) subscription task set up in `init_client_communication` (`client_msg_router.rs:56-147`).
- Inside the group, `handle_sync_step2`/`handle_update` (`group_init.rs:741-847`) call `persister.send_update()` (`group_init.rs:983-1001`), which **XADDs to a Redis stream and returns**, exactly like v2's `publish_update`.
- A **separate** `inbound_task` per group (`group_init.rs:177-208`, spawned in `CollabGroup::new`, `group_init.rs:130-137`) subscribes to that same per-object Redis stream and, on each message, loops `state.subscribers.iter_mut()`, skips the origin (`message.origin == subscription.collab_origin`, `group_init.rs:241`), and sends a `BroadcastSync` to everyone else (`group_init.rs:239-255`). Awareness has its own parallel `inbound_awareness_task` (`group_init.rs:267-320`).
- **Difference from v2 that matters for understanding the design evolution, not for the gap analysis**: v1 *does* send an ack back to the sender (`CollabAck`, `group/cmd.rs:14,204-209`, `group_init.rs:605-653`) — gated on the Redis XADD succeeding, same timing as this independent backend's "persist-before-ack" except upstream's "persist" here means "written to Redis," not "written to the Postgres-backed long-term store" (that's the group's own periodic `snapshot_task`, `group_init.rs:322-353`, structurally identical in spirit to v2's `Workspace::Snapshot`).

**Conclusion for Stage 2/3**: whichever stack is examined, the underlying idea is identical and is the single most important fact this audit establishes: **upstream's "other clients see the change" step is always a maintained, live roster of currently-connected sessions/subscribers for the relevant scope (per-object in v1, per-workspace in v2), iterated and pushed to (minus the origin) whenever an accepted update becomes visible — never a redirect-the-client-to-poll-again design.** Persistence to the long-term store is always decoupled from this broadcast (asynchronous snapshot), and in v1 an ack is sent to the sender but in the live v2 protocol it is not.

---

## 3. AppFlowy-Web client: already fully able to consume a server-pushed Update it didn't request

**Verified source behavior**, `AppFlowy-Web/src/application/services/js-services/sync-protocol.ts`:
- `handleUpdate(ctx, message)` (`sync-protocol.ts:220-254`) applies **any** incoming `Update` frame to the doc via `Y.applyUpdate(doc, message.payload!, 'remote')` (or `applyUpdateV2` for the v2 flag), unconditionally — it has no notion of "this is an ack of my own change" vs. "this is someone else's push." It updates `ctx.lastMessageId` and, if the applied update revealed pending structs/deletes it can't yet resolve, emits a fresh `SyncRequest` (`sync-protocol.ts:239-253`).
- `handleMessage(ctx, message)` (`sync-protocol.ts:384-400`) is the single dispatch point for every incoming `CollabMessage` on an already-open object — `update` → `handleUpdate`, `syncRequest` → `handleSyncRequest`, `accessChanged` → `handleAccessChanged`, `awarenessUpdate` → `handleAwarenessUpdate`. It is invoked uniformly regardless of the message's origin or purpose.
- `onUpdate` (the local-doc observer registered in `initSync`, `sync-protocol.ts:288-313`) explicitly ignores its own echo: `if (origin === CollabOrigin.Remote) return;` (`sync-protocol.ts:289`) — i.e. the client already defends against reapplying a server-pushed update as if it were a fresh local edit. Applying the *same bytes* twice (e.g. a self-echoed ack) is a no-op under Yjs CRDT semantics regardless.
- `useCollabMessageHandler.ts` (`AppFlowy-Web/src/components/ws/sync/useCollabMessageHandler.ts:42-364`) is the React-side intake for every WS frame (`wsCollabMessage`) and sibling-tab `BroadcastChannel` frame (`bcCollabMessage`); `applyCollabMessage` (`useCollabMessageHandler.ts:55-365`) routes to `handleMessage` for an already-registered sync context (`handleOnActiveContext`, `useCollabMessageHandler.ts:128-167`) with no special-casing for whether the frame was solicited.

**Conclusion, with confidence**: the frontend imposes **no blocker** on a backend sending an unsolicited `Update` frame for an object a client currently has open — this is precisely the shape of message the real upstream v2 `Workspace` actor sends in its broadcast step (§1.3), and it is exactly the shape of message this independent backend already sends to the *originating* socket as its ack (`server.js` ~1788-1798/1945-1955/2106-2116, cited in the companion gap-analysis document). No frontend change is implicated by anything found in this audit.

---

## 4. What upstream does NOT do (explicitly checked, not assumed)

- **No per-cell or per-row CRDT merge logic server-side** — already established by Task 60 (`collab-database`'s flat `HashMap<String,Any>` last-write-wins cells); not re-litigated here, cited for completeness since it bears on "concurrent editing" in the Stage 2 comparison table.
- **No message-broker abstraction beyond Redis** — both v1 and v2 use `collab-stream` (`libs/collab-stream/src/{client.rs,stream_router.rs,awareness_gossip.rs,collab_update_sink.rs}`) directly; no Kafka/NATS/other broker evidence found anywhere in `AppFlowy-Cloud`.
- **No cross-instance coordination beyond "every instance's `Workspace`/`CollabGroup` actor reads the same Redis stream"** — there is no leader-election or per-object instance-pinning found; any instance can accept a write (subject to having a session joined), and the Redis stream is the sole ordering/fan-out substrate across instances. **Limitation**: this was not run/tested in this audit (no multi-instance deployment was stood up); it is read directly from the source's design, not independently verified under load.
- **No literal embeddable library** — re-confirms Task 60.5 §5 unchanged: both stacks are Actix applications wired into one binary (`AppFlowy-Cloud/src/application.rs`), not a crate designed for in-process embedding into a different language/runtime. Nothing in this task's deeper trace changes that conclusion.

---

## 5. Limitations of this audit

- The exact Redis Lua/command script behind `UpdateStreamMessage::prepare_command` (`collab-stream/src/model.rs`, not read in full this task) was not traced to the byte level — its XADD-vs-transaction semantics are taken as "atomic single Redis command" from the calling code's usage, not independently verified against the Redis command reference.
- `collab/cache/*` (`collab_cache.rs`, `disk_cache.rs`, `mem_cache.rs`) — the Postgres/S3-backed long-term store behind `CollabManager`'s snapshot path — was not read in this task; Task 60.5's `af_collab`/`af_collab_snapshot` schema description is relied upon rather than re-derived.
- The Flutter desktop/mobile client's own collaboration integration (`AppFlowy/frontend/rust-lib/collab-integrate`) was not re-examined this task; this audit is scoped to the AppFlowy-Web/AppFlowy-Cloud pairing, which is this project's actual frontend.
- No multi-instance AppFlowy-Cloud deployment was stood up to observe real cross-instance fan-out; the mechanism described in §1.3/§4 is read directly from source, not load-tested.
- `AppFlowy`/`AppFlowy-Collab` crate internals remain unavailable as local source (Task 60.5's finding, unchanged): nothing in this task required or obtained that repository.
