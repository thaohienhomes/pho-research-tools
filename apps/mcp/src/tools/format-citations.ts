import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CITATION_OUTPUTS,
  CITATION_STYLES,
  formatCitations,
  parseReferences,
  type CitableInput,
  type CitationOutput,
  type CitationStyle,
} from '@pho/scholar-core';
import { z } from 'zod';
import { errorResult, quotaLine, runTool, type ToolContext } from '../context';
import { MAX_REFERENCE_INPUT_CHARS, MAX_REFERENCES_PER_CALL, quotaSchema } from './shared';
import { inputProblem, verifyWithinQuota } from './verify-references';

const STYLES = CITATION_STYLES as [CitationStyle, ...CitationStyle[]];
const OUTPUTS = CITATION_OUTPUTS as [CitationOutput, ...CitationOutput[]];

const STYLE_NAMES: Record<CitationStyle, string> = {
  apa: 'APA 7',
  mla: 'MLA 9',
  chicago: 'Chicago author-date',
  harvard: 'Harvard',
  vancouver: 'Vancouver',
  ieee: 'IEEE',
  ama: 'AMA',
};

export const FORMAT_DESCRIPTION = [
  'Format references in a citation style (APA 7, MLA 9, Chicago author-date, Harvard, Vancouver, IEEE, AMA) or export them as BibTeX, RIS or CSL-JSON.',
  'By default every reference is first verified against Crossref, PubMed and OpenAlex, and verified references are formatted from the database record, so wrong years, pages or author names in the input are corrected.',
  'References that could not be verified are formatted exactly as written and flagged in `entries[].warnings`.',
  'Returns the bibliography and, for text and html output, the matching in-text citation for each reference.',
].join(' ');

export const formatOutputSchema = {
  style: z.string(),
  style_title: z.string(),
  output: z.string(),
  content: z.string(),
  entries: z.array(
    z.object({
      index: z.number().int(),
      verified: z.boolean(),
      status: z.string().optional(),
      retracted: z.boolean(),
      bibliography: z.string(),
      in_text: z.string(),
      warnings: z.array(z.string()),
    }),
  ),
  warnings: z.array(z.string()),
  quota: quotaSchema.optional(),
};

export function registerFormatCitations(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'format_citations',
    {
      title: 'Format citations',
      description: FORMAT_DESCRIPTION,
      inputSchema: {
        references: z
          .string()
          .min(1)
          .max(MAX_REFERENCE_INPUT_CHARS)
          .describe('References in any form: a pasted list in any style, BibTeX, RIS, CSL-JSON, or DOIs one per line.'),
        style: z
          .enum(STYLES)
          .default('apa')
          .describe(
            `Citation style: ${CITATION_STYLES.map((s) => `${s} (${STYLE_NAMES[s]})`).join(', ')}. Ignored for bibtex/ris/csl-json output.`,
          ),
        output: z
          .enum(OUTPUTS)
          .default('text')
          .describe('text (plain bibliography), html, bibtex, ris or csl-json.'),
        verify: z
          .boolean()
          .default(true)
          .describe(
            'Verify each reference before formatting (recommended). When false, references are formatted exactly as given, without corrections.',
          ),
      },
      outputSchema: formatOutputSchema,
      annotations: { title: 'Format citations', readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
    },
    async ({ references, style, output, verify }) =>
      runTool(ctx, 'format_citations', async (track) => {
        let items: CitableInput[];
        let quota;
        let unverified = 0;
        if (verify) {
          const v = await verifyWithinQuota(ctx, references);
          if (v.kind !== 'ok') {
            track({ result_status: v.kind === 'quota' ? 'quota_exceeded' : 'invalid_input', style, output });
            return inputProblem(ctx, v);
          }
          // References the allowance did not reach are formatted as written, and flagged.
          items = [...v.results, ...v.unchecked];
          unverified = v.unchecked.length;
          quota = v.info;
        } else {
          const refs = parseReferences(references);
          if (refs.length === 0) {
            track({ result_status: 'invalid_input', style, output });
            return errorResult('No references were found in the input.');
          }
          if (refs.length > MAX_REFERENCES_PER_CALL) {
            track({ result_status: 'invalid_input', style, output });
            return errorResult(`One call formats at most ${MAX_REFERENCES_PER_CALL} references; split the list.`);
          }
          items = refs;
        }

        const r = formatCitations(items, style, output);
        const entries = r.entries.map((e) => ({
          index: e.index + 1,
          verified: e.verified,
          ...(e.status ? { status: e.status } : {}),
          retracted: e.retracted,
          bibliography: e.bibliography,
          in_text: e.inText,
          warnings: unverified && !e.status && e.source === 'as-cited'
            ? [...e.warnings, 'Not verified: the allowance ran out before this reference.']
            : e.warnings,
        }));
        const flagged = entries.filter((e) => !e.verified || e.retracted).length;
        track({
          result_status: unverified ? 'partial' : 'ok',
          style,
          output,
          references: entries.length,
          flagged,
        });

        const notes = entries
          .filter((e) => e.warnings.length)
          .map((e) => `- [${e.index}] ${e.warnings.join(' ')}`);
        const text = [
          output === 'text' || output === 'html' ? `${STYLE_NAMES[style]} (${r.styleTitle}):` : `${output.toUpperCase()} export:`,
          '',
          r.content,
          ...(notes.length ? ['', 'Check before using:', ...notes] : []),
          ...(quota ? ['', quotaLine(quota)] : []),
        ].join('\n');

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            style: r.style,
            style_title: r.styleTitle,
            output: r.output,
            content: r.content,
            entries,
            warnings: [...r.warnings, ...(unverified ? ['Some references were formatted as cited without checking: the allowance ran out.'] : [])],
            ...(quota ? { quota } : {}),
          },
        };
      }),
  );
}
