import { describe, expect, it } from 'vitest';
import {
  compareUpcomingInvoice,
  recurringSubscriptionLineTotalCents,
} from '../drift';

describe('reconciliation is tax-safe', () => {
  // Dahlia invoice lines expose pricing.unit_amount_decimal (price.unit_amount
  // is the legacy shape). The tax-inclusive values surface on subtotal/amount,
  // which this function only reads as a LAST resort — so they must be ignored.
  it('uses the Dahlia pre-tax pricing field, ignoring tax-inclusive subtotal/amount', () => {
    const previewInvoice = {
      lines: {
        data: [
          {
            quantity: 1,
            pricing: { unit_amount_decimal: '7900' }, // pre-tax — must win
            parent: { subscription_item_details: { subscription_item: 'si_1' } },
            subtotal: 8612, // 7900 + 712 tax — must be ignored
            amount: 8612,   // tax-inclusive — must be ignored
          },
        ],
      },
    };
    expect(recurringSubscriptionLineTotalCents(previewInvoice)).toBe(7900);
  });

  it('also handles the legacy price.unit_amount shape pre-tax', () => {
    const previewInvoice = {
      lines: {
        data: [
          {
            quantity: 1,
            price: { unit_amount: 7900 }, // pre-tax — must win
            parent: { subscription_item_details: { subscription_item: 'si_1' } },
            subtotal: 8612,
            amount: 8612,
          },
        ],
      },
    };
    expect(recurringSubscriptionLineTotalCents(previewInvoice)).toBe(7900);
  });

  it('does not flag drift when DB-expected equals the pre-tax recurring total', () => {
    expect(compareUpcomingInvoice('acct_1', 7900, 7900)).toEqual([]);
  });
});
