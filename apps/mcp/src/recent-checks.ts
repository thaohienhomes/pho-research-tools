/**
 * Retraction results a caller asked for in the last hour, kept in memory so an
 * assistant that re-checks the same DOIs (common when it re-reads a list) does
 * not spend the caller's allowance or Crossref's goodwill twice.
 *
 * Best effort: the memo lives in one server instance, so a repeat that lands on
 * another instance is checked and charged as before. Nothing here is written
 * to storage, and it holds only DOIs and their public notice status.
 */

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

export class RecentChecks<T> {
  private readonly map = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly ttlMs = TTL_MS,
    private readonly max = MAX_ENTRIES,
  ) {}

  get(subject: string, key: string, now: number): T | undefined {
    const k = `${subject}\u0000${key}`;
    const hit = this.map.get(k);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    return hit.value;
  }

  set(subject: string, key: string, value: T, now: number): void {
    const k = `${subject}\u0000${key}`;
    this.map.delete(k);
    this.map.set(k, { at: now, value });
    // Map keeps insertion order: the first key is the oldest.
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}
