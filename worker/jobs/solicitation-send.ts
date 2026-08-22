// Success-path composition root for solicitation_send (#899). All domain
// behavior — the Dispatch gate, the unsubscribe token mint, the provider call
// and the terminal transaction — lives in src/lib/solicitation/dispatch.ts.
// The domain completes the owned outbox attempt on every non-transient path
// (defer / terminal tx — the ask-generation precedent), so this handler never
// touches the outbox row.
//
// NOTHING RETRYABLE REACHES BULLMQ FROM THE PROVIDER. A `retryable` send
// failure is absorbed in process by the domain's bounded, jittered retry, while
// the raw unsubscribe token is still in scope, and an exhausted budget is
// terminalized in tx2 exactly like a terminal one — decision 9a, and the reason
// a retry that rebuilt the body would be worse than not retrying at all.
//
// What still propagates from here is a genuine error: tx2 failing to commit, or
// an impossible state the domain asserts on. BullMQ retries those, and on the
// final attempt `./solicitation-send/failed-hook.ts` writes the terminal
// `failed` / `send_exhausted` facts this handler deliberately does not own.

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
