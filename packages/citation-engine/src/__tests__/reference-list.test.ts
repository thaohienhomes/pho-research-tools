/**
 * The invariant these guard is the one that silently corrupts a submission:
 * after the reference list is re-ordered, marker `[i]` in the body must still
 * resolve to the SAME paper it did before. Checked by round-trip, not by eye.
 */
import { describe, it, expect } from 'vitest';

import {
  buildReferenceList,
  remapCitationMarkers,
  isVietnameseSource,
  vietnameseSortKey,
  latinSortKey,
  type OrderableReference,
} from '../reference-list';

const ref = (authors: string, title: string): OrderableReference => ({ authors, title });

/** Resolve every `[N]` in `body` to the reference it points at. */
const resolve = (body: string, list: readonly OrderableReference[]): string[] =>
  [...body.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) =>
    (m[1] as string).split(',').map((n) => list[Number(n.trim()) - 1]?.title ?? 'MISSING'),
  );

describe('isVietnameseSource', () => {
  it('detects diacritics in either the authors or the title', () => {
    expect(isVietnameseSource('Nguyễn Văn An', 'Any title')).toBe(true);
    expect(isVietnameseSource('Smith J', 'Đái tháo đường típ 2')).toBe(true);
  });

  it('does not flag plain English', () => {
    expect(isVietnameseSource('Smith J, Doe A', 'Metformin and CV outcomes')).toBe(false);
  });
});

describe('sort keys', () => {
  it('files a Vietnamese author under the GIVEN name, the last token', () => {
    expect(vietnameseSortKey('Nguyễn Văn An')).toBe('An');
    expect(vietnameseSortKey('Trần Thị Bích Hạnh, Lê Văn C')).toBe('Hạnh');
  });

  it('keeps the family-first key for a Vancouver-style latin author string', () => {
    expect(latinSortKey('Smith J, Doe A')).toBe('Smith J');
  });

  it('survives an empty author string', () => {
    expect(vietnameseSortKey('')).toBe('');
    expect(latinSortKey('')).toBe('');
  });
});

describe('remapCitationMarkers', () => {
  it('rewrites a single marker', () => {
    expect(remapCitationMarkers('Effect held [1].', [2, 0, 1])).toBe('Effect held [3].');
  });

  it('rewrites a comma list', () => {
    expect(remapCitationMarkers('Both agreed [1, 3].', [2, 0, 1])).toBe('Both agreed [3, 2].');
  });

  it('expands a range, because it is usually no longer contiguous afterwards', () => {
    expect(remapCitationMarkers('See [1-3].', [2, 0, 1])).toBe('See [3, 1, 2].');
  });

  it('leaves an out-of-range marker EXACTLY as written rather than deleting it', () => {
    expect(remapCitationMarkers('Stale [9].', [0, 1])).toBe('Stale [9].');
  });

  it('ignores bracketed text that is not a citation', () => {
    expect(remapCitationMarkers('an [aside] here [1]', [0])).toBe('an [aside] here [1]');
  });
});

describe('buildReferenceList — citation ordering', () => {
  it('is a no-op that still returns a usable identity map', () => {
    const refs = [ref('Smith J', 'A'), ref('Doe A', 'B')];
    const out = buildReferenceList(refs, ['x [1] y [2]'], 'citation');
    expect(out.ordered).toEqual(refs);
    expect(out.bodies).toEqual(['x [1] y [2]']);
    expect(out.oldToNew).toEqual([0, 1]);
  });
});

describe('buildReferenceList — Vietnamese thesis ordering', () => {
  const refs = [
    ref('Smith J, Doe A', 'Metformin and CV outcomes'),
    ref('Nguyễn Văn An', 'Đái tháo đường típ 2 tại Hà Nội'),
    ref('Brown K', 'Aspirin trial'),
    ref('Trần Thị Bích', 'Tăng huyết áp ở người cao tuổi'),
  ];

  it('puts Vietnamese sources first, sorted by given name', () => {
    const out = buildReferenceList(refs, [], 'vietnamese-alphabetical');
    expect(out.ordered.map((r) => r.authors)).toEqual([
      'Nguyễn Văn An', // An
      'Trần Thị Bích', // Bich
      'Brown K',
      'Smith J, Doe A',
    ]);
  });

  it('keeps Vietnamese names in natural order — never inverted to "family, given"', () => {
    const out = buildReferenceList(refs, [], 'vietnamese-alphabetical');
    expect(out.ordered[0]!.authors).toBe('Nguyễn Văn An');
    expect(out.ordered[0]!.authors).not.toContain(',');
  });

  it('ROUND TRIP: every marker still resolves to the same paper after re-ordering', () => {
    const body = 'One [1]. Two [2]. Three and four [3, 4].';
    const before = resolve(body, refs);
    const out = buildReferenceList(refs, [body], 'vietnamese-alphabetical');
    const after = resolve(out.bodies[0] as string, out.ordered);
    expect(after).toEqual(before);
  });

  it('rewrites markers across every section body, not just the first', () => {
    const out = buildReferenceList(refs, ['A [1].', 'B [2].'], 'vietnamese-alphabetical');
    expect(resolve(out.bodies[0] as string, out.ordered)).toEqual([refs[0]!.title]);
    expect(resolve(out.bodies[1] as string, out.ordered)).toEqual([refs[1]!.title]);
  });

  it('oldToNew is a permutation — no reference dropped or duplicated', () => {
    const out = buildReferenceList(refs, [], 'vietnamese-alphabetical');
    expect([...out.oldToNew].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(out.ordered).toHaveLength(refs.length);
  });

  it('is stable for two sources with the same sort key', () => {
    const dup = [ref('Nguyễn Văn An', 'First'), ref('Lê Văn An', 'Second')];
    const out = buildReferenceList(dup, [], 'vietnamese-alphabetical');
    expect(out.ordered.map((r) => r.title)).toEqual(['First', 'Second']);
  });

  it('handles an empty list', () => {
    const out = buildReferenceList([], ['no markers'], 'vietnamese-alphabetical');
    expect(out.ordered).toEqual([]);
    expect(out.bodies).toEqual(['no markers']);
  });
});
