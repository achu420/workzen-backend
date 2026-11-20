# Durable AppFlowy collaboration storage

**Status:** implemented repository layer; no WebSocket/HTTP collaboration endpoint is included.

## Scope and evidence

The Web source establishes that a page is loaded as binary `data.encoded_collab`, that Yjs state vectors and v1/v2 updates are exchanged, and that update metadata includes a version, optional restore identifier, message identifier and before-state vector (`AppFlowy-Web/src/application/services/js-services/http/collab-api.ts:45-110,285-430`; `src/application/services/js-services/sync-protocol.ts:92-348`; `src/proto/messages.proto`, `collab.proto`). The server's `Rid` ordering algorithm, compaction policy, restore fences and acknowledgement contract are not established by those sources.

This design therefore stores the observable binary state and metadata without claiming to reproduce those unknown server semantics.

## Relational model

`collab_documents` is one row per `(workspace_id,page_id)`, with a composite foreign key to `pages(id,workspace_id)`. It stores the canonical Yjs v1 document update (`document_state`), its Yjs state vector, an application-defined `collab_version`, optional `restore_id`, a monotonically increasing local `generation`, and update time.

`collab_updates` is an append-only audit/recovery log for accepted payloads. It stores the original binary payload, v1/v2 flag, SHA-256 payload digest, optional message key, before-state vector, version/restore metadata and commit time. A unique digest and unique non-null message key make delivery retries idempotent per page. The log is intentionally not interpreted as an AppFlowy `Rid` stream.

## Admission and recovery

An update transaction locks the document row, verifies page/workspace identity and version/restore metadata, checks duplicate keys, applies the binary update to a Y.Doc, rejects malformed or unresolved updates, inserts the accepted payload, and replaces the canonical document/state vector while incrementing `generation`. The transaction commits before the repository reports `durable: true`; it reports `acknowledged: false` because no network acknowledgement exists in this task. A process restart loads the canonical binary state and vector from PostgreSQL; no process-local `seen` set is required.

Row locking plus a generation predicate prevents silent last-writer overwrites across independent repository instances. Concurrent valid Yjs updates are applied serially to the latest state and both are retained when their Yjs client clocks are compatible.

## JSON mode and boundaries

The existing JSON storage adapter remains unchanged for users, workspaces and JSON page CRUD. It does not expose this durable binary collaboration repository; silently treating JSON page documents as Yjs state would be unsafe. Collaboration in JSON mode is therefore explicitly unsupported until a separate crash-safe design is approved.

No WebSocket, HTTP sync route, authentication policy, authorization expansion, compaction, notification, or frontend integration is implemented here. Redis-style `Rid`, restore-generation semantics beyond equality checks, and server acknowledgement timing remain unresolved and require conformance evidence before being specified.
