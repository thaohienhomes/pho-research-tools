/**
 * prismaFlowDiagram — PRISMA 2020 flow diagram for new systematic reviews.
 *
 * Follows the official template "PRISMA 2020 flow diagram for new systematic
 * reviews which included searches of databases, registers and other sources"
 * (Page MJ et al. BMJ 2021;372:n71, CC BY 4.0), with the "other methods"
 * column optional.
 *
 * The diagram is only as good as its arithmetic, and the arithmetic is where
 * hand-drawn diagrams go wrong (peer reviewers check it). So every box that
 * can be computed from the boxes above it is checked: a count that disagrees
 * produces a warning naming the expected value, and a count left out is
 * filled in and marked as derived. Counts are never silently changed.
 *
 * Output is a self-contained SVG string (no external fonts or images needed;
 * `svgToPng` in `./png` rasterises it with an embedded font).
 */

export interface NamedCount {
  name: string;
  n: number;
}

export interface PrismaOtherMethodsCounts {
  websites?: number;
  organisations?: number;
  citationSearching?: number;
  /** Further sources, each its own line (e.g. `{ name: 'Experts contacted', n: 4 }`). */
  sources?: NamedCount[];
  reportsSought?: number;
  reportsNotRetrieved?: number;
  reportsAssessed?: number;
  /** Itemised exclusion reasons. */
  reportsExcludedReasons?: NamedCount[];
  /** Total excluded, when reasons are not itemised. */
  reportsExcluded?: number;
}

export interface PrismaCounts {
  /** Total records from databases. Can be omitted when `databaseSources` lists them. */
  databases?: number;
  /** Per-database counts (the template recommends reporting them). */
  databaseSources?: NamedCount[];
  registers?: number;
  registerSources?: NamedCount[];
  duplicatesRemoved?: number;
  automationIneligible?: number;
  otherRemoved?: number;
  recordsScreened?: number;
  recordsExcluded?: number;
  reportsSought?: number;
  reportsNotRetrieved?: number;
  reportsAssessed?: number;
  reportsExcludedReasons?: NamedCount[];
  reportsExcluded?: number;
  studiesIncluded?: number;
  reportsIncluded?: number;
  /** Counts for the "identification of studies via other methods" column. */
  otherMethods?: PrismaOtherMethodsCounts;
}

export interface PrismaOptions {
  /** Draw the "other methods" column. Default: true when `counts.otherMethods` is given. */
  otherMethods?: boolean;
  /** Print the template footnotes and source attribution under the diagram. Default true. */
  footnotes?: boolean;
  /** Accent used for the section headers. Default jade. */
  accent?: string;
}

export type PrismaWarningCode = 'mismatch' | 'negative' | 'invalid_value' | 'missing' | 'inconsistent';

export interface PrismaWarning {
  code: PrismaWarningCode;
  /** Count the warning is about (dot path, e.g. `recordsScreened`, `otherMethods.reportsAssessed`). */
  field: string;
  message: string;
  expected?: number;
  given?: number;
}

export interface ResolvedCount {
  value?: number;
  /** True when the value was computed from other boxes rather than given. */
  derived: boolean;
}

export interface PrismaResult {
  svg: string;
  width: number;
  height: number;
  /** Empty when every count adds up. */
  warnings: PrismaWarning[];
  /** Every count the diagram shows, as drawn. */
  counts: Record<string, ResolvedCount>;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

const LABELS: Record<string, string> = {
  databases: 'Records from databases',
  registers: 'Records from registers',
  recordsIdentified: 'Records identified',
  recordsRemoved: 'Records removed before screening',
  recordsScreened: 'Records screened',
  recordsExcluded: 'Records excluded',
  reportsSought: 'Reports sought for retrieval',
  reportsNotRetrieved: 'Reports not retrieved',
  reportsAssessed: 'Reports assessed for eligibility',
  reportsExcluded: 'Reports excluded',
  reportsIncluded: 'Reports of included studies',
  studiesIncluded: 'Studies included in review',
  'otherMethods.recordsIdentified': 'Records identified via other methods',
  'otherMethods.reportsSought': 'Reports sought for retrieval (other methods)',
  'otherMethods.reportsNotRetrieved': 'Reports not retrieved (other methods)',
  'otherMethods.reportsAssessed': 'Reports assessed for eligibility (other methods)',
  'otherMethods.reportsExcluded': 'Reports excluded (other methods)',
};

const fmt = (n: number) => n.toLocaleString('en-US');

class Ledger {
  readonly counts: Record<string, ResolvedCount> = {};
  readonly warnings: PrismaWarning[] = [];

  /** Accept a caller-supplied number, rejecting anything that is not a count. */
  input(field: string, raw: number | undefined): number | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      this.warnings.push({
        code: 'invalid_value',
        field,
        message: `${LABELS[field] ?? field}: "${String(raw)}" is not a whole number of 0 or more, so it was ignored.`,
      });
      return undefined;
    }
    return raw;
  }

  /** Sum of named counts; invalid items are reported and skipped. */
  sum(field: string, items: NamedCount[] | undefined): number | undefined {
    if (!items?.length) return undefined;
    let total = 0;
    items.forEach((it, i) => {
      const v = this.input(`${field}[${i}]`, it.n);
      if (v !== undefined) total += v;
    });
    return total;
  }

  /**
   * Resolve a box that the template defines as `expected`. Given and
   * computable: compare. Only one: use it. Neither: unknown.
   */
  resolve(field: string, given: number | undefined, expected: number | undefined, why: string): number | undefined {
    if (expected !== undefined && expected < 0) {
      this.warnings.push({
        code: 'negative',
        field,
        message: `${LABELS[field] ?? field} would be ${fmt(expected)} (${why}). Check the counts above it.`,
        expected,
      });
      expected = undefined;
    }
    if (given !== undefined) {
      if (expected !== undefined && given !== expected) {
        this.warnings.push({
          code: 'mismatch',
          field,
          message: `${LABELS[field] ?? field} is ${fmt(given)} but should be ${fmt(expected)} (${why}).`,
          expected,
          given,
        });
      }
      this.counts[field] = { value: given, derived: false };
      return given;
    }
    if (expected !== undefined) {
      this.counts[field] = { value: expected, derived: true };
      return expected;
    }
    this.counts[field] = { derived: false };
    return undefined;
  }

  set(field: string, value: number | undefined, derived = false): number | undefined {
    this.counts[field] = value === undefined ? { derived: false } : { value, derived };
    return value;
  }
}

const add = (...xs: (number | undefined)[]) =>
  xs.every((x) => x === undefined) ? undefined : xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const sub = (a: number | undefined, b: number | undefined) =>
  a === undefined || b === undefined ? undefined : a - b;

interface Resolved {
  databases?: number;
  registers?: number;
  databaseSources: NamedCount[];
  registerSources: NamedCount[];
  duplicatesRemoved?: number;
  automationIneligible?: number;
  otherRemoved?: number;
  recordsScreened?: number;
  recordsExcluded?: number;
  reportsSought?: number;
  reportsNotRetrieved?: number;
  reportsAssessed?: number;
  reasons: NamedCount[];
  reportsExcluded?: number;
  studiesIncluded?: number;
  reportsIncluded?: number;
  other?: {
    websites?: number;
    organisations?: number;
    citationSearching?: number;
    sources: NamedCount[];
    identified?: number;
    reportsSought?: number;
    reportsNotRetrieved?: number;
    reportsAssessed?: number;
    reasons: NamedCount[];
    reportsExcluded?: number;
  };
}

function excludedTotal(
  L: Ledger,
  field: string,
  reasons: NamedCount[] | undefined,
  total: number | undefined,
): number | undefined {
  const itemised = L.sum(`${field}Reasons`, reasons);
  const given = L.input(field, total);
  if (itemised !== undefined && given !== undefined && itemised !== given) {
    L.warnings.push({
      code: 'inconsistent',
      field,
      message: `${LABELS[field] ?? field}: the reasons add up to ${fmt(itemised)} but the total given is ${fmt(given)}.`,
      expected: itemised,
      given,
    });
  }
  return L.set(field, given ?? itemised, given === undefined && itemised !== undefined);
}

function resolveCounts(c: PrismaCounts, withOther: boolean): { r: Resolved; L: Ledger } {
  const L = new Ledger();
  const databaseSources = c.databaseSources ?? [];
  const registerSources = c.registerSources ?? [];
  const databases = L.resolve('databases', L.input('databases', c.databases), L.sum('databaseSources', databaseSources), 'sum of the databases listed');
  const registers = L.resolve('registers', L.input('registers', c.registers), L.sum('registerSources', registerSources), 'sum of the registers listed');
  const identified = L.set('recordsIdentified', add(databases, registers), true);
  const duplicatesRemoved = L.set('duplicatesRemoved', L.input('duplicatesRemoved', c.duplicatesRemoved));
  const automationIneligible = L.set('automationIneligible', L.input('automationIneligible', c.automationIneligible));
  const otherRemoved = L.set('otherRemoved', L.input('otherRemoved', c.otherRemoved));
  const removed = L.set('recordsRemoved', add(duplicatesRemoved, automationIneligible, otherRemoved), true);

  const recordsScreened = L.resolve(
    'recordsScreened',
    L.input('recordsScreened', c.recordsScreened),
    sub(identified, removed ?? 0),
    `records identified ${identified === undefined ? '?' : fmt(identified)} minus records removed before screening ${fmt(removed ?? 0)}`,
  );
  const recordsExcluded = L.set('recordsExcluded', L.input('recordsExcluded', c.recordsExcluded));
  const reportsSought = L.resolve(
    'reportsSought',
    L.input('reportsSought', c.reportsSought),
    sub(recordsScreened, recordsExcluded),
    `records screened ${recordsScreened === undefined ? '?' : fmt(recordsScreened)} minus records excluded ${recordsExcluded === undefined ? '?' : fmt(recordsExcluded)}`,
  );
  const reportsNotRetrieved = L.set('reportsNotRetrieved', L.input('reportsNotRetrieved', c.reportsNotRetrieved));
  const reportsAssessed = L.resolve(
    'reportsAssessed',
    L.input('reportsAssessed', c.reportsAssessed),
    sub(reportsSought, reportsNotRetrieved ?? 0),
    `reports sought ${reportsSought === undefined ? '?' : fmt(reportsSought)} minus reports not retrieved ${fmt(reportsNotRetrieved ?? 0)}`,
  );
  const reasons = c.reportsExcludedReasons ?? [];
  const reportsExcluded = excludedTotal(L, 'reportsExcluded', reasons, c.reportsExcluded);

  let other: Resolved['other'];
  let otherIncluded: number | undefined = 0;
  if (withOther) {
    const o = c.otherMethods ?? {};
    const p = 'otherMethods.';
    const websites = L.set(`${p}websites`, L.input(`${p}websites`, o.websites));
    const organisations = L.set(`${p}organisations`, L.input(`${p}organisations`, o.organisations));
    const citationSearching = L.set(`${p}citationSearching`, L.input(`${p}citationSearching`, o.citationSearching));
    const sources = o.sources ?? [];
    const oIdentified = L.set(
      `${p}recordsIdentified`,
      add(websites, organisations, citationSearching, L.sum(`${p}sources`, sources)),
      true,
    );
    // Not every record found by hand is sought, so the template only bounds this box.
    const oSought = L.set(`${p}reportsSought`, L.input(`${p}reportsSought`, o.reportsSought) ?? oIdentified, o.reportsSought === undefined && oIdentified !== undefined);
    if (oSought !== undefined && oIdentified !== undefined && oSought > oIdentified) {
      L.warnings.push({
        code: 'inconsistent',
        field: `${p}reportsSought`,
        message: `${LABELS[`${p}reportsSought`]} is ${fmt(oSought)}, more than the ${fmt(oIdentified)} records identified via other methods.`,
        expected: oIdentified,
        given: oSought,
      });
    }
    const oNotRetrieved = L.set(`${p}reportsNotRetrieved`, L.input(`${p}reportsNotRetrieved`, o.reportsNotRetrieved));
    const oAssessed = L.resolve(
      `${p}reportsAssessed`,
      L.input(`${p}reportsAssessed`, o.reportsAssessed),
      sub(oSought, oNotRetrieved ?? 0),
      `reports sought ${oSought === undefined ? '?' : fmt(oSought)} minus reports not retrieved ${fmt(oNotRetrieved ?? 0)}`,
    );
    const oReasons = o.reportsExcludedReasons ?? [];
    const oExcluded = excludedTotal(L, `${p}reportsExcluded`, oReasons, o.reportsExcluded);
    otherIncluded = sub(oAssessed, oExcluded ?? 0);
    other = {
      ...(websites !== undefined ? { websites } : {}),
      ...(organisations !== undefined ? { organisations } : {}),
      ...(citationSearching !== undefined ? { citationSearching } : {}),
      sources,
      ...(oIdentified !== undefined ? { identified: oIdentified } : {}),
      ...(oSought !== undefined ? { reportsSought: oSought } : {}),
      ...(oNotRetrieved !== undefined ? { reportsNotRetrieved: oNotRetrieved } : {}),
      ...(oAssessed !== undefined ? { reportsAssessed: oAssessed } : {}),
      reasons: oReasons,
      ...(oExcluded !== undefined ? { reportsExcluded: oExcluded } : {}),
    };
  }

  const mainIncluded = sub(reportsAssessed, reportsExcluded ?? 0);
  const reportsIncluded = L.resolve(
    'reportsIncluded',
    L.input('reportsIncluded', c.reportsIncluded),
    mainIncluded === undefined || otherIncluded === undefined ? undefined : mainIncluded + otherIncluded,
    withOther
      ? 'reports assessed minus reports excluded, in both columns'
      : `reports assessed ${reportsAssessed === undefined ? '?' : fmt(reportsAssessed)} minus reports excluded ${fmt(reportsExcluded ?? 0)}`,
  );
  const studiesIncluded = L.set('studiesIncluded', L.input('studiesIncluded', c.studiesIncluded));
  if (studiesIncluded !== undefined && reportsIncluded !== undefined && studiesIncluded > reportsIncluded) {
    L.warnings.push({
      code: 'inconsistent',
      field: 'studiesIncluded',
      message: `Studies included (${fmt(studiesIncluded)}) cannot exceed reports of included studies (${fmt(reportsIncluded)}): each study has at least one report.`,
      expected: reportsIncluded,
      given: studiesIncluded,
    });
  }
  if (studiesIncluded === undefined) {
    L.warnings.push({ code: 'missing', field: 'studiesIncluded', message: 'Studies included in review is missing.' });
  }
  if (identified === undefined) {
    L.warnings.push({ code: 'missing', field: 'databases', message: 'No records identified from databases or registers were given.' });
  }

  return {
    L,
    r: {
      ...(databases !== undefined ? { databases } : {}),
      ...(registers !== undefined ? { registers } : {}),
      databaseSources,
      registerSources,
      ...(duplicatesRemoved !== undefined ? { duplicatesRemoved } : {}),
      ...(automationIneligible !== undefined ? { automationIneligible } : {}),
      ...(otherRemoved !== undefined ? { otherRemoved } : {}),
      ...(recordsScreened !== undefined ? { recordsScreened } : {}),
      ...(recordsExcluded !== undefined ? { recordsExcluded } : {}),
      ...(reportsSought !== undefined ? { reportsSought } : {}),
      ...(reportsNotRetrieved !== undefined ? { reportsNotRetrieved } : {}),
      ...(reportsAssessed !== undefined ? { reportsAssessed } : {}),
      reasons,
      ...(reportsExcluded !== undefined ? { reportsExcluded } : {}),
      ...(studiesIncluded !== undefined ? { studiesIncluded } : {}),
      ...(reportsIncluded !== undefined ? { reportsIncluded } : {}),
      ...(other ? { other } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const FONT = "'Be Vietnam Pro', 'Helvetica Neue', Arial, sans-serif";
const FONT_SIZE = 13;
const LINE_H = 18;
const PAD_X = 12;
const PAD_Y = 10;
const BOX_W = 300;
const SIDE_W = 270;
const GAP_X = 44;
const GAP_Y = 40;
const MARGIN = 24;
const BAR_W = 30;
const HEADER_H = 46;
const INK = '#1f2624';
const MUTED = '#5b6764';
const LINE = '#384240';
const BOX_FILL = '#ffffff';
const BAR_FILL = '#ecfdf5';

/**
 * Rough advance width in em for Be Vietnam Pro / Arial-like sans. Errs wide
 * so a wrapped line never overflows its box in any of the fallback fonts.
 */
function charEm(ch: string): number {
  if (/[il.,:;'|!()[\]]/.test(ch)) return 0.3;
  if (/[fjrt\- ]/.test(ch)) return 0.38;
  if (/[mwMW]/.test(ch)) return 0.92;
  if (/[A-Z]/.test(ch)) return 0.7;
  if (/[0-9]/.test(ch)) return 0.62;
  return 0.58;
}

function textWidth(s: string, size = FONT_SIZE): number {
  let em = 0;
  for (const ch of s) em += charEm(ch);
  return em * size;
}

function wrap(text: string, width: number, size = FONT_SIZE): string[] {
  // Split on plain spaces only: `\s` would also break the non-breaking ones.
  const words = text.replace(/[\t\r\n]+/g, ' ').split(/ +/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    // A single word wider than the box (a URL, a pasted id) is cut, not allowed to overflow.
    let w = word;
    while (textWidth(w, size) > width && w.length > 1) {
      let cut = w.length - 1;
      while (cut > 1 && textWidth(w.slice(0, cut), size) > width) cut--;
      if (line) lines.push(line);
      lines.push(w.slice(0, cut));
      line = '';
      w = w.slice(cut);
    }
    const next = line ? `${line} ${w}` : w;
    if (line && textWidth(next, size) > width) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function esc(s: string): string {
  // Control characters are not allowed in XML at all.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Non-breaking spaces keep "(n = 27)" on one line when a label wraps.
/** User-supplied labels (database names, exclusion reasons) are capped so one cannot swamp the diagram. */
const label = (s: string) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);

const n = (v: number | undefined) => `(n\u00a0=\u00a0${v === undefined ? '–' : fmt(v)})`;

interface Line {
  text: string;
  indent?: boolean;
  bold?: boolean;
}

interface Box {
  x: number;
  width: number;
  lines: string[][];
  bold: boolean[];
  indent: boolean[];
}

function makeBox(x: number, width: number, content: Line[]): Box {
  const inner = width - 2 * PAD_X;
  return {
    x,
    width,
    lines: content.map((l) => wrap(l.text, inner - (l.indent ? 12 : 0))),
    bold: content.map((l) => !!l.bold),
    indent: content.map((l) => !!l.indent),
  };
}

const boxHeight = (b: Box) => 2 * PAD_Y + b.lines.reduce((a, l) => a + l.length, 0) * LINE_H;

function drawBox(b: Box, y: number, h: number): string {
  const out = [`<rect x="${b.x}" y="${y}" width="${b.width}" height="${h}" fill="${BOX_FILL}" stroke="${LINE}" stroke-width="1.2"/>`];
  let ty = y + PAD_Y + LINE_H - 5;
  b.lines.forEach((wrapped, i) => {
    for (const t of wrapped) {
      const x = b.x + PAD_X + (b.indent[i] ? 12 : 0);
      out.push(
        `<text x="${x}" y="${ty}"${b.bold[i] ? ' font-weight="600"' : ''}>${esc(t)}</text>`,
      );
      ty += LINE_H;
    }
  });
  return out.join('');
}

function arrow(x1: number, y1: number, x2: number, y2: number): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${LINE}" stroke-width="1.4" marker-end="url(#ah)"/>`;
}

function polyArrow(points: [number, number][]): string {
  return `<polyline points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${LINE}" stroke-width="1.4" marker-end="url(#ah)"/>`;
}

function exclusionLines(title: string, reasons: NamedCount[], total: number | undefined): Line[] {
  if (reasons.length === 0) return [{ text: `${title} ${n(total)}` }];
  return [{ text: `${title}:`, bold: true }, ...reasons.map((r) => ({ text: `${label(r.name)} ${n(r.n)}`, indent: true }))];
}

/** Build the PRISMA 2020 diagram and check its arithmetic. */
export function prismaFlowDiagram(counts: PrismaCounts, options: PrismaOptions = {}): PrismaResult {
  const withOther = options.otherMethods ?? counts.otherMethods !== undefined;
  const footnotes = options.footnotes ?? true;
  const accent = options.accent ?? '#047857';
  const { r, L } = resolveCounts(counts, withOther);

  const x0 = MARGIN + BAR_W + 16;
  const xSide = x0 + BOX_W + GAP_X;
  const xOther = xSide + SIDE_W + GAP_X;
  const xOtherSide = xOther + BOX_W + GAP_X;
  const width = (withOther ? xOtherSide + SIDE_W : xSide + SIDE_W) + MARGIN;

  // Rows: [main, side, other, otherSide]
  // Per-database lines read as sub-items of "Databases" / "Registers".
  const subItems = (items: NamedCount[]) => items.map((s) => ({ text: `– ${label(s.name)} ${n(s.n)}`, indent: true }));
  const identified: Line[] = [
    { text: 'Records identified from*:', bold: true },
    { text: `Databases ${n(r.databases)}`, indent: true },
    ...subItems(r.databaseSources),
    { text: `Registers ${n(r.registers)}`, indent: true },
    ...subItems(r.registerSources),
  ];

  const rows: (Line[] | null)[][] = [
    [
      identified,
      [
        { text: 'Records removed before screening:', bold: true },
        { text: `Duplicate records removed ${n(r.duplicatesRemoved)}`, indent: true },
        { text: `Records marked as ineligible by automation tools ${n(r.automationIneligible)}`, indent: true },
        { text: `Records removed for other reasons ${n(r.otherRemoved)}`, indent: true },
      ],
      withOther
        ? [
            { text: 'Records identified from:', bold: true },
            { text: `Websites ${n(r.other?.websites)}`, indent: true },
            { text: `Organisations ${n(r.other?.organisations)}`, indent: true },
            { text: `Citation searching ${n(r.other?.citationSearching)}`, indent: true },
            ...(r.other?.sources ?? []).map((s) => ({ text: `${label(s.name)} ${n(s.n)}`, indent: true })),
          ]
        : null,
      null,
    ],
    [[{ text: `Records screened ${n(r.recordsScreened)}` }], [{ text: `Records excluded** ${n(r.recordsExcluded)}` }], null, null],
    [
      [{ text: `Reports sought for retrieval ${n(r.reportsSought)}` }],
      [{ text: `Reports not retrieved ${n(r.reportsNotRetrieved)}` }],
      withOther ? [{ text: `Reports sought for retrieval ${n(r.other?.reportsSought)}` }] : null,
      withOther ? [{ text: `Reports not retrieved ${n(r.other?.reportsNotRetrieved)}` }] : null,
    ],
    [
      [{ text: `Reports assessed for eligibility ${n(r.reportsAssessed)}` }],
      exclusionLines('Reports excluded', r.reasons, r.reportsExcluded),
      withOther ? [{ text: `Reports assessed for eligibility ${n(r.other?.reportsAssessed)}` }] : null,
      withOther ? exclusionLines('Reports excluded', r.other?.reasons ?? [], r.other?.reportsExcluded) : null,
    ],
    [
      [
        { text: `Studies included in review ${n(r.studiesIncluded)}` },
        { text: `Reports of included studies ${n(r.reportsIncluded)}` },
      ],
      null,
      null,
      null,
    ],
  ];

  const xs = [x0, xSide, xOther, xOtherSide];
  const ws = [BOX_W, SIDE_W, BOX_W, SIDE_W];
  const boxes = rows.map((row) => row.map((content, i) => (content ? makeBox(xs[i]!, ws[i]!, content) : null)));

  let y = MARGIN;
  const parts: string[] = [];
  // Section headers.
  const headerY = y;
  const header = (x: number, w: number, label: string) => {
    const lines = wrap(label, w - 2 * PAD_X, 14);
    const ty = headerY + HEADER_H / 2 - ((lines.length - 1) * 17) / 2 + 5;
    parts.push(`<rect x="${x}" y="${headerY}" width="${w}" height="${HEADER_H}" rx="6" fill="${accent}"/>`);
    lines.forEach((t, i) =>
      parts.push(`<text x="${x + w / 2}" y="${ty + i * 17}" text-anchor="middle" font-size="14" font-weight="600" fill="#ecfdf5">${esc(t)}</text>`),
    );
  };
  header(x0, xSide + SIDE_W - x0, 'Identification of new studies via databases and registers');
  if (withOther) header(xOther, xOtherSide + SIDE_W - xOther, 'Identification of new studies via other methods');
  y += HEADER_H + 24;

  const rowY: number[] = [];
  const rowH: number[] = [];
  // The rotated phase labels need their bar to be at least as tall as the word.
  const minH = [textWidth('Identification'), 0, 0, 0, textWidth('Included')].map((w) => Math.ceil(w + 24));
  for (const [ri, row] of boxes.entries()) {
    const h = Math.max(minH[ri] ?? 0, ...row.map((b) => (b ? boxHeight(b) : 0)));
    rowY.push(y);
    rowH.push(h);
    y += h + GAP_Y;
  }
  y -= GAP_Y;

  // Phase bars on the left.
  const bar = (label: string, top: number, bottom: number) => {
    const cy = (top + bottom) / 2;
    const cx = MARGIN + BAR_W / 2;
    parts.push(`<rect x="${MARGIN}" y="${top}" width="${BAR_W}" height="${bottom - top}" rx="6" fill="${BAR_FILL}" stroke="${accent}" stroke-width="1"/>`);
    parts.push(
      `<text x="${cx}" y="${cy}" transform="rotate(-90 ${cx} ${cy})" text-anchor="middle" dominant-baseline="central" font-size="13" font-weight="600" fill="${accent}">${label}</text>`,
    );
  };
  bar('Identification', rowY[0]!, rowY[0]! + rowH[0]!);
  bar('Screening', rowY[1]!, rowY[3]! + rowH[3]!);
  bar('Included', rowY[4]!, rowY[4]! + rowH[4]!);

  // Boxes: every box in a row shares the row's height, like the template.
  boxes.forEach((row, ri) => row.forEach((b) => b && parts.push(drawBox(b, rowY[ri]!, rowH[ri]!))));

  // Arrows.
  const mid = (ri: number) => rowY[ri]! + rowH[ri]! / 2;
  const bottom = (ri: number) => rowY[ri]! + rowH[ri]!;
  const cxMain = x0 + BOX_W / 2;
  for (let ri = 0; ri < 4; ri++) {
    parts.push(arrow(cxMain, bottom(ri), cxMain, rowY[ri + 1]! - 2));
    parts.push(arrow(x0 + BOX_W, mid(ri), xSide - 2, mid(ri)));
  }
  if (withOther) {
    const cxO = xOther + BOX_W / 2;
    parts.push(arrow(cxO, bottom(0), cxO, rowY[2]! - 2));
    parts.push(arrow(cxO, bottom(2), cxO, rowY[3]! - 2));
    parts.push(arrow(xOther + BOX_W, mid(2), xOtherSide - 2, mid(2)));
    parts.push(arrow(xOther + BOX_W, mid(3), xOtherSide - 2, mid(3)));
    parts.push(polyArrow([[cxO, bottom(3)], [cxO, mid(4)], [x0 + BOX_W + 2, mid(4)]]));
  }

  if (footnotes) {
    y += 22;
    const notes = [
      '*Consider, if feasible to do so, reporting the number of records identified from each database or register searched (rather than the total number across all databases/registers).',
      '**If automation tools were used, indicate how many records were excluded by a human and how many were excluded by automation tools.',
      'Template: Page MJ, McKenzie JE, Bossuyt PM, et al. The PRISMA 2020 statement: an updated guideline for reporting systematic reviews. BMJ 2021;372:n71. doi:10.1136/bmj.n71. CC BY 4.0.',
    ];
    for (const note of notes) {
      for (const t of wrap(note, width - 2 * MARGIN, 11)) {
        parts.push(`<text x="${MARGIN}" y="${y}" font-size="11" fill="${MUTED}">${esc(t)}</text>`);
        y += 15;
      }
      y += 3;
    }
  }
  const height = Math.ceil(y + MARGIN);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="prisma-title">`,
    `<title id="prisma-title">PRISMA 2020 flow diagram</title>`,
    `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${LINE}"/></marker></defs>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<g font-family="${esc(FONT)}" font-size="${FONT_SIZE}" fill="${INK}">`,
    ...parts,
    '</g>',
    '</svg>',
  ].join('\n');

  return { svg, width, height, warnings: L.warnings, counts: L.counts };
}
