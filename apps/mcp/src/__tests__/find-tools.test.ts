/**
 * find_tools end to end over MCP, with bio.tools, GitHub and Crossref answered
 * by a fake. scholar-core's recorded run covers the real responses; this
 * covers the server: the tool, its schemas and what analytics may carry.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HttpClient } from '@pho/scholar-core';
import { describe, expect, it } from 'vitest';
import { createRecordingAnalytics } from '../analytics';
import { createApp } from '../app';
import { loadConfig } from '../config';
import { createMemoryUsageStore } from '../storage';

const DOI = '10.1186/s13059-017-1382-0';

const fake: HttpClient = async (req) => {
  if (req.url.startsWith('https://bio.tools/api/t/')) {
    return {
      status: 200,
      body: {
        count: 1,
        list: [
          {
            biotoolsID: 'scanpy',
            name: 'Scanpy',
            description: 'Single-cell RNA-seq clustering <script>alert(1)</script>',
            homepage: 'https://scanpy.readthedocs.io',
            license: 'BSD-3-Clause',
            cost: 'Free of charge',
            language: ['Python'],
            function: [
              {
                operation: [{ term: 'Clustering' }],
                input: [{ format: [{ term: 'H5AD' }] }],
                output: [],
              },
            ],
            link: [{ url: 'https://github.com/scverse/scanpy', type: ['Repository'] }],
            download: [{ url: 'https://pypi.org/project/scanpy/', type: 'Software package' }],
            publication: [{ doi: DOI, type: ['Primary'] }],
          },
        ],
      },
    };
  }
  if (req.url.includes('api.github.com/repos/scverse/scanpy')) {
    return {
      status: 200,
      body: {
        archived: false,
        pushed_at: new Date().toISOString(),
        license: { spdx_id: 'BSD-3-Clause' },
      },
    };
  }
  if (req.url.includes('api.crossref.org/works/')) {
    return {
      status: 200,
      body: {
        status: 'ok',
        'message-type': 'work',
        message: {
          DOI,
          title: ['SCANPY: large-scale single-cell gene expression data analysis'],
          author: [{ family: 'Wolf', given: 'F. Alexander' }],
          'container-title': ['Genome Biology'],
          issued: { 'date-parts': [[2018]] },
          type: 'journal-article',
        },
      },
    };
  }
  return { status: 404, body: null };
};

function setup() {
  const analytics = createRecordingAnalytics();
  const app = createApp({
    config: loadConfig({ PUBLIC_URL: 'https://tools.test', QUOTA_SALT: 'a'.repeat(32) }),
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
  return { analytics, connect };
}

const text = (r: CallToolResult) =>
  r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('find_tools', () => {
  it('returns the tool with licence, verified paper, maintenance label and install line', async () => {
    const { analytics, connect } = setup();
    const client = await connect();
    const r = (await client.callTool({
      name: 'find_tools',
      arguments: { question: 'cluster single-cell RNA-seq data', input_format: 'H5AD' },
    })) as CallToolResult;
    expect(r.isError, text(r)).toBeFalsy();
    const s = r.structuredContent as {
      results: {
        match: string;
        licence: { verdict: string };
        paper: { status: string; doi?: string };
        health: { label: string };
        install?: { line: string };
        reads_requested_format?: boolean;
      }[];
    };
    expect(s.results).toHaveLength(1);
    expect(s.results[0]).toMatchObject({
      match: 'best',
      licence: { verdict: 'ok_publication_commercial' },
      paper: { status: 'verified', doi: DOI },
      health: { label: 'active' },
      install: { line: 'pip install scanpy' },
      reads_requested_format: true,
    });
    expect(text(r)).toMatch(/Install: pip install scanpy/);
    expect(text(r)).toMatch(/not legal advice/);

    // Analytics never carries the user's question.
    const ev = analytics.events.at(-1)!;
    expect(ev).toMatchObject({ tool_name: 'find_tools', result_status: 'ok' });
    expect(ev.props).toMatchObject({ results: 1, with_install: 1 });
    expect(JSON.stringify(ev)).not.toMatch(/cluster|single-cell|H5AD/i);
  });

  it('says so, and invents nothing, when the registry has no match', async () => {
    const { connect } = setup();
    const client = await connect();
    const r = (await client.callTool({
      name: 'find_tools',
      arguments: { question: 'zxqv blorf glimmering unicorn telemetry' },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { results: unknown[] }).results).toEqual([]);
    expect(text(r)).toMatch(/Do not suggest tools from memory/);
  });
});
