/**
 * `parseReferences` — split whatever the user pasted into individual references.
 *
 * Accepts a pasted reference list in any common style (APA, Vancouver/AMA,
 * MLA, Chicago, Harvard, IEEE, numbered or not), BibTeX, RIS, CSL-JSON, or a
 * bare list of DOIs.
 *
 * Parsing is best-effort by design and that is safe here: verification sends
 * the raw reference string to Crossref's own citation matcher and compares the
 * record's title against the raw text, so a field this parser misreads costs a
 * weaker mismatch report, never a wrong verdict on whether the paper exists.
 * What the parser must never do is invent a field — an absent value stays absent.
 */

import { parseBibTeX, parseRIS, type ParsedReference } from '@pho/citation-engine';
import { normalizeDoi } from './retractions';
import type { Author, ParsedRef } from './types';

export type ReferenceInput = string | readonly unknown[] | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"<>]+/i;
const DOI_FRAGMENT = /(?:https?:\/\/(?:dx\.)?doi\.org\/|\bdoi:\s*|\bDOI\s+)?\b10\.\d{4,9}\/[^\s"<>]+/gi;
const PMID = /\bPMID:?\s*(\d{4,9})\b/i;
const URL_FRAGMENT = /https?:\/\/[^\s"<>]+/gi;
const NOISE = [
  /\bPMCID:?\s*PMC\d+\b/gi,
  /\bPMID:?\s*\d+\b/gi,
  /\bAvailable (?:from|at):?/gi,
  /\[Internet\]/gi,
  /\bEpub \d{4}[^.;]*[.;]?/gi,
  /\bRetrieved from\b/gi,
  /\bAccessed\b[^.]*\./gi,
];

function findDoi(s: string): string | undefined {
  const m = DOI_IN_TEXT.exec(s);
  if (!m) return undefined;
  return normalizeDoi(m[0]) ?? undefined;
}

/** The reference text with DOIs, URLs and database ids removed. */
export function stripIdentifiers(s: string): string {
  let out = s.replace(DOI_FRAGMENT, ' ').replace(URL_FRAGMENT, ' ');
  for (const re of NOISE) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

// ---------------------------------------------------------------------------
// Splitting a pasted list
// ---------------------------------------------------------------------------

const LIST_MARKER = /^\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)]|[-•*–])\s+/;

/**
 * One entry per numbered marker when the list is numbered; otherwise one per
 * blank-line block; otherwise one per line. A line that follows a numbered
 * entry without its own marker is a wrapped continuation of that entry.
 */
export function splitReferenceList(input: string): string[] {
  const text = input.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const lines = text.split('\n');
  const marked = lines.filter((l) => LIST_MARKER.test(l)).length;

  if (marked >= 2) {
    const out: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      if (LIST_MARKER.test(line) || out.length === 0) out.push(line.replace(LIST_MARKER, '').trim());
      else out[out.length - 1] += ' ' + line.trim();
    }
    return out.filter(Boolean);
  }

  const blocks = text.split(/\n\s*\n/).map((b) => b.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  if (blocks.length >= 2) return blocks.map((b) => b.replace(LIST_MARKER, ''));

  return lines.map((l) => l.replace(LIST_MARKER, '').trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

// Every repetition below is delimited by a character the inner class cannot
// match (a space or hyphen before each name part, a period after each initial),
// so the patterns stay linear on hostile input. Text reaches them from public
// tools; an ambiguous nesting here is a ReDoS.
const NAME = "[\\p{Lu}][\\p{L}'’]*(?:[ \\-](?:[\\p{Lu}][\\p{L}'’]*|van|von|de|der|den|da|di|le|la|du))*";
const INITIALS_DOTTED = '(?:\\p{Lu}\\.\\s*(?:-\\s*)?)+';

/** `Drysdale, S. B., Cathie, K., & Munro, A. P. S.` (APA, Harvard). */
function apaAuthors(s: string): Author[] {
  const re = new RegExp(`(${NAME}),\\s*(${INITIALS_DOTTED})`, 'gu');
  const out: Author[] = [];
  for (const m of s.matchAll(re)) out.push({ family: m[1]!.trim(), given: m[2]!.replace(/\s+/g, '').trim() });
  return out;
}

/** `Drysdale SB, Cathie K, et al.` (Vancouver, AMA). */
function vancouverAuthors(s: string): Author[] {
  const out: Author[] = [];
  for (const part of s.split(/,\s*/)) {
    const p = part.replace(/\bet al\.?/i, '').replace(/\.$/, '').trim();
    if (!p) continue;
    const m = new RegExp(`^(${NAME})\\s+(\\p{Lu}{1,4})$`, 'u').exec(p);
    if (m) out.push({ family: m[1]!, given: m[2]! });
  }
  return out;
}

/** `S. B. Drysdale, K. Cathie, and F. Flamein` (IEEE). */
function ieeeAuthors(s: string): Author[] {
  const re = new RegExp(`(${INITIALS_DOTTED})(${NAME})`, 'gu');
  const out: Author[] = [];
  for (const m of s.matchAll(re)) out.push({ family: m[2]!.trim(), given: m[1]!.replace(/\s+/g, '') });
  return out;
}

/** `Drysdale, Simon B., Katrina Cathie, and …` (MLA, Chicago): first author is inverted. */
function invertedFirstAuthor(s: string): Author[] {
  const m = new RegExp(`^\\s*(${NAME}),\\s*([\\p{Lu}][\\p{L}.\\s\\-]*?)(?:,|\\.|$)`, 'u').exec(s);
  return m ? [{ family: m[1]!.trim(), given: m[2]!.trim() }] : [];
}

export function parseAuthors(s: string): Author[] {
  // "Ioannidis, John P. A." — a spelled-out given name after the first comma
  // is the MLA/Chicago shape; the initials readers would misread "P. A." as a name.
  const inverted = invertedFirstAuthor(s);
  // Vancouver "Drysdale SB, Cathie K" has the same comma shape, but its family
  // part ends in bare initials.
  if (
    inverted[0]?.given &&
    /\p{Ll}{2}/u.test(inverted[0].given) &&
    !/\s\p{Lu}{1,4}$/u.test(inverted[0].family)
  ) {
    return inverted;
  }
  const candidates = [apaAuthors(s), vancouverAuthors(s), ieeeAuthors(s), invertedFirstAuthor(s)];
  // The reader that explains the most of the string wins.
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] ?? [];
}

// ---------------------------------------------------------------------------
// One text reference
// ---------------------------------------------------------------------------

const YEAR = /\b(1[89]\d\d|20\d\d)[a-z]?\b/;

/** `389(26):2425-2435`, `389(26), 2425–2435`, `vol. 389, no. 26, pp. 2425–35`. */
function locator(s: string): { volume?: string; issue?: string; pages?: string } {
  const vancouver = /(\d{1,5})\s*(?:\(([^)]{1,15})\))?\s*:\s*([A-Za-z]?\d+[A-Za-z]?(?:\s*[-–—]\s*[A-Za-z]?\d+[A-Za-z]?)?)/.exec(s);
  if (vancouver) return { volume: vancouver[1], issue: vancouver[2], pages: vancouver[3]?.replace(/\s+/g, '') };
  const apa = /(\d{1,5})\s*(?:\(([^)]{1,15})\))?\s*,\s*(?:pp?\.\s*)?([A-Za-z]?\d+[A-Za-z]?(?:\s*[-–—]\s*[A-Za-z]?\d+[A-Za-z]?)?)/.exec(s);
  const mla = {
    volume: /\bvol\.?\s*(\d+)/i.exec(s)?.[1],
    issue: /\bno\.?\s*(\d+)/i.exec(s)?.[1],
    pages: /\bpp?\.\s*([A-Za-z]?\d+(?:\s*[-–—]\s*[A-Za-z]?\d+)?)/i.exec(s)?.[1]?.replace(/\s+/g, ''),
  };
  // `pp.` marks MLA/IEEE pages even without `vol.` (conference papers); the
  // APA pattern would otherwise read "pp. 770-778, 2016" as volume 778.
  if (mla.volume || mla.pages) {
    return Object.fromEntries(Object.entries(mla).filter(([, v]) => v)) as ReturnType<typeof locator>;
  }
  if (apa) return { volume: apa[1], issue: apa[2], pages: apa[3]?.replace(/\s+/g, '') };
  return {};
}

function clean(s: string | undefined): string | undefined {
  const out = s
    ?.replace(/^[\s"“”'‘’]+|[\s"“”'‘’,.;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out ? out : undefined;
}

/** Split at sentence ends: `. ` followed by an uppercase letter or digit. Initials (`J. `) are not ends. */
function sentences(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /([.?!])\s+(?=[\p{Lu}\d"“[(])/gu;
  for (const m of s.matchAll(re)) {
    const end = m.index!;
    const before = s.slice(Math.max(0, end - 4), end);
    // A single capital before the period is an initial when it sits in a run of
    // initials ("Smith, J. A.", "S. B. Drysdale", "Francis H. C. Crick"). The
    // Vancouver "Hinton G." ends the author list: the capital follows a word, and
    // the next token is not another initial.
    if (
      m[1] === '.' &&
      (/(?:^|[.,]\s?)\p{Lu}$/u.test(before) ||
        (/(?:^|\s)\p{Lu}$/u.test(before) && /^\s+\p{Lu}\./u.test(s.slice(end + 1))))
    ) {
      continue;
    }
    out.push(s.slice(start, end + (m[1] === '.' ? 0 : 1)).trim());
    start = end + m[0].length;
  }
  out.push(s.slice(start).trim());
  return out.filter(Boolean);
}

function looksLikeAuthors(seg: string): boolean {
  return (
    vancouverAuthors(seg).length > 0 ||
    apaAuthors(seg).length > 0 ||
    /\bet al\b/i.test(seg) ||
    ieeeAuthors(seg).length > 0
  );
}

export function parseTextReference(raw: string, index: number): ParsedRef {
  const doi = findDoi(raw);
  const pmid = PMID.exec(raw)?.[1];
  const url = /https?:\/\/(?!(?:dx\.)?doi\.org)[^\s"<>]+/i.exec(raw)?.[0]?.replace(/[.,;]$/, '');
  const body = stripIdentifiers(raw);

  const base: ParsedRef = {
    index,
    raw: raw.trim(),
    format: 'text',
    authors: [],
    ...(doi ? { doi } : {}),
    ...(pmid ? { pmid } : {}),
    ...(url ? { url } : {}),
  };

  if (!/[\p{L}]{3,}/u.test(body.replace(/\b(?:doi|pmid|https?)\b/gi, ''))) {
    return { ...base, format: doi ? 'doi' : 'text' };
  }

  // 1. Quoted title — MLA, Chicago, IEEE.
  const quoted = /["“]([^"”]{8,}?)[,.]?["”]/.exec(body);
  if (quoted) {
    const before = body.slice(0, quoted.index);
    const after = body.slice(quoted.index + quoted[0].length);
    const journal = clean(/^\s*[,.]?\s*((?:[^,0-9(]|\([^)]*\))+?)(?:,|\s+\d|$)/.exec(after)?.[1]);
    const year = Number(YEAR.exec(after)?.[1] ?? YEAR.exec(before)?.[1]) || undefined;
    return {
      ...base,
      title: clean(quoted[1]),
      authors: parseAuthors(before),
      ...(year ? { year } : {}),
      ...(journal ? { journal } : {}),
      ...locator(after),
    };
  }

  // 2. Author (Year). Title. Journal, vol(issue), pages. — APA, Harvard.
  const apa = /^(.*?)\(\s*(1[89]\d\d|20\d\d)[a-z]?(?:,[^)]*)?\s*\)\.?\s*(.+)$/u.exec(body);
  if (apa && apa[1]!.trim().length > 0) {
    const parts = sentences(apa[3]!);
    const title = clean(parts[0]);
    const rest = parts.slice(1).join('. ');
    const journal = clean(/^((?:[^,0-9(]|\([^)]*\))+?)(?:,|\s+\d|$)/.exec(rest)?.[1]);
    return {
      ...base,
      title,
      authors: parseAuthors(apa[1]!),
      year: Number(apa[2]),
      ...(journal ? { journal } : {}),
      ...locator(rest),
    };
  }

  // 3. Sentence-structured — Vancouver, AMA, Chicago author-date without quotes.
  const parts = sentences(body);
  const locIdx = parts.findIndex((p) => /\b(1[89]\d\d|20\d\d)\b[^;]*;\s*\d/.test(p) || /^\d{4}\s*[;,]/.test(p));
  let authorsSeg: string | undefined;
  let i = 0;
  if (parts.length > 1 && looksLikeAuthors(parts[0]!)) {
    authorsSeg = parts[0];
    i = 1;
  }
  // A Chicago-style bare year sentence right after the authors: "Smith, J. 2020."
  if (parts[i] && /^(1[89]\d\d|20\d\d)[a-z]?$/.test(parts[i]!.trim())) i++;
  const title = clean(parts[i]);
  const tail = parts.slice(i + 1).join('. ');
  let journal: string | undefined;
  if (locIdx > i + 1) journal = clean(parts.slice(i + 1, locIdx).join('. '));
  else if (locIdx === -1 && parts[i + 1]) journal = clean(/^([^,0-9]+)/.exec(parts[i + 1]!)?.[1]);
  else if (locIdx === i + 1) journal = clean(/^([^0-9;]+?)\s*(?:1[89]\d\d|20\d\d)/.exec(parts[i + 1]!)?.[1]);
  const year = Number(YEAR.exec(tail)?.[1] ?? YEAR.exec(body)?.[1]) || undefined;
  return {
    ...base,
    ...(title ? { title } : {}),
    authors: authorsSeg ? parseAuthors(authorsSeg) : [],
    ...(year ? { year } : {}),
    ...(journal ? { journal } : {}),
    ...locator(tail),
  };
}

// ---------------------------------------------------------------------------
// Structured formats
// ---------------------------------------------------------------------------

function fromParsedReference(r: ParsedReference, index: number, format: 'bibtex' | 'ris', raw: string): ParsedRef {
  const doi = r.doi ? (normalizeDoi(r.doi) ?? undefined) : undefined;
  return {
    index,
    raw,
    format,
    title: r.title,
    authors: r.authors.map((a) => ({ family: a.family, ...(a.given ? { given: a.given } : {}) })),
    ...(r.year ? { year: r.year } : {}),
    ...(r.journal ? { journal: r.journal } : {}),
    ...(r.volume ? { volume: r.volume } : {}),
    ...(r.issue ? { issue: r.issue } : {}),
    ...(r.pages ? { pages: r.pages.replace(/--/g, '-') } : {}),
    ...(doi ? { doi } : {}),
    ...(r.url ? { url: r.url } : {}),
    ...(r.type ? { type: r.type } : {}),
  };
}

interface CslItem {
  type?: string;
  title?: string;
  author?: { family?: string; given?: string; literal?: string }[];
  issued?: { 'date-parts'?: (number | string)[][] };
  'container-title'?: string | string[];
  volume?: string | number;
  issue?: string | number;
  page?: string;
  DOI?: string;
  PMID?: string | number;
  URL?: string;
}

function fromCsl(item: CslItem, index: number): ParsedRef {
  const year = Number(item.issued?.['date-parts']?.[0]?.[0]) || undefined;
  const journal = Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'];
  const doi = item.DOI ? (normalizeDoi(item.DOI) ?? undefined) : undefined;
  return {
    index,
    raw: JSON.stringify(item),
    format: 'csl-json',
    ...(item.title ? { title: item.title } : {}),
    authors: (item.author ?? [])
      .map((a) => ({ family: a.family ?? a.literal ?? '', ...(a.given ? { given: a.given } : {}) }))
      .filter((a) => a.family),
    ...(year ? { year } : {}),
    ...(journal ? { journal } : {}),
    ...(item.volume != null ? { volume: String(item.volume) } : {}),
    ...(item.issue != null ? { issue: String(item.issue) } : {}),
    ...(item.page ? { pages: item.page } : {}),
    ...(doi ? { doi } : {}),
    ...(item.PMID != null ? { pmid: String(item.PMID) } : {}),
    ...(item.URL ? { url: item.URL } : {}),
    ...(item.type ? { type: item.type } : {}),
  };
}

/** Raw text of each `@type{…}` entry, for display next to the parsed fields. */
function bibtexEntries(src: string): string[] {
  return src
    .split(/(?=@[a-zA-Z]+\s*[{(])/)
    .map((s) => s.trim())
    .filter((s) => /^@[a-zA-Z]+\s*[{(]/.test(s) && !/^@(comment|string|preamble)\b/i.test(s));
}

function risEntries(src: string): string[] {
  return src
    .split(/(?=^TY\s{1,2}-)/m)
    .map((s) => s.trim())
    .filter((s) => /^TY\s{1,2}-/.test(s));
}

/** Build a citation-like string from structured fields, for Crossref's matcher. */
export function citationString(ref: ParsedRef): string {
  if (ref.format === 'text') return stripIdentifiers(ref.raw);
  return [
    ref.authors
      .slice(0, 3)
      .map((a) => a.family)
      .join(', '),
    ref.year ? `(${ref.year})` : '',
    ref.title ?? '',
    ref.journal ?? '',
    ref.volume ?? '',
    ref.pages ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Limits on untrusted input: a reference list longer than this is not one. */
export const MAX_INPUT_CHARS = 200_000;
export const MAX_REFERENCES = 500;
export const MAX_REFERENCE_CHARS = 2_000;

export function parseReferences(input: ReferenceInput): ParsedRef[] {
  if (typeof input !== 'string') {
    const items = Array.isArray(input) ? input : [input];
    return items.slice(0, MAX_REFERENCES).map((it, i) => fromCsl(it as CslItem, i));
  }
  return parseReferenceText(input.slice(0, MAX_INPUT_CHARS)).slice(0, MAX_REFERENCES);
}

function parseReferenceText(input: string): ParsedRef[] {
  const text = input.trim();
  if (!text) return [];

  if (/^[[{]/.test(text)) {
    try {
      const json = JSON.parse(text) as unknown;
      const items = Array.isArray(json) ? json : [json];
      if (items.every((x) => x && typeof x === 'object')) return items.map((it, i) => fromCsl(it as CslItem, i));
    } catch {
      /* not JSON — fall through to text */
    }
  }

  if (/^\s*@[a-zA-Z]+\s*[{(]/m.test(text)) {
    const parsed = parseBibTeX(text).references;
    const raws = bibtexEntries(text);
    return parsed.map((r, i) =>
      fromParsedReference(r, i, 'bibtex', raws.length === parsed.length ? raws[i]! : r.title),
    );
  }

  if (/^TY\s{1,2}-/m.test(text)) {
    const parsed = parseRIS(text).references;
    const raws = risEntries(text);
    return parsed.map((r, i) => fromParsedReference(r, i, 'ris', raws.length === parsed.length ? raws[i]! : r.title));
  }

  return splitReferenceList(text)
    .slice(0, MAX_REFERENCES)
    .map((entry, i) => parseTextReference(entry.slice(0, MAX_REFERENCE_CHARS), i));
}
