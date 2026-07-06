// worker/jobs/response-generation/analytics.ts
//
// Best-effort `first_response_drafted` analytics enqueue for the response
// generator. Intentionally OUTSIDE the response-creation transaction: it runs
// AFTER the response commits so it can detect "first draft for the account"
// against committed rows. Idempotency across BullMQ retries-after-commit is
// guaranteed by the account-scoped event_key + ON CONFLICT (event_key) DO
// NOTHING in enqueueAnalyticsEvent, so a re-run cannot double-count. Analytics
// must never fail response generation, hence the swallowed catch.

import type { Sql } from 'postgres';
import { enqueueAnalyticsEvent } from '../../../src/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '../../../src/lib/analytics/events';

export async function maybeEnqueueFirstResponseDrafted(sql: Sql, input: {
  accountId: string;
  businessId: string;
  responseId: string;
  reviewId: string;
  logger?: Pick<Console, 'warn'>;
}): Promise<void> {
  try {
    const [row] = await sql<{ earlier_exists: boolean; email_verified_at: Date | null }[]>`
      SELECT
        EXISTS (
          SELECT 1
          FROM responses r2
          JOIN businesses b2 ON b2.id = r2.business_id
          WHERE b2.account_id = ${input.accountId}::uuid
            AND r2.id <> ${input.responseId}::uuid
            AND r2.created_at IS NOT NULL
          LIMIT 1
        ) AS earlier_exists,
        (
          SELECT occurred_at
          FROM analytics_events
          WHERE event_name = 'email_verified'
            AND account_id = ${input.accountId}::uuid
          ORDER BY occurred_at ASC
          LIMIT 1
        ) AS email_verified_at
    `;
    if (row?.earlier_exists) return;

    const minutesToFirstDraft = row?.email_verified_at
      ? Math.max(0, (Date.now() - new Date(row.email_verified_at).getTime()) / 60_000)
      : null;

    await enqueueAnalyticsEvent(sql, {
      eventName: 'first_response_drafted',
      eventKey: makeAnalyticsEventKey('first_response_drafted', [input.accountId]),
      distinctId: input.accountId,
      accountId: input.accountId,
      businessId: input.businessId,
      properties: {
        account_id: input.accountId,
        business_id: input.businessId,
        response_id: input.responseId,
        review_id: input.reviewId,
        minutes_to_first_draft: minutesToFirstDraft === null ? null : Number(minutesToFirstDraft.toFixed(2)),
      },
    });
  } catch (err) {
    input.logger?.warn(`first_response_drafted enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
