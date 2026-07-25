// Success-path composition root for build_solicitation_batch. Domain SQL,
// ownership, gates, and retry behavior live in batch-builder.ts. Watch-mode
// performs no transmission or external call.

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { buildSolicitationBatch } from '@/lib/solicitation/batch-builder';
import { createWorkerLogger } from '@/lib/shared/logger';
import { extractOutboxHandle } from '@/lib/shared/outbox';
import type { BuildSolicitationBatchPayload } from '@/lib/shared/worker-types';

export async function handleSolicitationBatch(
  sql: Sql,
  job: Job<BuildSolicitationBatchPayload>,
): Promise<void> {
  const logger = createWorkerLogger(
    '[SolicitationBatchWorker]',
    job.data.correlation_id,
  );
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
  if (attempt === undefined) {
    throw new Error('build_solicitation_batch requires an exact outbox_attempt');
  }
  const result = await buildSolicitationBatch(sql, {
    batchId: job.data.batch_id,
    businessId: job.data.business_id,
    outboxId,
    attempt,
    correlationId: job.data.correlation_id,
  });

  if (result.status === 'built') {
    logger.log('solicitation batch build finished', {
      status: result.status,
      candidate_count: result.candidateCount,
      send_count: result.sendCount,
      withhold_count: result.withholdCount,
      withheld_by_reason: result.withheldByReason,
    });
    return;
  }

  logger.log('solicitation batch build finished', result.status === 'gate_closed'
    ? {
        status: result.status,
        reason: result.reason,
        parent_terminalized: result.parentTerminalized,
      }
    : { status: result.status });
}
