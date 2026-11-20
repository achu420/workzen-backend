# Deploying for a team (about 20 people)

Written for: whoever runs this server for the team. Everything here was exercised on this project's own test setup;
what was **not** tried (a real public host, a real certificate, a real load) is listed at the end.

## 1. Pick the right kind of hosting

This server is a **long-running Node.js process** that keeps **WebSocket connections** open (that is how people see
each other's edits live) and stores data in **PostgreSQL**.

| Need | Shared hosting (cPanel, "web hosting" plans) | Small VPS / cloud VM |
|---|---|---|
| Run Node 20+ as a permanent process | Usually no (request/response hosting only; processes are killed) | Yes |
| Hold WebSocket connections open | Often blocked or time out | Yes |
| PostgreSQL | MySQL is typical; Postgres rarely | Yes (install or use a managed one) |
| HTTPS in front of it | Provided | Caddy / nginx, free certificates |
| Cost | cheap | roughly 5-12 USD a month is plenty for 20 people |

**Recommendation: a small VPS** (2 vCPU, 2-4 GB RAM, 40 GB disk; Ubuntu 22.04/24.04). If your host is a shared plan,
ask them one question before buying anything: *"Can I run a Node.js 20 process that stays up, accept WebSocket
connections, and use PostgreSQL?"* If any answer is no, it will not work and no configuration changes that.

## 2. What runs where

```
 browser ──HTTPS──> Caddy (your domain)
                      ├─ /            static web app (the built AppFlowy-Web `dist/`)
                      ├─ /api/* /ws/* /mcp /health        ──> backend  127.0.0.1:8787
                      └─ /gotrue/*  (prefix removed)       ──> backend  127.0.0.1:8787
 backend (node server.js, as a service) ──> PostgreSQL (same machine)
 uploaded files: /var/lib/tracker/files        backups: /var/backups/tracker
```

Everything is behind one domain, so no cross-origin (CORS) settings are needed.

## 2b. The quick way: one script

`deploy/setup-server.sh` does sections 3-5 below in one go on a fresh Ubuntu 22.04/24.04 server (PostgreSQL, Node 22,
Caddy with automatic HTTPS, the settings file with generated secrets, the service, the firewall and the nightly backup),
and updates an existing install when run again.

```sh
# on your computer: build the two archives for your address (needs the web app folder next to this one)
DOMAIN=tracker.example.com bash deploy/build-archives.sh
# the DNS A record tracker.example.com -> the server's IP must already exist, then:
scp deploy/out/tracker-backend.tgz deploy/out/tracker-web.tgz deploy/setup-server.sh root@SERVER:/root/
ssh root@SERVER 'DOMAIN=tracker.example.com bash /root/setup-server.sh /root/tracker-backend.tgz /root/tracker-web.tgz'
```

Optional settings can be added in front of the command (`SMTP_HOST=... SMTP_USER=... SMTP_PASS=... EMAIL_FROM=...`,
`SIGNUP_ALLOWED_DOMAINS=yourcompany.com`). The script prints the `AI_KEY_SECRET` once: store it outside the server. To
update later, run `build-archives.sh` again, copy the two archives and run the same ssh command without `DOMAIN`.
The archives were checked by unpacking them, installing only the production dependencies and starting the server in
production mode against PostgreSQL; the script itself has not been run on a real server yet, so read its output.

## 3. Install

```sh
# Node 20+, PostgreSQL 14+, Caddy
sudo apt install -y postgresql caddy        # Node: use nodesource or nvm; check `node --version` >= 20
sudo -u postgres createuser tracker --pwprompt
sudo -u postgres createdb -O tracker tracker

sudo useradd --system --home /opt/tracker --shell /usr/sbin/nologin tracker
sudo mkdir -p /opt/tracker /opt/tracker/backend/logs /var/lib/tracker /var/backups/tracker
# copy the AppFlowy-Independent-Backend folder to /opt/tracker/backend and run:  npm ci --omit=dev
sudo chown -R tracker:tracker /opt/tracker /var/lib/tracker /var/backups/tracker
```

Build the web app on any machine and copy `dist/` to `/opt/tracker/web`:

```sh
cd AppFlowy-Web
APPFLOWY_BASE_URL=https://tracker.example.com \
APPFLOWY_GOTRUE_BASE_URL=https://tracker.example.com/gotrue \
APPFLOWY_WS_BASE_URL=wss://tracker.example.com/ws/v2 \
npx vite build
```

## 4. Backend settings (`/etc/tracker.env`, `chmod 640`, `chgrp tracker`)

```sh
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
STORAGE=postgres
DATABASE_URL=postgresql://tracker:CHANGE-ME@127.0.0.1:5432/tracker
DATA_FILE=/var/lib/tracker/state.json          # only locates the files/ and secret directory next to it
FILE_STORAGE_DIR=/var/lib/tracker/files
AI_KEY_SECRET=<64 hex characters: `openssl rand -hex 32`>   # keep a copy outside the server
TRUST_PROXY=true                               # Caddy sets X-Forwarded-For; needed for per-address sign-in limits
HSTS=true                                      # the site is HTTPS-only
SIGNUP_ENABLED=false                           # or SIGNUP_ALLOWED_DOMAINS=yourcompany.com  (see section 6)
CORS_ALLOWED_ORIGINS=                           # empty: same origin
# E-mail (see section 6): password reset codes, invitations, optional notification e-mails
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=mailer@yourcompany.com
SMTP_PASS=CHANGE-ME
EMAIL_FROM=tracker@yourcompany.com
PUBLIC_URL=https://tracker.example.com
# EMAIL_NOTIFICATIONS=true                      # e-mail mentions, replies and assignments too
# VERSION_QUIET_SECONDS=180   VERSION_MAX_SECONDS=600   VERSION_KEEP_AUTO=100   (automatic page history)
# Optional tuning
# LOGIN_MAX_ATTEMPTS=10  LOGIN_WINDOW_SECONDS=900  FILE_MAX_BYTES=104857600
# API_LOG_FILE=./logs/api.log  API_LOG_MAX_BYTES=20971520  API_LOG_KEEP=5   (rotates by itself; default under the backend folder)
# AI_RATE_LIMIT_PER_MINUTE=30
```

With `NODE_ENV=production` the server **refuses to start** if `DEV_TEST_KEY` is set or `STORAGE` is not `postgres`, and
prints a warning for each of these that is still open: no `AI_KEY_SECRET`, `localhost` in CORS, open sign-up, no
`TRUST_PROXY`. Read those warnings in `journalctl -u tracker` after the first start.

`/etc/systemd/system/tracker.service`:

```ini
[Unit]
Description=Team tracker backend
After=network.target postgresql.service

[Service]
User=tracker
WorkingDirectory=/opt/tracker/backend
EnvironmentFile=/etc/tracker.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/tracker /opt/tracker/backend/logs

[Install]
WantedBy=multi-user.target
```

`/etc/caddy/Caddyfile`:

```
tracker.example.com {
	encode gzip
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		X-Frame-Options DENY
	}
	@backend path /api/* /ws/* /mcp /health
	handle @backend {
		reverse_proxy 127.0.0.1:8787
	}
	handle_path /gotrue/* {
		reverse_proxy 127.0.0.1:8787
	}
	handle {
		root * /opt/tracker/web
		try_files {path} /index.html
		file_server
	}
}
```

Start: `sudo systemctl enable --now tracker && sudo systemctl reload caddy`. Caddy obtains the HTTPS certificate by itself
once the domain points at the server.

## 4b. Test accounts (seeder)

`scripts/seed.mjs` creates three accounts that share one workspace, **Workzen Test Workspace**, so you can sign in and
check the install while sign-up is still closed:

| Role | E-mail | Password | Can do |
|---|---|---|---|
| owner | `owner@workzen.test` | `Owner#Test2026` | everything, including members, AI settings and agent tokens |
| admin | `admin@workzen.test` | `Admin#Test2026` | the same as owner (manages members, the invite link and AI settings) |
| member | `member@workzen.test` | `Member#Test2026` | edit content; no member or AI settings (the invite link answers 403) |

**These passwords are public (they are in this file).** Lock the accounts when you have finished testing (below).

On the server (it reads the same settings file as the service, so it writes to the real database):

```sh
sudo -u tracker bash -c 'set -a; . /etc/tracker.env; set +a; cd /opt/tracker/backend && node scripts/seed.mjs --allow-production'
```

It prints the workspace id and one line per account (`created`, or `reset` if it already existed). With
`NODE_ENV=production` it refuses to run without `--allow-production`. Running it again is safe: it puts back the
passwords and roles above and signs those accounts out, and changes nothing else. The service can keep running.

On a developer machine with the default JSON storage, **stop the backend first** (it holds the data in memory and
would overwrite the seeder's changes), then run `npm run seed` in the backend folder and start it again.

What to try with them:

1. Open `https://tracker.example.com`, sign in as `owner@workzen.test`. The first sign-in creates the workspace's first
   space, as it does for anyone who signs up. Create a page and a board.
2. In a private window, sign in as `member@workzen.test`: the same workspace and page are there, and typing in one
   window shows up in the other within a second or two (WebSockets work through Caddy).
3. As `admin@workzen.test`, open Members: all three people are listed. The list labels the admin as "Member" (the web
   app only shows Owner/Member); the admin rights are still there, as step 4 shows.
4. As admin, copying the Members invite link works; as member the server refuses it.

The addresses end in `.test`, so the server never e-mails them and "Forgot password" does nothing for them; use the
passwords above.

When testing is finished, give the three accounts random passwords and sign them out:

```sh
sudo -u tracker bash -c 'set -a; . /etc/tracker.env; set +a; cd /opt/tracker/backend && node scripts/seed.mjs --lock'
```

Locking keeps the accounts and the test workspace (delete the test pages yourself if you want them gone). Run the seed
command again to unlock them for the next test.

## 5. Backups (do this before anyone writes real content)

One command makes a verified archive of the database, the uploaded files and the AI key secret:

```sh
sudo -u tracker bash -c 'set -a; . /etc/tracker.env; set +a; cd /opt/tracker/backend && node scripts/backup.mjs --out /var/backups/tracker --keep 14'
```

Run it nightly from cron (`0 3 * * *`) and **copy `/var/backups/tracker` off the machine** (another server, a bucket,
your laptop) - a backup that lives only on the same disk does not survive losing the disk. `AI_KEY_SECRET` is not in the
archive when it comes from the environment; store it with your other secrets.

**Restore** (stop the service first; the database must already exist and be empty or disposable):

```sh
sudo systemctl stop tracker
node scripts/restore.mjs /var/backups/tracker/backup-20261114-030000.tar.gz          # verifies and describes, changes nothing
node scripts/restore.mjs /var/backups/tracker/backup-20261114-030000.tar.gz --yes    # restores
sudo systemctl start tracker
```

**Test a restore once, now**, on a spare database, and again after any big change. A backup you have never restored is a
guess. (The automated test does this on a throwaway database; it cannot test your server.)

## 6. People and access

* **Accounts.** With `SIGNUP_ENABLED=false` nobody can register. To add someone: temporarily set
  `SIGNUP_ALLOWED_DOMAINS=yourcompany.com` (and `SIGNUP_ENABLED=true`) so they can sign up with a company address, or
  leave it that way if everyone has one. After they have an account, an owner/admin adds them from Members (invite
  link, or the invite-by-email box, which adds people who already have an account).
* **E-mail.** With the `SMTP_*` settings the server sends: invitations to people who have no account yet (Members >
  invite by e-mail; creating an account with that address is accepted even when sign-up is closed and adds them to
  your workspace), 6-digit codes for "Forgot password" and "Continue with email" (valid 10 minutes, single use, five
  guesses), and - only if `EMAIL_NOTIFICATIONS=true` - e-mails for mentions, replies and assignments (at most one per
  person per page every 5 minutes, each with a one-click unsubscribe link). Check it with
  `GET /api/workspace/<id>/email-status` (connects and logs in to the mail server, sends nothing) and
  `POST /api/workspace/<id>/email-test {"to": "you@yourcompany.com"}`. Addresses that cannot receive mail
  (example.com, anything ending in .test) are skipped instead of bouncing. Put the SMTP password in the environment
  file only, never in a repository, and change it if it was ever shared in chat or e-mail.
* **AI chat and search.** The chat searches the workspace for each question (only what the asker may read) and tells the
  model which pages and cards it found; they appear as source chips under the answer. Questions about tasks, deadlines,
  risks or plans also get a table of cards from every database (newest-changed first, capped). Picking pages in the
  chat's scope limits *documents* to those pages; cards and databases are included by default and can be switched off
  with "Include cards and databases" in the same picker. Agents get the same search
  through the `search`, `read_page` and `list_pages` tools, and can write with `create_page`, `append_to_page` and `append_to_card_body` (existing text is never changed; a restore point is saved first), and read and write comments with `list_comments`, `add_comment` and `resolve_comment`.
  How good the answers are depends on the model behind your API key: this was tested with a stand-in model, not a real
  one.
* **Passwords.** The web form requires at least one special character; the server accepts 8-200 characters. Without
  mail settings there is no password reset (an admin must change it in the database); with them, "Forgot password"
  works. A signed-in person can always change their password in Settings.
* **Roles.** Owner and admin can manage members and AI settings. **Every member can edit and delete everything in the
  workspace** - there is no read-only or comment-only role yet. That is acceptable for contributors you trust,
  because nothing is silently lost: documents keep automatic version history (below), every agent change is recorded
  and undoable (below), and the trash holds deleted pages. It is *not* acceptable for someone who must only look.
* **History and "who changed it".** After a page has been quiet for 3 minutes (or edited for 10 minutes straight) the
  server saves a version of it, credited to the people who edited, keeping the newest 100 per page (versions saved by
  hand are never removed). Open a page's version history to browse and restore. Card (database row) edits made by
  people are recorded too: open a card and look under **History** to see who changed the title or fields and when, and
  restore a change (only if the card has not been edited since; otherwise nothing is touched and you are told why).
  Edits are grouped: a burst of typing becomes one entry after `CARD_HISTORY_QUIET_SECONDS` (default 15) of quiet or
  `CARD_HISTORY_MAX_SECONDS` (default 60). Not covered: deleting a card from the web app's own menu and edits to a
  card's body text are not in card history (the page trash still holds deleted cards).
* **Agents.** Every member creates tokens for their own agents (Settings > Agent access) and should name them after the
  agent, e.g. "Achal's Claude Code". A token has exactly its owner's access. Everything an agent searches, reads or
  changes is recorded under the token's name and its owner (Settings > Agent access > Activity, visible to everyone in
  the workspace). Anyone can undo an agent's card change, created page, appended text (page or card body) or comment from there,
  unless it was edited again afterwards, or, for a comment, someone has replied (then nothing is touched and you are
  told why). An agent's comment is shown under its owner's name and starts with "Via <agent name>:", so readers can
  tell it came from an agent; a new comment thread on a page is attached to the text the agent quotes. Before `append_to_page` writes, the page's
  version history gets a restore point; Undo brings the page back to it. Owners and admins can see and revoke every token.

## 6b. Templates

The "Templates" and "Page templates" sections of the new-page menu come from the files in `templates/databases` and
`templates/documents` (4 + 9 built in, plus those imported from https://appflowy.com/templates, grouped by category in
the menu). Every imported file keeps its `source_url`, `category` and `author`; the templates are published by AppFlowy
and community authors there, so keep that credit and check the source's terms if you redistribute them.

To pull in new or updated ones (needs internet; nothing is fetched at run time, the files are part of the backend):

```sh
node scripts/import-appflowy-templates.mjs --dry-run                 # shows what would be added or skipped, and why
node scripts/import-appflowy-templates.mjs --cache /tmp/af-templates  # writes the files
node scripts/import-appflowy-templates.mjs --force                    # also refreshes ones imported earlier
```

The importer never overwrites a template you built by hand. What it carries over, and what it cannot:

* **Linked databases** (relation fields, rollups, formulas built on them) are imported together: the template's own
  database plus every database it links to (up to 8), created as a connected set under the same space or page.
  Relations, related rows and rollups work as in the original. Linked databases that came from an embedded view with
  a generic name are called "<template> - <name>".
* **Pages with embedded databases and sub-pages** are imported with their databases (created as children of the page,
  shown in the page by the same block) and their sub-pages.
* Removed: media/file fields, relations to anything that cannot be imported (and rollups and formulas that depended on
  them), Form views, PDF blocks, person mentions and reminders. Images and files stored on AppFlowy's servers become
  empty placeholders. A template that would lose too much of itself, or whose source copy cannot be read, is skipped,
  and the report says why (at the time of writing: Agile Board Template, Blog Editorial Calendar, and one broken copy).
* Restart the backend after importing (the library is read once at start).

## 7. Updating

Take a backup, stop the service, replace `/opt/tracker/backend`, run `npm ci --omit=dev`, start. Database migrations run
on start (they are idempotent and use an advisory lock). Then replace `/opt/tracker/web` with the new `dist/`.

## 8. Checklist before you invite the team

- [ ] `journalctl -u tracker` shows no `[config]` warnings you did not choose to accept
- [ ] `curl -I https://tracker.example.com/api/server-info` answers 200 with `strict-transport-security`
- [ ] Sign-up behaves as you intend (try it in a private window)
- [ ] The three test accounts from section 4b are locked (`node scripts/seed.mjs --lock`)
- [ ] A nightly backup exists **off the machine**, and one restore has been rehearsed
- [ ] `AI_KEY_SECRET` is stored somewhere other than this server
- [ ] `GET /api/workspace/<id>/email-status` shows `connection: { ok: true }` and a test e-mail reached a real inbox
- [ ] You know who is an owner/admin (they can manage AI keys and agent tokens)

## 9. What this guide does not cover

Not tried on a real public host: certificate issuance, behaviour behind your actual network, sustained load from 20
simultaneous editors, a PostgreSQL major-version upgrade, running two backend processes (not supported - one process).
The seeder (section 4b) was checked against PostgreSQL and JSON storage through the API (sign-in, workspace, roles,
lock, re-seed), not yet by signing in through the web app in a browser.
Private spaces, single sign-on and publishing pages to the public web do not
exist yet.
