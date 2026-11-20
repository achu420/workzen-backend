# Independent backend MVP prototype

> **Product name:** this system is branded **Workzen** in everything users see (web app, e-mails, MCP descriptions). The `AppFlowy-*` folder names, `appflowy-*` identifiers, database/file names, environment variables and API shapes are internal and intentionally unchanged.

A self-hosted backend for the AppFlowy-Web client: accounts, workspaces, documents and databases with live collaboration, comments, notifications, search, AI chat and a card-level MCP server. It owns its own identities, sessions and data and does not connect to AppFlowy Cloud. It is built for small internal teams (tens of people), not for public multi-tenant hosting. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) before running it for real work.

## Quick start

Node.js 20+ is required for JSON mode. PostgreSQL mode uses the declared `pg` dependency; install dependencies in this isolated project before selecting `STORAGE=postgres`.

```sh
cp .env.example .env   # optional; values are placeholders
HOST=127.0.0.1 PORT=8787 DATA_FILE=./data/appflowy-independent.json node server.js
```

For PostgreSQL, create a new disposable database and configure it explicitly:

```sh
npm install
STORAGE=postgres DATABASE_URL='postgresql://prototype_user:REPLACE@127.0.0.1:5432/appflowy_independent_test' node server.js
```

The server runs the numbered SQL migrations on startup (`001_initial.sql`, then `002_spaces.sql`). If PostgreSQL configuration or the `pg` driver is missing, startup fails; it never silently switches to JSON. Do not use an existing AppFlowy or production database URL.

Task 15 used a separate native cluster on port `55432`, database `appflowy_independent_task15`, and role `task15_admin`. Its data directory was `/tmp/appflowy-pg-task15-data`; only that cluster was stopped after testing. To reproduce it, initialize a new cluster in a new directory, start it on a new port, create a new database, and set `DATABASE_URL` accordingly. Do not reuse the existing 5432 listeners.

Stop with `Ctrl-C`. The default data file is local JSON with mode `0600`; use a new path for each disposable test run. Never point `DATA_FILE` at an existing AppFlowy database or shared production location.

Run tests:

```sh
npm test
```

Run the offline AppFlowy collaboration prototype tests:

```sh
npm run test:offline-collab
```

Those tests load the source-derived page fixtures from the sibling AppFlowy checkout. Set `APPFLOWY_FIXTURE_ROOT` to another reviewed fixture directory when needed.

Tests use a temporary isolated file and an ephemeral localhost port. They do not call external services. `npm run test:postgres` is opt-in and requires `RUN_POSTGRES_TESTS=1 DATABASE_URL=...`; without those settings it is skipped.

With an isolated database running, execute:

```sh
RUN_POSTGRES_TESTS=1 DATABASE_URL='postgresql://ROLE@127.0.0.1:PORT/DATABASE' npm run test:postgres
```

The PostgreSQL suite covers migrations, uniqueness/foreign keys, auth/session behavior, membership authorization, page persistence, rollback, restart persistence, and two independent application instances racing on one page version.

## Implemented journeys

- Register with an email and password hashed using Node's `crypto.scrypt`.
- Login, bearer-session validation, current-user lookup, and logout revocation.
- AppFlowy-Web password-token exchange, refresh-token rotation, path-token verification, and authenticated profile response. Access tokens expire after one hour; refresh sessions expire after seven days and rotate on use. Only hashes of access/refresh tokens are persisted. This is an authentication adapter only, not full frontend API compatibility.
- Atomically provision a persisted initial workspace and owner membership on native user registration; list authorized workspaces for AppFlowy-Web bootstrap.
- Advertise the implemented AppFlowy-Web server capabilities.
- Return an authenticated workspace root/page outline from persisted workspace and JSON page metadata; this does not return page content or collaboration state.
- Create persisted, workspace-scoped public spaces through the current Web client's structured `POST /api/workspace/{workspaceId}/spaces` contract. Private/custom ACLs are rejected until their authorization behavior is implemented.
- Create/list/read workspaces and owner/member roles.
- Development-only synthetic membership helper, protected by `NODE_ENV` and `x-development-key`.
- Create/list/read/update pages with validated object documents and optimistic `expected_version` checks.
- Workspace and page authorization, including cross-workspace denial.

## Storage, backup and recovery

JSON mode is the default and keeps everything in one versioned file (atomic rename on every change): fine for trying things out and for tests, but it rewrites the whole file per change and is refused in production. PostgreSQL mode (`STORAGE=postgres`) uses the migration schema, foreign keys, uniqueness constraints and transactions, and is what a team should run.

`node scripts/backup.mjs --out ./backups --keep 14` writes one verified `.tar.gz` holding the database (or the JSON file), the uploaded files and the AI key secret; `node scripts/restore.mjs <archive> --yes` restores it (stop the server first). Both are covered by tests, including a real PostgreSQL dump and restore. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for hosting, production settings and the pre-launch checklist.

## API

The implemented subset is described in [openapi.yaml](openapi.yaml). Native backend error responses use `{ "error": { "code": "...", "message": "..." } }`; AppFlowy-Web authentication, profile, server-info, workspace-bootstrap, and workspace-outline routes use their expected GoTrue/AppFlowy response shapes. The outline includes persisted page metadata only; this is still a partial frontend adapter, not a complete AppFlowy-Web endpoint implementation.

## Not implemented yet

Read-only / comment-only / guest roles and private spaces (every member can edit everything in the workspace; all spaces are public), client or guest access, single sign-on, publishing pages to the public web, forms, import, link previews, and the database bulk-row endpoint (`blob/diff`; the web client falls back to per-row sync). Duplicating a database or a page that contains one is refused with a clear message. MCP exposes eighteen tools: search, read and browse pages, create and append to pages, read/create/update/move/archive/restore database cards, append to a card's body, and read/add/resolve comments on pages and cards (a new page thread must quote the text it is about; comments appear under the token owner's name prefixed "Via <agent>"). Editing or deleting existing text, and deleting comments, are not exposed; card history is in the web app (open a card, History).

For the state of everything else, see `docs/` (for example `LIGHT_MCP_ACCEPTANCE_REPORT.md`, `AI_CAPABILITIES_DISCOVERY.md`).

Templates: besides the built-in database and page templates, about 40 more from appflowy.com/templates are in `templates/`, including sets of linked databases and pages with embedded databases (import or refresh them with `scripts/import-appflowy-templates.mjs`, see docs/DEPLOYMENT.md section 6b). Two could not be carried over (Agile Board Template, Blog Editorial Calendar); the importer prints which and why.
