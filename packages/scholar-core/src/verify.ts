/**
 * `verifyReference` — does this cited paper exist, and does the citation say
 * what the record says?
 *
 * Order of evidence, cheapest and strongest first:
 *   1. The cited DOI (Crossref; if Crossref has never heard of it, the DOI
 *      handle registry, which covers every agency).
 *   2. The cited PMID.
 *   3. Crossref's citation matcher on the whole reference string.
 *   4. PubMed title search, then OpenAlex title search — only while no
 *      candidate is convincing yet.
 *
 * The verdict is driven by TITLE similarity between the citation and the best
 * candidate, with first author and year as supporting evidence. Every other
 * field only produces corrections; it never decides whether the paper exists.
 *
 * Never invents metadata: `match` is always a record a database returned, and
 * a reference with no convincing match gets no `match` at all.
 */

import type { HttpClient } from './http';
import { citationString, parseReferences, type ReferenceInput } from './parse';
import { classifyNotices, normalizeDoi } from './retractions';
import { crossrefGetWork, crossrefSearchBibliographic } from './sources/crossref';
import { doiRegistration, type DoiRegistration } from './sources/doi-handle';
import { openalexSearchTitle } from './sources/openalex';
import { pubmedByDoi, pubmedSearchTitle, pubmedSummaries } from './sources/pubmed';
import {
  charRatio,
  foldName,
  journalMatches,
  normalize,
  orderedCoverage,
  pagesMatch,
  titleSimilarity,
  tokens,
} from './text';
import type {
  FieldMismatch,
  LookupLog,
  ParsedRef,
  RetractionNotice,
  SourceLinks,
  VerificationResult,
  Work,
} from './types';

export interface VerifyOptions {
  http: HttpClient;
  /** Polite-pool contact for Crossref / NCBI. */
  contactEmail?: string;
  pubmedApiKey?: string;
  openalexApiKey?: string;
  /** Default true. */
  useOpenAlex?: boolean;
}

/** A candidate this close is the cited paper, whatever the other fields say. */
export const ACCEPT_TITLE = 0.88;
/** This close AND same first author AND same year: the cited paper with a garbled title. */
export const SUPPORTED_TITLE = 0.72;
/** Below ACCEPT but at least this close with some support: we cannot tell. */
export const AMBIGUOUS_TITLE = 0.6;
/** At or above this, a title difference is formatting, not a correction worth reporting. */
const TITLE_CORRECTION_FLOOR = 0.95;

interface Scored {
  work: Work;
  title: number;
  author: boolean;
  year: boolean;
  journal: boolean;
  rank: number;
}

const NOTICE_TITLE = /^\s*(retraction|correction|erratum|corrigendum|expression of concern|notice of retraction)\b/i;

function firstAuthorMatches(ref: ParsedRef, work: Work): boolean {
  const cited = ref.authors[0]?.family;
  if (!cited || work.authors.length === 0) return false;
  const c = foldName(cited);
  return work.authors.slice(0, 10).some((a) => {
    const f = foldName(a.family);
    return f === c || (f.length > 3 && c.length > 3 && (f.includes(c) || c.includes(f)));
  });
}

/** The record's first author appears somewhere in the raw citation. */
function recordAuthorInRaw(ref: ParsedRef, work: Work): boolean {
  const fam = work.authors[0]?.family;
  if (!fam) return false;
  return normalize(ref.raw).split(' ').includes(foldName(fam)) || normalize(ref.raw).includes(normalize(fam));
}

function yearMatches(ref: ParsedRef, work: Work): boolean {
  return ref.year != null && work.years.includes(ref.year);
}

function journalOk(ref: ParsedRef, work: Work): boolean {
  if (!ref.journal) return false;
  return work.journals.some((j) => journalMatches(ref.journal!, j));
}

function scoreTitle(ref: ParsedRef, work: Work): number {
  if (!work.title) return 0;
  let s = ref.title ? titleSimilarity(ref.title, work.title) : 0;
  const recordTokens = tokens(work.title).length;
  const citedTokens = ref.title ? tokens(ref.title).length : 0;
  // Fallback for citation styles the parser misread: is the record's whole
  // title inside the raw text? Not used when the cited title is clearly longer
  // than the record's — a longer title is a different paper that merely shares
  // the record's words ("Deep learning" ⊂ "Deep learning for sepsis triage").
  if (ref.format === 'text' && (!citedTokens || citedTokens <= recordTokens * 1.3)) {
    let cov = orderedCoverage(work.title, ref.raw);
    if (recordTokens < 4) cov *= 0.85;
    s = Math.max(s, cov * 0.97);
  }
  if (work.isNotice && !(ref.title && NOTICE_TITLE.test(ref.title))) s *= 0.5;
  return s;
}

function score(ref: ParsedRef, work: Work): Scored {
  const title = scoreTitle(ref, work);
  const author = firstAuthorMatches(ref, work);
  const year = yearMatches(ref, work);
  const journal = journalOk(ref, work);
  return { work, title, author, year, journal, rank: title + (author ? 0.04 : 0) + (year ? 0.02 : 0) + (journal ? 0.02 : 0) };
}

function sameWork(a: Work, b: Work): boolean {
  if (a.doi && b.doi) return a.doi === b.doi;
  if (a.pmid && b.pmid) return a.pmid === b.pmid;
  return false;
}

/** Fold every candidate that is the same paper into one record (union of years, journals, notices). */
function consolidate(primary: Work, all: Work[]): Work {
  const same = all.filter((w) => w !== primary && sameWork(primary, w));
  if (same.length === 0) return primary;
  const notices: RetractionNotice[] = [...primary.notices];
  for (const w of same) for (const n of w.notices) if (!notices.some((x) => x.type === n.type && x.source === n.source)) notices.push(n);
  return {
    ...primary,
    years: [...new Set([...primary.years, ...same.flatMap((w) => w.years)])],
    journals: [...new Set([...primary.journals, ...same.flatMap((w) => w.journals)])],
    pmid: primary.pmid ?? same.find((w) => w.pmid)?.pmid,
    openalexId: primary.openalexId ?? same.find((w) => w.openalexId)?.openalexId,
    notices,
  };
}

function linksFor(w: Work | undefined): SourceLinks {
  if (!w) return {};
  return {
    ...(w.doi ? { doi: `https://doi.org/${w.doi}` } : {}),
    ...(w.pmid ? { pubmed: `https://pubmed.ncbi.nlm.nih.gov/${w.pmid}/` } : {}),
    ...(w.openalexId ? { openalex: `https://openalex.org/${w.openalexId}` } : {}),
  };
}

function fmtAuthor(w: Work): string {
  const a = w.authors[0];
  return a ? `${a.family}${a.given ? ', ' + a.given : ''}` : '';
}

function mismatchesFor(ref: ParsedRef, work: Work, s: Scored): FieldMismatch[] {
  const out: FieldMismatch[] = [];
  if (ref.title && s.title < TITLE_CORRECTION_FLOOR && charRatio(ref.title, work.title) < TITLE_CORRECTION_FLOOR) {
    out.push({ field: 'title', cited: ref.title, found: work.title });
  }
  if (ref.authors[0] && work.authors.length > 0 && !s.author && !recordAuthorInRaw(ref, work)) {
    out.push({ field: 'authors', cited: ref.authors[0].family, found: fmtAuthor(work) });
  }
  if (ref.year != null && work.years.length > 0 && !s.year) {
    out.push({ field: 'year', cited: String(ref.year), found: work.years.join(' / ') });
  }
  if (ref.journal && work.journals.length > 0 && !s.journal) {
    const raw = normalize(ref.raw);
    const inRaw = work.journals.some((j) => normalize(j.replace(/\([^)]*\)/g, ' ')).length > 3 && raw.includes(normalize(j.replace(/\([^)]*\)/g, ' '))));
    if (!inRaw) out.push({ field: 'journal', cited: ref.journal, found: work.journals[0]! });
  }
  if (ref.volume && work.volume && normalize(ref.volume) !== normalize(work.volume)) {
    out.push({ field: 'volume', cited: ref.volume, found: work.volume });
  }
  if (ref.pages && work.pages && !pagesMatch(ref.pages, work.pages)) {
    out.push({ field: 'pages', cited: ref.pages, found: work.pages });
  }
  if (ref.doi && work.doi && normalizeDoi(ref.doi) !== work.doi) {
    out.push({ field: 'doi', cited: ref.doi, found: work.doi });
  }
  return out;
}

function looksLikeArticle(ref: ParsedRef): boolean {
  if (ref.journal || ref.volume || ref.pages) return true;
  if (ref.type && /article|jour|journal/i.test(ref.type)) return true;
  return /\b(1[89]\d\d|20\d\d)\s*;\s*\d/.test(ref.raw);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function verifyReference(ref: ParsedRef, opts: VerifyOptions): Promise<VerificationResult> {
  const { http, contactEmail } = opts;
  const lookups: LookupLog[] = [];
  const pool: Work[] = [];
  /** DOIs whose complete Crossref record (not a search hit) is in the pool. */
  const fullRecord = new Set<string>();
  const log = (source: LookupLog['source'], ok: boolean, hits: number) => lookups.push({ source, ok, hits });

  // 1. Cited DOI.
  const citedDoi = ref.doi ? normalizeDoi(ref.doi) : null;
  let doiWork: Work | undefined;
  let registration: DoiRegistration | 'crossref' | undefined;
  if (citedDoi) {
    const r = await crossrefGetWork(http, citedDoi, contactEmail);
    log('crossref', r.ok || r.reason === 'not_found', r.ok ? 1 : 0);
    if (r.ok) {
      fullRecord.add(citedDoi);
      doiWork = r.value;
      registration = 'crossref';
      pool.push(r.value);
    } else if (r.reason === 'not_found') {
      registration = await doiRegistration(http, citedDoi);
      log('doi.org', registration !== 'unknown', registration === 'registered' ? 1 : 0);
    }
  }

  // 2. Cited PMID.
  if (ref.pmid) {
    const r = await pubmedSummaries(http, [ref.pmid], { apiKey: opts.pubmedApiKey, contactEmail });
    log('pubmed', r.ok, r.ok ? r.value.length : 0);
    if (r.ok) pool.push(...r.value);
  }

  const query = citationString(ref);
  const hasTitle = (!!ref.title && tokens(ref.title).length >= 3) || (ref.format === 'text' && tokens(query).length >= 6);

  const best = (): Scored | undefined =>
    pool.map((w) => score(ref, w)).sort((a, b) => b.rank - a.rank)[0];
  const convincing = (s?: Scored) =>
    !!s && (s.title >= ACCEPT_TITLE || (s.title >= SUPPORTED_TITLE && s.author && s.year));

  // 3–4. Search, only while nothing convincing is in hand.
  let crossrefSearched = false;
  let secondarySearched = false;
  if (hasTitle && !convincing(best())) {
    const r = await crossrefSearchBibliographic(http, query, { contactEmail });
    log('crossref', r.ok, r.ok ? r.value.length : 0);
    crossrefSearched = r.ok;
    if (r.ok) pool.push(...r.value);
  }
  const titleForSearch = ref.title ?? (ref.format === 'text' ? query : undefined);
  if (hasTitle && titleForSearch && !convincing(best())) {
    const r = await pubmedSearchTitle(http, titleForSearch, { apiKey: opts.pubmedApiKey, contactEmail });
    log('pubmed', r.ok, r.ok ? r.value.length : 0);
    secondarySearched ||= r.ok;
    if (r.ok) pool.push(...r.value);
  }
  if (hasTitle && ref.title && (opts.useOpenAlex ?? true) && !convincing(best())) {
    const r = await openalexSearchTitle(http, ref.title, { apiKey: opts.openalexApiKey, contactEmail });
    log('openalex', r.ok, r.ok ? r.value.length : 0);
    secondarySearched ||= r.ok;
    if (r.ok) pool.push(...r.value);
  }

  const top = best();
  const base = { index: ref.index, input: ref, lookups };
  const titleScore = round(top?.title ?? 0);

  // ---- A match --------------------------------------------------------------
  // DOI-only references have no title to compare; the DOI record IS the answer.
  const doiOnly = !hasTitle && !!doiWork;
  if (doiOnly || convincing(top)) {
    const chosen = doiOnly ? score(ref, doiWork!) : top!;
    let work = consolidate(chosen.work, pool);
    // A match found via PubMed/OpenAlex: fetch its Crossref record for notices.
    if (work.source !== 'crossref' && work.doi && !pool.some((w) => w.source === 'crossref' && w.doi === work.doi)) {
      const r = await crossrefGetWork(http, work.doi, contactEmail);
      log('crossref', r.ok || r.reason === 'not_found', r.ok ? 1 : 0);
      if (r.ok) {
        fullRecord.add(work.doi);
        pool.push(r.value);
        work = consolidate(work, pool);
      }
    }
    let mismatches = mismatchesFor(ref, work, score(ref, work));
    // Crossref often lacks the online-first date (NEJM: print 2024, online Dec
    // 2023). Before telling the user a year off by one is wrong, ask PubMed,
    // which records the e-pub date.
    const yearOff = () =>
      !!ref.year && work.years.length > 0 && work.years.every((y) => Math.abs(y - ref.year!) === 1);
    // A search hit lacks the issue cover date; the full record carries it.
    if (yearOff() && work.doi && !fullRecord.has(work.doi)) {
      const r = await crossrefGetWork(http, work.doi, contactEmail);
      log('crossref', r.ok || r.reason === 'not_found', r.ok ? 1 : 0);
      if (r.ok) {
        fullRecord.add(work.doi);
        pool.push(r.value);
        work = consolidate(work, pool);
        mismatches = mismatchesFor(ref, work, score(ref, work));
      }
    }
    if (yearOff() && work.doi && !pool.some((w) => w.source === 'pubmed' && w.doi === work.doi)) {
      const r = await pubmedByDoi(http, work.doi, { apiKey: opts.pubmedApiKey, contactEmail });
      log('pubmed', r.ok, r.ok ? r.value.length : 0);
      if (r.ok && r.value.length > 0) {
        pool.push(...r.value);
        work = consolidate(work, pool);
        mismatches = mismatchesFor(ref, work, score(ref, work));
      }
    }
    const retraction = { status: classifyNotices(work.notices, work.title), notices: work.notices };
    const links = linksFor(work);
    if (retraction.status === 'retracted') {
      // The notice list can also hold earlier corrections; date the retraction itself.
      const retractedOn = work.notices.find((n) => n.type === 'retraction')?.date;
      return {
        ...base,
        status: 'retracted',
        confidence: 0.98,
        summary: `This paper exists but has been retracted${retractedOn ? ` (${retractedOn})` : ''}. Do not cite it as evidence.`,
        match: work,
        mismatches,
        links,
        retraction,
        titleScore: doiOnly ? 1 : titleScore,
      };
    }
    const notice =
      retraction.status === 'concern'
        ? ' An expression of concern has been published about it.'
        : retraction.status === 'corrected'
          ? ' A correction has been published for it.'
          : '';
    if (mismatches.length === 0) {
      return {
        ...base,
        status: 'verified',
        confidence: round(doiOnly ? 0.9 : Math.min(0.99, 0.5 + chosen.title / 2)),
        summary: (doiOnly ? 'The DOI resolves to a real record.' : 'Matches a real record.') + notice,
        match: work,
        mismatches,
        links,
        retraction,
        titleScore: doiOnly ? 1 : titleScore,
      };
    }
    return {
      ...base,
      status: 'verified_with_corrections',
      confidence: round(Math.min(0.97, 0.45 + chosen.title / 2)),
      summary: `The paper exists, but the citation has errors in: ${[...new Set(mismatches.map((m) => m.field))].join(', ')}.${notice}`,
      match: work,
      mismatches,
      links,
      retraction,
      titleScore: doiOnly ? 1 : titleScore,
    };
  }

  // ---- No match -------------------------------------------------------------
  if (!hasTitle) {
    if (registration === 'unregistered') {
      return {
        ...base,
        status: 'likely_fabricated',
        confidence: 0.9,
        summary: 'The DOI is not registered with any DOI agency, and there is no title to search for.',
        mismatches: [],
        links: {},
        titleScore,
      };
    }
    return {
      ...base,
      status: 'not_found',
      confidence: 0.5,
      notFoundReason: registration === 'registered' ? 'not_indexed' : citedDoi ? 'lookup_failed' : 'insufficient_data',
      summary:
        registration === 'registered'
          ? 'The DOI exists (registered outside Crossref) but its metadata could not be checked.'
          : citedDoi
            ? 'The DOI could not be checked right now.'
            : 'Not enough information to search for this reference (no title or DOI found).',
      mismatches: [],
      links: registration === 'registered' && citedDoi ? { doi: `https://doi.org/${citedDoi}` } : {},
      titleScore,
    };
  }

  const searched = crossrefSearched && (secondarySearched || !(opts.useOpenAlex ?? true));
  const support = top ? (top.author ? 1 : 0) + (top.year ? 1 : 0) + (top.journal ? 1 : 0) : 0;
  if (top && top.title >= AMBIGUOUS_TITLE && support >= 2) {
    return {
      ...base,
      status: 'ambiguous',
      confidence: 0.5,
      summary: `A similar paper exists ("${top.work.title}"), but the title differs too much to confirm it is the one cited.`,
      match: top.work,
      mismatches: mismatchesFor(ref, top.work, top),
      links: linksFor(top.work),
      titleScore,
    };
  }

  const doiPointsElsewhere = registration === 'crossref' && doiWork && (!top || top.work !== doiWork || top.title < AMBIGUOUS_TITLE);
  if (registration === 'unregistered' || doiPointsElsewhere || (searched && looksLikeArticle(ref))) {
    const why =
      registration === 'unregistered'
        ? 'The DOI is not registered anywhere and no paper with this title was found.'
        : doiPointsElsewhere
          ? `The DOI belongs to a different paper ("${doiWork!.title}") and no paper with the cited title was found.`
          : 'No paper with this title was found in Crossref, PubMed or OpenAlex.';
    return {
      ...base,
      status: 'likely_fabricated',
      confidence: round(Math.min(0.97, 1 - (top?.title ?? 0) / 2)),
      summary: why,
      mismatches: [],
      links: {},
      titleScore,
    };
  }

  return {
    ...base,
    status: 'not_found',
    confidence: 0.5,
    notFoundReason: crossrefSearched ? 'not_indexed' : 'lookup_failed',
    summary: crossrefSearched
      ? 'Not found in Crossref, PubMed or OpenAlex. Books, theses and grey literature are often not indexed, so this is not proof it is fake.'
      : 'The bibliographic databases could not be reached; this reference was not checked.',
    mismatches: [],
    links: {},
    titleScore,
  };
}

export interface VerifyManyOptions extends VerifyOptions {
  /** Parallel references. Default 1 without a contact email (public pool), 3 with. */
  concurrency?: number;
}

export async function verifyReferences(
  input: ReferenceInput | ParsedRef[],
  opts: VerifyManyOptions,
): Promise<VerificationResult[]> {
  const refs: ParsedRef[] =
    Array.isArray(input) && input.length > 0 && typeof (input[0] as ParsedRef).raw === 'string' && 'index' in (input[0] as object)
      ? (input as ParsedRef[])
      : parseReferences(input as ReferenceInput);
  const limit = Math.max(1, opts.concurrency ?? (opts.contactEmail ? 3 : 1));
  const out = new Array<VerificationResult>(refs.length);
  let next = 0;
  async function worker() {
    while (next < refs.length) {
      const i = next++;
      out[i] = await verifyReference(refs[i]!, opts);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, refs.length) }, worker));
  return out;
}

export interface VerificationSummary {
  total: number;
  verified: number;
  verified_with_corrections: number;
  likely_fabricated: number;
  not_found: number;
  retracted: number;
  ambiguous: number;
}

export function summarize(results: VerificationResult[]): VerificationSummary {
  const s: VerificationSummary = {
    total: results.length,
    verified: 0,
    verified_with_corrections: 0,
    likely_fabricated: 0,
    not_found: 0,
    retracted: 0,
    ambiguous: 0,
  };
  for (const r of results) s[r.status]++;
  return s;
}
