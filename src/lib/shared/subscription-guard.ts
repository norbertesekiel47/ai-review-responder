export type WorkerType = 'generator' | 'notification' | 'publisher' | 'summary' | 'owner_email' | 'drain';

type Allowed = { allowed: true };
type Denied = { allowed: false; reason: string };
export type SubscriptionCheckResult = Allowed | Denied;

const GRACE_PERIOD_MS = 7 * 86_400_000; // 7 days

/**
 * Checks whether a worker should process work for a business based on
 * its subscription status. Rules are authoritative from CLAUDE.md:
 *
 * - cancelled → skip
 * - past_due  → 7-day grace, then skip
 * - pending_payment → only generator allowed (admin-visible demo drafts)
 * - active → allowed
 */
export function checkSubscription(
  status: string,
  businessUpdatedAt: Date,
  workerType: WorkerType,
): SubscriptionCheckResult {
  switch (status) {
    case 'active':
      return { allowed: true };

    case 'cancelled':
      return { allowed: false, reason: 'cancelled' };

    case 'past_due': {
      const elapsed = Date.now() - businessUpdatedAt.getTime();
      if (elapsed > GRACE_PERIOD_MS) {
        return { allowed: false, reason: 'past_due_expired' };
      }
      return { allowed: true };
    }

    case 'pending_payment':
      if (workerType === 'generator') {
        return { allowed: true };
      }
      return { allowed: false, reason: 'pending_payment' };

    default:
      return { allowed: false, reason: `unknown_status:${status}` };
  }
}
