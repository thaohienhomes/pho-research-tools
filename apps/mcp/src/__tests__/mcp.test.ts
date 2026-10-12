/**
 * The MCP server end to end: a real MCP client talks to the Hono app over the
 * Streamable HTTP transport, and every outbound call to Crossref, PubMed,
 * OpenAlex and doi.org is answered from scholar-core's recorded responses.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HttpClient } from '@pho/scholar-core';
import { describe, expect, it } from 'vitest';
import { createRecordingAnalytics } from '../analytics';
import { createApp } from '../app';
import { identifyCaller, quotaKey } from '../caller';
import { loadConfig } from '../config';
import { decodePrismaPayload } from '../prisma-link';
import { createMemoryUsageStore, jsonbSafe } from '../storage';
import { openCassette } from '../../../../packages/scholar-core/test/support/cassette';

const CORE = join(__dirname, '..', '..', '..', '..', 'packages', 'scholar-core');
const verifyCassette = openCassette(join(CORE, 'test', 'fixtures', 'cassettes'));
const searchCassette = openCassette(join(CORE, 'test', 'fixtures', 'cassettes-search'));

/** Answer from whichever cassette recorded the URL. */
const recorded: HttpClient = async (req) => {
  const a = await verifyCassette.http(req);
  return a.status !== 0 ? a : searchCassette.http(req);
};

const fixtures = JSON.parse(readFileSync(join(CORE, 'test', 'fixtures', 'references.json'), 'utf8')) as {
  id: string;
  input: string;
}[];
const ref = (id: string) => fixtures.find((r) => r.id === id)!.input;

const REFS = ['correct-01', 'injected-12', 'fabricated-01', 'retracted-01'].map(ref).join('\n\n');

function setup(env: Record<string, string> = {}, userAgent = 'claude-ai/1.0') {
  const analytics = createRecordingAnalytics();
  const app = createApp({
    config: loadConfig({ PUBLIC_URL: 'https://tools.test', ...env }),
    http: recorded,
    usage: createMemoryUsageStore(),
    analytics,
  });
  async function connect() {
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL('https://tools.test/mcp'), {
      fetch: async (url, init) => app.request(String(url), init),
      requestInit: { headers: { 'user-agent': userAgent } },
    });
    await client.connect(transport);
    return client;
  }
  return { app, analytics, connect };
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('tools/list', () => {
  it('lists the five read-only tools with input and output schemas', async () => {
    const client = await setup().connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_retractions',
      'format_citations',
      'prisma_flow_diagram',
      'search_papers',
      'verify_references',
    ]);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      // OpenAI's app review rejects a tool unless all three hints are explicit booleans.
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(typeof t.annotations?.openWorldHint, t.name).toBe('boolean');
      // Directory listings read the title from annotations, not the top-level field.
      expect(t.annotations?.title, t.name).toBe(t.title);
      expect(t.outputSchema, t.name).toBeTruthy();
      expect(t.description!.length, t.name).toBeGreaterThan(80);
    }
    // Directory policy: descriptions state what a tool does and never steer the model.
    for (const t of tools) {
      expect(t.description, t.name).not.toMatch(/call this|tell the user|show th(ose|e)|never present|instead of recalling/i);
    }
  });
});

describe('verify_references', () => {
  it('gives each reference its status, with corrections and retraction notices', async () => {
    const { connect, analytics } = setup();
    const client = await connect();
    const r = (await client.callTool({ name: 'verify_references', arguments: { references: REFS } })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as {
      summary: Record<string, number>;
      references: { status: string; mismatches: { field: string }[]; corrected?: { pages?: string } }[];
    };
    expect(s.references.map((x) => x.status)).toEqual(['verified', 'verified_with_corrections', 'likely_fabricated', 'retracted']);
    expect(s.references[1]!.mismatches.map((m) => m.field)).toContain('pages');
    expect(s.references[1]!.corrected?.pages).toMatch(/585/);
    expect(s.references[2]!.corrected).toBeUndefined();
    expect(s.summary).toMatchObject({ total: 4, verified: 1, likely_fabricated: 1, retracted: 1, not_checked: 0 });
    expect(text(r)).toMatch(/Checked 4 of 4 references/);

    // Analytics: counts and labels only, never the references themselves.
    const ev = analytics.events.at(-1)!;
    expect(ev).toMatchObject({ tool_name: 'verify_references', result_status: 'ok', client: 'claude' });
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toMatch(/Wakefield|Nirsevimab|Drysdale|10\.1056/i);
  });

  it('checks only what the daily allowance covers and says so', async () => {
    const { connect, analytics } = setup({ QUOTA_ANON_VERIFICATIONS_PER_DAY: '3' });
    const client = await connect();
    const first = (await client.callTool({ name: 'verify_references', arguments: { references: REFS } })) as CallToolResult;
    const s = first.structuredContent as { summary: { not_checked: number }; references: { status: string }[]; quota: { plan: string; used: number; limit: number } };
    expect(s.summary.not_checked).toBe(1);
    expect(s.references.at(-1)!.status).toBe('not_checked');
    expect(s.quota).toMatchObject({ plan: 'anon', used: 3, limit: 3 });
    expect(analytics.events.at(-1)!.result_status).toBe('partial');

    const second = (await client.callTool({ name: 'verify_references', arguments: { references: ref('correct-01') } })) as CallToolResult;
    expect(second.isError).toBe(true);
    expect(text(second)).toMatch(/daily allowance of 3 reference checks/);
    expect(text(second)).toContain('https://pho.chat/pricing');
    expect(second.structuredContent).toMatchObject({ error: 'quota_exceeded', quota: { plan: 'anon' } });
    expect(analytics.events.at(-1)!.result_status).toBe('quota_exceeded');
  });

  it('refuses empty input and oversized lists with a message the model can act on', async () => {
    const client = await setup().connect();
    const empty = (await client.callTool({ name: 'verify_references', arguments: { references: '   ' } })) as CallToolResult;
    expect(empty.isError).toBe(true);
    const many = Array.from({ length: 51 }, (_, i) => `10.1000/test.${i}`).join('\n');
    const tooMany = (await client.callTool({ name: 'verify_references', arguments: { references: many } })) as CallToolResult;
    expect(tooMany.isError).toBe(true);
    expect(text(tooMany)).toMatch(/at most 50/);
  });
});

describe('format_citations', () => {
  it('formats verified references from the matched record and flags the rest', async () => {
    const client = await setup().connect();
    const r = (await client.callTool({
      name: 'format_citations',
      arguments: { references: [ref('injected-12'), ref('fabricated-01')].join('\n\n'), style: 'apa' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { entries: { verified: boolean; bibliography: string }[] };
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0]!.verified).toBe(true);
    expect(s.entries[0]!.bibliography).toMatch(/585/);
    expect(s.entries[1]!.verified).toBe(false);
  });

  it('can skip verification and emit BibTeX', async () => {
    const client = await setup().connect();
    const r = (await client.callTool({
      name: 'format_citations',
      arguments: { references: ref('correct-01'), style: 'vancouver', output: 'bibtex', verify: false },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/@article\{/);
  });
});

describe('search_papers', () => {
  it('returns real papers with identifiers', async () => {
    const client = await setup().connect();
    const r = (await client.callTool({
      name: 'search_papers',
      arguments: { query: 'sepsis fluid resuscitation', year_from: 2018, year_to: 2024, max_results: 10 },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { results: { doi?: string; pmid?: string; year?: number }[] };
    expect(s.results.length).toBeGreaterThan(0);
    for (const p of s.results) {
      expect(p.doi || p.pmid).toBeTruthy();
      if (p.year) {
        expect(p.year).toBeGreaterThanOrEqual(2018);
        expect(p.year).toBeLessThanOrEqual(2024);
      }
    }
  });
});

describe('check_retractions', () => {
  it('reports a retracted DOI and a clean one', async () => {
    const client = await setup().connect();
    const r = (await client.callTool({
      name: 'check_retractions',
      arguments: { dois: ['10.1016/S0140-6736(20)31180-6', '10.1056/NEJMoa2309189'] },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { results: { doi: string; status: string }[] };
    expect(s.results[0]!.status).toBe('retracted');
    expect(s.results[1]!.status).not.toBe('retracted');
  });

  it('checks two spellings of one DOI once', async () => {
    const client = await setup().connect();
    const r = (await client.callTool({
      name: 'check_retractions',
      arguments: { dois: ['10.1056/NEJMoa2309189', 'https://doi.org/10.1056/nejmoa2309189', 'doi:10.1056/NEJMOA2309189'] },
    })) as CallToolResult;
    const s = r.structuredContent as { results: unknown[]; quota: { used: number } };
    expect(s.results).toHaveLength(1);
    expect(s.quota.used).toBe(1);
  });

  it('rejects a blank DOI instead of skipping it', async () => {
    const client = await setup().connect();
    const r = (await client.callTool({ name: 'check_retractions', arguments: { dois: ['   '] } })) as CallToolResult;
    expect(r.isError).toBe(true);
  });
});

describe('prisma_flow_diagram', () => {
  const counts = {
    databases: 2000,
    registers: 131,
    duplicatesRemoved: 480,
    automationIneligible: 20,
    otherRemoved: 10,
    recordsScreened: 1621,
    recordsExcluded: 1400,
    reportsSought: 221,
    reportsNotRetrieved: 11,
    reportsAssessed: 210,
    reportsExcludedReasons: [
      { name: 'Wrong population', n: 90 },
      { name: 'Wrong outcome', n: 75 },
    ],
    studiesIncluded: 45,
    reportsIncluded: 45,
  };

  it('returns the image, links that render it, and the checks', async () => {
    const { app, connect } = setup();
    const client = await connect();
    const r = (await client.callTool({ name: 'prisma_flow_diagram', arguments: { counts } })) as CallToolResult;
    expect(r.isError, text(r)).toBeFalsy();
    expect(r.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    const s = r.structuredContent as { image_url: string; svg_url: string; warnings: unknown[] };
    expect(s.image_url).toMatch(/^https:\/\/tools\.test\/prisma\/[A-Za-z0-9_-]+\.png$/);

    const png = await app.request(s.image_url);
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join('')).toBe('PNG');

    const svg = await app.request(s.svg_url);
    expect(svg.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await svg.text()).toContain('<svg');
  });

  it('reports a box that does not add up', async () => {
    const client = await setup().connect();
    const r = (await client.callTool({
      name: 'prisma_flow_diagram',
      arguments: { counts: { ...counts, recordsScreened: 1700 } },
    })) as CallToolResult;
    const s = r.structuredContent as { warnings: unknown[] };
    expect(s.warnings.length).toBeGreaterThan(0);
  });

  it('rejects a tampered image link', async () => {
    const { app } = setup();
    expect((await app.request('/prisma/not-a-payload.png')).status).toBe(400);
    expect(decodePrismaPayload('AAAA')).toBeNull();
  });
});

describe('HTTP surface', () => {
  it('serves health and refuses GET on /mcp', async () => {
    const { app } = setup();
    expect(await (await app.request('/health')).json()).toEqual({ ok: true, storage: 'memory', sign_in: false });
    expect((await app.request('/mcp')).status).toBe(405);
  });

  it('never takes the link host from X-Forwarded-Host', async () => {
    const app = createApp({
      config: loadConfig({ TRUST_PROXY: '1' }),
      http: recorded,
      usage: createMemoryUsageStore(),
      analytics: createRecordingAnalytics(),
    });
    const res = await app.request('https://tools.test/', {
      headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    });
    expect(((await res.json()) as { mcp_endpoint: string }).mcp_endpoint).toBe('https://tools.test/mcp');
  });

  it('caps calls per day for one caller', async () => {
    const { connect } = setup({ QUOTA_ANON_CALLS_PER_DAY: '1' });
    const client = await connect();
    const ok = (await client.callTool({ name: 'check_retractions', arguments: { dois: ['10.1056/NEJMoa2309189'] } })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    const blocked = (await client.callTool({ name: 'check_retractions', arguments: { dois: ['10.1056/NEJMoa2309189'] } })) as CallToolResult;
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toMatch(/1 tool calls/);
  });
});

describe('caller identity', () => {
  const opts = { salt: 's', trustProxy: true };
  const h = (ip: string, ua: string) => new Headers({ 'x-forwarded-for': ip, 'user-agent': ua });

  it('hashes the IP and never exposes it', () => {
    const a = identifyCaller(h('1.2.3.4', 'Cursor/1.0'), opts);
    expect(a.client).toBe('cursor');
    expect(a.subject).not.toContain('1.2.3.4');
    expect(identifyCaller(h('1.2.3.4', 'Cursor/1.0'), opts).subject).toBe(a.subject);
    expect(identifyCaller(h('5.6.7.8', 'Cursor/1.0'), opts).subject).not.toBe(a.subject);
    // A new User-Agent is not a new allowance.
    const b = identifyCaller(h('1.2.3.4', 'claude-code/2.0'), opts);
    expect(b.client).toBe('claude-code');
    expect(b.subject).toBe(a.subject);
    // The web tools name themselves by header; the allowance is still the IP's.
    const web = identifyCaller(new Headers({ 'x-forwarded-for': '1.2.3.4', 'user-agent': 'Mozilla/5.0', 'x-pho-client': 'tools-web' }), opts);
    expect(web.client).toBe('pho-tools-web');
    expect(web.subject).toBe(a.subject);
  });

  it('uses the address the proxy appended, not one the client forged', () => {
    const real = identifyCaller(h('1.2.3.4', 'x'), opts);
    expect(identifyCaller(h('9.9.9.9, 1.2.3.4', 'x'), opts).subject).toBe(real.subject);
    expect(identifyCaller(h('8.8.8.8, 1.2.3.4', 'x'), opts).subject).toBe(real.subject);
  });

  it('charges an IPv6 caller per /64, and IPv4-mapped IPv6 as IPv4', () => {
    expect(quotaKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(quotaKey('2001:0DB8:0001:0002:ffff:aaaa:bbbb:cccc')).toBe('2001:db8:1:2::/64');
    expect(quotaKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(quotaKey('::ffff:102:304')).toBe('1.2.3.4');
    expect(quotaKey('[2001:db8::1]')).toBe('2001:db8:0:0::/64');
    expect(quotaKey('1.2.3.4')).toBe('1.2.3.4');
    const a = identifyCaller(h('2001:db8:1:2::1', 'x'), opts);
    expect(identifyCaller(h('2001:db8:1:2:dead:beef:0:7', 'x'), opts).subject).toBe(a.subject);
    expect(identifyCaller(h('2001:db8:1:3::1', 'x'), opts).subject).not.toBe(a.subject);
    expect(identifyCaller(h('::ffff:1.2.3.4', 'x'), opts).subject).toBe(identifyCaller(h('1.2.3.4', 'x'), opts).subject);
  });

  it('ignores X-Forwarded-For unless the proxy is trusted', () => {
    const a = identifyCaller(h('1.2.3.4', 'x'), { salt: 's', trustProxy: false, socketIp: '9.9.9.9' });
    const b = identifyCaller(h('5.6.7.8', 'x'), { salt: 's', trustProxy: false, socketIp: '9.9.9.9' });
    expect(a.subject).toBe(b.subject);
  });
});

describe('storage', () => {
  it('keeps a window for a month, then forgets it', async () => {
    const store = createMemoryUsageStore();
    expect((await store.take('a', 'calls', 1, 1, '2026-10-01')).granted).toBe(1);
    // Days turning over do not wipe a monthly window that started on the 1st.
    expect((await store.take('b', 'calls', 1, 1, '2026-10-30')).granted).toBe(1);
    expect((await store.take('a', 'calls', 1, 1, '2026-10-01')).granted).toBe(0);
    // More than 31 days later the old counter is gone.
    expect((await store.take('b', 'calls', 1, 1, '2026-11-02')).granted).toBe(1);
    expect((await store.take('a', 'calls', 1, 1, '2026-10-01')).granted).toBe(1);
  });

  it('makes text Postgres jsonb accepts', () => {
    const out = jsonbSafe({ title: 'a\u0000b', lone: 'x\uD800y', pair: '😀' });
    expect(out).not.toContain('\\u0000');
    expect(JSON.parse(out)).toEqual({ title: 'ab', lone: 'x\uFFFDy', pair: '😀' });
  });
});

describe('config', () => {
  it('refuses to start a deployment without its own quota salt', () => {
    expect(() => loadConfig({ VERCEL: '1' })).toThrow(/QUOTA_SALT/);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/QUOTA_SALT/);
    const salt = 'a'.repeat(64);
    expect(loadConfig({ VERCEL: '1', QUOTA_SALT: salt }).quotaSalt).toBe(salt);
  });

  it('rejects a salt short enough to guess', () => {
    expect(() => loadConfig({ VERCEL: '1', QUOTA_SALT: 'secret' })).toThrow(/at least 32/);
    expect(() => loadConfig({ QUOTA_SALT: 'secret' })).toThrow(/at least 32/);
  });

  it('uses a random salt for local runs', () => {
    expect(loadConfig({}).quotaSalt).not.toBe(loadConfig({}).quotaSalt);
  });

  it('trusts X-Forwarded-For on Vercel only unless told otherwise', () => {
    expect(loadConfig({ VERCEL: '1', QUOTA_SALT: 's'.repeat(32) }).trustProxy).toBe(true);
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });
});

describe('all outbound calls were recorded', () => {
  it('has no cassette misses', () => {
    // A miss returns status 0; the verify cassette is tried first, so its misses
    // are expected whenever the search cassette answered.
    const unanswered = searchCassette.misses.filter((u) => verifyCassette.misses.includes(u));
    expect(unanswered, unanswered.join("\n")).toEqual([]);
  });
});
