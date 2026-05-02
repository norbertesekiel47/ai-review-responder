// scripts/zernio-backfill-external-replies.ts
//
// One-off CLI to retroactively ingest already-replied Google reviews for a
// specific business. Useful for VIPs onboarded before the Edit Existing
// Replies feature shipped — they have no `external_reply_ingested_at` data,
// so the dashboard's Past Replies tab is empty for them until either (a) a
// review.updated webhook fires (opportunistic backfill via the ingest worker)
// or (b) this script runs (manual / on-demand).
//
// Idempotent — re-running on the same business produces zero new rows after
// the first successful run, thanks to the ON CONFLICT clauses inside
// reconcileExternallyAnsweredReview's helpers.
//
// Usage:
//   pnpm tsx scripts/zernio-backfill-external-replies.ts <business-id>
//
// Requires:
//   EDIT_EXISTING_REPLIES_ENABLED=true (else the helpers no-op).
//   ZERNIO_API_KEY set (or MOCK_EXTERNAL_APIS=true for local smoke tests).
//   Active zernio_connections row for the business.

import 'dotenv/config';
import { sql } from '../src/lib/db/server';
import { zernioClient } from '../src/lib/zernio/client';
import { reconcileExternallyAnsweredReview } from '../worker/jobs/zernio-ingest-shared';
import { createWorkerLogger } from '../src/lib/shared/logger';

async function main(): Promise<void> {
  const businessId = process.argv[2];
  if (!businessId) {
    console.error('Usage: pnpm tsx scripts/zernio-backfill-external-replies.ts <business-id>');
    process.exit(1);
  }

  if (process.env.EDIT_EXISTING_REPLIES_ENABLED !== 'true') {
    console.error(
      'EDIT_EXISTING_REPLIES_ENABLED must be set to "true" before running this script.',
    );
    console.error('Without it, reconcileExternallyAnsweredReview falls back to today\'s silent-no-op behavior.');
    process.exit(1);
  }

  const [conn] = await sql<{
    zernio_account_id: string;
    zernio_location_id: string;
  }[]>`
    SELECT zernio_account_id, zernio_location_id
    FROM zernio_connections
    WHERE business_id = ${businessId} AND status = 'active'
    LIMIT 1
  `;
  if (!conn) {
    console.error(`No active Zernio connection found for business ${businessId}.`);
    process.exit(1);
  }

  const logger = createWorkerLogger('[backfill-external-replies]');
  console.log(
    `Walking Zernio for business=${businessId} account=${conn.zernio_account_id} location=${conn.zernio_location_id} (max 20 pages of 50)…`,
  );

  const reviews = await zernioClient.listAllReviews(conn.zernio_account_id, {
    locationId: conn.zernio_location_id,
    pageSize: 50,
    maxPages: 20,
  });
  const answered = reviews.filter((r) => r.reviewReply !== null);
  console.log(`Total reviews seen: ${reviews.length}. Already-answered: ${answered.length}.`);

  let success = 0;
  let failure = 0;
  for (const r of answered) {
    try {
      await reconcileExternallyAnsweredReview(
        r,
        businessId,
        conn.zernio_account_id,
        conn.zernio_location_id,
        logger,
      );
      success++;
    } catch (err) {
      failure++;
      console.error(`Failed for review ${r.id}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Done. ${success}/${answered.length} processed; ${failure} failed.`);

  // Postgres.js connections persist; force exit so the script terminates.
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
