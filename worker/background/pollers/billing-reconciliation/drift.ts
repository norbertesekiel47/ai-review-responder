import { SubscriptionStatus } from '../../../../src/lib/shared/subscription-status';
import type { BillingReconciliationAccount, DriftFinding } from './types';

const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function isExpectedStatusWindow(
  account: BillingReconciliationAccount,
  stripeStatus: string,
  now: Date = new Date(),
): boolean {
  if (account.subscription_status !== SubscriptionStatus.PAST_DUE) return false;
  if (!account.past_due_at) return false;

  const ageMs = now.getTime() - new Date(account.past_due_at).getTime();
  return ageMs >= 0
    && ageMs <= PAST_DUE_GRACE_MS
    && ['past_due', 'unpaid'].includes(stripeStatus);
}

export function compareUpcomingInvoice(
  accountId: string,
  expectedCents: number,
  actualCents: number,
): DriftFinding[] {
  if (Math.abs(expectedCents - actualCents) <= 1) return [];

  return [{
    severity: 'unsafe',
    type: 'upcoming_invoice_mismatch',
    message: `Upcoming invoice drift for account ${accountId}: expected=${expectedCents} actual=${actualCents}`,
    expectedCents,
    actualCents,
  }];
}
