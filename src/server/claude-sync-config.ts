const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Earliest queryable date for the Claude Enterprise Analytics API.
 * The API returns 400 for dates before this floor.
 */
export const CLAUDE_ANALYTICS_DATA_FLOOR = "2026-01-01";

/**
 * Data availability lag for the Analytics API (days). The most recent
 * queryable date is `today - CLAUDE_ANALYTICS_LAG_DAYS`.
 *
 * Empirical: Anthropic publishes the cost endpoints within ~24 hours.
 * The probe at `/api/sync/claude-enterprise/probe` reports
 * `data_refreshed_at` for the queried window; recent observations show
 * the most recent UTC day finalizing within ~5 hours of midnight UTC.
 *
 * We keep this at 1 (not 0) because the most recent UTC day is still
 * mid-revision while it's in progress. Staying one day back trades
 * ~24 hours of freshness for stable, non-revising figures.
 */
export const CLAUDE_ANALYTICS_LAG_DAYS = 1;

/**
 * Returns the Unix-ms timestamp for the start of the Claude Analytics API lookback.
 * Capped at 90 days (the API only retains 90 days of history). Never earlier than
 * CLAUDE_ANALYTICS_DATA_FLOOR.
 */
export function getClaudeAnalyticsLookbackStartMs(): number {
  const raw = process.env.CLAUDE_ANALYTICS_LOOKBACK_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 90) : 90;
  const byEnv = Date.now() - days * DAY_MS;
  const floorMs = new Date(`${CLAUDE_ANALYTICS_DATA_FLOOR}T00:00:00.000Z`).getTime();
  return Math.max(byEnv, floorMs);
}

/** Returns the most recent queryable date (YYYY-MM-DD) for the Analytics API. */
export function getClaudeAnalyticsMaxDate(now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - CLAUDE_ANALYTICS_LAG_DAYS * DAY_MS);
  return cutoff.toISOString().slice(0, 10);
}

/**
 * Enumerate YYYY-MM-DD dates in [start, end] inclusive.
 */
export function enumerateDates(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  const start = new Date(`${startIso}T00:00:00.000Z`).getTime();
  const end = new Date(`${endIso}T00:00:00.000Z`).getTime();
  for (let t = start; t <= end; t += DAY_MS) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}
