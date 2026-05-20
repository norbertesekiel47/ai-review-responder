import { sql } from '../../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed } from '../../../src/lib/shared/outbox';

export interface PublishResponseContext {
  response: {
    id: string;
    review_id: string;
    business_id: string;
    approved_text: string | null;
    status: string;
  };
  business: {
    id: string;
    name: string;
    subscription_status: string;
    account_updated_at: Date;
    archived_at: Date | null;
  };
}

export async function loadPublishResponseContext(input: {
  responseId: string;
  businessId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: { error(message: string): void; warn(message: string): void };
}): Promise<PublishResponseContext | 'completed'> {
  const { responseId, businessId, outboxId, outboxAttempt, logger } = input;

  const [response] = await sql<PublishResponseContext['response'][]>`
    SELECT id, review_id, business_id, approved_text, status
    FROM responses
    WHERE id = ${responseId}
  `;

  if (!response) {
    logger.error(`Response ${responseId} not found`);
    await markOutboxFailed(outboxId, `response_not_found: ${responseId}`, outboxAttempt);
    return 'completed';
  }

  if (response.business_id !== businessId) {
    logger.error(`Response ${responseId} belongs to business ${response.business_id}, not ${businessId}`);
    await markOutboxFailed(outboxId, 'business_id_mismatch', outboxAttempt);
    return 'completed';
  }

  const [business] = await sql<PublishResponseContext['business'][]>`
    SELECT b.id, b.name, b.archived_at, a.subscription_status, a.updated_at AS account_updated_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
  `;

  if (!business) {
    logger.error(`Business ${businessId} not found`);
    await markOutboxFailed(outboxId, `business_not_found: ${businessId}`, outboxAttempt);
    return 'completed';
  }

  if (business.archived_at !== null) {
    logger.warn(
      `Business ${businessId} is archived; skipping public publish for response ${responseId}`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return 'completed';
  }

  return { response, business };
}
