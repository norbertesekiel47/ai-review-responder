// worker/jobs/DrainOwnerConnectWorker.ts
//
// Re-enqueues stuck `publish_response` outbox rows for a business whose
// owner just (re)connected Zernio. For each response in
// `awaiting_owner_connect` status, inserts a fresh `publish_response`
// outbox row IF AND ONLY IF no live publish_response row already exists
// for that response.
//
// Idempotency — three layers of defense:
//   1. DB partial unique index `idx_jo_publish_response_inflight`
//      (migration 026) — hard guarantee against duplicate in-flight rows.
//   2. Application-level NOT EXISTS guard — fast-path skip on the common
//      case so we don't even attempt duplicate inserts.
//   3. ResponsePublisherWorker `status='posted'` early-exit — final guard
//      if both above are bypassed.
//
// `ON CONFLICT DO NOTHING` is required even with the WHERE NOT EXISTS
// guard: an INSERT...SELECT batch racing with another DrainOwnerConnect
// run on ONE row would otherwise abort the entire batch on the unique
// index violation, leaving the other N-1 stuck responses unqueued.
//
// `gen_random_uuid()` (DB-side) is used inline rather than a JS-side
// `${uuidv7()}` parameter — the latter would be evaluated ONCE by
// Postgres.js and produce duplicate PKs across the batch.
//
// See spec §3.3 (2026-04-27-zernio-integration-design.md).

import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, extractOutboxHandle } from '../../src/lib/shared/outbox';
import type { DrainOwnerConnectPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';

export async function handleDrainOwnerConnect(
  job: Job<DrainOwnerConnectPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[DrainOwnerConnectWorker]', job.data.correlation_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const businessId = job.data.business_id;

  // Bulk re-enqueue with NOT EXISTS guard (app fast-path) + ON CONFLICT
  // DO NOTHING (DB hard guarantee). The ON CONFLICT clause MUST match
  // migration 026's `idx_jo_publish_response_inflight` partial unique
  // index expression byte-for-byte.
  const result = await sql`
    WITH stuck AS (
      SELECT id, business_id
      FROM responses
      WHERE business_id = ${businessId}
        AND status = 'awaiting_owner_connect'
    )
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
    )
    SELECT
      gen_random_uuid(),
      'publish_response',
      'response',
      stuck.id,
      jsonb_build_object('response_id', stuck.id, 'business_id', stuck.business_id),
      0, 5
    FROM stuck
    WHERE NOT EXISTS (
      SELECT 1 FROM job_outbox jo
      WHERE jo.topic = 'publish_response'
        AND jo.aggregate_id = stuck.id
        AND jo.status IN ('pending', 'dispatching', 'dispatched')
    )
    ON CONFLICT (topic, aggregate_id)
      WHERE topic = 'publish_response'
        AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;

  logger.log(
    `Drained business ${businessId}: ${result.count} new publish_response row(s) enqueued`,
  );

  await markOutboxCompleted(outboxId, outboxAttempt);
}
