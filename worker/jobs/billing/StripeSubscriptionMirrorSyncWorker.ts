import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { acquireTierEntitlementLock } from '../../../src/lib/accounts/billing-locks';
import { extractOutboxHandle, markOutboxCompleted } from '../../../src/lib/shared/outbox';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import type { StripeSubscriptionMirrorSyncPayload } from '../../../src/lib/shared/worker-types';

interface CanonicalSubscriptionState {
  subscription_status: string;
  subscription_activated_at: Date | null;
}

/**
 * Synchronizes the deprecated business subscription mirror from canonical
 * account state. The lock order is deliberately business rows (ordered) ->
 * entitlement; canonical status writers only take entitlement -> account and
 * therefore never wait on the publisher's business-row anchor.
 */
export async function handleStripeSubscriptionMirrorSync(
  sql: Sql,
  job: Job<StripeSubscriptionMirrorSyncPayload>,
): Promise<void> {
  const { account_id: accountId } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  await sql.begin(async (tx) => {
    await tx`
      SELECT id
      FROM businesses
      WHERE account_id = ${accountId}::uuid
      ORDER BY id
      FOR UPDATE
    `;
    await acquireTierEntitlementLock(tx, accountId);

    const [account] = await tx<CanonicalSubscriptionState[]>`
      SELECT subscription_status, subscription_activated_at
      FROM accounts
      WHERE id = ${accountId}::uuid
    `;

    if (account) {
      switch (account.subscription_status) {
        case SubscriptionStatus.TRIALING:
        case SubscriptionStatus.ACTIVE:
          await tx`
            UPDATE businesses
            SET subscription_status = ${account.subscription_status},
                subscription_activated_at = COALESCE(
                  subscription_activated_at,
                  ${account.subscription_activated_at},
                  NOW()
                ),
                updated_at = NOW()
            WHERE account_id = ${accountId}::uuid
              AND is_primary = TRUE
              AND archived_at IS NULL
          `;
          break;
        case SubscriptionStatus.PAST_DUE:
        case SubscriptionStatus.CANCELLED:
          await tx`
            UPDATE businesses
            SET subscription_status = ${account.subscription_status},
                updated_at = NOW()
            WHERE account_id = ${accountId}::uuid
          `;
          break;
        default:
          break;
      }
    }

    // Missing accounts converge too: there is no mirror left to maintain, so
    // the originating work is complete rather than retrying forever.
    await markOutboxCompleted(tx, outboxId, attempt);
  });
}
