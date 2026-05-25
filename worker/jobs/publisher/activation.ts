import { captureAnalyticsEvent } from '../../../src/lib/analytics/posthog';
import { sql } from '../../../src/lib/db/server';

const MS_PER_DAY = 86_400_000;

export interface PostedResponseActivationInput {
  responseId: string;
  businessId: string;
  reviewId: string;
  logger?: {
    warn(message: string): void;
  };
}

interface ActivationCandidateRow {
  account_id: string;
  account_created_at: Date | string;
  response_id: string;
  business_id: string;
  review_id: string;
  posted_at: Date | string;
  first_response_id: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Best-effort activation capture for a just-posted response.
 *
 * Never throws: all failures (query or analytics) are swallowed and logged via
 * `input.logger`. Callers may invoke it without their own try/catch and rely on
 * this contract to keep analytics from blocking outbox completion.
 */
export async function maybeCaptureActivationCompleted(
  input: PostedResponseActivationInput,
): Promise<void> {
  try {
    const [row] = await sql<ActivationCandidateRow[]>`
      SELECT
        a.id AS account_id,
        a.created_at AS account_created_at,
        r.id AS response_id,
        r.business_id,
        r.review_id,
        r.posted_at,
        first_post.id AS first_response_id
      FROM responses r
      JOIN businesses b ON b.id = r.business_id
      JOIN accounts a ON a.id = b.account_id
      JOIN LATERAL (
        SELECT r2.id
        FROM responses r2
        JOIN businesses b2 ON b2.id = r2.business_id
        WHERE b2.account_id = a.id
          AND r2.status = 'posted'
          AND r2.posted_at IS NOT NULL
        ORDER BY r2.posted_at ASC, r2.id ASC
        LIMIT 1
      ) first_post ON TRUE
      WHERE r.id = ${input.responseId}::uuid
        AND r.business_id = ${input.businessId}::uuid
        AND r.status = 'posted'
        AND r.posted_at IS NOT NULL
        -- Activation can only fire within 7 days of account creation, so skip
        -- the first-post lookup for older accounts. The 8-day window is a safe
        -- superset; the precise 7-day gate is enforced in code below.
        AND a.created_at >= NOW() - INTERVAL '8 days'
      LIMIT 1
    `;

    if (!row) {
      return;
    }

    // Enforce the PostedResponseActivationInput contract: the caller's reviewId
    // must match the posted response's review. A mismatch means a caller bug,
    // so skip and surface it rather than capturing against a stale pairing.
    if (row.review_id !== input.reviewId) {
      input.logger?.warn(
        `activation_completed skipped: reviewId mismatch for response=${input.responseId} (expected=${input.reviewId}, actual=${row.review_id})`,
      );
      return;
    }

    if (row.first_response_id !== row.response_id) {
      return;
    }

    const postedAtMs = new Date(row.posted_at).getTime();
    const accountCreatedAtMs = new Date(row.account_created_at).getTime();
    const daysToActivation = (postedAtMs - accountCreatedAtMs) / MS_PER_DAY;

    if (!Number.isFinite(daysToActivation) || daysToActivation < 0 || daysToActivation > 7) {
      return;
    }

    captureAnalyticsEvent({
      event: 'activation_completed',
      distinctId: row.account_id,
      properties: {
        account_id: row.account_id,
        business_id: row.business_id,
        response_id: row.response_id,
        review_id: row.review_id,
        days_to_activation: Number(daysToActivation.toFixed(4)),
      },
    });
  } catch (error) {
    input.logger?.warn(
      `activation_completed capture failed for response=${input.responseId}: ${errorMessage(error)}`,
    );
  }
}
