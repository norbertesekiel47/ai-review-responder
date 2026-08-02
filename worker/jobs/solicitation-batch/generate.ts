// Success-path composition root for generate_solicitation_asks (#628). All
// domain behavior — flag/subscription gates, the worker-enforced regen budget,
// the per-child LLM pipeline, and outbox completion — lives in
// src/lib/solicitation/ask-generation.ts. The domain completes the owned
// outbox attempt on EVERY non-transient path (finale tx / no-op / refusal —
// decision 9, batch-builder precedent), so this handler never touches the
// outbox row; transient errors (TransientLLMError, CostInfraUnavailableError)
// rethrow from the domain and propagate here for BullMQ retry.

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import {
  generateAsksForBatch,
  regenerateAsk,
} from '@/lib/solicitation/ask-generation';
import { extractOutboxHandle } from '@/lib/shared/outbox';
import type { GenerateSolicitationAsksPayload } from '@/lib/shared/worker-types';

export async function handleGenerateSolicitationAsks(
  sql: Sql,
  job: Job<GenerateSolicitationAsksPayload>,
): Promise<void> {
  const outboxHandle = extractOutboxHandle(job.data, job.id!);

  if (job.data.ask_id !== undefined) {
    await regenerateAsk(sql, {
      batchId: job.data.batch_id,
      businessId: job.data.business_id,
      askId: job.data.ask_id,
      outboxHandle,
      correlationId: job.data.correlation_id,
    });
    return;
  }

  await generateAsksForBatch(sql, {
    batchId: job.data.batch_id,
    businessId: job.data.business_id,
    outboxHandle,
    correlationId: job.data.correlation_id,
  });
}
