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
}

function nextUtcMidnight(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

function nextUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export function planFor(ctx: ToolContext): QuotaPlan {
  return ctx.caller.auth === 'user' ? 'free' : 'anon';
}

export function limitFor(ctx: ToolContext, metric: QuotaMetric): number {
  const q = ctx.config.quota;
  if (planFor(ctx) === 'free') return metric === 'verifications' ? q.userVerificationsPerMonth : q.userCallsPerMonth;
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
  const monthly = plan === 'free';
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
  return { ...grant, info: { plan, metric, used: grant.used, limit, resets } };
}

/** One line the model can read back to the user: who the allowance belongs to, how much is left, when it resets. */
export function quotaLine(info: QuotaInfo): string {
  const what = info.metric === 'verifications' ? 'reference checks' : 'tool calls';
  const left = Math.max(0, info.limit - info.used);
  return info.plan === 'free'
    ? `Phở account allowance: ${info.used}/${info.limit} ${what} used this month, ${left} left; resets ${info.resets}.`
    : `Anonymous allowance: ${info.used}/${info.limit} ${what} used today, ${left} left; resets ${info.resets}.`;
}

export function quotaExceededText(ctx: ToolContext, info: QuotaInfo): string {
  const what = info.metric === 'verifications' ? 'reference checks' : 'tool calls';
  if (info.plan === 'free') {
    return (
      `This Phở account has used its free monthly allowance of ${info.limit} ${what}. ` +
      `It resets at ${info.resets} (start of the next UTC month). Plans with more are at ${ctx.config.upgradeUrl}.`
    );
  }
  const login = signInUrl(ctx);
  const signIn = login
    ? `For ${ctx.config.quota.userVerificationsPerMonth} reference checks a month, sign in with a free Phở account: ` +
      `add this server again using the URL ${login} and sign in when asked. `
    : '';
  return (
    `The free daily allowance of ${info.limit} ${what} for anonymous use is used up. ` +
    `It resets at ${info.resets} (UTC midnight). ` +
    signIn +
    `Plans are at ${ctx.config.upgradeUrl}.`
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
