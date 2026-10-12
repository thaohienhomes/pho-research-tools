/**
 * String comparison for bibliographic fields.
 *
 * Every function here is pure and has one job: decide whether two spellings of
 * the same field mean the same thing. They are tuned toward tolerance on
 * formatting (case, punctuation, diacritics, abbreviations, page ranges) and
 * intolerance on content (a different word in a title is a different title).
 */

const INVISIBLES = /[​-‍﻿­]/g;

/** Lowercase, strip diacritics/markup/punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .replace(INVISIBLES, '')
    .replace(/<[^>]+>/g, ' ') // Crossref titles carry JATS tags: <i>, <sup>…
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'o')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

/**
 * Prefixes that mark a record as being ABOUT a paper rather than the paper.
 * Stripped before comparison so `RETRACTED: X` still matches a citation of X;
 * the retraction itself is reported through the notices, not lost.
 */
const STATUS_PREFIX = /^\s*(retracted|withdrawn|retraction|expression of concern|retracted article)\s*[:.\-–—]\s*/i;

export function stripStatusPrefix(title: string): string {
  return title.replace(STATUS_PREFIX, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** 1 − edit distance / longer length, on normalized strings. */
export function charRatio(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x && !y) return 1;
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 0 : 1 - levenshtein(x, y) / longest;
}

/** Multiset Dice coefficient on tokens. */
export function tokenDice(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of tb) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(t, c - 1);
    }
  }
  return (2 * shared) / (ta.length + tb.length);
}

/**
 * Title similarity, 0–1.
 *
 * The average of a character ratio and a token Dice score. Either alone fails
 * in a known way: the character ratio forgives a swapped word in a long title
 * (which is how plausible fabrications are built — real title, one noun
 * changed), and token Dice forgives reordering. Averaged, a one-word change in
 * a 12-word title lands around 0.9 while a "same topic, different paper" title
 * lands well under 0.7.
 *
 * Also compared against the main title alone (before the first colon), because
 * citations routinely drop subtitles.
 */
export function titleSimilarity(cited: string, record: string): number {
  const c = stripStatusPrefix(cited);
  const r = stripStatusPrefix(record);
  const score = (x: string, y: string) => (charRatio(x, y) + tokenDice(x, y)) / 2;
  let best = score(c, r);
  const recordMain = r.split(/:\s/)[0] ?? r;
  if (recordMain !== r && tokens(recordMain).length >= 3) best = Math.max(best, score(c, recordMain));
  const citedMain = c.split(/:\s/)[0] ?? c;
  if (citedMain !== c && tokens(citedMain).length >= 3) best = Math.max(best, score(citedMain, r));
  return best;
}

/**
 * How much of `title` appears, in order, inside `text`.
 *
 * Used when the parser could not isolate the cited title (an unusual citation
 * style): if a record's whole title sits inside the raw reference string, the
 * reference cites that record whatever its punctuation. Longest common
 * subsequence of tokens / title length.
 */
export function orderedCoverage(title: string, text: string): number {
  const t = tokens(stripStatusPrefix(title));
  const x = tokens(text);
  if (!t.length || !x.length) return 0;
  const dp = new Array<number>(x.length + 1).fill(0);
  for (let i = 1; i <= t.length; i++) {
    let diag = 0;
    for (let j = 1; j <= x.length; j++) {
      const up = dp[j]!;
      dp[j] = t[i - 1] === x[j - 1] ? diag + 1 : Math.max(dp[j]!, dp[j - 1]!);
      diag = up;
    }
  }
  return dp[x.length]! / t.length;
}

/** Fold a surname for comparison: `Žídek` → `zidek`, `O'Brien` → `obrien`. */
export function foldName(s: string): string {
  return normalize(s).replace(/\s+/g, '');
}

const JOURNAL_STOP = new Set(['the', 'of', 'and', 'for', 'in', 'on', 'de', 'la', 'le', 'des', 'der', 'und']);

function journalTokens(s: string): string[] {
  // "Lancet (London, England)" → "Lancet": PubMed appends the place of publication.
  const cleaned = s.replace(/\([^)]*(?:\)|$)/g, ' ');
  return tokens(cleaned).filter((t) => !JOURNAL_STOP.has(t));
}

/**
 * Do two journal names denote the same journal?
 *
 * Handles ISO/NLM abbreviations against full titles by prefix-matching tokens
 * in order: `N Engl J Med` ↔ `New England Journal of Medicine`,
 * `Brief Bioinform` ↔ `Briefings in Bioinformatics`.
 */
export function journalMatches(a: string, b: string): boolean {
  const x = journalTokens(a);
  const y = journalTokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  // An ISO abbreviation keeps every content word, so token counts must agree.
  // No slack here: "Nature" vs "Nature Medicine" differ by exactly one token
  // and are different journals.
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const s = x[i]!;
    const l = y[i]!;
    if (!(l.startsWith(s) || s.startsWith(l))) return false;
  }
  return true;
}

/** `436-44` → { start: '436', end: '444' }; `e124` → { start: 'e124' }. */
export function parsePages(raw: string): { start: string; end?: string } | null {
  const s = raw.replace(/\s+/g, '').replace(/[–—−]/g, '-').replace(/^pp?\.?/i, '');
  if (!s) return null;
  const m = /^([A-Za-z]*\d+[A-Za-z]*)(?:-([A-Za-z]*\d+[A-Za-z]*))?/.exec(s);
  if (!m) return null;
  const start = m[1]!.toLowerCase();
  let end = m[2]?.toLowerCase();
  if (end && /^\d+$/.test(start) && /^\d+$/.test(end) && end.length < start.length) {
    // Abbreviated range: 1669-74 → 1674.
    end = start.slice(0, start.length - end.length) + end;
  }
  return { start, ...(end ? { end } : {}) };
}

/** Page ranges agree when their start pages agree (ends are often omitted). */
export function pagesMatch(a: string, b: string): boolean {
  const x = parsePages(a);
  const y = parsePages(b);
  if (!x || !y) return true; // cannot compare → do not accuse
  if (x.start !== y.start) return false;
  if (x.end && y.end && x.end !== y.end) return false;
  return true;
}
