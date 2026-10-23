import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EVIDENCE_LABELS, EVIDENCE_LEVELS, findEvidence } from '@pho/scholar-core';
import { z } from 'zod';
import { errorResult, runTool, type ToolContext } from '../context';

const LEVELS = EVIDENCE_LEVELS as unknown as [string, ...string[]];

export const EVIDENCE_DESCRIPTION = [
  'Find the strongest published evidence for and against a scientific or medical claim.',
  'Searches PubMed (including a pass limited to guidelines, meta-analyses, systematic reviews and randomized trials) and OpenAlex, and returns real papers, each with a PMID or DOI, ordered by level of evidence: guideline, meta-analysis, systematic review, RCT, other trial, observational study, narrative review, case report, then study protocols that have not reported results yet.',
  'Each paper comes with the conclusion copied verbatim from its abstract, so you can judge for yourself whether it supports the claim, contradicts it, or does not address it, and quote the sentence you rely on.',
  'The tool does not judge stance and does not summarise: count a paper as support or contradiction only when its conclusion says so.',
  'Pass `query` with English search keywords when the claim is long or not in English.',
  'Retracted papers and correction notices are left out. Preprints are included and marked (not peer reviewed).',
].join(' ');

const paperSchema = z.object({
  rank: z.number().int(),
  level: z.enum(LEVELS),
  level_label: z.string(),
  level_from: z.enum(['publication-type', 'title']),
  title: z.string(),
  authors: z.string().optional(),
  year: z.number().int().optional(),
  journal: z.string().optional(),
  doi: z.string().optional(),
  pmid: z.string().optional(),
  url: z.string(),
  conclusion: z.string().optional(),
  conclusion_from: z.enum(['section', 'last-sentences']).optional(),
  abstract: z.string().optional(),
  preprint: z.boolean(),
  open_access: z.boolean(),
  cited_by_count: z.number().int().optional(),
  found_in: z.array(z.string()),
});

export const evidenceOutputSchema = {
  claim: z.string(),
  query: z.string(),
  status: z.enum(['ok', 'unavailable']),
  papers: z.array(paperSchema),
  by_level: z.record(z.string(), z.number().int()),
  excluded: z.object({ retracted: z.number().int(), notices: z.number().int(), preprints: z.number().int() }),
  without_abstract: z.number().int(),
  warnings: z.array(z.string()),
};

export function registerFindEvidence(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'find_evidence',
    {
      title: 'Find evidence',
      description: EVIDENCE_DESCRIPTION,
      inputSchema: {
        claim: z
          .string()
          .trim()
          .min(3)
          .max(1000)
          .describe('The claim to check, as a sentence (e.g. "Drinking coffee reduces the risk of type 2 diabetes").'),
        query: z
          .string()
          .trim()
          .max(300)
          .optional()
          .describe(
            'English search keywords for the claim (e.g. "coffee consumption type 2 diabetes risk"). Recommended.',
          ),
        year_from: z.number().int().min(1800).max(2100).optional().describe('Earliest publication year, inclusive.'),
        year_to: z.number().int().min(1800).max(2100).optional().describe('Latest publication year, inclusive.'),
        max_results: z.number().int().min(1).max(25).default(15).describe('Number of papers, 1–25.'),
        include_preprints: z.boolean().default(true).describe('Keep preprints (marked as not peer reviewed).'),
      },
      outputSchema: evidenceOutputSchema,
      annotations: {
        title: 'Find evidence',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runTool(ctx, 'find_evidence', async (track) => {
        const r = await findEvidence(
          args.claim,
          {
            ...(args.query ? { query: args.query } : {}),
            ...(args.year_from !== undefined ? { yearFrom: args.year_from } : {}),
            ...(args.year_to !== undefined ? { yearTo: args.year_to } : {}),
            maxResults: args.max_results,
            includePreprints: args.include_preprints,
          },
          {
            http: ctx.http,
            contactEmail: ctx.config.contactEmail,
            pubmedApiKey: ctx.config.pubmedApiKey,
            openalexApiKey: ctx.config.openalexApiKey,
          },
        );
        track({
          result_status: r.status === 'ok' ? 'ok' : r.query.length < 3 ? 'invalid_input' : 'upstream_unavailable',
          results: r.papers.length,
          syntheses:
            (r.byLevel.guideline ?? 0) + (r.byLevel['meta-analysis'] ?? 0) + (r.byLevel['systematic-review'] ?? 0),
          without_abstract: r.withoutAbstract,
          query_given: !!args.query,
        });
        if (r.status === 'unavailable') {
          return errorResult(
            r.query.length < 3
              ? 'The claim has no searchable words. Call again with `query` set to English keywords.'
              : 'PubMed and OpenAlex could not be reached just now, so no search was done. Try again in a minute; do not answer from memory.',
          );
        }

        const papers = r.papers.map((p) => ({
          rank: p.rank,
          level: p.level,
          level_label: EVIDENCE_LABELS[p.level],
          level_from: p.levelFrom,
          title: p.title,
          authors: p.authors,
          year: p.year,
          journal: p.journal,
          doi: p.doi,
          pmid: p.pmid,
          url: p.url,
          conclusion: p.conclusion,
          conclusion_from: p.conclusionFrom,
          abstract: p.abstract,
          preprint: p.preprint,
          open_access: p.openAccess,
          cited_by_count: p.citedByCount,
          found_in: p.foundIn,
        }));

        const lines = papers.map((p) => {
          const tags = [p.level_label, p.preprint ? 'preprint, not peer reviewed' : ''].filter(Boolean).join('; ');
          const head = `${p.rank}. [${tags}] ${p.title} (${p.authors ?? 'Unknown author'}, ${p.year ?? 'n.d.'}${p.journal ? `, ${p.journal}` : ''}) ${p.url}`;
          const body = p.conclusion
            ? `   ${p.conclusion_from === 'section' ? 'Conclusion' : 'End of abstract'}: "${p.conclusion}"`
            : '   No abstract available here; open the link before relying on it.';
          return `${head}\n${body}`;
        });
        const counts = EVIDENCE_LEVELS.filter((l) => r.byLevel[l])
          .map((l) => `${r.byLevel[l]} ${EVIDENCE_LABELS[l].toLowerCase()}`)
          .join(', ');
        const text = [
          papers.length
            ? `${papers.length} papers on "${r.claim}" (searched: ${r.query}), strongest evidence first: ${counts}.`
            : `No papers found for "${r.claim}" (searched: ${r.query}). Try broader English keywords in \`query\`.`,
          papers.length
            ? 'For each paper, decide from its conclusion whether it supports the claim, contradicts it, or does not address it, and quote it. These are search results, not a verdict.'
            : '',
          '',
          ...lines,
          ...r.warnings.map((w) => `Note: ${w}`),
        ]
          .filter((l, i) => l !== '' || i === 2)
          .join('\n');

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            claim: r.claim,
            query: r.query,
            status: r.status,
            papers,
            by_level: r.byLevel,
            excluded: r.excluded,
            without_abstract: r.withoutAbstract,
            warnings: r.warnings,
          },
        };
      }),
  );
}
