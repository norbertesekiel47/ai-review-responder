// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  it('uses the configured brand voice anchor for single-location accounts', () => {
    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        voiceHref="/settings#brand-voice"
        onLocationChange={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: /^voice$/i })).toHaveAttribute(
      'href',
      '/settings#brand-voice',
    );
  });

  it('defaults the Voice action to the multi-location voice page', () => {
    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        onLocationChange={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: /^voice$/i })).toHaveAttribute(
      'href',
      '/settings/voice',
    );
  });

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

describe('LocationsPanel primary promotion', () => {
  it('requires confirmation before promoting a location to primary', async () => {
    const user = userEvent.setup();
    const onLocationChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ promoted: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

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
            zernioStatus: 'active',
          }),
        ]}
        archivedLocations={[]}
        activeCount={2}
        accountId={ACCOUNT_ID}
        onLocationChange={onLocationChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: /make primary/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Make "Tanicia" primary?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm primary' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/locations/promote-primary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPrimaryId: SECONDARY_LOCATION_ID, accountId: ACCOUNT_ID }),
      });
    });
    expect(onLocationChange).toHaveBeenCalledTimes(1);
  });

  it('cancels primary promotion without sending a request', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

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
            zernioStatus: 'active',
          }),
        ]}
        archivedLocations={[]}
        activeCount={2}
        accountId={ACCOUNT_ID}
        onLocationChange={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: /make primary/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Make "Tanicia" primary?')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('LocationsPanel add-location state', () => {
  it('shows Add location for eligible accounts', () => {
    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        addLocationState={{ kind: 'enabled' }}
        onLocationChange={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: /add location/i })).toHaveAttribute(
      'href',
      '/dashboard/add-location',
    );
  });

  it('shows a Basic locked upgrade state instead of Add location', () => {
    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        addLocationState={{
          kind: 'locked',
          title: 'Upgrade to add locations',
          description: 'Basic includes one location. Upgrade to Standard or Premium to add more.',
          ctaHref: '/settings#subscription-billing',
          ctaLabel: 'View plan options',
        }}
        onLocationChange={() => {}}
      />,
    );

    expect(screen.queryByRole('link', { name: /^add location$/i })).not.toBeInTheDocument();
    expect(screen.getByText('Upgrade to add locations')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view plan options/i })).toHaveAttribute(
      'href',
      '/settings#subscription-billing',
    );
  });
});
