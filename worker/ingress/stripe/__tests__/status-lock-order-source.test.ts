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
  ])('%s explicitly acquires entitlement before using the under-lock applier', (path) => {
    const text = source(path);
    const lock = text.indexOf('await acquireTierEntitlementLock(');
    const apply = text.indexOf('applyStripeSubscriptionStateUnderEntitlementLock(', lock);
    expect(lock).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(lock);
    expect(text).not.toMatch(/applyStripeSubscriptionState\s*\(/);
  });

  it('generic applier resolves identity before entitlement and locks the account only afterward', () => {
    const text = source('worker/ingress/stripe/apply-subscription-state.ts');
    const genericStart = text.indexOf('export async function applyStripeSubscriptionState(');
    const resolveId = text.indexOf('resolveAccountId(tx, ref)', genericStart);
    const entitlement = text.indexOf('acquireTierEntitlementLock(tx, accountId)', resolveId);
    const lockedRead = text.indexOf('applyStripeSubscriptionStateInternal(tx, accountId, ref, stripeSub)', entitlement);
    expect(genericStart).toBeGreaterThan(-1);
    expect(resolveId).toBeGreaterThan(genericStart);
    expect(entitlement).toBeGreaterThan(resolveId);
    expect(lockedRead).toBeGreaterThan(entitlement);
  });

  it('under-entitlement applier requires its locked account id and never re-resolves lineage', () => {
    const text = source('worker/ingress/stripe/apply-subscription-state.ts');
    const start = text.indexOf('export async function applyStripeSubscriptionStateUnderEntitlementLock(');
    const end = text.indexOf('\n}', start);
    const body = text.slice(start, end);
    expect(body).toContain('lockedAccountId: string');
    expect(body).toContain('applyStripeSubscriptionStateInternal(tx, lockedAccountId, ref, stripeSub)');
    expect(body).not.toContain('resolveAccountId(');
  });

  it.each([
    'worker/ingress/stripe/invoice-payment-failed.ts',
    'worker/ingress/stripe/invoice-paid.ts',
  ])('%s retrieves provider-current subscription before opening the write transaction', (path) => {
    const text = source(path);
    const retrieve = text.indexOf('.subscriptions.retrieve(');
    const transaction = text.indexOf('await sql.begin(', retrieve);
    expect(retrieve).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(retrieve);
  });
});
