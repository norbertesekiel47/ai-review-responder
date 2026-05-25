import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import type { AnalyticsEventName } from './events';
import { sanitizeAnalyticsProperties } from './events';

type SqlExecutor = typeof sql | postgres.TransactionSql;

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
  input: EnqueueAnalyticsEventInput,
  db: SqlExecutor = sql,
): Promise<void> {
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
      ${jsonb(properties)},
      ${input.occurredAt ?? new Date()}
    )
    ON CONFLICT (event_key) DO NOTHING
  `;
}
