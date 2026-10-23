import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkRetractions, normalizeDoi, summaryNotice } from '@pho/scholar-core';
import { z } from 'zod';
import { errorResult, quotaExceededText, quotaLine, runTool, takeQuota, type ToolContext } from '../context';
import { RecentChecks } from '../recent-checks';
import { noticeSchema, quotaSchema } from './shared';

export const MAX_DOIS_PER_CALL = 50;

export const RETRACTIONS_DESCRIPTION = [
  'Check DOIs for retractions, expressions of concern and corrections, using Crossref (which includes Retraction Watch data).',
  'Status per DOI: retracted, concern, corrected, other_notice, no_notice (nothing on record), not_in_crossref, invalid_doi, rate_limited or lookup_failed (the DOI could not be checked, which is not a clean result).',
  'Works for a single paper or a whole reference list.',
  'verify_references already includes this check, so use this tool for DOIs that have not just been through verify_references.',
  'A DOI the same caller checked in the last hour is answered again at no cost to the allowance.',
].join(' ');

type Row = { doi: string; status: string; title?: string; notices: z.infer<typeof noticeSchema>[] };
/** Statuses worth repeating without a lookup: a failed lookup must be retried, not remembered. */
const DEFINITIVE = new Set(['retracted', 'concern', 'corrected', 'other_notice', 'no_notice', 'not_in_crossref', 'invalid_doi']);
const recent = new RecentChecks<Row>();

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
        const now = (ctx.now?.() ?? new Date()).getTime();
        const keyOf = (d: string) => normalizeDoi(d) ?? d;
        const remembered = new Map<string, Row>();
        for (const d of unique) {
          const hit = recent.get(ctx.caller.subject, keyOf(d), now);
          if (hit) remembered.set(d, hit);
        }
        const fresh = unique.filter((d) => !remembered.has(d));
        const quota = await takeQuota(ctx, 'verifications', fresh.length);
        if (fresh.length > 0 && quota.granted < 1 && remembered.size === 0) {
          track({ result_status: 'quota_exceeded' });
          return errorResult(quotaExceededText(ctx, quota.info), { error: 'quota_exceeded', quota: quota.info });
        }
        const checked = fresh.length
          ? await checkRetractions(ctx.http, fresh.slice(0, quota.granted), {
              contactEmail: ctx.config.contactEmail,
              budgetMs: 45_000,
            })
          : [];
        const byInput = new Map<string, Row>();
        fresh.slice(0, quota.granted).forEach((d, i) => {
          const c = checked[i];
          if (!c) return;
          const row: Row = {
            doi: c.doi,
            status: c.status,
            ...(c.title ? { title: c.title } : {}),
            notices: c.notices.map((n) => ({ type: n.type, label: n.label, date: n.date, source: n.source, notice_doi: n.noticeDoi })),
          };
          byInput.set(d, row);
          if (DEFINITIVE.has(row.status)) recent.set(ctx.caller.subject, keyOf(d), row, now);
        });
        const results: Row[] = unique.map(
          (d) => remembered.get(d) ?? byInput.get(d) ?? { doi: d, status: 'not_checked', notices: [] },
        );
        const counts: Record<string, number> = {};
        for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
        track({
          result_status: quota.granted < fresh.length ? 'partial' : 'ok',
          dois: unique.length,
          repeated: remembered.size,
          retracted: counts.retracted ?? 0,
          concern: counts.concern ?? 0,
          unchecked: (counts.lookup_failed ?? 0) + (counts.rate_limited ?? 0) + (counts.not_checked ?? 0),
        });

        const lines = results.map((r) => {
          const notice = summaryNotice(r.notices);
          const detail = notice ? ` (${notice.label}${notice.date ? `, ${notice.date}` : ''}${notice.notice_doi ? `, https://doi.org/${notice.notice_doi}` : ''})` : '';
          const label = r.status === 'not_checked' ? 'not checked: allowance used up' : (STATUS_TEXT[r.status] ?? r.status);
          return `- ${r.doi}: ${label}${detail}`;
        });
        const repeat = remembered.size
          ? `${remembered.size} of these DOIs were checked earlier this hour; their results are repeated at no cost.`
          : '';
        return {
          content: [{ type: 'text', text: [...lines, '', ...(repeat ? [repeat] : []), quotaLine(quota.info)].join('\n') }],
          structuredContent: { results, counts, quota: quota.info },
        };
      }),
  );
}
