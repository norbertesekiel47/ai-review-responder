import { sql } from '../../../src/lib/db/server';
import { markOutboxFailed } from '../../../src/lib/shared/outbox';
import type { AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
import type { ActiveOffboardingProjection } from '../../../src/lib/account-offboarding/gate';

export interface PublishResponseContext {
  response: {
    id: string;
    review_id: string;
    business_id: string;
    approved_text: string | null;
    status: string;
    approval_method: string | null;
    posting_error: string | null;
  };
  business: {
    id: string;
    account_id: string;
    name: string;
    subscription_status: string;
    account_updated_at: Date;
    account_past_due_at: Date | null;
    account_flags: AccountFlagsInput;
    archived_at: Date | null;
  } & ActiveOffboardingProjection;
}

export async function loadPublishResponseContext(input: {
  responseId: string;
  businessId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: { error(message: string): void; warn(message: string): void };
}): Promise<PublishResponseContext | 'terminal'> {
  const { responseId, businessId, outboxId, outboxAttempt, logger } = input;

  const [response] = await sql<PublishResponseContext['response'][]>`
    SELECT id, review_id, business_id, approved_text, status, approval_method, posting_error
    FROM responses
    WHERE id = ${responseId}
  `;

  if (!response) {
    logger.error(`Response ${responseId} not found`);
    await markOutboxFailed(outboxId, `response_not_found: ${responseId}`, outboxAttempt);
    return 'terminal';
  }

  if (response.business_id !== businessId) {
    logger.error(`Response ${responseId} belongs to business ${response.business_id}, not ${businessId}`);
    await markOutboxFailed(outboxId, 'business_id_mismatch', outboxAttempt);
    return 'terminal';
  }

  const [business] = await sql<PublishResponseContext['business'][]>`
    SELECT b.id, b.account_id, b.name, b.archived_at, a.subscription_status, a.updated_at AS account_updated_at,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags,
           ao.id AS offboarding_id,
           ao.account_id AS offboarding_account_id,
           ao.mode AS offboarding_mode,
           ao.status AS offboarding_status,
           ao.failed_step AS offboarding_failed_step,
           ao.access_ends_at AS offboarding_access_ends_at,
           ao.teardown_started_at AS offboarding_teardown_started_at,
           ao.purge_after AS offboarding_purge_after,
           ao.purge_started_at AS offboarding_purge_started_at,
           ao.purge_cancelled_at AS offboarding_purge_cancelled_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    LEFT JOIN LATERAL (
      SELECT id, account_id, mode, status, failed_step, access_ends_at,
             teardown_started_at, purge_after, purge_started_at,
             purge_cancelled_at
      FROM account_offboardings
      WHERE account_id = a.id
        AND terminal_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    ) ao ON TRUE
    WHERE b.id = ${businessId}
  `;

  if (!business) {
    logger.error(`Business ${businessId} not found`);
    await markOutboxFailed(outboxId, `business_not_found: ${businessId}`, outboxAttempt);
    return 'terminal';
  }

  return { response, business };
}
