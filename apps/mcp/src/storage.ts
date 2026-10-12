/**
 * Quota counters (`rt_usage`) and the response cache (`rt_cache`).
 *
 * Two implementations of each: in-memory for local runs and tests, Postgres
 * for anything with more than one process (Vercel, several containers). The
 * tables are defined in packages/database/src/schema/research-tools.ts and
 * created by packages/database/drizzle/manual/2026-10-05_research_tools.sql.
 */

import { neon } from '@neondatabase/serverless';
import type { HttpResponse, ScholarCache } from '@pho/scholar-core';
import { runInBackground } from './analytics';

export type QuotaMetric = 'verifications' | 'calls';

export interface Grant {
  /** Units actually granted (0..requested). */
  granted: number;
  /** Units used in this window after the grant. */
  used: number;
  limit: number;
}

export interface UsageStore {
  /**
   * Atomically take up to `units` from the allowance of the window starting on
   * `day` (today for anonymous callers, the 1st of the month for accounts).
   * Never over-grants: two parallel requests cannot both receive the last unit.
   */
  take(subject: string, metric: QuotaMetric, units: number, limit: number, day: string, plan?: QuotaPlan): Promise<Grant>;
}

/** `anon`: per network, per day. `free`: a signed-in Phở account, per month. Paid plans come later. */
export type QuotaPlan = 'anon' | 'free';

export function createMemoryUsageStore(): UsageStore {
  const used = new Map<string, number>();
  let currentDay = '';
  return {
    async take(subject, metric, units, limit, day) {
      // A window is at most a month long. When the day turns over, drop
      // counters whose window started more than 31 days earlier.
      if (day !== currentDay) {
        const cutoff = utcDay(new Date(Date.parse(`${day}T00:00:00Z`) - 31 * 24 * 60 * 60 * 1000));
        for (const key of used.keys()) if (key.slice(key.lastIndexOf('|') + 1) < cutoff) used.delete(key);
        currentDay = day;
      }
      const key = `${subject}|${metric}|${day}`;
      const before = used.get(key) ?? 0;
      const granted = Math.max(0, Math.min(units, limit - before));
      used.set(key, before + granted);
      return { granted, used: before + granted, limit };
    },
  };
}

type Sql = ReturnType<typeof neon<false, false>>;

/**
 * Days of quota rows kept before they are deleted. Longer than the longest
 * window (a month, keyed by its 1st day), or a live monthly counter would go.
 */
export const USAGE_RETENTION_DAYS = 35;
/** Roughly one write in this many also deletes a batch of stale rows. */
const CLEANUP_EVERY = 200;
const CLEANUP_BATCH = 500;

/**
 * Nothing else deletes from rt_usage or rt_cache, so writes occasionally clear
 * a bounded batch of stale rows in the background. Spread over traffic, this
 * keeps both tables at roughly their live size without a cron job.
 */
function maybeCleanup(run: () => Promise<unknown>): void {
  if (Math.random() * CLEANUP_EVERY >= 1) return;
  runInBackground(
    run().catch((err) => {
      console.error('[mcp] storage cleanup failed', err);
    }),
  );
}

/**
 * Postgres jsonb rejects U+0000 and unpaired surrogates, both of which can
 * appear in scholarly API text. Strip them so the response can still be cached.
 */
export function jsonbSafe(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'string'
      ? v.replace(/\u0000/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
      : v,
  );
}

export function createPgUsageStore(sql: Sql): UsageStore {
  return {
    async take(subject, metric, units, limit, day, plan = 'anon') {
      // `last_grant` records what THIS statement granted, so the grant comes
      // back from the same atomic upsert that applied it.
      const rows = (await sql`
        INSERT INTO rt_usage (subject, day, metric, used, last_grant, plan)
        VALUES (${subject}, ${day}, ${metric}, LEAST(${units}::int, ${limit}::int), LEAST(${units}::int, ${limit}::int), ${plan})
        ON CONFLICT (subject, day, metric) DO UPDATE SET
          last_grant = LEAST(${units}::int, GREATEST(${limit}::int - rt_usage.used, 0)),
          used = rt_usage.used + LEAST(${units}::int, GREATEST(${limit}::int - rt_usage.used, 0)),
          updated_at = now()
        RETURNING used, last_grant
      `) as { used: number; last_grant: number }[];
      const row = rows[0];
      maybeCleanup(
        () => sql`
          DELETE FROM rt_usage WHERE ctid IN (
            SELECT ctid FROM rt_usage WHERE day < ${day}::date - ${USAGE_RETENTION_DAYS}::int LIMIT ${CLEANUP_BATCH}
          )
        `,
      );
      return { granted: Number(row?.last_grant ?? 0), used: Number(row?.used ?? 0), limit };
    },
  };
}

export function createPgCache(sql: Sql): ScholarCache {
  return {
    async get(key) {
      const rows = (await sql`
        SELECT status, body FROM rt_cache WHERE key = ${key} AND expires_at > now()
      `) as { status: number; body: unknown }[];
      const row = rows[0];
      return row ? ({ status: Number(row.status), body: row.body } satisfies HttpResponse) : undefined;
    },
    async set(key, value, ttlSeconds) {
      await sql`
        INSERT INTO rt_cache (key, status, body, expires_at)
        VALUES (${key}, ${value.status}, ${jsonbSafe(value.body)}::jsonb, now() + make_interval(secs => ${ttlSeconds}))
        ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, body = EXCLUDED.body,
          expires_at = EXCLUDED.expires_at, updated_at = now()
      `;
      maybeCleanup(
        () => sql`
          DELETE FROM rt_cache WHERE key IN (
            SELECT key FROM rt_cache WHERE expires_at < now() LIMIT ${CLEANUP_BATCH}
          )
        `,
      );
    },
  };
}

export function createPgStorage(databaseUrl: string): { usage: UsageStore; cache: ScholarCache } {
  const sql = neon(databaseUrl);
  return { usage: createPgUsageStore(sql), cache: createPgCache(sql) };
}

/** UTC calendar day, the anonymous quota window. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** First day of the UTC calendar month, the signed-in quota window. */
export function utcMonthStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}
