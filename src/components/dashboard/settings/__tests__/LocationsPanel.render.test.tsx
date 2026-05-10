// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LocationsPanel, type LocationEntry } from '../LocationsPanel';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRIMARY_LOCATION_ID = '11111111-1111-4111-8111-111111111111';
const SECONDARY_LOCATION_ID = '22222222-2222-4222-8222-222222222222';

function location(overrides: Partial<LocationEntry>): LocationEntry {
  return {
    id: PRIMARY_LOCATION_ID,
    name: 'Testing Business',
    displayLabel: null,
    address: null,
    isPrimary: true,
    googlePlaceId: 'place-primary',
    zernioStatus: 'active',
    pendingApprovalCount: 0,
    ...overrides,
  };
}

describe('LocationsPanel connection action', () => {
  it('shows a Connect Google action for an unconnected secondary location', () => {
    render(
      <LocationsPanel
        locations={[
          location({}),
          location({
            id: SECONDARY_LOCATION_ID,
            name: 'Tanicia',
            displayLabel: 'Tanicia',
            isPrimary: false,
            googlePlaceId: 'place-secondary',
            zernioStatus: 'none',
          }),
        ]}
        archivedLocations={[]}
        activeCount={2}
        accountId={ACCOUNT_ID}
        onLocationChange={() => {}}
      />,
    );

    const connectLink = screen.getByRole('link', { name: /connect google/i });
    expect(connectLink).toHaveAttribute(
      'href',
      `/dashboard/connect?locationId=${SECONDARY_LOCATION_ID}`,
    );
  });

  it('shows a Reconnect Google action for a disconnected location', () => {
    render(
      <LocationsPanel
        locations={[
          location({
            id: SECONDARY_LOCATION_ID,
            name: 'Tanicia',
            displayLabel: 'Tanicia',
            isPrimary: false,
            zernioStatus: 'disconnected',
          }),
        ]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        onLocationChange={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: /reconnect google/i })).toHaveAttribute(
      'href',
      `/dashboard/connect?locationId=${SECONDARY_LOCATION_ID}`,
    );
  });
});
