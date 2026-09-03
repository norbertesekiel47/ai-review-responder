import { readFileSync } from 'node:fs';
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
function makeStripe(
  initial: Partial<FakeCustomerState> = {},
  paymentMethodIds: string[] = ['pm_card_1'],
) {
  // Attached PaymentMethods hold their own billing_details, which
  // customers.update cannot reach. The fake models detach as REMOVAL from the
  // customer's list, which is what Stripe does.
  const attachedPaymentMethods = paymentMethodIds.map((id) => ({ id }));
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

  // `as unknown as` because FakeCustomerState has no index signature; the two
  // types do not overlap enough for a direct assertion.
  const mutable = state as unknown as Record<string, unknown>;
  const applyScalar = (field: keyof FakeCustomerState, value: unknown) => {
    if (value === '' || value === null) {
      mutable[field as string] = null;
      return;
    }
    if (value !== undefined) mutable[field as string] = value;
  };

  const stripe = {
    customers: {
      retrieve: vi.fn(async () => (state.deleted ? { id: state.id, deleted: true } : { ...state })),
      update: vi.fn(async (
        _id: string,
        params: Record<string, unknown>,
        _options?: { idempotencyKey: string },
      ) => {
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
    paymentMethods: {
      list: vi.fn(async () => ({ data: [...attachedPaymentMethods], has_more: false })),
      detach: vi.fn(async (id: string) => {
        const i = attachedPaymentMethods.findIndex((m) => m.id === id);
        if (i >= 0) attachedPaymentMethods.splice(i, 1);
        return { id };
      }),
    },
  };

  return { stripe, state, attachedPaymentMethods };
}

function stripeError(type: string, code?: string): Error {
  const err = new Error(`stripe ${type}`) as Error & { type: string; code?: string };
  err.type = type;
  if (code) err.code = code;
  return err;
}

describe('redactStripeCustomer', () => {
  it('redactStripeCustomer clears name, email, phone, description, address, shipping, business_name and individual_name in one update call', async () => {
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

  it('redactStripeCustomer unsets every pre-existing metadata key and writes only the offboarding id key', async () => {
    const { stripe, state } = makeStripe();

    await redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID });

    expect(Object.keys(state.metadata)).toEqual([STRIPE_CUSTOMER_REDACTION_METADATA_KEY]);
    expect(state.metadata[STRIPE_CUSTOMER_REDACTION_METADATA_KEY]).toBe(OFFBOARDING_ID);
  });

  it('redactStripeCustomer leaves exactly the offboarding metadata key when the fake applies Stripe merge semantics', async () => {
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

  it('redactStripeCustomer detaches every attached PaymentMethod', async () => {
    // customers.update clears the Customer's own fields and reaches NOTHING on
    // an attached PaymentMethod, which carries its own billing_details — name,
    // email, phone, full address — plus card last4 and fingerprint. That data
    // is deletable, unlike a paid invoice, so leaving it is an erasure gap in a
    // feature whose entire purpose is erasure.
    const { stripe, attachedPaymentMethods } = makeStripe({}, ['pm_1', 'pm_2', 'pm_3']);

    const result = await redactStripeCustomer({
      stripe,
      customerId: CUSTOMER_ID,
      offboardingId: OFFBOARDING_ID,
    });

    expect(result.outcome).toBe('redacted');
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(3);
    expect(attachedPaymentMethods).toEqual([]);
  });

  it('redactStripeCustomer detaches before it clears the customer fields', async () => {
    // Ordering matters on RETRY. Detaching first means a failure leaves the
    // Customer's own fields intact, so the next attempt re-runs the whole
    // sequence from a consistent state rather than from a half-cleared one.
    const order: string[] = [];
    const { stripe } = makeStripe({}, ['pm_1']);
    stripe.paymentMethods.detach.mockImplementation(async (id: string) => {
      order.push('detach');
      return { id };
    });
    stripe.customers.update.mockImplementation(async () => {
      order.push('update');
      return { id: CUSTOMER_ID, metadata: {} };
    });

    await redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID });

    expect(order).toEqual(['detach', 'update']);
  });

  it('redactStripeCustomer treats a resource_missing detach as success and continues', async () => {
    // Another attempt in the same retry sequence already removed it. Aborting
    // here would strand the remaining methods attached.
    const { stripe } = makeStripe({}, ['pm_gone', 'pm_live']);
    stripe.paymentMethods.detach.mockRejectedValueOnce(
      stripeError('StripeInvalidRequestError', 'resource_missing'),
    );

    const result = await redactStripeCustomer({
      stripe,
      customerId: CUSTOMER_ID,
      offboardingId: OFFBOARDING_ID,
    });

    expect(result.outcome).toBe('redacted');
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(2);
  });

  it('redactStripeCustomer rethrows a non-missing detach failure without clearing the customer', async () => {
    // The Customer must stay intact so a retry starts from a known state.
    const { stripe, state } = makeStripe({}, ['pm_1']);
    stripe.paymentMethods.detach.mockRejectedValueOnce(
      stripeError('StripeConnectionError'),
    );

    await expect(
      redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID }),
    ).rejects.toThrow();

    expect(stripe.customers.update).not.toHaveBeenCalled();
    expect(state.email).toBe('jordan@example.com');
  });

  it('redactStripeCustomer never calls customers.del', async () => {
    const { stripe } = makeStripe();

    await redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID });

    expect(stripe.customers.del).not.toHaveBeenCalled();
  });

  it('redactStripeCustomer returns already_redacted and issues no update when the customer is already cleared', async () => {
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

  it('redactStripeCustomer treats a resource_missing error as success', async () => {
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

  it('redactStripeCustomer treats a deleted customer returned by retrieve as success', async () => {
    const { stripe } = makeStripe({ deleted: true });

    const result = await redactStripeCustomer({
      stripe,
      customerId: CUSTOMER_ID,
      offboardingId: OFFBOARDING_ID,
    });

    expect(result.outcome).toBe('customer_absent');
    expect(stripe.customers.update).not.toHaveBeenCalled();
  });

  it('redactStripeCustomer rethrows a retryable Stripe error type', async () => {
    const { stripe } = makeStripe();
    stripe.customers.update.mockRejectedValueOnce(stripeError('StripeConnectionError'));

    await expect(
      redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID }),
    ).rejects.toThrow();
  });

  it('redactStripeCustomer rethrows a permanent Stripe error that is not resource_missing', async () => {
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

  it('redactStripeCustomer sends a deterministic idempotency key derived from the offboarding id', async () => {
    const { stripe } = makeStripe();

    await redactStripeCustomer({ stripe, customerId: CUSTOMER_ID, offboardingId: OFFBOARDING_ID });

    const [, , options] = stripe.customers.update.mock.calls[0]!;
    expect(options!.idempotencyKey).toBe(
      stripeCustomerRedactionIdempotencyKey(OFFBOARDING_ID),
    );
    expect(stripeCustomerRedactionIdempotencyKey(OFFBOARDING_ID)).toBe(
      stripeCustomerRedactionIdempotencyKey(OFFBOARDING_ID),
    );
  });
});

/**
 * The T0 meta-check. Plan round 1 finding 1: `pnpm test` is ordinary
 * `vitest run`, and a pending test does not make it fail — so a suite of
 * `.todo` titles would exit 0 with zero feature behaviour behind it. A pending
 * test is not a promise. This walks the feature's OWN test files and refuses
 * any of the three ways to write one.
 */
describe('feature test suite integrity', () => {
  // Every file this feature adds a promised test to, relative to the repo
  // root. Adding a file to allowed_edit_surface without adding it here would
  // let a pending test hide in it.
  const FEATURE_TEST_FILES = [
    'src/lib/account-offboarding/__tests__/stripe-customer-redaction.test.ts',
    'src/lib/account-offboarding/__tests__/table-disposition.test.ts',
    'src/lib/notifications/__tests__/email-templates.test.ts',
    'src/lib/legal/__tests__/content.test.ts',
    'src/lib/accounts/__tests__/billing-locks.test.ts',
    'src/lib/accounts/__tests__/billing-locks.integration.test.ts',
    'src/lib/payments/__tests__/create-checkout-session.test.ts',
    'worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts',
    'worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts',
    'worker/ingress/__tests__/shared.test.ts',
    'worker/ingress/__tests__/stripe.test.ts',
    'worker/ingress/__tests__/stripe-subscription-updated.test.ts',
    'worker/ingress/stripe/__tests__/apply-subscription-state.test.ts',
    'worker/ingress/stripe/__tests__/subscription-deleted-trial.test.ts',
    'worker/background/pollers/__tests__/ArchivalPoller.test.ts',
    'worker/background/pollers/health-alert/__tests__/checks.test.ts',
  ] as const;

  const REPO_ROOT = new URL('../../../../', import.meta.url);

  it('the feature test suite contains no todo or skipped tests', () => {
    const offenders: string[] = [];

    for (const relativePath of FEATURE_TEST_FILES) {
      const source = readFileSync(new URL(relativePath, REPO_ROOT), 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        // Comment lines are prose, not tests. Without this the check reports
        // its own documentation, which is a false positive that teaches the
        // next reader to ignore it.
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        // The two pending forms on it/describe, plus the conditional variants,
        // which are the same evasion wearing a predicate.
        if (/\b(it|test|describe)\.(todo|skip|skipIf|runIf)\b/.test(line)) {
          offenders.push(`${relativePath}:${index + 1}: ${trimmed}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
