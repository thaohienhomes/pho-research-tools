/**
 * find_datasets and the shared brief page, end to end over MCP, with the
 * repositories answered by a fake. scholar-core's recorded run covers the real
 * responses; this covers the server: the tool, the signed link, the page, the
 * preview image and the page events.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HttpClient, HttpResponse } from '@pho/scholar-core';
import { describe, expect, it } from 'vitest';
import { createRecordingAnalytics } from '../analytics';
import { createApp } from '../app';
import { MAX_BRIEF_TOKEN_CHARS, briefToken, decodeBrief, type BriefPayload } from '../brief-link';
import { loadConfig } from '../config';
import { createMemoryUsageStore } from '../storage';

const PAPER_DOI = '10.1158/1078-0432.ccr-14-0432';

const routes: [string, HttpResponse][] = [
  [
    'api.datacite.org/dois?',
    {
      status: 200,
      body: {
        data: [
          {
            attributes: {
              doi: '10.5281/zenodo.111',
              titles: [{ title: 'Triple negative breast cancer gene expression matrix <script>alert(1)</script>' }],
              creators: [{ name: 'Burstein, Matthew', nameType: 'Personal' }],
              publisher: 'Zenodo',
              publicationYear: 2016,
              rightsList: [{ rightsIdentifier: 'cc-by-4.0' }],
              relatedIdentifiers: [
                { relatedIdentifier: PAPER_DOI, relatedIdentifierType: 'DOI', relationType: 'IsSupplementTo' },
              ],
              formats: ['text/csv'],
            },
          },
        ],
      },
    },
  ],
  [
    'api.crossref.org/works/10.1158',
    {
      status: 200,
      body: {
        status: 'ok',
        'message-type': 'work',
        message: {
          DOI: PAPER_DOI,
          title: ['Comprehensive genomic analysis identifies novel subtypes of triple-negative breast cancer'],
          author: [{ family: 'Burstein', given: 'Matthew D.' }],
          'container-title': ['Clinical Cancer Research'],
          issued: { 'date-parts': [[2015]] },
          type: 'journal-article',
        },
      },
    },
  ],
];

const fake: HttpClient = async (req) => {
  const hit = routes.find(([k]) => req.url.includes(k));
  if (hit) return hit[1];
  if (req.url.includes('huggingface.co/api/')) return { status: 200, body: [] };
  if (req.url.includes('api.datacite.org')) return { status: 200, body: { data: [] } };
  if (req.url.includes('esearch.fcgi')) return { status: 200, body: { esearchresult: { idlist: [] } } };
  if (req.url.includes('huggingscience.co')) return { status: 200, body: '# Hugging Science\n' };
  if (req.url.includes('api.cellxgene.cziscience.com')) return { status: 200, body: [] };
  if (req.url.includes('graphql.cryoetdataportal')) {
    return { status: 200, body: { data: { byTitle: [], byDescription: [], byOrganism: [] } } };
  }
  return { status: 404, body: null };
};

const SALT = 'a'.repeat(32);

function setup() {
  const analytics = createRecordingAnalytics();
  const app = createApp({
    config: loadConfig({ PUBLIC_URL: 'https://tools.test', QUOTA_SALT: SALT }),
    http: fake,
    usage: createMemoryUsageStore(),
    analytics,
  });
  async function connect() {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://tools.test/mcp'), {
        fetch: async (url, init) => app.request(String(url), init),
        requestInit: { headers: { 'user-agent': 'claude-ai/1.0' } },
      }),
    );
    return client;
  }
  return { app, analytics, connect };
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

const QUESTION = "I'm writing my thesis on gene expression in triple-negative breast cancer. Is there open data?";

describe('find_datasets', () => {
  it('returns a brief with licence, verified paper, citations, snippet and a share link', async () => {
    const { app, analytics, connect } = setup();
    const client = await connect();
    const r = (await client.callTool({
      name: 'find_datasets',
      arguments: { question: QUESTION, intended_use: 'thesis' },
    })) as CallToolResult;
    expect(r.isError, text(r)).toBeFalsy();
    const s = r.structuredContent as {
      share_url: string;
      results: {
        match: string;
        licence: { verdict: string };
        paper: { status: string; doi?: string };
        citation: string;
        load_snippet: string;
      }[];
    };
    expect(s.results).toHaveLength(1);
    expect(s.results[0]).toMatchObject({
      match: 'best',
      licence: { verdict: 'ok_publication_commercial' },
      paper: { status: 'verified', doi: PAPER_DOI },
    });
    expect(s.results[0]!.load_snippet).toContain('zenodo_get 10.5281/zenodo.111');
    expect(text(r)).toMatch(/Shareable brief: https:\/\/tools\.test\/brief\//);
    expect(text(r)).toMatch(/not legal advice/);

    // Analytics never carries the user's question.
    const ev = analytics.events.at(-1)!;
    expect(ev).toMatchObject({ tool_name: 'find_datasets', result_status: 'ok' });
    expect(JSON.stringify(ev)).not.toMatch(/breast|negative/i);

    // The share page renders what the tool returned, escaped, with a nonce'd script only.
    expect(s.share_url).toMatch(/^https:\/\/tools\.test\/brief\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const page = await app.request(s.share_url);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).not.toContain('unsafe-eval');
    expect(page.headers.get('x-robots-tag')).toBe('noindex');
    const html = await page.text();
    expect(html).toContain('Triple negative breast cancer gene expression matrix');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain(`https://doi.org/${PAPER_DOI}`);
    expect(html).toContain('og:image');
    expect(analytics.pages.at(-1)).toEqual({ name: 'rt_brief_viewed', props: { results: 1 } });

    const og = await app.request(`${s.share_url}/og.png`);
    expect(og.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await og.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(1, 4))).toBe('PNG');
  });

  it('says plainly when nothing matches, and asks for keywords when there is nothing to search', async () => {
    const client = await setup().connect();
    const r = (await client.callTool({
      name: 'find_datasets',
      arguments: { question: 'zxqv blorf marmalade telemetry' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/No open dataset matched/);
    expect((r.structuredContent as { results: unknown[] }).results).toEqual([]);

    const none = (await client.callTool({
      name: 'find_datasets',
      arguments: { question: 'is there data?' },
    })) as CallToolResult;
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/keywords/);
  });
});

describe('brief links', () => {
  const payload: BriefPayload = {
    v: 1,
    q: 'TNBC expression data',
    u: 'publication',
    d: '2026-10-08',
    st: [12, 1, 0],
    r: [],
    tk: [],
    wn: [],
  };

  it('refuses an edited link', async () => {
    const token = briefToken(payload, SALT)!;
    expect(decodeBrief(token, SALT)).toEqual(payload);
    expect(decodeBrief(token, 'b'.repeat(32))).toBeNull();
    const [data, sig] = token.split('.');
    const forged = briefToken({ ...payload, st: [12, 9, 0] }, SALT)!.split('.')[0];
    expect(decodeBrief(`${forged}.${sig}`, SALT)).toBeNull();
    expect(decodeBrief(`${data}.${sig}x`, SALT)).toBeNull();

    const { app } = setup();
    const res = await app.request(`/brief/${forged}.${sig}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/changed after it was shared/);
    expect((await app.request(`/brief/${forged}.${sig}/og.png`)).status).toBe(400);
  });

  it('keeps long briefs under the URL budget by dropping detail, not by failing', () => {
    const item = {
      k: 'dataset' as const,
      s: 'datacite' as const,
      id: 'x',
      url: 'https://example.org',
      t: 'T',
      m: 'good' as const,
      w: 'w',
      l: 'unclear' as const,
      a: 'open' as const,
      p: { s: 'verified' as const, n: 'n', c: 'Long citation '.repeat(40) },
      c: 'Data citation',
      n: 'snippet',
    };
    // Random text does not compress, so this would be far over budget untrimmed.
    const noise = () => Array.from({ length: 300 }, () => Math.random().toString(36).slice(2)).join(' ');
    const big = { ...payload, r: Array.from({ length: 5 }, (_, i) => ({ ...item, id: `x${i}`, w: noise() })) };
    const token = briefToken(big, SALT)!;
    expect(token.length).toBeLessThanOrEqual(MAX_BRIEF_TOKEN_CHARS);
    const back = decodeBrief(token, SALT)!;
    expect(back.r.length).toBeGreaterThanOrEqual(1);
    expect(back.r.length).toBeLessThan(5);
  });

  it('counts only known page events', async () => {
    const { app, analytics } = setup();
    const post = (body: string) =>
      app.request('/brief/event', { method: 'POST', body, headers: { 'content-type': 'text/plain' } });
    expect((await post(JSON.stringify({ e: 'citation_copied' }))).status).toBe(204);
    await post(JSON.stringify({ e: 'share_clicked', channel: 'x' }));
    await post(JSON.stringify({ e: 'share_clicked', channel: 'evil' }));
    await post(JSON.stringify({ e: 'drop_table' }));
    await post('not json');
    expect(analytics.pages).toEqual([
      { name: 'rt_brief_citation_copied' },
      { name: 'rt_brief_share_clicked', props: { channel: 'x' } },
      { name: 'rt_brief_share_clicked' },
    ]);
  });
});
