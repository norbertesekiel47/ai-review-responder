import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import type { AnalyticsEventName } from './events';
import { isAnalyticsEventName, sanitizeAnalyticsProperties } from './events';

type SqlExecutor = Sql | TransactionSql;

export interface EnqueueAnalyticsEventInput {
  eventName: AnalyticsEventName;
  eventKey: string;
  distinctId: string;
  anonymousId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  businessId?: string | null;
  properties?: Record<string, unknown>;
  occurredAt?: Date;
}

export async function enqueueAnalyticsEvent(
  db: SqlExecutor,
  input: EnqueueAnalyticsEventInput,
): Promise<void> {
  if (!isAnalyticsEventName(input.eventName)) {
    throw new Error(`Invalid analytics event name: ${input.eventName}`);
  }

  const properties = sanitizeAnalyticsProperties(input.properties ?? {});
  await db`
    INSERT INTO analytics_events (
      id,
      event_key,
      event_name,
      distinct_id,
      anonymous_id,
      account_id,
      user_id,
      business_id,
      properties,
      occurred_at
    ) VALUES (
      ${uuidv7()}::uuid,
      ${input.eventKey},
      ${input.eventName},
      ${input.distinctId},
      ${input.anonymousId ?? null},
      ${input.accountId ?? null}::uuid,
      ${input.userId ?? null}::uuid,
      ${input.businessId ?? null}::uuid,
      ${db.json(properties as never)},
      ${input.occurredAt ?? new Date()}
    )
    ON CONFLICT (event_key) DO NOTHING
  `;
}
