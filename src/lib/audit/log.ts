import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { jsonb, sql } from '@/lib/db/server';

type SqlExecutor = typeof sql | postgres.TransactionSql;

export interface WriteAccountAuditLogInput {
  accountId: string;
  locationId?: string | null;
  actorUserId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  entityType?: string | null;
  entityId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function writeAccountAuditLog(
  input: WriteAccountAuditLogInput,
  db: SqlExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO account_audit_log (
      id,
      account_id,
      location_id,
      event_type,
      actor_user_id,
      payload,
      entity_type,
      entity_id,
      ip,
      user_agent,
      request_id
    ) VALUES (
      ${uuidv7()}::uuid,
      ${input.accountId}::uuid,
      ${input.locationId ?? null}::uuid,
      ${input.eventType},
      ${input.actorUserId ?? null}::uuid,
      ${jsonb(input.payload)},
      ${input.entityType ?? null},
      ${input.entityId ?? null},
      ${input.ip ?? null},
      ${input.userAgent ?? null},
      ${input.requestId ?? null}
    )
  `;
}
