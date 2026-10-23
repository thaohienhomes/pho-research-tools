/**
 * screeningLog — PRISMA counts from the screening decisions themselves.
 *
 * A PRISMA diagram is usually filled in by hand from a spreadsheet, and the
 * counts drift from the decisions behind them. Here the decisions are the
 * input: one row per record, with its title/abstract decision, its full-text
 * decision and the reason for any full-text exclusion. Every PRISMA box below
 * "records screened" is counted from those rows, and the rows come back as a
 * CSV a reviewer can attach as the screening appendix.
 *
 * Pure: no network, no model.
 */

import type { NamedCount, PrismaCounts } from './prisma';

export type ScreeningDecision = 'include' | 'exclude';
export type FullTextDecision = 'include' | 'exclude' | 'not_retrieved';

export interface ScreeningRecord {
  /** DOI, PMID or title: whatever identifies the record to the reviewer. */
  id: string;
  title?: string;
  /** Title/abstract screening. */
  screening: ScreeningDecision;
  /** Full-text assessment; only for records included at screening. */
  fullText?: FullTextDecision;
  /** Why it was excluded. Required by PRISMA for full-text exclusions. */
  reason?: string;
}

export interface ScreeningIdentification {
  databases?: number;
  databaseSources?: NamedCount[];
  registers?: number;
  registerSources?: NamedCount[];
  duplicatesRemoved?: number;
  automationIneligible?: number;
  otherRemoved?: number;
}

export interface ScreeningIssue {
  code: 'duplicate_id' | 'missing_reason' | 'pending_full_text' | 'full_text_without_inclusion';
  message: string;
  ids: string[];
}

export interface ScreeningResult {
  /** Ready for `prismaFlowDiagram`. */
  counts: PrismaCounts;
  /** Full-text exclusions grouped by reason, largest first. */
  reasons: NamedCount[];
  /** Title/abstract exclusions grouped by reason (not drawn in PRISMA 2020, reported for transparency). */
  screeningReasons: NamedCount[];
  pendingFullText: number;
  issues: ScreeningIssue[];
  /** One row per record, RFC 4180, for the review's appendix. */
  csv: string;
}

const NO_REASON = 'Reason not recorded';
const MAX_IDS_IN_ISSUE = 10;
/** Same limits `prisma_flow_diagram` puts on its input: the diagram stays legible and bounded. */
export const MAX_DIAGRAM_REASONS = 30;
export const MAX_REASON_LENGTH = 160;

function group(rows: ScreeningRecord[]): NamedCount[] {
  const m = new Map<string, { name: string; n: number }>();
  for (const r of rows) {
    const name = r.reason?.trim().replace(/\s+/g, ' ').slice(0, MAX_REASON_LENGTH) || NO_REASON;
    const key = name.toLowerCase();
    const g = m.get(key);
    if (g) g.n++;
    else m.set(key, { name, n: 1 });
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** Keeps the largest groups and folds the rest into one box, so the diagram has at most `MAX_DIAGRAM_REASONS`. */
function forDiagram(reasons: NamedCount[]): NamedCount[] {
  if (reasons.length <= MAX_DIAGRAM_REASONS) return reasons;
  const kept = reasons.slice(0, MAX_DIAGRAM_REASONS - 1);
  const rest = reasons.slice(MAX_DIAGRAM_REASONS - 1);
  return [...kept, { name: `Other reasons (${rest.length})`, n: rest.reduce((a, g) => a + g.n, 0) }];
}

function csvCell(v: string | undefined): string {
  // A cell starting with = + - @ (or a tab/CR) runs as a formula when the log is opened in a spreadsheet.
  const s = /^[=+\-@\t\r]/.test(v ?? '') ? `'${v}` : (v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function issue(code: ScreeningIssue['code'], message: string, ids: string[]): ScreeningIssue {
  const shown = ids.slice(0, MAX_IDS_IN_ISSUE);
  return { code, message: ids.length > shown.length ? `${message} (${ids.length} records)` : message, ids: shown };
}

export function screeningLog(
  records: ScreeningRecord[],
  identification: ScreeningIdentification = {},
): ScreeningResult {
  const issues: ScreeningIssue[] = [];

  const seen = new Map<string, number>();
  for (const r of records) seen.set(r.id.trim().toLowerCase(), (seen.get(r.id.trim().toLowerCase()) ?? 0) + 1);
  const dups = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  if (dups.length) {
    issues.push(issue('duplicate_id', 'Some records appear more than once; each row is still counted.', dups));
  }

  const screenedOut = records.filter((r) => r.screening === 'exclude');
  const sought = records.filter((r) => r.screening === 'include');
  const strayFullText = screenedOut.filter((r) => r.fullText);
  if (strayFullText.length) {
    issues.push(
      issue(
        'full_text_without_inclusion',
        'Records excluded at screening also carry a full-text decision; it was ignored.',
        strayFullText.map((r) => r.id),
      ),
    );
  }
  const notRetrieved = sought.filter((r) => r.fullText === 'not_retrieved');
  const ftExcluded = sought.filter((r) => r.fullText === 'exclude');
  const included = sought.filter((r) => r.fullText === 'include');
  const pending = sought.filter((r) => !r.fullText);
  if (pending.length) {
    issues.push(
      issue(
        'pending_full_text',
        `${pending.length} record(s) passed screening but have no full-text decision yet; the boxes below "Reports sought" are incomplete until they do.`,
        pending.map((r) => r.id),
      ),
    );
  }
  const noReason = ftExcluded.filter((r) => !r.reason?.trim());
  if (noReason.length) {
    issues.push(
      issue(
        'missing_reason',
        `PRISMA 2020 asks for a reason for every full-text exclusion; ${noReason.length} have none and are shown as "${NO_REASON}".`,
        noReason.map((r) => r.id),
      ),
    );
  }

  const reasons = group(ftExcluded);
  const counts: PrismaCounts = {
    ...identification,
    recordsScreened: records.length,
    recordsExcluded: screenedOut.length,
    reportsSought: sought.length,
    reportsNotRetrieved: notRetrieved.length,
    // Pending records are neither assessed nor excluded yet; leaving them out of
    // "assessed" keeps the diagram's arithmetic honest about it.
    reportsAssessed: ftExcluded.length + included.length,
    ...(reasons.length ? { reportsExcludedReasons: forDiagram(reasons) } : { reportsExcluded: 0 }),
    studiesIncluded: included.length,
  };

  const header = 'id,title,screening,full_text,reason';
  const lines = records.map((r) =>
    [r.id, r.title, r.screening, r.screening === 'include' ? (r.fullText ?? 'pending') : '', r.reason]
      .map(csvCell)
      .join(','),
  );

  return {
    counts,
    reasons,
    screeningReasons: group(screenedOut).filter((g) => g.name !== NO_REASON),
    pendingFullText: pending.length,
    issues,
    csv: [header, ...lines].join('\r\n') + '\r\n',
  };
}
