import { describe, expect, it } from 'vitest';
import { prismaFlowDiagram, type PrismaCounts } from '../prisma';
import { svgToPng } from '../png';

/** A review whose numbers all add up, with both columns. */
const clean: PrismaCounts = {
  databaseSources: [
    { name: 'MEDLINE', n: 800 },
    { name: 'Embase', n: 1000 },
  ],
  registers: 50,
  duplicatesRemoved: 400,
  automationIneligible: 0,
  otherRemoved: 50,
  recordsScreened: 1400,
  recordsExcluded: 1300,
  reportsSought: 100,
  reportsNotRetrieved: 5,
  reportsAssessed: 95,
  reportsExcludedReasons: [
    { name: 'Wrong population', n: 50 },
    { name: 'Wrong outcome', n: 25 },
  ],
  studiesIncluded: 18,
  reportsIncluded: 25,
  otherMethods: {
    websites: 6,
    citationSearching: 10,
    reportsSought: 16,
    reportsNotRetrieved: 1,
    reportsAssessed: 15,
    reportsExcludedReasons: [{ name: 'Wrong design', n: 10 }],
  },
};

/** The diagram's words, with wrapped lines joined back together. */
function textOf(svg: string): string {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(' ');
}

describe('prismaFlowDiagram', () => {
  it('draws every PRISMA 2020 box with no warnings when the counts add up', () => {
    const r = prismaFlowDiagram(clean);
    expect(r.warnings).toEqual([]);
    for (const label of [
      'Identification of new studies via databases and registers',
      'Identification of new studies via other methods',
      'Records identified from*:',
      '– MEDLINE (n = 800)',
      'Databases (n = 1,800)',
      'Duplicate records removed (n = 400)',
      'Records screened (n = 1,400)',
      'Records excluded** (n = 1,300)',
      'Reports not retrieved (n = 5)',
      'Wrong population (n = 50)',
      'Citation searching (n = 10)',
      'Studies included in review (n = 18)',
      'Reports of included studies (n = 25)',
      'Included',
    ]) {
      expect(textOf(r.svg), label).toContain(label);
    }
    expect(r.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(r.svg).toContain('doi:10.1136/bmj.n71');
  });

  it('leaves out the other-methods column unless asked', () => {
    const { otherMethods: _, ...dbOnly } = clean;
    const r = prismaFlowDiagram({ ...dbOnly, reportsIncluded: 20 });
    expect(r.svg).not.toContain('via other methods');
    expect(r.warnings).toEqual([]);
    expect(r.width).toBeLessThan(prismaFlowDiagram(clean).width);
    expect(prismaFlowDiagram({ ...dbOnly, reportsIncluded: 20 }, { otherMethods: true }).svg).toContain('via other methods');
  });

  it('names the expected value when a box does not add up', () => {
    const r = prismaFlowDiagram({ ...clean, recordsScreened: 1450 });
    const w = r.warnings.find((x) => x.field === 'recordsScreened');
    expect(w).toMatchObject({ code: 'mismatch', expected: 1400, given: 1450 });
    expect(w!.message).toBe(
      'Records screened is 1,450 but should be 1,400 (records identified 1,850 minus records removed before screening 450).',
    );
    // The diagram shows what the author gave, never a silently corrected number.
    expect(r.svg).toContain('Records screened (n = 1,450)');
  });

  it('checks included reports across both columns, and studies against reports', () => {
    const r = prismaFlowDiagram({ ...clean, reportsIncluded: 30, studiesIncluded: 31 });
    expect(r.warnings.map((w) => [w.field, w.code])).toEqual([
      ['reportsIncluded', 'mismatch'],
      ['studiesIncluded', 'inconsistent'],
    ]);
    expect(r.warnings[0]!.expected).toBe(25);
  });

  it('fills in boxes that follow from the ones above and marks them derived', () => {
    const r = prismaFlowDiagram({
      databases: 1000,
      duplicatesRemoved: 200,
      recordsExcluded: 700,
      reportsNotRetrieved: 10,
      reportsExcluded: 60,
      studiesIncluded: 25,
    });
    expect(r.warnings).toEqual([]);
    expect(r.counts.recordsScreened).toEqual({ value: 800, derived: true });
    expect(r.counts.reportsSought).toEqual({ value: 100, derived: true });
    expect(r.counts.reportsAssessed).toEqual({ value: 90, derived: true });
    expect(r.counts.reportsIncluded).toEqual({ value: 30, derived: true });
    expect(r.svg).toContain('Registers (n = –)');
  });

  it('flags excluded reasons that disagree with the stated total, and impossible counts', () => {
    const r = prismaFlowDiagram({ ...clean, reportsExcluded: 80 });
    expect(r.warnings[0]).toMatchObject({ field: 'reportsExcluded', code: 'inconsistent', expected: 75, given: 80 });

    const neg = prismaFlowDiagram({ databases: 10, duplicatesRemoved: 20, studiesIncluded: 0 });
    expect(neg.warnings[0]).toMatchObject({ field: 'recordsScreened', code: 'negative', expected: -10 });

    const bad = prismaFlowDiagram({ databases: -5, registers: 2.5, studiesIncluded: 1 });
    expect(bad.warnings.filter((w) => w.code === 'invalid_value').map((w) => w.field)).toEqual(['databases', 'registers']);
  });

  it('reports missing essentials and other-methods sought above identified', () => {
    const r = prismaFlowDiagram({ otherMethods: { websites: 2, reportsSought: 5 } });
    expect(r.warnings.map((w) => w.field)).toEqual(
      expect.arrayContaining(['otherMethods.reportsSought', 'studiesIncluded', 'databases']),
    );
  });

  it('escapes user text and keeps hostile labels from swamping the diagram', () => {
    const r = prismaFlowDiagram({
      ...clean,
      reportsExcludedReasons: [
        { name: '<script>alert(1)</script> & "x"', n: 50 },
        { name: 'x'.repeat(5000), n: 25 },
      ],
    });
    expect(r.svg).not.toContain('<script>');
    expect(r.svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(r.svg.length).toBeLessThan(40_000);
  });

  it('rasterises to a PNG with the embedded font', () => {
    const r = prismaFlowDiagram(clean);
    const png = svgToPng(r.svg, { scale: 1 });
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR width/height at bytes 16–23.
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(r.width);
    expect(view.getUint32(20)).toBe(r.height);
  });
});

describe('prismaFlowDiagram layout', () => {
  it('never draws a text line wider than its box', () => {
    const r = prismaFlowDiagram({ ...clean, reportsExcludedReasons: [{ name: 'y'.repeat(300), n: 75 }] });
    // Footnotes (font-size 11) span the page; every other line sits in a box.
    const boxText = [...r.svg.matchAll(/<text(?![^>]*font-size="11")[^>]*>([^<]*)<\/text>/g)];
    const longest = Math.max(...boxText.map((m) => m[1]!.length));
    expect(longest).toBeLessThan(60);
  });
});
