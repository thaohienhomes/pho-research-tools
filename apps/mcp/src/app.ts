/**
 * HTTP surface:
 *   POST /mcp                      MCP Streamable HTTP endpoint (stateless, JSON responses).
 *                                  Anonymous; an optional Phở bearer token raises the allowance.
 *   POST /mcp/login                The same tools, but sign-in required: answers 401 until the
 *                                  client has run OAuth against Clerk (only with OAUTH_ISSUER).
 *   GET  /.well-known/oauth-protected-resource[/mcp|/mcp/login]  RFC 9728 metadata
 *   GET  /.well-known/oauth-authorization-server                 Clerk's metadata, for older clients
 *   GET  /prisma/<payload>.png|svg rendered PRISMA diagrams (counts encoded in the URL)
 *   GET  /brief/<token>            a shared Research Data Brief (signed payload in the URL)
 *   GET  /brief/<token>/og.png     its social preview image
 *   POST /brief/event              page interactions (copy citation, share…) for analytics
 *   GET  /health                   liveness
 *   GET  /                         what this is and how to connect
 */

import { randomBytes } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createFetchHttp, createMemoryCache, withCache, type HttpClient, type ScholarCache } from '@pho/scholar-core';
import { svgToPng } from '@pho/scholar-core/png';
import { prismaFlowDiagram } from '@pho/scholar-core';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { decodeBrief } from './brief-link';
import { renderBriefHtml, renderBriefOgSvg } from './brief-page';
import { createPosthogAnalytics, noopAnalytics, runInBackground, type Analytics } from './analytics';
import {
  bearerToken,
  createClerkVerifier,
  protectedResourceMetadata,
  wwwAuthenticate,
  type TokenVerifier,
} from './auth';
import { identifyCaller, signedInCaller, type Caller } from './caller';
import type { Config } from './config';
import type { ToolContext } from './context';
import { decodePrismaPayload } from './prisma-link';
import { SERVER_NAME, SERVER_VERSION, buildMcpServer } from './server';
import { createMemoryUsageStore, createPgStorage, utcDay, type PaidPlanLookup, type UsageStore } from './storage';
import { prismaPayloadSchema } from './tools/prisma-flow-diagram';

export interface AppDeps {
  config: Config;
  /** Raw network client; wrapped with the cache here. Tests pass a recorded one. */
  http?: HttpClient;
  usage?: UsageStore;
  cache?: ScholarCache;
  analytics?: Analytics;
  /** Checks a Phở bearer token. Defaults to Clerk's userinfo endpoint at OAUTH_ISSUER. */
  verifyToken?: TokenVerifier;
  /** Tells whether a signed-in account is on a paid plan. Defaults to `users.tier` in Postgres. */
  paidPlan?: PaidPlanLookup;
  /** Peer address when not behind a trusted proxy. */
  socketIp?: (c: Context) => string | undefined;
  now?: () => Date;
}

/** Crossref work records carry retraction notices, which can appear any day. */
const ONE_DAY = 24 * 60 * 60;
const THIRTY_DAYS = 30 * ONE_DAY;
/** Dataset searches change as repositories add records; a day keeps briefs fresh. */
const DAILY = [
  /api\.crossref\.org\/works\/10\./,
  /huggingface\.co\/api\//,
  /huggingscience\.co\//,
  /api\.datacite\.org\//,
  /eutils\.ncbi\.nlm\.nih\.gov\/entrez\/eutils\/e(search|summary)\.fcgi\?db=gds/,
  /api\.cellxgene\.cziscience\.com\//,
  /graphql\.cryoetdataportal\.czscience\.com\//,
];
export function cacheTtl(url: string): number {
  return DAILY.some((re) => re.test(url)) ? ONE_DAY : THIRTY_DAYS;
}

/**
 * Every tool this server registers. The sign-in check only reacts to these,
 * so a made-up tool name never reaches analytics: it gets the normal MCP error.
 * mcp.test.ts checks this matches tools/list.
 */
export const TOOL_NAMES: ReadonlySet<string> = new Set([
  'check_retractions',
  'find_datasets',
  'find_evidence',
  'find_tools',
  'format_citations',
  'prisma_flow_diagram',
  'screening_log',
  'search_papers',
  'verify_references',
]);

/** Tools that spend the reference-check allowance, so they stop when it runs out. */
const VERIFICATION_TOOLS = new Set(['verify_references', 'check_retractions', 'find_datasets', 'find_tools']);

const BRIEF_EVENTS = new Set(['citation_copied', 'snippet_copied', 'snippet_opened', 'share_clicked', 'cta_clicked']);
const BRIEF_CHANNELS = new Set(['link', 'x']);

export function createApp(deps: AppDeps): Hono {
  const { config } = deps;
  const pg = config.databaseUrl ? createPgStorage(config.databaseUrl) : undefined;
  const usage = deps.usage ?? pg?.usage ?? createMemoryUsageStore();
  const cache = deps.cache ?? pg?.cache ?? createMemoryCache();
  const paidPlan = deps.paidPlan ?? pg?.paidPlan;
  const http = withCache(deps.http ?? createFetchHttp({ contactEmail: config.contactEmail }), cache, cacheTtl);
  const analytics =
    deps.analytics ??
    (config.posthogApiKey ? createPosthogAnalytics(config.posthogApiKey, config.posthogHost) : noopAnalytics);

  const issuer = config.oauthIssuer;
  const verifyToken = issuer ? (deps.verifyToken ?? createClerkVerifier(issuer)) : undefined;

  const app = new Hono();

  const mcpCors = cors({
    origin: '*',
    allowMethods: ['POST', 'GET', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'content-type',
      'accept',
      'authorization',
      'mcp-protocol-version',
      'mcp-session-id',
      'last-event-id',
      'x-pho-client',
    ],
    exposeHeaders: ['mcp-session-id', 'mcp-protocol-version', 'www-authenticate'],
  });
  app.use('/mcp', mcpCors);
  app.use('/mcp/*', mcpCors);
  app.use('/.well-known/*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'] }));

  // Links this server hands out (MCP endpoint, PRISMA images) use PUBLIC_URL.
  // Without it, the host is the one the request was routed by. It is never
  // taken from X-Forwarded-Host, which a client can set to any domain.
  function baseUrl(c: Context): string {
    if (config.publicUrl) return config.publicUrl;
    const url = new URL(c.req.url);
    if (config.trustProxy) {
      const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
      if (proto === 'http' || proto === 'https') url.protocol = `${proto}:`;
    }
    return url.origin;
  }

  app.get('/', (c) =>
    c.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      description:
        'Phở Research Tools: verify references, format citations, search papers, check retractions, draw PRISMA 2020 diagrams.',
      mcp_endpoint: `${baseUrl(c)}/mcp`,
      ...(issuer ? { mcp_endpoint_signed_in: `${baseUrl(c)}/mcp/login` } : {}),
      transport: 'streamable-http',
      docs: 'https://pho.chat/tools/mcp/',
    }),
  );

  app.get('/health', (c) => c.json({ ok: true, storage: pg ? 'postgres' : 'memory', sign_in: Boolean(issuer) }));

  // RFC 9728 metadata. A client that found no WWW-Authenticate header looks at
  // the bare path, so that one describes the sign-in endpoint too.
  if (issuer) {
    app.get('/.well-known/oauth-protected-resource', (c) =>
      c.json(protectedResourceMetadata(baseUrl(c), '/mcp/login', issuer)),
    );
    app.get('/.well-known/oauth-protected-resource/mcp/login', (c) =>
      c.json(protectedResourceMetadata(baseUrl(c), '/mcp/login', issuer)),
    );
    app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
      c.json(protectedResourceMetadata(baseUrl(c), '/mcp', issuer)),
    );

    // Clients on the 2025-03-26 MCP auth spec ask the resource server itself
    // for authorization-server metadata. Hand them Clerk's, unchanged.
    let asMetadata: { body: unknown; until: number } | undefined;
    app.get('/.well-known/oauth-authorization-server', async (c) => {
      if (!asMetadata || asMetadata.until < Date.now()) {
        try {
          const res = await fetch(`${issuer}/.well-known/oauth-authorization-server`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          asMetadata = { body: await res.json(), until: Date.now() + 60 * 60 * 1000 };
        } catch (err) {
          console.error('[mcp] could not fetch authorization server metadata', err);
          return c.json({ error: 'Authorization server metadata unavailable' }, 502);
        }
      }
      return c.json(asMetadata.body as Record<string, unknown>);
    });
  }

  /**
   * Who is calling. A valid token makes the caller a Phở account; a token the
   * authorization server rejects is a 401 (MCP auth spec), so the client signs
   * in again. If Clerk cannot be reached, the call goes ahead as anonymous
   * rather than failing.
   */
  async function resolveCaller(c: Context, path: string): Promise<Caller | Response> {
    const anon = identifyCaller(c.req.raw.headers, {
      salt: config.quotaSalt,
      trustProxy: config.trustProxy,
      socketIp: deps.socketIp?.(c),
    });
    const token = bearerToken(c.req.raw.headers);
    const mustSignIn = path === '/mcp/login';
    if (!token || !verifyToken) {
      if (mustSignIn) return unauthorized(c, path);
      return anon;
    }
    const check = await verifyToken(token);
    if (check.kind === 'valid') {
      const paid = (await paidPlan?.(check.user.userId)) ?? false;
      return signedInCaller(anon, check.user.userId, config.quotaSalt, paid);
    }
    if (check.kind === 'invalid') return unauthorized(c, path, 'invalid_token');
    console.error('[mcp] token check unavailable, serving as anonymous');
    return anon;
  }

  function unauthorized(
    c: Context,
    path: string,
    error?: 'invalid_token',
    message = 'Sign in with your Phở account to use this endpoint.',
  ): Response {
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32001, message },
        id: null,
      },
      401,
      { 'www-authenticate': wwwAuthenticate(baseUrl(c), path, error) },
    );
  }

  /**
   * The tool an anonymous caller is about to run once their allowance for it
   * is gone, or undefined. Only asked for clients listed in
   * SIGN_IN_ON_ANON_LIMIT; any failure answers undefined, so the call goes on
   * and gets the usual quota message.
   */
  async function blockedAnonTool(c: Context, caller: Caller): Promise<string | undefined> {
    if (!issuer || caller.auth !== 'anon' || !config.signInOnAnonLimit.includes(caller.client)) return undefined;
    try {
      const body = (await c.req.raw.clone().json()) as { method?: unknown; params?: { name?: unknown } } | null;
      if (body?.method !== 'tools/call' || typeof body.params?.name !== 'string') return undefined;
      const tool = body.params.name;
      if (!TOOL_NAMES.has(tool)) return undefined;
      const day = utcDay(deps.now?.() ?? new Date());
      const calls = await usage.peek(caller.subject, 'calls', day);
      if (calls >= config.quota.anonCallsPerDay) return tool;
      if (VERIFICATION_TOOLS.has(tool)) {
        const checks = await usage.peek(caller.subject, 'verifications', day);
        if (checks >= config.quota.anonVerificationsPerDay) return tool;
      }
    } catch (err) {
      console.error('[mcp] anonymous allowance peek failed', err);
    }
    return undefined;
  }

  async function serveMcp(c: Context, path: string): Promise<Response> {
    const caller = await resolveCaller(c, path);
    if (caller instanceof Response) return caller;
    if (path === '/mcp') {
      // Out of allowance: ask the client to sign in on this same connector.
      // Clients that follow the MCP auth spec run OAuth and retry with a token.
      const tool = await blockedAnonTool(c, caller);
      if (tool) {
        runInBackground(analytics.track(caller, { tool_name: tool, result_status: 'sign_in_requested', latency_ms: 0 }));
        const q = config.quota;
        return unauthorized(
          c,
          path,
          undefined,
          `Today's free allowance is used up. Sign in with a free Phở account to keep going: ` +
            `${q.userVerificationsPerMonth} reference checks and ${q.userCallsPerMonth} tool calls a month.`,
        );
      }
    }
    const ctx: ToolContext = { config, http, usage, analytics, caller, baseUrl: baseUrl(c), now: deps.now };
    const server = buildMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  }

  const limitBody = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) });
  app.post('/mcp', limitBody, (c) => serveMcp(c, '/mcp'));

  // Stateless server: no standalone SSE stream and no sessions to delete.
  const notAllowed = (c: Context) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null }, 405, {
      allow: 'POST',
    });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  if (issuer) {
    app.post('/mcp/login', limitBody, (c) => serveMcp(c, '/mcp/login'));
    // A client probing with GET first must also see the sign-in challenge.
    const loginOther = async (c: Context) => {
      const caller = await resolveCaller(c, '/mcp/login');
      return caller instanceof Response ? caller : notAllowed(c);
    };
    app.get('/mcp/login', loginOther);
    app.delete('/mcp/login', loginOther);
  }

  app.get('/prisma/:file', (c) => {
    const m = /^([A-Za-z0-9_-]+)\.(png|svg)$/.exec(c.req.param('file'));
    const payload = m ? decodePrismaPayload(m[1]!) : null;
    const parsed = payload ? prismaPayloadSchema.safeParse(payload) : null;
    if (!m || !parsed?.success) return c.text('Invalid diagram link.', 400);
    const d = prismaFlowDiagram(parsed.data.counts, parsed.data.options);
    const headers = {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-disposition': `inline; filename="prisma-2020-flow-diagram.${m[2]}"`,
      'x-content-type-options': 'nosniff',
    };
    if (m[2] === 'svg') {
      return c.body(d.svg, 200, {
        ...headers,
        'content-type': 'image/svg+xml; charset=utf-8',
        // The SVG is built from escaped text, but an SVG opened directly is a document: no scripts, ever.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
    }
    return c.body(Buffer.from(svgToPng(d.svg, { scale: 2 })), 200, { ...headers, 'content-type': 'image/png' });
  });

  // Shared Research Data Briefs. The page is public but unlisted: it only
  // exists for whoever has the link, so it asks search engines not to index it.
  const briefNotFound = (c: Context) =>
    c.html(
      '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Link not valid</title>' +
        '<p style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">This brief link is incomplete or was changed after it was shared. ' +
        'Ask whoever sent it for the full link, or <a href="https://pho.chat/tools/mcp/">make your own brief</a>.</p>',
      400,
      { 'x-robots-tag': 'noindex' },
    );

  app.post('/brief/event', bodyLimit({ maxSize: 1024 }), async (c) => {
    let body: { e?: unknown; channel?: unknown } = {};
    try {
      body = JSON.parse(await c.req.text()) as typeof body;
    } catch {
      return c.body(null, 204);
    }
    if (typeof body.e === 'string' && BRIEF_EVENTS.has(body.e)) {
      const channel = typeof body.channel === 'string' && BRIEF_CHANNELS.has(body.channel) ? body.channel : undefined;
      await analytics.page({ name: `rt_brief_${body.e}`, ...(channel ? { props: { channel } } : {}) });
    }
    return c.body(null, 204);
  });

  app.get('/brief/:token/og.png', (c) => {
    const p = decodeBrief(c.req.param('token'), config.quotaSalt);
    if (!p) return c.text('Invalid brief link.', 400);
    return c.body(Buffer.from(svgToPng(renderBriefOgSvg(p), { scale: 1 })), 200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
  });

  app.get('/brief/:token', async (c) => {
    const token = c.req.param('token');
    const p = decodeBrief(token, config.quotaSalt);
    if (!p) return briefNotFound(c);
    const base = baseUrl(c);
    const nonce = randomBytes(16).toString('base64');
    await analytics.page({ name: 'rt_brief_viewed', props: { results: p.r.length } });
    const html = renderBriefHtml(
      p,
      { page: `${base}/brief/${token}`, og: `${base}/brief/${token}/og.png`, event: `${base}/brief/event` },
      nonce,
    );
    return c.html(html, 200, {
      'cache-control': 'public, max-age=300',
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
  });

  return app;
}
