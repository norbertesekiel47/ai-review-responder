// Composition root for the csv_ingest queue: subscription gate + delegate to
// the ingest module (src/lib/solicitation/ingest.ts owns all match/merge/upsert
// behavior). Invariant #11 gate: the SAME writable-subscription predicate the
// upload route applies (requireWritableOwner → assertWritableSubscriptionForAccount),
// so the worker can never permanently refuse an upload the route admitted —
// past_due inside the 7-day grace window still processes. An account that
// stops passing the predicate mid-flight (cancelled / pending_payment /
// expired grace / blocking offboarding) gets its upload TERMINALIZED
// (status='failed', 'subscription_inactive' report, raw_csv NULLed) — never
// stranded 'pending' with the raw CSV retained.
// PII contract: log counts/ids only — never names, handles, notes, or raw CSV.

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import {
  ingestContactsCsvUpload,
  terminalizeUploadForInactiveSubscription,
} from '@/lib/solicitation/ingest';
import { createWorkerLogger } from '@/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompleted } from '@/lib/shared/outbox';
import { assertWritableSubscriptionForAccount } from '@/lib/shared/writable-subscription';
import type { CsvIngestPayload } from '@/lib/shared/worker-types';

export async function handleCsvIngest(
  sql: Sql,
  job: Job<CsvIngestPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[CsvIngestWorker]', job.data.correlation_id);
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
  const { upload_id: uploadId, business_id: businessId } = job.data;

  // The gate is derived FROM THE UPLOAD ROW, not the raw payload — the upload
  // row's business → account join is the authoritative pairing. The payload's
  // business_id is BOUND into the read (u.business_id AND b.id) so the query
  // is tenant-scoped by construction, mirroring ingestContactsCsvUpload's
  // expectedBusinessId assert: a payload/row pairing mismatch yields no row.
  const [gate] = await sql<{ account_id: string }[]>`
    SELECT a.id AS account_id
    FROM contact_csv_uploads u
    JOIN businesses b ON b.id = u.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE u.id = ${uploadId}
      AND u.business_id = ${businessId}
      AND b.id = ${businessId}
  `;
  if (!gate) {
    // Upload/business deleted mid-flight (offboarding CASCADE) — or the
    // payload's business_id does not match the upload row's pairing. Either
    // way there is no entitled work to do for this payload.
    logger.warn('csv_ingest upload row missing or not paired to payload business — skipping', {
      upload_id: uploadId,
    });
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }

  const writable = await assertWritableSubscriptionForAccount(gate.account_id, sql);
  if (!writable.ok) {
    // Route/worker entitlement now agrees by construction (same predicate);
    // this branch is only reachable via a mid-flight status transition, and
    // it must bound the raw CSV's lifetime rather than skip (see header).
    logger.log('csv_ingest terminalizing: subscription not writable', {
      upload_id: uploadId,
      reason: writable.error,
    });
    await terminalizeUploadForInactiveSubscription(sql, uploadId, businessId);
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }

  await ingestContactsCsvUpload(sql, uploadId, businessId);
  await markOutboxCompleted(sql, outboxId, attempt);
}
