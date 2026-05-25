import { SubscriptionStatus } from '../../../../src/lib/shared/subscription-status';
import type { BillingReconciliationAccount, DriftFinding } from './types';

const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

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
