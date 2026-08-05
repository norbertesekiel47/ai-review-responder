import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// settings/profile/page.tsx is the composition root for the Attested postal
// address read (#656 T5). Two facts are worth a test rather than a comment,
// because getting either wrong is invisible in a single-location account and
// wrong in every multi-location one:
//
//  1. It reads the CURRENT location — the `rw_location_scope` cookie resolved
//     by requireOwnerAccess — not the account's primary location. The PUT route
//     resolves the same cookie, so a mismatch here would show one location's
//     address while writing another's (review round 1 finding).
//  2. It scopes the read by the guard's accountId and passes the `sql`
//     singleton down, since the domain module never imports it (invariant #15).

const readPostalAddressState = vi.fn();
const requireOwnerAccess = vi.fn();

vi.mock('@/lib/db/server', () => ({ sql: { __marker: 'sql-singleton' } }));
vi.mock('@/lib/auth/require-owner-access', () => ({
  requireOwnerAccess: (...args: unknown[]) => requireOwnerAccess(...args),
}));
vi.mock('@/lib/solicitation/postal-address', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/solicitation/postal-address')>()),
  readPostalAddressState: (...args: unknown[]) => readPostalAddressState(...args),
}));
vi.mock('../ProfileClient', () => ({
  ProfileClient: function ProfileClient() {
    return null;
  },
}));

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const PRIMARY_LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const CURRENT_LOCATION_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  requireOwnerAccess.mockReset();
  readPostalAddressState.mockReset();
  requireOwnerAccess.mockResolvedValue({
    accountId: ACCOUNT_ID,
    currentLocationId: CURRENT_LOCATION_ID,
    role: 'owner',
  });
  readPostalAddressState.mockResolvedValue(null);
});

describe('settings/profile page', () => {
  it('reads the postal-address state for the cookie-resolved active location', async () => {
    const { default: ProfilePage } = await import('../page');

    await ProfilePage();

    expect(readPostalAddressState).toHaveBeenCalledTimes(1);
    const [client, params] = readPostalAddressState.mock.calls[0] as [
      unknown,
      { accountId: string; businessId: string },
    ];
    expect(client).toEqual({ __marker: 'sql-singleton' });
    expect(params).toEqual({ accountId: ACCOUNT_ID, businessId: CURRENT_LOCATION_ID });
    expect(params.businessId).not.toBe(PRIMARY_LOCATION_ID);
  });

  it('passes the fetched state to ProfileClient', async () => {
    const state = {
      address: '77 Rainey St\nAustin, TX 78701',
      attestedAt: '2026-08-01T12:00:00.000Z',
      attestationVersion: 'postal_address_attestation_v1',
      suggestion: null,
    };
    readPostalAddressState.mockResolvedValue(state);
    const { default: ProfilePage } = await import('../page');
    const { ProfileClient } = await import('../ProfileClient');

    const tree = (await ProfilePage()) as ReactElement<{ children: ReactElement[] }>;
    const clientElement = tree.props.children.find((child) => child.type === ProfileClient);

    expect(clientElement).toBeDefined();
    expect((clientElement?.props as { postalAddress: unknown }).postalAddress).toEqual(state);
  });
});
