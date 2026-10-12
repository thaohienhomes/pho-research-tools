/**
 * BibTeX reader — the inverse of `formatBibTeX` in `./formatter`.
 *
 * The repo already exported BibTeX and never read it back, which meant a user
 * could get a `.bib` out of Phở and had no way to bring one in. Every reference
 * manager in the target audience's hands (EndNote, Zotero, Mendeley) exports
 * this format, so it is the cheapest possible on-ramp for someone who already
 * assembled a reading list somewhere else.
 *
 * Scope note: this is a *pragmatic* reader, not a BibTeX implementation. It does
 * not evaluate `@string` macros or `#` concatenation, because exporters do not
 * emit them. It does track brace depth properly, because exporters absolutely do
 * emit `title = {The {DNA} of {H}anoi}` and a naive split on `,` shreds it.
 */

import type { CitationAuthor } from './types';
import { type ParsedBibliography, type ParsedReference, parsePersonName } from './parsed-reference';

/** Entry types that carry no reference data and must be skipped wholesale. */
const NON_ENTRY = new Set(['comment', 'string', 'preamble']);

/**
 * Escaped braces are parked on sentinels before the decorative braces are
 * stripped, then restored. Without the detour, `\{` would lose its brace to the
 * very pass that removes the ones around `{DNA}`.
 */
const LBRACE = '\u0001';
const RBRACE = '\u0002';

/**
 * LaTeX escapes that survive a modern exporter. Deliberately short: files are
 * UTF-8 these days, so accents arrive as real characters and only the reserved
 * characters still need escaping. A giant accent table would be dead code that
 * looks like diligence.
 */
const ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\\&/g, '&'],
  [/\\%/g, '%'],
  [/\\\$/g, '$'],
  [/\\#/g, '#'],
  [/\\_/g, '_'],
  [/\\\{/g, LBRACE],
  [/\\\}/g, RBRACE],
];

/**
 * Undo BibTeX escaping and drop the capitalisation-protection braces that
 * exporters sprinkle over acronyms (`{DNA}` → `DNA`). Runs after field
 * extraction, so the braces it removes are decorative rather than structural.
 */
function unescape(value: string): string {
  let out = value;
  for (const [pattern, replacement] of ESCAPES) out = out.replace(pattern, replacement);
  out = out.replace(/[{}]/g, '');
  return out.split(LBRACE).join('{').split(RBRACE).join('}').replace(/\s+/g, ' ').trim();
}

/** Read a `{…}`-delimited run starting at `open`, returning the index past `}`. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1; // unbalanced — caller treats the entry as truncated
}

/** `Nguyen, Hien T. and Tran, Minh` → two authors. `and` splits at depth 0. */
function parseAuthors(raw: string): CitationAuthor[] {
  const out: CitationAuthor[] = [];
  let depth = 0;
  let start = 0;

  const push = (end: number) => {
    const chunk = raw.slice(start, end).trim();
    // "others" is BibTeX for "et al." — a marker, not a person.
    if (chunk.toLowerCase() === 'others') return;

    // A name wrapped in its own brace group is BibTeX for "this is one literal
    // name": `{World Health Organization}`, `{Rand and Sons Institute}`. Running
    // the given/family split on it would invent a surname out of its last word.
    if (chunk.startsWith('{') && matchBrace(chunk, 0) === chunk.length) {
      const literal = unescape(chunk);
      if (literal) out.push({ given: '', family: literal });
      return;
    }

    const person = parsePersonName(unescape(chunk));
    if (person) out.push(person);
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (
      depth === 0 &&
      (ch === 'a' || ch === 'A') &&
      /\s/.test(raw[i - 1] ?? ' ') &&
      raw.slice(i, i + 3).toLowerCase() === 'and' &&
      /\s/.test(raw[i + 3] ?? ' ')
    ) {
      push(i);
      i += 3;
      start = i + 1;
    }
  }
  push(raw.length);
  return out;
}

/** Split one entry body into its `name = value` pairs, respecting brace depth. */
function parseFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  let i = 0;

  // The citation key runs to the first top-level comma; we do not keep it — the
  // key is the exporter's private handle, not information about the work.
  while (i < body.length && body[i] !== ',') i++;
  i++;

  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i]!)) i++;
    const nameStart = i;
    while (i < body.length && /[A-Za-z0-9_-]/.test(body[i]!)) i++;
    const name = body.slice(nameStart, i).toLowerCase();
    if (!name) break;

    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (body[i] !== '=') break;
    i++;
    while (i < body.length && /\s/.test(body[i]!)) i++;

    let raw: string;
    if (body[i] === '{') {
      const end = matchBrace(body, i);
      if (end < 0) break;
      raw = body.slice(i + 1, end - 1);
      i = end;
    } else if (body[i] === '"') {
      let j = i + 1;
      while (j < body.length && !(body[j] === '"' && body[j - 1] !== '\\')) j++;
      raw = body.slice(i + 1, j);
      i = j + 1;
    } else {
      const start = i;
      while (i < body.length && body[i] !== ',') i++;
      raw = body.slice(start, i);
    }

    // First writer wins: a duplicated field in one entry is an exporter bug, and
    // the first occurrence is the one a human reading the file would believe.
    if (!fields.has(name)) fields.set(name, raw);
  }

  return fields;
}

/** `2024` from `2024`, `{2024}`, `2024-03`, `March 2024`. `undefined` if none. */
function parseYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = unescape(raw).match(/\b(1\d{3}|2\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Parse a BibTeX document.
 *
 * Never throws, and a malformed entry costs exactly one entry: on an unbalanced
 * brace the scanner RESYNCS to the next `@` rather than giving up on the
 * document.
 *
 * That distinction is the whole point. `matchBrace` counts braces across the
 * remaining file, so one stray `{` in an abstract — `{Cochrane risk-of-bias
 * tool.` — makes it run to EOF and report failure. Abandoning the document
 * there meant a 200-entry export with one typo imported as ZERO references, and
 * the UI then said "no references found", which reads as "your file was empty".
 * Silent total loss, from one bad character.
 */
export function parseBibTeX(source: string): ParsedBibliography {
  // Reference managers round-trip through systems that hand back decomposed
  // diacritics; every downstream comparison assumes composed form.
  const src = source.normalize('NFC');
  const out: ParsedReference[] = [];
  let skipped = 0;
  let i = 0;

  while (i < src.length) {
    const at = src.indexOf('@', i);
    if (at < 0) break;

    let j = at + 1;
    while (j < src.length && /\s/.test(src[j]!)) j++;
    const typeStart = j;
    while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
    const type = src.slice(typeStart, j).toLowerCase();
    while (j < src.length && /\s/.test(src[j]!)) j++;

    if (!type || src[j] !== '{') {
      i = at + 1;
      continue;
    }

    const end = matchBrace(src, j);
    if (end < 0) {
      // Unbalanced: this entry is unreadable, but the ones after it are not.
      // Resync past the `@` so the next entry is still found.
      skipped++;
      i = at + 1;
      continue;
    }

    if (!NON_ENTRY.has(type)) {
      const fields = parseFields(src.slice(j + 1, end - 1));
      const title = unescape(fields.get('title') ?? '');
      // An entry with no title is not a reference anyone can act on. Dropping it
      // is honest; padding it with "Untitled" would put a fake row in a
      // bibliography the user is about to cite from.
      if (!title) {
        // No title means no reference anyone can act on. Counted, not silent.
        skipped++;
      } else {
        const ref: ParsedReference = {
          title,
          authors: parseAuthors(fields.get('author') ?? ''),
          type,
        };
        const year = parseYear(fields.get('year') ?? fields.get('date'));
        if (year !== undefined) ref.year = year;
        // `journal` for @article, `booktitle` for @inproceedings — same slot to
        // the reader, so the venue is never lost to the entry type.
        const journal = unescape(fields.get('journal') ?? fields.get('booktitle') ?? '');
        if (journal) ref.journal = journal;
        const volume = unescape(fields.get('volume') ?? '');
        if (volume) ref.volume = volume;
        // BibTeX calls the issue `number`; `issue` also appears in the wild.
        const issue = unescape(fields.get('number') ?? fields.get('issue') ?? '');
        if (issue) ref.issue = issue;
        const pages = fields.get('pages');
        if (pages) ref.pages = unescape(pages).replace(/--/g, '-');
        const publisher = unescape(fields.get('publisher') ?? '');
        if (publisher) ref.publisher = publisher;
        // Exporters put either a bare DOI or a full `https://doi.org/…` in this
        // field. Strip the wrapper here so both readers hand back the same shape
        // and downstream matching does not have to guess which one it got.
        const doi = unescape(fields.get('doi') ?? '')
          .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
          .replace(/^doi:\s*/i, '')
          .trim();
        if (doi) ref.doi = doi;
        const url = unescape(fields.get('url') ?? '');
        if (url) ref.url = url;
        const abstract = unescape(fields.get('abstract') ?? '');
        if (abstract) ref.abstract = abstract;
        out.push(ref);
      }
    }

    i = end;
  }

  return { references: out, skipped };
}
