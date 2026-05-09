import "dotenv/config";

import { backfillClaudeEnterpriseCostAndUsage } from "../src/server/claude-enterprise-sync";
import {
  CLAUDE_ANALYTICS_DATA_FLOOR,
  getClaudeAnalyticsMaxDate,
} from "../src/server/claude-sync-config";

/**
 * Backfill Claude Enterprise cost + per-user usage facts for an explicit
 * date range. Useful when:
 *   - The cost endpoints went live after some historical date and
 *     `getIncrementalStart` won't re-pull pre-watermark days.
 *   - You change `CLAUDE_ANALYTICS_LAG_DAYS` and want to fill the
 *     freshly-available days.
 *
 * Usage:
 *   npm run backfill:claude-cost -- 2026-04-15 2026-05-08
 *   npm run backfill:claude-cost -- 2026-04-15            # end defaults to most recent queryable date
 *   npm run backfill:claude-cost                          # start = data floor, end = most recent queryable
 *
 * Does NOT advance the connector watermark, so the next regular sync run
 * picks up where it left off.
 */
async function main() {
  const argv = process.argv.slice(2);
  const startDate = argv[0] ?? CLAUDE_ANALYTICS_DATA_FLOOR;
  const endDate = argv[1] ?? getClaudeAnalyticsMaxDate();

  console.log(`Claude Enterprise cost backfill`);
  console.log(`  start: ${startDate}`);
  console.log(`  end:   ${endDate}`);
  console.log();

  const t0 = Date.now();
  const result = await backfillClaudeEnterpriseCostAndUsage(startDate, endDate);
  const elapsedMs = Date.now() - t0;

  console.log(JSON.stringify(result, null, 2));
  console.log(`\nElapsed: ${(elapsedMs / 1000).toFixed(1)}s`);

  if (result.errors.length > 0) {
    console.error(`\nCompleted with ${result.errors.length} error(s).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
