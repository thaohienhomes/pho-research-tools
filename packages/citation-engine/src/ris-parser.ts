/**
 * RIS reader — the other half of the reference-manager on-ramp.
 *
 * RIS is what EndNote and PubMed hand you by default, and what most Vietnamese
 * university libraries document in their "how to export" guides, so it matters
 * at least as much as BibTeX for this audience.
 *
 * The format is line-oriented: `XX  - value`, one record per `TY`…`ER` block.
 * Two details decide whether a parser survives real files. First, a long
 * abstract is wrapped across untagged continuation lines, and a parser that
 * drops them truncates exactly the field this feature exists to carry. Second —
 * and this is the trap — those continuation lines are medical prose, so telling
 * a tag from a sentence cannot be done on shape alone. See `TAG_LINE`.
 */

import type { CitationAuthor } from './types';
import { type ParsedBibliography, type ParsedReference, parsePersonName } from './parsed-reference';

/**
 * `AB  - text` (the spec's two spaces) or `AB - text` (what several tools emit).
 *
 * At least ONE space is required, and the tag must be a real RIS tag. Both
 * conditions are load-bearing, and the reason is medical prose: a wrapped
 * abstract line beginning `ER-positive tumours…`, `T2-weighted images…` or
 * `IL-6 was elevated…` matched the old zero-space pattern. `ER-` then
 * TERMINATED the record, throwing away the DOI and URL that came after it;
 * `T2-` landed in the journal aliases and put "weighted images were obtained in
 * all cases" on the card as the journal name — a fabricated venue, which is a
 * provenance lie rather than a mere truncation. Tolerating a nonstandard export
 * is not worth corrupting the abstracts this feature exists to carry.
 */
const TAG_LINE = /^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/;

/** Tags that may legitimately repeat, each occurrence its own value. */
const AUTHOR_TAGS = new Set(['AU', 'A1']);

/**
 * Every tag this reader acts on, plus `ER`/`TY` which control record framing.
 * A two-letter token that is not in here is prose, not a tag — the second half
 * of the defence described on `TAG_LINE`.
 */
const KNOWN_TAGS = new Set([
  'TY', 'ER', 'AU', 'A1', 'A2', 'A3', 'A4', 'TI', 'T1', 'T2', 'T3', 'CT',
  'JO', 'JF', 'JA', 'J1', 'J2', 'PY', 'Y1', 'Y2', 'DA', 'VL', 'IS', 'SP', 'EP',
  'DO', 'DI', 'UR', 'L1', 'L2', 'L3', 'L4', 'AB', 'N1', 'N2', 'PB', 'CY', 'SN',
  'KW', 'LA', 'ID', 'M1', 'M3', 'ET', 'AN', 'C1', 'AD', 'RN', 'RP', 'ST', 'VO',
]);

/** First tag in each list wins, so the more specific tag is preferred. */
const TITLE_TAGS = ['TI', 'T1', 'CT'] as const;
const JOURNAL_TAGS = ['JO', 'JF', 'JA', 'T2'] as const;
const ABSTRACT_TAGS = ['AB', 'N2'] as const;
const YEAR_TAGS = ['PY', 'Y1', 'DA'] as const;
const DOI_TAGS = ['DO', 'DI'] as const;

type Fields = Map<string, string[]>;

function first(fields: Fields, tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    const value = fields.get(tag)?.[0]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** `2023`, `2023/04/12`, `2023 Feb` → 2023. `undefined` when there is no year. */
function parseYear(fields: Fields): number | undefined {
  const raw = first(fields, YEAR_TAGS);
  if (!raw) return undefined;
  const match = raw.match(/\b(1\d{3}|2\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

/** RIS splits pagination into start (`SP`) and end (`EP`). Rejoin for display. */
function parsePages(fields: Fields): string | undefined {
  const start = first(fields, ['SP']);
  const end = first(fields, ['EP']);
  if (start && end) return `${start}-${end}`;
  return start ?? end;
}

/**
 * Some exporters put a bare DOI in `DO`, others a full `https://doi.org/…` URL.
 * Strip the wrapper so the value matches what `normalizeDOI` expects, without
 * calling it here — this module stays a parser, not a validator.
 */
function cleanDoi(raw: string): string {
  return raw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
}

/** Turn one `TY`…`ER` block's tag map into a reference, or null if untitled. */
function toReference(fields: Fields): ParsedReference | null {
  const title = first(fields, TITLE_TAGS);
  // No title means no reference a user could act on. Dropping it is honest;
  // inventing "Untitled" would seed a bibliography with a row that cites nothing.
  if (!title) return null;

  const authors: CitationAuthor[] = [];
  for (const tag of AUTHOR_TAGS) {
    for (const value of fields.get(tag) ?? []) {
      const person = parsePersonName(value);
      if (person) authors.push(person);
    }
  }

  const ref: ParsedReference = { title, authors };

  const type = first(fields, ['TY']);
  if (type) ref.type = type.toLowerCase();
  const year = parseYear(fields);
  if (year !== undefined) ref.year = year;
  const journal = first(fields, JOURNAL_TAGS);
  if (journal) ref.journal = journal;
  const volume = first(fields, ['VL']);
  if (volume) ref.volume = volume;
  const issue = first(fields, ['IS']);
  if (issue) ref.issue = issue;
  const pages = parsePages(fields);
  if (pages) ref.pages = pages;
  const publisher = first(fields, ['PB']);
  if (publisher) ref.publisher = publisher;
  const doi = first(fields, DOI_TAGS);
  if (doi) ref.doi = cleanDoi(doi);
  const url = first(fields, ['UR', 'L1']);
  if (url) ref.url = url;
  const abstract = first(fields, ABSTRACT_TAGS);
  if (abstract) ref.abstract = abstract;

  return ref;
}

/**
 * Parse an RIS document into references.
 *
 * Never throws. A block missing its `ER` terminator is still emitted at
 * end-of-file, because truncated exports are common and the records before the
 * truncation are perfectly good.
 */
export function parseRIS(source: string): ParsedBibliography {
  const lines = source.normalize('NFC').split(/\r\n|\r|\n/);
  const out: ParsedReference[] = [];
  let skipped = 0;

  let fields: Fields = new Map();
  let started = false;
  let lastTag: string | null = null;

  const flush = () => {
    if (started) {
      const ref = toReference(fields);
      // An untitled record is dropped, but counted — the caller says how many.
      if (ref) out.push(ref);
      else skipped++;
    }
    fields = new Map();
    started = false;
    lastTag = null;
  };

  for (const line of lines) {
    const raw = line.match(TAG_LINE);
    // An unknown two-letter token is prose continuing the previous field.
    const match = raw && KNOWN_TAGS.has(raw[1]!) ? raw : null;

    if (!match) {
      // Continuation of the previous field — abstracts wrap constantly. Blank
      // lines between records are not continuations of anything.
      const text = line.trim();
      if (lastTag && text) {
        const values = fields.get(lastTag)!;
        values[values.length - 1] = `${values[values.length - 1]} ${text}`.trim();
      }
      continue;
    }

    const tag = match[1]!;
    const value = (match[2] ?? '').trim();

    if (tag === 'ER') {
      flush();
      continue;
    }

    if (tag === 'TY') {
      // A new `TY` without an intervening `ER` means the previous record was
      // never terminated. Emit it rather than merging two works into one.
      flush();
      started = true;
    }

    // A file whose first record omits `TY` is still worth reading.
    started = true;

    const existing = fields.get(tag);
    if (existing) existing.push(value);
    else fields.set(tag, [value]);
    lastTag = tag;
  }

  flush();
  return { references: out, skipped };
}
