# Older AppFlowy-Web end-to-end compatibility attempt

**Review date:** 2026-10-28  
**Web candidate:** `3ff072838202a4d47f0fa6683b4179fd0ad5fb4f`  
**Cloud source:** `c5bcfd33edd46ced4a9b4fdb7ddb3bbf8c0326da`  
**Decision:** **NO-GO** for selecting the older frontend as the MVP route on the evidence available. This is an environment/safety decision, not a finding that the candidate is inherently incompatible.

## Result summary

No candidate frontend or server was started. No authentication, page, edit, or persistence request was sent. The required proof could not be collected because an isolated runtime could not be established safely with the available environment.

| Required behavior | Result | Evidence |
|---|---|---|
| Isolated environment starts | **BLOCKED** | The Cloud checkout has no built server binary; `rustc` and `cargo` are not installed. Its documented launcher requires Rust/Cargo, Docker Compose, a `.env`, PostgreSQL, and SQLx; it is not an isolated single-process test runner. |
| Authentication | **BLOCKED** | No isolated server or auth service was started. The candidate's test account and credentials were not fabricated or obtained from any deployment. |
| Page loading | **BLOCKED** | No request was made to any existing AppFlowy service. |
| Page editing | **BLOCKED** | No candidate browser session was started and no test text was entered. |
| Durable server persistence | **BLOCKED** | No edit reached a test server; no database or object store was queried. |
| Reconnect/reopen | **BLOCKED** | No test edit existed to verify after reconnect or restart. |
| Evidence that the intended test server received an edit | **BLOCKED** | No edit request or server log was produced. |
| Legacy HTTP `web-update` route used | **BLOCKED** | The route was not exercised; no HTTP capture was produced. |

No behavior is marked **PASS** or **FAIL**: the end-to-end sequence was not attempted after the safe-environment prerequisite failed.

## Environment and license evidence

- Git reports the exact Web candidate commit is present in the existing Web history; Cloud `HEAD` is the specified `c5bcfd33…`. The existing Web checkout has pre-existing modifications and untracked files. They were preserved. The Cloud checkout was not modified.
- The `LICENSE` file at each specified source revision identifies GNU AGPL version 3. No code was built or run; no licensing restriction was bypassed.
- The Cloud README at `c5bcfd33…` states this repository is archived and warns not to build it as the latest AppFlowy self-hosted server. Its documented current distribution is based on a separate commercial codebase; that codebase and its images were not used.
- The Cloud `script/run_local_server.sh` describes a complete environment and requires Docker, PostgreSQL, Rust/Cargo, an `.env`, and SQLx. It contains logic for handling existing containers and was not executed.
- The launcher invokes `docker-compose-dev.yml`, which requires database, Redis, MinIO, GoTrue, and PostgreSQL administration services. It uses an `appflowyinc/gotrue` image and binds fixed host ports including `5432`, `6379`, and `9999`, which are already occupied here. It was not run. The standard `docker-compose.yml` additionally references `appflowyinc` Cloud/AI/worker/search/admin/Web images and was also not run.
- Read-only process/port inspection found an already-running AppFlowy commercial Docker stack, host Redis on `127.0.0.1:6379`, and PostgreSQL listeners on port `5432`; the Docker stack also occupies ports including `8000`, `8100`, `8443`, and `9999`. These resources were not contacted, stopped, reconfigured, or reused. No database state, credentials, Docker volumes, or deployment endpoints were inspected.
- Node 26 and an existing `node_modules` directory are present in the current Web checkout, but that checkout is dirty and is not an isolated snapshot of the `3ff0728` candidate. It was not used to launch the frontend. `corepack pnpm` is unavailable.
- No disposable clone/worktree, container, database, storage directory, credential, or service was created. No tests or builds were run.

## Recommendation

**NO-GO** for adopting the older frontend as the MVP route until an isolated end-to-end test demonstrates authentication, page edit, durable persistence, and reopen/reconnect. This is not a permanent technical rejection of the candidate: source review suggests a plausible older WebSocket protocol pairing, but source inspection cannot substitute for the requested end-to-end proof.

**Single next action:** Provision a task-owned, isolated test environment with a Rust/Cargo toolchain and disposable Cloud dependencies on verified unused ports, with no commercial images or existing services, then rerun this same narrow end-to-end test.
