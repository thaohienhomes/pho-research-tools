/**
 * Call every tool on a running server, live:
 *   pnpm --filter @pho/mcp smoke                       # http://localhost:8787/mcp
 *   pnpm --filter @pho/mcp smoke https://<host>/mcp    # a deployment
 *
 * Exits non-zero if any tool errors. Spends 5 of the daily tool-call allowance
 * and 8 reference checks (3 verify_references, 3 format_citations, 2 check_retractions).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const url = new URL(process.argv[2] ?? 'http://localhost:8787/mcp');

const REFS = [
  'Drysdale SB, Cathie K, Flamein F, et al. Nirsevimab for Prevention of Hospitalizations Due to RSV in Infants. N Engl J Med. 2023;389(26):2425-2435. doi:10.1056/NEJMoa2309189',
  'Feng H, Jin P, Wu H. Disease prediction by cell-free DNA methylation. Brief Bioinform. 2019;20(2):485-497.',
  'Nguyen TH, Whitfield JA, Patel R. Efficacy of alternate-day fasting on HbA1c in adults with prediabetes in rural Vietnam: a multicenter randomized controlled trial. Diabetes Care. 2021;44(7):1532-1540.',
].join('\n\n');

const CALLS: { name: string; arguments: Record<string, unknown> }[] = [
  { name: 'verify_references', arguments: { references: REFS } },
  { name: 'format_citations', arguments: { references: REFS, style: 'apa' } },
  { name: 'search_papers', arguments: { query: 'sepsis fluid resuscitation', year_from: 2018, max_results: 5 } },
  { name: 'check_retractions', arguments: { dois: ['10.1016/S0140-6736(20)31180-6', '10.1056/NEJMoa2309189'] } },
  {
    name: 'prisma_flow_diagram',
    arguments: {
      counts: {
        databases: 1200,
        duplicatesRemoved: 300,
        recordsScreened: 900,
        recordsExcluded: 780,
        reportsSought: 120,
        reportsNotRetrieved: 5,
        reportsAssessed: 115,
        reportsExcludedReasons: [
          { name: 'Wrong population', n: 60 },
          { name: 'Wrong outcome', n: 31 },
        ],
        studiesIncluded: 24,
      },
    },
  },
];

const client = new Client({ name: 'pho-mcp-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url));
const { tools } = await client.listTools();
console.log(`${url} — ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}\n`);

let failed = 0;
for (const call of CALLS) {
  const started = Date.now();
  const r = (await client.callTool(call)) as CallToolResult;
  const first = r.content.find((c) => c.type === 'text');
  const line = first && first.type === 'text' ? first.text.split('\n')[0] : '';
  if (r.isError) failed++;
  console.log(`${r.isError ? '✗' : '✓'} ${call.name} (${Date.now() - started} ms): ${line}`);
}
await client.close();
process.exit(failed ? 1 : 0);
