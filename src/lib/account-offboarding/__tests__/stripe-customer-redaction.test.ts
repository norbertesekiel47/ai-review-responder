import { describe, expect, it, vi } from 'vitest';
import {
  redactStripeCustomer,
  stripeCustomerRedactionIdempotencyKey,
  STRIPE_CUSTOMER_REDACTION_METADATA_KEY,
} from '../stripe-customer-redaction';

const CUSTOMER_ID = 'cus_redaction_123';
const OFFBOARDING_ID = '11111111-2222-4333-8444-555555555555';

interface FakeCustomerState {
  id: string;
  deleted?: boolean;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  description?: string | null;
  address?: unknown;
  shipping?: unknown;
  business_name?: string | null;
  individual_name?: string | null;
  metadata: Record<string, string>;
}

/**
 * A fake that applies Stripe's REAL semantics, not a convenient replacement
 * model. Two rules decide whether this suite proves anything:
 *
 *  - `metadata` MERGES into the existing object. A caller that sends only the
 *    offboarding key leaves every prior key in place.
 *  - An empty-string value DELETES that key (and clears a scalar field).
 *
 * A fake that replaced metadata wholesale would pass an implementation that
 * silently retains customer metadata in production.
 */
function makeStripe(initial: Partial<FakeCustomerState> = {}) {
  const state: FakeCustomerState = {
    id: CUSTOMER_ID,
    name: 'Jordan Rivera',
    email: 'jordan@example.com',
    phone: '+15125550101',
    description: 'Founding customer',
    address: { line1: '100 Congress Ave', city: 'Austin', country: 'US' },
    shipping: { name: 'Jordan Rivera', address: { line1: '100 Congress Ave' } },
    business_name: 'Rivera Dental',
    individual_name: 'Jordan Rivera',
    metadata: { account_id: 'acct-1', business_id: 'biz-1', tier: 'autopilot' },
    ...initial,
  };

  const applyScalar = (field: keyof FakeCustomerState, value: unknown) => {
    if (value === '' || value === null) {
      (state as Record<string, unknown>)[field as string] = null;
      return;
    }
    if (value !== undefined) (state as Record<string, unknown>)[field as string] = value;
  };

  const stripe = {
    customers: {
      retrieve: vi.fn(async () => (state.deleted ? { id: state.id, deleted: true } : { ...state })),
      update: vi.fn(async (_id: string, params: Record<string, unknown>) => {
        for (const field of [
          'name',
          'email',
          'phone',
          'description',
          'address',
          'shipping',
          'business_name',
          'individual_name',
        ] as const) {
          if (field in params) applyScalar(field, params[field]);
        }
        if ('metadata' in params) {
          const incoming = params.metadata as Record<string, string> | '' | null;
          if (incoming === '' || incoming === null) {
            state.metadata = {};
          } else {
            for (const [key, value] of Object.entries(incoming)) {
              if (value === '') delete state.metadata[key];
              else state.metadata[key] = value;
            }
          }
        }
        return { ...state };
      }),
      del: vi.fn(),
    },
  };

  return { stripe, state };
}

function stripeError(type: string, code?: string): Error {
  const err = new Error(`stripe ${type}`) as Error & { type: string; code?: string };
  err.type = type;
  if (code) err.code = code;
  return err;
}

describe('redactStripeCustomer', () => {
  it('clears name, email, phone, description, address, shipping, business_name and individual_name in one update call', async () => {
    const { stripe, state } = makeStripe();

    const result = await redactStripeCustomer({
      stripe,
      customerId: CUSTOMER_ID,
      offboardingId: OFFBOARDING_ID,
    });

    expect(result.outcome).toBe('redacted');
    expect(stripe.customers.update).toHaveBeenCalledTimes(1);
    expect(state.name).toBeNull();
    expect(state.email).toBeNull();
    expect(state.phone).toBeNull();
    expect(state.description).toBeNull();
    expect(state.address).toBeNull();
    expect(state.shipping).toBeNull();
    expect(state.business_name).toBeNull();
    expect(state.individual_name).toBeNull();
  });

  it('unsets every pre-existing metadata key and writes only the offboarding id key', async () => {
    const { stripe, state } = makeStripe();

    await redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID });

    expect(Object.keys(state.metadata)).toEqual([STRIPE_CUSTOMER_REDACTION_METADATA_KEY]);
    expect(state.metadata[STRIPE_CUSTOMER_REDACTION_METADATA_KEY]).toBe(OFFBOARDING_ID);
  });

  it('leaves exactly the offboarding metadata key when the fake applies Stripe merge semantics', async () => {
    // The guard against the finding-2 defect: seed MANY keys, and prove the
    // post-merge remote object holds exactly one. An implementation that sends
    // only the offboarding key passes a replacement fake and fails this.
    const { stripe, state } = makeStripe({
      metadata: { a: '1', b: '2', c: '3', d: '4', account_id: 'acct-9' },
    });

    await redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID });

    expect(Object.keys(state.metadata)).toHaveLength(1);
    expect(state.metadata).toEqual({ [STRIPE_CUSTOMER_REDACTION_METADATA_KEY]: OFFBOARDING_ID });
  });

  it('never calls customers.del', async () => {
    const { stripe } = makeStripe();

    await redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID });

    expect(stripe.customers.del).not.toHaveBeenCalled();
  });

  it('returns already_redacted and issues no update when the customer is already cleared', async () => {
    const { stripe } = makeStripe({
      name: null,
      email: null,
      phone: null,
      description: null,
      address: null,
      shipping: null,
      business_name: null,
      individual_name: null,
      metadata: { [STRIPE_CUSTOMER_REDACTION_METADATA_KEY]: OFFBOARDING_ID },
    });

    const result = await redactStripeCustomer({
      stripe,
      customerId: CUSTOMER_ID,
      offboardingId: OFFBOARDING_ID,
    });

    expect(result.outcome).toBe('already_redacted');
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it('treats a resource_missing error as success', async () => {
    const { stripe } = makeStripe();
    stripe.customers.retrieve.mockRejectedValueOnce(
      stripeError('StripeInvalidRequestError', 'resource_missing'),
    );

    const result = await redactStripeCustomer({
      stripe,
      customerId: CUSTOMER_ID,
      offboardingId: OFFBOARDING_ID,
    });

    expect(result.outcome).toBe('customer_absent');
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it('treats a deleted customer returned by retrieve as success', async () => {
    const { stripe } = makeStripe({ deleted: true });

    const result = await redactStripeCustomer({
      stripe,
      customerId: CUSTOMER_ID,
      offboardingId: OFFBOARDING_ID,
    });

    expect(result.outcome).toBe('customer_absent');
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it('rethrows a retryable Stripe error type', async () => {
    const { stripe } = makeStripe();
    stripe.customers.update.mockRejectedValueOnce(stripeError('StripeConnectionError'));

    await expect(
      redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID }),
    ).rejects.toThrow();
  });

  it('rethrows a permanent Stripe error that is not resource_missing', async () => {
    // Finding 3: mapping every StripeInvalidRequestError to customer_absent
    // would finalize a purge whose redaction failed on bad parameters or
    // credentials. Only resource_missing means "already gone".
    const { stripe } = makeStripe();
    stripe.customers.update.mockRejectedValueOnce(
      stripeError('StripeInvalidRequestError', 'parameter_unknown'),
    );

    await expect(
      redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID }),
    ).rejects.toThrow();
  });

  it('sends a deterministic idempotency key derived from the offboarding id', async () => {
    const { stripe } = makeStripe();

    await redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID });

    const [, , options] = stripe.customers.update.mock.calls[0]!;
    expect((options as { idempotencyKey: string }).idempotencyKey).toBe(
      stripeCustomerRedactionIdempotencyKey(OFFBOARDING_ID),
    );
    expect(stripeCustomerRedactionIdempotencyKey(OFFBOARDING_ID)).toBe(
      stripeCustomerRedactionIdempotencyKey(OFFBOARDING_ID),
    );
  });
});
