// Composition root for the csv_ingest queue: subscription gate + delegate to
// the ingest module (src/lib/solicitation/ingest.ts owns all match/merge/upsert
// behavior). Invariant #11: gate on subscriptionGrantsFullAccess —
// pending_payment / cancelled accounts get no ingest work (their upload stays
// pending until resubscription re-upload; watch-mode sends nothing either way).
// PII contract: log counts/ids only — never names, handles, notes, or raw CSV.

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { ingestContactsCsvUpload } from '@/lib/solicitation/ingest';
import { createWorkerLogger } from '@/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompleted } from '@/lib/shared/outbox';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import type { CsvIngestPayload } from '@/lib/shared/worker-types';

export async function handleCsvIngest(
  sql: Sql,
  job: Job<CsvIngestPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[CsvIngestWorker]', job.data.correlation_id);
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  // The gate is derived FROM THE UPLOAD ROW, not the raw payload — the upload
  // row's business → account join is the authoritative pairing. The payload's
  // businessId is BOUND into the read (u.business_id AND b.id) so the query is
  // tenant-scoped by construction, mirroring ingestContactsCsvUpload's
  // expectedBusinessId assert: a payload/row pairing mismatch yields no row.
  const [gate] = await sql<{ subscription_status: string }[]>`
    SELECT a.subscription_status
    FROM contact_csv_uploads u
    JOIN businesses b ON b.id = u.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE u.id = ${job.data.uploadId}
      AND u.business_id = ${job.data.businessId}
      AND b.id = ${job.data.businessId}
  `;
  if (!gate) {
    // Upload/business deleted mid-flight (offboarding CASCADE) — or the
    // payload's businessId does not match the upload row's pairing. Either
    // way there is no entitled work to do for this payload.
    logger.warn('csv_ingest upload row missing or not paired to payload business — skipping', {
      upload_id: job.data.uploadId,
    });
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }
  if (!subscriptionGrantsFullAccess(gate.subscription_status)) {
    // Invariant #11 no-op — same posture as NotificationWorker. The upload row
    // itself is deliberately untouched (stays pending).
    logger.log('csv_ingest skipped: subscription lacks full access', {
      upload_id: job.data.uploadId,
      subscription_status: gate.subscription_status,
    });
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }

  await ingestContactsCsvUpload(sql, job.data.uploadId, job.data.businessId);
  await markOutboxCompleted(sql, outboxId, attempt);
}
