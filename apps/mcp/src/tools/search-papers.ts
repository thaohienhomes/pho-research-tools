import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { STUDY_TYPES, searchPapers } from '@pho/scholar-core';
import { z } from 'zod';
import { errorResult, runTool, type ToolContext } from '../context';

const KNOWN_TYPES = Object.keys(STUDY_TYPES).join(', ');

export const SEARCH_DESCRIPTION = [
  'Search PubMed and OpenAlex for real papers. Every result carries a DOI or PubMed ID that resolves, so nothing returned can be fabricated.',
  'Finds sources for a claim or a topic.',
  'Filters: publication year range, open-access only, study types, and the number of results.',
  'Retracted papers are left out by default. Preprints are included and marked `preprint: true` (not peer reviewed).',
  'Results are ranked by the databases\' relevance, alternating between the two sources.',
].join(' ');

const paperSchema = z.object({
  rank: z.number().int(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().optional(),
  journal: z.string().optional(),
  doi: z.string().optional(),
  pmid: z.string().optional(),
  url: z.string(),
  links: z.object({}).passthrough(),
  open_access: z.object({ is_oa: z.boolean(), url: z.string().optional() }),
  found_in: z.array(z.string()),
  study_type_match: z.string().optional(),
  retracted: z.boolean(),
  preprint: z.boolean(),
  cited_by_count: z.number().int().optional(),
});

export const searchOutputSchema = {
  query: z.string(),
  status: z.enum(['ok', 'unavailable']),
  results: z.array(paperSchema),
  excluded: z.object({
    no_identifier: z.number().int(),
    retracted: z.number().int(),
    notices: z.number().int(),
    outside_years: z.number().int(),
  }),
  warnings: z.array(z.string()),
};

export function registerSearchPapers(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_papers',
    {
      title: 'Search papers',
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z.string().trim().min(2).max(500).describe('What to look for, in English keywords (e.g. "sepsis early antibiotics mortality").'),
        year_from: z.number().int().min(1800).max(2100).optional().describe('Earliest publication year, inclusive.'),
        year_to: z.number().int().min(1800).max(2100).optional().describe('Latest publication year, inclusive.'),
        open_access_only: z.boolean().default(false).describe('Only papers with a free, legal full text.'),
        study_types: z
          .array(z.string().max(60))
          .max(5)
          .optional()
          .describe(`Study designs. Known ids use database filters: ${KNOWN_TYPES}. Any other text is added as keywords.`),
        max_results: z.number().int().min(1).max(50).default(10).describe('Number of results, 1–50.'),
        include_retracted: z.boolean().default(false).describe('Keep retracted papers (flagged) instead of leaving them out.'),
      },
      outputSchema: searchOutputSchema,
      annotations: { title: 'Search papers', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool(ctx, 'search_papers', async (track) => {
        const r = await searchPapers(
          args.query,
          {
            yearFrom: args.year_from,
            yearTo: args.year_to,
            openAccessOnly: args.open_access_only,
            studyTypes: args.study_types,
            maxResults: args.max_results,
            includeRetracted: args.include_retracted,
          },
          {
            http: ctx.http,
            contactEmail: ctx.config.contactEmail,
            pubmedApiKey: ctx.config.pubmedApiKey,
            openalexApiKey: ctx.config.openalexApiKey,
          },
        );
        track({
          result_status: r.status === 'ok' ? 'ok' : 'upstream_unavailable',
          results: r.results.length,
          filter_years: args.year_from !== undefined || args.year_to !== undefined,
          filter_oa: args.open_access_only,
          filter_study_types: args.study_types?.length ?? 0,
        });
        if (r.status === 'unavailable') {
          return errorResult(
            'PubMed and OpenAlex could not be reached just now, so no search was done. Try again in a minute; do not fall back to references from memory.',
          );
        }

        const results = r.results.map((p) => ({
          rank: p.rank,
          title: p.title,
          authors: p.authors,
          year: p.year,
          journal: p.journal,
          doi: p.doi,
          pmid: p.pmid,
          url: p.url,
          links: p.links,
          open_access: { is_oa: p.openAccess.isOa, url: p.openAccess.url },
          found_in: p.foundIn,
          study_type_match: p.studyTypeMatch,
          retracted: p.retracted,
          preprint: p.preprint,
          cited_by_count: p.citedByCount,
        }));
        const lines = results.map((p) => {
          const tags = [p.preprint ? 'preprint, not peer reviewed' : '', p.retracted ? 'RETRACTED' : '', p.open_access.is_oa ? 'open access' : '']
            .filter(Boolean)
            .join('; ');
          const who = p.authors.length ? `${p.authors[0]}${p.authors.length > 1 ? ' et al.' : ''}` : 'Unknown author';
          return `${p.rank}. ${p.title} (${who}, ${p.year ?? 'n.d.'}${p.journal ? `, ${p.journal}` : ''}) ${p.url}${tags ? ` [${tags}]` : ''}`;
        });
        const text = [
          results.length ? `${results.length} papers for "${r.query}":` : `No papers found for "${r.query}" with these filters.`,
          ...lines,
          ...r.warnings.map((w) => `Note: ${w}`),
        ].join('\n');

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            query: r.query,
            status: r.status,
            results,
            excluded: {
              no_identifier: r.excluded.noIdentifier,
              retracted: r.excluded.retracted,
              notices: r.excluded.notices,
              outside_years: r.excluded.outsideYears,
            },
            warnings: r.warnings,
          },
        };
      }),
  );
}
