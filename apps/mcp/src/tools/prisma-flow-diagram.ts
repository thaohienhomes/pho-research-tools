import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prismaFlowDiagram } from '@pho/scholar-core';
import { svgToPng } from '@pho/scholar-core/png';
import { z } from 'zod';
import { runTool, type ToolContext } from '../context';
import { prismaLinks, type PrismaPayload } from '../prisma-link';

export const PRISMA_DESCRIPTION = [
  'Draw a PRISMA 2020 flow diagram for a new systematic review from the record counts, as a PNG image plus an SVG and download links.',
  'Give the counts you have; boxes that follow arithmetically from others are filled in and marked as derived.',
  'The tool checks that the numbers add up (records identified minus removed equals screened, and so on) and returns a warning naming each box that does not, with the value it should have. The diagram always shows the numbers exactly as given.',
  'Add `otherMethods` counts to draw the second column (websites, organisations, citation searching).',
].join(' ');

const count = z.number().int().min(0).max(100_000_000);
const named = z.object({ name: z.string().min(1).max(160), n: count });

export const prismaCountsSchema = z
  .object({
    databases: count.optional().describe('Records identified from databases (total).'),
    databaseSources: z.array(named).max(30).optional().describe('Per-database counts, e.g. [{"name":"MEDLINE","n":812}].'),
    registers: count.optional().describe('Records identified from registers.'),
    registerSources: z.array(named).max(30).optional(),
    duplicatesRemoved: count.optional(),
    automationIneligible: count.optional().describe('Records marked ineligible by automation tools.'),
    otherRemoved: count.optional().describe('Records removed for other reasons before screening.'),
    recordsScreened: count.optional(),
    recordsExcluded: count.optional(),
    reportsSought: count.optional().describe('Reports sought for retrieval.'),
    reportsNotRetrieved: count.optional(),
    reportsAssessed: count.optional().describe('Reports assessed for eligibility.'),
    reportsExcludedReasons: z.array(named).max(30).optional().describe('Reports excluded, one entry per reason.'),
    reportsExcluded: count.optional().describe('Total reports excluded, when reasons are not itemised.'),
    studiesIncluded: count.optional().describe('Studies included in the review.'),
    reportsIncluded: count.optional().describe('Reports of included studies.'),
    otherMethods: z
      .object({
        websites: count.optional(),
        organisations: count.optional(),
        citationSearching: count.optional(),
        sources: z.array(named).max(30).optional(),
        reportsSought: count.optional(),
        reportsNotRetrieved: count.optional(),
        reportsAssessed: count.optional(),
        reportsExcludedReasons: z.array(named).max(30).optional(),
        reportsExcluded: count.optional(),
      })
      .strict()
      .optional()
      .describe('Counts for the "identification via other methods" column.'),
  })
  .strict();

export const prismaOptionsSchema = z
  .object({
    otherMethods: z.boolean().optional(),
    footnotes: z.boolean().optional(),
  })
  .strict();

export const prismaPayloadSchema = z.object({ counts: prismaCountsSchema, options: prismaOptionsSchema.optional() });

export const prismaOutputSchema = {
  image_url: z.string().optional(),
  svg_url: z.string().optional(),
  svg: z.string(),
  width: z.number(),
  height: z.number(),
  warnings: z.array(
    z.object({
      code: z.string(),
      field: z.string(),
      message: z.string(),
      expected: z.number().optional(),
      given: z.number().optional(),
    }),
  ),
  counts: z.record(z.object({ value: z.number().optional(), derived: z.boolean() })),
};

export function registerPrismaFlowDiagram(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'prisma_flow_diagram',
    {
      title: 'PRISMA 2020 flow diagram',
      description: PRISMA_DESCRIPTION,
      inputSchema: {
        counts: prismaCountsSchema,
        other_methods_column: z
          .boolean()
          .optional()
          .describe('Force the other-methods column on or off. Default: drawn when otherMethods counts are given.'),
        footnotes: z.boolean().default(true).describe('Print the template footnotes and source attribution.'),
      },
      outputSchema: prismaOutputSchema,
      annotations: { title: 'PRISMA 2020 flow diagram', readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ counts, other_methods_column, footnotes }) =>
      runTool(ctx, 'prisma_flow_diagram', async (track) => {
        const payload: PrismaPayload = {
          counts,
          options: { ...(other_methods_column !== undefined ? { otherMethods: other_methods_column } : {}), footnotes },
        };
        const d = prismaFlowDiagram(payload.counts, payload.options);
        const links = prismaLinks(ctx.baseUrl, payload);
        const png = Buffer.from(svgToPng(d.svg, { scale: 1.5 })).toString('base64');
        track({
          result_status: 'ok',
          warnings: d.warnings.length,
          other_methods: other_methods_column ?? Boolean(counts.otherMethods),
        });

        const text = [
          d.warnings.length
            ? `The diagram is drawn with the numbers as given, but ${d.warnings.length} count(s) do not add up:\n${d.warnings.map((w) => `- ${w.message}`).join('\n')}`
            : 'All counts add up.',
          links ? `PNG: ${links.png}\nSVG: ${links.svg}` : 'The counts are too long to fit in a download link; use the SVG in the result.',
        ].join('\n\n');

        return {
          content: [
            { type: 'image', data: png, mimeType: 'image/png' },
            { type: 'text', text },
          ],
          structuredContent: {
            ...(links ? { image_url: links.png, svg_url: links.svg } : {}),
            svg: d.svg,
            width: d.width,
            height: d.height,
            warnings: d.warnings,
            counts: d.counts,
          },
        };
      }),
  );
}
