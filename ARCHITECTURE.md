# Prototype architecture

`server.js` owns HTTP routing and request validation. `auth.js` owns password hashing and opaque session token hashing. `storage.js` exposes the JSON repository contract; `postgres-storage.js` exposes the same operations with direct parameterized SQL. The data model contains users, workspaces, memberships, pages, and hashed sessions, with workspace membership checked before every workspace/page read or write.

JSON mode is intentionally a single-process, single-file prototype. PostgreSQL mode uses the same application state contract through `postgres-storage.js`, with tables for users, sessions, workspaces, memberships, and pages. The migration is explicit and startup fails if PostgreSQL is selected but unavailable. It has no vendor license service, commercial binary, external identity provider, WebSocket layer, Yjs merge engine, or external egress.

The page `document` is validated as an object and stored with a schema version. It may contain an AppFlowy-derived fixture, but storing JSON does not claim compatibility with AppFlowy Yjs or protobuf synchronization.

PostgreSQL reads are performed per repository operation rather than through a full process-local snapshot. Page updates use a single conditional `UPDATE ... WHERE id, workspace_id, version` and return the committed row; a zero-row result is reported as a stale conflict after authorization. The JSON repository retains its in-memory state and atomic file replacement for lightweight tests.
