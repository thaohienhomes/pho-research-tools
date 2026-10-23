/**
 * findEvidence — the strongest published evidence on a claim, both ways.
 *
 * This module never decides whether a paper supports or refutes the claim.
 * It finds real papers (every one has a PMID or DOI), labels each with its
 * level of evidence from the database's own publication types, and pulls the
 * conclusion out of the abstract. Judging stance is left to the reader (in
 * practice the assistant that called the tool), which has to quote the
 * conclusion it relies on. Keeping judgement out of here means no model call,
 * no cost per lookup, and nothing in the output that a database did not say.
 *
 * Retrieval, in parallel:
 *   - PubMed, relevance-ranked, for the claim's keywords;
 *   - PubMed again, restricted to guidelines, meta-analyses, systematic
 *     reviews and RCTs, so the strongest designs are not crowded out;
 *   - OpenAlex, for literature PubMed does not index.
 * PubMed records are then hydrated through Europe PMC, the only JSON source of
 * PubMed abstracts and publication types.
 */

import type { HttpClient } from './http';
import { europepmcByPmids, type EpmcPaper } from './sources/europepmc';
import { openalexSearchWorks, type OpenAlexHit } from './sources/openalex';
import { pubmedSearchIds, pubmedSummaries } from './sources/pubmed';
import { normalize } from './text';
import type { LookupLog, Work } from './types';

export type EvidenceLevel =
  | 'guideline'
  | 'meta-analysis'
  | 'systematic-review'
  | 'rct'
  | 'clinical-trial'
  | 'observational'
  | 'review'
  | 'case-report'
  | 'other'
  | 'protocol';

/** Strongest first. The order papers are returned in. */
export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'guideline',
  'meta-analysis',
  'systematic-review',
  'rct',
  'clinical-trial',
  'observational',
  'review',
  'case-report',
  'other',
  'protocol',
];

export const EVIDENCE_LABELS: Record<EvidenceLevel, string> = {
  guideline: 'Guideline',
  'meta-analysis': 'Meta-analysis',
  'systematic-review': 'Systematic review',
  rct: 'Randomized controlled trial',
  'clinical-trial': 'Clinical trial',
  observational: 'Observational study',
  review: 'Narrative review',
  'case-report': 'Case report',
  other: 'Other study type',
  protocol: 'Study protocol (no results)',
};

export interface EvidenceOptions {
  http: HttpClient;
  contactEmail?: string;
  pubmedApiKey?: string;
  openalexApiKey?: string;
}

export interface EvidenceFilters {
  /** Search words in English. Defaults to the claim's content words. */
  query?: string;
  yearFrom?: number;
  yearTo?: number;
  /** 1–25, default 15. */
  maxResults?: number;
  /** Keep preprints (flagged). Default true. */
  includePreprints?: boolean;
}

export interface EvidencePaper {
  rank: number;
  level: EvidenceLevel;
  /** How the level was decided: the database's publication type, or words in the title. */
  levelFrom: 'publication-type' | 'title';
  title: string;
  /** As the source writes it, e.g. "Ding M, Bhupathiraju SN, Chen M". */
  authors?: string;
  year?: number;
  journal?: string;
  doi?: string;
  pmid?: string;
  url: string;
  /** The abstract's conclusion section, or its last sentences when it has no sections. */
  conclusion?: string;
  conclusionFrom?: 'section' | 'last-sentences';
  /** The abstract, shortened. Absent when no database holds one. */
  abstract?: string;
  publicationTypes: string[];
  preprint: boolean;
  openAccess: boolean;
  citedByCount?: number;
  foundIn: ('pubmed' | 'openalex')[];
}

export interface EvidenceResult {
  claim: string;
  query: string;
  /** `ok` when at least one search answered. */
  status: 'ok' | 'unavailable';
  papers: EvidencePaper[];
  byLevel: Partial<Record<EvidenceLevel, number>>;
  excluded: { retracted: number; notices: number; preprints: number };
  /** Papers listed without an abstract (no conclusion to read). */
  withoutAbstract: number;
  lookups: (LookupLog | { source: 'europepmc'; ok: boolean; hits: number })[];
  warnings: string[];
}

const MAX_RESULTS = 25;
const DEFAULT_RESULTS = 15;
const ABSTRACT_CHARS = 1500;
const CONCLUSION_CHARS = 700;
const OPENALEX_PER_PAGE = 8;

const HIGH_EVIDENCE_FILTER =
  '("meta-analysis"[pt] OR systematic[sb] OR guideline[pt] OR "practice guideline"[pt] OR "randomized controlled trial"[pt])';

const NOTICE_PUBTYPES = /^(published erratum|retraction of publication|retraction notice|expression of concern)$/i;
const RETRACTED_PUBTYPE = /^retracted publication$/i;

const STOPWORDS = new Set(
  (
    'a an the of in on at to for from by with without and or not no is are was were be been being does do did ' +
    'can could may might will would should shall has have had it its this that these those than then there their ' +
    'what which who whom whose when where why how whether if into over under about after before between during ' +
    'more less most least very really true false claim claims evidence study studies people patients'
  ).split(' '),
);

/** Content words of a sentence, for when the caller gave no search query. */
export function keywordsFromClaim(claim: string): string {
  return normalize(claim)
    .split(' ')
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .slice(0, 12)
    .join(' ');
}

/** A query as PubMed and OpenAlex will accept it: syntax characters out. */
function cleanQuery(q: string): string {
  return q
    .replace(/[[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

const PROTOCOL_TITLE =
  /\b(?:study|trial) protocol\b|\bprotocol (?:for|of) an? (?:\w+[- ])*?(?:trial|study|review)\b|(?::|\s[–—])\s*(?:a |the )?protocol\b|\bstatistical analysis plan\b/i;

/** OpenAlex lists open peer-review reports as works of their own; they are not papers. */
const PEER_REVIEW_TITLE = /^peer review report for\b/i;

function has(types: string[], re: RegExp): boolean {
  return types.some((t) => re.test(t));
}

/**
 * Level of evidence from publication types (authoritative when present), else
 * from words in the title. Never from the abstract: abstracts of narrative
 * reviews routinely mention the meta-analyses they discuss.
 */
export function evidenceLevel(
  pubTypes: string[],
  title: string,
): { level: EvidenceLevel; from: 'publication-type' | 'title' } {
  const pt = (level: EvidenceLevel) => ({ level, from: 'publication-type' as const });
  // A protocol or analysis plan describes a trial that has not reported yet.
  // PubMed often tags it "Randomized Controlled Trial" too, so this comes first.
  if (has(pubTypes, /^clinical (trial|study) protocol$/i)) return pt('protocol');
  if (PROTOCOL_TITLE.test(title)) return { level: 'protocol', from: 'title' };
  if (has(pubTypes, /^(practice guideline|guideline|consensus development conference(, nih)?)$/i))
    return pt('guideline');
  if (has(pubTypes, /^meta-analysis$/i)) return pt('meta-analysis');
  if (has(pubTypes, /^systematic review$/i)) return pt('systematic-review');
  if (has(pubTypes, /^randomized controlled trial$/i)) return pt('rct');
  if (has(pubTypes, /^(controlled )?clinical trial(, phase [iv]+)?$/i)) return pt('clinical-trial');
  if (has(pubTypes, /^observational study$/i)) return pt('observational');
  if (has(pubTypes, /^case reports?$/i)) return pt('case-report');

  const t = ` ${title.toLowerCase()} `;
  const ti = (level: EvidenceLevel) => ({ level, from: 'title' as const });
  if (/\b(guideline|recommendations? (of|from) the|consensus statement)\b/.test(t)) return ti('guideline');
  if (/\bmeta[- ]?analys[ie]s\b/.test(t)) return ti('meta-analysis');
  if (/\b(systematic (review|literature review)|umbrella review)\b/.test(t)) return ti('systematic-review');
  if (/\brandomi[sz]ed\b.*\b(trial|study)\b/.test(t)) return ti('rct');
  if (/\b(clinical trial|phase (1|2|3|i|ii|iii) trial)\b/.test(t)) return ti('clinical-trial');
  if (
    /\b(cohort|case[- ]control|cross[- ]sectional|prospective|retrospective|observational|mendelian randomi[sz]ation|population[- ]based|registry)\b/.test(
      t,
    )
  ) {
    return ti('observational');
  }
  if (has(pubTypes, /^review$/i) || /\breview\b/.test(t))
    return { level: 'review', from: has(pubTypes, /^review$/i) ? 'publication-type' : 'title' };
  if (/\bcase report\b/.test(t)) return ti('case-report');
  return { level: 'other', from: pubTypes.length ? 'publication-type' : 'title' };
}

const CONCLUSION_LABEL =
  /(?:^|[.!?]\s+|\s)(AUTHORS'? CONCLUSIONS?|CONCLUSIONS? AND RELEVANCE|CONCLUSIONS? AND IMPLICATIONS|CONCLUSIONS?|INTERPRETATIONS?|SUMMARY AND CONCLUSIONS?)\s*:\s*/gi;
const NEXT_LABEL = /\s[A-Z][A-Z ,'&-]{3,40}:\s/;

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = cut.lastIndexOf('. ');
  return `${stop > max * 0.6 ? cut.slice(0, stop + 1) : cut.trimEnd()}…`;
}

/**
 * The conclusion of an abstract: the text after its last "Conclusions:" style
 * heading, else its last two sentences. Text is copied, never rewritten, so a
 * reader can quote it.
 */
export function conclusionOf(abstract: string): { text: string; from: 'section' | 'last-sentences' } | undefined {
  const a = abstract.replace(/\s+/g, ' ').trim();
  if (!a) return undefined;
  let last: RegExpExecArray | null = null;
  for (const m of a.matchAll(CONCLUSION_LABEL)) last = m as RegExpExecArray;
  if (last) {
    const rest = a.slice(last.index + last[0].length);
    const next = NEXT_LABEL.exec(rest);
    const text = (next ? rest.slice(0, next.index) : rest).trim();
    if (text.length >= 20) return { text: cap(text, CONCLUSION_CHARS), from: 'section' };
  }
  const sentences =
    a
      .match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (sentences.length === 0) return undefined;
  return { text: cap(sentences.slice(-2).join(' '), CONCLUSION_CHARS), from: 'last-sentences' };
}

interface Candidate {
  paper: Omit<EvidencePaper, 'rank'>;
  /** Position in retrieval order, the tiebreak inside a level. */
  order: number;
}

function fromEpmc(p: EpmcPaper, order: number): Candidate {
  const { level, from } = evidenceLevel(p.pubTypes, p.title);
  const c = p.abstract ? conclusionOf(p.abstract) : undefined;
  return {
    order,
    paper: {
      level,
      levelFrom: from,
      title: p.title,
      ...(p.authorString ? { authors: p.authorString } : {}),
      ...(p.year ? { year: p.year } : {}),
      ...(p.journal ? { journal: p.journal } : {}),
      ...(p.doi ? { doi: p.doi } : {}),
      pmid: p.pmid,
      url: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
      ...(c ? { conclusion: c.text, conclusionFrom: c.from } : {}),
      ...(p.abstract ? { abstract: cap(p.abstract, ABSTRACT_CHARS) } : {}),
      publicationTypes: p.pubTypes,
      preprint: has(p.pubTypes, /^preprint$/i),
      openAccess: p.isOpenAccess,
      ...(p.citedByCount !== undefined ? { citedByCount: p.citedByCount } : {}),
      foundIn: ['pubmed'],
    },
  };
}

function authorString(w: Work): string | undefined {
  if (!w.authors.length) return undefined;
  const names = w.authors
    .slice(0, 3)
    .map((a) => (a.given ? `${a.family} ${a.given.replace(/[^A-Z]/g, '') || a.given}` : a.family));
  return w.authors.length > 3 ? `${names.join(', ')}, et al` : names.join(', ');
}

function fromPubmedSummary(w: Work, order: number): Candidate {
  const { level, from } = evidenceLevel([], w.title);
  return {
    order,
    paper: {
      level,
      levelFrom: from,
      title: w.title,
      ...(authorString(w) ? { authors: authorString(w)! } : {}),
      ...(w.years[0] ? { year: w.years[0] } : {}),
      ...(w.journals[0] ? { journal: w.journals[0] } : {}),
      ...(w.doi ? { doi: w.doi } : {}),
      ...(w.pmid ? { pmid: w.pmid } : {}),
      url: w.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${w.pmid}/` : `https://doi.org/${w.doi}`,
      publicationTypes: [],
      preprint: w.type === 'preprint',
      openAccess: !!w.pmcid,
      foundIn: ['pubmed'],
    },
  };
}

function fromOpenAlex(h: OpenAlexHit, order: number): Candidate {
  const w = h.work;
  const { level } = evidenceLevel([], w.title);
  const c = h.abstract ? conclusionOf(h.abstract) : undefined;
  return {
    order,
    paper: {
      level,
      levelFrom: 'title',
      title: w.title,
      ...(authorString(w) ? { authors: authorString(w)! } : {}),
      ...(w.years[0] ? { year: w.years[0] } : {}),
      ...(w.journals[0] ? { journal: w.journals[0] } : {}),
      ...(w.doi ? { doi: w.doi } : {}),
      ...(w.pmid ? { pmid: w.pmid } : {}),
      url: w.doi ? `https://doi.org/${w.doi}` : `https://pubmed.ncbi.nlm.nih.gov/${w.pmid}/`,
      ...(c ? { conclusion: c.text, conclusionFrom: c.from } : {}),
      ...(h.abstract ? { abstract: cap(h.abstract, ABSTRACT_CHARS) } : {}),
      publicationTypes: w.type ? [w.type] : [],
      preprint: h.isPreprint,
      openAccess: h.isOa,
      ...(h.citedByCount !== undefined ? { citedByCount: h.citedByCount } : {}),
      foundIn: ['openalex'],
    },
  };
}

/** Interleave ranked lists, first occurrence wins: neither search crowds out the other. */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  const n = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < n; i++) {
    for (const l of lists) {
      const v = l[i];
      if (v !== undefined && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

/** Strongest design first; inside a level, papers with an abstract first, then retrieval order. */
export function rankEvidence<
  T extends { paper: { level: EvidenceLevel; abstract?: string; preprint: boolean }; order: number },
>(cands: T[]): T[] {
  const lv = (l: EvidenceLevel) => EVIDENCE_LEVELS.indexOf(l);
  return [...cands].sort(
    (a, b) =>
      lv(a.paper.level) - lv(b.paper.level) ||
      Number(a.paper.preprint) - Number(b.paper.preprint) ||
      Number(!a.paper.abstract) - Number(!b.paper.abstract) ||
      a.order - b.order,
  );
}

function clampYear(y: number | undefined): number | undefined {
  if (y === undefined || !Number.isFinite(y)) return undefined;
  const n = Math.trunc(y);
  return n >= 1800 && n <= 2100 ? n : undefined;
}

export async function findEvidence(
  claim: string,
  filters: EvidenceFilters,
  opts: EvidenceOptions,
): Promise<EvidenceResult> {
  const c = claim.replace(/\s+/g, ' ').trim().slice(0, 1000);
  const query = cleanQuery(filters.query?.trim() || keywordsFromClaim(c));
  const maxResults = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(filters.maxResults ?? DEFAULT_RESULTS)));
  const includePreprints = filters.includePreprints ?? true;
  const warnings: string[] = [];
  let yearFrom = clampYear(filters.yearFrom);
  let yearTo = clampYear(filters.yearTo);
  if (yearFrom && yearTo && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];
  const excluded = { retracted: 0, notices: 0, preprints: 0 };
  const result: EvidenceResult = {
    claim: c,
    query,
    status: 'unavailable',
    papers: [],
    byLevel: {},
    excluded,
    withoutAbstract: 0,
    lookups: [],
    warnings,
  };
  if (query.split(' ').filter(Boolean).length < 1 || query.length < 3) {
    warnings.push('The claim has no searchable words. Pass `query` with English keywords.');
    return result;
  }

  const years = yearFrom || yearTo ? ` AND (${yearFrom ?? 1800}:${yearTo ?? 3000}[dp])` : '';
  const pm = {
    ...(opts.pubmedApiKey ? { apiKey: opts.pubmedApiKey } : {}),
    ...(opts.contactEmail ? { contactEmail: opts.contactEmail } : {}),
  };
  const [relevant, strong, oa] = await Promise.all([
    pubmedSearchIds(opts.http, `(${query})${years}`, { ...pm, retmax: maxResults }),
    pubmedSearchIds(opts.http, `(${query}) AND ${HIGH_EVIDENCE_FILTER}${years}`, {
      ...pm,
      retmax: Math.ceil(maxResults * 0.6),
    }),
    openalexSearchWorks(opts.http, query, {
      perPage: OPENALEX_PER_PAGE,
      withAbstract: true,
      ...(yearFrom ? { yearFrom } : {}),
      ...(yearTo ? { yearTo } : {}),
      ...(opts.openalexApiKey ? { apiKey: opts.openalexApiKey } : {}),
      ...(opts.contactEmail ? { contactEmail: opts.contactEmail } : {}),
    }),
  ]);

  result.lookups.push({
    source: 'pubmed',
    ok: relevant.ok && strong.ok,
    hits: (relevant.ok ? relevant.value.length : 0) + (strong.ok ? strong.value.length : 0),
  });
  result.lookups.push({ source: 'openalex', ok: oa.ok, hits: oa.ok ? oa.value.length : 0 });
  if (!relevant.ok || !strong.ok) warnings.push('PubMed could not be fully searched; results may be incomplete.');
  if (!oa.ok) warnings.push('OpenAlex could not be searched; results cover PubMed only.');
  if (!relevant.ok && !strong.ok && !oa.ok) return result;
  result.status = 'ok';

  // Strong designs first in the interleave so the hydration cap never drops them.
  const pmids = interleave([strong.ok ? strong.value : [], relevant.ok ? relevant.value : []]);
  const oaHits = oa.ok ? oa.value : [];
  const oaAllPmids = new Set(oaHits.map((h) => h.work.pmid).filter((p): p is string => !!p));
  const oaPmids = [...oaAllPmids].filter((p) => !pmids.includes(p));
  const toHydrate = [...pmids, ...oaPmids];

  const cands: Candidate[] = [];
  const seenDoi = new Set<string>();
  const seenPmid = new Set<string>();
  let order = 0;

  if (toHydrate.length) {
    const ep = await europepmcByPmids(
      opts.http,
      toHydrate,
      opts.contactEmail ? { contactEmail: opts.contactEmail } : {},
    );
    result.lookups.push({ source: 'europepmc', ok: ep.ok, hits: ep.ok ? ep.value.length : 0 });
    if (ep.ok) {
      const byPmid = new Map(ep.value.map((p) => [p.pmid, p]));
      for (const id of toHydrate) {
        const p = byPmid.get(id);
        if (!p) continue;
        if (has(p.pubTypes, NOTICE_PUBTYPES)) {
          excluded.notices++;
          continue;
        }
        if (has(p.pubTypes, RETRACTED_PUBTYPE) || /^retracted\b/i.test(p.title)) {
          excluded.retracted++;
          continue;
        }
        const cand = fromEpmc(p, order++);
        if (oaAllPmids.has(id))
          cand.paper.foundIn = pmids.includes(id) ? ['pubmed', 'openalex'] : ['openalex', 'pubmed'];
        seenPmid.add(p.pmid);
        if (p.doi) seenDoi.add(p.doi);
        cands.push(cand);
      }
    } else {
      // No abstracts, but the papers are still real and still ranked.
      warnings.push('Abstracts could not be fetched from Europe PMC; PubMed results are listed without conclusions.');
      const sum = await pubmedSummaries(opts.http, pmids, pm);
      if (sum.ok) {
        for (const w of sum.value) {
          if (w.isNotice) {
            excluded.notices++;
            continue;
          }
          if (w.notices.length) {
            excluded.retracted++;
            continue;
          }
          if (w.pmid) seenPmid.add(w.pmid);
          if (w.doi) seenDoi.add(w.doi);
          cands.push(fromPubmedSummary(w, order++));
        }
      }
    }
  }

  for (const h of oaHits) {
    const w = h.work;
    if ((w.pmid && seenPmid.has(w.pmid)) || (w.doi && seenDoi.has(w.doi))) continue;
    if (!w.doi && !w.pmid) continue;
    if (w.type === 'peer-review' || PEER_REVIEW_TITLE.test(w.title)) continue;
    if (w.type && /^(erratum|retraction|paratext|correction)$/.test(w.type)) {
      excluded.notices++;
      continue;
    }
    if (w.notices.length) {
      excluded.retracted++;
      continue;
    }
    // A PMID that Europe PMC already returned was merged above; one it could not
    // hydrate is still a real paper, so OpenAlex's own record stands in.
    if (w.doi) seenDoi.add(w.doi);
    cands.push(fromOpenAlex(h, order++));
  }

  let ranked = rankEvidence(cands);
  if (!includePreprints) {
    excluded.preprints = ranked.filter((x) => x.paper.preprint).length;
    ranked = ranked.filter((x) => !x.paper.preprint);
  }
  for (const { paper } of ranked.slice(0, maxResults)) {
    result.papers.push({ rank: result.papers.length + 1, ...paper });
    result.byLevel[paper.level] = (result.byLevel[paper.level] ?? 0) + 1;
  }
  result.withoutAbstract = result.papers.filter((p) => !p.abstract).length;
  if (result.papers.length && result.withoutAbstract === result.papers.length) {
    warnings.push('None of these papers has an abstract here; open the links before relying on them.');
  }
  if (excluded.retracted) warnings.push(`${excluded.retracted} retracted paper(s) left out.`);
  return result;
}
