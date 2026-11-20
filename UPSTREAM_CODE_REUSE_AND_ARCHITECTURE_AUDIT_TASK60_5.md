# Task 60.5 — Upstream Code-Reuse, Architecture, and Over-Engineering Audit

**Status:** Read-only audit. No application code, configuration, dependencies, databases, or running services were modified by this task. Task 61 was not touched.

**Report location note:** This report was written to the repo root (`UPSTREAM_CODE_REUSE_AND_ARCHITECTURE_AUDIT_TASK60_5.md`) instead of `docs/`, because at the time of this audit `docs/AGENT_HANDOVER.md`, `docs/ARCHITECTURE_OVERVIEW.md`, `docs/FEATURE_REGISTRY.md`, and `docs/MASTER_FEATURE_ROADMAP.md` were confirmed to be the four most recently modified files in the entire backend repository (all newer than every task report, including `APPFLOWY_TASK60_REPORT.md`), indicating Task 61 is actively writing to `docs/` right now. To avoid any collision, this report lives at the repo root only.

**Method note:** This audit was produced by directly reading source files, manifests, and LICENSE files across all four repositories, plus three focused read-only research passes (current backend; upstream AppFlowy/AppFlowy-Cloud; AppFlowy-Web frontend) whose outputs were verified against spot-checks of the actual files cited below. Where source could not be inspected (e.g. the `collab`/`collab-database` Rust crates are pulled as pinned git dependencies with no local checkout), this is stated explicitly rather than guessed.

---

## 1. Executive Summary

**Are we reusing enough upstream code?** Partially, and in the way that matters most: the backend already depends on the real `yjs` npm package for all CRDT operations (not a custom CRDT), and its WebSocket wire protocol (`collab-protocol.js`) is a source-derived reconstruction of AppFlowy's actual protobuf schema (`collab.proto`/`messages.proto`), matching AppFlowy-Web's real client query parameters (`cv=0.10.0`, `cp=web`) and message shapes. The backend is not reinventing the CRDT or the wire format from scratch — it is reimplementing the *server* that upstream ships as a large, AGPL-licensed, Postgres/Redis/Actix-coupled Rust application (`AppFlowy-Cloud/services/appflowy-collaborate`), using the same data model concepts (Rid-based ordering, before/after state vectors) but a much smaller, independent, Node.js implementation.

**Are we unnecessarily recreating functionality?** Mostly no, for the P0 collaboration path — the alternative (embedding upstream's Rust collab stack) is not available as a reusable library today (see §5). Yes, in a few bounded, low-risk spots: a legacy/test-only duplicate validation path (`collab-repository.js`) coexists with the production path, and some REST routing is hand-rolled rather than using a lightweight router — neither is a meaningful reuse opportunity, both are minor.

**Is there over-engineering?** No major over-engineering was found in the P0 collaboration/persistence core. The migration advisory-lock mechanism (Task 59) is thoroughly commented but mechanically proportionate to the concurrency bug it fixes. The clearest *simplification* opportunity is not "remove engineering" but "stop building bespoke server-side equivalents of logic the frontend already fully owns" (filtering, sorting, grouping, formula evaluation, rollups) — see §9 and §15.

**Biggest simplification/reuse opportunities, in priority order:**
1. Treat the backend's job for databases as sync/persistence/authorization only — the frontend (AppFlowy-Web) already fully implements filter/sort/group/formula/rollup/field-type logic client-side on the Yjs document. Any backend-side reimplementation of this logic (if ever considered, e.g. for server-side search/export) would be pure duplication of complete, tested frontend code.
2. Reuse upstream's *data model conventions* (collab object types/partition keys, Rid semantics, before/after state-vector discipline, protobuf message shapes) — already being done — rather than upstream's *code*, which is not independently embeddable.
3. Do not attempt to adopt AppFlowy-Cloud's Rust collaboration service — it is an AGPL-licensed Actix application tightly coupled to its own Postgres schema, `gotrue` auth, and workspace/permission tables; adopting it would reintroduce exactly the dependency coupling this project exists to avoid, for no proven integration benefit (no FFI/WASM Node bindings exist anywhere in the ecosystem today).

**Recommended overall approach:** **Strategy A** (continue the Node.js backend, build missing capability ourselves, keep reusing upstream's data models/protocols where already doing so) — see §10 for the full comparison. Strategy B (integrating upstream Rust collab components via FFI/thin service) is not practically available given the absence of any Node-embeddable packaging. Strategy C (adopting large portions of the upstream backend) would violate the project's core independence goal (AGPL copyleft + hard coupling to AppFlowy-Cloud's own auth/workspace schema) for no demonstrated development-speed win.

---

## 2. Current Architecture (with source references)

Repo: `/Volumes/work disk/Codes/Tracker/AppFlowy-Independent-Backend`

- **Runtime:** Node.js ESM, `engines.node >= 20` (`package.json`). No framework — raw `node:http`; `server.js` (1824 lines) is a monolith combining HTTP routing, CORS, auth checks, ~15+ REST handlers, and the full WebSocket collaboration protocol state machine.
- **Dependencies** (`package.json`): `pg ^8.13.1`, `protobufjs ^7.6.6`, `ws ^8.22.0`, `yjs ^14.0.0-16`; dev: `@playwright/test`. No Express/Fastify, no ORM, no schema-validation library. No repo-level LICENSE file exists for this backend (checked directly — `LICENSE*` glob returns nothing).
- **Wire protocol:** `collab-protocol.js` uses `protobufjs`'s programmatic API to construct AppFlowy's real `collab.CollabMessage`/`messages.Message` schema (binary protobuf over WebSocket, not JSON). The file's own header comment states it is "a source-derived subset of AppFlowy-Web's `src/proto/messages.proto` and `collab.proto`." `server.js` requires binary frames (closes 1003 on non-binary) and matches AppFlowy-Web's real client connection query params (`cv=0.10.0`, `cp=web`, `clientId`, `deviceId`, `token`) at `server.js:1332-1347`.
- **Collaboration architecture (persist-before-ACK, RID, generation/fencing — Tasks 42-46):**
  - Persist-before-ACK: `server.js:1500` awaits `store.acceptPageCollabUpdate(...)` before any ack frame is constructed/sent (`server.js:1512-1525`); the Database branch mirrors this exactly (comment at `server.js:1565-1569`). Documented as verified via fault injection in Task 44, not just static inspection.
  - RID allocation: server-assigned, monotonic, per-workspace. JSON mode: `storage.js:205-213`. Postgres mode: `last_message_id_timestamp`/`last_message_id_counter` columns, `postgres-collab-repository.js:144,150`. Client-supplied message IDs are rejected (`server.js:1494-1497`, close code 1008).
  - Generation/fencing: a `generation` counter incremented on every accepted update (`storage.js:216`), used as an optimistic-concurrency guard in Postgres (`postgres-collab-repository.js:198`, `WHERE ... generation=$8`). Version-restore reuses the same fencing mechanism (`postgres-collab-repository.js:336-394`).
  - Known, already-documented limitation (not discovered by this audit, but corroborated): RID allocation and "server state" are per-process/per-DB-local; no cross-instance replay/ordering mechanism exists despite protocol comments implying a once-envisioned Redis-stream design. Flagged in the backend's own `ARCHITECTURE_OVERVIEW.md` and `FEATURE_REGISTRY.md` as High risk / P0-if-horizontal-scaling-becomes-a-goal.
- **Persistence:**
  - JSON mode (`storage.js`, 683 lines): in-memory graph + atomic temp-file-write-then-rename; a single `mutate()` chokepoint is where RID allocation and persist-before-ack both happen.
  - Postgres mode (`postgres-storage.js`, 340 lines; `postgres-collab-repository.js`, 416 lines): same method names as JSON mode, so `server.js` never branches on storage mode. Explicit `BEGIN`/`COMMIT`/`ROLLBACK` with `finally`-guaranteed pool release.
  - Migration advisory lock (`postgres-migration-lock.js`, 102 lines, Task 59): SHA-256-derived deterministic lock key folded into a signed 64-bit BigInt; bounded `pg_try_advisory_lock` retry loop (not blocking); session-level (not transaction-level) lock, deliberately chosen because the migration critical section spans multiple independently-committed migration files.
  - Version history/restore (Tasks 49A/49B/57): JSON mode uses `pageCollabVersions`/`pageCollabRestoreEvents`; Postgres mode uses `collab_versions`/`restore_events` tables (migration `005_document_version_history.sql`). Restore uses `SELECT ... FOR UPDATE` plus the same generation-based optimistic-concurrency guard — no new mechanism invented for restore.
- **Document collaboration objects:** `page-document.js`, `database-document.js`, `workspace-database.js` all build initial state using the real `Y.Doc` API — genuine Yjs documents, not a custom format.
- **Auth** (`auth.js`, 19 lines): `scrypt` password hashing with random salt, `timingSafeEqual` comparisons, opaque bearer session tokens (`randomBytes(32)`), SHA-256 token-hash storage. No JWT/OAuth/external IdP — minimal and self-contained, not over-engineered.
- **Testing:** `test/backend.test.js` (JSON-mode HTTP/WS regression), `test/offline-collab.test.js` (legacy prototype), `test/database-collab.test.js`, `test/collab-conformance.js` (8 protocol-semantics vectors; per the backend's own `TESTING_AND_ACCEPTANCE_STRATEGY.md`, 6 resolved / 2 explicitly pending — compaction-retention and cross-instance-replay), 4 Postgres suites gated behind `RUN_POSTGRES_TESTS=1`, and Playwright specs under `test/specs/` and `test/tests/`.
- **Not yet implemented server-side** (confirmed by direct grep — zero hits — and consistent with the backend's own `FEATURE_REGISTRY.md`): comments, notifications, full-text/semantic search, AI chat, per-document ACLs (authorization today is workspace-membership-existence only), rate limiting.

---

## 3. Upstream Architecture (relevant components + dependencies)

Repos: `/Volumes/work disk/Codes/Tracker/AppFlowy` (client), `/Volumes/work disk/Codes/Tracker/AppFlowy-Cloud` (archived server reference), `/Volumes/work disk/Codes/Tracker/AppFlowy-SelfHost-Commercial` (comparison only).

- **Collab crates are not vendored as source anywhere in these repos.** `AppFlowy-Cloud/Cargo.toml` pulls `collab`, `collab-document`, `collab-entity`, `collab-folder`, `collab-user`, `collab-database`, `collab-importer`, `collab-plugins` as a pinned git dependency: `git = "https://github.com/AppFlowy-IO/AppFlowy-Collab", rev = "e59260e524f33104b0ddcd6bb8f6218cad0f7e18"` (confirmed in `Cargo.toml` and `Cargo.lock`). No local checkout exists on disk in this environment, so the crates' internal API shape and the exact `collab-database` field/row model could not be directly inspected — flagged as **investigate further**, not asserted.
- **CRDT foundation:** `yrs` v0.23.5 (Rust port of Yjs, from `Cargo.lock`). `AppFlowy-Cloud/libs/collab-rt-protocol/src/protocol.rs` uses standard Yjs sync-protocol primitives (`StateVector`, `Update::decode_v1`, `encode_diff_v1`, sync-step1/2) — the same binary update encoding used by JS `yjs`, so wire-level interop between a `yrs` backend and the independent backend's `yjs`-based implementation is architecturally plausible, though exact byte-for-byte parity across versions was not independently verified.
- **Realtime transport (vendored as real source, path deps not git deps):** `AppFlowy-Cloud/libs/collab-rt-protocol/src/{message.rs, protocol.rs, data_validation.rs}`, `AppFlowy-Cloud/libs/collab-rt-entity/src/{message.rs, client_message.rs, server_message.rs, user.rs}`, proto files `libs/collab-rt-entity/proto/{collab.proto, realtime.proto}`. Message types: `ClientInitSync`, `ClientUpdateSync`, `ServerInitSync`, `ClientAwarenessSync`, `ClientCollabStateCheck`, with explicit "⚠️ compatibility warning — don't change fields" comments on `InitSync`/`UpdateSync`. The actual server logic (`services/appflowy-collaborate/src/{group/*, actix_ws/*, ws2/*, collab/collab_manager.rs, collab/collab_store.rs, snapshot/snapshot_control.rs}`) is an **Actix-web application**, not a library designed for embedding.
- **No clean persistence trait/abstraction found** (`CollabStorage`/`Snapshot`/`Persist`) in `libs/` or `services/` — persistence is handled ad hoc against Postgres directly inside `collab_store.rs`/`cache/*`.
- **Storage schema:** `af_collab` table (migration `20230906102652_collab.sql`), partitioned by `partition_key` (0=document, 1=database, 2=workspace-database, 3=folder, 4=database_row, 5=user_awareness), storing the **full latest Yrs document blob**, not an incremental update log; `af_collab_snapshot` for periodic snapshots. Both tables carry hard foreign keys to `af_workspace`/`af_user`/`af_permissions` — this persistence layer is not separable from AppFlowy-Cloud's own workspace/user/permission/`gotrue`-auth schema without reimplementing or adopting that surrounding schema. 64 migration files touch `af_collab*` tables over time.
- **Client-side Rust integration surface:** `AppFlowy/frontend/rust-lib/collab-integrate` sits alongside `flowy-database2`/`flowy-folder`/`flowy-document` — the Flutter client has its own separate dart-ffi integration point into the collab crates, entirely distinct from the AppFlowy-Cloud server's integration. Neither is a Node.js integration point.
- **No FFI/napi/neon/wasm-bindgen Node-native-addon bindings exist anywhere in these repos.** `js-sys` appears in `collab`'s dependency tree (suggesting some `wasm32` compile target, likely for Flutter-web), but this is not evidence of a packaged, usable Node.js addon. **The only proven upstream integration model is running a separate Rust process** (i.e., `services/appflowy-collaborate` itself).
- **AppFlowy-SelfHost-Commercial** (comparison only, never a target): no OSS license; `SELF_HOST_LICENSE_AGREEMENT.md` is a proprietary "APPFLOWY PTE. LTD. SOFTWARE LICENSE AGREEMENT" — per-server key, non-transferable, reverse-engineering prohibited, annual billing, Singapore governing law; README confirms seat-based tiers and license-gated SCIM/Search/Admin features.

---

## 4. Reuse Opportunity Matrix

| Capability | Upstream source | Existing implementation | Reuse classification | Complexity to adopt alternative |
|---|---|---|---|---|
| CRDT data model / update encoding | `yrs` crate (Rust) via `collab` (git dep, not vendored) | `yjs` npm package (`package.json`), used throughout `server.js`/`storage.js`/`*-document.js` | **Direct reuse already in place** (same Yjs CRDT family, JS side) | N/A — already done |
| Collab wire protocol (protobuf schema) | `AppFlowy-Cloud/libs/collab-rt-entity/proto/{collab.proto,realtime.proto}`, `AppFlowy-Web/src/proto/messages.proto` | `collab-protocol.js` — source-derived reconstruction via `protobufjs` | **Partial reuse** (data model/shape reused; not a literal file reuse) | Low to re-derive further message types if needed; AGPL provenance of the `.proto` files is an **unresolved licensing question**, see §13 |
| Realtime WS server (session mgmt, broadcast, ack) | `AppFlowy-Cloud/services/appflowy-collaborate` (Actix, AGPL) | `server.js` WS handler (custom, Node/`ws`) | **Reference only** — not embeddable; application, not a library | Very High to adopt (separate Rust process, AGPL, coupled to `af_workspace`/`gotrue`) |
| Collab persistence schema (blob+snapshot) | `af_collab`/`af_collab_snapshot` tables, AppFlowy-Cloud migrations | `postgres-storage.js`/`postgres-collab-repository.js` (update-oriented, own schema) | **Reference only** for schema concepts (partition-key-style typing already mirrored conceptually by `collabType`); not directly portable due to FK coupling to `af_workspace`/`af_user` | Medium if only borrowing concepts; Very High if trying to literally adopt |
| Migration locking / concurrency safety | No upstream equivalent found | `postgres-migration-lock.js` (Task 59, advisory lock) | **Unavoidable custom implementation** | N/A |
| Database/DatabaseRow object model | `collab-database` crate (git dep, source not inspectable) | Not yet built (Task 61 in progress) | **Investigate further** — crate source unavailable in this environment; data model partially inferable from AppFlowy-Cloud's partition-key table design (database vs. workspace-database vs. database_row are separate collab object types) | Unknown until crate source is fetched/reviewed |
| Database view/filter/sort/group logic | N/A (frontend-owned, not server-owned upstream either) | Not built server-side; fully implemented client-side in AppFlowy-Web (`src/application/database-yjs/*`) | **Keep existing (client-owned)** — do not build server-side | N/A — do not build |
| Formula/rollup evaluation | N/A | Fully implemented client-side (`src/application/database-yjs/fields/formula/*`, `rollup/*`) with its own lexer/parser/compiler/evaluator and large test suite | **Keep existing (client-owned)** | N/A — do not build |
| Version history/restore | AppFlowy-Cloud snapshot mechanism (different design — full-blob snapshots, not generation-fenced deltas) | `postgres-collab-repository.js` restore path (Tasks 49A/49B/57), generation-fenced, `FOR UPDATE` serialized | **Keep existing** — already working, different but reasonable design | N/A |
| Auth / session model | AppFlowy-Cloud uses `gotrue` (Supabase auth service, external) | `auth.js` — scrypt + opaque tokens, self-contained | **Reasonable independence — keep existing** | High to adopt gotrue (external service dependency, against independence goal) |
| Full-text/semantic search | Dedicated `appflowy_search` microservice (pgvector + Redis + OpenAI/Azure embeddings) | Not started server-side; frontend fully built expecting `/api/search/*` | **Reference only** — adopting as-is reintroduces the external/commercial dependency this project exists to avoid | High if built to match upstream fidelity with external embeddings; Medium if built with a self-hosted/optional-key boundary |
| AI chat | Dedicated `appflowy_ai` microservice (`OPENAI_API_KEY`/Azure) | Not started; frontend fully built | **Reference only** — same external-dependency concern | High if faithful; Medium with explicit optional-key boundary |
| Comments / notifications | Not clearly a separable upstream module (not deeply investigated — P2) | Not started server-side; frontend fully built | **Keep existing frontend, build backend ourselves** | Medium — straightforward CRUD/pubsub, no CRDT complexity |

---

## 5. Collaboration Engine Assessment

**Does upstream expose reusable collaboration crates/modules?** Yes by name — `collab`, `collab-document`, `collab-database`, `collab-folder`, `collab-entity`, `collab-plugins`, `collab-user`, `collab-importer`, pinned at `AppFlowy-IO/AppFlowy-Collab@e59260e` — but they are **not vendored as source** in any of the four repos examined, and no local checkout was available to inspect their actual API surface. This is an acknowledged gap in this audit: a definitive statement about their internal structure requires fetching that repository, which was out of scope for a read-only audit of the four designated repos.

**Can they integrate directly into the current Node.js backend?** Not as a native library, based on all available evidence: no FFI/napi/neon/wasm-bindgen Node-addon bindings exist anywhere in the inspected repos' build configuration. The presence of `js-sys` in `collab`'s dependency tree suggests *some* `wasm32` compilation target exists (plausibly for Flutter-web), but a `wasm32` target is not the same as a packaged, consumable Node.js module, and no evidence of such packaging was found.

**Would a Rust library/service be required?** Yes — the only proven integration model anywhere in this ecosystem is running collab logic inside a separate Rust process. That is exactly what `AppFlowy-Cloud/services/appflowy-collaborate` already is: an Actix-web application, not a reusable library. Standing up this service would mean operating a second runtime (Rust/Actix) alongside the Node.js backend, with its own build toolchain, deployment, and Postgres schema expectations — a materially different and heavier operational model than today's single-process Node.js deployment.

**Can the collaboration engine be reused without adopting the whole upstream backend?** Not cleanly. No narrow `CollabStorage`/`Snapshot`/persistence trait was found that could be lifted out independently of the rest of `services/appflowy-collaborate`; persistence is handled ad hoc against Postgres directly inside the service, and the realtime messages carry `workspace_id` with hard FK dependencies on `af_workspace`/`af_user`/`gotrue` auth.

**Would integration preserve persist-before-ACK?** Unknown/unverified — upstream's actual ack-sequencing guarantees were not independently proven in this audit (would require running/testing the Rust service), but structurally the realtime service's architecture (full-document-blob persistence rather than delta-log) is different enough from the independent backend's generation-fenced delta model that a straight swap-in is not architecturally guaranteed to preserve the same guarantee without adaptation work.

**What happens to the existing Document collaboration implementation if any of this were adopted?** It would need to be replaced or run in parallel during a migration, since the independent backend's persist-before-ack/RID/generation-fencing model (Tasks 42-46) has no upstream equivalent to map onto directly — upstream's model is coarser (whole-blob snapshot + Redis-backed message stream per the protobuf comments found in the frontend's `messages.proto`, which labels `Rid` explicitly as "Redis stream message Id").

**Can upstream components coexist with independent auth/storage?** Only with meaningful adapter work, because upstream's realtime/persistence code assumes its own `af_workspace`/`af_user` schema and `gotrue`-shaped auth is wired through the stack, not because of hardcoded cloud URLs or billing/seat checks (none were found in the AGPL-licensed collab-rt/storage code itself — billing/seat logic lives only in the separate proprietary commercial repo).

**Verdict for this focus area:** Keep the current Node.js/`yjs`-based implementation. Do not pursue direct Rust-crate integration without first fetching and inspecting the actual `AppFlowy-Collab` repository — only then could a concrete decision be made, and even then the integration model would necessarily be "separate service," not "in-process library," given everything else observed.

---

## 6. Database Implementation Assessment

- `collab-database`'s internal field/row/view model could not be directly inspected (git dependency, no local checkout). Indirect evidence from AppFlowy-Cloud's `af_collab` partition-key scheme (database=1, workspace-database=2, database_row=4 as distinct values) confirms the *conceptual* shape — database definition, workspace-database index, and individual rows are separate, independently-syncable collab objects — which is useful confirmation for Task 61's in-progress design, but not a literal reusable implementation.
- The frontend (AppFlowy-Web) already contains the entire business-logic layer that would otherwise need building: filtering (`filter.ts`), sorting/grouping (`sort.ts`, `group*.ts`, `board-grouping.ts`), calculations (`calculation.ts`), per-field-type parsing/formatting (`fields/*` — select-option, person, date, checkbox, number, url, rollup, checklist, media, relation, rich-text), a full formula engine with its own lexer/parser/AST/compiler/evaluator/type-checker/dependency-graph (`fields/formula/*`), and a rollup/cross-row aggregation system (`rollup/*`). All of this operates directly on the Yjs CRDT structures client-side and has a substantial existing test suite (`researched-business-scenarios.test.ts`, `notion-use-cases.test.ts`, etc.).
- **Implication for the backend's database work (including Task 61, without touching it):** the backend's job for databases is to correctly persist and fan out Yjs updates for Database/DatabaseRow/View objects (and expose REST metadata/CRUD scaffolding), not to recompute filter/sort/formula/rollup results server-side. The frontend already satisfies those contracts. This is recorded here as a **potential Task 61 optimization — review after Task 61** (see §15) rather than a directive, since Task 61 is actively in progress and must not be interrupted.
- Upstream's own resolution strategy for concurrent same-cell database edits (as already documented in this backend's own `docs/DATABASE_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`, read but not modified) is reported there as plain last-write-wins over a flat `HashMap<String, Any>`, not a per-cell CRDT — i.e., upstream itself does not over-engineer per-cell merge semantics, which is useful precedent if Task 61's design is evaluated against "is our complexity justified" after the fact.

---

## 7. Storage/Persistence Assessment

- Upstream's persistence model (whole-document-blob `af_collab` table + periodic `af_collab_snapshot`) is structurally different from the independent backend's generation-fenced, update-oriented model (`collab_updates`/`collab_versions`/`restore_events`). Neither is strictly "more correct" — they solve for different operational assumptions (upstream assumes a Redis-backed message stream feeding periodic snapshot compaction at scale; the independent backend assumes a simpler, single/few-instance deployment with durable-write-before-ack as the primary correctness property).
- Upstream's persistence tables carry hard foreign keys into `af_workspace`/`af_user`/`af_permissions` — adopting this schema would require adopting (or faithfully reimplementing) AppFlowy-Cloud's workspace/user/permission model wholesale, which the independent backend deliberately does not depend on.
- The independent backend's current persistence (JSON file mode + Postgres mode behind an identical method-name interface) is not unnecessarily complex for its stated goals — Task 59's advisory-lock fix addressed a real concurrent-migration defect, and the session-level-lock design is proportionate to the problem (multiple independently-committed migration files in the critical section), not overbuilt.
- One genuinely open concern already flagged in the backend's own docs (not newly discovered here): unbounded growth of `collab_updates`/`collab_versions`/`restore_events` with no retention/TTL/cap — this is a forward-looking operational risk, not evidence of current over-engineering, and does not require upstream code to fix (a simple retention policy would suffice).
- **Verdict:** keep the current JSON/Postgres persistence abstraction. No upstream persistence component is adoptable without also adopting AppFlowy-Cloud's surrounding schema and auth model, which would compromise independence for no demonstrated benefit.

---

## 8. Frontend Compatibility Assessment

Repo: `/Volumes/work disk/Codes/Tracker/AppFlowy-Web`

- **Collaboration deps already present:** `yjs 14.0.0-1`, `y-protocols ^1.0.6`, `y-indexeddb 9.0.12`, `@slate-yjs/core`, `lib0`, plus `protobufjs`/`google-protobuf` for the wire protocol, and `dexie`/`dexie-react-hooks` for local IndexedDB persistence.
- **WebSocket client contract** (`src/components/ws/useAppflowyWebSocket.ts`): connects to `ws://.../ws/v2/{workspaceId}/?clientId=...&deviceId=...&token=...&cv=0.10.0&cp=web`, binary `arraybuffer` frames, protobuf-encoded via generated `messages.Message` — this matches exactly what the independent backend's `server.js`/`collab-protocol.js` already implement (confirmed cross-referencing both forks' findings: same query params, same binary-protobuf requirement).
- **`src/proto/messages.proto`** defines `Rid` (explicitly commented as "Redis stream message Id"), `SyncRequest`, `Update` (with `beforeStateVector`/`afterStateVector`), `AwarenessUpdate`, `AccessChanged`, `CollabMessage` — a custom protobuf-over-WebSocket protocol modeled on AppFlowy Cloud's Redis-stream design, not the standard `y-websocket` sync protocol. The independent backend's `collab-protocol.js` schema matches this shape field-for-field.
- **Client-side sync logic** (`src/application/services/js-services/sync-protocol.ts`): implements the handshake (`Y.encodeStateVector`/`Y.encodeStateAsUpdate`), applies updates via `Y.applyUpdate`/`applyUpdateV2`, detects missing dependencies via `doc.store.pendingStructs`/`pendingDs` to re-request sync, and destroys the local doc on `AccessChanged` read-revocation. A local "sync outbox" persists every local update to IndexedDB before sending, giving offline durability independent of the server. The client enforces a before/after-state-vector discipline that the backend must honor — this is already consistent with the independent backend's persist-before-ack design.
- **Database business logic is entirely client-owned** (§6 above) — confirmed again here from the frontend side: filter/sort/group/formula/rollup/field-type logic all live in `src/application/database-yjs/*` with a substantial test suite. The backend should not duplicate any of this.
- **Auth coupling risk:** the frontend's auth flow (`gotrue.ts`, `auth-api.ts`) expects a **GoTrue-compatible** response shape (`{access_token, refresh_token, user}` and GoTrue-specific error codes) — distinct from the main `/api` error envelope. The backend's own `FEATURE_REGISTRY.md` (read, not modified) already flags this as "currently harmless... but a latent compatibility risk" since it only works by coincidence of response shape today. This is a real, bounded compatibility risk worth tracking, not something requiring upstream code adoption — a thin compatibility shim in the existing `auth.js` response shape would suffice if it ever breaks.
- **License:** AppFlowy-Web's own `LICENSE` file is AGPLv3 (verified directly). The frontend is being used as the *primary client*, which is normal and permitted use of an AGPL frontend; it does not by itself impose obligations on the independent backend's own code (AGPL's network-use clause concerns distribution/modification of the AGPL-covered program itself, not every program that merely talks to it over a network protocol — see §13 for the nuance that does need flagging).
- **README confirms** the frontend's documented pairing is with AppFlowy Cloud specifically ("Once AppFlowy Cloud has been setup...") — i.e., the frontend's contract was authored against AppFlowy Cloud's actual API, and the independent backend is deliberately satisfying that same contract independently. No functionality already built in the frontend is being unnecessarily rebuilt server-side, based on everything inspected.

---

## 9. Over-Engineering Findings

| Finding | File/Module | Current implementation | Upstream alternative | Classification | Simplify? | Risk of changing |
|---|---|---|---|---|---|---|
| Monolithic `server.js` (1824 lines, routing+auth+WS all inline) | `server.js` | Manual `pathname.split('/')` dispatch, no router library | N/A (upstream uses Actix routing, not portable) | **Reasonable independence** (minimal-dependency choice, not accidental) | Only if route count keeps growing — low urgency | Low if done incrementally; do not touch during Task 61 |
| Duplicate Yjs-update validation logic | `collab-repository.js` (legacy/offline prototype) vs. `postgres-collab-repository.js`/`storage.js` (production) | Two independent implementations of update validation | N/A | **Premature optimization / legacy residue**, not active over-engineering — the legacy path is explicitly kept for its own test suite | Low-value to merge; its own tests depend on it | Low risk to leave; low value to touch |
| Heavily-commented migration advisory lock | `postgres-migration-lock.js` (Task 59) | ~50% comments justifying hash-key derivation, try-lock vs blocking, session vs transaction scope | No upstream equivalent found | **Necessary adaptation** — the mechanism itself (session-level `pg_try_advisory_lock`, bounded retry, SHA-256 key) is proportionate to the real concurrency defect it fixes, not overbuilt | No — thoroughness here is justified by the bug it fixes | N/A |
| No schema-validation library; ad hoc per-route validation | `server.js` various routes | Hand-rolled checks (e.g. "no schema-validation library; page title length unbounded" per the backend's own `FEATURE_REGISTRY.md`) | N/A | **Reasonable independence for current scale**, but a genuine latent gap, not over-engineering | Worth adding a small validation layer eventually | Low |
| Hand-transcribed protobuf schema via `protobufjs` programmatic API | `collab-protocol.js` | Protobuf descriptor built in JS object literals rather than a `.proto` file + codegen | Upstream ships literal `.proto` files + generated bindings | **Reasonable independence / necessary adaptation** — avoids a build step, but is a maintenance burden if the schema grows; not "over-engineering," arguably slightly under-tooled | Could switch to `.proto` + codegen for maintainability, low priority | Low |

**No evidence was found of:** unnecessary service boundaries/microservices (the backend is a deliberate monolith), excessive abstraction layers, custom protocols invented where a standard one would do (the protocol used is the real upstream protocol, reused), data structures gratuitously diverging from upstream without justification, or features built meaningfully ahead of their dependencies within the P0 collaboration/persistence core. The backend's own `TESTING_AND_ACCEPTANCE_STRATEGY.md` explicitly documents a discipline against claiming completeness prematurely (e.g., stub endpoints are explicitly labeled non-functional rather than silently counted as done), which is the opposite of the over-engineering/premature-completion pattern this step was checking for.

---

## 10. Three-Strategy Comparison

**Strategy A — Continue current Node.js backend, build missing capability ourselves, reuse upstream data models/protocols where practical (status quo direction).**
- Development speed: Medium-High (team already has working momentum across 60 tasks).
- New code required: Medium (comments/notifications/search/AI still to build; database Phase 1+ in progress via Task 61).
- Reuse potential: Already realized for CRDT (`yjs`) and wire protocol (protobuf shape); Low further reuse available for the realtime server itself (not embeddable).
- Complexity: Low-Medium (single Node process, two storage backends behind one interface).
- Performance: Unknown at scale (single-instance assumption not yet stress-tested beyond documented gaps); adequate for current single/few-instance deployment target.
- Reliability: Medium-High — persist-before-ack, generation fencing, and migration-lock safety are proven via fault-injection-style tests, not just unit tests.
- Maintenance: Medium — one language/runtime, one team context.
- Independence: High — no AppFlowy Cloud or commercial dependency anywhere in the collaboration/storage/auth path.
- Compatibility: High — wire protocol and query params already match AppFlowy-Web's real client.
- Migration cost: None (status quo).
- Testing difficulty: Medium — existing suites cover JSON+Postgres+conformance; cross-instance scenarios remain untested/unimplemented by design.
- Licensing: Clean — no AGPL code incorporated; wire-format reconstruction is the only nuance to resolve (§13).

**Strategy B — Keep current backend infra, integrate AppFlowy's collaboration components via direct integration or thin adapters, retain independent auth/storage/deployment.**
- Development speed: Low — no proven Node-embeddable packaging of `collab`/`yrs` exists; would require either (a) building new FFI/WASM bindings upstream doesn't currently ship, or (b) standing up a separate Rust service and building a cross-process adapter protocol, both of which are new engineering work, not reuse.
- New code required: High (adapter/service boundary, deployment of a second runtime).
- Reuse potential: Theoretically high if bindings existed; **practically unproven** — this audit found no FFI/napi/neon/wasm Node bindings anywhere in the inspected repos.
- Complexity: High — two runtimes, a new IPC/protocol boundary, two deployment artifacts.
- Performance: Unknown — could be better (native CRDT ops) or worse (cross-process overhead) without benchmarking.
- Reliability: Unknown — would need to independently re-prove persist-before-ack across the new boundary; today's fault-injection test coverage does not transfer automatically.
- Maintenance: High — two codebases/toolchains (Node + Rust), plus the adapter layer itself.
- Independence: Medium — the Rust collab-rt code itself is AGPL and its sibling persistence code is coupled to AppFlowy-Cloud's own schema/auth; isolating just the "pure CRDT" parts (if that's even separable, unconfirmed) would require careful AGPL compliance review.
- Compatibility: Potentially high (same CRDT family) but unproven in this concrete integration shape.
- Migration cost: High — not a drop-in; would be a multi-step research-then-build effort with no existing map in this ecosystem.
- Testing difficulty: High — new failure modes at the process boundary.
- Licensing: Needs careful review — AGPL provenance of any adopted Rust source.
- **Verdict: not currently practical.** This audit explicitly checked for FFI/WASM/native-binding evidence and found none; recommending B would require first unresolved upstream research (fetching and inspecting `AppFlowy-Collab`) that is out of this audit's scope and may still conclude integration isn't viable.

**Strategy C — Adopt larger portions of the upstream backend (AppFlowy-Cloud), retain only genuinely-needed independent infra.**
- Development speed: Low initially (migration/adaptation cost) though potentially faster for already-built upstream features (search, AI gateways, admin tooling) if their external dependencies (OpenAI/Azure, Redis) were accepted.
- New code required: High (adapting around AppFlowy-Cloud's `gotrue` auth and `af_workspace`/`af_user`/`af_permissions` schema to preserve independence, or abandoning independence and accepting those dependencies).
- Reuse potential: High for raw feature surface (comments, notifications, search, AI already fully built upstream) but at the direct cost of the project's core independence requirement.
- Complexity: High (Rust toolchain, Postgres schema migration from the current schema, Actix runtime, possibly Redis).
- Performance: Likely good at scale (this is upstream's own production-proven path) but irrelevant if the independence requirement rules it out.
- Reliability: Likely high (mature, widely deployed) but this project's own fault-injection-proven guarantees (persist-before-ack, generation fencing) would need to be re-verified against a different persistence model (whole-blob snapshot vs. delta log).
- Maintenance: High initial migration cost, potentially lower long-term maintenance if the team is willing to track upstream Rust releases.
- Independence: **Low** — AGPL copyleft code, and features like search/AI are upstream-built as calls to external services (OpenAI/Azure, dedicated microservices), which directly conflicts with the stated no-mandatory-cloud/no-AI-gateway-dependency goal.
- Compatibility: High with the real AppFlowy ecosystem (by definition).
- Migration cost: Very High — full schema and service-model change.
- Testing difficulty: High — new runtime, new failure modes, loss of existing proven test coverage until re-established.
- Licensing: AGPLv3 — copyleft obligations would need careful review before any adoption (§13).
- **Verdict: not recommended.** It would reintroduce the exact dependency/independence problem the project exists to avoid, for features (search, AI) that the backend's own `FEATURE_REGISTRY.md` already separately flags as needing an independent/self-hosted-key design regardless of where the code comes from.

**Recommendation: Strategy A**, continuing to mine upstream's *data models and protocols* (as already successfully done for the CRDT and wire format) rather than its *code or running services*, which are not available in an embeddable, independence-preserving form today.

---

## 11. Recommended Target Architecture

No full rewrite is justified by the evidence gathered. The existing architecture should be preserved with targeted additions:

```
                        ┌─────────────────────────────┐
                        │   AppFlowy-Web (frontend)    │
                        │  - Yjs/Slate editor binding  │
                        │  - database-yjs business     │
                        │    logic (filter/sort/group/ │
                        │    formula/rollup) [KEEP]     │
                        │  - sync-outbox (offline)      │
                        │  - protobuf WS client         │
                        └───────────────┬──────────────┘
                                        │ wss:// binary protobuf
                                        │ (Rid, before/after SV)
                        ┌───────────────▼──────────────┐
                        │  Independent Backend (Node)   │
                        │  server.js  [KEEP — monolith   │
                        │   is fine at current scale]   │
                        │  ┌──────────────────────────┐ │
                        │  │ collab-protocol.js        │ │  <- already upstream-
                        │  │ (protobuf, source-derived) │ │     protocol-compatible
                        │  └──────────────────────────┘ │
                        │  ┌──────────────────────────┐ │
                        │  │ WS handler: persist-before-│ │  <- Tasks 42-46,
                        │  │ ack, RID, generation fence │ │     proven, KEEP
                        │  └──────────────────────────┘ │
                        │  ┌──────────────────────────┐ │
                        │  │ auth.js (scrypt + opaque   │ │  <- KEEP, self-contained
                        │  │ tokens)                     │ │
                        │  └──────────────────────────┘ │
                        │  ┌──────────────────────────┐ │
                        │  │ storage.js (JSON) /         │ │  <- KEEP both, same
                        │  │ postgres-storage.js +       │ │     interface already
                        │  │ postgres-collab-repository  │ │
                        │  │ + postgres-migration-lock   │ │  <- Task 59, KEEP
                        │  └──────────────────────────┘ │
                        │  ── to build, no upstream code ──
                        │  comments | notifications |    │
                        │  search (self-hosted/optional   │
                        │  embedding key) | AI (optional  │
                        │  user-supplied key) | ACLs |    │
                        │  rate limiting                  │
                        └───────────────┬──────────────┘
                                        │
                        ┌───────────────▼──────────────┐
                        │   PostgreSQL (self-hosted)    │
                        └───────────────────────────────┘

   Upstream AppFlowy-Collab crates / AppFlowy-Cloud service: REFERENCE ONLY
   (data-model/protocol concepts already mined; not embedded, not adopted
    as a running dependency — no proven Node integration path exists today)
```

- **Preserve:** AppFlowy-Web as primary frontend (already does its job well); existing Document collaboration implementation (Tasks 42-46); existing version history/restore (49A/49B/57); JSON+Postgres dual storage behind one interface; `auth.js`; migration advisory-lock safety (Task 59).
- **Reuse (already happening, continue):** `yjs` CRDT semantics; upstream's protobuf message shapes/field names as the wire contract; upstream's conceptual collab-object typing (document/database/workspace-database/folder/database_row/awareness) as a naming convention for `collabType`.
- **Build ourselves, no upstream shortcut available:** comments, notifications, per-document ACLs, rate limiting (all plain CRUD/authorization work, not CRDT-hard); search and AI chat, each with an explicit self-hosted/optional-key design to avoid recreating upstream's mandatory external-service dependency.
- **Simplify when convenient, not urgently:** `server.js`'s routing could move to a lightweight router if route count keeps growing; the legacy `collab-repository.js` duplicate-validation path could eventually be retired once its own tests are folded elsewhere.
- **Do not pursue:** FFI/WASM integration of upstream Rust collab crates (no proven path exists); adoption of AppFlowy-Cloud's Rust service or Postgres schema (AGPL + hard coupling to its own auth/workspace model).

---

## 12. Engineering Effort/Risk Assessment

- Continuing Strategy A for remaining gaps (comments, notifications, search, AI, ACLs, rate limiting): each is independently buildable with conventional CRUD/authorization engineering; no CRDT-level complexity is involved for comments/notifications. Search and AI carry an external-dependency design risk (not an effort/risk from upstream code reuse, but from the nature of the features themselves) that the backend's own `FEATURE_REGISTRY.md` already flags — this audit concurs with that existing assessment rather than introducing a new one.
- Attempting Strategy B carries High research risk before any build risk: the first real engineering step would be fetching `AppFlowy-Collab@e59260e` and determining whether any embeddable packaging exists at all — something this audit could not do within its read-only, four-repo scope. Until that research happens, B's effort cannot be estimated responsibly, only bounded as "at least as expensive as building a new Rust service plus a cross-process protocol," which is unattractive relative to A's incremental cost for the same capability.
- Attempting Strategy C carries Very High migration risk (schema, auth, runtime all change) for capability (search/AI/admin) that would need an independence-preserving redesign regardless of its code origin — i.e., even C's benefit is partly illusory for this project's specific constraints.
- No numeric time estimates are given anywhere in this report, per the audit's constraints — only qualitative Low/Medium/High/Very High levels, as instructed.

---

## 13. Licensing/Dependency Assessment

| Component | Source | License (verbatim) | Dependencies | Cloud/commercial coupling | Can run independently self-hosted? |
|---|---|---|---|---|---|
| `AppFlowy` (client) | `/Volumes/work disk/Codes/Tracker/AppFlowy/LICENSE` | GNU Affero General Public License, Version 3 (confirmed by direct read of file header) | — | — | Yes, by design (self-host-oriented client) |
| `AppFlowy-Cloud` | `/Volumes/work disk/Codes/Tracker/AppFlowy-Cloud/LICENSE` | GNU AGPLv3 (identical header, confirmed) | `collab`/`collab-*` crates (git dep), `yrs`, Actix, Postgres, Redis (implied by Rid/stream design), `gotrue` | Server persistence FK-bound to its own `af_workspace`/`af_user`/`af_permissions`/`gotrue` — not a remote-SaaS hardcoded dependency, but a schema/auth-model coupling | Only as a whole stack (its own Postgres schema + gotrue + Actix service); not as isolated pieces without further engineering |
| `AppFlowy-Web` (frontend, currently used as the project's primary frontend) | `/Volumes/work disk/Codes/Tracker/AppFlowy-Web/LICENSE` | GNU AGPLv3 (confirmed by direct read: standard FSF AGPL header) | `yjs`, `y-protocols`, `y-indexeddb`, `protobufjs`, `google-protobuf`, `dexie` | README documents AppFlowy Cloud as its reference backend, but the frontend itself imposes no runtime cloud dependency when paired with an independent backend implementing the same contract | Yes — this is exactly the project's current approach (AGPL frontend talking to an independent, non-AGPL backend over its own protocol implementation) |
| `AppFlowy-SelfHost-Commercial` | No OSS license; `SELF_HOST_LICENSE_AGREEMENT.md` | Proprietary "APPFLOWY PTE. LTD. SOFTWARE LICENSE AGREEMENT" — per-server key, reverse-engineering prohibited, annual billing, Singapore law | — | Seat-based, license-gated features (SCIM/Search/Admin per README) | Not applicable — reference/comparison only, never a dependency source, per task scope |
| `AppFlowy-Independent-Backend` (this project) | No LICENSE file present (checked directly — none exists) | **Unstated** | `pg`, `protobufjs`, `ws`, `yjs` (all independently MIT-or-similar in the npm ecosystem by common knowledge, but each package's actual license text was not individually re-verified in this audit — flag for confirmation) | None found — no AppFlowy-sourced npm packages, no hardcoded AppFlowy Cloud URLs, no gotrue dependency | Yes, as designed |

**Unresolved/flagged licensing questions, not concluded here (legal review recommended, not guessed):**
1. **The backend's own license is unstated.** No LICENSE file exists in `AppFlowy-Independent-Backend`. This is worth resolving independent of upstream-reuse questions, since the project pairs with an AGPL frontend (AppFlowy-Web) and distributes/reconstructs data drawn from AGPL-licensed `.proto` schemas (see point 2) — the project's own licensing position should be made explicit.
2. **`collab-protocol.js`'s protobuf schema is described by its own header comment as "a source-derived subset of AppFlowy-Web's `src/proto/messages.proto` and `collab.proto`."** Both of those `.proto` files live inside AGPLv3-licensed repositories (AppFlowy-Web and, by extension, AppFlowy-Cloud/collab-rt-entity, which ships the canonical `collab.proto`). The independent backend's version is a hand-written `protobufjs` object-literal reconstruction, not a copy of the literal `.proto` file text — whether reconstructing field names/numbers/message shapes from an AGPL-licensed interface-definition file carries AGPL obligations (protocols/wire-formats are often treated differently from code under copyright law in various jurisdictions, but this varies and is genuinely unsettled as a general matter) is a real open question this audit cannot responsibly resolve. **Recommend: explicit legal/licensing review of this specific file's provenance before any wider distribution of this backend.**
3. Individual npm dependency licenses (`pg`, `protobufjs`, `ws`, `yjs`) were not independently re-verified against each package's actual `LICENSE` file in `node_modules` in this audit — commonly known to be permissive (MIT/MIT-equivalent) but stated here as a flag for confirmation, not an asserted fact.
4. If any future work fetches and inspects the actual `AppFlowy-Collab` repository source (to resolve §5's "investigate further" item), its license should be checked explicitly at that time — it was not inspectable in this audit's scope.

---

## 14. Recommendations by Timing

- **Keep as-is:** `auth.js`; persist-before-ack/RID/generation-fencing WS core (`server.js` WS handler, Tasks 42-46); JSON/Postgres dual storage interface; migration advisory lock (`postgres-migration-lock.js`, Task 59); version history/restore mechanism (49A/49B/57); the decision to reuse upstream's protobuf message shapes and `yjs` as the CRDT foundation.
- **Simplify when convenient (no urgency, no Task 61 interaction):** retire or consolidate the legacy `collab-repository.js` duplicate-validation path once its own tests can be migrated or deprecated; consider a lightweight router for `server.js` only if/when route count materially grows further; consider replacing the hand-written `protobufjs` object literal with `.proto` file + codegen for long-term maintainability.
- **Adopt after Task 61 (review only, do not act now):** none of the upstream-code-adoption options are recommended for adoption at all (see §10), so there is nothing in the "adopt upstream code after Task 61" category. The one legitimate "after Task 61" item is reviewing whether Task 61's database sync/persistence layer can shed any planned server-side filter/sort/compute logic in favor of relying on the frontend's already-complete implementation (§15) — a scope-reduction opportunity, not an upstream-code-adoption.
- **Refactor before further development:** none identified as blocking — no finding in this audit rises to "must fix before proceeding."
- **Replace only if justified:** the realtime collaboration engine — justified only if a future, dedicated research spike confirms an actual embeddable packaging of upstream's collab crates exists (unconfirmed today) AND a concrete performance/capability gap with the current Node/`yjs` implementation is demonstrated. Neither condition is currently met.
- **Do not pursue:** FFI/WASM integration of AppFlowy-Collab crates into Node.js (no evidence it's packaged for that); wholesale adoption of AppFlowy-Cloud's Rust service/schema/auth (AGPL + independence conflict); adopting upstream's search/AI microservices as-is (external-service dependency conflict).
- **Resolve soon, not strictly "timing-classified" but flagged as important:** the backend's own LICENSE file absence and the `collab-protocol.js` AGPL-provenance question (§13) — these are licensing-hygiene items, not architecture items, but should not be left indefinitely unresolved.

---

## 15. Potential Task 61 Optimizations (recorded for later review — Task 61 was not touched, consulted, or interrupted)

1. **Potential Task 61 optimization — review after Task 61:** if Task 61's in-progress database/Grid work includes any server-side filter, sort, group, or computed-value logic, consider whether that logic could be reduced or removed in a later pass, since AppFlowy-Web already fully implements filter/sort/group/formula/rollup/field-type logic client-side against the Yjs CRDT (`src/application/database-yjs/*`, `fields/formula/*`, `rollup/*` — confirmed with file-level detail in §6/§8). This is not a suggestion to change anything now — only a note for whoever reviews Task 61's output afterward.
2. **Potential Task 61 optimization — review after Task 61:** the collab object partition-key convention observed in AppFlowy-Cloud (`af_collab.partition_key`: document=0, database=1, workspace-database=2, folder=3, database_row=4, user_awareness=5) may be a useful naming/typing convention to cross-check Task 61's `collabType` values against, purely for future compatibility/clarity — not a correctness issue, just a convention alignment opportunity to consider later.
3. **Potential Task 61 optimization — review after Task 61:** the WS admission handler currently branches explicitly on `collabType` (0=Document, 1=Database per Task 61's in-progress work, per code comments observed). Once Task 61 lands, it may be worth checking whether its new Database branch can share more code with the Document branch's persist-before-ack/RID/generation-fencing logic rather than duplicating it (the existing Database WS branch comment already claims it "mirrors the Document branch above exactly" — worth confirming post-Task-61 that this remains true and isn't drifting into a second parallel implementation).

No files belonging to Task 61 (docs/AGENT_HANDOVER.md, docs/ARCHITECTURE_OVERVIEW.md, docs/FEATURE_REGISTRY.md, docs/MASTER_FEATURE_ROADMAP.md, or any in-progress source files) were opened for editing, and none of the above was derived by inspecting Task 61's actual in-progress diffs — these are general observations from the existing, already-documented architecture and from upstream's data-model conventions.

---

## 16. Unresolved Questions

1. What is the actual internal API/data model of the `collab`/`collab-database`/`collab-document` Rust crates? Not inspectable in this environment (pinned git dependency, no local checkout) — would require fetching `github.com/AppFlowy-IO/AppFlowy-Collab@e59260e524f33104b0ddcd6bb8f6218cad0f7e18` directly.
2. Does any WASM or native-addon packaging of the collab crates exist upstream that simply wasn't referenced by Cargo.toml in these repos (e.g., a separate npm-published WASM build maintained elsewhere)? Not found via dependency-manifest inspection; would require a broader search (e.g., npm registry) outside this audit's repo-scoped mandate.
3. Does reconstructing an AGPL-licensed `.proto` schema's field names/structure in a new file (as `collab-protocol.js` does) carry AGPL obligations for the independent backend? Flagged in §13 as requiring legal review, not resolved here.
4. What is the independent backend's own intended license? Currently unstated (no LICENSE file).
5. Would upstream's whole-blob-snapshot persistence model (if ever considered as a reference) actually preserve the independent backend's proven persist-before-ack guarantee if adapted, or would it require redesign? Not testable without building/running the Rust service, out of scope here.
6. Are individual npm dependency licenses (`pg`, `protobufjs`, `ws`, `yjs`) confirmed permissive in the exact versions pinned? Commonly assumed MIT/MIT-equivalent but not independently re-verified file-by-file in this audit.

---

## 17. Final Verdict

1. **Are we over-engineering any part?** No major over-engineering was found in the P0 collaboration/persistence core. The most-commented component (`postgres-migration-lock.js`) is proportionate to the real bug it fixes. The closest thing to a caution is duplicated validation logic between a legacy test-only path and the production path — low-risk, not worth urgent action.
2. **Are we unnecessarily recreating upstream functionality?** No, for the collaboration/wire-protocol core — the backend already reuses `yjs` and upstream's protobuf message shapes rather than inventing its own. The one area to watch (not yet proven to be a problem, since it's mid-build) is whether Task 61's database work ends up recreating filter/sort/formula logic the frontend already owns — flagged for post-Task-61 review only.
3. **Is the current Node.js backend still the best foundation?** Yes, based on everything inspected. No evidence supports a rewrite; no embeddable alternative exists today for the one component (collaboration engine) where upstream might theoretically offer more capability.
4. **Should we integrate upstream Rust collaboration components?** Not now, and not without first doing dedicated research (fetching and inspecting the actual `AppFlowy-Collab` repository) that this audit's scope did not cover. No FFI/WASM/native-binding packaging was found anywhere in the four inspected repos; the only proven integration model is a separate Rust service, which is a heavier operational model with no demonstrated benefit over the current approach.
5. **Would adopting more upstream backend code save substantial effort?** Based on available evidence, no — AppFlowy-Cloud's backend is AGPL-licensed and its persistence/auth model is tightly coupled to its own `af_workspace`/`af_user`/`gotrue` schema; adopting it would require either abandoning independence or doing substantial adaptation work, for capability (search/AI/admin) that needs an independence-preserving redesign regardless of code origin. No invented effort-savings percentage is offered, per this audit's constraints — the available evidence simply does not support claiming "substantial effort would be saved."
6. **Fastest reasonable path to a functional independent product?** Continue Strategy A: keep the current Node.js backend and proven collaboration/persistence core, build the clearly-missing, non-CRDT-complex features (comments, notifications, ACLs, rate limiting) directly, and give search/AI an explicit self-hosted/optional-key design rather than porting upstream's external-service-dependent versions.
7. **What should we stop building ourselves?** Nothing in the current P0 core should stop — it's working and proven. The one thing to avoid *starting* to build is server-side reimplementation of database filter/sort/group/formula/rollup computation, since the frontend already fully owns and tests this logic.
8. **What existing functionality should we absolutely preserve?** The persist-before-ack/RID/generation-fencing WebSocket collaboration core (Tasks 42-46); the JSON/Postgres dual-storage interface and the Task 59 migration-lock safety fix; the version history/restore mechanism (49A/49B/57); the existing auth model; AppFlowy-Web as the primary frontend and its already-complete client-side business logic.
9. **Recommended architecture and why:** The architecture described in §11 — the current Node.js monolith backend, unchanged in its core collaboration/persistence/auth design, extended only with genuinely-missing non-CRDT features, and continuing to mine upstream's data-model/protocol *conventions* (already proven compatible with the real AppFlowy-Web client) rather than its *code or services* (not embeddable, and licensing/coupling-incompatible with this project's independence goal). This is the simplest architecture that satisfies every stated constraint (no mandatory AppFlowy Cloud dependency, no commercial seat/AI-gateway dependency, independent self-hosted deployment, preserved Document collaboration and version history, AppFlowy-Web as primary frontend) without inventing new risk for unproven benefit.
