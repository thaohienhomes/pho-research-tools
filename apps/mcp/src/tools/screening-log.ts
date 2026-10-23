import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { screeningLog } from '@pho/scholar-core';
import { z } from 'zod';
import { runTool, type ToolContext } from '../context';
import { prismaOutputSchema, renderPrisma } from './prisma-flow-diagram';

export const MAX_SCREENING_RECORDS = 5000;

export const SCREENING_DESCRIPTION = [
  'Turn the screening decisions of a systematic review into its PRISMA 2020 counts, flow diagram and screening log.',
  'Give one row per record: its title/abstract decision (include or exclude), its full-text decision for records that passed (include, exclude or not_retrieved), and the reason for each exclusion.',
  'Every box from "records screened" down is counted from the rows, so the diagram always matches the decisions; full-text exclusions are grouped by reason.',
  'Returns the diagram (PNG, SVG, links), the counts, a CSV of every decision for the review appendix, and the problems a reviewer would catch: full-text exclusions without a reason, records still waiting for a full-text decision, and duplicate ids.',
  'Add the identification counts (records from databases, duplicates removed) to complete the top of the diagram.',
  `At most ${MAX_SCREENING_RECORDS} records per call.`,
].join(' ');

const count = z.number().int().min(0).max(100_000_000);
const named = z.object({ name: z.string().min(1).max(160), n: count });

const recordSchema = z.object({
  id: z.string().trim().min(1).max(300).describe('DOI, PMID or another id the reviewer recognises.'),
  title: z.string().max(500).optional(),
  screening: z.enum(['include', 'exclude']).describe('Title/abstract screening decision.'),
  full_text: z
    .enum(['include', 'exclude', 'not_retrieved'])
    .optional()
    .describe('Full-text decision, for records included at screening. Leave out while it is still pending.'),
  reason: z.string().max(200).optional().describe('Why the record was excluded, e.g. "Wrong population".'),
});

export const screeningOutputSchema = {
  ...prismaOutputSchema,
  screening: z.object({
    records: z.number().int(),
    excluded_at_screening: z.number().int(),
    full_text_reasons: z.array(named),
    screening_reasons: z.array(named),
    pending_full_text: z.number().int(),
    issues: z.array(z.object({ code: z.string(), message: z.string(), ids: z.array(z.string()) })),
    csv: z.string(),
  }),
};

export function registerScreeningLog(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'screening_log',
    {
      title: 'Screening log',
      description: SCREENING_DESCRIPTION,
      inputSchema: {
        records: z.array(recordSchema).min(1).max(MAX_SCREENING_RECORDS),
        identification: z
          .object({
            databases: count.optional().describe('Records identified from databases (total).'),
            databaseSources: z
              .array(named)
              .max(30)
              .optional()
              .describe('Per-database counts, e.g. [{"name":"MEDLINE","n":812}].'),
            registers: count.optional(),
            registerSources: z.array(named).max(30).optional(),
            duplicatesRemoved: count.optional(),
            automationIneligible: count.optional(),
            otherRemoved: count.optional(),
          })
          .strict()
          .optional()
          .describe('Counts before screening, for the top of the diagram.'),
        footnotes: z.boolean().default(true).describe('Print the template footnotes and source attribution.'),
      },
      outputSchema: screeningOutputSchema,
      annotations: {
        title: 'Screening log',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ records, identification, footnotes }) =>
      runTool(ctx, 'screening_log', async (track) => {
        const log = screeningLog(
          records.map((r) => ({
            id: r.id,
            ...(r.title ? { title: r.title } : {}),
            screening: r.screening,
            ...(r.full_text ? { fullText: r.full_text } : {}),
            ...(r.reason ? { reason: r.reason } : {}),
          })),
          identification ?? {},
        );
        const r = renderPrisma(ctx, { counts: log.counts, options: { footnotes } });
        track({
          result_status: 'ok',
          records: records.length,
          included: log.counts.studiesIncluded ?? 0,
          issues: log.issues.length,
          pending: log.pendingFullText,
          has_identification: !!identification,
        });

        const c = log.counts;
        const lines = [
          `${c.recordsScreened} records screened: ${c.recordsExcluded} excluded on title/abstract, ${c.reportsSought} sought in full text, ${c.reportsNotRetrieved} not retrieved, ${c.reportsAssessed} assessed, ${c.studiesIncluded} included.`,
          log.reasons.length
            ? `Full-text exclusions: ${log.reasons.map((g) => `${g.name} (${g.n})`).join('; ')}.`
            : 'No full-text exclusions.',
          ...log.issues.map((i) => `Check: ${i.message}${i.ids.length ? ` e.g. ${i.ids.slice(0, 3).join(', ')}` : ''}`),
          '',
          r.summary,
          r.linksText,
          '',
          'The full screening log is in `screening.csv` of the structured result; save it as a .csv file for the review appendix.',
        ];

        return {
          content: [r.image, { type: 'text', text: lines.join('\n') }],
          structuredContent: {
            ...r.structured,
            screening: {
              records: records.length,
              excluded_at_screening: c.recordsExcluded ?? 0,
              full_text_reasons: log.reasons,
              screening_reasons: log.screeningReasons,
              pending_full_text: log.pendingFullText,
              issues: log.issues,
              csv: log.csv,
            },
          },
        };
      }),
  );
}
