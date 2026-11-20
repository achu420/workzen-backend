# Offline AppFlowy admission conformance harness

The entry point is:

```sh
npm run test:collab-conformance
```

The harness is source-only and uses the existing AppFlowy-specific binaries under `contracts/mvp/appflowy-golden/`. It contacts no backend, starts no service, and does not create accounts or database records.

## Passing vectors

The harness checks:

1. Every manifest byte length, SHA-256 digest, and deterministic marker.
2. Loading the source-derived page update and calculating an empty state-vector diff.
3. Protobuf envelope decode/re-encode for sync, v1 update, v2 update, awareness, and access-change fixtures.
4. v1/v2 flag acceptance and unsupported-flag rejection.
5. Ordinary text update validation/application.
6. Advisory treatment of `after_state_vector` in the local admission prototype; the post-update state is derived from Yjs rather than that field.
7. Malformed protobuf/Yjs data, invalid state vectors, version mismatches, and restore metadata mismatches.
8. The local sync response's `durable: false` result and absence of a wire acknowledgement.

These are fixture/source-confirmed or local prototype invariants. They are not evidence of a complete AppFlowy server.

## Pending vectors

Seven vectors are printed as `PENDING`, never as passes:

- server-issued `Rid` allocation/order and reconnect cursor behavior;
- duplicate admission key and retry response;
- realtime acknowledgement timing;
- compaction/history retention;
- restore-generation transitions and notifications;
- cross-instance replay ordering/failover;
- WebSocket versus HTTP full-sync convergence.

Each pending line includes the missing behavior and the upstream implementation or integration evidence required to resolve it. These gaps correspond to the unknown items in `docs/APPFLOWY_SYNC_SEMANTICS_AND_ADMISSION.md` and are intentionally not guessed by the harness.

## Output contract

Output is deterministic and machine-readable by prefix: `PASS`, `FAIL`, `PENDING`, or `SKIP`, followed by a final `COLLAB_CONFORMANCE_SUMMARY` block. Any failed confirmed vector sets a non-zero exit code. Pending vectors do not fail the command, but are counted separately and remain visible in CI logs.
