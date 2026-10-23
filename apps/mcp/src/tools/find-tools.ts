import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CITATION_STYLES,
  INTENDED_USES,
  LICENCE_LABELS,
  findTools,
  type ToolHealth,
  type ToolResult,
} from '@pho/scholar-core';
import { z } from 'zod';
import {
  errorResult,
  quotaExceededText,
  quotaLine,
  runTool,
  takeQuota,
  type ToolContext,
} from '../context';
import { quotaSchema } from './shared';

const USES = INTENDED_USES as unknown as [string, ...string[]];
const STYLES = CITATION_STYLES as unknown as [string, ...string[]];

export const TOOLS_DESCRIPTION = [
  "Find research software for a task from the bio.tools registry (ELIXIR), check each tool's licence, verify the paper behind it (DOI, retractions, corrections), label whether it is still maintained, and give the install line.",
  'Describe the task (e.g. "cluster single-cell RNA-seq data") and optionally the file format the data is in (e.g. H5AD, FASTQ, VCF); tools that list that format as an input are favoured.',
  'Each result has a match level, a plain-language licence verdict, the paper and whether it checks out, a maintenance label (active, idle, stale, archived) read from the linked GitHub repository, and an install line built from a PyPI, Bioconda, Bioconductor, CRAN or GitHub link the registry lists.',
  "Every identifier and command comes from the registry's own records; nothing is generated. The `why` field lists the facts behind the match: explain the fit in your own words from those facts, and say plainly when no tool matched.",
  'Pass `keywords` with English words when the task is long or not in English.',
  'Licence verdicts come from registry and repository metadata and are not legal advice.',
].join(' ');

const HEALTH = [
  'active',
  'idle',
  'stale',
  'archived',
  'unknown',
] as const satisfies readonly ToolHealth[];

const resultSchema = z.object({
  rank: z.number().int(),
  id: z.string(),
  name: z.string(),
  url: z.string(),
  homepage: z.string().optional(),
  description: z.string().optional(),
  match: z.enum(['best', 'good', 'use_with_care']),
  why: z.string(),
  matched_terms: z.array(z.string()),
  relevance: z.number(),
  operations: z.array(z.string()),
  input_formats: z.array(z.string()),
  output_formats: z.array(z.string()),
  languages: z.array(z.string()),
  reads_requested_format: z.boolean().optional(),
  licence: z.object({
    spdx: z.string().optional(),
    verdict: z.string(),
    label: z.string(),
    notes: z.array(z.string()),
  }),
  paper: z.object({
    doi: z.string().optional(),
    pmid: z.string().optional(),
    status: z.enum([
      'verified',
      'correction',
      'concern',
      'retracted',
      'not_found',
      'unchecked',
      'none_linked',
    ]),
    note: z.string(),
    title: z.string().optional(),
    year: z.number().int().optional(),
    journal: z.string().optional(),
    citation: z.string().optional(),
  }),
  paper_is_preprint: z.boolean().optional(),
  health: z.object({ label: z.enum(HEALTH), note: z.string(), last_push: z.string().optional() }),
  install: z
    .object({
      kind: z.enum(['pip', 'conda', 'bioconductor', 'cran', 'source']),
      line: z.string(),
      from: z.string(),
    })
    .optional(),
});

export const toolsOutputSchema = {
  question: z.string(),
  search_terms: z.array(z.string()),
  input_format: z.string().optional(),
  intended_use: z.enum(USES),
  stats: z.object({
    candidates: z.number().int(),
    results: z.number().int(),
    papers_verified: z.number().int(),
    warnings: z.number().int(),
  }),
  results: z.array(resultSchema),
  takeaways: z.array(z.string()),
  warnings: z.array(z.string()),
  suggestions: z.array(z.string()),
  data_note: z.string(),
  quota: quotaSchema,
};

const PAPER_TEXT: Record<ToolResult['paper']['status'], string> = {
  verified: '✓ paper verified',
  correction: '⚠ paper has a correction',
  concern: '⚠ expression of concern on the paper',
  retracted: '✕ paper RETRACTED',
  not_found: '✕ listed paper not found',
  unchecked: '? paper not fully checked',
  none_linked: '– no paper listed',
};

const HEALTH_TEXT: Record<ToolHealth, string> = {
  active: 'Active',
  idle: 'Idle',
  stale: 'Stale',
  archived: 'Archived',
  unknown: 'Maintenance unknown',
};

const MATCH_TEXT = {
  best: 'Best match',
  good: 'Good match',
  use_with_care: 'Use with care',
} as const;

function paperId(p: ToolResult['paper']): string {
  if (p.doi) return `https://doi.org/${p.doi}`;
  if (p.pmid) return `PMID ${p.pmid}`;
  return '';
}

export function registerFindTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'find_tools',
    {
      title: 'Find research software',
      description: TOOLS_DESCRIPTION,
      inputSchema: {
        question: z
          .string()
          .trim()
          .min(3)
          .max(1000)
          .describe('The task in natural language (e.g. "cluster single-cell RNA-seq data").'),
        keywords: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe('English search keywords (e.g. "single-cell clustering"). Recommended.'),
        input_format: z
          .string()
          .trim()
          .max(30)
          .optional()
          .describe(
            'The file format the data is in (e.g. "H5AD", "FASTQ", "VCF"). Tools that read it are favoured.',
          ),
        intended_use: z
          .enum(USES)
          .default('publication')
          .describe(
            'What the software is for. `commercial` demotes anything its licence does not clear.',
          ),
        max_results: z.number().int().min(1).max(5).default(3).describe('Number of results, 1–5.'),
        citation_style: z
          .enum(STYLES)
          .default('apa')
          .describe('Style for the ready-made paper citations.'),
      },
      outputSchema: toolsOutputSchema,
      annotations: {
        title: 'Find research software',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      runTool(ctx, 'find_tools', async (track) => {
        // One answer is one unit of the reference-check allowance: it checks up to five papers.
        const quota = await takeQuota(ctx, 'verifications', 1);
        if (quota.granted < 1) {
          track({ result_status: 'quota_exceeded' });
          return errorResult(quotaExceededText(ctx, quota.info), {
            error: 'quota_exceeded',
            quota: quota.info,
          });
        }

        const r = await findTools(
          {
            question: args.question,
            ...(args.keywords ? { keywords: args.keywords } : {}),
            ...(args.input_format ? { inputFormat: args.input_format } : {}),
            intendedUse: args.intended_use as (typeof INTENDED_USES)[number],
            maxResults: args.max_results,
            citationStyle: args.citation_style as (typeof CITATION_STYLES)[number],
          },
          {
            http: ctx.http,
            contactEmail: ctx.config.contactEmail,
            pubmedApiKey: ctx.config.pubmedApiKey,
            githubToken: ctx.config.githubToken,
          },
        );
        track({
          result_status:
            r.status === 'ok'
              ? 'ok'
              : r.terms.length === 0
                ? 'invalid_input'
                : 'upstream_unavailable',
          results: r.results.length,
          candidates: r.stats.candidates,
          papers_verified: r.stats.papersVerified,
          best: r.results.filter((t) => t.match === 'best').length,
          active: r.results.filter((t) => t.health.label === 'active').length,
          with_install: r.results.filter((t) => t.install).length,
          intended_use: r.intendedUse,
          format_given: !!args.input_format,
          keywords_given: !!args.keywords,
        });
        if (r.status === 'unavailable') {
          return errorResult(
            r.terms.length === 0
              ? 'The task has no searchable words. Call again with `keywords` set to English search words.'
              : 'The tool registry could not be reached just now, so no search was done. Try again in a minute; do not answer from memory.',
          );
        }

        const results = r.results.map((t) => ({
          rank: t.rank,
          id: t.id,
          name: t.name,
          url: t.url,
          homepage: t.homepage,
          description: t.description,
          match: t.match,
          why: t.why,
          matched_terms: t.matchedTerms,
          relevance: t.relevance,
          operations: t.operations,
          input_formats: t.inputFormats,
          output_formats: t.outputFormats,
          languages: t.languages,
          reads_requested_format: t.readsRequestedFormat,
          licence: t.licence,
          paper: t.paper,
          paper_is_preprint: t.paperIsPreprint,
          health: { label: t.health.label, note: t.health.note, last_push: t.health.lastPush },
          install: t.install,
        }));

        const lines = r.results.map((t) =>
          [
            `${t.rank}. [${MATCH_TEXT[t.match]}] ${t.name} ${t.url}`,
            `   Why: ${t.why}`,
            `   Reads: ${t.inputFormats.join(', ') || 'not listed'}. Writes: ${t.outputFormats.join(', ') || 'not listed'}.`,
            `   Licence: ${LICENCE_LABELS[t.licence.verdict]}${t.licence.spdx ? ` (${t.licence.spdx})` : ''}${t.licence.notes.length ? `. ${t.licence.notes.join(' ')}` : ''}`,
            `   Paper: ${PAPER_TEXT[t.paper.status]}${t.paper.title ? `: ${t.paper.title}` : ''}${paperId(t.paper) ? ` ${paperId(t.paper)}` : ''}${t.paperIsPreprint ? ' (preprint, not peer reviewed)' : ''}. ${t.paper.note}`,
            `   Maintenance: ${HEALTH_TEXT[t.health.label]}. ${t.health.note}`,
            `   Install: ${t.install ? t.install.line : 'no install link listed in the registry'}`,
            ...(t.paper.citation ? [`   Cite the paper: ${t.paper.citation}`] : []),
          ].join('\n'),
        );
        const text = [
          r.results.length
            ? `${r.results.length} tool${r.results.length === 1 ? '' : 's'} for "${r.question}" from ${r.stats.candidates} registry records (searched: ${r.terms.join(' ')}); ${r.stats.papersVerified} paper${r.stats.papersVerified === 1 ? '' : 's'} verified.`
            : `No tool matched "${r.question}" closely enough (searched: ${r.terms.join(' ')}, ${r.stats.candidates} registry records). Do not suggest tools from memory.`,
          '',
          ...lines,
          ...(r.takeaways.length
            ? ['', 'What this means for the research:', ...r.takeaways.map((t) => `- ${t}`)]
            : []),
          ...(r.suggestions.length ? ['', 'Try:', ...r.suggestions.map((s) => `- ${s}`)] : []),
          ...r.warnings.map((w) => `Note: ${w}`),
          `${r.dataNote} Licence information is taken from metadata; not legal advice.`,
          '',
          quotaLine(quota.info),
        ]
          .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
          .join('\n');

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            question: r.question,
            search_terms: r.terms,
            ...(r.inputFormat ? { input_format: r.inputFormat } : {}),
            intended_use: r.intendedUse,
            stats: {
              candidates: r.stats.candidates,
              results: r.stats.results,
              papers_verified: r.stats.papersVerified,
              warnings: r.stats.warnings,
            },
            results,
            takeaways: r.takeaways,
            warnings: r.warnings,
            suggestions: r.suggestions,
            data_note: r.dataNote,
            quota: quota.info,
          },
        };
      }),
  );
}
