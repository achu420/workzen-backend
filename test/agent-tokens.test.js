// Agent (MCP) tokens: management routes (owner/admin only), storage (hash only), the
// authenticator the /mcp endpoint uses, and the boundary that agent tokens are never
// sessions. The same suite runs against JSON storage and, when RUN_POSTGRES_TESTS=1 and
// DATABASE_URL are set, against a real PostgreSQL.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const logDir = await mkdtemp(path.join(os.tmpdir(), 'agent-tokens-log-'));
const logFile = path.join(logDir, 'api.log');

process.env.API_LOG_FILE = logFile;
const { startServer } = await import('../server.js');
const { createAgentAuthenticator, generateAgentToken, parseAgentToken, secretMatches } = await import('../agent-auth.js');

const postgresConfigured = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const TOKEN_SHAPE = /^afmcp_[a-z0-9]{12,40}_[A-Za-z0-9_-]{43}$/;
const DEV = { 'x-development-key': 'test-key' };

after(async () => { await rm(logDir, { recursive: true, force: true }); });

describe('pure token helpers', () => {
  test('generated tokens have the afmcp_<id>_<secret> shape, parse back, and only the hash matches', () => {
    const issued = generateAgentToken();

    assert.match(issued.token, TOKEN_SHAPE);
    assert.deepEqual(parseAgentToken(issued.token), { id: issued.id, secret: issued.secret });
    assert.equal(issued.hash, createHash('sha256').update(issued.secret).digest('hex'));
    assert.notEqual(generateAgentToken().token, issued.token);
    for (const bad of ['', 'afmcp_', 'afmcp_abc_def', `afmcp_${issued.id}_short`, issued.token.replace('afmcp_', 'other_'), `${issued.token}x`, null, undefined, 42]) {
      assert.equal(parseAgentToken(bad), null, String(bad));
    }
  });

  test('secret comparison is constant-time on fixed-length digests and never throws', async () => {
    const issued = generateAgentToken();
    const sameLengthWrong = `${issued.secret.slice(0, -1)}${issued.secret.endsWith('A') ? 'B' : 'A'}`;

    assert.equal(secretMatches(issued.secret, issued.hash), true);
    assert.equal(secretMatches(sameLengthWrong, issued.hash), false);
    assert.equal(secretMatches('short', issued.hash), false);
    assert.equal(secretMatches('x'.repeat(5000), issued.hash), false);
    assert.equal(secretMatches(issued.secret, 'not-hex'), false);
    assert.equal(secretMatches(issued.secret, ''), false);
    assert.equal(secretMatches(issued.secret, undefined), false);
    assert.match(readFileSync(new URL('../agent-auth.js', import.meta.url), 'utf8'), /timingSafeEqual/);
  });
});

function defineSuite(mode) {
  describe(`agent tokens (${mode})`, { skip: mode === 'postgres' && !postgresConfigured }, () => {
    let dir, running, base;

    async function api(method, route, payload, token, headers = {}) {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      const text = await response.text();

      return { status: response.status, body: text ? JSON.parse(text) : null };
    }

    before(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'agent-tokens-'));
      running = await startServer(mode === 'postgres'
        ? { storage: 'postgres', databaseUrl: process.env.DATABASE_URL, host: '127.0.0.1', port: 0, devKey: 'test-key', environment: 'test' }
        : { host: '127.0.0.1', port: 0, file: path.join(dir, 'state.json'), devKey: 'test-key', environment: 'test' });
      base = `http://127.0.0.1:${running.address.port}`;
    });
    after(async () => {
      await new Promise((resolve) => { running.server.closeAllConnections?.(); running.server.close(resolve); });
      await running.app.store.close?.();
      await rm(dir, { recursive: true, force: true });
    });

    const unique = (label) => `${label}-${mode}-${Math.random().toString(36).slice(2, 8)}`;

    async function account(label) {
      const email = `${unique(label)}@example.test`;

      assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
      const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
      const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;

      return { email, token, workspaceId };
    }

    // Adds `member` to `owner`'s workspace with the given role through the dev helper.
    const grant = (owner, member, role = 'member') => api('POST', `/api/workspaces/${owner.workspaceId}/test-members`, { email: member.email, role }, owner.token, DEV);
    const revokeMembership = (owner, member) => api('DELETE', `/api/workspaces/${owner.workspaceId}/test-members?email=${encodeURIComponent(member.email)}`, undefined, owner.token, DEV);
    const tokensUrl = (workspaceId, tokenId = '') => `/api/workspace/${workspaceId}/agent-tokens${tokenId ? `/${tokenId}` : ''}`;
    const create = (owner, payload = {}) => api('POST', tokensUrl(owner.workspaceId), { name: 'Claude Code', scope: 'read', ...payload }, owner.token);
    const agentReq = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

    test('create, list and revoke work; the secret is returned once and never listed', async () => {
      const owner = await account('tok-owner');
      const created = await create(owner, { name: '  Cursor  ', scope: 'write', expires_in_days: 30 });

      assert.equal(created.status, 200, JSON.stringify(created.body));
      const data = created.body.data;

      assert.match(data.token, TOKEN_SHAPE);
      assert.equal(data.name, 'Cursor');
      assert.equal(data.scope, 'write');
      assert.ok(data.id && data.created_at);
      assert.ok(Math.abs(Date.parse(data.expires_at) - Date.parse(data.created_at) - 30 * 86400000) < 1000);
      assert.ok(data.token.startsWith(`afmcp_${data.id}_`));

      const listed = await api('GET', tokensUrl(owner.workspaceId), undefined, owner.token);
      const secret = parseAgentToken(data.token).secret;

      assert.equal(listed.status, 200);
      assert.deepEqual(Object.keys(listed.body.data.tokens[0]).sort(), ['created_at', 'expired', 'expires_at', 'id', 'last_used_at', 'name', 'owned_by_me', 'owner', 'revoked', 'scope']);
      assert.deepEqual([listed.body.data.tokens[0].owned_by_me, listed.body.data.tokens[0].owner.email], [true, owner.email]);
      assert.equal(listed.body.data.tokens[0].id, data.id);
      assert.equal(listed.body.data.tokens[0].revoked, false);
      assert.equal(listed.body.data.tokens[0].expired, false);
      assert.equal(listed.body.data.tokens[0].last_used_at, null);
      assert.ok(!JSON.stringify(listed.body).includes(secret));

      const second = await create(owner, { name: 'Second' });
      const order = (await api('GET', tokensUrl(owner.workspaceId), undefined, owner.token)).body.data.tokens;

      assert.deepEqual(order.map((t) => t.id), [second.body.data.id, data.id], 'most recent first');

      const revoked = await api('DELETE', tokensUrl(owner.workspaceId, data.id), undefined, owner.token);

      assert.deepEqual(revoked.body.data, { id: data.id, revoked: true });
      assert.equal((await api('DELETE', tokensUrl(owner.workspaceId, data.id), undefined, owner.token)).status, 200, 'revoking twice is harmless');
      const after = (await api('GET', tokensUrl(owner.workspaceId), undefined, owner.token)).body.data.tokens.find((t) => t.id === data.id);

      assert.equal(after.revoked, true);
    });

    test('only the SHA-256 of the secret is stored', async () => {
      const owner = await account('tok-hash');
      const { token, id } = (await create(owner)).body.data;
      const { secret } = parseAgentToken(token);
      const row = await running.app.store.getAgentToken(id);

      assert.equal(row.token_hash, createHash('sha256').update(secret).digest('hex'));
      assert.ok(!JSON.stringify(row).includes(secret));
      if (mode === 'json') {
        assert.ok(!JSON.stringify(running.app.store.state).includes(secret), 'the secret is nowhere in the state');
      } else {
        const everything = await running.app.store.pool.query('SELECT * FROM agent_tokens WHERE id=$1', [id]);

        assert.ok(!JSON.stringify(everything.rows).includes(secret), 'the secret is in no column');
        assert.equal(everything.rows[0].token_hash, row.token_hash);
      }
    });

    test('validation rejects bad names, scopes, expiries and unknown fields, and caps active tokens', async () => {
      const owner = await account('tok-valid');
      const bad = [
        { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 7 }, { name: undefined },
        { scope: 'admin' }, { scope: undefined }, { scope: 'READ' },
        { expires_in_days: 0 }, { expires_in_days: 366 }, { expires_in_days: 1.5 }, { expires_in_days: '7' }, { expires_in_days: -1 },
        { role: 'owner' },
      ];

      for (const patch of bad) {
        const response = await api('POST', tokensUrl(owner.workspaceId), { name: 'ok', scope: 'read', ...patch }, owner.token);

        assert.equal(response.status, 400, JSON.stringify(patch));
        assert.ok(response.body.message, 'errors carry a top-level message');
      }
      assert.equal((await create(owner, { expires_in_days: null })).status, 200);
      assert.equal((await create(owner, { expires_in_days: 365 })).status, 200);
      assert.equal((await api('GET', tokensUrl(owner.workspaceId), undefined, owner.token)).body.data.tokens.length, 2, 'rejected requests created nothing');

      const ids = [];

      for (let index = 0; index < 8; index += 1) ids.push((await create(owner, { name: `bulk-${index}` })).body.data.id);
      const over = await create(owner, { name: 'one too many' });

      assert.equal(over.status, 400);
      assert.match(over.body.message, /10 active/, 'ten active tokens per person');
      await api('DELETE', tokensUrl(owner.workspaceId, ids[0]), undefined, owner.token);
      assert.equal((await create(owner, { name: 'fits again' })).status, 200, 'revoking frees a slot');
    });

    test('every member manages their OWN tokens; owners and admins see and revoke everyone\'s; outsiders and anonymous callers get nothing', async () => {
      const owner = await account('tok-roles-owner');
      const member = await account('tok-roles-member');
      const other = await account('tok-roles-other');
      const admin = await account('tok-roles-admin');
      const outsider = await account('tok-roles-outsider');
      const existing = (await create(owner, { name: "Owner's agent" })).body.data;

      assert.equal((await grant(owner, member, 'member')).status, 201);
      assert.equal((await grant(owner, other, 'member')).status, 201);
      assert.equal((await grant(owner, admin, 'admin')).status, 201);
      const url = tokensUrl(owner.workspaceId);
      const mine = (await api('POST', url, { name: "Mia's Claude Code", scope: 'write' }, member.token)).body.data;
      const theirs = (await api('POST', url, { name: "Omar's Cursor", scope: 'read' }, other.token)).body.data;

      assert.ok(mine.token.startsWith('afmcp_'), 'a plain member can create a token');
      // A member lists only their own; the owner and an admin list all, each with its owner.
      const memberList = (await api('GET', url, undefined, member.token)).body.data;

      assert.deepEqual(memberList.tokens.map((t) => t.name), ["Mia's Claude Code"]);
      assert.equal(memberList.can_manage_all, false);
      assert.deepEqual([memberList.tokens[0].owner.email, memberList.tokens[0].owned_by_me], [member.email, true]);
      const adminList = (await api('GET', url, undefined, admin.token)).body.data;

      assert.equal(adminList.can_manage_all, true);
      assert.deepEqual(adminList.tokens.map((t) => [t.name, t.owner.email, t.owned_by_me]).sort(), [["Mia's Claude Code", member.email, false], ["Omar's Cursor", other.email, false], ["Owner's agent", owner.email, false]]);
      // Revoking: your own yes, somebody else's no (it does not even say it exists), a manager's yes.
      assert.equal((await api('DELETE', tokensUrl(owner.workspaceId, theirs.id), undefined, member.token)).status, 404);
      assert.equal((await api('DELETE', tokensUrl(owner.workspaceId, existing.id), undefined, member.token)).status, 404);
      assert.equal((await api('DELETE', tokensUrl(owner.workspaceId, mine.id), undefined, member.token)).status, 200);
      assert.equal((await api('DELETE', tokensUrl(owner.workspaceId, theirs.id), undefined, admin.token)).status, 200);
      // Outsiders and anonymous callers.
      assert.equal((await api('GET', url, undefined, outsider.token)).status, 403);
      assert.equal((await api('POST', url, { name: 'x', scope: 'read' }, outsider.token)).status, 403);
      assert.equal((await api('DELETE', tokensUrl(owner.workspaceId, existing.id), undefined, outsider.token)).status, 403);
      assert.equal((await api('GET', url)).status, 401);
      assert.equal((await api('POST', url, { name: 'x', scope: 'read' })).status, 401);
      assert.equal((await api('DELETE', tokensUrl(owner.workspaceId, existing.id))).status, 401);
      assert.equal((await api('DELETE', tokensUrl(owner.workspaceId, existing.id), undefined, admin.token)).status, 200);
    });

    test('a token of another workspace cannot be revoked (404) and malformed ids are 404', async () => {
      const alice = await account('tok-x-alice');
      const bob = await account('tok-x-bob');
      const bobsToken = (await create(bob)).body.data;

      assert.equal((await api('DELETE', tokensUrl(alice.workspaceId, bobsToken.id), undefined, alice.token)).status, 404);
      assert.equal((await api('DELETE', tokensUrl(alice.workspaceId, 'nope'), undefined, alice.token)).status, 404);
      assert.equal((await api('DELETE', tokensUrl(alice.workspaceId, 'A'.repeat(20)), undefined, alice.token)).status, 404);
      const stillActive = (await api('GET', tokensUrl(bob.workspaceId), undefined, bob.token)).body.data.tokens.find((t) => t.id === bobsToken.id);

      assert.equal(stillActive.revoked, false);
      assert.equal((await api('GET', tokensUrl(alice.workspaceId), undefined, alice.token)).body.data.tokens.length, 0, 'lists are workspace-scoped');
    });

    test('the authenticator resolves identity and scope, and refuses every bad credential', async () => {
      const owner = await account('tok-auth-owner');
      const readToken = (await create(owner, { name: 'r', scope: 'read' })).body.data;
      const writeToken = (await create(owner, { name: 'w', scope: 'write' })).body.data;
      const authenticate = createAgentAuthenticator({ store: running.app.store });
      const ownerUserId = (await running.app.store.getUserByEmail(owner.email)).id;
      const expectFail = async (req, status) => {
        await assert.rejects(authenticate(req), (error) => {
          assert.equal(error.status, status);
          assert.ok(error.message);
          assert.ok(!error.message.includes('afmcp_'), 'errors never echo the token');
          return true;
        });
      };

      assert.deepEqual(await authenticate(agentReq(readToken.token)), { tokenId: readToken.id, tokenName: readToken.name, userId: ownerUserId, workspaceId: owner.workspaceId, scope: 'read' });
      assert.equal((await authenticate(agentReq(writeToken.token))).scope, 'write');

      const parsed = parseAgentToken(writeToken.token);
      const flipped = `${parsed.secret.slice(0, -1)}${parsed.secret.endsWith('A') ? 'B' : 'A'}`;

      await expectFail(agentReq(`afmcp_${parsed.id}_${flipped}`), 401);
      await expectFail(agentReq(`afmcp_${parsed.id}_${parsed.secret}extra`), 401);
      await expectFail(agentReq(`afmcp_${parsed.id}_short`), 401);
      await expectFail(agentReq(`afmcp_${'z'.repeat(16)}_${parsed.secret}`), 401);
      await expectFail(agentReq('not-an-agent-token'), 401);
      await expectFail(agentReq(owner.token), 401);
      await expectFail(agentReq(undefined), 401);
      await expectFail({ headers: { authorization: `Basic ${writeToken.token}` } }, 401);
      await expectFail({ headers: { authorization: writeToken.token } }, 401);
      await expectFail({ headers: {}, url: `/mcp?access_token=${writeToken.token}` }, 401);

      await api('DELETE', tokensUrl(owner.workspaceId, readToken.id), undefined, owner.token);
      await expectFail(agentReq(readToken.token), 401);
    });

    test('expired tokens are refused', async () => {
      const owner = await account('tok-exp');
      const token = (await create(owner, { expires_in_days: 1 })).body.data;
      const early = createAgentAuthenticator({ store: running.app.store, now: () => Date.parse(token.created_at) + 3600_000 });
      const late = createAgentAuthenticator({ store: running.app.store, now: () => Date.parse(token.created_at) + 2 * 86400_000 });

      assert.equal((await early(agentReq(token.token))).scope, 'read');
      await assert.rejects(late(agentReq(token.token)), (error) => error.status === 401 && /expired/i.test(error.message));
      const listed = (await api('GET', tokensUrl(owner.workspaceId), undefined, owner.token)).body.data.tokens[0];

      assert.equal(listed.expired, false, 'real time has not passed');
    });

    test('removing the token owner from the workspace disables the token at once, and re-adding never revives a revoked token', async () => {
      const owner = await account('tok-mem-owner');
      const admin = await account('tok-mem-admin');

      assert.equal((await grant(owner, admin, 'admin')).status, 201);
      const keep = (await api('POST', tokensUrl(owner.workspaceId), { name: 'keep', scope: 'write' }, admin.token)).body.data;
      const gone = (await api('POST', tokensUrl(owner.workspaceId), { name: 'gone', scope: 'write' }, admin.token)).body.data;
      const authenticate = createAgentAuthenticator({ store: running.app.store });

      assert.equal((await authenticate(agentReq(keep.token))).workspaceId, owner.workspaceId);
      await api('DELETE', tokensUrl(owner.workspaceId, gone.id), undefined, owner.token);

      assert.equal((await revokeMembership(owner, admin)).status, 200);
      await assert.rejects(authenticate(agentReq(keep.token)), (error) => error.status === 403);
      await assert.rejects(authenticate(agentReq(gone.token)), (error) => error.status === 401, 'revoked reports revoked even without membership');

      assert.equal((await grant(owner, admin, 'member')).status, 201);
      assert.equal((await authenticate(agentReq(keep.token))).userId, (await running.app.store.getUserByEmail(admin.email)).id, 'an untouched token works again for a restored member');
      await assert.rejects(authenticate(agentReq(gone.token)), (error) => error.status === 401, 'a revoked token stays dead');
    });

    test('a token is bound to its own workspace', async () => {
      const alice = await account('tok-ws-alice');
      const bob = await account('tok-ws-bob');
      const token = (await create(alice, { scope: 'write' })).body.data;
      const authenticate = createAgentAuthenticator({ store: running.app.store });
      const identity = await authenticate(agentReq(token.token));

      assert.equal(identity.workspaceId, alice.workspaceId);
      assert.notEqual(identity.workspaceId, bob.workspaceId);
    });

    test('last_used_at updates are throttled to one write per interval', async () => {
      const owner = await account('tok-touch');
      const token = (await create(owner)).body.data;
      const store = running.app.store;
      let clock = Date.parse('2030-01-01T00:00:00Z');
      const authenticate = createAgentAuthenticator({ store, now: () => clock, touchIntervalMs: 60_000 });
      const original = store.touchAgentToken;
      let writes = 0;

      store.touchAgentToken = async (...args) => { writes += 1; return original(...args); };
      try {
        await authenticate(agentReq(token.token));
        await authenticate(agentReq(token.token));
        clock += 30_000;
        await authenticate(agentReq(token.token));
        assert.equal(writes, 1);
        clock += 31_000;
        await authenticate(agentReq(token.token));
        assert.equal(writes, 2);
      } finally {
        store.touchAgentToken = original;
      }
      const listed = (await api('GET', tokensUrl(owner.workspaceId), undefined, owner.token)).body.data.tokens[0];

      assert.equal(listed.last_used_at, '2030-01-01T00:01:01.000Z');
    });

    test('agent tokens never authenticate ordinary REST routes or the WebSocket handshake, and sessions are not agent tokens', async () => {
      const owner = await account('tok-boundary');
      const token = (await create(owner, { scope: 'write' })).body.data.token;

      assert.equal((await api('GET', '/api/user/workspace', undefined, token)).status, 401);
      assert.equal((await api('GET', '/api/auth/me', undefined, token)).status, 401);
      assert.equal((await api('GET', tokensUrl(owner.workspaceId), undefined, token)).status, 401);
      assert.equal((await api('POST', tokensUrl(owner.workspaceId), { name: 'x', scope: 'read' }, token)).status, 401);
      assert.equal((await api('GET', `/api/workspace/${owner.workspaceId}/member`, undefined, token)).status, 401);

      const status = await new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws/v2/${owner.workspaceId}/?clientId=1&deviceId=agent&token=${encodeURIComponent(token)}&cv=0.10.0&cp=web`);

        socket.on('unexpected-response', (_req, response) => { resolve(response.statusCode); socket.terminate(); });
        socket.on('open', () => { resolve('opened'); socket.close(); });
        socket.on('error', () => {});
      });

      assert.equal(status, 401, 'the WebSocket handshake rejects agent tokens');
      await assert.rejects(createAgentAuthenticator({ store: running.app.store })(agentReq(owner.token)), (error) => error.status === 401);
    });

    test('token secrets never reach the API log', async () => {
      const owner = await account('tok-log');
      const issued = (await create(owner, { name: 'logged?' })).body.data;
      const { secret } = parseAgentToken(issued.token);

      // A failing request echoes its body into the log; the token must be scrubbed from it.
      assert.equal((await api('POST', tokensUrl(owner.workspaceId), { name: issued.token, scope: 'nope' }, owner.token)).status, 400);
      assert.equal((await api('GET', '/api/user/workspace', undefined, issued.token)).status, 401);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const log = await readFile(logFile, 'utf8');

      assert.ok(!log.includes(secret), 'the secret is not in the log');
      assert.ok(log.includes('afmcp_[redacted]'), 'the failing request body was logged with the token redacted');
    });
  });
}

defineSuite('json');
defineSuite('postgres');
