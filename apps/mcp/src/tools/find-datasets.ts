import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CITATION_STYLES,
  DATASET_DOMAINS,
  INTENDED_USES,
  LICENCE_LABELS,
  SOURCE_NAMES,
  findDatasets,
  type DatasetResult,
} from '@pho/scholar-core';
import { z } from 'zod';
import { briefPayload, briefToken, briefUrl } from '../brief-link';
import { errorResult, quotaExceededText, quotaLine, runTool, takeQuota, type ToolContext } from '../context';
import { utcDay } from '../storage';
import { quotaSchema } from './shared';

const DOMAINS = DATASET_DOMAINS as unknown as [string, ...string[]];
const USES = INTENDED_USES as unknown as [string, ...string[]];
const STYLES = CITATION_STYLES as unknown as [string, ...string[]];

export const DATASETS_DESCRIPTION = [
  'Find open scientific datasets (and optionally models) that fit a research question, check their licences, verify the source papers (DOI, retractions, corrections), and return a citable Research Data Brief with a public share link.',
  'Searches DataCite (Zenodo, Figshare, Dryad and other data repositories), the Hugging Face Hub boosted by the Hugging Science curated index, and, for life-science questions, NCBI GEO, CZ CELLxGENE Discover (curated single-cell data) and the CZ CryoET Data Portal (cryo-electron tomography).',
  'Each result has a match level, a plain-language licence verdict, the source paper and whether it checks out, a citation for the data, and a line of code to load it.',
  "Every identifier comes from the repositories' own metadata; nothing is generated. The `why` field lists the facts behind the match: explain the fit to the user in your own words from those facts, and say plainly when the brief is empty.",
  'Pass `keywords` with English search words when the question is long or not in English.',
  'Licence verdicts come from repository metadata and are not legal advice.',
].join(' ');

const resultSchema = z.object({
  rank: z.number().int(),
  kind: z.enum(['dataset', 'model']),
  source: z.enum(['datacite', 'geo', 'cellxgene', 'cryoet', 'huggingface']),
  id: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().optional(),
  match: z.enum(['best', 'good', 'use_with_care']),
  why: z.string(),
  matched_terms: z.array(z.string()),
  relevance: z.number(),
  licence: z.object({
    spdx: z.string().optional(),
    verdict: z.string(),
    label: z.string(),
    notes: z.array(z.string()),
  }),
  access: z.enum(['open', 'gated', 'unknown']),
  format: z.array(z.string()),
  size: z.string().optional(),
  n_samples: z.number().int().optional(),
  organism: z.string().optional(),
  year: z.number().int().optional(),
  dataset_doi: z.string().optional(),
  paper: z.object({
    doi: z.string().optional(),
    pmid: z.string().optional(),
    arxiv: z.string().optional(),
    status: z.enum(['verified', 'correction', 'concern', 'retracted', 'not_found', 'unchecked', 'none_linked']),
    note: z.string(),
    title: z.string().optional(),
    year: z.number().int().optional(),
    journal: z.string().optional(),
    citation: z.string().optional(),
  }),
  citation: z.string(),
  load_snippet: z.string(),
  curated: z.boolean(),
});

export const datasetsOutputSchema = {
  title: z.string(),
  share_url: z.string().optional(),
  question: z.string(),
  search_terms: z.array(z.string()),
  intended_use: z.enum(USES),
  stats: z.object({
    sources_scanned: z.number().int(),
    results: z.number().int(),
    papers_verified: z.number().int(),
    warnings: z.number().int(),
  }),
  results: z.array(resultSchema),
  takeaways: z.array(z.string()),
  warnings: z.array(z.string()),
  suggestions: z.array(z.string()),
  quota: quotaSchema,
};

const PAPER_TEXT: Record<DatasetResult['paper']['status'], string> = {
  verified: '✓ source paper verified',
  correction: '⚠ source paper has a correction',
  concern: '⚠ expression of concern on the source paper',
  retracted: '✕ source paper RETRACTED',
  not_found: '✕ listed paper not found',
  unchecked: '? source paper not fully checked',
  none_linked: '– no source paper linked',
};

const MATCH_TEXT = { best: 'Best match', good: 'Good match', use_with_care: 'Use with care' } as const;

function paperId(p: DatasetResult['paper']): string {
  if (p.doi) return `https://doi.org/${p.doi}`;
  if (p.pmid) return `PMID ${p.pmid}`;
  if (p.arxiv) return `arXiv:${p.arxiv}`;
  return '';
}

export function registerFindDatasets(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'find_datasets',
    {
      title: 'Find datasets',
      description: DATASETS_DESCRIPTION,
      inputSchema: {
        question: z
          .string()
          .trim()
          .min(3)
          .max(1000)
          .describe(
            'The research question in natural language (e.g. "gene expression in triple-negative breast cancer").',
          ),
        keywords: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe('English search keywords (e.g. "triple negative breast cancer RNA-seq"). Recommended.'),
        domain: z
          .enum(DOMAINS)
          .optional()
          .describe('Field of the question. Life-science domains also search NCBI GEO.'),
        intended_use: z
          .enum(USES)
          .default('publication')
          .describe(
            'What the data is for. `commercial` demotes anything its licence does not clear for commercial use.',
          ),
        include_models: z.boolean().default(false).describe('Also look for pretrained models on Hugging Face.'),
        max_results: z.number().int().min(1).max(5).default(3).describe('Number of results, 1–5.'),
        citation_style: z.enum(STYLES).default('apa').describe('Style for the ready-made citations.'),
      },
      outputSchema: datasetsOutputSchema,
      annotations: {
        title: 'Find datasets',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runTool(ctx, 'find_datasets', async (track) => {
        // One brief is one unit of the reference-check allowance: it checks up to five papers.
        const quota = await takeQuota(ctx, 'verifications', 1);
        if (quota.granted < 1) {
          track({ result_status: 'quota_exceeded' });
          return errorResult(quotaExceededText(ctx, quota.info), { error: 'quota_exceeded', quota: quota.info });
        }

        const r = await findDatasets(
          {
            question: args.question,
            ...(args.keywords ? { keywords: args.keywords } : {}),
            ...(args.domain ? { domain: args.domain as (typeof DATASET_DOMAINS)[number] } : {}),
            intendedUse: args.intended_use as (typeof INTENDED_USES)[number],
            includeModels: args.include_models,
            maxResults: args.max_results,
            citationStyle: args.citation_style as (typeof CITATION_STYLES)[number],
          },
          {
            http: ctx.http,
            contactEmail: ctx.config.contactEmail,
            pubmedApiKey: ctx.config.pubmedApiKey,
            hfToken: ctx.config.hfToken,
          },
        );
        track({
          result_status: r.status === 'ok' ? 'ok' : r.terms.length === 0 ? 'invalid_input' : 'upstream_unavailable',
          results: r.results.length,
          scanned: r.stats.sourcesScanned,
          papers_verified: r.stats.papersVerified,
          best: r.results.filter((d) => d.match === 'best').length,
          from_geo: r.results.filter((d) => d.source === 'geo').length,
          from_datacite: r.results.filter((d) => d.source === 'datacite').length,
          from_hf: r.results.filter((d) => d.source === 'huggingface').length,
          from_cellxgene: r.results.filter((d) => d.source === 'cellxgene').length,
          from_cryoet: r.results.filter((d) => d.source === 'cryoet').length,
          intended_use: r.intendedUse,
          domain: args.domain,
          include_models: args.include_models,
          keywords_given: !!args.keywords,
        });
        if (r.status === 'unavailable') {
          return errorResult(
            r.terms.length === 0
              ? 'The question has no searchable words. Call again with `keywords` set to English search words.'
              : 'The data repositories could not be reached just now, so no search was done. Try again in a minute; do not answer from memory.',
          );
        }

        const title = `Open data for: ${r.question.length > 90 ? `${r.question.slice(0, 89)}…` : r.question}`;
        const token = briefToken(briefPayload(r, utcDay(ctx.now?.() ?? new Date())), ctx.config.quotaSalt);
        const shareUrl = token ? briefUrl(ctx.baseUrl, token) : undefined;

        const results = r.results.map((d) => ({
          rank: d.rank,
          kind: d.kind,
          source: d.source,
          id: d.id,
          url: d.url,
          title: d.title,
          description: d.description,
          match: d.match,
          why: d.why,
          matched_terms: d.matchedTerms,
          relevance: d.relevance,
          licence: d.licence,
          access: d.access,
          format: d.formats,
          size: d.size,
          n_samples: d.nSamples,
          organism: d.organism,
          year: d.year,
          dataset_doi: d.datasetDoi,
          paper: d.paper,
          citation: d.citation,
          load_snippet: d.loadSnippet,
          curated: d.curated,
        }));

        const lines = r.results.map((d) =>
          [
            `${d.rank}. [${MATCH_TEXT[d.match]}] ${d.title} (${SOURCE_NAMES[d.source]}${d.kind === 'model' ? ' model' : ''}) ${d.url}`,
            `   Why: ${d.why}`,
            `   Licence: ${LICENCE_LABELS[d.licence.verdict]}${d.licence.spdx ? ` (${d.licence.spdx})` : ''}${d.licence.notes.length ? `. ${d.licence.notes.join(' ')}` : ''}`,
            `   Paper: ${PAPER_TEXT[d.paper.status]}${d.paper.title ? `: ${d.paper.title}` : ''}${paperId(d.paper) ? ` ${paperId(d.paper)}` : ''}. ${d.paper.note}`,
            `   Cite the data: ${d.citation}`,
            ...(d.paper.citation ? [`   Cite the paper: ${d.paper.citation}`] : []),
            `   Load: ${d.loadSnippet.replace(/\n/g, ' ⏎ ')}`,
          ].join('\n'),
        );
        const text = [
          r.results.length
            ? `${title}. ${r.results.length} result${r.results.length === 1 ? '' : 's'} from ${r.stats.sourcesScanned} candidates (searched: ${r.terms.join(' ')}); ${r.stats.papersVerified} source paper${r.stats.papersVerified === 1 ? '' : 's'} verified.`
            : `No open dataset matched "${r.question}" closely enough (searched: ${r.terms.join(' ')}, ${r.stats.sourcesScanned} candidates). Do not suggest datasets from memory.`,
          shareUrl ? `Shareable brief: ${shareUrl}` : '',
          '',
          ...lines,
          ...(r.takeaways.length ? ['', 'What this means for the research:', ...r.takeaways.map((t) => `- ${t}`)] : []),
          ...(r.suggestions.length ? ['', 'Try:', ...r.suggestions.map((s) => `- ${s}`)] : []),
          ...r.warnings.map((w) => `Note: ${w}`),
          'Licence information is taken from repository metadata; not legal advice.',
          '',
          quotaLine(quota.info),
        ]
          .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
          .join('\n');

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            title,
            ...(shareUrl ? { share_url: shareUrl } : {}),
            question: r.question,
            search_terms: r.terms,
            intended_use: r.intendedUse,
            stats: {
              sources_scanned: r.stats.sourcesScanned,
              results: r.stats.results,
              papers_verified: r.stats.papersVerified,
              warnings: r.stats.warnings,
            },
            results,
            takeaways: r.takeaways,
            warnings: r.warnings,
            suggestions: r.suggestions,
            quota: quota.info,
          },
        };
      }),
  );
}
