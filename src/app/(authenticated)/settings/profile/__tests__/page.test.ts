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
//  3. It runs the Solicitation watch-mode gate. The address is a Solicitation
//     artefact — it exists only to footer an ask — so the panel rides that
//     master switch. Its visibility used to key on `readPostalAddressState`
//     returning null, but that returns null only for a MISSING business row,
//     never for a disabled feature: "no row" was standing in for "feature off",
//     which it cannot do, and the panel rendered for EVERY owner with the flag
//     off. PUT /api/settings/postal-address runs the identical gate, so the
//     panel and its writer appear and disappear together.

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
  // Both cases below exercise the ENABLED surface. Without this the gate would
  // short-circuit them and the file would assert the gate twice over instead of
  // the location-scoping it was written for. The gate's own coverage clears it.
  process.env.SOLICITATION_WATCH_ENABLED = 'true';
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

describe('settings/profile page - solicitation watch-mode gate', () => {
  beforeEach(() => {
    delete process.env.SOLICITATION_WATCH_ENABLED;
  });

  it('hides the panel and skips the read entirely when the flag is off', async () => {
    readPostalAddressState.mockResolvedValue({ address: '77 Rainey St' });
    const { default: ProfilePage } = await import('../page');
    const { ProfileClient } = await import('../ProfileClient');

    const tree = (await ProfilePage()) as ReactElement<{ children: ReactElement[] }>;
    const clientElement = tree.props.children.find((child) => child.type === ProfileClient);

    expect((clientElement?.props as { postalAddress: unknown }).postalAddress).toBeNull();
    // Asserting only the prop would let a version that reads and then discards
    // pass. A disabled feature costs no query.
    expect(readPostalAddressState).not.toHaveBeenCalled();
  });

  it('treats every non-exact value as off, matching readFlag', async () => {
    // readFlag accepts the literal 'true' and nothing else. A deploy that set
    // 'TRUE' or '1' meaning to enable the surface must still get the hidden
    // panel — silently half-enabling it is the failure this pins.
    const { default: ProfilePage } = await import('../page');
    const { ProfileClient } = await import('../ProfileClient');

    for (const value of ['TRUE', '1', 'yes', 'false', '']) {
      process.env.SOLICITATION_WATCH_ENABLED = value;
      const tree = (await ProfilePage()) as ReactElement<{ children: ReactElement[] }>;
      const clientElement = tree.props.children.find((child) => child.type === ProfileClient);
      expect(
        (clientElement?.props as { postalAddress: unknown }).postalAddress,
        `value ${JSON.stringify(value)}`,
      ).toBeNull();
    }
    expect(readPostalAddressState).not.toHaveBeenCalled();
  });
});
