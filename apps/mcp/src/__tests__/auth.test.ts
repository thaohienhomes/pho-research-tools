/**
 * Optional sign-in with a Phở account: the 401 challenge and RFC 9728
 * metadata a client needs to run OAuth, and the larger monthly allowance a
 * verified token buys. Clerk is replaced by a fake token checker.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HttpClient } from '@pho/scholar-core';
import { describe, expect, it, vi } from 'vitest';
import { createRecordingAnalytics } from '../analytics';
import { createApp } from '../app';
import { createClerkVerifier, type TokenCheck, type TokenVerifier } from '../auth';
import { loadConfig } from '../config';
import { createMemoryUsageStore } from '../storage';
import { openCassette } from '../../../../packages/scholar-core/test/support/cassette';

const CORE = join(__dirname, '..', '..', '..', '..', 'packages', 'scholar-core');
const cassette = openCassette(join(CORE, 'test', 'fixtures', 'cassettes'));
const recorded: HttpClient = (req) => cassette.http(req);
const fixtures = JSON.parse(readFileSync(join(CORE, 'test', 'fixtures', 'references.json'), 'utf8')) as {
  id: string;
  input: string;
}[];
const REF = fixtures.find((r) => r.id === 'correct-01')!.input;

const ISSUER = 'https://clerk.example';
const TOKENS: Record<string, TokenCheck> = {
  'tok-alice': { kind: 'valid', user: { userId: 'user_alice' } },
  'tok-bob': { kind: 'valid', user: { userId: 'user_bob' } },
  'tok-revoked': { kind: 'invalid' },
  'tok-clerk-down': { kind: 'unavailable' },
};
const fakeVerifier: TokenVerifier = async (t) => TOKENS[t] ?? { kind: 'invalid' };

function setup(env: Record<string, string> = {}, now = () => new Date('2026-10-06T10:00:00Z')) {
  const app = createApp({
    config: loadConfig({ PUBLIC_URL: 'https://tools.test', TRUST_PROXY: '1', OAUTH_ISSUER: ISSUER, ...env }),
    http: recorded,
    usage: createMemoryUsageStore(),
    analytics: createRecordingAnalytics(),
    verifyToken: fakeVerifier,
    now,
  });
  async function connect(opts: { path?: string; token?: string; ip?: string } = {}) {
    const headers: Record<string, string> = { 'user-agent': 'claude-ai/1.0', 'x-forwarded-for': opts.ip ?? '1.2.3.4' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`https://tools.test${opts.path ?? '/mcp'}`), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: { headers },
    });
    await client.connect(transport);
    return client;
  }
  return { app, connect };
}

const verify = (client: Client) =>
  client.callTool({ name: 'verify_references', arguments: { references: REF } }) as Promise<CallToolResult>;
const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
});
const post = (app: ReturnType<typeof setup>['app'], path: string, token?: string) =>
  app.request(`https://tools.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: initialize,
  });

describe('sign-in discovery', () => {
  it('challenges /mcp/login with a pointer to the resource metadata', async () => {
    const { app } = setup();
    const res = await post(app, '/mcp/login');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://tools.test/.well-known/oauth-protected-resource/mcp/login", scope="profile email"',
    );
    // A client that probes with GET sees the same challenge.
    expect((await app.request('https://tools.test/mcp/login')).status).toBe(401);
  });

  it('publishes RFC 9728 metadata naming Clerk as the authorization server', async () => {
    const { app } = setup();
    for (const path of ['/.well-known/oauth-protected-resource/mcp/login', '/.well-known/oauth-protected-resource']) {
      const meta = (await (await app.request(`https://tools.test${path}`)).json()) as Record<string, unknown>;
      expect(meta).toMatchObject({
        resource: 'https://tools.test/mcp/login',
        authorization_servers: [ISSUER],
        bearer_methods_supported: ['header'],
      });
    }
    const plain = (await (await app.request('https://tools.test/.well-known/oauth-protected-resource/mcp')).json()) as {
      resource: string;
    };
    expect(plain.resource).toBe('https://tools.test/mcp');
  });

  it('keeps /mcp open to anonymous callers', async () => {
    const { app } = setup();
    expect((await post(app, '/mcp')).status).toBe(200);
  });

  it('answers a rejected token with 401 so the client signs in again', async () => {
    const { app } = setup();
    const res = await post(app, '/mcp', 'tok-revoked');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer error="invalid_token", resource_metadata="https:\/\/tools\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
    expect((await post(app, '/mcp/login', 'tok-revoked')).status).toBe(401);
  });

  it('has no sign-in surface when OAUTH_ISSUER is unset', async () => {
    const { app } = setup({ OAUTH_ISSUER: '' });
    expect((await post(app, '/mcp/login')).status).toBe(404);
    expect((await app.request('https://tools.test/.well-known/oauth-protected-resource')).status).toBe(404);
    // A stray token is ignored rather than rejected.
    expect((await post(app, '/mcp', 'tok-revoked')).status).toBe(200);
    expect(((await (await app.request('https://tools.test/health')).json()) as { sign_in: boolean }).sign_in).toBe(false);
  });
});

describe('signed-in allowance', () => {
  it('gives a Phở account the monthly allowance, wherever it connects from', async () => {
    const { connect } = setup({ QUOTA_USER_VERIFICATIONS_PER_MONTH: '2', QUOTA_ANON_VERIFICATIONS_PER_DAY: '1' });
    const home = await connect({ path: '/mcp/login', token: 'tok-alice', ip: '1.1.1.1' });
    const first = await verify(home);
    expect(first.isError).toBeFalsy();
    expect((first.structuredContent as { quota: unknown }).quota).toEqual({
      plan: 'free',
      metric: 'verifications',
      used: 1,
      limit: 2,
      resets: '2026-11-01T00:00:00.000Z',
    });
    // The model reads text, not structuredContent: the allowance must be in it.
    expect(text(first)).toContain('Phở account allowance: 1/2 reference checks used this month, 1 left; resets 2026-11-01T00:00:00.000Z.');
    const retraction = (await (await connect({ token: 'tok-bob' })).callTool({ name: 'check_retractions', arguments: { dois: ['10.1056/NEJMoa2034577'] } })) as CallToolResult;
    expect(text(retraction)).toContain('Phở account allowance: 1/2 reference checks used this month, 1 left;');

    // Same account from another network: the same counter.
    const office = await connect({ path: '/mcp', token: 'tok-alice', ip: '2.2.2.2' });
    expect((await verify(office)).isError).toBeFalsy();
    const over = await verify(office);
    expect(over.isError).toBe(true);
    expect(text(over)).toMatch(/Phở account has used its free monthly allowance of 2 reference checks/);
    expect(text(over)).not.toMatch(/sign in/i);

    // Another account, and anonymous use from the first network, are untouched.
    expect((await verify(await connect({ token: 'tok-bob', ip: '1.1.1.1' }))).isError).toBeFalsy();
    expect((await verify(await connect({ ip: '1.1.1.1' }))).isError).toBeFalsy();
  });

  it('tells an anonymous caller who ran out how to sign in', async () => {
    const { connect } = setup({ QUOTA_ANON_VERIFICATIONS_PER_DAY: '1' });
    const client = await connect();
    const first = await verify(client);
    expect(text(first)).toContain('Anonymous allowance: 1/1 reference checks used today, 0 left;');
    const over = await verify(client);
    expect(over.isError).toBe(true);
    expect(text(over)).toContain('https://tools.test/mcp/login');
    expect(text(over)).toMatch(/300 reference checks a month/);
  });

  it('serves the call as anonymous when Clerk cannot be reached', async () => {
    const { connect } = setup();
    const r = await verify(await connect({ token: 'tok-clerk-down' }));
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { quota: { plan: string } }).quota.plan).toBe('anon');
  });
});

describe('Clerk token check', () => {
  const response = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('accepts a token userinfo accepts, and asks Clerk once per token', async () => {
    const fetchImpl = vi.fn(async () => response(200, { object: 'oauth_user_info', user_id: 'user_1', sub: 'user_1' }));
    const check = createClerkVerifier(ISSUER, fetchImpl as unknown as typeof fetch);
    expect(await check('t')).toEqual({ kind: 'valid', user: { userId: 'user_1' } });
    expect(await check('t')).toEqual({ kind: 'valid', user: { userId: 'user_1' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://clerk.example/oauth/userinfo');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
  });

  it('tells a rejected token from an unreachable Clerk', async () => {
    expect(await createClerkVerifier(ISSUER, (async () => response(401)) as unknown as typeof fetch)('t')).toEqual({ kind: 'invalid' });
    expect(await createClerkVerifier(ISSUER, (async () => response(200, {})) as unknown as typeof fetch)('t')).toEqual({ kind: 'invalid' });
    expect(await createClerkVerifier(ISSUER, (async () => response(503)) as unknown as typeof fetch)('t')).toEqual({ kind: 'unavailable' });
    const throwing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(await createClerkVerifier(ISSUER, throwing)('t')).toEqual({ kind: 'unavailable' });
  });

  it('does not cache a rejection', async () => {
    let status = 401;
    const fetchImpl = vi.fn(async () => (status === 401 ? response(401) : response(200, { user_id: 'user_1' })));
    const check = createClerkVerifier(ISSUER, fetchImpl as unknown as typeof fetch);
    expect((await check('t')).kind).toBe('invalid');
    status = 200;
    expect((await check('t')).kind).toBe('valid');
  });
});
