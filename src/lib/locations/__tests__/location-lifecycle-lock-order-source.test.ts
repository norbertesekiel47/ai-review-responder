import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), 'utf8');
}

function segment(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing production marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  expect(end, `missing production marker: ${endMarker ?? 'EOF'}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectOrder(source: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker, previous + 1);
    expect(index, `missing/out-of-order production marker: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('location lifecycle production lock-order binding', () => {
  it('binds add and every archive/teardown path to the account-scoped lifecycle mutex', () => {
    const addSource = read('../add-location-tx.ts');
    const archiveSource = read('../archive-location-tx.ts');
    const teardownSource = read('../../../../worker/jobs/account-offboarding/teardown-locations.ts');

    expectOrder(segment(addSource, 'await sql.begin(async (tx)'), [
      'acquireLocationLifecycleLock(tx, accountId)',
      'INSERT INTO businesses',
    ]);

    const archiveContext = segment(
      archiveSource,
      'async function lockArchiveContext',
      '// One UPDATE serves both the owner and teardown paths.',
    );
    expectOrder(archiveContext, [
      'acquireLocationLifecycleLock(tx, accountId)',
      'FROM businesses',
      'ORDER BY id',
      'FOR UPDATE',
      'FROM accounts',
      'FOR UPDATE',
    ]);

    expect(teardownSource).toContain('archiveLocationForAccountOffboardingTeardownTransaction');
    expect(teardownSource).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?businesses/i);
  });

  it('binds reactivate and promote to lifecycle -> ordered business rows -> account', () => {
    const archiveSource = read('../archive-location-tx.ts');
    const promoteSource = read('../promote-primary-tx.ts');

    const reactivate = segment(
      archiveSource,
      'export async function reactivateLocationTransaction',
    );
    expectOrder(reactivate, [
      'acquireLocationLifecycleLock(tx, accountId)',
      'SELECT id, archived_at',
      'FROM businesses',
      'ORDER BY id',
      'FOR UPDATE',
      'SELECT id, subscription_tier, subscription_activated_at',
      'FROM accounts',
      'FOR UPDATE',
    ]);

    const promote = segment(promoteSource, 'export async function promotePrimaryTransaction');
    expectOrder(promote, [
      'acquireLocationLifecycleLock(tx, accountId)',
      'FROM businesses',
      'ORDER BY id',
      'FOR UPDATE',
      'FROM accounts',
      'FOR UPDATE',
    ]);
  });

  it('binds cancellation teardown to lifecycle -> ordered business rows -> mutation', () => {
    const source = read('../../../../worker/background/pollers/CancellationGracePoller.ts');
    const actor = segment(source, 'await sql.begin(async (tx)');
    expectOrder(actor, [
      'acquireLocationLifecycleLock(tx, account_id)',
      'FROM businesses',
      'ORDER BY id',
      'FOR UPDATE',
      'UPDATE businesses',
    ]);
  });

  it('keeps publisher and mirror anchors in business -> entitlement order', () => {
    const publisherSource = read('../../../../worker/jobs/publisher/auto-policy-publish.ts');
    const mirrorSource = read('../../../../worker/jobs/billing/StripeSubscriptionMirrorSyncWorker.ts');

    const publisher = segment(publisherSource, 'async function lockLane', 'async function lockProviderAttemptMarkerRow');
    expectOrder(publisher, [
      'FROM businesses',
      'FOR UPDATE',
      'acquireTierEntitlementLock(tx, business.account_id)',
    ]);

    const mirror = segment(mirrorSource, 'export async function handleStripeSubscriptionMirrorSync');
    expectOrder(mirror, [
      'FROM businesses',
      'ORDER BY id',
      'FOR UPDATE',
      'acquireTierEntitlementLock(tx, accountId)',
    ]);
  });
});
