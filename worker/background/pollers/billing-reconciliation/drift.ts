import { computePastDueRecoveryState } from '../../../../src/lib/shared/past-due-recovery';
import type { BillingReconciliationAccount, DriftFinding } from './types';

// Stripe statuses that are EXPECTED while our DB row sits in its past-due grace
// window (Stripe's dunning keeps the subscription past_due/unpaid until it
// either recovers or cancels). Outside the window these would be real drift.
const TOLERATED_PAST_DUE_STRIPE_STATUSES = ['past_due', 'unpaid'];

interface PreviewInvoiceLine {
  amount?: number | null;
  subtotal?: number | null;
  quantity?: number | null;
  price?: {
    unit_amount?: number | null;
  } | null;
  pricing?: {
    unit_amount_decimal?: unknown;
  } | null;
  parent?: {
    subscription_item_details?: {
      proration?: boolean | null;
      subscription_item?: string | null;
    } | null;
  } | null;
  proration?: boolean | null;
  subscription_item?: string | null;
  type?: string | null;
}

interface PreviewInvoice {
  lines?: {
    data?: PreviewInvoiceLine[] | null;
  } | null;
}

/**
 * True when a Stripe past_due/unpaid status is EXPECTED because our account is
 * still inside its past-due grace window — so the reconcile poller must not
 * raise a false status_mismatch.
 *
 * The window is computed by the single grace-clock owner
 * (`computePastDueRecoveryState`, the same logic the read-only access gate
 * uses), which makes this EXTENSION-AWARE: an admin `grant-extension`
 * (`flags.past_due_extension`) pushes the effective deadline past the default
 * 7-day grace, and we tolerate the Stripe divergence for exactly as long as the
 * customer legitimately retains access. (deep-scan §6.3 / §6.5 — previously a
 * hardcoded 7-day window that ignored extensions and false-alerted hourly once
 * an extended account passed day 7.)
 */
export function isExpectedStatusWindow(
  account: BillingReconciliationAccount,
  stripeStatus: string,
  now: Date = new Date(),
): boolean {
  if (!TOLERATED_PAST_DUE_STRIPE_STATUSES.includes(stripeStatus)) return false;

  const recovery = computePastDueRecoveryState({
    subscriptionStatus: account.subscription_status,
    pastDueAt: account.past_due_at,
    accountFlags: account.flags,
    now,
  });

  // In-window == past_due AND access not yet cut (extension-aware deadline).
  return recovery.isPastDue && !recovery.isReadOnly;
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

export function recurringSubscriptionLineTotalCents(
  invoice: PreviewInvoice,
): number | null {
  const lines = invoice.lines?.data;
  if (!Array.isArray(lines) || lines.length === 0) return null;

  let totalCents = 0;
  let sawRecurringSubscriptionLine = false;

  for (const line of lines) {
    if (!isRecurringSubscriptionLine(line)) continue;

    const lineCents = undiscountedLineAmountCents(line);
    if (lineCents === null) continue;

    totalCents += lineCents;
    sawRecurringSubscriptionLine = true;
  }

  return sawRecurringSubscriptionLine ? totalCents : null;
}

function isRecurringSubscriptionLine(line: PreviewInvoiceLine): boolean {
  const details = line.parent?.subscription_item_details;
  if (line.proration === true || details?.proration === true) return false;
  if (details?.subscription_item) return true;
  if (line.subscription_item) return true;
  return line.type === 'subscription';
}

function undiscountedLineAmountCents(line: PreviewInvoiceLine): number | null {
  const quantity = typeof line.quantity === 'number' && line.quantity > 0
    ? line.quantity
    : 1;

  const unitAmount = line.price?.unit_amount;
  if (typeof unitAmount === 'number') {
    return unitAmount * quantity;
  }

  const unitAmountDecimal = line.pricing?.unit_amount_decimal;
  if (unitAmountDecimal !== undefined && unitAmountDecimal !== null) {
    const parsed = Number(unitAmountDecimal);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed * quantity);
    }
  }

  if (typeof line.subtotal === 'number') return line.subtotal;
  return typeof line.amount === 'number' ? line.amount : null;
}
