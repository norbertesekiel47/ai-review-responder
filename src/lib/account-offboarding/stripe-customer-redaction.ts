// src/lib/account-offboarding/stripe-customer-redaction.ts
//
// Clears the identifying fields on an account's Stripe Customer during a
// delete_data purge, immediately before the local tombstone destroys the last
// copy of the customer id.
//
// The Customer is REDACTED, never DELETED. `customers.del` detaches every
// invoice from the customer and cannot be undone, which would destroy the
// financial record tax retention requires. Redaction reaches the same privacy
// outcome and leaves invoices and charges intact. `customers.del` is not
// referenced anywhere in this file, and a test asserts the injected client's
// `del` is never called.
//
// Two Stripe behaviours decide the shape of the single update below:
//
//   1. `metadata` MERGES. A caller that sends only the offboarding key leaves
//      every pre-existing key in place, which is why the retrieve is not
//      optional — it supplies the key set to unset.
//   2. An empty string CLEARS. Per the version-matched SDK (stripe@22.2.0,
//      apiVersion 2026-05-27.dahlia) `name`/`email`/`phone`/`description` are
//      plain `string`, while `address`/`shipping`/`business_name`/
//      `individual_name` are `Emptyable<T> = null | '' | T`. `''` clears all
//      eight, and `''` on a metadata VALUE deletes that key.
//
// Attached PaymentMethods are DETACHED as well as the Customer being cleared.
// `customers.update` cannot reach a PaymentMethod's own `billing_details` —
// name, email, phone, full address — nor its card `last4`/`fingerprint`. That
// data IS deletable, unlike an invoice, so leaving it would be an erasure gap
// rather than an unavoidable retention. Detaching is only possible here because
// teardown already cancelled the subscription; Stripe refuses to detach a
// method a live subscription depends on.
//
// What survives at Stripe, unavoidably: paid invoices with the billing name and
// address snapshotted onto them, and `tax_ids`, which is not a field
// `customers.update` can reach. `PROVIDER_DATA_RETENTION` in
// `table-disposition.ts` is the inventory that records this. The purge receipt
// and the privacy policy state the same categories; neither imports the
// inventory, so the three are kept in step by review, not by the compiler.

import {
  RETRYABLE_STRIPE_ERROR_TYPES,
  PERMANENT_STRIPE_ERROR_TYPES,
} from '../payments/stripe-error-inspect';
import {
  RETRYABLE_NETWORK_ERROR_CODES,
  errorStringProperty as stringProperty,
  errorNumberProperty as numberProperty,
} from '../shared/error-inspect';

/** The one metadata key a redacted Customer keeps, naming the offboarding. */
export const STRIPE_CUSTOMER_REDACTION_METADATA_KEY = 'repworth_redacted_offboarding_id';

/** The eight identifying fields one `customers.update` clears. */
const REDACTED_CUSTOMER_FIELDS = [
  'name',
  'email',
  'phone',
  'description',
  'address',
  'shipping',
  'business_name',
  'individual_name',
] as const;

export type StripeCustomerRedactionOutcome =
  | 'redacted'
  | 'already_redacted'
  | 'customer_absent';

type StripeCustomerRedactionOperation =
  | 'retrieve'
  | 'update'
  | 'list_payment_methods'
  | 'detach_payment_method';

export interface StripeCustomerLike {
  id: string;
  /**
   * `boolean | void` is not a mistake — it is the SDK's own shape. Stripe types
   * a live `Customer` as `deleted?: void` and a `DeletedCustomer` as
   * `deleted: true`, which is how it discriminates the union. Narrowing this to
   * `boolean` makes the real client structurally incompatible with this
   * interface, so the worker cannot pass `getStripe()` in at all. The
   * `=== true` test below reads correctly against both arms.
   */
  deleted?: boolean | void;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  description?: string | null;
  address?: unknown;
  shipping?: unknown;
  business_name?: string | null;
  individual_name?: string | null;
  metadata?: Record<string, string> | null;
}

/** One attached PaymentMethod, narrowed to the id detaching needs. */
export interface StripePaymentMethodLike {
  id: string;
}

export interface StripePaymentMethodListResult {
  data: StripePaymentMethodLike[];
  has_more: boolean;
}

/**
 * The narrow client this module declares for itself — customer `retrieve` +
 * `update`, and PaymentMethod `list` + `detach`. Domain modules receive their
 * clients as parameters (invariant #15); the worker resolves `getStripe()` at
 * its own boundary and passes it in, the way `teardown-stripe.ts` already does.
 *
 * The PaymentMethod half was added after review: `customers.update` clears the
 * Customer's own fields but CANNOT reach an attached PaymentMethod, which holds
 * its own `billing_details` — name, email, phone and full address — plus card
 * `last4` and `fingerprint`. Unlike a paid invoice that data is deletable, so
 * leaving it would have been an erasure gap in a feature whose entire purpose
 * is erasure, not merely an under-disclosure.
 */
export interface StripeCustomerRedactionClient {
  customers: {
    retrieve: (
      customerId: string,
      params?: Record<string, never>,
      requestOptions?: { maxNetworkRetries?: number },
    ) => Promise<StripeCustomerLike>;
    update: (
      customerId: string,
      params: Record<string, unknown>,
      requestOptions?: { idempotencyKey: string; maxNetworkRetries?: number },
    ) => Promise<StripeCustomerLike>;
  };
  paymentMethods: {
    list: (
      params: { customer: string; limit: number },
      requestOptions?: { maxNetworkRetries?: number },
    ) => Promise<StripePaymentMethodListResult>;
    detach: (
      paymentMethodId: string,
      params?: Record<string, never>,
      requestOptions?: { idempotencyKey: string; maxNetworkRetries?: number },
    ) => Promise<StripePaymentMethodLike>;
  };
}

export interface RedactStripeCustomerInput {
  stripe: StripeCustomerRedactionClient;
  customerId: string;
  offboardingId: string;
}

export interface RedactStripeCustomerResult {
  outcome: StripeCustomerRedactionOutcome;
}

interface StripeCustomerRedactionErrorDetails {
  type?: string;
  statusCode?: number;
  code?: string;
  requestId?: string;
}

/**
 * Carries the classification without the provider's message.
 *
 * `scrubOffboardingErrorForStorage` redacts emails, phone numbers and
 * credentials, but NOT a `cus_…` identifier, so a raw Stripe message would be
 * one route by which the id this stage exists to erase reaches `last_error`
 * and Sentry. A bounded message plus structured details tells an operator what
 * failed without re-persisting the handle.
 *
 * NO CODE READS `retryable`, `operation` or `stripeError` today — `PurgeWorker`
 * takes only `err.message`. They exist for the human reading a stored error,
 * not for a branch. An earlier version of this docblock named the worker's
 * failure sink as their consumer, which was simply untrue; if a future caller
 * does branch on `retryable`, that is the moment to give it a test.
 */
export class StripeCustomerRedactionError extends Error {
  readonly retryable: boolean;
  readonly operation: StripeCustomerRedactionOperation;
  readonly stripeError: StripeCustomerRedactionErrorDetails;

  constructor(input: {
    retryable: boolean;
    operation: StripeCustomerRedactionOperation;
    stripeError: StripeCustomerRedactionErrorDetails;
  }) {
    super(
      input.retryable
        ? `Stripe customer redaction hit a retryable Stripe error on ${input.operation}.`
        : `Stripe customer redaction hit a permanent Stripe error on ${input.operation}.`,
    );
    this.name = 'StripeCustomerRedactionError';
    this.retryable = input.retryable;
    this.operation = input.operation;
    this.stripeError = input.stripeError;
  }
}

/**
 * Deterministic per offboarding, so a BullMQ retry re-sends the SAME key and
 * Stripe replays its own answer rather than issuing a second write. Mirrors
 * `accountOffboardingTeardownStripeIdempotencyKey`. A UUID offboarding id
 * keeps this far under Stripe's 255-character limit, so no hash is needed.
 */
export function stripeCustomerRedactionIdempotencyKey(offboardingId: string): string {
  return `account-offboarding-purge:${offboardingId}:stripe-customer-redaction`;
}

export async function redactStripeCustomer(
  input: RedactStripeCustomerInput,
): Promise<RedactStripeCustomerResult> {
  const { stripe, customerId, offboardingId } = input;

  let customer: StripeCustomerLike;
  try {
    customer = await stripe.customers.retrieve(customerId);
  } catch (err) {
    if (isResourceMissing(err)) return { outcome: 'customer_absent' };
    throw redactionError(err, 'retrieve');
  }

  // A deleted Customer carries no identifying fields to clear, and updating it
  // fails. The identifiers are already gone, which is this stage's goal.
  if (customer.deleted === true) return { outcome: 'customer_absent' };

  if (isAlreadyRedacted(customer, offboardingId)) {
    return { outcome: 'already_redacted' };
  }

  // Detach BEFORE the update. A PaymentMethod carries its own billing_details —
  // name, email, phone, full address — plus card last4 and fingerprint, none of
  // which customers.update can reach. Detaching first means a failure here
  // leaves the Customer's own fields intact, so a retry re-runs the whole
  // sequence from a consistent state rather than from a half-cleared one.
  await detachPaymentMethods(stripe, customerId, offboardingId);

  try {
    await stripe.customers.update(
      customerId,
      buildRedactionParams(customer, offboardingId),
      { idempotencyKey: stripeCustomerRedactionIdempotencyKey(offboardingId) },
    );
  } catch (err) {
    if (isResourceMissing(err)) return { outcome: 'customer_absent' };
    throw redactionError(err, 'update');
  }

  return { outcome: 'redacted' };
}

/** One page is 100; a customer with more attached methods than this is not real. */
const PAYMENT_METHOD_PAGE_SIZE = 100;

/**
 * Detach every PaymentMethod attached to the Customer.
 *
 * Detaching is possible precisely because teardown has already cancelled the
 * subscription — Stripe refuses to detach a method a live subscription depends
 * on, and by this point none does. That is why this belongs to the purge and
 * not to teardown.
 *
 * A detached PaymentMethod keeps no link to the Customer, so its billing_details
 * stop being reachable from the account's Stripe record. This is the one part
 * of the surviving data that is genuinely deletable; invoices and tax_ids are
 * not, and `PROVIDER_DATA_RETENTION` records those instead.
 *
 * `resource_missing` on an individual detach is success: another attempt in the
 * same retry sequence already removed it.
 */
async function detachPaymentMethods(
  stripe: StripeCustomerRedactionClient,
  customerId: string,
  offboardingId: string,
): Promise<void> {
  let page: StripePaymentMethodListResult;
  try {
    page = await stripe.paymentMethods.list({
      customer: customerId,
      limit: PAYMENT_METHOD_PAGE_SIZE,
    });
  } catch (err) {
    if (isResourceMissing(err)) return;
    throw redactionError(err, 'list_payment_methods');
  }

  for (const method of page.data) {
    try {
      await stripe.paymentMethods.detach(method.id, undefined, {
        idempotencyKey: `${stripeCustomerRedactionIdempotencyKey(offboardingId)}:pm:${method.id}`,
      });
    } catch (err) {
      if (isResourceMissing(err)) continue;
      throw redactionError(err, 'detach_payment_method');
    }
  }
}

/**
 * One update, clearing all eight fields and every pre-existing metadata key,
 * then writing the single key that names the offboarding.
 */
function buildRedactionParams(
  customer: StripeCustomerLike,
  offboardingId: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of REDACTED_CUSTOMER_FIELDS) params[field] = '';

  // Merge semantics: each existing key must be named with an empty value to be
  // deleted. Sending `metadata: ''` would clear the object wholesale but also
  // discard the key being written in the same call.
  const metadata: Record<string, string> = {};
  for (const key of Object.keys(customer.metadata ?? {})) metadata[key] = '';
  metadata[STRIPE_CUSTOMER_REDACTION_METADATA_KEY] = offboardingId;
  params.metadata = metadata;

  return params;
}

function isAlreadyRedacted(
  customer: StripeCustomerLike,
  offboardingId: string,
): boolean {
  const marker = customer.metadata?.[STRIPE_CUSTOMER_REDACTION_METADATA_KEY];
  if (marker !== offboardingId) return false;
  return REDACTED_CUSTOMER_FIELDS.every((field) => isEmptyField(customer[field]));
}

function isEmptyField(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * `resource_missing` is the ONLY permanent error that means success. Mapping
 * every permanent type here would finalize a purge whose redaction silently
 * failed on bad parameters or bad credentials — the identifying fields would
 * still be live at Stripe with no local copy of the id left to retry with.
 */
function isResourceMissing(err: unknown): boolean {
  return stringProperty(err, 'code') === 'resource_missing';
}

function redactionError(
  err: unknown,
  operation: StripeCustomerRedactionOperation,
): StripeCustomerRedactionError {
  return new StripeCustomerRedactionError({
    retryable: isRetryableStripeError(err),
    operation,
    stripeError: {
      type: stringProperty(err, 'type'),
      statusCode: numberProperty(err, 'statusCode') ?? numberProperty(err, 'status'),
      code: stringProperty(err, 'code'),
      requestId: stringProperty(err, 'requestId'),
    },
  });
}

/**
 * BYTE-IDENTICAL to `stripe-invoices.ts`'s function of the same name, and that
 * duplication is deliberate rather than overlooked. `stripe-error-inspect.ts`
 * owns the type VOCABULARY and says in its own header that each consumer keeps
 * its own retry POLICY; two offboarding modules currently agree on that policy,
 * and collapsing them would make a future divergence in one a silent change to
 * the other. An earlier version of this comment claimed the policy was "this
 * module's own", which read as though it differed. It does not, today.
 *
 * Both arms throw. The classification rides on the thrown error so an operator
 * reading `last_error` can tell a Stripe outage from a misconfiguration without
 * parsing a provider message — nothing in the worker branches on it.
 */
function isRetryableStripeError(err: unknown): boolean {
  const type = stringProperty(err, 'type');
  if (type && RETRYABLE_STRIPE_ERROR_TYPES.has(type)) return true;
  if (type && PERMANENT_STRIPE_ERROR_TYPES.has(type)) return false;

  const statusCode = numberProperty(err, 'statusCode') ?? numberProperty(err, 'status');
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode <= 599) return true;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 499) return false;

  const code = stringProperty(err, 'code');
  return code ? RETRYABLE_NETWORK_ERROR_CODES.has(code) : false;
}
