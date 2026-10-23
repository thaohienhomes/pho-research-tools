/**
 * bio.tools (the ELIXIR registry of life-science software), through its public
 * REST API.
 *
 * Records describe a tool with EDAM terms for what it does (operations),
 * what it reads and writes (data types and formats) and the field it serves
 * (topics), plus its licence, links, downloads and the publications to cite.
 * Only identifiers the registry lists are used downstream: a paper is the DOI
 * or PMID in `publication`, a repository is a URL in `link` or `download`.
 *
 * The registry's data licence is not stated in its API documentation, so the
 * caller keeps `BIOTOOLS_LICENCE_NOTE` next to every result.
 */

import type { HttpClient } from '../http';
import type { LookupOutcome } from './crossref';

export const BIOTOOLS_API = 'https://bio.tools/api/t/';
export const BIOTOOLS_LICENCE_NOTE =
  'Tool records come from bio.tools (ELIXIR), used under CC BY 4.0 (https://bio.tools). Each tool keeps its own licence.';
const MAX_TERMS = 4;

interface BiotoolsEdam {
  uri?: string;
  term?: string;
}

interface BiotoolsIo {
  data?: BiotoolsEdam;
  format?: BiotoolsEdam[];
}

interface BiotoolsDoc {
  biotoolsID?: string;
  name?: string;
  description?: string;
  homepage?: string;
  version?: string[];
  license?: string | null;
  cost?: string | null;
  accessibility?: string | null;
  maturity?: string | null;
  toolType?: string[];
  language?: string[];
  operatingSystem?: string[];
  topic?: BiotoolsEdam[];
  function?: { operation?: BiotoolsEdam[]; input?: BiotoolsIo[]; output?: BiotoolsIo[] }[];
  link?: { url?: string; type?: string[] }[];
  download?: { url?: string; type?: string | null }[];
  publication?: { doi?: string | null; pmid?: string | null; type?: string[] }[];
  lastUpdate?: string;
}

export interface BiotoolsPublication {
  doi?: string;
  pmid?: string;
  /** Registry label: `Primary`, `Method`, `Review`, `Preprint`, … */
  types: string[];
}

export interface BiotoolsTool {
  id: string;
  /** The tool's page on bio.tools. */
  url: string;
  name: string;
  description?: string;
  homepage?: string;
  licence?: string;
  /** `Free of charge`, `Commercial`, … as the registry states it. */
  cost?: string;
  operations: string[];
  topics: string[];
  inputFormats: string[];
  outputFormats: string[];
  languages: string[];
  toolTypes: string[];
  maturity?: string;
  /** Every http(s) URL the registry lists for the tool (links and downloads). */
  urls: string[];
  publications: BiotoolsPublication[];
  lastUpdate?: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const DOI_RE = /^10\.\d{4,9}\/\S+$/;

function httpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function terms(list: BiotoolsEdam[] | undefined): string[] {
  return [...new Set((list ?? []).map((x) => x.term?.trim()).filter((t): t is string => !!t))];
}

export function mapBiotools(d: BiotoolsDoc): BiotoolsTool | null {
  if (!d.biotoolsID || !ID_RE.test(d.biotoolsID) || !d.name?.trim()) return null;
  const fns = d.function ?? [];
  const urls = [
    ...new Set(
      [d.homepage, ...(d.link ?? []).map((l) => l.url), ...(d.download ?? []).map((x) => x.url)]
        .map(httpUrl)
        .filter((u): u is string => !!u),
    ),
  ];
  const publications: BiotoolsPublication[] = [];
  for (const p of d.publication ?? []) {
    const doi = p.doi?.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const pmid = p.pmid?.trim();
    const ok = {
      ...(doi && DOI_RE.test(doi) ? { doi } : {}),
      ...(pmid && /^\d{1,9}$/.test(pmid) ? { pmid } : {}),
    };
    if (ok.doi || ok.pmid) publications.push({ ...ok, types: p.type ?? [] });
  }
  const str = (v: string | null | undefined) => (v && v.trim() ? v.trim() : undefined);
  const homepage = httpUrl(d.homepage);
  return {
    id: d.biotoolsID,
    url: `https://bio.tools/${d.biotoolsID}`,
    name: d.name.trim(),
    ...(str(d.description) ? { description: str(d.description) } : {}),
    ...(homepage ? { homepage } : {}),
    ...(str(d.license) ? { licence: str(d.license) } : {}),
    ...(str(d.cost) ? { cost: str(d.cost) } : {}),
    operations: [...new Set(fns.flatMap((f) => terms(f.operation)))],
    topics: terms(d.topic),
    inputFormats: [...new Set(fns.flatMap((f) => (f.input ?? []).flatMap((i) => terms(i.format))))],
    outputFormats: [
      ...new Set(fns.flatMap((f) => (f.output ?? []).flatMap((i) => terms(i.format)))),
    ],
    languages: (d.language ?? []).filter(Boolean),
    toolTypes: (d.toolType ?? []).filter(Boolean),
    ...(str(d.maturity) ? { maturity: str(d.maturity) } : {}),
    urls,
    publications,
    ...(str(d.lastUpdate) ? { lastUpdate: str(d.lastUpdate) } : {}),
  };
}

/** Words safe to put in a query string: letters, digits and hyphens. */
export function biotoolsQuery(words: string[]): string | undefined {
  const w = [
    ...new Set(
      words.map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter((t) => t.length >= 2),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_TERMS);
  return w.length ? w.join(' ') : undefined;
}

/** One page of tools matching the words. An empty page is an answer, not an error. */
export async function biotoolsSearch(
  http: HttpClient,
  words: string[],
): Promise<LookupOutcome<BiotoolsTool[]>> {
  const q = biotoolsQuery(words);
  if (!q) return { ok: true, value: [] };
  const res = await http({ url: `${BIOTOOLS_API}?format=json&page=1&q=${encodeURIComponent(q)}` });
  if (res.status === 429) return { ok: false, reason: 'rate_limited' };
  if (res.status === 404) return { ok: true, value: [] };
  if (res.status !== 200) return { ok: false, reason: 'error' };
  const list = (res.body as { list?: BiotoolsDoc[] } | null)?.list;
  if (!Array.isArray(list)) return { ok: false, reason: 'error' };
  const out: BiotoolsTool[] = [];
  const seen = new Set<string>();
  for (const d of list) {
    const m = mapBiotools(d);
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return { ok: true, value: out };
}
