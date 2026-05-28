// scripts/posthog-backfill-activations.ts
//
// One-off CLI to backfill historical `activation_completed` events into
// PostHog for accounts that activated before the live capture path started
// emitting (live emits only for accounts created within ~8 days AND only once
// POSTHOG_API_KEY exists in prod).
//
// Each event is stamped at its real `posted_at` and keyed on uuid =
// response_id. Re-running the backfill is therefore safe: a second run emits
// the identical (uuid, timestamp) tuple, which PostHog dedupes.
//
// Overlap with the live path is NOT prevented by dedup — PostHog's dedup key
// includes `timestamp`, and the live path stamps events at send time (now)
// while this backfill stamps `posted_at`, so the same response could yield two
// events. Use `--before` (set it to when POSTHOG_API_KEY went live in prod) so
// the backfill set (`posted_at < cutoff`) and the live set stay disjoint.
//
// Cross-account by design (operator tool, like src/lib/admin/margin-service.ts).
// Lives in scripts/, which the tenant-scope audit does not scan.
//
// Usage:
//   # Dry run (default): report what WOULD be sent, send nothing.
//   pnpm tsx scripts/posthog-backfill-activations.ts
//   pnpm tsx scripts/posthog-backfill-activations.ts --before 2026-05-28T00:00:00Z
//
//   # Execute: actually send. Requires POSTHOG_API_KEY (and POSTHOG_HOST if EU).
//   pnpm tsx scripts/posthog-backfill-activations.ts --execute --before 2026-05-28T00:00:00Z
//
// Flags:
//   --execute            Actually send events. Default off (dry run).
//   --before <iso>       Only activations with posted_at < cutoff. Default: now.
//                        Set this to roughly when POSTHOG_API_KEY went live to
//                        avoid overlapping the going-forward live path.
//   --limit <n>          Cap candidates processed (accounts). Optional.
//   --account <uuid>     Restrict to a single account. Optional.
//
// Requires: DATABASE_POOL_URL (Postgres.js). --execute additionally requires
// POSTHOG_API_KEY.

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { buildActivationCompletedEvent } from '../src/lib/analytics/activation-event';
import {
  captureAnalyticsEvent,
  isAnalyticsConfigured,
  shutdownAnalytics,
} from '../src/lib/analytics/posthog';

interface CandidateRow {
  account_id: string;
  account_created_at: Date | string;
  response_id: string;
  business_id: string;
  review_id: string;
  posted_at: Date | string;
}

function parseCutoff(before: string | undefined): Date {
  if (before === undefined) {
    return new Date();
  }
  const cutoff = new Date(before);
  if (Number.isNaN(cutoff.getTime())) {
    console.error(`Invalid --before value: "${before}". Use an ISO timestamp, e.g. 2026-05-28T00:00:00Z.`);
    process.exit(1);
  }
  return cutoff;
}

function parseLimit(limit: string | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`Invalid --limit value: "${limit}". Use a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      before: { type: 'string' },
      limit: { type: 'string' },
      account: { type: 'string' },
    },
  });

  const execute = values.execute === true;
  const cutoff = parseCutoff(values.before);
  const limit = parseLimit(values.limit);
  const accountId = values.account;

  // No silent success: refuse to --execute when nothing could possibly send.
  if (execute && !isAnalyticsConfigured()) {
    console.error('Refusing to --execute: POSTHOG_API_KEY is unset, so every capture would be a no-op.');
    console.error('Set POSTHOG_API_KEY (and POSTHOG_HOST if EU) before running with --execute.');
    process.exit(1);
  }

  if (!process.env.DATABASE_POOL_URL) {
    console.error('DATABASE_POOL_URL is not set — cannot query for activation candidates.');
    process.exit(1);
  }

  console.log(
    `[posthog-backfill] mode=${execute ? 'EXECUTE' : 'DRY-RUN'} cutoff=${cutoff.toISOString()}` +
      `${limit ? ` limit=${limit}` : ''}${accountId ? ` account=${accountId}` : ''}`,
  );

  // Lazy import: arg validation and the key guard run before we touch the DB
  // module. src/lib/db/server initializes Supabase client at module load time,
  // so importing it at the top of the file would throw before main() runs when
  // SUPABASE_URL/SUPABASE_SERVICE_KEY are unset (e.g. during smoke tests).
  const { sql } = await import('../src/lib/db/server');

  const accountFilter = accountId ? sql`AND a.id = ${accountId}::uuid` : sql``;
  const limitClause = limit ? sql`LIMIT ${limit}` : sql``;

  const rows = await sql<CandidateRow[]>`
    SELECT DISTINCT ON (a.id)
      a.id          AS account_id,
      a.created_at  AS account_created_at,
      r.id          AS response_id,
      r.business_id AS business_id,
      r.review_id   AS review_id,
      r.posted_at   AS posted_at
    FROM responses r
    JOIN businesses b ON b.id = r.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE r.status = 'posted'
      AND r.posted_at IS NOT NULL
      AND r.posted_at < ${cutoff}
      ${accountFilter}
    ORDER BY a.id, r.posted_at ASC, r.id ASC
    ${limitClause}
  `;

  let eligible = 0;
  let skipped = 0;
  let sent = 0;
  let failed = 0;
  const samples: string[] = [];

  for (const row of rows) {
    const event = buildActivationCompletedEvent({
      accountId: row.account_id,
      accountCreatedAt: row.account_created_at,
      responseId: row.response_id,
      businessId: row.business_id,
      reviewId: row.review_id,
      postedAt: row.posted_at,
    });

    if (!event) {
      skipped++;
      continue;
    }
    eligible++;
    if (samples.length < 10) {
      samples.push(
        `account=${row.account_id} response=${row.response_id} days=${event.properties?.days_to_activation}`,
      );
    }

    if (!execute) {
      continue;
    }

    try {
      const ok = captureAnalyticsEvent({ ...event, timestamp: new Date(row.posted_at) });
      if (ok) {
        sent++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.error(
        `[posthog-backfill] capture failed for response=${row.response_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (execute) {
    // posthog-node batches in memory; flush before the process exits.
    await shutdownAnalytics();
  }

  console.log(
    `[posthog-backfill] candidates=${rows.length} eligible=${eligible} skipped=${skipped}` +
      `${execute ? ` sent=${sent} failed=${failed}` : ''}`,
  );
  if (samples.length > 0) {
    console.log(`[posthog-backfill] sample (first ${samples.length}):`);
    for (const line of samples) {
      console.log(`  ${line}`);
    }
  }
  if (!execute) {
    console.log(
      `[posthog-backfill] dry run — nothing sent. Re-run with --execute to send ${eligible} event(s).` +
        `${limit ? ` (limited to first ${limit} accounts — remove --limit for the full count)` : ''}`,
    );
  }

  // Postgres.js connections persist; force exit so the script terminates.
  process.exit(0);
}

main().catch((err) => {
  console.error('[posthog-backfill] fatal:', err);
  process.exit(1);
});
