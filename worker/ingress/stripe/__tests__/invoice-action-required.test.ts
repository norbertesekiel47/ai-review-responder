import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * invoice.payment_action_required — SCA pending at the trial-end charge.
 *
 * Treated exactly like a payment failure: active/trialing → past_due with a
 * 7-day grace. Routed through the same processInvoicePaymentFailed logic so the
 * trialing→past_due path emits trial_payment_failed via the applier and the
 * active→past_due path uses the inline write.
 */

const { mockProcessInvoicePaymentFailed } = vi.hoisted(() => ({
  mockProcessInvoicePaymentFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../invoice-payment-failed', () => ({
  processInvoicePaymentFailed: mockProcessInvoicePaymentFailed,
}));

import { processInvoicePaymentActionRequired } from '../invoice-payment-action-required';

beforeEach(() => {
  mockProcessInvoicePaymentFailed.mockClear();
});

describe('invoice.payment_action_required', () => {
  it('delegates to the payment-failed past_due path', async () => {
    const invoice = { id: 'in_sca', customer: 'cus_1', subscription: 'sub_1' } as never;
    await processInvoicePaymentActionRequired(invoice);
    expect(mockProcessInvoicePaymentFailed).toHaveBeenCalledWith(invoice);
  });
});
