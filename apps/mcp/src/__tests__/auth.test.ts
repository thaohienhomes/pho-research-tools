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
  'tok-carol': { kind: 'valid', user: { userId: 'user_carol' } },
  'tok-dave': { kind: 'valid', user: { userId: 'user_dave' } },
  'tok-revoked': { kind: 'invalid' },
  'tok-clerk-down': { kind: 'unavailable' },
};
const fakeVerifier: TokenVerifier = async (t) => TOKENS[t] ?? { kind: 'invalid' };

const PAID: Record<string, boolean | undefined> = { user_carol: true, user_dave: undefined };
const fakePaidPlan = async (userId: string) => (userId in PAID ? PAID[userId] : false);

function setup(env: Record<string, string> = {}, now = () => new Date('2026-10-06T10:00:00Z')) {
  const analytics = createRecordingAnalytics();
  const app = createApp({
    paidPlan: fakePaidPlan,
    config: loadConfig({ PUBLIC_URL: 'https://tools.test', TRUST_PROXY: '1', OAUTH_ISSUER: ISSUER, ...env }),
    http: recorded,
    usage: createMemoryUsageStore(),
    analytics,
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
  return { app, connect, analytics };
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
    expect(text(over)).toMatch(/free Phở account has used its monthly allowance of 2 reference checks/);
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
    // Running low already says how to get more, before a list comes back half-checked.
    expect(text(first)).toContain('https://tools.test/mcp/login');
    expect(text(first)).toContain('https://pho.chat/tools/mcp/?utm_source=research-tools&utm_medium=mcp&utm_campaign=sign-in#sign-in');
    const over = await verify(client);
    expect(over.isError).toBe(true);
    expect(text(over)).toContain('https://tools.test/mcp/login');
    expect(text(over)).toContain('https://pho.chat/tools/mcp/?utm_source=research-tools&utm_medium=mcp&utm_campaign=sign-in#sign-in');
    expect(text(over)).toMatch(/1000 reference checks a month at no cost/);
    expect(text(over)).toMatch(/Phở Pro or Founder Lifetime includes 3000 reference checks a month/);
  });

  const toolCall = (app: ReturnType<typeof setup>['app'], name: string, args: Record<string, unknown>, ua = 'claude-ai/1.0') =>
    app.request('https://tools.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'user-agent': ua,
        'x-forwarded-for': '1.2.3.4',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }),
    });

  it('asks a listed client to sign in on the same connector once the anonymous allowance is gone', async () => {
    const { app, connect } = setup({ QUOTA_ANON_VERIFICATIONS_PER_DAY: '1', SIGN_IN_ON_ANON_LIMIT: 'claude' });
    const client = await connect();
    // While checks are left, nothing changes.
    expect((await verify(client)).isError).toBeFalsy();

    const res = await toolCall(app, 'verify_references', { references: REF });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://tools.test/.well-known/oauth-protected-resource/mcp", scope="profile email"',
    );
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Sign in with a free Phở account to keep going: 1000 reference checks/);

    // Tools that do not spend reference checks keep working anonymously.
    const diagram = await toolCall(app, 'prisma_flow_diagram', { counts: { records_identified_databases: 10, studies_included: 2 } });
    expect(diagram.status).toBe(200);

    // After sign-in the client retries the same address with a token, and the call goes through.
    const signedIn = await connect({ token: 'tok-alice' });
    expect((await verify(signedIn)).isError).toBeFalsy();
  });

  it('ignores tool names this server does not have, so they never reach analytics', async () => {
    const { app, connect, analytics } = setup({ QUOTA_ANON_CALLS_PER_DAY: '1', SIGN_IN_ON_ANON_LIMIT: 'claude' });
    await verify(await connect());
    const res = await toolCall(app, 'not_a_tool_<script>', {});
    expect(res.status).toBe(200);
    expect(analytics.events.some((e) => e.tool_name === 'not_a_tool_<script>')).toBe(false);
    // A real tool past the allowance still gets the sign-in challenge.
    expect((await toolCall(app, 'search_papers', { query: 'x' })).status).toBe(401);
  });

  it('keeps the quota message for clients that are not listed, and when the switch is off', async () => {
    for (const [env, ua] of [
      [{ SIGN_IN_ON_ANON_LIMIT: 'claude' }, 'openai-mcp/1.0'],
      [{}, 'claude-ai/1.0'],
    ] as const) {
      const { app, connect } = setup({ QUOTA_ANON_VERIFICATIONS_PER_DAY: '1', ...env });
      await verify(await connect());
      const res = await toolCall(app, 'verify_references', { references: REF }, ua);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('used up');
    }
  });

  it('gives a paid Phở account the Pro allowance', async () => {
    const { connect } = setup({ QUOTA_PRO_VERIFICATIONS_PER_MONTH: '2', QUOTA_USER_VERIFICATIONS_PER_MONTH: '1' });
    const client = await connect({ token: 'tok-carol' });
    const first = await verify(client);
    expect((first.structuredContent as { quota: unknown }).quota).toEqual({
      plan: 'pro',
      metric: 'verifications',
      used: 1,
      limit: 2,
      resets: '2026-11-01T00:00:00.000Z',
    });
    expect(text(first)).toContain('Phở Pro allowance: 1/2 reference checks used this month, 1 left;');
    expect((await verify(client)).isError).toBeFalsy();
    const over = await verify(client);
    expect(over.isError).toBe(true);
    expect(text(over)).toMatch(/Phở Pro account has used its monthly allowance of 2 reference checks/);
    expect(text(over)).not.toMatch(/Founder Lifetime/);
  });

  it('tells a free account that ran out what Pro includes', async () => {
    const { connect } = setup({ QUOTA_USER_VERIFICATIONS_PER_MONTH: '1' });
    const client = await connect({ token: 'tok-alice' });
    await verify(client);
    const over = await verify(client);
    expect(text(over)).toMatch(/free Phở account has used its monthly allowance of 1 reference checks/);
    expect(text(over)).toMatch(/includes 3000 reference checks a month: https:\/\/pho\.chat\/pricing\?utm_source=research-tools&utm_medium=mcp&utm_campaign=limit-reached\. /);
  });

  it('names the next plan up once 80% of the allowance is used, and not before', async () => {
    const { connect } = setup({ QUOTA_ANON_VERIFICATIONS_PER_DAY: '10', QUOTA_USER_VERIFICATIONS_PER_MONTH: '5', QUOTA_PRO_VERIFICATIONS_PER_MONTH: '5' });
    const quotaOf = (r: CallToolResult) => (r.structuredContent as { quota: { used: number; upgrade?: string } }).quota;

    // Anonymous: the first call of the day introduces the free account once,
    // then the sign-in hint returns with 5 checks left (before 80% here).
    const anon = await connect();
    const intro = await verify(anon);
    expect(quotaOf(intro)).toMatchObject({ used: 1, hint: 'intro', upgrade: expect.stringContaining('https://tools.test/mcp/login') });
    expect(text(intro)).toMatch(/1\/10 reference checks used today, 9 left; resets [^ ]+ Tip: To get 5 reference checks a month/);
    expect(text(intro)).toContain('utm_campaign=sign-in-intro#sign-in');
    expect(text(intro)).not.toMatch(/Running low/);
    for (let i = 0; i < 3; i++) expect(quotaOf(await verify(anon)).upgrade).toBeUndefined();
    const anonLow = await verify(anon);
    expect(quotaOf(anonLow)).toMatchObject({ used: 5, hint: 'low', upgrade: expect.stringContaining('https://tools.test/mcp/login') });
    expect(text(anonLow)).toContain('5/10 reference checks used today, 5 left;');
    expect(text(anonLow)).toMatch(/Running low\. To get 5 reference checks a month, tell the user they can sign in/);

    const free = await connect({ token: 'tok-alice' });
    for (let i = 0; i < 3; i++) await verify(free);
    expect(text(await verify(free))).toMatch(/Running low\. Phở Pro or Founder Lifetime includes 5 reference checks a month: https:\/\/pho\.chat\/pricing\?utm_source=research-tools&utm_medium=mcp&utm_campaign=running-low\./);

    const pro = await connect({ token: 'tok-carol' });
    for (let i = 0; i < 3; i++) await verify(pro);
    const proLow = await verify(pro);
    expect(quotaOf(proLow).upgrade).toBeUndefined();
    expect(text(proLow)).not.toMatch(/Running low/);
  });

  it('keeps the free allowance when the plan cannot be read', async () => {
    const { connect } = setup();
    const r = await verify(await connect({ token: 'tok-dave' }));
    expect((r.structuredContent as { quota: { plan: string; limit: number } }).quota).toMatchObject({ plan: 'free', limit: 1000 });
  });

  it('mentions the free account once a day, then stays quiet while plenty of checks are left', async () => {
    const { connect } = setup({ QUOTA_ANON_VERIFICATIONS_PER_DAY: '30' });
    const client = await connect();
    const first = await verify(client);
    expect(text(first)).toContain('Anonymous allowance: 1/30 reference checks used today, 29 left;');
    expect(text(first)).toMatch(/Tip: To get 1000 reference checks a month, tell the user they can sign in/);
    const second = await verify(client);
    expect(text(second)).toContain('2/30 reference checks used today, 28 left;');
    expect(text(second)).not.toMatch(/sign in/i);
  });

  it('tells a caller whose list ran past the allowance how to sign in', async () => {
    const { connect } = setup({ QUOTA_ANON_VERIFICATIONS_PER_DAY: '1' });
    const r = (await (await connect()).callTool({
      name: 'verify_references',
      arguments: { references: '10.1056/NEJMoa2034577\n10.1038/nature14539' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/1 not checked \(allowance used up\)/);
    expect(text(r)).toContain('https://tools.test/mcp/login');
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
