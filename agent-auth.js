import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Agent (MCP) tokens look like `afmcp_<id>_<secret>`: the id locates the record, only
// sha256(secret) is stored, and the comparison is constant time. These tokens are
// accepted ONLY by authenticateAgentRequest (the /mcp endpoint); they are not sessions,
// so requireUser/currentUser and the WebSocket handshake never accept them.
export const AGENT_TOKEN_PREFIX = 'afmcp_';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_PATTERN = /^afmcp_([a-z0-9]{12,40})_([A-Za-z0-9_-]{43})$/;
export const AGENT_TOKEN_ID_PATTERN = /^[a-z0-9]{12,40}$/;

export const hashAgentSecret = (secret) => createHash('sha256').update(secret).digest('hex');

export function generateAgentToken() {
  const idBytes = randomBytes(16);
  const id = Array.from(idBytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
  const secret = randomBytes(32).toString('base64url');

  return { id, secret, token: `${AGENT_TOKEN_PREFIX}${id}_${secret}`, hash: hashAgentSecret(secret) };
}

export function parseAgentToken(value) {
  const match = typeof value === 'string' ? TOKEN_PATTERN.exec(value) : null;

  return match ? { id: match[1], secret: match[2] } : null;
}

// Compares fixed-length digests in constant time. Never throws for any input.
export function secretMatches(secret, storedHashHex) {
  const actual = createHash('sha256').update(String(secret)).digest();
  let wanted;

  try { wanted = Buffer.from(String(storedHashHex), 'hex'); } catch { wanted = Buffer.alloc(0); }
  if (wanted.length !== actual.length) wanted = Buffer.alloc(actual.length);
  return timingSafeEqual(actual, wanted) && String(storedHashHex).length === actual.length * 2;
}

function authError(status, message) {
  return Object.assign(new Error(message), { status });
}

const UNKNOWN_HASH = hashAgentSecret('unknown-token-padding');

export function createAgentAuthenticator({ store, now = () => Date.now(), touchIntervalMs = 60_000 } = {}) {
  const lastTouched = new Map();

  // Resolves {tokenId, userId, workspaceId, scope} or throws an Error with .status 401 | 403.
  return async function authenticateAgentRequest(req) {
    const header = req.headers?.authorization;
    const bearerToken = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!bearerToken) throw authError(401, 'An agent token is required in the Authorization header (Bearer scheme)');
    const parsed = parseAgentToken(bearerToken);

    if (!parsed) throw authError(401, 'Invalid agent token');
    const record = await store.getAgentToken(parsed.id);
    const matches = secretMatches(parsed.secret, record?.token_hash ?? UNKNOWN_HASH);

    if (!record || !matches) throw authError(401, 'Invalid agent token');
    if (record.revoked) throw authError(401, 'This agent token has been revoked');
    if (record.expires_at && Date.parse(record.expires_at) <= now()) throw authError(401, 'This agent token has expired');
    // Membership is checked on every call, so removing a member immediately disables their tokens.
    if (!(await store.getMembership(record.workspace_id, record.user_id))) {
      throw authError(403, 'The token owner no longer has access to this workspace');
    }
    const at = now();

    if (at - (lastTouched.get(record.id) ?? 0) >= touchIntervalMs) {
      lastTouched.set(record.id, at);
      try { await store.touchAgentToken(record.id, new Date(at).toISOString()); } catch { /* usage tracking must never fail a request */ }
    }
    return { tokenId: record.id, tokenName: record.name, userId: record.user_id, workspaceId: record.workspace_id, scope: record.scope };
  };
}
