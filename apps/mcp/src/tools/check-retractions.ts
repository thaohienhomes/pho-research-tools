import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkRetractions, normalizeDoi } from '@pho/scholar-core';
import { z } from 'zod';
import { errorResult, quotaExceededText, quotaLine, runTool, takeQuota, type ToolContext } from '../context';
import { noticeSchema, quotaSchema } from './shared';

export const MAX_DOIS_PER_CALL = 50;

export const RETRACTIONS_DESCRIPTION = [
  'Check DOIs for retractions, expressions of concern and corrections, using Crossref (which includes Retraction Watch data).',
  'Status per DOI: retracted, concern, corrected, other_notice, no_notice (nothing on record), not_in_crossref, invalid_doi, rate_limited or lookup_failed (the DOI could not be checked, which is not a clean result).',
  'Works for a single paper or a whole reference list.',
].join(' ');

const STATUS_TEXT: Record<string, string> = {
  retracted: 'RETRACTED',
  concern: 'expression of concern',
  corrected: 'corrected',
  other_notice: 'has an editorial notice',
  no_notice: 'no notice on record',
  not_in_crossref: 'not a Crossref DOI (could not check)',
  invalid_doi: 'not a valid DOI',
  rate_limited: 'could not check (rate limited)',
  lookup_failed: 'could not check',
};

export const retractionsOutputSchema = {
  results: z.array(
    z.object({
      doi: z.string(),
      status: z.string(),
      title: z.string().optional(),
      notices: z.array(noticeSchema),
    }),
  ),
  counts: z.record(z.number().int()),
  quota: quotaSchema,
};

export function registerCheckRetractions(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'check_retractions',
    {
      title: 'Check retractions',
      description: RETRACTIONS_DESCRIPTION,
      inputSchema: {
        dois: z
          .array(z.string().trim().min(1).max(300))
          .min(1)
          .max(MAX_DOIS_PER_CALL)
          .describe('DOIs, bare (10.1000/xyz) or as https://doi.org/ links.'),
      },
      outputSchema: retractionsOutputSchema,
      annotations: { title: 'Check retractions', readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ dois }) =>
      runTool(ctx, 'check_retractions', async (track) => {
        // Dedupe on the canonical DOI, so a link and a bare spelling of the same
        // work cost one unit. Unparseable input is kept as typed; it still gets
        // its own line saying the lookup failed.
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const d of dois) {
          const key = normalizeDoi(d) ?? d;
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(d);
        }
        const quota = await takeQuota(ctx, 'verifications', unique.length);
        if (quota.granted < 1) {
          track({ result_status: 'quota_exceeded' });
          return errorResult(quotaExceededText(ctx, quota.info), { error: 'quota_exceeded', quota: quota.info });
        }
        const checked = await checkRetractions(ctx.http, unique.slice(0, quota.granted), {
          contactEmail: ctx.config.contactEmail,
          budgetMs: 45_000,
        });
        const results = [
          ...checked.map((c) => ({
            doi: c.doi,
            status: c.status,
            ...(c.title ? { title: c.title } : {}),
            notices: c.notices.map((n) => ({ type: n.type, label: n.label, date: n.date, source: n.source, notice_doi: n.noticeDoi })),
          })),
          ...unique.slice(quota.granted).map((d) => ({ doi: d, status: 'not_checked', notices: [] })),
        ];
        const counts: Record<string, number> = {};
        for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
        track({
          result_status: quota.granted < unique.length ? 'partial' : 'ok',
          dois: unique.length,
          retracted: counts.retracted ?? 0,
          concern: counts.concern ?? 0,
          unchecked: (counts.lookup_failed ?? 0) + (counts.rate_limited ?? 0) + (counts.not_checked ?? 0),
        });

        const lines = results.map((r) => {
          const notice = r.notices[0];
          const detail = notice ? ` (${notice.label}${notice.date ? `, ${notice.date}` : ''}${notice.notice_doi ? `, https://doi.org/${notice.notice_doi}` : ''})` : '';
          const label = r.status === 'not_checked' ? 'not checked: allowance used up' : (STATUS_TEXT[r.status] ?? r.status);
          return `- ${r.doi}: ${label}${detail}`;
        });
        return {
          content: [{ type: 'text', text: [...lines, '', quotaLine(quota.info)].join('\n') }],
          structuredContent: { results, counts, quota: quota.info },
        };
      }),
  );
}
