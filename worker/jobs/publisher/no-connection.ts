import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';
import { markOutboxCompleted } from '../../../src/lib/shared/outbox';
import type { SendOwnerEmailPayload } from '../../../src/lib/shared/worker-types';

export async function parkResponseForOwnerReconnect(sql: Sql, input: {
  responseId: string;
  businessId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  responseStatus?: string;
  logger: { log(message: string): void };
}): Promise<void> {
  const { responseId, businessId, outboxId, outboxAttempt, responseStatus, logger } = input;

  const parked = await sql.begin(async (tx) => {
    const updated = await tx`
      UPDATE responses
      SET status = 'awaiting_owner_connect', updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;

    if (updated.count === 0) {
      logger.log(
        `Response ${responseId} already terminal (status=${responseStatus ?? 'unknown'}), skipping reconnect notify`,
      );
      return false;
    }

    const reconnectPayload = {
      kind: 'reconnect_required',
      response_id: responseId,
      business_id: businessId,
    } satisfies SendOwnerEmailPayload;
    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()},
        'notify_owner_reconnect',
        'response',
        ${responseId},
        ${tx.json(reconnectPayload as never)},
        0,
        5
      )
    `;
    return true;
  });

  if (!parked) {
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  logger.log(
    `No active Zernio connection for business ${businessId}; response ${responseId} parked at awaiting_owner_connect`,
  );
  await markOutboxCompleted(sql, outboxId, outboxAttempt);
}
