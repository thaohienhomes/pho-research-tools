import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prismaFlowDiagram } from '@pho/scholar-core';
import { svgToPng } from '@pho/scholar-core/png';
import { z } from 'zod';
import { runTool, type ToolContext } from '../context';
import { prismaLinks, type PrismaPayload } from '../prisma-link';

export const PRISMA_DESCRIPTION = [
  'Draw a PRISMA 2020 flow diagram for a new systematic review from the record counts, as a PNG image plus an SVG and download links.',
  'Give the counts you have; screened, sought, assessed and reports-included boxes that follow from others are filled in and marked as derived. Studies included is never derived.',
  'The tool checks that the numbers add up (records identified minus removed equals screened, and so on) and returns a warning naming each box that does not, with the value it should have. The diagram always shows the numbers exactly as given.',
  'Add `otherMethods` counts to draw the second column (websites, organisations, citation searching).',
].join(' ');

const count = z.number().int().min(0).max(100_000_000);
const named = z.object({ name: z.string().min(1).max(160), n: count });

export const prismaCountsSchema = z
  .object({
    databases: count.optional().describe('Records identified from databases, all databases together, before duplicates are removed. Leave out when databaseSources is given: it is their sum.'),
    databaseSources: z
      .array(named)
      .max(30)
      .optional()
      .describe('Per-database counts before deduplication, e.g. [{"name":"MEDLINE","n":812}]. If databases is also given, the two are compared.'),
    registers: count.optional().describe('Records identified from trial registers (ClinicalTrials.gov, ICTRP…), before duplicates are removed.'),
    registerSources: z.array(named).max(30).optional(),
    duplicatesRemoved: count.optional().describe('Duplicate records removed before screening.'),
    automationIneligible: count.optional().describe('Records marked ineligible by automation tools.'),
    otherRemoved: count.optional().describe('Records removed for other reasons before screening.'),
    recordsScreened: count.optional().describe('Records screened on title and abstract. Derived when left out: identified minus removed before screening.'),
    recordsExcluded: count.optional().describe('Records excluded at title and abstract screening (not reports excluded at full text).'),
    reportsSought: count.optional().describe('Full-text reports sought for retrieval. Derived when left out: screened minus excluded.'),
    reportsNotRetrieved: count.optional().describe('Reports that could not be retrieved.'),
    reportsAssessed: count.optional().describe('Full-text reports assessed for eligibility. Derived when left out: sought minus not retrieved.'),
    reportsExcludedReasons: z.array(named).max(30).optional().describe('Full-text reports excluded, one entry per reason, e.g. [{"name":"Wrong population","n":12}].'),
    reportsExcluded: count.optional().describe('Total full-text reports excluded. If reasons are also given, their sum is compared with it.'),
    studiesIncluded: count.optional().describe('Studies included in the review. Never derived: one study can have several reports, so give it. It cannot exceed reportsIncluded.'),
    reportsIncluded: count.optional().describe('Reports of included studies. Derived when left out: assessed minus excluded (both columns when otherMethods is drawn).'),
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

/** Draw the diagram, rasterise it and build the download links: shared with `screening_log`. */
export function renderPrisma(ctx: ToolContext, payload: PrismaPayload) {
  const d = prismaFlowDiagram(payload.counts, payload.options);
  const links = prismaLinks(ctx.baseUrl, payload);
  const png = Buffer.from(svgToPng(d.svg, { scale: 1.5 })).toString('base64');
  return {
    diagram: d,
    image: { type: 'image' as const, data: png, mimeType: 'image/png' },
    summary: d.warnings.length
      ? `The diagram is drawn with the numbers as given, but ${d.warnings.length} count(s) do not add up:\n${d.warnings.map((w) => `- ${w.message}`).join('\n')}`
      : 'All counts add up.',
    linksText: links
      ? `PNG: ${links.png}\nSVG: ${links.svg}`
      : 'The counts are too long to fit in a download link; use the SVG in the result.',
    structured: {
      ...(links ? { image_url: links.png, svg_url: links.svg } : {}),
      svg: d.svg,
      width: d.width,
      height: d.height,
      warnings: d.warnings,
      counts: d.counts,
    },
  };
}

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
      annotations: {
        title: 'PRISMA 2020 flow diagram',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async ({ counts, other_methods_column, footnotes }) =>
      runTool(ctx, 'prisma_flow_diagram', async (track) => {
        const payload: PrismaPayload = {
          counts,
          options: { ...(other_methods_column !== undefined ? { otherMethods: other_methods_column } : {}), footnotes },
        };
        const r = renderPrisma(ctx, payload);
        track({
          result_status: 'ok',
          warnings: r.diagram.warnings.length,
          other_methods: other_methods_column ?? Boolean(counts.otherMethods),
        });
        return {
          content: [r.image, { type: 'text', text: [r.summary, r.linksText].join('\n\n') }],
          structuredContent: r.structured,
        };
      }),
  );
}
