// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement as h, type ReactElement } from 'react';
import { LocationProvider } from '@/contexts/LocationContext';
import { OwnerIdentityProvider } from '@/contexts/OwnerIdentityContext';
import type { LocationId } from '@/lib/shared/ids';
import type { OwnerReviewQrLocation } from '@/lib/locations/review-qr';

// The **Review QR** page is a server component with a DB read. #1092 moved it
// from Settings to Requests, and the move rewrites every line, so the page went
// from "never executed by a test" to "the largest uncovered block on the
// branch". Executing it here is worth more than a source-scan: it is the only
// assertion that the moved page still mounts its three parts, and it pins the
// routed pill bar the mobile path depends on.

const { requireOwnerAccessMock, getLocationsMock, watchEnabledMock } = vi.hoisted(() => ({
  requireOwnerAccessMock: vi.fn(),
  getLocationsMock: vi.fn(),
  watchEnabledMock: vi.fn<() => boolean>(() => true),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: { signOut: vi.fn().mockResolvedValue({ error: null }) },
  }),
}));
vi.mock('@/lib/db/server', () => ({ sql: {} }));
vi.mock('@/lib/solicitation/flags', () => ({
  solicitationWatchEnabled: watchEnabledMock,
}));
vi.mock('@/lib/auth/require-owner-access', () => ({
  requireOwnerAccess: requireOwnerAccessMock,
}));
vi.mock('@/lib/locations/review-qr', () => ({
  getOwnerReviewQrLocations: getLocationsMock,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/requests/qr',
}));

import ReviewQrPage from '../page';

const LOCATION: OwnerReviewQrLocation = {
  businessId: '019db8c1-c3f4-7668-b353-2b8b718ec603',
  displayName: 'Acme',
  qrTargetUrl: 'https://app.example.com/q/019db8c1-c3f4-7668-b353-2b8b718ec603',
  qrDataUrl: 'data:image/png;base64,QQ==',
  ineligibleReason: null,
};

const LOC_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as LocationId;

/** TopBar reads the location scope and the owner identity from context. */
function withProviders(ui: ReactElement) {
  return h(
    OwnerIdentityProvider,
    {
      name: 'Maya Chen',
      email: 'maya@bristolbay.co',
      children: h(LocationProvider, {
        locations: [
          { id: LOC_A, name: 'Acme', displayLabel: null, isPrimary: true },
        ],
        initialScope: LOC_A,
        multiLocationEnabled: false,
        children: ui,
      }),
    },
  );
}

beforeEach(() => {
  requireOwnerAccessMock.mockReset();
  requireOwnerAccessMock.mockResolvedValue({ accountId: 'acct-1' });
  getLocationsMock.mockReset();
  getLocationsMock.mockResolvedValue([LOCATION]);
  watchEnabledMock.mockReset();
  watchEnabledMock.mockReturnValue(true);
});

describe('the moved Review QR page', () => {
  it('renders the Review QR surface at its new home', async () => {
    render(withProviders(await ReviewQrPage()));
    // The TopBar subtitle, not the title: since #1092 the title string "Review
    // QR" also names the routed pill, so it is no longer unique on this page.
    expect(
      screen.getByText(/printable qr codes that send customers/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('renders the routed pill bar, which is the only mobile path to its siblings', async () => {
    // Below 768px `.sidebar` is hidden, so without this bar the moved surface
    // would be a dead end on every phone (#1089).
    const { container } = render(withProviders(await ReviewQrPage()));
    expect(container.querySelector('.tabs--routed')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Contacts' })).toHaveAttribute(
      'href',
      '/dashboard/requests/contacts',
    );
    expect(screen.getByRole('link', { name: 'Review QR' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('offers no pills at all when watch-mode is off, rather than dead ones', async () => {
    // This page is ungated because Review QR is visible to every owner, but
    // `/dashboard/requests` and its contacts child both notFound() with the
    // flag off. An ungated bar would offer two links to nowhere — the standard
    // ReviewQrClient states as "no owner may ever get a dead link".
    watchEnabledMock.mockReturnValue(false);
    const { container } = render(withProviders(await ReviewQrPage()));
    expect(container.querySelector('.tabs--routed')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Contacts' })).not.toBeInTheDocument();
    // The surface itself still renders — the page is NOT flag-gated.
    expect(
      screen.getByText(/printable qr codes that send customers/i),
    ).toBeInTheDocument();
  });

  it('scopes the location read to the owner account the access check returned', async () => {
    // Invariant #8: every owner read is scoped by account_id. A page that reads
    // some other account's locations is a tenant leak, not a display bug.
    await ReviewQrPage();
    expect(requireOwnerAccessMock).toHaveBeenCalledOnce();
    expect(getLocationsMock).toHaveBeenCalledWith({}, 'acct-1', expect.any(String));
  });

  it('renders with no locations without throwing', async () => {
    getLocationsMock.mockResolvedValue([]);
    render(withProviders(await ReviewQrPage()));
    expect(
      screen.getByText(/printable qr codes that send customers/i),
    ).toBeInTheDocument();
  });
});
