/**
 * Environment for the MCP server. Every value has a safe default so the server
 * runs locally with no configuration at all (in-memory quota and cache, no
 * analytics); production sets DATABASE_URL, POSTHOG_API_KEY and a contact email.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(0));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z.object({
  PORT: int(8787),
  /** Public origin of this server, used to build PRISMA image links. */
  PUBLIC_URL: optionalString,
  /** Postgres (Neon) for rt_usage / rt_cache. Unset = in-memory (single process only). */
  DATABASE_URL: optionalString,
  /** Contact for the Crossref / NCBI / OpenAlex polite pools. */
  SCHOLAR_CONTACT_EMAIL: optionalString,
  PUBMED_API_KEY: optionalString,
  OPENALEX_API_KEY: optionalString,
  POSTHOG_API_KEY: optionalString,
  POSTHOG_HOST: optionalString,
  /** Salt for hashing IP + client into the anonymous quota subject. */
  QUOTA_SALT: optionalString,
  /** References checked per day by an anonymous caller (verify, format, retraction checks). */
  QUOTA_ANON_VERIFICATIONS_PER_DAY: int(30),
  /** Tool calls of any kind per day by an anonymous caller. */
  QUOTA_ANON_CALLS_PER_DAY: int(200),
  /**
   * OAuth authorization server for optional sign-in (Phở's Clerk, e.g.
   * https://clerk.pho.chat). Unset = sign-in off, every caller is anonymous.
   */
  OAUTH_ISSUER: optionalString,
  /** References checked per calendar month (UTC) by a signed-in Phở account. */
  QUOTA_USER_VERIFICATIONS_PER_MONTH: int(300),
  /** Tool calls of any kind per calendar month (UTC) by a signed-in Phở account. */
  QUOTA_USER_CALLS_PER_MONTH: int(3000),
  /** Shown when a quota runs out. */
  UPGRADE_URL: optionalString,
  /** Trust X-Forwarded-For (set to 1 behind Vercel / Caddy / a load balancer). */
  TRUST_PROXY: optionalString,
  /** Set by Vercel on every deployment. */
  VERCEL: optionalString,
});

export interface Config {
  port: number;
  publicUrl?: string;
  databaseUrl?: string;
  contactEmail?: string;
  pubmedApiKey?: string;
  openalexApiKey?: string;
  posthogApiKey?: string;
  posthogHost: string;
  quotaSalt: string;
  oauthIssuer?: string;
  quota: {
    anonVerificationsPerDay: number;
    anonCallsPerDay: number;
    userVerificationsPerMonth: number;
    userCallsPerMonth: number;
  };
  upgradeUrl: string;
  trustProxy: boolean;
}

/**
 * The salt is what keeps a quota subject from being reversed into an IP
 * address: with a known salt, hashing all 2^32 IPv4 addresses takes minutes.
 * So a deployment must set its own secret one. Local runs and tests get a
 * random per-process salt, which is safe but resets allowances on restart.
 */
export const MIN_QUOTA_SALT_LENGTH = 32;

function quotaSalt(configured: string | undefined, env: Record<string, string | undefined>): string {
  if (configured) {
    // A short salt can be guessed, and with it every subject maps back to an IP.
    if (configured.length < MIN_QUOTA_SALT_LENGTH) {
      throw new Error(`QUOTA_SALT must be at least ${MIN_QUOTA_SALT_LENGTH} characters; generate one with \`openssl rand -hex 32\`.`);
    }
    return configured;
  }
  if (env.VERCEL === '1' || env.NODE_ENV === 'production') {
    throw new Error('QUOTA_SALT must be set to a long random secret in a deployed MCP server.');
  }
  return randomBytes(32).toString('hex');
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const e = EnvSchema.parse(env);
  return {
    port: e.PORT,
    publicUrl: e.PUBLIC_URL?.replace(/\/+$/, ''),
    databaseUrl: e.DATABASE_URL,
    contactEmail: e.SCHOLAR_CONTACT_EMAIL,
    pubmedApiKey: e.PUBMED_API_KEY,
    openalexApiKey: e.OPENALEX_API_KEY,
    posthogApiKey: e.POSTHOG_API_KEY,
    posthogHost: (e.POSTHOG_HOST ?? 'https://us.i.posthog.com').replace(/\/+$/, ''),
    quotaSalt: quotaSalt(e.QUOTA_SALT, env),
    oauthIssuer: e.OAUTH_ISSUER?.replace(/\/+$/, ''),
    quota: {
      anonVerificationsPerDay: e.QUOTA_ANON_VERIFICATIONS_PER_DAY,
      anonCallsPerDay: e.QUOTA_ANON_CALLS_PER_DAY,
      userVerificationsPerMonth: e.QUOTA_USER_VERIFICATIONS_PER_MONTH,
      userCallsPerMonth: e.QUOTA_USER_CALLS_PER_MONTH,
    },
    upgradeUrl: e.UPGRADE_URL ?? 'https://pho.chat/pricing',
    // Vercel's edge overwrites X-Forwarded-For with the real client address,
    // so it is trustworthy there by default. Anywhere else it must be opted in.
    trustProxy: e.TRUST_PROXY === undefined ? e.VERCEL === '1' : e.TRUST_PROXY === '1' || e.TRUST_PROXY === 'true',
  };
}
