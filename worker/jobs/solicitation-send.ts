// Success-path composition root for solicitation_send (#899). All domain
// behavior — the Dispatch gate, the unsubscribe token mint, the provider call
// and the terminal transaction — lives in src/lib/solicitation/dispatch.ts.
// The domain completes the owned outbox attempt on every non-transient path
// (defer / terminal tx — the ask-generation precedent), so this handler never
// touches the outbox row; retryable failures rethrow from the domain and
// propagate here for BullMQ retry.

import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { dispatchOutreach } from '@/lib/solicitation/dispatch';
import { extractOutboxHandle } from '@/lib/shared/outbox';
import type { SolicitationSendPayload } from '@/lib/shared/worker-types';

export async function handleSolicitationSend(
  sql: Sql,
  job: Job<SolicitationSendPayload>,
): Promise<void> {
  const outboxHandle = extractOutboxHandle(job.data, job.id!);

  await dispatchOutreach(sql, {
    batchId: job.data.batch_id,
    businessId: job.data.business_id,
    outreachId: job.data.outreach_id,
    outboxHandle,
    // The domain REQUIRES a correlation id — every line this lane logs has to
    // be joinable to the attempt that produced it. The outbox row id is the
    // durable identity when the producer sent no correlation_id.
    correlationId: job.data.correlation_id ?? outboxHandle.outboxId,
  });
}
