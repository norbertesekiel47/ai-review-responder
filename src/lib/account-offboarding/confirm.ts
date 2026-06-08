import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { sql } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';
import {
  enqueueAccountOffboardingBillingSchedule,
  enqueueAccountOffboardingEmail,
  enqueueAccountOffboardingTeardown,
} from '@/lib/shared/job-outbox-helpers';
import {
  captureAccountOffboardingSnapshot,
  type AccountOffboardingSnapshotMissingField,
} from './snapshot';
import { enqueueOffboardingStarted } from './analytics';
import type { AccountOffboardingMode } from './types';

interface ActiveOffboardingRow {
  id: string;
  mode: AccountOffboardingMode;
  status: 'pending' | 'scheduled' | 'tearing_down' | 'purge_scheduled' | 'failed';
  idempotency_key_matches: boolean;
}

export interface AccountOffboardingConfirmSummary {
  id: string;
  accountId: string;
  mode: AccountOffboardingMode;
  status: ActiveOffboardingRow['status'];
}

export type CancelOnlyOffboardingSummary = AccountOffboardingConfirmSummary & {
  mode: 'cancel_only';
};

export type DeleteDataOffboardingSummary = AccountOffboardingConfirmSummary & {
  mode: 'delete_data';
};

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
    activeOffboarding: AccountOffboardingConfirmSummary;
  }
  | {
    ok: false;
    reason: 'snapshot_incomplete';
    missingFields: AccountOffboardingSnapshotMissingField[];
  };

export interface ConfirmDeleteDataOffboardingInput {
  accountId: string;
  actorUserId: string;
  idempotencyKey: string;
  reasonCode: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type ConfirmDeleteDataOffboardingResult =
  | {
    ok: true;
    status: 'created' | 'idempotent';
    offboarding: DeleteDataOffboardingSummary;
  }
  | {
    ok: false;
    reason: 'duplicate_active';
    activeOffboarding: AccountOffboardingConfirmSummary;
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
    const prologue = await resolveActiveOrLock(
      tx,
      input.accountId,
      idempotencyKeyHash,
      'cancel_only',
    );
    if (prologue.kind === 'idempotent') {
      return {
        ok: true,
        status: 'idempotent',
        offboarding: prologue.offboarding as CancelOnlyOffboardingSummary,
      };
    }
    if (prologue.kind === 'duplicate') {
      return { ok: false, reason: 'duplicate_active', activeOffboarding: prologue.activeOffboarding };
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

    await writeConfirmAuditAndAnalytics(tx, input, offboardingId, 'cancel_only', {
      mode: 'cancel_only',
      status: 'pending',
      idempotency_key_hash: idempotencyKeyHash,
    });

    await enqueueAccountOffboardingBillingSchedule(tx, {
      accountOffboardingId: offboardingId,
      accountId: input.accountId,
      idempotencyKeyHash,
      correlationId: input.requestId ?? undefined,
    });

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

export async function confirmDeleteDataOffboarding(
  input: ConfirmDeleteDataOffboardingInput,
): Promise<ConfirmDeleteDataOffboardingResult> {
  const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);

  return sql.begin(async (tx) => {
    const prologue = await resolveActiveOrLock(
      tx,
      input.accountId,
      idempotencyKeyHash,
      'delete_data',
    );
    if (prologue.kind === 'idempotent') {
      return {
        ok: true,
        status: 'idempotent',
        offboarding: prologue.offboarding as DeleteDataOffboardingSummary,
      };
    }
    if (prologue.kind === 'duplicate') {
      return { ok: false, reason: 'duplicate_active', activeOffboarding: prologue.activeOffboarding };
    }

    const snapshotResult = await captureAccountOffboardingSnapshot(tx, {
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      requireStripeCustomerId: false,
      requireStripeSubscriptionId: false,
      // delete_data purges archived businesses too, so a fully-archived /
      // never-activated account must still capture a location_ids snapshot.
      includeArchivedLocations: true,
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
        recipient_email,
        purge_after
      ) VALUES (
        ${offboardingId}::uuid,
        ${input.accountId}::uuid,
        'delete_data',
        'pending',
        ${snapshot.stripeCustomerId},
        ${snapshot.stripeSubscriptionId},
        ${snapshot.zernioAccountIds}::text[],
        ${snapshot.zernioProfileIds}::text[],
        ${snapshot.locationIds}::uuid[],
        ${snapshot.authUserId},
        ${snapshot.recipientEmail},
        NOW() + interval '30 days'
      )
    `;

    // Mark-then-call: disconnect every live Zernio connection for the account,
    // including connections on ARCHIVED businesses (which are excluded from the
    // active-location snapshot). Scoping this to snapshot.locationIds would leave
    // an archived business's live connection processing inbound webhooks during
    // teardown. Provider-side deletion still runs from the snapshot in teardown.
    await tx`
      UPDATE zernio_connections zc
      SET status = 'disconnected',
          disconnected_at = COALESCE(disconnected_at, NOW()),
          disconnect_reason = 'account_offboarding_delete_data',
          updated_at = NOW()
      FROM businesses b
      WHERE zc.business_id = b.id
        AND b.account_id = ${input.accountId}::uuid
        AND zc.status IN ('pending', 'active')
    `;

    await writeConfirmAuditAndAnalytics(tx, input, offboardingId, 'delete_data', {
      mode: 'delete_data',
      status: 'pending',
      reason_code: input.reasonCode,
      idempotency_key_hash: idempotencyKeyHash,
    });

    await enqueueAccountOffboardingTeardown(tx, {
      accountOffboardingId: offboardingId,
      accountId: input.accountId,
      correlationId: input.requestId ?? undefined,
    });

    await enqueueAccountOffboardingEmail(tx, {
      accountOffboardingId: offboardingId,
      accountId: input.accountId,
      idempotencyKeyHash,
      correlationId: input.requestId ?? undefined,
      emailType: 'delete_data_confirmation',
    });

    return {
      ok: true,
      status: 'created',
      offboarding: {
        id: offboardingId,
        accountId: input.accountId,
        mode: 'delete_data',
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
        WHERE aal.account_id = ${accountId}::uuid
          AND aal.account_id = ao.account_id
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
): AccountOffboardingConfirmSummary {
  return {
    id: row.id,
    accountId,
    mode: row.mode,
    status: row.status,
  };
}

type ConfirmPrologueResult =
  | { kind: 'idempotent'; offboarding: AccountOffboardingConfirmSummary }
  | { kind: 'duplicate'; activeOffboarding: AccountOffboardingConfirmSummary }
  | { kind: 'proceed' };

/**
 * Shared confirm prologue for both modes: lock the account row, then resolve any
 * existing active offboarding into an idempotent replay (same key + same mode),
 * a duplicate-active rejection, or a green light to proceed. The row lock + the
 * `WHERE terminal_at IS NULL` unique index are the double-click/retry safety net.
 */
async function resolveActiveOrLock(
  tx: postgres.TransactionSql,
  accountId: string,
  idempotencyKeyHash: string,
  expectedMode: AccountOffboardingMode,
): Promise<ConfirmPrologueResult> {
  await tx`
    SELECT id
    FROM accounts
    WHERE id = ${accountId}::uuid
    FOR UPDATE
  `;

  const active = await getActiveOffboarding(tx, accountId, idempotencyKeyHash);
  if (!active) return { kind: 'proceed' };

  const offboarding = mapActiveOffboarding(active, accountId);
  if (active.idempotency_key_matches && offboarding.mode === expectedMode) {
    return { kind: 'idempotent', offboarding };
  }
  return { kind: 'duplicate', activeOffboarding: offboarding };
}

/** Shared confirm epilogue: the audit row + analytics enqueue every confirm path writes. */
async function writeConfirmAuditAndAnalytics(
  tx: postgres.TransactionSql,
  input: ConfirmCancelOnlyOffboardingInput | ConfirmDeleteDataOffboardingInput,
  offboardingId: string,
  mode: AccountOffboardingMode,
  auditPayload: Record<string, unknown>,
): Promise<void> {
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
      payload: auditPayload,
    },
    tx,
  );

  await enqueueOffboardingStarted(tx, {
    accountId: input.accountId,
    actorUserId: input.actorUserId,
    offboardingId,
    mode,
  });
}
