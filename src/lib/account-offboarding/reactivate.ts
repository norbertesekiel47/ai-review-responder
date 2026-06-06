import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type postgres from 'postgres';
import { sql } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { enqueueAccountOffboardingEmail } from '@/lib/shared/job-outbox-helpers';

type SqlExecutor = typeof sql | postgres.TransactionSql;
const REACTIVATION_CLAIM_PREFIX = 'reactivation_claim:';
const STALE_REACTIVATION_CLAIM_MS = 5 * 60 * 1000;

interface ReactivatableOffboardingRow {
  id: string;
  mode: 'cancel_only';
  status: 'scheduled';
  teardown_started_at: Date | string | null;
  terminal_at: Date | string | null;
  reactivated_at: Date | string | null;
  last_error: string | null;
  stripe_subscription_id: string | null;
}

interface ReactivatedOffboardingRow {
  id: string;
  mode: 'cancel_only';
  status: 'reactivated';
}

export interface ReactivateCancelOnlyOffboardingInput {
  accountId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type ReactivateCancelOnlyOffboardingResult =
  | {
    ok: true;
    status: 'reactivated';
    offboarding: {
      id: string;
      accountId: string;
      mode: 'cancel_only';
      status: 'reactivated';
    };
  }
  | { ok: false; reason: 'not_reactivatable' }
  | { ok: false; reason: 'state_changed' }
  | {
    ok: false;
    reason: 'stripe_reversal_unavailable';
    recovery: {
      checkoutPath: '/api/billing/checkout';
      reconnectPath: '/api/zernio/connect/start';
    };
  };

let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

export async function reactivateCancelOnlyOffboarding(
  input: ReactivateCancelOnlyOffboardingInput,
): Promise<ReactivateCancelOnlyOffboardingResult> {
  const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);

  const claim = await claimReactivation(input.accountId, idempotencyKeyHash);
  if (claim.kind === 'idempotent') {
    return {
      ok: true,
      status: 'reactivated',
      offboarding: {
        id: claim.offboarding.id,
        accountId: input.accountId,
        mode: claim.offboarding.mode,
        status: claim.offboarding.status,
      },
    };
  }
  if (claim.kind === 'not_reactivatable') {
    return { ok: false, reason: 'not_reactivatable' };
  }
  if (claim.kind === 'state_changed') {
    return { ok: false, reason: 'state_changed' };
  }

  const { offboarding } = claim;
  try {
    const subscription = await getStripe().subscriptions.update(
      offboarding.stripe_subscription_id!,
      { cancel_at_period_end: false },
      {
        idempotencyKey: accountOffboardingReactivationIdempotencyKey(
          offboarding,
          input.accountId,
          idempotencyKeyHash,
        ),
      },
    );
    if (!isSameReactivatedSubscription(subscription, offboarding.stripe_subscription_id!)) {
      await clearReactivationClaim(offboarding, input.accountId, idempotencyKeyHash);
      return stripeRecoveryResult();
    }
  } catch {
    // A thrown Stripe update can be a timeout after Stripe accepted the
    // idempotent reversal. Keep the claim so a same-key retry can reconcile
    // instead of allowing access-end teardown to race an active subscription.
    return stripeRecoveryResult();
  }

  let finalized: ReactivateCancelOnlyOffboardingResult;
  try {
    finalized = await finalizeReactivation(input, offboarding, idempotencyKeyHash);
  } catch (err) {
    const idempotent = await getIdempotentReactivatedOffboarding(
      sql,
      input.accountId,
      idempotencyKeyHash,
    );
    if (idempotent) {
      return {
        ok: true,
        status: 'reactivated',
        offboarding: {
          id: idempotent.id,
          accountId: input.accountId,
          mode: idempotent.mode,
          status: idempotent.status,
        },
      };
    }
    if (await shouldCompensateReactivation(offboarding, input.accountId, idempotencyKeyHash)) {
      await compensateReactivationStripeReversal(
        offboarding,
        input.accountId,
        idempotencyKeyHash,
      );
      await clearReactivationClaim(offboarding, input.accountId, idempotencyKeyHash);
    }
    throw err;
  }

  if (!finalized.ok && finalized.reason === 'state_changed') {
    if (await shouldCompensateReactivation(offboarding, input.accountId, idempotencyKeyHash)) {
      await compensateReactivationStripeReversal(
        offboarding,
        input.accountId,
        idempotencyKeyHash,
      );
      await clearReactivationClaim(offboarding, input.accountId, idempotencyKeyHash);
    }
  }
  return finalized;
}

type ReactivationClaim =
  | { kind: 'claimed'; offboarding: ReactivatableOffboardingRow }
  | { kind: 'idempotent'; offboarding: ReactivatedOffboardingRow }
  | { kind: 'not_reactivatable' }
  | { kind: 'state_changed' };

async function claimReactivation(
  accountId: string,
  idempotencyKeyHash: string,
): Promise<ReactivationClaim> {
  return sql.begin(async (tx) => {
    const offboarding = await lockReactivatableOffboarding(tx, accountId);
    if (!offboarding) {
      const idempotent = await getIdempotentReactivatedOffboarding(
        tx,
        accountId,
        idempotencyKeyHash,
      );
      if (idempotent) return { kind: 'idempotent', offboarding: idempotent };
      return { kind: 'not_reactivatable' };
    }

    if (offboarding.reactivated_at !== null) {
      const currentMarker = reactivationClaimMarker(idempotencyKeyHash);
      if (offboarding.last_error === currentMarker) {
        return { kind: 'claimed', offboarding };
      }
      if (!isStaleReactivationClaim(offboarding.reactivated_at)) {
        return { kind: 'state_changed' };
      }
      const takeover = await tx<{ id: string }[]>`
        UPDATE account_offboardings
        SET reactivated_at = NOW(),
            last_error = ${currentMarker},
            updated_at = NOW()
        WHERE id = ${offboarding.id}::uuid
          AND account_id = ${accountId}::uuid
          AND mode = 'cancel_only'
          AND status = 'scheduled'
          AND teardown_started_at IS NULL
          AND terminal_at IS NULL
          AND reactivated_at IS NOT NULL
          AND last_error = ${offboarding.last_error}
        RETURNING id
      `;
      if (takeover.length === 0) return { kind: 'state_changed' };
      return {
        kind: 'claimed',
        offboarding: {
          ...offboarding,
          reactivated_at: new Date(),
          last_error: currentMarker,
        },
      };
    }

    const claimed = await tx<{ id: string }[]>`
      UPDATE account_offboardings
      SET reactivated_at = NOW(),
          last_error = ${reactivationClaimMarker(idempotencyKeyHash)},
          updated_at = NOW()
      WHERE id = ${offboarding.id}::uuid
        AND account_id = ${accountId}::uuid
        AND mode = 'cancel_only'
        AND status = 'scheduled'
        AND teardown_started_at IS NULL
        AND terminal_at IS NULL
        AND reactivated_at IS NULL
      RETURNING id
    `;
    if (claimed.length === 0) return { kind: 'state_changed' };
    return {
      kind: 'claimed',
      offboarding: {
        ...offboarding,
        reactivated_at: new Date(),
        last_error: reactivationClaimMarker(idempotencyKeyHash),
      },
    };
  });
}

async function finalizeReactivation(
  input: ReactivateCancelOnlyOffboardingInput,
  offboarding: ReactivatableOffboardingRow,
  idempotencyKeyHash: string,
): Promise<ReactivateCancelOnlyOffboardingResult> {
  return sql.begin(async (tx) => {
    const updated = await tx<{ id: string }[]>`
      UPDATE account_offboardings
      SET status = 'reactivated',
          reactivated_at = COALESCE(reactivated_at, NOW()),
          terminal_at = NOW(),
          last_error = NULL,
          updated_at = NOW()
      WHERE id = ${offboarding.id}::uuid
        AND account_id = ${input.accountId}::uuid
        AND mode = 'cancel_only'
        AND status = 'scheduled'
        AND teardown_started_at IS NULL
        AND terminal_at IS NULL
        AND reactivated_at IS NOT NULL
        AND last_error = ${reactivationClaimMarker(idempotencyKeyHash)}
      RETURNING id
    `;
    if (updated.length === 0) {
      const idempotent = await getIdempotentReactivatedOffboarding(
        tx,
        input.accountId,
        idempotencyKeyHash,
      );
      if (idempotent) {
        return {
          ok: true,
          status: 'reactivated',
          offboarding: {
            id: idempotent.id,
            accountId: input.accountId,
            mode: idempotent.mode,
            status: idempotent.status,
          },
        };
      }
      return { ok: false, reason: 'state_changed' };
    }

    await writeAccountAuditLog(
      {
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        eventType: 'account_offboarding_reactivated',
        entityType: 'account_offboarding',
        entityId: offboarding.id,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
        payload: {
          mode: 'cancel_only',
          status: 'reactivated',
          idempotency_key_hash: idempotencyKeyHash,
          stripe_subscription_id: offboarding.stripe_subscription_id,
        },
      },
      tx,
    );

    await enqueueAccountOffboardingEmail(tx, {
      accountOffboardingId: offboarding.id,
      accountId: input.accountId,
      correlationId: input.requestId ?? undefined,
      emailType: 'cancel_only_reactivation_confirmation',
    });

    return {
      ok: true,
      status: 'reactivated',
      offboarding: {
        id: offboarding.id,
        accountId: input.accountId,
        mode: 'cancel_only',
        status: 'reactivated',
      },
    };
  });
}

async function compensateReactivationStripeReversal(
  offboarding: ReactivatableOffboardingRow,
  accountId: string,
  idempotencyKeyHash: string,
): Promise<void> {
  try {
    await getStripe().subscriptions.update(
      offboarding.stripe_subscription_id!,
      { cancel_at_period_end: true },
      {
        idempotencyKey: [
          'account-offboarding-reactivate-compensate',
          offboarding.id,
          accountId,
          idempotencyKeyHash,
        ].join(':'),
      },
    );
  } catch (err) {
    const error = new Error('account_offboarding_reactivation_compensation_failed');
    (error as Error & { cause?: unknown }).cause = err;
    throw error;
  }
}

async function clearReactivationClaim(
  offboarding: ReactivatableOffboardingRow,
  accountId: string,
  idempotencyKeyHash: string,
): Promise<void> {
  await sql`
    UPDATE account_offboardings
    SET reactivated_at = NULL,
        last_error = NULL,
        updated_at = NOW()
    WHERE id = ${offboarding.id}::uuid
      AND account_id = ${accountId}::uuid
      AND mode = 'cancel_only'
      AND status = 'scheduled'
      AND terminal_at IS NULL
      AND reactivated_at IS NOT NULL
      AND last_error = ${reactivationClaimMarker(idempotencyKeyHash)}
  `;
}

async function shouldCompensateReactivation(
  offboarding: ReactivatableOffboardingRow,
  accountId: string,
  idempotencyKeyHash: string,
): Promise<boolean> {
  if (await isTerminalReactivatedOffboarding(offboarding, accountId)) {
    return false;
  }

  const [row] = await sql<{ last_error: string | null }[]>`
    SELECT last_error
    FROM account_offboardings
    WHERE id = ${offboarding.id}::uuid
      AND account_id = ${accountId}::uuid
      AND mode = 'cancel_only'
      AND status = 'scheduled'
      AND terminal_at IS NULL
      AND reactivated_at IS NOT NULL
    LIMIT 1
  `;

  const marker = row?.last_error;
  return !(
    marker?.startsWith(REACTIVATION_CLAIM_PREFIX)
    && marker !== reactivationClaimMarker(idempotencyKeyHash)
  );
}

function accountOffboardingReactivationIdempotencyKey(
  row: ReactivatableOffboardingRow,
  accountId: string,
  idempotencyKeyHash: string,
): string {
  return ['account-offboarding-reactivate', row.id, accountId, idempotencyKeyHash].join(':');
}

function hashIdempotencyKey(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}

async function lockReactivatableOffboarding(
  tx: postgres.TransactionSql,
  accountId: string,
): Promise<ReactivatableOffboardingRow | null> {
  const [row] = await tx<ReactivatableOffboardingRow[]>`
    SELECT id, mode, status, teardown_started_at, terminal_at, reactivated_at, last_error, stripe_subscription_id
    FROM account_offboardings
    WHERE account_id = ${accountId}::uuid
      AND mode = 'cancel_only'
      AND status = 'scheduled'
      AND teardown_started_at IS NULL
      AND terminal_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE
  `;
  if (!row?.stripe_subscription_id?.trim()) return null;
  return row;
}

async function getIdempotentReactivatedOffboarding(
  exec: SqlExecutor,
  accountId: string,
  idempotencyKeyHash: string,
): Promise<ReactivatedOffboardingRow | null> {
  const [row] = await exec<ReactivatedOffboardingRow[]>`
    SELECT ao.id, ao.mode, ao.status
    FROM account_offboardings ao
    WHERE ao.account_id = ${accountId}::uuid
      AND ao.mode = 'cancel_only'
      AND ao.status = 'reactivated'
      AND ao.terminal_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM account_audit_log aal
        WHERE aal.account_id = ao.account_id
          AND aal.entity_type = 'account_offboarding'
          AND aal.entity_id = ao.id::text
          AND aal.event_type = 'account_offboarding_reactivated'
          AND aal.payload->>'idempotency_key_hash' = ${idempotencyKeyHash}
      )
    ORDER BY ao.reactivated_at DESC NULLS LAST, ao.created_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

async function isTerminalReactivatedOffboarding(
  offboarding: ReactivatableOffboardingRow,
  accountId: string,
): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id
    FROM account_offboardings
    WHERE id = ${offboarding.id}::uuid
      AND account_id = ${accountId}::uuid
      AND mode = 'cancel_only'
      AND status = 'reactivated'
      AND terminal_at IS NOT NULL
    LIMIT 1
  `;
  return Boolean(row);
}

function reactivationClaimMarker(idempotencyKeyHash: string): string {
  return `${REACTIVATION_CLAIM_PREFIX}${idempotencyKeyHash}`;
}

function isStaleReactivationClaim(value: Date | string): boolean {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp >= STALE_REACTIVATION_CLAIM_MS;
}

function isSameReactivatedSubscription(
  subscription: Stripe.Response<Stripe.Subscription>,
  stripeSubscriptionId: string,
): boolean {
  const response = subscription as unknown as {
    id?: unknown;
    cancel_at_period_end?: unknown;
    status?: unknown;
  };
  return response.id === stripeSubscriptionId
    && response.cancel_at_period_end === false
    && response.status !== 'canceled';
}

function stripeRecoveryResult(): Extract<
  ReactivateCancelOnlyOffboardingResult,
  { reason: 'stripe_reversal_unavailable' }
> {
  return {
    ok: false,
    reason: 'stripe_reversal_unavailable',
    recovery: {
      checkoutPath: '/api/billing/checkout',
      reconnectPath: '/api/zernio/connect/start',
    },
  };
}
