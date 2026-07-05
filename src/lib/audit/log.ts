import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';

// Callable with either the base client (standalone, best-effort writes — e.g.
// the MFA challenge route) or a transaction client (the SAME transaction as
// the caller's state change — the documented contract for account-status
// writes; CLAUDE.md "Audit writes"). Both shapes expose `.json()`, so the
// single body below serves either.
type SqlExecutor = Sql | TransactionSql;

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
  db: SqlExecutor,
  input: WriteAccountAuditLogInput,
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
      ${db.json(input.payload as never)},
      ${input.entityType ?? null},
      ${input.entityId ?? null},
      ${input.ip ?? null},
      ${input.userAgent ?? null},
      ${input.requestId ?? null}
    )
  `;
}
