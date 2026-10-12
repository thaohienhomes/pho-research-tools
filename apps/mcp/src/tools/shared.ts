/**
 * Schemas and small helpers shared by several tools.
 */

import { z } from 'zod';
import type { Author, VerificationResult, Work } from '@pho/scholar-core';

/** Upper bound on one call: keeps a single request well inside a serverless time limit. */
export const MAX_REFERENCES_PER_CALL = 50;
export const MAX_REFERENCE_INPUT_CHARS = 100_000;

export const quotaSchema = z.object({
  plan: z.enum(['anon', 'free']),
  metric: z.enum(['verifications', 'calls']),
  used: z.number().int(),
  limit: z.number().int(),
  resets: z.string(),
});

export const linksSchema = z
  .object({ doi: z.string().optional(), pubmed: z.string().optional(), openalex: z.string().optional() })
  .passthrough();

export const noticeSchema = z.object({
  type: z.string(),
  label: z.string(),
  date: z.string().optional(),
  source: z.string(),
  notice_doi: z.string().optional(),
});

export function authorName(a: Author): string {
  return a.given ? `${a.family}, ${a.given}` : a.family;
}

export function authorList(authors: Author[], max = 6): string[] {
  const names = authors.slice(0, max).map(authorName);
  if (authors.length > max) names.push(`… (${authors.length - max} more)`);
  return names;
}

export function workMetadata(w: Work) {
  return {
    title: w.title,
    authors: authorList(w.authors),
    year: w.years[0],
    journal: w.journals[0],
    volume: w.volume,
    issue: w.issue,
    pages: w.pages,
    doi: w.doi,
    pmid: w.pmid,
  };
}

export function noticesOut(r: VerificationResult['retraction']) {
  return (r?.notices ?? []).map((n) => ({
    type: n.type,
    label: n.label,
    date: n.date,
    source: n.source,
    notice_doi: n.noticeDoi,
  }));
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const STATUS_MARK: Record<string, string> = {
  verified: '✅',
  verified_with_corrections: '🟡',
  likely_fabricated: '❌',
  not_found: '❓',
  retracted: '⛔',
  ambiguous: '⚠️',
  not_checked: '⏸️',
};
