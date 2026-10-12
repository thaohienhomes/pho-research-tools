/**
 * searchPapers — find real papers, each with a DOI or a PMID.
 *
 * Results come only from bibliographic databases (OpenAlex and PubMed), never
 * from a model, so a result cannot be fabricated: every one carries the id of
 * the record it came from. Results without a DOI or PMID are dropped rather
 * than shown, because a reader could not check them.
 *
 * Retracted papers and notices (errata, retraction notices) are excluded by
 * default and counted, so a literature search does not quietly hand back
 * withdrawn evidence.
 */

import type { HttpClient } from './http';
import { openalexSearchWorks, type OpenAlexHit } from './sources/openalex';
import { pubmedSearch } from './sources/pubmed';
import { isRetractionType } from './retractions';
import type { LookupLog, Work, WorkSource } from './types';

/** Study types with a precise PubMed filter. Anything else is used as a plain keyword. */
export const STUDY_TYPES = {
  rct: { label: 'Randomized controlled trial', pubmed: '"randomized controlled trial"[pt]', keyword: 'randomized controlled trial' },
  'clinical-trial': { label: 'Clinical trial', pubmed: '"clinical trial"[pt]', keyword: 'clinical trial' },
  'systematic-review': { label: 'Systematic review', pubmed: 'systematic[sb]', keyword: 'systematic review', openalexType: 'review' },
  'meta-analysis': { label: 'Meta-analysis', pubmed: '"meta-analysis"[pt]', keyword: 'meta-analysis', openalexType: 'review' },
  review: { label: 'Review', pubmed: 'review[pt]', keyword: 'review', openalexType: 'review' },
  guideline: { label: 'Guideline', pubmed: '(guideline[pt] OR "practice guideline"[pt])', keyword: 'guideline' },
  cohort: { label: 'Cohort study', pubmed: '"cohort studies"[mh]', keyword: 'cohort study' },
  'case-control': { label: 'Case-control study', pubmed: '"case-control studies"[mh]', keyword: 'case-control study' },
  'case-report': { label: 'Case report', pubmed: '"case reports"[pt]', keyword: 'case report' },
  observational: { label: 'Observational study', pubmed: '"observational study"[pt]', keyword: 'observational study' },
} as const satisfies Record<string, { label: string; pubmed: string; keyword: string; openalexType?: string }>;

export type KnownStudyType = keyof typeof STUDY_TYPES;

export interface SearchFilters {
  yearFrom?: number;
  yearTo?: number;
  /** Only papers with a free, legal full text (OpenAlex `is_oa`, PubMed free full text). */
  openAccessOnly?: boolean;
  /**
   * Study types: a known id (`rct`, `systematic-review`, `meta-analysis`…) uses
   * PubMed's publication-type filter; any other text is added as a keyword.
   */
  studyTypes?: string[];
  /** 1–50, default 10. */
  maxResults?: number;
  /** Default both. */
  sources?: ('openalex' | 'pubmed')[];
  /** Keep retracted papers in the results (flagged). Default false. */
  includeRetracted?: boolean;
}

export interface SearchOptions {
  http: HttpClient;
  contactEmail?: string;
  pubmedApiKey?: string;
  openalexApiKey?: string;
}

export interface PaperResult {
  /** 1-based rank in the merged list. */
  rank: number;
  title: string;
  authors: string[];
  year?: number;
  journal?: string;
  doi?: string;
  pmid?: string;
  openalexId?: string;
  /** Where a reader can check the record: the DOI link, else the PubMed page. */
  url: string;
  links: { doi?: string; pubmed?: string; openalex?: string; pmc?: string };
  openAccess: { isOa: boolean; url?: string };
  /** Which databases returned it. */
  foundIn: WorkSource[];
  /**
   * How a study-type filter was applied to this result: `publication-type` =
   * PubMed indexed it as that type; `keyword` = matched only as search words.
   */
  studyTypeMatch?: 'publication-type' | 'keyword';
  retracted: boolean;
  /** Not peer reviewed (preprint server or PubMed publication type "Preprint"). Show it as such. */
  preprint: boolean;
  citedByCount?: number;
  /** The database record, ready for `formatCitations` or `verifyReference`. */
  work: Work;
}

export interface SearchResult {
  query: string;
  filters: Required<Pick<SearchFilters, 'maxResults'>> & SearchFilters;
  /** `ok` when at least one source answered. */
  status: 'ok' | 'unavailable';
  results: PaperResult[];
  excluded: { noIdentifier: number; retracted: number; notices: number; outsideYears: number };
  lookups: LookupLog[];
  warnings: string[];
}

const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 10;
const MAX_QUERY_CHARS = 500;
const NOTICE_TYPES = new Set(['erratum', 'retraction', 'paratext', 'correction']);

function clampYear(y: number | undefined): number | undefined {
  if (y === undefined || !Number.isFinite(y)) return undefined;
  const n = Math.trunc(y);
  return n >= 1500 && n <= 2100 ? n : undefined;
}

function isKnown(t: string): t is KnownStudyType {
  return Object.prototype.hasOwnProperty.call(STUDY_TYPES, t);
}

function normalizeStudyType(t: string): string {
  return t.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/^randomi[sz]ed-controlled-trials?$/, 'rct');
}

function pubmedTerm(query: string, f: SearchFilters, known: KnownStudyType[], keywords: string[]): string {
  const parts = [`(${query})`];
  if (keywords.length) parts.push(`(${keywords.map((k) => `"${k.replace(/"/g, '')}"`).join(' OR ')})`);
  if (known.length) parts.push(`(${known.map((k) => STUDY_TYPES[k].pubmed).join(' OR ')})`);
  if (f.yearFrom || f.yearTo) parts.push(`(${f.yearFrom ?? 1800}:${f.yearTo ?? 3000}[dp])`);
  if (f.openAccessOnly) parts.push('free full text[sb]');
  return parts.join(' AND ');
}

function linksFor(w: Work): PaperResult['links'] {
  return {
    ...(w.doi ? { doi: `https://doi.org/${w.doi}` } : {}),
    ...(w.pmid ? { pubmed: `https://pubmed.ncbi.nlm.nih.gov/${w.pmid}/` } : {}),
    ...(w.openalexId ? { openalex: `https://openalex.org/${w.openalexId}` } : {}),
    ...(w.pmcid ? { pmc: `https://pmc.ncbi.nlm.nih.gov/articles/${w.pmcid}/` } : {}),
  };
}

interface Candidate {
  work: Work;
  source: WorkSource;
  preprint: boolean;
  isOa: boolean;
  oaUrl?: string;
  citedByCount?: number;
  studyTypeMatch?: 'publication-type' | 'keyword';
}

function fromOpenAlex(h: OpenAlexHit, typed: boolean): Candidate {
  return {
    work: h.work,
    source: 'openalex',
    preprint: h.isPreprint,
    isOa: h.isOa,
    ...(h.oaUrl ? { oaUrl: h.oaUrl } : {}),
    ...(h.citedByCount !== undefined ? { citedByCount: h.citedByCount } : {}),
    ...(typed ? { studyTypeMatch: 'keyword' as const } : {}),
  };
}

function fromPubmed(w: Work, f: SearchFilters, known: boolean, keyword: boolean): Candidate {
  const pmc = w.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${w.pmcid}/` : undefined;
  return {
    work: w,
    source: 'pubmed',
    preprint: w.type === 'preprint',
    // `free full text[sb]` was in the query, so every hit has one even without a PMC copy.
    isOa: !!pmc || !!f.openAccessOnly,
    ...(pmc ? { oaUrl: pmc } : {}),
    ...(known ? { studyTypeMatch: 'publication-type' as const } : keyword ? { studyTypeMatch: 'keyword' as const } : {}),
  };
}

/** Merge two ranked lists round-robin, folding duplicates (same DOI or PMID) into the first copy. */
function merge(lists: Candidate[][]): { cand: Candidate; foundIn: WorkSource[] }[] {
  const out: { cand: Candidate; foundIn: WorkSource[] }[] = [];
  const byKey = new Map<string, { cand: Candidate; foundIn: WorkSource[] }>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const c = list[i];
      if (!c) continue;
      const keys = [c.work.doi && `doi:${c.work.doi}`, c.work.pmid && `pmid:${c.work.pmid}`].filter(
        (k): k is string => !!k,
      );
      const existing = keys.map((k) => byKey.get(k)).find(Boolean);
      if (existing) {
        const w = existing.cand.work;
        // Identifiers and access info are facts about the same paper; add the ones missing.
        existing.cand.work = {
          ...w,
          ...(!w.doi && c.work.doi ? { doi: c.work.doi } : {}),
          ...(!w.pmid && c.work.pmid ? { pmid: c.work.pmid } : {}),
          ...(!w.pmcid && c.work.pmcid ? { pmcid: c.work.pmcid } : {}),
          ...(!w.openalexId && c.work.openalexId ? { openalexId: c.work.openalexId } : {}),
          notices: [...w.notices, ...c.work.notices],
        };
        existing.cand.isOa ||= c.isOa;
        existing.cand.preprint ||= c.preprint;
        existing.cand.oaUrl ??= c.oaUrl;
        existing.cand.citedByCount ??= c.citedByCount;
        if (c.studyTypeMatch === 'publication-type') existing.cand.studyTypeMatch = 'publication-type';
        if (!existing.foundIn.includes(c.source)) existing.foundIn.push(c.source);
        for (const k of keys) byKey.set(k, existing);
        continue;
      }
      const entry = { cand: { ...c }, foundIn: [c.source] };
      for (const k of keys) byKey.set(k, entry);
      out.push(entry);
    }
  }
  return out;
}

function isRetracted(w: Work): boolean {
  return w.notices.some((n) => isRetractionType(n.type));
}

export async function searchPapers(
  query: string,
  filters: SearchFilters,
  opts: SearchOptions,
): Promise<SearchResult> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
  const maxResults = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(filters.maxResults ?? DEFAULT_RESULTS)));
  const warnings: string[] = [];
  let yearFrom = clampYear(filters.yearFrom);
  let yearTo = clampYear(filters.yearTo);
  if (filters.yearFrom !== undefined && yearFrom === undefined) warnings.push(`Ignored yearFrom ${filters.yearFrom}: not a valid year.`);
  if (filters.yearTo !== undefined && yearTo === undefined) warnings.push(`Ignored yearTo ${filters.yearTo}: not a valid year.`);
  if (yearFrom && yearTo && yearFrom > yearTo) {
    [yearFrom, yearTo] = [yearTo, yearFrom];
    warnings.push('yearFrom was after yearTo; the range was swapped.');
  }
  const { yearFrom: _from, yearTo: _to, ...rest } = filters;
  const f: SearchFilters = { ...rest, ...(yearFrom ? { yearFrom } : {}), ...(yearTo ? { yearTo } : {}) };
  const studyTypes = (filters.studyTypes ?? []).map(normalizeStudyType).filter(Boolean);
  const known = studyTypes.filter(isKnown);
  const keywords = studyTypes.filter((t) => !isKnown(t)).map((t) => t.replace(/-/g, ' '));
  const sources = filters.sources?.length ? filters.sources : (['openalex', 'pubmed'] as const);
  const excluded = { noIdentifier: 0, retracted: 0, notices: 0, outsideYears: 0 };
  const result: SearchResult = {
    query: q,
    filters: { ...f, maxResults, ...(studyTypes.length ? { studyTypes } : {}) },
    status: 'unavailable',
    results: [],
    excluded,
    lookups: [],
    warnings,
  };
  if (q.length < 2) {
    warnings.push('The query is empty.');
    return result;
  }

  // Ask for more than needed: filtering below drops some.
  const perSource = Math.min(MAX_RESULTS, maxResults + 5);
  // OpenAlex has no publication-type index for trials; the study type becomes
  // search words there, and is labelled as a keyword match.
  const oaTypes = [...new Set(known.map((k) => (STUDY_TYPES[k] as { openalexType?: string }).openalexType))];
  const oaTypeFilter = known.length > 0 && oaTypes.every(Boolean) ? (oaTypes as string[]) : undefined;
  const oaKeywords = [...keywords, ...(oaTypeFilter ? [] : known.map((k) => STUDY_TYPES[k].keyword))];
  const oaQuery = [q, ...oaKeywords].join(' ');

  const [oa, pm] = await Promise.all([
    sources.includes('openalex')
      ? openalexSearchWorks(opts.http, oaQuery, {
          perPage: perSource,
          ...(f.yearFrom ? { yearFrom: f.yearFrom } : {}),
          ...(f.yearTo ? { yearTo: f.yearTo } : {}),
          ...(f.openAccessOnly ? { openAccessOnly: true } : {}),
          ...(oaTypeFilter ? { types: oaTypeFilter } : {}),
          ...(opts.openalexApiKey ? { apiKey: opts.openalexApiKey } : {}),
          ...(opts.contactEmail ? { contactEmail: opts.contactEmail } : {}),
        })
      : undefined,
    sources.includes('pubmed')
      ? pubmedSearch(opts.http, pubmedTerm(q, f, known, keywords), {
          retmax: perSource,
          ...(opts.pubmedApiKey ? { apiKey: opts.pubmedApiKey } : {}),
          ...(opts.contactEmail ? { contactEmail: opts.contactEmail } : {}),
        })
      : undefined,
  ]);

  const lists: Candidate[][] = [];
  if (oa) {
    result.lookups.push({ source: 'openalex', ok: oa.ok, hits: oa.ok ? oa.value.length : 0 });
    if (oa.ok) lists.push(oa.value.map((h) => fromOpenAlex(h, studyTypes.length > 0)));
    else warnings.push(`OpenAlex could not be searched (${oa.reason.replace('_', ' ')}).`);
  }
  if (pm) {
    result.lookups.push({ source: 'pubmed', ok: pm.ok, hits: pm.ok ? pm.value.length : 0 });
    if (pm.ok) lists.push(pm.value.map((w) => fromPubmed(w, f, known.length > 0, keywords.length > 0)));
    else warnings.push(`PubMed could not be searched (${pm.reason.replace('_', ' ')}).`);
  }
  if (lists.length === 0) return result;
  result.status = 'ok';

  for (const { cand, foundIn } of merge(lists)) {
    const w = cand.work;
    if (!w.doi && !w.pmid) {
      excluded.noIdentifier++;
      continue;
    }
    if (w.isNotice || (w.type && NOTICE_TYPES.has(w.type))) {
      excluded.notices++;
      continue;
    }
    const year = w.years[0];
    if (year && ((f.yearFrom && year < f.yearFrom) || (f.yearTo && year > f.yearTo))) {
      excluded.outsideYears++;
      continue;
    }
    const retracted = isRetracted(w);
    if (retracted && !filters.includeRetracted) {
      excluded.retracted++;
      continue;
    }
    if (f.openAccessOnly && !cand.isOa) continue;
    if (result.results.length >= maxResults) break;
    const links = linksFor(w);
    result.results.push({
      rank: result.results.length + 1,
      title: w.title,
      authors: w.authors.map((a) => (a.given ? `${a.given} ${a.family}` : a.family)),
      ...(year ? { year } : {}),
      ...(w.journals[0] ? { journal: w.journals[0] } : {}),
      ...(w.doi ? { doi: w.doi } : {}),
      ...(w.pmid ? { pmid: w.pmid } : {}),
      ...(w.openalexId ? { openalexId: w.openalexId } : {}),
      url: links.doi ?? links.pubmed!,
      links,
      openAccess: { isOa: cand.isOa, ...(cand.oaUrl ? { url: cand.oaUrl } : {}) },
      foundIn,
      ...(cand.studyTypeMatch ? { studyTypeMatch: cand.studyTypeMatch } : {}),
      retracted,
      preprint: cand.preprint,
      ...(cand.citedByCount !== undefined ? { citedByCount: cand.citedByCount } : {}),
      work: w,
    });
  }
  if (excluded.retracted > 0) {
    warnings.push(`${excluded.retracted} retracted paper(s) left out. Set includeRetracted to see them.`);
  }
  return result;
}
