import { describe, expect, it, vi } from 'vitest';
import {
  cleanupSubscriptionInvoices,
  StripeInvoiceCleanupError,
} from '../stripe-invoices';

const SUBSCRIPTION_ID = 'sub_cancelled_123';
const OPERATION_SCOPE = 'offboarding_22222222';

interface Invoice {
  id: string;
  status: string | null;
  subscription?: string | { id: string } | null;
}

function invoice(id: string, status: string | null, subscription: Invoice['subscription'] = SUBSCRIPTION_ID): Invoice {
  return { id, status, subscription };
}

function makeStripe(pages: Array<{ data: Invoice[]; has_more: boolean }>) {
  const stripe = {
    invoices: {
      list: vi.fn(),
      finalizeInvoice: vi.fn(),
      voidInvoice: vi.fn(),
    },
  };
  for (const page of pages) {
    stripe.invoices.list.mockResolvedValueOnce(page);
  }
  return stripe;
}

function key(invoiceId: string, operation: 'finalize' | 'void') {
  return `acct-offboarding.invoice-cleanup:${OPERATION_SCOPE}:${SUBSCRIPTION_ID}:${invoiceId}:${operation}`;
}

describe('cleanupSubscriptionInvoices', () => {
  it('finalizes subscription draft invoices, voids finalized invoices, and retains terminal paid and void invoices', async () => {
    const stripe = makeStripe([
      {
        has_more: false,
        data: [
          invoice('in_draft', 'draft'),
          invoice('in_open', 'open'),
          invoice('in_uncollectible', 'uncollectible'),
          invoice('in_void', 'void'),
          invoice('in_paid', 'paid'),
          invoice('in_other_subscription', 'open', 'sub_other_999'),
        ],
      },
    ]);
    stripe.invoices.finalizeInvoice.mockResolvedValueOnce(invoice('in_draft', 'open'));
    stripe.invoices.voidInvoice
      .mockResolvedValueOnce(invoice('in_draft', 'void'))
      .mockResolvedValueOnce(invoice('in_open', 'void'))
      .mockResolvedValueOnce(invoice('in_uncollectible', 'void'));

    const result = await cleanupSubscriptionInvoices({
      stripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: OPERATION_SCOPE,
      maxNetworkRetries: 2,
    });

    expect(stripe.invoices.list).toHaveBeenCalledWith(
      { subscription: SUBSCRIPTION_ID, limit: 100 },
      { maxNetworkRetries: 2 },
    );
    expect(stripe.invoices.finalizeInvoice).toHaveBeenCalledWith(
      'in_draft',
      { auto_advance: false },
      {
        idempotencyKey: key('in_draft', 'finalize'),
        maxNetworkRetries: 2,
      },
    );
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      'in_draft',
      {},
      {
        idempotencyKey: key('in_draft', 'void'),
        maxNetworkRetries: 2,
      },
    );
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      'in_open',
      {},
      {
        idempotencyKey: key('in_open', 'void'),
        maxNetworkRetries: 2,
      },
    );
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      'in_uncollectible',
      {},
      {
        idempotencyKey: key('in_uncollectible', 'void'),
        maxNetworkRetries: 2,
      },
    );
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(3);
    expect(result.actions).toEqual([
      { invoiceId: 'in_draft', action: 'finalized_and_voided' },
      { invoiceId: 'in_open', action: 'voided' },
      { invoiceId: 'in_uncollectible', action: 'voided' },
      { invoiceId: 'in_void', action: 'already_void' },
      { invoiceId: 'in_paid', action: 'retained_paid' },
      { invoiceId: 'in_other_subscription', action: 'skipped_subscription_mismatch' },
    ]);
    expect(result.summary).toEqual({
      inspected: 6,
      finalized: 1,
      voided: 3,
      retained: 2,
      skipped: 1,
    });
    for (const call of [
      ...stripe.invoices.finalizeInvoice.mock.calls,
      ...stripe.invoices.voidInvoice.mock.calls,
    ]) {
      expect(call[2].idempotencyKey.length).toBeLessThanOrEqual(255);
    }
  });

  it('continues pagination with starting_after and fails retryably after the bounded page limit', async () => {
    const stripe = makeStripe([
      { has_more: true, data: [invoice('in_page_1', 'void')] },
      { has_more: true, data: [invoice('in_page_2', 'void')] },
    ]);

    await expect(cleanupSubscriptionInvoices({
      stripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: OPERATION_SCOPE,
      maxPages: 2,
      pageSize: 1,
      maxNetworkRetries: 1,
    })).rejects.toMatchObject({
      name: 'StripeInvoiceCleanupError',
      retryable: true,
      operation: 'list',
      code: 'bounded_pagination_exhausted',
    });

    expect(stripe.invoices.list).toHaveBeenNthCalledWith(
      1,
      { subscription: SUBSCRIPTION_ID, limit: 1 },
      { maxNetworkRetries: 1 },
    );
    expect(stripe.invoices.list).toHaveBeenNthCalledWith(
      2,
      { subscription: SUBSCRIPTION_ID, limit: 1, starting_after: 'in_page_1' },
      { maxNetworkRetries: 1 },
    );
  });

  it('retains draft invoices when finalization returns paid or void', async () => {
    const stripe = makeStripe([
      {
        has_more: false,
        data: [
          invoice('in_paid_after_finalize', 'draft'),
          invoice('in_void_after_finalize', 'draft'),
        ],
      },
    ]);
    stripe.invoices.finalizeInvoice
      .mockResolvedValueOnce(invoice('in_paid_after_finalize', 'paid'))
      .mockResolvedValueOnce(invoice('in_void_after_finalize', 'void'));

    const result = await cleanupSubscriptionInvoices({
      stripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: OPERATION_SCOPE,
    });

    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
    expect(result.actions).toEqual([
      { invoiceId: 'in_paid_after_finalize', action: 'retained_paid' },
      { invoiceId: 'in_void_after_finalize', action: 'already_void' },
    ]);
    expect(result.summary).toEqual({
      inspected: 2,
      finalized: 2,
      voided: 0,
      retained: 2,
      skipped: 0,
    });
  });

  it('throws a permanent cleanup error for null, unknown, or still-draft statuses', async () => {
    const stripe = makeStripe([
      { has_more: false, data: [invoice('in_null', null)] },
    ]);

    await expect(cleanupSubscriptionInvoices({
      stripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: OPERATION_SCOPE,
    })).rejects.toMatchObject({
      retryable: false,
      operation: 'inspect',
      invoiceId: 'in_null',
      code: 'invalid_invoice_status',
    });

    const unknownStatusStripe = makeStripe([
      { has_more: false, data: [invoice('in_unknown', 'forgiven')] },
    ]);
    await expect(cleanupSubscriptionInvoices({
      stripe: unknownStatusStripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: OPERATION_SCOPE,
    })).rejects.toMatchObject({
      retryable: false,
      operation: 'inspect',
      invoiceId: 'in_unknown',
      code: 'invalid_invoice_status',
    });

    const stillDraftStripe = makeStripe([
      { has_more: false, data: [invoice('in_still_draft', 'draft')] },
    ]);
    stillDraftStripe.invoices.finalizeInvoice.mockResolvedValueOnce(invoice('in_still_draft', 'draft'));
    await expect(cleanupSubscriptionInvoices({
      stripe: stillDraftStripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: OPERATION_SCOPE,
    })).rejects.toMatchObject({
      retryable: false,
      operation: 'finalize',
      invoiceId: 'in_still_draft',
      code: 'unexpected_finalized_status',
    });
  });

  it('classifies Stripe retryable and permanent errors without leaking secrets', async () => {
    const retryableStripe = makeStripe([
      { has_more: false, data: [invoice('in_retry', 'open')] },
    ]);
    retryableStripe.invoices.voidInvoice.mockRejectedValueOnce(Object.assign(
      new Error('timeout while using sk_test_secret'),
      { type: 'StripeAPIConnectionError' },
    ));

    await expect(cleanupSubscriptionInvoices({
      stripe: retryableStripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: OPERATION_SCOPE,
    })).rejects.toMatchObject({
      retryable: true,
      operation: 'void',
      invoiceId: 'in_retry',
      code: 'stripe_retryable_error',
    });

    const permanentStripe = makeStripe([
      { has_more: false, data: [invoice('in_permanent', 'open')] },
    ]);
    permanentStripe.invoices.voidInvoice.mockRejectedValueOnce(Object.assign(
      new Error('invalid request for sk_test_secret'),
      { type: 'StripeInvalidRequestError', statusCode: 400 },
    ));

    try {
      await cleanupSubscriptionInvoices({
        stripe: permanentStripe,
        subscriptionId: SUBSCRIPTION_ID,
        operationScope: OPERATION_SCOPE,
      });
      throw new Error('expected cleanup to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(StripeInvoiceCleanupError);
      expect(err).toMatchObject({
        retryable: false,
        operation: 'void',
        invoiceId: 'in_permanent',
        code: 'stripe_permanent_error',
      });
      expect(err).toMatchObject({
        stripeError: {
          type: 'StripeInvalidRequestError',
          statusCode: 400,
        },
      });
      expect(String(err)).not.toContain('sk_test_secret');
      expect(JSON.stringify(err)).not.toContain('sk_test_secret');
    }
  });

  it('hashes overlong idempotency keys deterministically under Stripe limits', async () => {
    const stripe = makeStripe([
      { has_more: false, data: [invoice('in_long_scope', 'open')] },
    ]);
    stripe.invoices.voidInvoice.mockResolvedValueOnce(invoice('in_long_scope', 'void'));

    await cleanupSubscriptionInvoices({
      stripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: 'scope-'.repeat(80),
    });

    const requestOptions = stripe.invoices.voidInvoice.mock.calls[0]![2];
    expect(requestOptions.idempotencyKey).toMatch(
      /^acct-offboarding\.invoice-cleanup:hashed:void:[a-f0-9]{64}$/,
    );
    expect(requestOptions.idempotencyKey.length).toBeLessThanOrEqual(255);
  });

  it('caps maxNetworkRetries while preserving zero retries', async () => {
    const cappedStripe = makeStripe([
      { has_more: false, data: [invoice('in_capped', 'open')] },
    ]);
    cappedStripe.invoices.voidInvoice.mockResolvedValueOnce(invoice('in_capped', 'void'));

    await cleanupSubscriptionInvoices({
      stripe: cappedStripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: OPERATION_SCOPE,
      maxNetworkRetries: 99,
    });

    expect(cappedStripe.invoices.list).toHaveBeenCalledWith(
      { subscription: SUBSCRIPTION_ID, limit: 100 },
      { maxNetworkRetries: 2 },
    );
    expect(cappedStripe.invoices.voidInvoice.mock.calls[0]![2]).toMatchObject({
      maxNetworkRetries: 2,
    });

    const zeroRetryStripe = makeStripe([
      { has_more: false, data: [invoice('in_zero_retry', 'open')] },
    ]);
    zeroRetryStripe.invoices.voidInvoice.mockResolvedValueOnce(invoice('in_zero_retry', 'void'));

    await cleanupSubscriptionInvoices({
      stripe: zeroRetryStripe,
      subscriptionId: SUBSCRIPTION_ID,
      operationScope: OPERATION_SCOPE,
      maxNetworkRetries: 0,
    });

    expect(zeroRetryStripe.invoices.list).toHaveBeenCalledWith(
      { subscription: SUBSCRIPTION_ID, limit: 100 },
      { maxNetworkRetries: 0 },
    );
    expect(zeroRetryStripe.invoices.voidInvoice.mock.calls[0]![2]).toMatchObject({
      maxNetworkRetries: 0,
    });
  });
});
