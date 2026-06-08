import { createHash } from 'node:crypto';
import { sql } from '@/lib/db/server';
import { enqueueAccountOffboardingReactivation } from '@/lib/shared/job-outbox-helpers';

interface ReactivationRequestRow {
  id: string;
  mode: 'cancel_only';
  status: 'scheduled';
  stripe_subscription_id: string | null;
}

export interface RequestCancelOnlyReactivationInput {
  accountId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type RequestCancelOnlyReactivationResult =
  | {
    ok: true;
    status: 'queued';
    offboarding: {
      id: string;
      accountId: string;
      mode: 'cancel_only';
      status: 'scheduled';
    };
  }
  | { ok: false; reason: 'not_reactivatable' };

export async function requestCancelOnlyReactivation(
  input: RequestCancelOnlyReactivationInput,
): Promise<RequestCancelOnlyReactivationResult> {
  const idempotencyKeyHash = createHash('sha256').update(input.idempotencyKey).digest('hex');

  return sql.begin(async (tx) => {
    const [offboarding] = await tx<ReactivationRequestRow[]>`
      SELECT id, mode, status, stripe_subscription_id
      FROM account_offboardings
      WHERE account_id = ${input.accountId}::uuid
        AND mode = 'cancel_only'
        AND status = 'scheduled'
        AND teardown_started_at IS NULL
        AND terminal_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `;

    if (!offboarding?.stripe_subscription_id?.trim()) {
      return { ok: false, reason: 'not_reactivatable' };
    }

    await enqueueAccountOffboardingReactivation(tx, {
      accountOffboardingId: offboarding.id,
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      idempotencyKeyHash,
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      correlationId: input.requestId ?? undefined,
    });

    return {
      ok: true,
      status: 'queued',
      offboarding: {
        id: offboarding.id,
        accountId: input.accountId,
        mode: 'cancel_only',
        status: 'scheduled',
      },
    };
  });
}
