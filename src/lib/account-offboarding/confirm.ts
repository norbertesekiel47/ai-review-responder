import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { sql } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';
import {
  enqueueAccountOffboardingBillingSchedule,
} from '@/lib/shared/job-outbox-helpers';
import {
  captureAccountOffboardingSnapshot,
  type AccountOffboardingSnapshotMissingField,
} from './snapshot';

interface ActiveOffboardingRow {
  id: string;
  mode: 'cancel_only';
  status: 'pending' | 'scheduled' | 'tearing_down' | 'failed';
  idempotency_key_matches: boolean;
}

export interface CancelOnlyOffboardingSummary {
  id: string;
  accountId: string;
  mode: 'cancel_only';
  status: ActiveOffboardingRow['status'];
}

export interface ConfirmCancelOnlyOffboardingInput {
  accountId: string;
  actorUserId: string;
  idempotencyKey: string;
  reasonCode?: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type ConfirmCancelOnlyOffboardingResult =
  | {
    ok: true;
    status: 'created' | 'idempotent';
    offboarding: CancelOnlyOffboardingSummary;
  }
  | {
    ok: false;
    reason: 'duplicate_active';
    activeOffboarding: CancelOnlyOffboardingSummary;
  }
  | {
    ok: false;
    reason: 'snapshot_incomplete';
    missingFields: AccountOffboardingSnapshotMissingField[];
  };

export async function confirmCancelOnlyOffboarding(
  input: ConfirmCancelOnlyOffboardingInput,
): Promise<ConfirmCancelOnlyOffboardingResult> {
  const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);

  return sql.begin(async (tx) => {
    await tx`
      SELECT id
      FROM accounts
      WHERE id = ${input.accountId}::uuid
      FOR UPDATE
    `;

    const active = await getActiveOffboarding(tx, input.accountId, idempotencyKeyHash);
    if (active) {
      const offboarding = mapActiveOffboarding(active, input.accountId);
      if (active.idempotency_key_matches) {
        return { ok: true, status: 'idempotent', offboarding };
      }
      return { ok: false, reason: 'duplicate_active', activeOffboarding: offboarding };
    }

    const snapshotResult = await captureAccountOffboardingSnapshot(tx, {
      accountId: input.accountId,
      actorUserId: input.actorUserId,
    });
    if (!snapshotResult.ok) {
      return {
        ok: false,
        reason: 'snapshot_incomplete',
        missingFields: snapshotResult.missingFields,
      };
    }

    const offboardingId = uuidv7();
    const { snapshot } = snapshotResult;
    await tx`
      INSERT INTO account_offboardings (
        id,
        account_id,
        mode,
        status,
        stripe_customer_id,
        stripe_subscription_id,
        zernio_account_ids,
        zernio_profile_ids,
        location_ids,
        auth_user_id,
        recipient_email
      ) VALUES (
        ${offboardingId}::uuid,
        ${input.accountId}::uuid,
        'cancel_only',
        'pending',
        ${snapshot.stripeCustomerId},
        ${snapshot.stripeSubscriptionId},
        ${snapshot.zernioAccountIds}::text[],
        ${snapshot.zernioProfileIds}::text[],
        ${snapshot.locationIds}::uuid[],
        ${snapshot.authUserId},
        ${snapshot.recipientEmail}
      )
    `;

    await writeAccountAuditLog(
      {
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        eventType: 'account_offboarding_requested',
        entityType: 'account_offboarding',
        entityId: offboardingId,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
        payload: {
          mode: 'cancel_only',
          status: 'pending',
          idempotency_key_hash: idempotencyKeyHash,
        },
      },
      tx,
    );

    const outboxInput = {
      accountOffboardingId: offboardingId,
      accountId: input.accountId,
      idempotencyKeyHash,
      correlationId: input.requestId ?? undefined,
    };
    await enqueueAccountOffboardingBillingSchedule(tx, outboxInput);

    return {
      ok: true,
      status: 'created',
      offboarding: {
        id: offboardingId,
        accountId: input.accountId,
        mode: 'cancel_only',
        status: 'pending',
      },
    };
  });
}

function hashIdempotencyKey(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}

async function getActiveOffboarding(
  tx: postgres.TransactionSql,
  accountId: string,
  idempotencyKeyHash: string,
): Promise<ActiveOffboardingRow | null> {
  const [row] = await tx<ActiveOffboardingRow[]>`
    SELECT
      ao.id,
      ao.mode,
      ao.status,
      EXISTS (
        SELECT 1
        FROM account_audit_log aal
        WHERE aal.account_id = ao.account_id
          AND aal.entity_type = 'account_offboarding'
          AND aal.entity_id = ao.id::text
          AND aal.event_type = 'account_offboarding_requested'
          AND aal.payload->>'idempotency_key_hash' = ${idempotencyKeyHash}
      ) AS idempotency_key_matches
    FROM account_offboardings ao
    WHERE ao.account_id = ${accountId}::uuid
      AND ao.terminal_at IS NULL
    ORDER BY ao.created_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

function mapActiveOffboarding(
  row: ActiveOffboardingRow,
  accountId: string,
): CancelOnlyOffboardingSummary {
  return {
    id: row.id,
    accountId,
    mode: row.mode,
    status: row.status,
  };
}
