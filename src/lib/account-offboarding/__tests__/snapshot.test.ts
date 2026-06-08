import { describe, expect, it, vi } from 'vitest';
import { captureAccountOffboardingSnapshot } from '../snapshot';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const LOCATION_ID = '33333333-3333-4333-8333-333333333333';

// Minimal tagged-template stub for the snapshot's four reads. The businesses
// location read returns a location only when the account still has an ACTIVE
// location, or when archived locations were explicitly requested (delete_data).
function makeTx(opts: { archivedOnlyAccount?: boolean } = {}) {
  const tx: any = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM accounts')) {
      return Promise.resolve([{ stripe_customer_id: null, stripe_subscription_id: null }]);
    }
    if (text.includes('FROM users')) {
      return Promise.resolve([{ auth_id: 'auth-user-1', email: 'owner@example.com' }]);
    }
    if (text.includes('zernio_connections')) {
      return Promise.resolve([{ zernio_account_ids: [], zernio_profile_ids: [] }]);
    }
    if (text.includes('FROM businesses') && text.includes('location_ids')) {
      const includeArchived = values.includes(true);
      const hasLocation = includeArchived || !opts.archivedOnlyAccount;
      return Promise.resolve([{ location_ids: hasLocation ? [LOCATION_ID] : [] }]);
    }
    return Promise.resolve([]);
  });
  return tx;
}

describe('captureAccountOffboardingSnapshot — location capture (L5)', () => {
  it('blocks when the account has only archived locations and archived are not requested', async () => {
    const result = await captureAccountOffboardingSnapshot(makeTx({ archivedOnlyAccount: true }), {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      requireStripeCustomerId: false,
      requireStripeSubscriptionId: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missingFields).toContain('location_ids');
  });

  it('captures an archived location when includeArchivedLocations is set, so a never-activated / all-archived account can still delete_data', async () => {
    const result = await captureAccountOffboardingSnapshot(makeTx({ archivedOnlyAccount: true }), {
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      requireStripeCustomerId: false,
      requireStripeSubscriptionId: false,
      includeArchivedLocations: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.locationIds).toEqual([LOCATION_ID]);
  });
});
