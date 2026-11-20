# Offline AppFlowy collaboration repository

**Status:** implemented as an in-memory, test-only prototype. No WebSocket, HTTP endpoint, durable storage, authentication, or frontend integration is included.

## Repository contract

`OfflinePageCollabRepository` owns one `Y.Doc` initialized from an AppFlowy-specific v1 page update. It exposes:

- `stateVector()` — current lib0 v1 state vector.
- `documentUpdate(flags)` — full current update in lib0 v1 (`flags=0`) or v2 (`flags=1`).
- `missingUpdate(stateVector, flags)` — state-vector diff after validating the vector encoding.
- `validateUpdate(metadata)` — validates flags, payload, version, restore generation, state vector, and Yjs decodability without mutating the document.
- `acceptUpdate(metadata)` — applies a validated v1/v2 update and records a duplicate key. It returns `durable:false` and `acknowledged:false` because this repository has no durable storage.
- `applyMessage(bytes)` — decodes the source-derived `messages.Message` subset and handles `SyncRequest` or `Update` for the configured object ID.

## Confirmed behavior

- AppFlowy page update bytes are accepted by Yjs v1/v2 decoders.
- State-vector diffs are generated with `Y.encodeStateAsUpdate`/`Y.encodeStateAsUpdateV2`.
- Invalid state vectors, malformed Yjs updates, unsupported flags, version mismatch, restore mismatch, and object mismatch are rejected.
- Repeated delivery with the same message ID or payload digest is classified as duplicate and does not mutate the document twice.
- Protobuf envelopes use the field numbers and oneofs from AppFlowy-Web `messages.proto`/`collab.proto`.

## Deliberate boundaries

The source establishes the client message shapes but not the server's Redis/Rid admission algorithm, durable acknowledgement timing, compaction, authorization, or restore-generation policy. This prototype therefore does not claim durable acknowledgement, server ordering, persistence, or frontend compatibility. `seen` is process-local and only demonstrates duplicate handling within one test repository.

