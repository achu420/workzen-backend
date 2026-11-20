// Light MCP security behaviour at the protocol layer: authentication results, Origin validation,
// HTTP method handling, body limits, per-token rate limiting, audit records and token secrecy.
// The real token store is a later integration step; authenticate() is a fake with the same contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_TOKEN, WRITE_TOKEN, callModern, legacy, modern, post, startMcp } from './helpers/mcp-test-kit.js';

const ping = () => legacy('ping');

test('authentication failures: 401 with WWW-Authenticate, 403 for a removed member, never echoing the token', async () => {
  const mcp = await startMcp();

  try {
    const missing = await post(mcp.url, ping(), { token: null });

    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate'), /^Bearer/);
    assert.equal(missing.json.error.code, -32001);

    const secrets = ['afmcp_bad_invalidsecret', 'afmcp_x_expiredsecret'];
    const bodies = [];

    for (const token of secrets) {
      const response = await post(mcp.url, ping(), { token });

      assert.equal(response.status, 401, token);
      assert.ok(!response.text.includes(token), `${token} is not echoed back`);
      assert.ok(!JSON.stringify([...response.headers]).includes(token));
      bodies.push(response.text);
    }
    assert.ok(bodies.every((text) => text.includes('[redacted]') || !/afmcp_/.test(text)));

    const noMembership = await post(mcp.url, ping(), { token: 'afmcp_m_nomembership' });

    assert.equal(noMembership.status, 403);
    assert.equal(noMembership.headers.get('www-authenticate'), null);
    assert.match(noMembership.json.error.message, /no longer a member/);

    const nonBearer = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${WRITE_TOKEN}` }, body: JSON.stringify(ping()) });

    assert.equal(nonBearer.status, 401);
    assert.equal(mcp.audit.length, 0, 'authentication failures are not tool calls');
  } finally {
    await mcp.close();
  }
});

test('an authenticator that crashes, or returns a bad identity, is a generic 500', async () => {
  const crashing = await startMcp({ authenticate: () => { throw new Error('db down postgres://u:p@h/x'); } });
  const malformed = await startMcp({ authenticate: () => ({ workspaceId: 'ws-1' }) });

  try {
    for (const server of [crashing, malformed]) {
      const response = await post(server.url, ping());

      assert.equal(response.status, 500);
      assert.equal(response.json.error.message, 'Internal error');
      assert.ok(!response.text.includes('postgres://'));
    }
    assert.ok(crashing.logs.some((line) => line.includes('db down')), 'logged server-side only');
  } finally {
    await crashing.close();
    await malformed.close();
  }
});

test('authentication is checked before the body is read or parsed', async () => {
  const mcp = await startMcp();

  try {
    const response = await post(mcp.url, undefined, { token: null, raw: '{definitely not json' });

    assert.equal(response.status, 401, 'unauthenticated garbage is a 401, not a parse error');
  } finally {
    await mcp.close();
  }
});

test('Origin validation: absent is fine, loopback is fine on a loopback server, others are 403 unless allow-listed', async () => {
  const mcp = await startMcp({ allowedOrigins: ['https://agents.example.com'] });

  try {
    assert.equal((await post(mcp.url, ping())).status, 200, 'no Origin header (CLI and server clients)');
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:5173', 'http://[::1]:8787']) {
      assert.equal((await post(mcp.url, ping(), { headers: { origin } })).status, 200, origin);
    }
    assert.equal((await post(mcp.url, ping(), { headers: { origin: 'https://agents.example.com' } })).status, 200, 'allow-listed');
    for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null', 'not a url']) {
      const response = await post(mcp.url, ping(), { headers: { origin } });

      assert.equal(response.status, 403, origin);
      assert.equal(response.json.id, null);
    }
    const unauthenticatedEvil = await post(mcp.url, ping(), { token: null, headers: { origin: 'https://evil.example' } });

    assert.equal(unauthenticatedEvil.status, 403, 'Origin is checked before authentication');
    const getWithEvil = await fetch(mcp.url, { method: 'GET', headers: { origin: 'https://evil.example' } });

    assert.equal(getWithEvil.status, 403);
  } finally {
    await mcp.close();
  }
});

test('only POST is served: GET, DELETE, PUT, PATCH, HEAD and OPTIONS are 405 with Allow: POST', async () => {
  const mcp = await startMcp();

  try {
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']) {
      const response = await fetch(mcp.url, { method, headers: { authorization: `Bearer ${WRITE_TOKEN}`, accept: 'text/event-stream', 'mcp-session-id': 'abc' } });

      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'POST', method);
      assert.equal(response.headers.get('mcp-session-id'), null, 'session ids are ignored, never echoed');
    }
  } finally {
    await mcp.close();
  }
});

test('oversized bodies are 413, bodies under the limit still work', async () => {
  const mcp = await startMcp({ limits: { maxBodyBytes: 4096 } });

  try {
    const big = await post(mcp.url, legacy('tools/call', { name: 'get_card', arguments: { card_id: 'c-1', pad: 'x'.repeat(20000) } }));

    assert.equal(big.status, 413);
    assert.equal(big.json.error.code, -32600);
    const fine = await post(mcp.url, legacy('tools/call', { name: 'get_card', arguments: { card_id: 'c-1' } }));

    assert.equal(fine.status, 200);
    assert.equal(mcp.cards.calls.filter((entry) => entry.method === 'getCard').length, 1, 'the oversized call never reached the card service');
  } finally {
    await mcp.close();
  }
});

test('per-token rate limit: 429 with Retry-After, other tokens unaffected, the window resets', async () => {
  let clock = 1_000_000;
  const mcp = await startMcp({ limits: { ratePerMinute: 3 }, now: () => clock });

  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await post(mcp.url, ping())).status, 200);
    const limited = await post(mcp.url, legacy('tools/call', { name: 'get_card', arguments: { card_id: 'c-1' } }));

    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after'), /^\d+$/);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1 && Number(limited.headers.get('retry-after')) <= 60);
    assert.equal(mcp.cards.calls.length, 0, 'a limited call never reached the card service');
    const record = mcp.audit.at(-1);

    assert.equal(record.tool, 'get_card');
    assert.equal(record.error_code, 'RATE_LIMITED');
    assert.equal(record.ok, false);

    assert.equal((await post(mcp.url, ping(), { token: READ_TOKEN })).status, 200, 'a different token has its own budget');
    clock += 61_000;
    assert.equal((await post(mcp.url, ping())).status, 200, 'the window reset');
  } finally {
    await mcp.close();
  }
});

test('one audit record per tools/call, with no secrets and no card content', async () => {
  const mcp = await startMcp();

  try {
    await callModern(mcp.url, 'tools/call', { name: 'get_card', arguments: { card_id: 'c-3' } });
    await callModern(mcp.url, 'tools/call', { name: 'list_cards', arguments: { database_id: 'db-1' } });
    await callModern(mcp.url, 'tools/call', { name: 'create_card', arguments: { database_id: 'db-1', title: 'Secret roadmap title', idempotency_key: 'audit-key-123456', fields: { Notes: 'confidential body' } } });
    await callModern(mcp.url, 'tools/call', { name: 'get_card', arguments: {} });
    await callModern(mcp.url, 'tools/call', { name: 'get_card', arguments: { card_id: 'missing' } });
    await callModern(mcp.url, 'tools/call', { name: 'not_a_tool', arguments: {} });
    await callModern(mcp.url, 'tools/call', { name: 'archive_card', arguments: { card_id: 'c-1', confirm: true } }, { token: READ_TOKEN });
    await callModern(mcp.url, 'tools/list', {});
    await post(mcp.url, legacy('ping'));

    assert.equal(mcp.audit.length, 7, 'tools/list and ping are not tool calls');
    const [getOk, listOk, created, invalid, notFound, unknown, forbidden] = mcp.audit;

    assert.deepEqual(Object.keys(getOk).sort(), ['at', 'detail', 'duration_ms', 'error_code', 'ok', 'scope', 'target', 'token_id', 'token_name', 'tool', 'user_id', 'workspace_id']);
    assert.equal(getOk.tool, 'get_card');
    assert.equal(getOk.target, 'c-3');
    assert.equal(getOk.ok, true);
    assert.equal(getOk.error_code, null);
    assert.equal(getOk.token_id, 'tok-write');
    assert.equal(getOk.user_id, 'user-1');
    assert.equal(getOk.workspace_id, 'ws-1');
    assert.ok(Number.isFinite(getOk.duration_ms) && getOk.duration_ms >= 0);
    assert.match(getOk.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(listOk.target, 'db-1');
    assert.equal(created.tool, 'create_card');
    assert.match(created.target, /^c-\d+$/, 'create reports the new card id as its target');
    assert.deepEqual([invalid.ok, invalid.error_code], [false, 'INVALID_INPUT']);
    assert.deepEqual([notFound.ok, notFound.error_code, notFound.target], [false, 'NOT_FOUND', 'missing']);
    assert.deepEqual([unknown.ok, unknown.error_code, unknown.tool], [false, 'UNKNOWN_TOOL', 'not_a_tool']);
    assert.deepEqual([forbidden.ok, forbidden.error_code, forbidden.token_id], [false, 'FORBIDDEN', 'tok-read']);

    // `detail` (target title, summary, undo) is what the activity trail stores for people to read, on purpose; the
    // request log line never carries it (see server.js). Everything else in a record stays free of content and secrets.
    assert.match(created.detail.summary, /Secret roadmap title/);
    assert.ok(!JSON.stringify(created.detail).includes('confidential'), 'field values are never part of the detail');
    const serialized = JSON.stringify(mcp.audit.map(({ detail, ...rest }) => rest));

    for (const secret of [WRITE_TOKEN, READ_TOKEN, 'afmcp_', 'Secret roadmap', 'confidential', 'Ignore previous instructions', 'audit-key-123456']) {
      assert.ok(!serialized.includes(secret), `audit contains no ${secret}`);
    }
  } finally {
    await mcp.close();
  }
});

test('a failing audit sink never breaks the response', async () => {
  const mcp = await startMcp();
  const original = mcp.audit.push.bind(mcp.audit);

  mcp.audit.push = (...args) => { original(...args); throw new Error('sink offline'); };
  try {
    const response = await callModern(mcp.url, 'tools/call', { name: 'get_card', arguments: { card_id: 'c-1' } });

    assert.equal(response.status, 200);
    assert.equal(response.json.result.isError, false);
    assert.ok(mcp.logs.some((line) => line.includes('audit sink failed')), 'the sink failure is logged');
  } finally {
    await mcp.close();
  }
});

test('no response ever contains the bearer token, across profiles and error paths', async () => {
  const mcp = await startMcp();

  try {
    const { body, headers } = modern('tools/call', { name: 'get_card', arguments: { card_id: 'c-1' } }, 1);
    const responses = [
      await post(mcp.url, body, { headers }),
      await post(mcp.url, legacy('tools/list')),
      await post(mcp.url, undefined, { raw: '{bad' }),
      await post(mcp.url, body, { headers: { ...headers, 'mcp-method': 'ping' } }),
      await callModern(mcp.url, 'tools/call', { name: 'update_card', arguments: { card_id: 'c-1', title: 'boom' } }),
      await callModern(mcp.url, 'resources/list', {}),
    ];

    for (const response of responses) {
      assert.ok(!response.text.includes(WRITE_TOKEN));
      assert.ok(!JSON.stringify([...response.headers]).includes(WRITE_TOKEN));
    }
    assert.ok(mcp.logs.every((line) => !line.includes(WRITE_TOKEN)), 'logs never contain the token');
  } finally {
    await mcp.close();
  }
});

test('createMcpHandler requires its dependencies', async () => {
  const { createMcpHandler } = await import('../mcp.js');

  assert.throws(() => createMcpHandler({}), /cards, authenticate/);
  assert.throws(() => createMcpHandler({ cards: {} }), /cards, authenticate/);
});
