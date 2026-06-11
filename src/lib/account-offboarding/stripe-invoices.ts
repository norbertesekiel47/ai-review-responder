import { createHash } from 'node:crypto';
import {
  RETRYABLE_STRIPE_ERROR_TYPES,
  PERMANENT_STRIPE_ERROR_TYPES,
  RETRYABLE_NETWORK_ERROR_CODES,
  errorStringProperty as stringProperty,
  errorNumberProperty as numberProperty,
} from '../payments/stripe-error-inspect';

type StripeInvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
type StripeInvoiceCleanupOperation = 'list' | 'inspect' | 'finalize' | 'void';

export type StripeInvoiceCleanupAction =
  | 'finalized_and_voided'
  | 'voided'
  | 'already_void'
  | 'retained_paid'
  | 'skipped_subscription_mismatch';

export interface StripeInvoiceLike {
  id: string;
  status: string | null;
  subscription?: string | { id?: string | null } | null;
}

export interface StripeInvoiceListResult {
  data: StripeInvoiceLike[];
  has_more: boolean;
}

export interface StripeInvoiceCleanupClient {
  invoices: {
    list: (
      params: {
        subscription: string;
        limit: number;
        starting_after?: string;
      },
      requestOptions?: { maxNetworkRetries?: number },
    ) => Promise<StripeInvoiceListResult>;
    finalizeInvoice: (
      invoiceId: string,
      params: { auto_advance: false },
      requestOptions?: { idempotencyKey: string; maxNetworkRetries?: number },
    ) => Promise<StripeInvoiceLike>;
    voidInvoice: (
      invoiceId: string,
      params?: Record<string, never>,
      requestOptions?: { idempotencyKey: string; maxNetworkRetries?: number },
    ) => Promise<StripeInvoiceLike>;
  };
}

export interface CleanupSubscriptionInvoicesInput {
  stripe: StripeInvoiceCleanupClient;
  subscriptionId: string;
  operationScope: string;
  maxPages?: number;
  pageSize?: number;
  maxNetworkRetries?: number;
}

export interface StripeInvoiceCleanupActionResult {
  invoiceId: string;
  action: StripeInvoiceCleanupAction;
}

export interface CleanupSubscriptionInvoicesResult {
  subscriptionId: string;
  actions: StripeInvoiceCleanupActionResult[];
  summary: {
    inspected: number;
    finalized: number;
    voided: number;
    retained: number;
    skipped: number;
  };
}

interface StripeInvoiceCleanupErrorInput {
  message: string;
  retryable: boolean;
  operation: StripeInvoiceCleanupOperation;
  code: string;
  invoiceId?: string;
  stripeError?: StripeInvoiceCleanupErrorDetails;
}

export interface StripeInvoiceCleanupErrorDetails {
  type?: string;
  statusCode?: number;
  code?: string;
  requestId?: string;
}

export class StripeInvoiceCleanupError extends Error {
  readonly retryable: boolean;
  readonly operation: StripeInvoiceCleanupOperation;
  readonly code: string;
  readonly invoiceId?: string;
  readonly stripeError?: StripeInvoiceCleanupErrorDetails;

  constructor(input: StripeInvoiceCleanupErrorInput) {
    super(input.message);
    this.name = 'StripeInvoiceCleanupError';
    this.retryable = input.retryable;
    this.operation = input.operation;
    this.code = input.code;
    this.invoiceId = input.invoiceId;
    this.stripeError = input.stripeError;
  }
}

const STRIPE_INVOICE_CLEANUP_KEY_NAMESPACE = 'acct-offboarding.invoice-cleanup';
const MAX_STRIPE_IDEMPOTENCY_KEY_LENGTH = 255;
// Error-type sets, network codes, and property readers come from
// src/lib/payments/stripe-error-inspect.ts — the single owner of the Stripe
// error-inspection vocabulary. The retry POLICY here (isRetryableStripeError:
// all idempotency errors permanent) remains this module's own.
const DEFAULT_MAX_NETWORK_RETRIES = 2;
const MAX_NETWORK_RETRIES_CAP = 2;

export async function cleanupSubscriptionInvoices(
  input: CleanupSubscriptionInvoicesInput,
): Promise<CleanupSubscriptionInvoicesResult> {
  const maxPages = normalizePositiveInteger(input.maxPages, 10);
  const pageSize = Math.min(normalizePositiveInteger(input.pageSize, 100), 100);
  const maxNetworkRetries = normalizeMaxNetworkRetries(input.maxNetworkRetries);
  const result: CleanupSubscriptionInvoicesResult = {
    subscriptionId: input.subscriptionId,
    actions: [],
    summary: {
      inspected: 0,
      finalized: 0,
      voided: 0,
      retained: 0,
      skipped: 0,
    },
  };

  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const listParams: {
      subscription: string;
      limit: number;
      starting_after?: string;
    } = {
      subscription: input.subscriptionId,
      limit: pageSize,
    };
    if (startingAfter) listParams.starting_after = startingAfter;

    // cursor pagination loop: each page needs starting_after from the prior page (cannot parallelize)
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const pageResult = await listInvoices(input, listParams, maxNetworkRetries);
    for (const invoice of pageResult.data) {
      // rate-limited Stripe provider call: sequential to avoid Stripe rate-limit/429 bursts
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await cleanupInvoice(input, invoice, result, maxNetworkRetries);
    }

    if (!pageResult.has_more) return result;

    const lastInvoice = pageResult.data.at(-1);
    if (!lastInvoice?.id) {
      throw new StripeInvoiceCleanupError({
        message: 'Stripe invoice cleanup could not continue pagination without a cursor.',
        retryable: true,
        operation: 'list',
        code: 'pagination_cursor_missing',
      });
    }
    startingAfter = lastInvoice.id;
  }

  throw new StripeInvoiceCleanupError({
    message: 'Stripe invoice cleanup reached the bounded pagination limit.',
    retryable: true,
    operation: 'list',
    code: 'bounded_pagination_exhausted',
  });
}

async function listInvoices(
  input: CleanupSubscriptionInvoicesInput,
  params: {
    subscription: string;
    limit: number;
    starting_after?: string;
  },
  maxNetworkRetries: number,
): Promise<StripeInvoiceListResult> {
  try {
    return await input.stripe.invoices.list(params, requestOptions(maxNetworkRetries));
  } catch (err) {
    throw stripeError({
      err,
      operation: 'list',
    });
  }
}

async function cleanupInvoice(
  input: CleanupSubscriptionInvoicesInput,
  invoice: StripeInvoiceLike,
  result: CleanupSubscriptionInvoicesResult,
  maxNetworkRetries: number,
): Promise<void> {
  result.summary.inspected += 1;

  if (invoiceSubscriptionId(invoice) !== input.subscriptionId) {
    recordAction(result, invoice.id, 'skipped_subscription_mismatch');
    result.summary.skipped += 1;
    return;
  }

  const status = invoice.status;
  if (!isKnownInvoiceStatus(status)) {
    throw new StripeInvoiceCleanupError({
      message: `Stripe invoice cleanup found an unsupported invoice status: ${status ?? 'null'}.`,
      retryable: false,
      operation: 'inspect',
      invoiceId: invoice.id,
      code: 'invalid_invoice_status',
    });
  }

  if (status === 'draft') {
    await cleanupDraftInvoice(input, invoice, result, maxNetworkRetries);
    return;
  }

  if (status === 'open' || status === 'uncollectible') {
    await voidInvoice(input, invoice.id, maxNetworkRetries);
    recordAction(result, invoice.id, 'voided');
    result.summary.voided += 1;
    return;
  }

  if (status === 'void') {
    recordAction(result, invoice.id, 'already_void');
    result.summary.retained += 1;
    return;
  }

  recordAction(result, invoice.id, 'retained_paid');
  result.summary.retained += 1;
}

async function cleanupDraftInvoice(
  input: CleanupSubscriptionInvoicesInput,
  invoice: StripeInvoiceLike,
  result: CleanupSubscriptionInvoicesResult,
  maxNetworkRetries: number,
): Promise<void> {
  const finalized = await finalizeInvoice(input, invoice.id, maxNetworkRetries);
  result.summary.finalized += 1;

  if (finalized.status === 'open' || finalized.status === 'uncollectible') {
    await voidInvoice(input, invoice.id, maxNetworkRetries);
    recordAction(result, invoice.id, 'finalized_and_voided');
    result.summary.voided += 1;
    return;
  }

  if (finalized.status === 'void') {
    recordAction(result, invoice.id, 'already_void');
    result.summary.retained += 1;
    return;
  }

  if (finalized.status === 'paid') {
    recordAction(result, invoice.id, 'retained_paid');
    result.summary.retained += 1;
    return;
  }

  throw new StripeInvoiceCleanupError({
    message: `Stripe invoice cleanup received an unsupported finalized status: ${finalized.status ?? 'null'}.`,
    retryable: false,
    operation: 'finalize',
    invoiceId: invoice.id,
    code: 'unexpected_finalized_status',
  });
}

async function finalizeInvoice(
  input: CleanupSubscriptionInvoicesInput,
  invoiceId: string,
  maxNetworkRetries: number,
): Promise<StripeInvoiceLike> {
  try {
    return await input.stripe.invoices.finalizeInvoice(
      invoiceId,
      { auto_advance: false },
      mutationRequestOptions(input, invoiceId, 'finalize', maxNetworkRetries),
    );
  } catch (err) {
    throw stripeError({
      err,
      operation: 'finalize',
      invoiceId,
    });
  }
}

async function voidInvoice(
  input: CleanupSubscriptionInvoicesInput,
  invoiceId: string,
  maxNetworkRetries: number,
): Promise<void> {
  let voided: StripeInvoiceLike;
  try {
    voided = await input.stripe.invoices.voidInvoice(
      invoiceId,
      {},
      mutationRequestOptions(input, invoiceId, 'void', maxNetworkRetries),
    );
  } catch (err) {
    throw stripeError({
      err,
      operation: 'void',
      invoiceId,
    });
  }

  if (voided.status !== 'void') {
    throw new StripeInvoiceCleanupError({
      message: `Stripe invoice cleanup received an unsupported void result status: ${voided.status ?? 'null'}.`,
      retryable: false,
      operation: 'void',
      invoiceId,
      code: 'unexpected_void_status',
    });
  }
}

function mutationRequestOptions(
  input: CleanupSubscriptionInvoicesInput,
  invoiceId: string,
  operation: 'finalize' | 'void',
  maxNetworkRetries: number,
) {
  return {
    idempotencyKey: stripeInvoiceCleanupIdempotencyKey({
      operationScope: input.operationScope,
      subscriptionId: input.subscriptionId,
      invoiceId,
      operation,
    }),
    maxNetworkRetries,
  };
}

function requestOptions(maxNetworkRetries: number) {
  return { maxNetworkRetries };
}

function stripeInvoiceCleanupIdempotencyKey(input: {
  operationScope: string;
  subscriptionId: string;
  invoiceId: string;
  operation: 'finalize' | 'void';
}): string {
  const key = [
    STRIPE_INVOICE_CLEANUP_KEY_NAMESPACE,
    input.operationScope,
    input.subscriptionId,
    input.invoiceId,
    input.operation,
  ].join(':');
  if (key.length <= MAX_STRIPE_IDEMPOTENCY_KEY_LENGTH) return key;

  const digest = createHash('sha256').update(key).digest('hex');
  return [
    STRIPE_INVOICE_CLEANUP_KEY_NAMESPACE,
    'hashed',
    input.operation,
    digest,
  ].join(':');
}

function recordAction(
  result: CleanupSubscriptionInvoicesResult,
  invoiceId: string,
  action: StripeInvoiceCleanupAction,
): void {
  result.actions.push({ invoiceId, action });
}

function invoiceSubscriptionId(invoice: StripeInvoiceLike): string | null {
  if (typeof invoice.subscription === 'string') return invoice.subscription;
  if (invoice.subscription && typeof invoice.subscription.id === 'string') {
    return invoice.subscription.id;
  }
  return null;
}

function isKnownInvoiceStatus(status: string | null): status is StripeInvoiceStatus {
  return (
    status === 'draft'
    || status === 'open'
    || status === 'paid'
    || status === 'uncollectible'
    || status === 'void'
  );
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeMaxNetworkRetries(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_NETWORK_RETRIES;
  }
  return Math.min(Math.floor(value), MAX_NETWORK_RETRIES_CAP);
}

function stripeError(input: {
  err: unknown;
  operation: StripeInvoiceCleanupOperation;
  invoiceId?: string;
}): StripeInvoiceCleanupError {
  const retryable = isRetryableStripeError(input.err);
  return new StripeInvoiceCleanupError({
    message: retryable
      ? 'Stripe invoice cleanup hit a retryable Stripe error.'
      : 'Stripe invoice cleanup hit a permanent Stripe error.',
    retryable,
    operation: input.operation,
    invoiceId: input.invoiceId,
    code: retryable ? 'stripe_retryable_error' : 'stripe_permanent_error',
    stripeError: stripeErrorDetails(input.err),
  });
}

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

function stripeErrorDetails(err: unknown): StripeInvoiceCleanupErrorDetails {
  return {
    type: stringProperty(err, 'type'),
    statusCode: numberProperty(err, 'statusCode') ?? numberProperty(err, 'status'),
    code: stringProperty(err, 'code'),
    requestId: stringProperty(err, 'requestId'),
  };
}
