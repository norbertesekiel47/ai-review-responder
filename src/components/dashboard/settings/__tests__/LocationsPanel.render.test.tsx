// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  LAST_ACTIVE_ARCHIVE_HINT,
  LocationsPanel,
  type LocationEntry,
} from '@/components/dashboard/settings/LocationsPanel';

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
  it('honors an explicit voiceHref override', () => {
    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        voiceHref="/settings/voice?from=locations"
        onLocationChange={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: /^voice$/i })).toHaveAttribute(
      'href',
      '/settings/voice?from=locations',
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

  it('focuses the display label field when edit mode opens', async () => {
    const user = userEvent.setup();

    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        onLocationChange={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Edit display label for Testing Business' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /location display name/i })).toHaveFocus();
    });
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

  it('shows a server-authoritative locked state instead of Add location', () => {
    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        addLocationState={{
          kind: 'locked',
          title: 'Location changes unavailable',
          description: 'Your account cannot add another location right now.',
          ctaHref: '/settings/billing',
          ctaLabel: 'View plan options',
        }}
        onLocationChange={() => {}}
      />,
    );

    expect(screen.queryByRole('link', { name: /^add location$/i })).not.toBeInTheDocument();
    expect(screen.getByText('Location changes unavailable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view plan options/i })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });
});

// UX audit S19/S20: the archive dialog matches the self-serve Reactivate that
// exists below it; Archive on the only active location is disabled with a hint
// instead of a 3-second timed error; the primary-location dialog explains and
// dismisses rather than pretending to navigate.
describe('LocationsPanel archive guards', () => {
  /** The nth row's Archive button — throws instead of yielding undefined. */
  function archiveButton(index: number): HTMLElement {
    const button = screen.getAllByRole('button', { name: /archive/i })[index];
    if (!button) throw new Error(`no Archive button at index ${index}`);
    return button;
  }

  it('disables Archive on the last active location and explains why beside it', async () => {
    const user = userEvent.setup();
    render(
      <LocationsPanel
        locations={[location({})]}
        archivedLocations={[]}
        activeCount={1}
        accountId={ACCOUNT_ID}
        onLocationChange={() => {}}
      />,
    );

    const archive = screen.getByRole('button', { name: /archive/i });
    expect(archive).toBeDisabled();
    expect(archive).toHaveAccessibleDescription(LAST_ACTIVE_ARCHIVE_HINT);
    expect(screen.getByText(LAST_ACTIVE_ARCHIVE_HINT)).toBeInTheDocument();
    await user.click(archive);
    expect(screen.queryByText(/cannot archive the last active location/i)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('archive dialog says the location can be reactivated from the Archived list, not "contact support"', async () => {
    const user = userEvent.setup();
    render(
      <LocationsPanel
        locations={[
          location({}),
          location({ id: SECONDARY_LOCATION_ID, name: 'Tanicia', displayLabel: 'Tanicia', isPrimary: false }),
        ]}
        archivedLocations={[]}
        activeCount={2}
        accountId={ACCOUNT_ID}
        onLocationChange={() => {}}
      />,
    );

    const archiveButtons = screen.getAllByRole('button', { name: /archive/i });
    expect(archiveButtons.every((button) => !button.hasAttribute('disabled'))).toBe(true);
    // Second row is the non-primary one.
    await user.click(archiveButton(1));

    const dialog = screen.getByRole('dialog', { name: 'Archive location' });
    expect(dialog).toHaveTextContent(/reactivate it any time from the archived list below/i);
    expect(dialog).not.toHaveTextContent(/contacting support/i);
  });

  it('primary-location dialog explains "Make primary" and has a single Got it button', async () => {
    const user = userEvent.setup();
    render(
      <LocationsPanel
        locations={[
          location({}),
          location({ id: SECONDARY_LOCATION_ID, name: 'Tanicia', displayLabel: 'Tanicia', isPrimary: false }),
        ]}
        archivedLocations={[]}
        activeCount={2}
        accountId={ACCOUNT_ID}
        onLocationChange={() => {}}
      />,
    );

    await user.click(archiveButton(0));

    const dialog = screen.getByRole('dialog', { name: 'Choose a new primary location first' });
    expect(dialog).toHaveTextContent(/use make primary on another location/i);
    expect(screen.queryByRole('button', { name: /go to locations/i })).toBeNull();
    expect(within(dialog).getAllByRole('button')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports which change happened so the parent can confirm it (S32)', async () => {
    const user = userEvent.setup();
    const onLocationChange = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    render(
      <LocationsPanel
        locations={[
          location({}),
          location({ id: SECONDARY_LOCATION_ID, name: 'Tanicia', displayLabel: 'Tanicia', isPrimary: false }),
        ]}
        archivedLocations={[]}
        activeCount={2}
        accountId={ACCOUNT_ID}
        onLocationChange={onLocationChange}
      />,
    );

    await user.click(archiveButton(1));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(onLocationChange).toHaveBeenCalledWith('archived'));
  });
});
