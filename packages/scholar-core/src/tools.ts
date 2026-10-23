/**
 * findTools — research software for a task, from the bio.tools registry, with
 * a licence verdict, the tool's paper checked, a maintenance label and an
 * install line.
 *
 * Like `findDatasets`, this module makes no model call and writes no prose a
 * database did not support:
 *   - candidates come from bio.tools (ELIXIR), which classifies tools with EDAM
 *     terms for what they do and which file formats they read and write;
 *   - relevance is the share of the question's keywords found in the record;
 *   - the licence verdict is the fixed table in `./licence`;
 *   - the "paper" is only a DOI or PMID the registry lists, looked up in
 *     Crossref / PubMed for existence and retraction or correction notices;
 *   - the maintenance label is read from the GitHub repository the registry
 *     links to (last push, archived flag), never guessed;
 *   - an install line appears only when the registry links to PyPI, Bioconda,
 *     Bioconductor, CRAN or a GitHub repository, and is built from that link.
 * Explaining why a tool fits the task is left to the assistant that called
 * this, which has the question and the facts.
 */

import type { CitationStyle } from './format';
import {
  checkPaper,
  datasetTerms,
  relevanceOf,
  termRegex,
  MIN_RELEVANCE,
  type DatasetPaper,
  type DatasetOptions,
  type IntendedUse,
  type MatchLevel,
  type PaperRef,
} from './datasets';
import { normalize } from './text';
import { licenceVerdict, OPEN_VERDICTS, type LicenceVerdict } from './licence';
import { BIOTOOLS_LICENCE_NOTE, biotoolsSearch, type BiotoolsTool } from './sources/biotools';
import { githubRepo, githubRepoOf, type GithubRepo } from './sources/github';

export type ToolHealth = 'active' | 'idle' | 'stale' | 'archived' | 'unknown';

export interface ToolQuery {
  /** What the researcher wants to do, in their own words. */
  question: string;
  /** English search keywords. Defaults to the question's content words. */
  keywords?: string;
  /** The file format the data is in (`H5AD`, `FASTQ`, `VCF`…), to favour tools that read it. */
  inputFormat?: string;
  intendedUse?: IntendedUse;
  /** 1–5, default 3. */
  maxResults?: number;
  citationStyle?: CitationStyle;
}

export interface ToolOptions extends DatasetOptions {
  /** The clock, for the maintenance label. Defaults to now. */
  now?: Date;
  /** A GitHub token, to lift the anonymous rate limit on the maintenance lookups. */
  githubToken?: string;
}

export interface ToolInstall {
  kind: 'pip' | 'conda' | 'bioconductor' | 'cran' | 'source';
  line: string;
  /** The registry link the line was built from. */
  from: string;
}

export interface ToolResult {
  rank: number;
  /** The bio.tools id. */
  id: string;
  name: string;
  /** The tool's page on bio.tools. */
  url: string;
  homepage?: string;
  description?: string;
  match: MatchLevel;
  /** Facts behind the match: the keywords found, the format, the operations. */
  why: string;
  matchedTerms: string[];
  relevance: number;
  operations: string[];
  inputFormats: string[];
  outputFormats: string[];
  languages: string[];
  /** True when the requested input format appears among the tool's inputs. */
  readsRequestedFormat?: boolean;
  licence: { spdx?: string; verdict: LicenceVerdict; label: string; notes: string[] };
  paper: DatasetPaper;
  /** True when the paper the registry lists is a preprint. */
  paperIsPreprint?: boolean;
  health: { label: ToolHealth; note: string; lastPush?: string };
  install?: ToolInstall;
}

export interface ToolsResult {
  question: string;
  terms: string[];
  inputFormat?: string;
  status: 'ok' | 'unavailable';
  intendedUse: IntendedUse;
  results: ToolResult[];
  stats: { candidates: number; results: number; papersVerified: number; warnings: number };
  takeaways: string[];
  warnings: string[];
  lookups: { source: 'biotools' | 'github'; ok: boolean; hits: number }[];
  suggestions: string[];
  /** Where the tool records come from, and what to check about them. */
  dataNote: string;
}

export const MAX_TOOL_RESULTS = 5;
const DEFAULT_RESULTS = 3;
const DESCRIPTION_CHARS = 400;
/** Months since the last push: under a year is active, under three idle. */
const ACTIVE_MONTHS = 12;
const IDLE_MONTHS = 36;
/** Below this many registry records, a second, broader query is added. */
const ENOUGH_CANDIDATES = 12;

/** Words that describe the request, not the software. */
const TOOL_REQUEST_WORDS = new Set(
  'tool tools software package packages program programs pipeline pipelines workflow workflows library libraries app apps application applications code script scripts method methods algorithm algorithms'.split(
    ' ',
  ),
);

export function toolTerms(question: string, keywords?: string): string[] {
  return datasetTerms(question, keywords).filter((t) => !TOOL_REQUEST_WORDS.has(t));
}

/**
 * Query words keep their hyphens ("single-cell" is one word in the registry) and
 * come from the question's own tokens, longest first, keeping those that
 * carry a search term.
 */
export function queryWords(text: string, terms: string[]): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  const keep = tokens.filter((tok) => tok.split('-').some((part) => terms.includes(part)));
  return [...new Set(keep)].sort((a, b) => b.length - a.length);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `scRNA-seq` is written out as "single-cell RNA-seq" in most records. */
const SINGLE_CELL_ASSAY = /^sc(rna|atac|dna|chip|tcr|bcr|cut|hic|mrna)$/;

/**
 * The patterns one query word must match. A plain word matches like a search
 * term; a hyphenated word ("rna-seq", "single-cell") must appear as one phrase,
 * so a record that says "sequencing" and, elsewhere, "gRNA" does not count as
 * RNA-seq. The last part matches as a prefix ("seq" → "sequencing").
 */
export function conceptPatterns(word: string): RegExp[] {
  const parts = word.split('-').filter(Boolean);
  if (parts.length < 2) {
    // "clustering" should find "clusters", "calling" find "calls".
    const stem = word.replace(/(ings?|ations?|ed|es|s)$/, '');
    return [stem.length >= 4 ? new RegExp(`(^|\\s)${esc(stem)}`) : termRegex(word)];
  }
  const phrase = (ps: string[]) => new RegExp(`(^|\\s)${ps.map(esc).join('\\s?')}`);
  const out = [phrase(parts)];
  const sc = SINGLE_CELL_ASSAY.exec(parts[0]!);
  // "single-cell RNA-seq", "single-cell RNA sequencing", "single-cell RNA".
  if (sc) out.push(phrase(['single', 'cell', sc[1]!]));
  return out;
}

/** Share of the query's words found in a tool record; title hits count fully, body hits 0.8. */
export function toolRelevance(
  words: string[],
  name: string,
  body: string,
): { score: number; matched: string[] } {
  if (words.length === 0) return { score: 0, matched: [] };
  const t = ` ${normalize(name)} `;
  const b = ` ${normalize(body)} `;
  let sum = 0;
  const matched: string[] = [];
  for (const w of words) {
    const res = conceptPatterns(w);
    if (res.some((re) => re.test(t))) {
      sum += 1;
      matched.push(w);
    } else if (res.some((re) => re.test(b))) {
      sum += 0.8;
      matched.push(w);
    }
  }
  return { score: Math.round((sum / words.length) * 100) / 100, matched };
}

function shorten(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= DESCRIPTION_CHARS) return t;
  const cut = t.slice(0, DESCRIPTION_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), DESCRIPTION_CHARS - 40))}…`;
}

const PKG = /^[A-Za-z][A-Za-z0-9._-]{0,60}$/;

/** An install line built from a URL the registry lists; undefined when none fits. */
export function installFrom(urls: string[]): ToolInstall | undefined {
  const found: Partial<Record<ToolInstall['kind'], ToolInstall>> = {};
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    if (host === 'pypi.org' && parts[0] === 'project' && parts[1] && PKG.test(parts[1])) {
      found.pip ??= { kind: 'pip', line: `pip install ${parts[1]}`, from: raw };
    } else if (
      host === 'anaconda.org' &&
      parts[0] === 'bioconda' &&
      parts[1] &&
      PKG.test(parts[1])
    ) {
      found.conda ??= { kind: 'conda', line: `conda install -c bioconda ${parts[1]}`, from: raw };
    } else if (
      host === 'bioconda.github.io' &&
      parts[0] === 'recipes' &&
      parts[1] &&
      PKG.test(parts[1])
    ) {
      found.conda ??= { kind: 'conda', line: `conda install -c bioconda ${parts[1]}`, from: raw };
    } else if (host === 'bioconductor.org' && parts[0] === 'packages') {
      const name = parts.find(
        (p, i) =>
          i > 0 && PKG.test(p) && !/^(release|devel|bioc|html|\d)/.test(p) && !p.endsWith('.html'),
      );
      const fromHtml = parts[parts.length - 1]?.replace(/\.html$/, '');
      const pkg = name ?? fromHtml;
      if (pkg && PKG.test(pkg))
        found.bioconductor ??= {
          kind: 'bioconductor',
          line: `BiocManager::install("${pkg}")`,
          from: raw,
        };
    } else if (host === 'cran.r-project.org') {
      const q = u.searchParams.get('package');
      const pkg = q ?? (parts[0] === 'web' && parts[1] === 'packages' ? parts[2] : undefined);
      if (pkg && PKG.test(pkg))
        found.cran ??= { kind: 'cran', line: `install.packages("${pkg}")`, from: raw };
    } else {
      const gh = githubRepoOf(raw);
      if (gh) {
        found.source ??= {
          kind: 'source',
          line: `git clone https://github.com/${gh.owner}/${gh.name}.git`,
          from: `https://github.com/${gh.owner}/${gh.name}`,
        };
      }
    }
  }
  return found.pip ?? found.conda ?? found.bioconductor ?? found.cran ?? found.source;
}

function months(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (30.44 * 24 * 3600 * 1000);
}

export function healthOf(repo: GithubRepo | null | undefined, now: Date): ToolResult['health'] {
  if (!repo) {
    return {
      label: 'unknown',
      note: 'No GitHub repository is linked, so maintenance could not be checked.',
    };
  }
  if (repo.archived) {
    return {
      label: 'archived',
      note: 'The GitHub repository is archived: read-only, no further fixes.',
      ...(repo.pushedAt ? { lastPush: repo.pushedAt.slice(0, 10) } : {}),
    };
  }
  const pushed = repo.pushedAt ? new Date(repo.pushedAt) : undefined;
  if (!pushed || Number.isNaN(pushed.getTime())) {
    return { label: 'unknown', note: 'GitHub did not report a last push date.' };
  }
  const age = months(pushed, now);
  const when = pushed.toISOString().slice(0, 10);
  if (age <= ACTIVE_MONTHS)
    return { label: 'active', note: `Last code push ${when}.`, lastPush: when };
  if (age <= IDLE_MONTHS)
    return { label: 'idle', note: `No code push since ${when}.`, lastPush: when };
  return {
    label: 'stale',
    note: `No code push since ${when}: may not run on current versions.`,
    lastPush: when,
  };
}

/** Free to use and something to check: a paper to verify or code to read. */
function usable(t: BiotoolsTool): boolean {
  if (t.cost && !/free/i.test(t.cost)) return false;
  if (t.licence && /^proprietary$/i.test(t.licence)) return false;
  const hasCode = t.urls.some((u) => githubRepoOf(u));
  return t.publications.length > 0 || hasCode || installFrom(t.urls) !== undefined;
}

function paperRefOf(t: BiotoolsTool): { ref?: PaperRef; preprint: boolean } {
  const rank = (p: BiotoolsTool['publications'][number]) =>
    p.types.includes('Primary')
      ? 0
      : p.types.includes('Method')
        ? 1
        : p.types.includes('Preprint')
          ? 3
          : 2;
  const best = [...t.publications].sort((a, b) => rank(a) - rank(b))[0];
  if (!best) return { preprint: false };
  return {
    ref: best.doi ? { doi: best.doi } : { pmid: best.pmid },
    preprint: best.types.includes('Preprint'),
  };
}

function matchLevel(
  rel: number,
  paper: DatasetPaper['status'],
  verdict: LicenceVerdict,
  health: ToolHealth,
  intendedUse: IntendedUse,
  preprint = false,
): MatchLevel {
  if (
    paper === 'retracted' ||
    paper === 'concern' ||
    paper === 'not_found' ||
    health === 'archived'
  )
    return 'use_with_care';
  if (intendedUse === 'commercial' && !OPEN_VERDICTS.includes(verdict)) return 'use_with_care';
  if (
    !preprint &&
    rel >= 0.75 &&
    paper === 'verified' &&
    OPEN_VERDICTS.includes(verdict) &&
    (health === 'active' || health === 'unknown')
  )
    return 'best';
  if (rel >= MIN_RELEVANCE && health !== 'stale' && paper !== 'none_linked') return 'good';
  return 'use_with_care';
}

export async function findTools(input: ToolQuery, opts: ToolOptions): Promise<ToolsResult> {
  const question = input.question.trim();
  const intendedUse = input.intendedUse ?? 'publication';
  const style = input.citationStyle ?? 'apa';
  const maxResults = Math.min(MAX_TOOL_RESULTS, Math.max(1, input.maxResults ?? DEFAULT_RESULTS));
  const now = opts.now ?? new Date();
  const terms = toolTerms(question, input.keywords);
  const format =
    input.inputFormat
      ?.trim()
      .replace(/[^A-Za-z0-9 ._-]/g, '')
      .slice(0, 30) || undefined;
  const base = {
    question,
    terms,
    ...(format ? { inputFormat: format } : {}),
    intendedUse,
    dataNote: BIOTOOLS_LICENCE_NOTE,
  };
  const empty = (
    status: ToolsResult['status'],
    warnings: string[],
    suggestions: string[],
    ok?: boolean,
  ): ToolsResult => ({
    ...base,
    status,
    results: [],
    stats: { candidates: 0, results: 0, papersVerified: 0, warnings: warnings.length },
    takeaways: [],
    warnings,
    lookups: ok === undefined ? [] : [{ source: 'biotools', ok, hits: 0 }],
    suggestions,
  });
  if (terms.length === 0) {
    return empty(
      'unavailable',
      ['The question has no searchable words.'],
      ['Pass `keywords` with English words for the task, e.g. "single-cell clustering".'],
    );
  }

  const lookups: ToolsResult['lookups'] = [];
  // The registry matches every word, so a long list finds little: ask with the
  // longest few, then with the two longest, and rank the union here. The format
  // is not a search word: many tools list it only in their documentation.
  const words = queryWords(input.keywords?.trim() ? input.keywords : question, terms);
  let search = await biotoolsSearch(opts.http, words);
  if (search.ok && search.value.length < ENOUGH_CANDIDATES && words.length > 2) {
    const narrower = await biotoolsSearch(opts.http, words.slice(0, 2));
    if (narrower.ok) {
      const ids = new Set(search.value.map((t) => t.id));
      search = {
        ok: true,
        value: [...search.value, ...narrower.value.filter((t) => !ids.has(t.id))],
      };
    }
  }
  if (!search.ok) {
    return empty(
      'unavailable',
      [
        search.reason === 'rate_limited'
          ? 'bio.tools is rate-limiting requests; try again shortly.'
          : 'bio.tools could not be reached.',
      ],
      [],
      false,
    );
  }
  lookups.push({ source: 'biotools', ok: true, hits: search.value.length });

  // Rank on the question's own words, compounds kept whole: the registry's
  // full-text search returns anything mentioning any word.
  const concepts = words;
  const wantFormat = format?.toLowerCase();
  const scored = search.value
    .filter(usable)
    .map((t) => {
      const body = [
        t.description ?? '',
        ...t.operations,
        ...t.topics,
        ...t.toolTypes,
        t.languages.join(' '),
      ].join(' ');
      const rel = concepts.length
        ? toolRelevance(concepts, t.name, body)
        : relevanceOf(terms, t.name, body);
      const reads = wantFormat
        ? t.inputFormats.some((f) => f.toLowerCase().includes(wantFormat))
        : undefined;
      return { t, rel, reads, score: rel.score + (reads ? 0.2 : 0) };
    })
    .filter((x) => x.rel.score >= MIN_RELEVANCE)
    .sort((a, b) => b.score - a.score || b.t.publications.length - a.t.publications.length);

  const warnings: string[] = [];
  if (wantFormat && scored.length > 0 && !scored.some((x) => x.reads)) {
    warnings.push(
      `No tool in these results lists ${format} among its input formats; they match the task only. Check each tool's documentation for ${format} support.`,
    );
  }

  const results: ToolResult[] = [];
  const top = scored.slice(0, maxResults);
  let githubOk = true;
  let githubAsked = false;
  // One at a time: Crossref's public pool allows one request in flight.
  for (const { t, rel, reads } of top) {
    const { ref, preprint } = paperRefOf(t);
    const paper = await checkPaper(ref, opts, style);
    const ghRef = t.urls.map(githubRepoOf).find(Boolean);
    let repo: GithubRepo | null | undefined;
    if (ghRef && githubOk) {
      githubAsked = true;
      const r = await githubRepo(opts.http, ghRef, opts.githubToken);
      if (r.ok) repo = r.value;
      else githubOk = false;
    }
    const health = healthOf(repo, now);
    const notes: string[] = [];
    let info = licenceVerdict(t.licence);
    if (info.verdict === 'unclear' && repo?.licence) {
      const gh = licenceVerdict(repo.licence);
      if (gh.verdict !== 'unclear') {
        info = gh;
        notes.push(
          'The licence shown is the one GitHub detected in the repository; bio.tools lists none usable.',
        );
      }
    }
    if (info.verdict === 'unclear') {
      notes.push(
        info.spdx
          ? `The listed licence (${info.spdx}) is not one this check can classify: read its terms before you build on it.`
          : 'No usable licence is listed: read the repository before you build on it.',
      );
    }
    if (intendedUse === 'commercial' && !OPEN_VERDICTS.includes(info.verdict)) {
      notes.push('Not cleared for commercial use by its licence.');
    }
    const install = installFrom(t.urls);
    results.push({
      rank: results.length + 1,
      id: t.id,
      name: t.name,
      url: t.url,
      ...(t.homepage ? { homepage: t.homepage } : {}),
      ...(shorten(t.description) ? { description: shorten(t.description) } : {}),
      match: matchLevel(rel.score, paper.status, info.verdict, health.label, intendedUse, preprint),
      why: whyLine(t, rel.matched, reads, paper, preprint),
      matchedTerms: rel.matched,
      relevance: rel.score,
      operations: t.operations.slice(0, 6),
      inputFormats: t.inputFormats.slice(0, 8),
      outputFormats: t.outputFormats.slice(0, 8),
      languages: t.languages.slice(0, 4),
      ...(reads !== undefined ? { readsRequestedFormat: reads } : {}),
      licence: {
        ...(info.spdx ? { spdx: info.spdx } : {}),
        verdict: info.verdict,
        label: info.label,
        notes,
      },
      paper,
      ...(preprint ? { paperIsPreprint: true } : {}),
      health,
      ...(install ? { install } : {}),
    });
  }
  if (!githubOk) {
    warnings.push(
      'GitHub could not be reached for some tools, so their maintenance label is missing.',
    );
  }

  const ORDER: Record<MatchLevel, number> = { best: 0, good: 1, use_with_care: 2 };
  results.sort((a, b) => ORDER[a.match] - ORDER[b.match] || a.rank - b.rank);
  results.forEach((r, i) => (r.rank = i + 1));
  if (githubAsked) {
    lookups.push({
      source: 'github',
      ok: githubOk,
      hits: results.filter((r) => r.health.label !== 'unknown').length,
    });
  }

  for (const r of results) {
    if (r.paper.status === 'retracted')
      warnings.push(`The paper behind ${r.name} has been retracted.`);
    else if (r.paper.status === 'correction')
      warnings.push(`The paper behind ${r.name} has a published correction.`);
    else if (r.paper.status === 'concern')
      warnings.push(`The paper behind ${r.name} has an expression of concern.`);
    else if (r.paper.status === 'not_found')
      warnings.push(`The paper listed for ${r.name} could not be found.`);
  }

  const papersVerified = results.filter(
    (r) => r.paper.status === 'verified' || r.paper.status === 'correction',
  ).length;
  return {
    ...base,
    status: 'ok',
    results,
    stats: {
      candidates: search.value.length,
      results: results.length,
      papersVerified,
      warnings: warnings.length,
    },
    takeaways: takeaways(results, intendedUse, format),
    warnings,
    lookups,
    suggestions: results.length ? [] : suggestionsFor(),
  };
}

function whyLine(
  t: BiotoolsTool,
  matched: string[],
  reads: boolean | undefined,
  paper: DatasetPaper,
  preprint: boolean,
): string {
  const parts: string[] = [];
  if (matched.length) parts.push(`matches ${matched.join(', ')}`);
  if (t.operations.length) parts.push(`does ${t.operations.slice(0, 3).join(', ').toLowerCase()}`);
  if (reads) parts.push('reads the format you named');
  if (paper.status === 'verified' || paper.status === 'correction') {
    parts.push(
      preprint
        ? 'paper is a preprint (not peer reviewed)'
        : `paper: ${paper.journal ?? 'found'}${paper.year ? ` ${paper.year}` : ''}`,
    );
  } else if (paper.status === 'none_linked') parts.push('no paper listed');
  return parts.join('; ');
}

function lowerFirst(s: string): string {
  return /^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

function takeaways(results: ToolResult[], intendedUse: IntendedUse, format?: string): string[] {
  if (results.length === 0) return [];
  const out: string[] = [];
  const first = results.find((r) => r.match === 'best') ?? results.find((r) => r.match === 'good');
  if (first) {
    const facts = [
      first.paper.status === 'verified' ? 'its paper checks out' : undefined,
      first.health.label === 'active' ? 'code pushed in the last year' : undefined,
      first.health.label === 'idle' ? `no code push since ${first.health.lastPush}` : undefined,
      first.licence.verdict === 'unclear' ? undefined : lowerFirst(first.licence.label),
    ].filter(Boolean);
    out.push(`Start with ${first.name}${facts.length ? `: ${facts.join('; ')}` : ''}.`);
  }
  const old = results.filter((r) => r.health.label === 'stale' || r.health.label === 'archived');
  if (old.length) {
    out.push(
      `${old.length} of ${results.length} look unmaintained (${old.map((r) => r.name).join(', ')}); test them on a small example before you rely on them.`,
    );
  }
  const unclear = results.filter((r) =>
    intendedUse === 'commercial'
      ? !OPEN_VERDICTS.includes(r.licence.verdict)
      : r.licence.verdict === 'unclear',
  );
  if (unclear.length) {
    out.push(
      intendedUse === 'commercial'
        ? `${unclear.length} of ${results.length} are not cleared for commercial use; check their licences first.`
        : `${unclear.length} of ${results.length} list no clear licence; confirm the terms before you publish with them.`,
    );
  }
  const noPaper = results.filter((r) => r.paper.status === 'none_linked');
  if (noPaper.length && out.length < 3) {
    out.push(
      `${noPaper.length} of ${results.length} list no paper, so you would cite the software itself and its version.`,
    );
  }
  if (format && out.length < 3 && results.every((r) => r.readsRequestedFormat === false)) {
    out.push(
      `None of them lists ${format} as an input format; convert the data or read their documentation first.`,
    );
  }
  return out.slice(0, 3);
}

function suggestionsFor(): string[] {
  return [
    'Describe the task with one or two English words (e.g. "clustering", "variant calling", "peak calling").',
    'Name the data type rather than the disease: the registry classifies tools by what they do.',
  ];
}
