import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const STATUS_WRITERS = [
  'worker/ingress/stripe/apply-subscription-state.ts',
  'worker/ingress/stripe/invoice-payment-failed.ts',
  'worker/ingress/stripe/invoice-paid.ts',
  'worker/ingress/stripe/subscription-deleted.ts',
  'worker/ingress/stripe/subscription-updated.ts',
  'worker/background/pollers/billing-reconciliation/reconcile-account.ts',
] as const;

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('Stripe status-writer lock-order tripwire', () => {
  it.each(STATUS_WRITERS)('%s never writes the business mirror or takes the removed status lock', (path) => {
    const text = source(path);
    expect(text).not.toMatch(/UPDATE\s+businesses/i);
    expect(text).not.toContain(':status_change');
  });

  it.each([
    'worker/ingress/stripe/invoice-payment-failed.ts',
    'worker/ingress/stripe/invoice-paid.ts',
    'worker/ingress/stripe/subscription-deleted.ts',
    'worker/background/pollers/billing-reconciliation/reconcile-account.ts',
  ])('%s acquires entitlement, then rechecks lineage on the locked row, then applies', (path) => {
    const text = source(path);
    const lock = text.indexOf('await acquireTierEntitlementLock(');
    const lineage = text.indexOf('lockAccountForStripeLineage(', lock);
    const apply = text.indexOf('applyStripeSubscriptionState(', lineage);
    expect(lock).toBeGreaterThan(-1);
    expect(lineage).toBeGreaterThan(lock);
    expect(apply).toBeGreaterThan(lineage);
    expect(text).not.toContain('UnderEntitlementLock');
  });

  it('the applier never takes the entitlement lock and never re-resolves by lineage', () => {
    const text = source('worker/ingress/stripe/apply-subscription-state.ts');
    expect(text).not.toContain('acquireTierEntitlementLock');
    expect(text).not.toMatch(/WHERE\s+(?:a\.)?stripe_customer_id\s*=/);
    expect(text).not.toMatch(/mode:\s*'(?:checkout|subscription)'/);
  });

  it.each([
    'export async function applyStripeSubscriptionState(',
    'export async function lockAccountForStripeLineage(',
  ])('%s takes the customer binding lock before the account row lock, by account id', (signature) => {
    const text = source('worker/ingress/stripe/apply-subscription-state.ts');
    const start = text.indexOf(signature);
    const end = text.indexOf('\n}', start);
    const body = text.slice(start, end);
    const binding = body.indexOf('acquireStripeCustomerBindingLock(');
    const rowLock = body.indexOf('FOR UPDATE');
    expect(start).toBeGreaterThan(-1);
    expect(binding).toBeGreaterThan(-1);
    expect(rowLock).toBeGreaterThan(binding);
    expect(body.slice(binding, rowLock)).toMatch(/WHERE (?:a\.)?id = \$\{accountId\}::uuid/);
  });

  it.each([
    'worker/ingress/stripe/invoice-payment-failed.ts',
    'worker/ingress/stripe/invoice-paid.ts',
  ])('%s acquires entitlement before its bounded provider-current retrieval', (path) => {
    const text = source(path);
    const transaction = text.indexOf('await sql.begin(');
    const entitlement = text.indexOf('await acquireTierEntitlementLock(', transaction);
    const retrieve = text.indexOf('.subscriptions.retrieve(', entitlement);
    const apply = text.indexOf('lockAccountForStripeLineage(', retrieve);
    expect(transaction).toBeGreaterThan(-1);
    expect(entitlement).toBeGreaterThan(transaction);
    expect(retrieve).toBeGreaterThan(entitlement);
    expect(apply).toBeGreaterThan(retrieve);
    expect(text.slice(retrieve, apply)).toContain('timeout: STRIPE_STATUS_READ_TIMEOUT_MS');
  });

  it('invoice.paid has no pre-lock status early return', () => {
    const text = source('worker/ingress/stripe/invoice-paid.ts');
    const transaction = text.indexOf('await sql.begin(');
    const prefix = text.slice(0, transaction);
    expect(prefix).not.toContain('subscription_status');
    expect(prefix).not.toContain('SubscriptionStatus.');
  });

  it('corrective reconciliation re-retrieves under entitlement before applying status', () => {
    const text = source('worker/background/pollers/billing-reconciliation/reconcile-account.ts');
    const correction = text.indexOf('if (dbTrialing && !stripeTrialing');
    const entitlement = text.indexOf('await acquireTierEntitlementLock(', correction);
    const retrieve = text.indexOf('stripe.subscriptions.retrieve(', entitlement);
    const apply = text.indexOf('lockAccountForStripeLineage(', retrieve);
    expect(correction).toBeGreaterThan(-1);
    expect(entitlement).toBeGreaterThan(correction);
    expect(retrieve).toBeGreaterThan(entitlement);
    expect(apply).toBeGreaterThan(retrieve);
    expect(text.slice(retrieve, apply)).toContain('timeout: STRIPE_READ_TIMEOUT_MS');
  });
});
