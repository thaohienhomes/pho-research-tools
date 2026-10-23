/**
 * What every tool handler receives, plus the shared run/quota/result helpers.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HttpClient } from '@pho/scholar-core';
import { runInBackground, type Analytics, type EventProps, type ResultStatus } from './analytics';
import type { Caller } from './caller';
import type { Config } from './config';
import { utcDay, utcMonthStart, type Grant, type QuotaMetric, type QuotaPlan, type UsageStore } from './storage';

export interface ToolContext {
  config: Config;
  http: HttpClient;
  usage: UsageStore;
  analytics: Analytics;
  caller: Caller;
  /** Origin used in links this server hands out (PRISMA images, the sign-in URL). */
  baseUrl: string;
  now?: () => Date;
}

export interface QuotaInfo {
  plan: QuotaPlan;
  metric: QuotaMetric;
  used: number;
  limit: number;
  resets: string;
  /** Set once 80% of the allowance is used: the next step up, in one sentence the model can pass on. */
  upgrade?: string;
  /** Why `upgrade` is set: the allowance is running low, or this is an anonymous caller's first call of the day. */
  hint?: 'low' | 'intro';
}

/** Share of the allowance after which the quota line names the next step up, before the user hits the wall. */
export const UPGRADE_HINT_AT = 0.8;

function nextUtcMidnight(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

function nextUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export function planFor(ctx: ToolContext): QuotaPlan {
  if (ctx.caller.auth !== 'user') return 'anon';
  return ctx.caller.paid ? 'pro' : 'free';
}

export function limitFor(ctx: ToolContext, metric: QuotaMetric): number {
  const q = ctx.config.quota;
  const plan = planFor(ctx);
  if (plan === 'pro') return metric === 'verifications' ? q.proVerificationsPerMonth : q.proCallsPerMonth;
  if (plan === 'free') return metric === 'verifications' ? q.userVerificationsPerMonth : q.userCallsPerMonth;
  return metric === 'verifications' ? q.anonVerificationsPerDay : q.anonCallsPerDay;
}

/** The URL a client connects to in order to sign in, when sign-in is configured. */
export function signInUrl(ctx: ToolContext): string | undefined {
  return ctx.config.oauthIssuer ? `${ctx.baseUrl}/mcp/login` : undefined;
}

export async function takeQuota(
  ctx: ToolContext,
  metric: QuotaMetric,
  units: number,
): Promise<Grant & { info: QuotaInfo }> {
  const now = ctx.now?.() ?? new Date();
  const plan = planFor(ctx);
  const limit = limitFor(ctx, metric);
  const monthly = plan !== 'anon';
  let grant: Grant;
  try {
    grant = await ctx.usage.take(ctx.caller.subject, metric, units, limit, monthly ? utcMonthStart(now) : utcDay(now), plan);
  } catch (err) {
    // Fail open: a database hiccup should not take the tools down. The
    // external APIs' own rate limits still bound what one caller can do.
    console.error('[mcp] quota store failed, granting request', err);
    grant = { granted: units, used: units, limit };
  }
  const resets = monthly ? nextUtcMonth(now) : nextUtcMidnight(now);
  const info: QuotaInfo = { plan, metric, used: grant.used, limit, resets };
  const low =
    grant.used >= limit * UPGRADE_HINT_AT ||
    (plan === 'anon' && metric === 'verifications' && limit - grant.used <= LOW_ALLOWANCE_HINT_AT);
  if (low) {
    const upgrade = upgradeHint(ctx, info);
    return { ...grant, info: upgrade ? { ...info, upgrade, hint: 'low' } : info };
  }
  // Anonymous callers rarely get near the daily cap, so the running-low hint
  // alone meant almost nobody heard that a free account exists. Say it once a
  // day, on the first call, and stay quiet until the allowance runs low.
  if (plan === 'anon' && grant.used === grant.granted && grant.granted > 0) {
    const upgrade = signInHint(ctx, 'sign-in-intro');
    if (upgrade) return { ...grant, info: { ...info, upgrade, hint: 'intro' } };
  }
  return { ...grant, info };
}

/**
 * The next allowance up, said while the user still has some left: anonymous
 * users are told how to sign in for the free account, free accounts what Pro gives.
 * Pro has nothing above it, so it gets no hint.
 */
export function upgradeHint(ctx: ToolContext, info: QuotaInfo): string | undefined {
  const q = ctx.config.quota;
  const what = info.metric === 'verifications' ? 'reference checks' : 'tool calls';
  if (info.plan === 'free') {
    const proLimit = info.metric === 'verifications' ? q.proVerificationsPerMonth : q.proCallsPerMonth;
    return `Phở Pro or Founder Lifetime includes ${proLimit} ${what} a month: ${tracked(ctx.config.upgradeUrl, 'running-low')}.`;
  }
  if (info.plan === 'anon') return signInHint(ctx) || undefined;
  return undefined;
}

/**
 * Tags a pricing link with where it was shown, so PostHog can tell a visit
 * sent by a running-low hint from one sent by a hard stop. Malformed URLs
 * (a bad UPGRADE_URL override) pass through untouched.
 */
export function tracked(url: string, campaign: 'running-low' | 'limit-reached' | 'sign-in' | 'sign-in-intro'): string {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', 'research-tools');
    u.searchParams.set('utm_medium', 'mcp');
    u.searchParams.set('utm_campaign', campaign);
    return u.toString();
  } catch {
    return url;
  }
}

/** When an anonymous caller has this many reference checks or fewer left, results say how to get more. */
export const LOW_ALLOWANCE_HINT_AT = 5;

/**
 * How to move from the anonymous allowance to an account, written for the
 * model to pass on. A client only offers sign-in when a connector is added,
 * never mid-chat, so the user has to add the sign-in address as a second
 * connector; the guide page walks through that for each client.
 */
export function signInHint(ctx: ToolContext, campaign: 'sign-in' | 'sign-in-intro' = 'sign-in'): string {
  const login = signInUrl(ctx);
  if (!login) return '';
  return (
    `To get ${ctx.config.quota.userVerificationsPerMonth} reference checks a month, tell the user they can sign in with a free Phở account: ` +
    `add this server again as a new connector with the address ${login}, sign in when asked, then turn the old connector off. ` +
    `Step-by-step guide: ${tracked(ctx.config.signInGuideUrl, campaign)}`
  );
}

/** One line the model can read back to the user: who the allowance belongs to, how much is left, when it resets. */
export function quotaLine(info: QuotaInfo): string {
  const line = allowanceLine(info);
  if (!info.upgrade) return line;
  return info.hint === 'intro' ? `${line} Tip: ${info.upgrade}` : `${line} Running low. ${info.upgrade}`;
}

function allowanceLine(info: QuotaInfo): string {
  const what = info.metric === 'verifications' ? 'reference checks' : 'tool calls';
  const left = Math.max(0, info.limit - info.used);
  if (info.plan === 'pro') return `Phở Pro allowance: ${info.used}/${info.limit} ${what} used this month, ${left} left; resets ${info.resets}.`;
  if (info.plan === 'free') {
    return `Phở account allowance: ${info.used}/${info.limit} ${what} used this month, ${left} left; resets ${info.resets}.`;
  }
  return `Anonymous allowance: ${info.used}/${info.limit} ${what} used today, ${left} left; resets ${info.resets}.`;
}

export function quotaExceededText(ctx: ToolContext, info: QuotaInfo): string {
  const q = ctx.config.quota;
  const what = info.metric === 'verifications' ? 'reference checks' : 'tool calls';
  const proLimit = info.metric === 'verifications' ? q.proVerificationsPerMonth : q.proCallsPerMonth;
  const freeLimit = info.metric === 'verifications' ? q.userVerificationsPerMonth : q.userCallsPerMonth;
  // What a paid plan buys, in the unit the caller just ran out of. Prices are
  // left to the pricing page: they change (Founder Lifetime is being repriced)
  // and a stale number here would be a broken promise in someone's chat.
  const pro =
    `Phở Pro or Founder Lifetime includes ${proLimit} ${what} a month: ${tracked(ctx.config.upgradeUrl, 'limit-reached')}. ` +
    'After upgrading, keep using the same signed-in connection.';
  if (info.plan === 'pro') {
    return (
      `This Phở Pro account has used its monthly allowance of ${info.limit} ${what}. ` +
      `It resets at ${info.resets} (start of the next UTC month). For more, write to support@pho.chat.`
    );
  }
  if (info.plan === 'free') {
    return (
      `This free Phở account has used its monthly allowance of ${info.limit} ${what}. ` +
      `It resets at ${info.resets} (start of the next UTC month). ${pro}`
    );
  }
  const login = signInUrl(ctx);
  const signIn = login
    ? `For ${freeLimit} ${what} a month at no cost, sign in with a free Phở account: ` +
      `add this server again as a new connector with the address ${login}, sign in when asked, then turn the old connector off. ` +
      `Step-by-step guide: ${tracked(ctx.config.signInGuideUrl, 'sign-in')}. `
    : '';
  return (
    `The free daily allowance of ${info.limit} ${what} for anonymous use is used up. ` +
    `It resets at ${info.resets} (UTC midnight). ` +
    signIn +
    pro
  );
}

export function errorResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/**
 * Time a tool call, record one analytics event, and turn unexpected errors
 * into a tool error the model can read instead of a protocol failure.
 */
export async function runTool(
  ctx: ToolContext,
  toolName: string,
  fn: (track: (props: { result_status: ResultStatus } & EventProps) => void) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = Date.now();
  let status: ResultStatus = 'ok';
  let props: EventProps = {};
  let result: CallToolResult;
  try {
    const calls = await takeQuota(ctx, 'calls', 1);
    if (calls.granted < 1) {
      status = 'quota_exceeded';
      props = { quota_metric: 'calls' };
      result = errorResult(quotaExceededText(ctx, calls.info), { error: 'quota_exceeded', quota: calls.info });
    } else {
      result = await fn(({ result_status, ...rest }) => {
        status = result_status;
        props = rest;
      });
    }
  } catch (err) {
    console.error(`[mcp] ${toolName} failed`, err);
    status = 'error';
    result = errorResult('The tool hit an unexpected error and returned no result. Please try again shortly.');
  }
  // Off the response path: a slow analytics host must not delay the answer.
  runInBackground(ctx.analytics.track(ctx.caller, { tool_name: toolName, result_status: status, latency_ms: Date.now() - started, props }));
  return result;
}
