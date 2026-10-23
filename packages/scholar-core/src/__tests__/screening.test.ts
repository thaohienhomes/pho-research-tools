import { describe, expect, it } from 'vitest';
import { prismaFlowDiagram } from '../prisma';
import { screeningLog, type ScreeningRecord } from '../screening';

const rec = (
  id: string,
  screening: 'include' | 'exclude',
  fullText?: 'include' | 'exclude' | 'not_retrieved',
  reason?: string,
): ScreeningRecord => ({
  id,
  screening,
  ...(fullText ? { fullText } : {}),
  ...(reason ? { reason } : {}),
});

describe('screeningLog', () => {
  const records: ScreeningRecord[] = [
    rec('pmid:1', 'exclude', undefined, 'Animal study'),
    rec('pmid:2', 'exclude'),
    rec('pmid:3', 'include', 'include'),
    rec('pmid:4', 'include', 'exclude', 'Wrong population'),
    rec('pmid:5', 'include', 'exclude', 'wrong population'),
    rec('pmid:6', 'include', 'exclude', 'No control group'),
    rec('pmid:7', 'include', 'not_retrieved'),
    rec('pmid:8', 'include', 'include'),
  ];

  it('counts every PRISMA box from the decisions, and the diagram adds up', () => {
    const r = screeningLog(records, { databases: 10, duplicatesRemoved: 2 });
    expect(r.counts).toEqual({
      databases: 10,
      duplicatesRemoved: 2,
      recordsScreened: 8,
      recordsExcluded: 2,
      reportsSought: 6,
      reportsNotRetrieved: 1,
      reportsAssessed: 5,
      reportsExcludedReasons: [
        { name: 'Wrong population', n: 2 },
        { name: 'No control group', n: 1 },
      ],
      studiesIncluded: 2,
    });
    expect(r.issues).toEqual([]);
    expect(prismaFlowDiagram(r.counts).warnings).toEqual([]);
    expect(r.screeningReasons).toEqual([{ name: 'Animal study', n: 1 }]);
  });

  it('flags missing reasons, pending full texts and duplicates instead of hiding them', () => {
    const r = screeningLog([rec('a', 'include', 'exclude'), rec('b', 'include'), rec('A', 'exclude', 'include')]);
    expect(r.issues.map((i) => i.code).sort()).toEqual([
      'duplicate_id',
      'full_text_without_inclusion',
      'missing_reason',
      'pending_full_text',
    ]);
    expect(r.reasons).toEqual([{ name: 'Reason not recorded', n: 1 }]);
    expect(r.pendingFullText).toBe(1);
    expect(r.counts.reportsAssessed).toBe(1);
  });

  it('writes an RFC 4180 CSV, one row per record', () => {
    const r = screeningLog([
      { id: '10.1/x', title: 'Coffee, "decaf" and you', screening: 'include', fullText: 'include' },
    ]);
    expect(r.csv).toBe(
      'id,title,screening,full_text,reason\r\n10.1/x,"Coffee, ""decaf"" and you",include,include,\r\n',
    );
  });

  it('neutralises spreadsheet formulas in the CSV', () => {
    const r = screeningLog([{ id: '=HYPERLINK("http://x","y")', screening: 'exclude', reason: '+1 wrong design' }]);
    expect(r.csv.split('\r\n')[1]).toBe(`"'=HYPERLINK(""http://x"",""y"")",,exclude,,'+1 wrong design`);
  });

  it('keeps the diagram within the PRISMA tool limits', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      screening: 'include' as const,
      fullText: 'exclude' as const,
      reason: `Reason ${String(i).padStart(2, '0')} ${'x'.repeat(300)}`,
    }));
    const r = screeningLog(rows, { databases: 40 });
    expect(r.reasons).toHaveLength(40);
    expect(r.reasons.every((g) => g.name.length <= 160)).toBe(true);
    const drawn = r.counts.reportsExcludedReasons!;
    expect(drawn).toHaveLength(30);
    expect(drawn[29]).toEqual({ name: 'Other reasons (11)', n: 11 });
    expect(drawn.reduce((a, g) => a + g.n, 0)).toBe(40);
    expect(prismaFlowDiagram(r.counts).warnings).toEqual([]);
  });
});
