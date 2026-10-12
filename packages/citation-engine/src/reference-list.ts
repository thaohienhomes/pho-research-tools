/**
 * Reference-list ordering — and the marker rewrite that MUST travel with it.
 *
 * WHY THIS EXISTS. A drafted manuscript carries inline markers (`[1]`, `[2, 5]`)
 * that index into the reference array. Any re-ordering of that array silently
 * repoints every claim in the text unless the markers are rewritten in the same
 * step. The manuscript export (V1) therefore refused to re-order at all. This
 * module makes re-ordering safe by making the two operations inseparable:
 * `buildReferenceList` returns the new order AND the rewritten body, and there
 * is no exported way to get one without the other.
 *
 * VIETNAMESE RULE. Vietnamese thesis regulations order the reference list
 * alphabetically with Vietnamese-language sources FIRST, sorted by the author's
 * GIVEN name (the last token of a Vietnamese full name — "Nguyễn Văn An" files
 * under "An"), and the name is NEVER inverted to "family, given". Zotero,
 * Mendeley, EndNote and CSL all get this wrong because CSL has no concept of
 * grouping by the language of the source, so students re-sort by hand on every
 * resubmission. Encoding it here is cheap and nobody else is going to.
 *
 * Pure and infra-free: no I/O, no model call, no dependency.
 */

/** How the reference list is ordered. */
export type ReferenceOrdering =
  /** Order of first citation — what Vancouver and AMA actually want. */
  | 'citation'
  /** Vietnamese thesis rule: Vietnamese sources first, then by given name. */
  | 'vietnamese-alphabetical';

/** Vietnamese-specific letters. Plain ASCII is excluded so English never matches. */
const VN_LETTERS =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂĂĐÊÔƠƯ]/;

/**
 * Is this reference a Vietnamese-language source?
 *
 * Detected from diacritics in the author names or title, which is the only
 * signal the paper records actually carry — none of the adapters return a
 * language field. Stated plainly because it is a heuristic: a Vietnamese paper
 * whose record happens to be stored without diacritics sorts with the foreign
 * group. That is a visible, correctable mistake in a list the author reads,
 * not a silent corruption of a claim.
 */
export function isVietnameseSource(authors: string, title: string): boolean {
  return VN_LETTERS.test(authors) || VN_LETTERS.test(title);
}

/** First author's segment of an "A, B, C" author string. */
function firstAuthor(authors: string): string {
  const first = authors.split(/[;,]/)[0] ?? '';
  return first.trim();
}

/**
 * Sort key for a Vietnamese author: the GIVEN name, i.e. the last token.
 * "Nguyễn Văn An" → "An". Falls back to the whole string for a single token.
 */
export function vietnameseSortKey(authors: string): string {
  const parts = firstAuthor(authors).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts[parts.length - 1] as string;
}

/**
 * Sort key for a non-Vietnamese author. Adapters return Vancouver-ish strings
 * ("Smith J, Doe A"), which already begin with the family name, so the first
 * author's segment sorts correctly as-is.
 */
export function latinSortKey(authors: string): string {
  return firstAuthor(authors);
}

/** What one reference needs to expose for ordering. Structural, not a class. */
export interface OrderableReference {
  authors: string;
  title: string;
}

/**
 * Expand and rewrite every citation marker in `body` using `oldToNew`, a map
 * from 0-based original position to 0-based new position.
 *
 * Handles `[3]`, `[3, 5]` and `[3-5]` (ranges are expanded, because a range
 * that was contiguous before re-ordering usually is not after). A marker that
 * points outside the reference list is left EXACTLY as written: an index we
 * cannot resolve is a bug to be seen, never one to be quietly deleted.
 */
export function remapCitationMarkers(body: string, oldToNew: readonly number[]): string {
  return body.replace(/\[(\d+(?:\s*[-,]\s*\d+)*)\]/g, (whole, inner: string) => {
    const nums: number[] = [];
    for (const part of inner.split(',')) {
      const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (from > to) return whole;
        for (let n = from; n <= to; n += 1) nums.push(n);
      } else {
        const n = Number(part.trim());
        if (!Number.isInteger(n)) return whole;
        nums.push(n);
      }
    }
    const mapped: number[] = [];
    for (const oneBased of nums) {
      const next = oldToNew[oneBased - 1];
      if (next === undefined) return whole; // unresolvable → leave verbatim
      mapped.push(next + 1);
    }
    return `[${mapped.join(', ')}]`;
  });
}

export interface ReferenceListResult<T> {
  /** References in their final printed order. */
  ordered: readonly T[];
  /** Section bodies with markers rewritten to match `ordered`. */
  bodies: readonly string[];
  /** 0-based original position → 0-based printed position. */
  oldToNew: readonly number[];
}

/**
 * Order the reference list AND rewrite the markers in the section bodies, in
 * one call. This coupling is the whole point of the module — see the header.
 */
export function buildReferenceList<T extends OrderableReference>(
  references: readonly T[],
  bodies: readonly string[],
  ordering: ReferenceOrdering,
): ReferenceListResult<T> {
  if (ordering === 'citation') {
    return {
      ordered: references,
      bodies,
      oldToNew: references.map((_, i) => i),
    };
  }

  const decorated = references.map((ref, index) => {
    const vietnamese = isVietnameseSource(ref.authors, ref.title);
    return {
      ref,
      index,
      vietnamese,
      key: vietnamese ? vietnameseSortKey(ref.authors) : latinSortKey(ref.authors),
    };
  });

  decorated.sort((a, b) => {
    // Vietnamese-language sources come first as one block.
    if (a.vietnamese !== b.vietnamese) return a.vietnamese ? -1 : 1;
    const cmp = a.key.localeCompare(b.key, a.vietnamese ? 'vi' : 'en', {
      sensitivity: 'base',
    });
    // A stable tie-break on the original position keeps the output identical
    // across runs, which matters for a file the author diffs between drafts.
    return cmp !== 0 ? cmp : a.index - b.index;
  });

  const oldToNew = new Array<number>(references.length);
  decorated.forEach((d, newIndex) => {
    oldToNew[d.index] = newIndex;
  });

  return {
    ordered: decorated.map((d) => d.ref),
    bodies: bodies.map((b) => remapCitationMarkers(b, oldToNew)),
    oldToNew,
  };
}
