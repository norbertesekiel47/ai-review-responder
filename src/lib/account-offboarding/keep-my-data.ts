import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { enqueueAccountOffboardingEmail } from '@/lib/account-offboarding/outbox';
import { hashAccountOffboardingToken } from './tokens';
import type { AccountOffboardingStatus } from './types';

type Tx = postgres.TransactionSql;

interface KeepMyDataOffboardingRow {
  id: string;
  account_id: string;
  mode: 'delete_data';
  status: 'pending' | 'tearing_down' | 'purge_scheduled';
  teardown_completed_at: Date | string | null;
  purge_started_at: Date | string | null;
  purge_cancelled_at: Date | string | null;
  terminal_at: Date | string | null;
}

interface IdempotentKeepMyDataRow {
  id: string;
  mode: 'delete_data';
  status: AccountOffboardingStatus;
  terminal_at: Date | string | null;
}

interface TokenKeepMyDataRow extends KeepMyDataOffboardingRow {
  token_id: string;
  token_hash: string;
  token_type: 'keep_my_data';
  expires_at: Date | string;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
}

export interface KeepMyDataAuthenticatedInput {
  accountId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface KeepMyDataTokenInput {
  rawToken: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type KeepMyDataResult =
  | {
    ok: true;
    status: 'kept' | 'idempotent';
    offboarding: {
      id: string;
      accountId: string;
      mode: 'delete_data';
      status: AccountOffboardingStatus;
    };
  }
  | {
    ok: false;
    reason:
      | 'not_available'
      | 'token_invalid'
      | 'token_expired'
      | 'token_consumed'
      | 'token_revoked';
  };

export async function keepMyDataForAccount(
  sql: postgres.Sql,
  input: KeepMyDataAuthenticatedInput,
): Promise<KeepMyDataResult> {
  const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);

  return sql.begin(async (tx) => {
    const row = await lockActiveKeepMyDataOffboarding(tx, input.accountId);
    if (!row) {
      const idempotent = await getIdempotentKeepMyDataOffboarding(
        tx,
        input.accountId,
        idempotencyKeyHash,
      );
      return idempotent
        ? idempotentKeepResult(idempotent, input.accountId)
        : { ok: false, reason: 'not_available' };
    }

    if (!canApplyKeepMyData(row)) {
      const idempotent = await getIdempotentKeepMyDataOffboarding(
        tx,
        input.accountId,
        idempotencyKeyHash,
      );
      return idempotent
        ? idempotentKeepResult(idempotent, input.accountId)
        : { ok: false, reason: 'not_available' };
    }

    return applyKeepMyData(tx, {
      row,
      actorUserId: input.actorUserId,
      idempotencyKeyHash,
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      authMethod: 'owner_session',
    });
  });
}

export async function keepMyDataWithToken(
  sql: postgres.Sql,
  input: KeepMyDataTokenInput,
): Promise<KeepMyDataResult> {
  const tokenHash = hashAccountOffboardingToken(input.rawToken);

  return sql.begin(async (tx) => {
    const tokenRow = await lockKeepMyDataToken(tx, tokenHash);
    if (!tokenRow) return { ok: false, reason: 'token_invalid' };
    if (tokenRow.consumed_at) return { ok: false, reason: 'token_consumed' };
    if (tokenRow.revoked_at) return { ok: false, reason: 'token_revoked' };
    if (isExpired(tokenRow.expires_at)) return { ok: false, reason: 'token_expired' };
    if (!canApplyKeepMyData(tokenRow)) return { ok: false, reason: 'not_available' };

    const consumed = await tx<{ id: string }[]>`
      UPDATE account_offboarding_tokens t
      SET consumed_at = NOW(),
          consumed_ip = ${input.ip ?? null},
          consumed_user_agent = ${input.userAgent ?? null},
          updated_at = NOW()
      FROM account_offboardings ao
      WHERE t.id = ${tokenRow.token_id}::uuid
        AND t.account_offboarding_id = ao.id
        AND ao.account_id = ${tokenRow.account_id}::uuid
        AND t.consumed_at IS NULL
        AND t.revoked_at IS NULL
        AND t.expires_at > NOW()
      RETURNING t.id
    `;
    if (consumed.length === 0) return { ok: false, reason: 'not_available' };

    return applyKeepMyData(tx, {
      row: tokenRow,
      actorUserId: null,
      idempotencyKeyHash: null,
      tokenId: tokenRow.token_id,
      tokenHash,
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      authMethod: 'token',
    });
  });
}

async function applyKeepMyData(
  tx: Tx,
  input: {
    row: KeepMyDataOffboardingRow;
    actorUserId: string | null;
    idempotencyKeyHash: string | null;
    tokenId?: string;
    tokenHash?: string;
    requestId: string | null;
    ip: string | null;
    userAgent: string | null;
    authMethod: 'owner_session' | 'token';
  },
): Promise<KeepMyDataResult> {
  const updated = await tx<{
    id: string;
    account_id: string;
    mode: 'delete_data';
    status: AccountOffboardingStatus;
  }[]>`
    UPDATE account_offboardings
    SET purge_cancelled_at = COALESCE(purge_cancelled_at, NOW()),
        status = CASE
          WHEN teardown_completed_at IS NOT NULL THEN 'churned'
          ELSE status
        END,
        terminal_at = CASE
          WHEN teardown_completed_at IS NOT NULL THEN COALESCE(terminal_at, NOW())
          ELSE terminal_at
        END,
        updated_at = NOW()
    WHERE id = ${input.row.id}::uuid
      AND account_id = ${input.row.account_id}::uuid
      AND mode = 'delete_data'
      AND status IN ('pending', 'tearing_down', 'purge_scheduled')
      AND terminal_at IS NULL
      AND purge_started_at IS NULL
      AND purge_cancelled_at IS NULL
    RETURNING id, account_id, mode, status
  `;
  const row = updated[0];
  if (!row) return { ok: false, reason: 'not_available' };

  if (input.tokenId) {
    await tx`
      UPDATE account_offboarding_tokens t
      SET revoked_at = NOW(),
          revoked_reason = 'keep_my_data',
          revoked_by_user_id = ${input.actorUserId ?? null}::uuid,
          updated_at = NOW()
      FROM account_offboardings ao
      WHERE t.account_offboarding_id = ao.id
        AND ao.id = ${row.id}::uuid
        AND ao.account_id = ${row.account_id}::uuid
        AND t.consumed_at IS NULL
        AND t.revoked_at IS NULL
        AND t.id <> ${input.tokenId}::uuid
    `;
  } else {
    await tx`
      UPDATE account_offboarding_tokens t
      SET revoked_at = NOW(),
          revoked_reason = 'keep_my_data',
          revoked_by_user_id = ${input.actorUserId ?? null}::uuid,
          updated_at = NOW()
      FROM account_offboardings ao
      WHERE t.account_offboarding_id = ao.id
        AND ao.id = ${row.id}::uuid
        AND ao.account_id = ${row.account_id}::uuid
        AND t.consumed_at IS NULL
        AND t.revoked_at IS NULL
    `;
  }

  await writeAccountAuditLog(tx, {
    accountId: row.account_id,
    actorUserId: input.actorUserId,
    eventType: 'account_offboarding_keep_my_data',
    entityType: 'account_offboarding',
    entityId: row.id,
    ip: input.ip,
    userAgent: input.userAgent,
    requestId: input.requestId,
    payload: {
      mode: 'delete_data',
      status: row.status,
      auth_method: input.authMethod,
      ...(input.idempotencyKeyHash
        ? { idempotency_key_hash: input.idempotencyKeyHash }
        : {}),
      ...(input.tokenHash ? { token_hash: input.tokenHash } : {}),
    },
  });

  await enqueueAccountOffboardingEmail(tx, {
    accountOffboardingId: row.id,
    accountId: row.account_id,
    correlationId: input.requestId ?? undefined,
    emailType: 'keep_my_data_confirmation',
  });

  return {
    ok: true,
    status: 'kept',
    offboarding: {
      id: row.id,
      accountId: row.account_id,
      mode: 'delete_data',
      status: row.status,
    },
  };
}

async function lockActiveKeepMyDataOffboarding(
  tx: Tx,
  accountId: string,
): Promise<KeepMyDataOffboardingRow | null> {
  const [row] = await tx<KeepMyDataOffboardingRow[]>`
    SELECT id, account_id, mode, status, teardown_completed_at,
           purge_started_at, purge_cancelled_at, terminal_at
    FROM account_offboardings
    WHERE account_id = ${accountId}::uuid
      AND mode = 'delete_data'
      AND terminal_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE
  `;
  return row ?? null;
}

async function lockKeepMyDataToken(tx: Tx, tokenHash: string): Promise<TokenKeepMyDataRow | null> {
  const [row] = await tx<TokenKeepMyDataRow[]>`
    SELECT
      t.id AS token_id,
      t.token_hash,
      t.token_type,
      t.expires_at,
      t.consumed_at,
      t.revoked_at,
      ao.id,
      ao.account_id,
      ao.mode,
      ao.status,
      ao.teardown_completed_at,
      ao.purge_started_at,
      ao.purge_cancelled_at,
      ao.terminal_at
    FROM account_offboarding_tokens t
    JOIN account_offboardings ao ON ao.id = t.account_offboarding_id
    WHERE t.token_hash = ${tokenHash}
      AND t.token_type = 'keep_my_data'
    LIMIT 1
    FOR UPDATE OF t, ao
  `;
  return row ?? null;
}

async function getIdempotentKeepMyDataOffboarding(
  tx: Tx,
  accountId: string,
  idempotencyKeyHash: string,
): Promise<IdempotentKeepMyDataRow | null> {
  const [row] = await tx<IdempotentKeepMyDataRow[]>`
    SELECT ao.id, ao.mode, ao.status, ao.terminal_at
    FROM account_offboardings ao
    WHERE ao.account_id = ${accountId}::uuid
      AND ao.mode = 'delete_data'
      AND ao.purge_cancelled_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM account_audit_log aal
        WHERE aal.account_id = ${accountId}::uuid
          AND aal.account_id = ao.account_id
          AND aal.entity_type = 'account_offboarding'
          AND aal.entity_id = ao.id::text
          AND aal.event_type = 'account_offboarding_keep_my_data'
          AND aal.payload->>'idempotency_key_hash' = ${idempotencyKeyHash}
      )
    ORDER BY ao.purge_cancelled_at DESC NULLS LAST, ao.created_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

function canApplyKeepMyData(row: KeepMyDataOffboardingRow): boolean {
  return (
    row.mode === 'delete_data' &&
    (
      row.status === 'pending' ||
      row.status === 'tearing_down' ||
      row.status === 'purge_scheduled'
    ) &&
    row.terminal_at === null &&
    row.purge_started_at === null &&
    row.purge_cancelled_at === null
  );
}

function idempotentKeepResult(
  row: IdempotentKeepMyDataRow,
  accountId: string,
): Extract<KeepMyDataResult, { ok: true }> {
  return {
    ok: true,
    status: 'idempotent',
    offboarding: {
      id: row.id,
      accountId,
      mode: 'delete_data',
      status: row.status,
    },
  };
}

function isExpired(value: Date | string): boolean {
  const expiresAt = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function hashIdempotencyKey(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}
