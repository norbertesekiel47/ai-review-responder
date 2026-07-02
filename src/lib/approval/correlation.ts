import type postgres from 'postgres';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

type TxClient = postgres.TransactionSql;

interface RecoveryInput {
  reviewId: string;
  responseId: string;
}

/**
 * Recover the upstream correlation_id for an approval action.
 *
 * Chain: ingest_zernio_review -> generate_response -> send_notification -> publish_response.
 * When the owner approves, publish_response should carry the SAME correlation_id
 * that the original ingest job generated, not a new one derived from response_id.
 *
 * Lookup strategy:
 *  1. Query the most recent generate_response outbox row for this review.
 *     (generate_response is the first hop that references the review_id as aggregate_id,
 *      so it's the canonical anchor for chain correlation.)
 *  2. If that row has a non-null correlation_id, return it.
 *  3. Otherwise fall back to responseId — a stable identifier that at least makes
 *     the publish hop traceable from the response, even if pre-20a data broke the chain.
 *
 * Uses idx_jo_topic (topic, status) for aggregate_id lookup, plus the new
 * idx_jo_correlation_id for payload field extraction.
 */
export async function recoverCorrelationId(
  tx: TxClient,
  input: RecoveryInput,
): Promise<string> {
  const rows = await tx<{ correlation_id: string | null }[]>`
    SELECT (payload#>>'{}')::jsonb->>'correlation_id' AS correlation_id
    FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
      AND aggregate_id = ${input.reviewId}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const upstream = rows[0]?.correlation_id;
  return upstream ?? input.responseId;
}
