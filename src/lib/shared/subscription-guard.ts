import { SubscriptionStatus } from './subscription-status';
import {
  computePastDueRecoveryState,
  type AccountFlagsInput,
} from './past-due-recovery';

export type { AccountFlagsInput } from './past-due-recovery';

export type WorkerType = 'generator' | 'notification' | 'publisher' | 'summary' | 'owner_email' | 'drain';

type Allowed = { allowed: true };
type Denied = { allowed: false; reason: string };
export type SubscriptionCheckResult = Allowed | Denied;

export interface SubscriptionGuardInput {
  status: string;
  workerType: WorkerType;
  pastDueAt?: Date | string | null;
  accountFlags?: AccountFlagsInput;
  now?: Date;
  /** @deprecated Only accepted to prove business clocks are ignored. */
  businessUpdatedAt?: Date;
}

/**
 * Checks whether a worker should process work for an account based on
 * its subscription status. Rules are authoritative from CLAUDE.md:
 *
 * - cancelled → skip
 * - past_due  → 7-day grace, then skip
 * - pending_payment → only generator allowed (admin-visible demo drafts)
 * - active → allowed
 * - trialing → allowed (treated like active; trial expiry is enforced by Stripe
 *   converting/cancelling the subscription and the reconcile poller correcting
 *   the projection, NOT by a per-request clock here)
 */
export function checkSubscription(input: SubscriptionGuardInput): SubscriptionCheckResult {
  switch (input.status) {
    case SubscriptionStatus.ACTIVE:
    case SubscriptionStatus.TRIALING:
      return { allowed: true };

    case SubscriptionStatus.CANCELLED:
      return { allowed: false, reason: 'cancelled' };

    case SubscriptionStatus.PAST_DUE: {
      const recovery = computePastDueRecoveryState({
        subscriptionStatus: input.status,
        pastDueAt: input.pastDueAt,
        accountFlags: input.accountFlags,
        now: input.now,
      });
      return recovery.isReadOnly
        ? { allowed: false, reason: 'past_due_expired' }
        : { allowed: true };
    }

    case SubscriptionStatus.PENDING_PAYMENT:
      if (input.workerType === 'generator') {
        return { allowed: true };
      }
      return { allowed: false, reason: 'pending_payment' };

    default:
      return { allowed: false, reason: `unknown_status:${input.status}` };
  }
}
