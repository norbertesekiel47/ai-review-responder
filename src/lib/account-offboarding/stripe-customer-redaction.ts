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
// What survives at Stripe, deliberately: paid invoices with the billing name
// and address snapshotted onto them, and `tax_ids`, which is not a field
// `customers.update` can reach. `PROVIDER_DATA_RETENTION` in
// `table-disposition.ts` is the inventory that records this, and the purge
// receipt and privacy policy are written from it.

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

type StripeCustomerRedactionOperation = 'retrieve' | 'update';

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

/**
 * The narrow client this module declares for itself — `retrieve` + `update`
 * only. Domain modules receive their clients as parameters (invariant #15);
 * the worker resolves `getStripe()` at its own boundary and passes it in, the
 * way `teardown-stripe.ts` already does.
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
 * The retry POLICY is this module's own; only the type vocabulary is shared
 * (`payments/stripe-error-inspect.ts`). Both arms throw — the classification
 * exists so the purge worker's failure sink can tell a Stripe outage from a
 * misconfiguration without parsing a message.
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
