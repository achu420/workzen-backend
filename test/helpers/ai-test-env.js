import assert from 'node:assert/strict';
import { KEYS } from './fake-ai-provider.js';

export function createApi(getBase) {
  return async function api(method, route, payload, token, headers = {}) {
    const response = await fetch(`${getBase()}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
}

export async function account(api, label) {
  const email = `${label}@example.test`;

  assert.equal((await api('POST', '/api/auth/register', { email, password: 'Correct horse 456' })).status, 201);
  const token = (await api('POST', '/api/auth/login', { email, password: 'Correct horse 456' })).body.access_token;
  const workspaceId = (await api('GET', '/api/user/workspace', undefined, token)).body.data.visiting_workspace.workspace_id;

  return { email, token, workspaceId };
}

// Adds `member` to `owner`'s workspace through the invite-code flow.
export async function addMember(api, owner, member) {
  const { code } = (await api('POST', `/api/workspace/${owner.workspaceId}/invite-code`, {}, owner.token)).body.data;

  assert.equal((await api('POST', '/api/workspace/join-by-invite-code', { code }, member.token)).status, 200);
}

export const aiSettingsUrl = (workspaceId, sub = '') => `/api/workspace/${workspaceId}/ai-settings${sub}`;

export async function configureAi(api, owner, provider = 'openai', extra = {}) {
  const response = await api('PUT', aiSettingsUrl(owner.workspaceId), { provider, api_key: KEYS[provider], ...extra }, owner.token);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data;
}

// Calls a streaming route and returns the status, headers and the parsed line-delimited frames.
export async function rawStream(base, route, payload, token, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const frames = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));

  return { status: response.status, headers: response.headers, text, frames, joined: frames.map((frame) => frame['1'] ?? '').join('') };
}
