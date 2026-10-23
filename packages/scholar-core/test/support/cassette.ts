/**
 * Recorded HTTP responses ("cassettes") for the quality test.
 *
 * The quality bar has to measure the real pipeline: parse → Crossref → PubMed
 * → OpenAlex → decision. Calling the live APIs on every CI run would make the
 * gate flaky (rate limits, index updates) and slow, so responses are recorded
 * once and replayed through the same `HttpClient` seam production uses.
 *
 * Modes (env `SCHOLAR_RECORD`):
 *   unset     replay only. A request with no recording returns status 0 and is
 *             listed in `misses`, which the test asserts is empty.
 *   missing   replay, fetch + save anything not yet recorded, and drop
 *             recordings no request used (the full suite runs in this mode).
 * `SCHOLAR_LIVE=1` bypasses cassettes entirely (manual drift check).
 *
 * One JSON file per host, keyed by `cacheKey(url)` so contact emails and API
 * keys never end up in the repository.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheKey, createFetchHttp, type HttpClient, type HttpResponse } from '../../src/http';

/** Keys the pipeline never reads. Dropping them keeps cassettes reviewable. */
const DROP_KEYS = new Set([
  'reference',
  'abstract',
  'license',
  'link',
  'assertion',
  'funder',
  'content-domain',
  'institution',
  'resource',
  'subject',
  'references-count',
  'is-referenced-by-count',
  'indexed',
  'deposited',
  'score',
  'affiliation',
  'ORCID',
  'authenticated-orcid',
  'clinical-trial-number',
  'review',
  'archive',
  // Europe PMC `core` records: lists findEvidence never reads.
  'authorList',
  'authorIdList',
  'investigatorList',
  'meshHeadingList',
  'chemicalList',
  'keywordList',
  'grantsList',
  'fullTextUrlList',
  'fullTextIdList',
  'commentCorrectionList',
  'subsetList',
  'dbCrossReferenceList',
  'tmAccessionTypeList',
  'embargoDate',
]);

/**
 * Dataset repositories put `license` and `subject` to use, so they get their
 * own list: only the bulky parts (file listings, feature schemas) go.
 */
const DATASET_HOSTS = new Set([
  'huggingface.co',
  'api.datacite.org',
  'huggingscience.co',
  'graphql.cryoetdataportal.czscience.com',
]);
const DATASET_DROP_KEYS = new Set([
  'siblings',
  'dataset_info',
  'configs',
  'model-index',
  'widget',
  'widgetData',
  'safetensors',
  'spaces',
  'transformersInfo',
  'config',
]);

/**
 * CELLxGENE answers with every public collection at once. Only the labels the
 * pipeline reads stay; ontology ids, contacts and version ids go.
 */
const CELLXGENE_DROP_KEYS = new Set([
  'links',
  'contact_email',
  'contact_name',
  'curator_name',
  'collection_version_id',
  'dataset_version_id',
  'ontology_term_id',
  'tissue_type',
  'cell_type',
  'development_stage',
  'self_reported_ethnicity',
  'sex',
  'suspension_type',
  'genetic_perturbation_strategy',
  'perturbation_types',
  'revising_in',
  'revision_of',
]);

/**
 * bio.tools records carry contacts (names, emails, ORCIDs), the owner's login
 * and edit permissions; none of it is read, and none of it belongs in a
 * committed file.
 */
const BIOTOOLS_DROP_KEYS = new Set([
  'credit',
  'owner',
  'editPermission',
  'relation',
  'documentation',
  'otherID',
  'elixirPlatform',
  'elixirNode',
  'elixirCommunity',
  'collectionID',
  'biotoolsCURIE',
  'validated',
  'homepage_status',
  'elixir_badge',
  'confidence_flag',
  'additionDate',
  'cmd',
  'note',
  'metadata',
]);

/** GitHub answers with ~90 fields; the pipeline reads three. Everything else goes. */
const GITHUB_KEEP = new Set(['archived', 'pushed_at', 'html_url', 'license', 'spdx_id']);

export function sanitize(v: unknown, host = ''): unknown {
  if (host === 'api.github.com') {
    if (Array.isArray(v)) return v.map((x) => sanitize(x, host));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v))
        if (GITHUB_KEEP.has(k)) out[k] = sanitize(val, host);
      return out;
    }
    return v;
  }
  const drop =
    host === 'bio.tools'
      ? BIOTOOLS_DROP_KEYS
      : host === 'api.cellxgene.cziscience.com'
        ? CELLXGENE_DROP_KEYS
        : DATASET_HOSTS.has(host)
          ? DATASET_DROP_KEYS
          : DROP_KEYS;
  if (Array.isArray(v)) return v.map((x) => sanitize(x, host));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (!drop.has(k)) out[k] = sanitize(val, host);
    return out;
  }
  return v;
}

/** Minimum gap between live requests per host while recording. */
const GAP_MS: Record<string, number> = {
  'eutils.ncbi.nlm.nih.gov': 400,
  // Crossref's public pool answered 429 at ~10 req/s (measured while recording).
  'api.crossref.org': 350,
  'api.openalex.org': 150,
  'doi.org': 100,
  'www.ebi.ac.uk': 250,
  'huggingface.co': 300,
  'api.datacite.org': 250,
  'api.cellxgene.cziscience.com': 500,
  'graphql.cryoetdataportal.czscience.com': 300,
  'bio.tools': 500,
  'api.github.com': 1000,
};

export interface Cassette {
  http: HttpClient;
  misses: string[];
  /** Write any newly recorded responses to disk. */
  save(): void;
}

export function openCassette(dir: string, opts: { contactEmail?: string } = {}): Cassette {
  const record = process.env.SCHOLAR_RECORD === 'missing';
  const live = createFetchHttp({ contactEmail: opts.contactEmail, timeoutMs: 20_000 });
  const files = new Map<string, Record<string, HttpResponse>>();
  const dirty = new Set<string>();
  const lastCall = new Map<string, number>();
  const misses: string[] = [];
  const used = new Map<string, Set<string>>();

  function tape(host: string): Record<string, HttpResponse> {
    let t = files.get(host);
    if (!t) {
      const p = join(dir, `${host}.json`);
      t = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, HttpResponse>) : {};
      files.set(host, t);
    }
    return t;
  }

  async function throttle(host: string) {
    const gap = GAP_MS[host] ?? 200;
    const wait = (lastCall.get(host) ?? 0) + gap - Date.now();
    lastCall.set(host, Date.now() + Math.max(0, wait));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  const http: HttpClient = async (req) => {
    const host = new URL(req.url).host;
    const key = cacheKey(req.url, req.body);
    const t = tape(host);
    if (!used.has(host)) used.set(host, new Set());
    used.get(host)!.add(key);
    const hit = t[key];
    if (hit) return hit;
    if (!record) {
      misses.push(key);
      return { status: 0, body: null };
    }
    await throttle(host);
    // Runners share IPs, so GitHub's anonymous limit runs out; the key is not part of the cache key.
    const token = host === 'api.github.com' ? process.env.GITHUB_TOKEN : undefined;
    const res = await live(
      token ? { ...req, headers: { ...req.headers, authorization: `Bearer ${token}` } } : req,
    );
    // Only stable answers are recorded; a 429/5xx/timeout must be retried later.
    if (res.status === 200 || res.status === 404) {
      t[key] = { status: res.status, body: sanitize(res.body, host) };
      dirty.add(host);
    } else {
      misses.push(`${res.status} ${key}`);
    }
    return res;
  };

  return {
    http,
    misses,
    save() {
      // While recording, drop responses no request asked for: a request the
      // code stopped making must not keep its stale answer in the repository.
      if (record) {
        for (const [host, t] of files) {
          const keep = used.get(host) ?? new Set<string>();
          for (const k of Object.keys(t)) {
            if (!keep.has(k)) {
              delete t[k];
              dirty.add(host);
            }
          }
        }
      }
      if (dirty.size === 0) return;
      mkdirSync(dir, { recursive: true });
      for (const host of dirty) {
        const t = files.get(host)!;
        const sorted = Object.fromEntries(Object.keys(t).sort().map((k) => [k, t[k]]));
        writeFileSync(join(dir, `${host}.json`), `${JSON.stringify(sorted, null, 1)}\n`);
      }
      dirty.clear();
    },
  };
}
