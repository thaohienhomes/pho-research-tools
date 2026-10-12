/**
 * Retraction / correction status from Crossref (which carries the Retraction
 * Watch database since 2023) plus independent PubMed and OpenAlex flags.
 *
 * Ported from `apps/api/src/lib/connectors/crossref-retractions.ts`, where every
 * rule was measured against live Crossref (see the MEASURED notes there). The
 * logic is copied rather than imported because Phase 0 must not depend on
 * `apps/api`; once both land, the API connector should import from here.
 * The invariant both copies guard: never make a bad paper look clean. A lookup
 * that did not happen is reported as such, never as "no notice".
 */

import type { HttpClient } from './http';
import type { RetractionNotice, RetractionStatus } from './types';

const RETRACTION_TYPES = new Set(['retraction', 'partial_retraction', 'removal', 'withdrawal']);
const CONCERN_TYPES = new Set(['expression_of_concern']);
const CORRECTION_TYPES = new Set([
  'correction',
  'corrigendum',
  'erratum',
  'addendum',
  'clarification',
  'new_edition',
  'new_version',
]);

const INVISIBLES = /[​-‍﻿­]/g;

/** `https://doi.org/10.x/y`, `doi:10.x/y`, stray case → bare lowercase DOI, or null. */
export function normalizeDoi(raw: string): string | null {
  const trimmed = (raw ?? '').replace(INVISIBLES, '').trim();
  if (!trimmed) return null;
  const bare = trimmed
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .trim()
    .replace(/[.,;]+$/, '')
    // A DOI quoted inside parentheses keeps its closing bracket; real DOIs
    // only end in `)` when they also contain a matching `(`.
    .replace(/\)$/, (m, offset: number, s: string) => (s.slice(0, offset).includes('(') ? m : ''))
    .toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(bare)) return null;
  if (bare.includes('..') || /\s/.test(bare)) return null;
  return bare;
}

/**
 * Crossref marks some retractions ONLY in the title (measured: Research Square
 * preprints carry an empty `updated-by`). Requires a delimiter after the word
 * so "Retracted articles in surgery: a review" is not flagged.
 */
export function titleMarksRetraction(title?: string): boolean {
  if (!title) return false;
  return /^\s*(retracted|withdrawn)\s*(?:[:.–—-]|$)/i.test(title);
}

/** Severity order, not first match: Wakefield has a 2004 correction AND a 2010 retraction. */
export function classifyNotices(notices: RetractionNotice[], title?: string): RetractionStatus {
  if (notices.some((n) => RETRACTION_TYPES.has(n.type))) return 'retracted';
  if (titleMarksRetraction(title)) return 'retracted';
  if (notices.some((n) => CONCERN_TYPES.has(n.type))) return 'concern';
  if (notices.length === 0) return 'no_notice';
  if (notices.every((n) => CORRECTION_TYPES.has(n.type))) return 'corrected';
  return 'other_notice';
}

export function isRetractionType(type: string): boolean {
  return RETRACTION_TYPES.has(type);
}

interface CrossrefUpdate {
  DOI?: string;
  type?: string;
  label?: string;
  source?: string;
  updated?: { 'date-parts'?: number[][] };
}

function toIsoDate(updated: CrossrefUpdate['updated']): string | undefined {
  const parts = updated?.['date-parts']?.[0];
  if (!Array.isArray(parts) || typeof parts[0] !== 'number') return undefined;
  const [y, m = 1, d = 1] = parts;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Notices pointing AT this work. Reads `updated-by`, never `update-to`
 * (measured: Elsevier populates `update-to` on the retracted Surgisphere paper
 * itself, which would label the paper as a notice).
 */
export function parseUpdatedBy(message: unknown): RetractionNotice[] {
  const updates = (message as { 'updated-by'?: CrossrefUpdate[] } | null)?.['updated-by'];
  if (!Array.isArray(updates)) return [];
  return updates
    .filter((u): u is CrossrefUpdate => typeof u?.type === 'string')
    .map((u) => {
      const date = toIsoDate(u.updated);
      return {
        type: String(u.type).toLowerCase(),
        label: u.label ?? String(u.type),
        ...(date ? { date } : {}),
        source: u.source ?? 'unknown',
        ...(u.DOI ? { noticeDoi: String(u.DOI) } : {}),
      };
    });
}

/** When the only evidence is the title, say so instead of a bare flag. */
export function withTitleNotice(notices: RetractionNotice[], title?: string): RetractionNotice[] {
  if (notices.length === 0 && titleMarksRetraction(title)) {
    return [{ type: 'retraction', label: 'Marked as retracted in the Crossref title', source: 'crossref-title' }];
  }
  return notices;
}

interface CrossrefEnvelope {
  status?: unknown;
  'message-type'?: unknown;
  message?: unknown;
}

/**
 * Is this body actually the work we asked for? A 200 is not a work: a DOI with
 * a tail like `/agency` reaches a Crossref sub-route that answers 200 with a
 * different message type (measured). The DOI echo closes that and aliasing.
 */
export function isWorkFor(body: unknown, doi: string): boolean {
  const env = body as CrossrefEnvelope | null;
  if (!env || typeof env !== 'object') return false;
  if (env.status !== 'ok') return false;
  if (env['message-type'] !== 'work') return false;
  const msg = env.message;
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  const echoed = (msg as { DOI?: unknown }).DOI;
  return typeof echoed === 'string' && echoed.toLowerCase() === doi.toLowerCase();
}

export interface RetractionCheck {
  doi: string;
  status: RetractionStatus;
  title?: string;
  notices: RetractionNotice[];
}

export const CROSSREF_BASE = 'https://api.crossref.org';

export function crossrefWorkUrl(doi: string, contactEmail?: string): string {
  const q = contactEmail ? `?mailto=${encodeURIComponent(contactEmail)}` : '';
  return `${CROSSREF_BASE}/works/${encodeURIComponent(doi)}${q}`;
}

/** Check one DOI. One request per DOI: the batch filter silently drops unknown DOIs. */
export async function checkRetraction(
  http: HttpClient,
  raw: string,
  opts: { contactEmail?: string } = {},
): Promise<RetractionCheck> {
  const doi = normalizeDoi(raw);
  if (!doi) return { doi: (raw ?? '').slice(0, 120), status: 'invalid_doi', notices: [] };
  const res = await http({ url: crossrefWorkUrl(doi, opts.contactEmail) });
  if (res.status === 404) return { doi, status: 'not_in_crossref', notices: [] };
  if (res.status === 429) return { doi, status: 'rate_limited', notices: [] };
  if (res.status !== 200 || !isWorkFor(res.body, doi)) return { doi, status: 'lookup_failed', notices: [] };
  const message = (res.body as CrossrefEnvelope).message;
  const title = (message as { title?: string[] } | undefined)?.title?.[0];
  const notices = withTitleNotice(parseUpdatedBy(message), title);
  return { doi, status: classifyNotices(notices, title), ...(title ? { title } : {}), notices };
}

export interface CheckRetractionsOptions {
  contactEmail?: string;
  /** Whole-batch budget; DOIs the budget does not reach come back `lookup_failed`, never dropped. */
  budgetMs?: number;
  maxDois?: number;
}

/**
 * Check several DOIs strictly one at a time (Crossref's public pool advertises
 * `x-concurrency-limit: 1`; at concurrency 2 answers went flaky — measured).
 */
export async function checkRetractions(
  http: HttpClient,
  dois: string[],
  opts: CheckRetractionsOptions = {},
): Promise<RetractionCheck[]> {
  const wanted = dois.slice(0, opts.maxDois ?? 100);
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const out: RetractionCheck[] = [];
  for (const raw of wanted) {
    if (Date.now() >= deadline) {
      out.push({ doi: normalizeDoi(raw) ?? (raw ?? '').slice(0, 120), status: 'lookup_failed', notices: [] });
      continue;
    }
    out.push(await checkRetraction(http, raw, opts));
  }
  return out;
}
