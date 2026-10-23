/**
 * One PostHog event per tool call: `rt_tool_call`.
 *
 * Properties are counts and labels only. Never reference text, queries, DOIs
 * or anything a user typed: the brief rules out reference text and PII, and a
 * search query can be both.
 */

import type { Caller } from './caller';

export type ResultStatus =
  | 'ok'
  | 'partial'
  | 'quota_exceeded'
  /** An anonymous caller out of allowance was sent to sign in on the same connector (HTTP 401). */
  | 'sign_in_requested'
  | 'invalid_input'
  | 'upstream_unavailable'
  | 'error';

/** Tool-specific counts and labels: references, results, warnings. Numbers and enums only. */
export type EventProps = Record<string, string | number | boolean | undefined>;

export interface ToolEvent {
  tool_name: string;
  result_status: ResultStatus;
  latency_ms: number;
  props?: EventProps;
}

/** Events from the public brief page: `rt_brief_viewed`, `rt_brief_citation_copied`… */
export interface PageEvent {
  name: string;
  props?: EventProps;
}

export interface Analytics {
  track(caller: Caller, event: ToolEvent): Promise<void>;
  /** An event with no caller (a public page view). Counted without a person profile. */
  page(event: PageEvent): Promise<void>;
}

export const noopAnalytics: Analytics = { async track() {}, async page() {} };

/**
 * Let `work` finish after the response is sent. On Vercel the function would
 * otherwise be frozen as soon as it responds, so the promise is handed to the
 * platform's waitUntil (the same hook @vercel/functions uses). Elsewhere the
 * process keeps running and the promise simply completes on its own.
 */
export function runInBackground(work: Promise<unknown>): void {
  const settled = work.catch(() => {});
  const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[
    Symbol.for('@vercel/request-context')
  ]?.get?.();
  ctx?.waitUntil?.(settled);
}

export function createPosthogAnalytics(apiKey: string, host: string, fetchImpl: typeof fetch = fetch): Analytics {
  return {
    async track(caller, event) {
      try {
        await fetchImpl(`${host}/capture/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            event: 'rt_tool_call',
            // The hashed subject, so daily actives can be counted without a person profile.
            distinct_id: `rt_${caller.subject}`,
            properties: {
              ...event.props,
              tool_name: event.tool_name,
              result_status: event.result_status,
              latency_ms: event.latency_ms,
              client: caller.client,
              auth: caller.auth,
              plan: caller.auth === 'user' ? (caller.paid ? 'pro' : 'free') : 'anon',
              surface: 'mcp',
              $process_person_profile: false,
            },
          }),
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        // Analytics never breaks a tool call.
      }
    },
    async page(event) {
      try {
        await fetchImpl(`${host}/capture/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            event: event.name,
            distinct_id: 'rt_brief_page',
            properties: { ...event.props, surface: 'brief_page', $process_person_profile: false },
          }),
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        // Analytics never breaks a page.
      }
    },
  };
}

/** In-memory sink for tests. */
export function createRecordingAnalytics(): Analytics & { events: (ToolEvent & { client: string })[]; pages: PageEvent[] } {
  const events: (ToolEvent & { client: string })[] = [];
  const pages: PageEvent[] = [];
  return {
    events,
    pages,
    async track(caller, event) {
      events.push({ ...event, client: caller.client });
    },
    async page(event) {
      pages.push(event);
    },
  };
}
