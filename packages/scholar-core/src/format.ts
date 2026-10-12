/**
 * formatCitations — turn references into a citation style or an export format.
 *
 * Formatting is done by citeproc-js (through citation-js) with the OFFICIAL
 * CSL style files, embedded in `csl-styles.generated.ts`. Hand-written
 * formatters drift from the manuals in a hundred small ways (et al. rules,
 * en dashes, page abbreviation); the CSL styles are what Zotero, Mendeley and
 * the journals themselves maintain.
 *
 * What gets formatted is decided by where a reference came from, and that
 * decision is reported on every entry:
 *   - a verified result is formatted from the RECORD it matched, so the
 *     corrections verification found are applied;
 *   - anything not verified (fabricated, not found, ambiguous, a bare parsed
 *     reference) is formatted exactly as cited and marked `verified: false`.
 * A formatter that silently "fixes" an unverified reference would be
 * inventing metadata, which is the one thing this package never does.
 */

import { Cite, plugins } from '@citation-js/core';
import '@citation-js/plugin-csl';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-ris';
import type { CSL, CSLName, CSLType } from '@citation-js/core';
import { CSL_STYLES } from './csl-styles.generated';
import { isRetractionType } from './retractions';
import type { Author, ParsedRef, VerificationResult, VerificationStatus, Work } from './types';

export type CitationStyle = keyof typeof CSL_STYLES;
export const CITATION_STYLES = Object.keys(CSL_STYLES) as CitationStyle[];

export type CitationOutput = 'text' | 'html' | 'bibtex' | 'ris' | 'csl-json';
export const CITATION_OUTPUTS: CitationOutput[] = ['text', 'html', 'bibtex', 'ris', 'csl-json'];

export type CslItem = CSL;

/** Anything a caller may hand in: a verify result, a database record, a parsed reference, or CSL-JSON. */
export type CitableInput = VerificationResult | Work | ParsedRef | CslItem;

/**
 * Where the metadata of an entry came from:
 *   `record`    a bibliographic database record (verified, or a `Work` passed directly)
 *   `as-cited`  the reference as the user wrote it, not confirmed by any database
 *   `csl-json`  CSL-JSON supplied by the caller, passed through untouched
 */
export type EntrySource = 'record' | 'as-cited' | 'csl-json';

export interface FormattedEntry {
  /** Position in the input, 0-based. */
  index: number;
  /** CSL item id (`ref-1`, `ref-2`…). */
  id: string;
  source: EntrySource;
  /** True only when a database record backs every field. */
  verified: boolean;
  /** Verification status, when the input was a verify result. */
  status?: VerificationStatus;
  retracted: boolean;
  /** This entry's line in the bibliography, in the requested style. */
  bibliography: string;
  /** In-text citation, numbered by input order for numeric styles. */
  inText: string;
  warnings: string[];
  csl: CslItem;
}

export interface FormatResult {
  style: CitationStyle;
  /** Human title of the official CSL style used (e.g. "APA Style 7th edition"). */
  styleTitle: string;
  output: CitationOutput;
  /** Input order. */
  entries: FormattedEntry[];
  /**
   * The finished output: the bibliography in the style's own order for
   * `text`/`html`, or the export file content for `bibtex`/`ris`/`csl-json`.
   */
  content: string;
  /** One line per entry that needs the reader's attention. */
  warnings: string[];
}

export interface FormatOptions {
  /** CSL locale. Only `en-US` ships with the CSL plugin; others fall back to it. */
  locale?: string;
}

const DEFAULT_LOCALE = 'en-US';
const STYLE_PREFIX = 'pho-';

let registered = false;
function ensureStyles(): void {
  if (registered) return;
  const cfg = plugins.config.get('@csl');
  for (const [id, s] of Object.entries(CSL_STYLES)) cfg.styles.add(STYLE_PREFIX + id, s.xml);
  registered = true;
}

export function isCitationStyle(s: string): s is CitationStyle {
  return Object.prototype.hasOwnProperty.call(CSL_STYLES, s);
}

// ---------------------------------------------------------------------------
// Input → CSL-JSON
// ---------------------------------------------------------------------------

function isVerificationResult(x: CitableInput): x is VerificationResult {
  return typeof x === 'object' && x !== null && 'status' in x && 'input' in x && 'mismatches' in x;
}
function isWork(x: CitableInput): x is Work {
  return typeof x === 'object' && x !== null && 'source' in x && 'years' in x && 'journals' in x;
}
function isParsedRef(x: CitableInput): x is ParsedRef {
  return typeof x === 'object' && x !== null && 'raw' in x && 'format' in x && 'authors' in x;
}

/** PubMed gives initials without dots (`SB`); citeproc reads that as one name word. */
function expandInitials(given: string): string {
  return /^[A-Z]{1,4}$/.test(given) ? given.split('').map((c) => `${c}.`).join(' ') : given;
}

function toCslName(a: Author): CSLName {
  if (!a.given) return /\s/.test(a.family) ? { literal: a.family } : { family: a.family };
  return { family: a.family, given: expandInitials(a.given) };
}

const TYPE_MAP: Record<string, CSLType> = {
  'journal-article': 'article-journal',
  article: 'article-journal',
  jour: 'article-journal',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  'book-chapter': 'chapter',
  'book-section': 'chapter',
  'book-part': 'chapter',
  chap: 'chapter',
  inbook: 'chapter',
  incollection: 'chapter',
  'proceedings-article': 'paper-conference',
  inproceedings: 'paper-conference',
  conf: 'paper-conference',
  'posted-content': 'article',
  preprint: 'article',
  dissertation: 'thesis',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
  thes: 'thesis',
  report: 'report',
  techreport: 'report',
  rprt: 'report',
  dataset: 'dataset',
  review: 'article-journal',
  letter: 'article-journal',
  editorial: 'article-journal',
};

function cslType(type: string | undefined, hasJournal: boolean): CSLType {
  const t = type ? TYPE_MAP[type.toLowerCase()] : undefined;
  return t ?? (hasJournal ? 'article-journal' : 'article');
}

function issued(year: number | undefined): Pick<CSL, 'issued'> {
  return year ? { issued: { 'date-parts': [[year]] } } : {};
}

/**
 * The year printed for a record. A record can carry several legitimate years
 * (print, online, issue cover date); when the user's own year is one of them
 * we keep it, otherwise the first (print year when the record has one).
 */
function yearFor(work: Work, cited?: number): number | undefined {
  if (cited && work.years.includes(cited)) return cited;
  return work.years[0];
}

export function workToCsl(work: Work, id: string, citedYear?: number): CslItem {
  const [journal, ...rest] = work.journals;
  const abbrev = rest.find((j) => j.length < (journal ?? '').length);
  return {
    id,
    type: cslType(work.type, !!journal),
    title: work.title,
    ...(work.authors.length ? { author: work.authors.map(toCslName) } : {}),
    ...issued(yearFor(work, citedYear)),
    ...(journal ? { 'container-title': journal } : {}),
    ...(abbrev ? { 'container-title-short': abbrev, journalAbbreviation: abbrev } : {}),
    ...(work.volume ? { volume: work.volume } : {}),
    ...(work.issue ? { issue: work.issue } : {}),
    ...(work.pages ? { page: work.pages } : {}),
    ...(work.doi ? { DOI: work.doi } : {}),
    ...(work.pmid ? { PMID: work.pmid } : {}),
  } as CslItem;
}

export function parsedRefToCsl(ref: ParsedRef, id: string): CslItem {
  return {
    id,
    type: cslType(ref.type, !!ref.journal),
    title: ref.title ?? ref.raw,
    ...(ref.authors.length ? { author: ref.authors.map(toCslName) } : {}),
    ...issued(ref.year),
    ...(ref.journal ? { 'container-title': ref.journal } : {}),
    ...(ref.volume ? { volume: ref.volume } : {}),
    ...(ref.issue ? { issue: ref.issue } : {}),
    ...(ref.pages ? { page: ref.pages } : {}),
    ...(ref.doi ? { DOI: ref.doi } : {}),
    ...(ref.pmid ? { PMID: ref.pmid } : {}),
    ...(ref.url && !ref.doi ? { URL: ref.url } : {}),
  } as CslItem;
}

const UNVERIFIED_STATUSES = new Set<VerificationStatus>(['likely_fabricated', 'not_found', 'ambiguous']);

interface Prepared {
  csl: CslItem;
  source: EntrySource;
  verified: boolean;
  status?: VerificationStatus;
  retracted: boolean;
  warnings: string[];
}

function prepare(input: CitableInput, id: string): Prepared {
  if (isVerificationResult(input)) {
    const { status, match } = input;
    if (match && !UNVERIFIED_STATUSES.has(status)) {
      const retracted = status === 'retracted';
      const warnings: string[] = [];
      if (retracted) warnings.push('This paper has been retracted. Do not cite it as valid evidence.');
      if (status === 'verified_with_corrections') {
        warnings.push(`Formatted from the matched record; corrected: ${input.mismatches.map((m) => m.field).join(', ')}.`);
      }
      return {
        csl: workToCsl(match, id, input.input.year),
        source: 'record',
        verified: true,
        status,
        retracted,
        warnings,
      };
    }
    return {
      csl: parsedRefToCsl(input.input, id),
      source: 'as-cited',
      verified: false,
      status,
      retracted: false,
      warnings: [`Not verified (${status.replace(/_/g, ' ')}): formatted exactly as cited.`],
    };
  }
  if (isWork(input)) {
    const retracted = input.notices.some((n) => isRetractionType(n.type));
    return {
      csl: workToCsl(input, id),
      source: 'record',
      verified: true,
      retracted,
      warnings: retracted ? ['This paper has been retracted. Do not cite it as valid evidence.'] : [],
    };
  }
  if (isParsedRef(input)) {
    return {
      csl: parsedRefToCsl(input, id),
      source: 'as-cited',
      verified: false,
      retracted: false,
      warnings: ['Not verified: formatted exactly as cited. Run verifyReferences first.'],
    };
  }
  return {
    csl: { ...input, id },
    source: 'csl-json',
    verified: false,
    retracted: false,
    warnings: ['Not verified: CSL-JSON formatted as provided.'],
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** The citeproc engine citation-js builds, reduced to what we call. */
interface CiteprocEngine {
  updateItems(ids: string[]): void;
  makeBibliography(): [{ entry_ids: string[][] }, string[]] | false;
  makeCitationCluster(items: { id: string }[]): string;
}

function engineFor(items: CslItem[], style: CitationStyle, locale: string, format: 'text' | 'html'): CiteprocEngine {
  ensureStyles();
  const engine = plugins.config.get('@csl').engine(items, STYLE_PREFIX + style, locale, format) as CiteprocEngine;
  // Registering in input order is what gives numeric styles (Vancouver, IEEE,
  // AMA) their citation numbers.
  engine.updateItems(items.map((i) => String(i.id)));
  return engine;
}

/**
 * Format references in one of the seven supported styles, or export them.
 *
 * @param refs   verify results (recommended), database records, parsed references or CSL-JSON
 * @param style  apa · mla · chicago · harvard · vancouver · ieee · ama
 * @param output text · html · bibtex · ris · csl-json
 */
export function formatCitations(
  refs: CitableInput[],
  style: CitationStyle,
  output: CitationOutput = 'text',
  opts: FormatOptions = {},
): FormatResult {
  if (!isCitationStyle(style)) throw new Error(`Unknown citation style: ${String(style)}`);
  if (!CITATION_OUTPUTS.includes(output)) throw new Error(`Unknown output format: ${String(output)}`);
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const prepared = refs.map((r, i) => prepare(r, `ref-${i + 1}`));
  const items = prepared.map((p) => p.csl);
  const markup: 'text' | 'html' = output === 'html' ? 'html' : 'text';

  const entryText = new Map<string, string>();
  const inText = new Map<string, string>();
  let bibliography = '';
  if (items.length > 0) {
    const engine = engineFor(items, style, locale, markup);
    const bib = engine.makeBibliography();
    if (bib) {
      const [meta, lines] = bib;
      meta.entry_ids.forEach((ids, k) => entryText.set(String(ids[0]), (lines[k] ?? '').trim()));
      bibliography =
        markup === 'html'
          ? `<div class="csl-bib-body">\n${lines.map((l) => `  ${l.trim()}`).join('\n')}\n</div>`
          : lines.map((l) => l.trim()).join('\n');
    }
    for (const it of items) inText.set(String(it.id), engine.makeCitationCluster([{ id: String(it.id) }]));
  }

  const entries: FormattedEntry[] = prepared.map((p, index) => ({
    index,
    id: String(p.csl.id),
    source: p.source,
    verified: p.verified,
    ...(p.status ? { status: p.status } : {}),
    retracted: p.retracted,
    bibliography: entryText.get(String(p.csl.id)) ?? '',
    inText: inText.get(String(p.csl.id)) ?? '',
    warnings: p.warnings,
    csl: p.csl,
  }));

  let content = bibliography;
  if (output === 'bibtex' || output === 'ris') {
    content = items.length ? String(new Cite(items).format(output === 'bibtex' ? 'bibtex' : 'ris')).trim() : '';
  } else if (output === 'csl-json') {
    content = JSON.stringify(items, null, 2);
  }

  return {
    style,
    styleTitle: CSL_STYLES[style].title,
    output,
    entries,
    content,
    warnings: entries.flatMap((e) => e.warnings.map((w) => `[${e.index + 1}] ${w}`)),
  };
}
