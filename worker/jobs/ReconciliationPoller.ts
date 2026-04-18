import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { SyncReviewsPayload } from '../../src/lib/shared/worker-types';

const DEFAULT_INTERVAL_MS = 3_600_000; // 60 minutes

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const envVal = process.env.RECONCILIATION_INTERVAL_MS;
  if (!envVal) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function pollBusinesses(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    if (isMockMode()) {
      console.log('[ReconciliationPoller] Mock mode — skipping');
      return;
    }

    // Find active businesses that are candidates for sync.
    const candidates = await sql<{ id: string; google_place_id: string }[]>`
      SELECT b.id, b.google_place_id
      FROM businesses b
      WHERE b.subscription_status = 'active'
        AND b.google_place_id IS NOT NULL
        AND b.place_id_verified = TRUE
        AND (b.last_sync_at IS NULL OR b.last_sync_at < NOW() - INTERVAL '60 minutes')
    `;

    if (candidates.length === 0) return;

    // Insert outbox entries one per transaction with an atomic dedup
    // guard inside each. This prevents concurrent pollers from creating
    // duplicate sync_reviews jobs for the same business.
    let queued = 0;
    for (const biz of candidates) {
      const payload: SyncReviewsPayload = {
        business_id: biz.id,
        google_place_id: biz.google_place_id,
        correlation_id: uuidv7(),
      };

      try {
        const inserted = await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          SELECT
            ${uuidv7()},
            'sync_reviews',
            'business',
            ${biz.id},
            ${jsonb(payload)},
            'pending'
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo
            WHERE jo.topic = 'sync_reviews'
              AND jo.aggregate_id = ${biz.id}
              AND jo.status IN ('pending', 'dispatching', 'dispatched')
          )
        `;

        if (inserted.count > 0) queued++;
      } catch (err: unknown) {
        // idx_jo_sync_reviews_inflight unique violation — another poller
        // already inserted for this business. Safe to skip.
        const code = (err as { code?: string }).code;
        if (code === '23505') continue;
        throw err;
      }
    }

    if (queued > 0) {
      console.log(
        `[ReconciliationPoller] Queued ${queued} sync_reviews outbox entries (${candidates.length} candidates checked)`,
      );
    }
  } catch (error) {
    console.error('[ReconciliationPoller] Poll cycle failed:', error);
  } finally {
    isPolling = false;
  }
}

export function startReconciliationPoller(): void {
  const intervalMs = getIntervalMs();
  console.log(`[ReconciliationPoller] Starting (interval=${intervalMs}ms)`);
  // Run once immediately, then on interval
  pollBusinesses().catch(console.error);
  pollerInterval = setInterval(() => {
    pollBusinesses().catch(console.error);
  }, intervalMs);
}

export function stopReconciliationPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log('[ReconciliationPoller] Stopped');
  }
}
