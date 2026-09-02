// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  PerLocationOverridePanel,
  type PerLocationOverride,
  type LocationOption,
} from '@/components/dashboard/settings/PerLocationOverridePanel';
import { removeOverrideConsequence } from '@/components/dashboard/settings/PerLocationOverridePanel.helpers';
import type { ChannelId } from '@/lib/notifications/channels/types';

const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));
vi.mock('@/components/dashboard/shell/toast/ToastProvider', () => ({
  useToast: () => ({ toast: mockToast, dismiss: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SINGLE_LOCATION: LocationOption[] = [
  { id: 'loc-1', displayName: 'Main St Branch', isPrimary: true },
];

const TWO_LOCATIONS: LocationOption[] = [
  { id: 'loc-1', displayName: 'Main St Branch', isPrimary: true },
  { id: 'loc-2', displayName: 'Park Ave Branch', isPrimary: false },
];

function makeOverride(
  locationId: string,
  locationName = 'Main St Branch',
  archived = false,
): PerLocationOverride {
  return {
    enrollmentId: `enroll-${locationId}`,
    locationId,
    locationName,
    archived,
    channel: 'whatsapp',
    handle: '+447700900000',
    status: 'verified',
    verified_at: '2026-01-01T00:00:00Z',
  };
}

const BASE_PROPS: { verifiedOrgChannels: ChannelId[] } = {
  verifiedOrgChannels: ['email'],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PerLocationOverridePanel visibility gating', () => {
  it('renders null when there are no overrides and adding is not allowed', () => {
    const { container } = render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[]}
        locationOptions={SINGLE_LOCATION}
        canAddOverrides={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the panel when adding is allowed (no overrides yet)', () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[]}
        locationOptions={TWO_LOCATIONS}
        canAddOverrides
      />,
    );
    // The heading should be present
    expect(screen.getByText(/per-location overrides/i)).toBeInTheDocument();
  });

  it('renders the panel when there are overrides even when adding is not allowed', () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[makeOverride('loc-1')]}
        locationOptions={SINGLE_LOCATION}
        canAddOverrides={false}
      />,
    );
    expect(screen.getByText(/per-location overrides/i)).toBeInTheDocument();
  });

  it('shows the Remove override control in the list when add-ineligible with existing overrides', async () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[makeOverride('loc-1')]}
        locationOptions={SINGLE_LOCATION}
        canAddOverrides={false}
      />,
    );

    // Expand the panel to see the list
    const toggle = screen.getByRole('button', { name: /per-location overrides/i });
    toggle.click();

    // Delete control should be present
    expect(await screen.findByRole('button', { name: /remove override/i })).toBeInTheDocument();
  });

  // Regression: feature flag OFF with 2+ active locations and existing
  // overrides — canAddOverrides is false even though locationOptions.length > 1.
  // The override list must still render (and stay deletable) with NO add
  // controls; eligibility comes from the prop, never from the location count.
  it('canAddOverrides=false with multiple locations + overrides: list rendered, no add buttons', async () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[makeOverride('loc-1'), makeOverride('loc-2', 'Park Ave Branch')]}
        locationOptions={TWO_LOCATIONS}
        canAddOverrides={false}
      />,
    );

    const toggle = screen.getByRole('button', { name: /per-location overrides/i });
    toggle.click();

    // Both override rows stay listed and deletable.
    const removeButtons = await screen.findAllByRole('button', { name: /remove override/i });
    expect(removeButtons).toHaveLength(2);

    // The "Add … override" creation buttons must NOT appear.
    expect(screen.queryByRole('button', { name: /add .* override/i })).toBeNull();
  });

  it('shows Add override creation controls when canAddOverrides is true', async () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[]}
        locationOptions={TWO_LOCATIONS}
        canAddOverrides
      />,
    );

    const toggle = screen.getByRole('button', { name: /per-location overrides/i });
    toggle.click();

    // Should show at least one "Add … override" button
    const addButtons = await screen.findAllByRole('button', { name: /add .* override/i });
    expect(addButtons.length).toBeGreaterThan(0);
  });

  it('offers add controls only for verified org channels not already overridden', async () => {
    render(
      <PerLocationOverridePanel
        overrides={[]}
        locationOptions={TWO_LOCATIONS}
        verifiedOrgChannels={['email', 'telegram']}
        canAddOverrides
      />,
    );

    const toggle = screen.getByRole('button', { name: /per-location overrides/i });
    toggle.click();

    // 2 channels × 2 locations.
    const addButtons = await screen.findAllByRole('button', { name: /add .* override/i });
    expect(addButtons).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: /add email override/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /add telegram override/i })).toHaveLength(2);
  });

  // E4/E5: an override whose location was archived back to single-location must
  // remain listable + deletable. The " (archived)" suffix is derived at render
  // time from the DTO `archived` flag — the server sends the plain label.
  it('renders + allows deleting an override pointing at an archived location', async () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[makeOverride('loc-archived', 'Old Shop', true)]}
        locationOptions={SINGLE_LOCATION}
        canAddOverrides={false}
      />,
    );

    const toggle = screen.getByRole('button', { name: /per-location overrides/i });
    toggle.click();

    // The " (archived)" suffix is derived from the flag at render time.
    expect(await screen.findByText('Old Shop (archived)')).toBeInTheDocument();

    // The override row must be deletable from the UI.
    expect(
      await screen.findByRole('button', { name: /remove override/i }),
    ).toBeInTheDocument();

    // Creation stays gated/absent for archived/inactive locations.
    expect(screen.queryByRole('button', { name: /add .* override/i })).toBeNull();
  });

  // Regression: a single-location account with overrides on BOTH an archived
  // location and the still-active sole location must render real labels and
  // classify by the DTO archived flag — the active-location override renders
  // in the active section (under its locationOptions heading), NOT in the
  // archived group.
  it('classifies a single-location account with active + archived overrides by the archived flag', async () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[
          makeOverride('loc-1', 'Main St Branch', false),
          makeOverride('loc-archived', 'Old Shop', true),
        ]}
        locationOptions={SINGLE_LOCATION}
        canAddOverrides={false}
      />,
    );

    const toggle = screen.getByRole('button', { name: /per-location overrides/i });
    toggle.click();

    // Active location heading renders once (the locationOptions section) and
    // its override row shows the plain label without any archived suffix.
    const activeHeadings = await screen.findAllByText('Main St Branch');
    expect(activeHeadings.length).toBeGreaterThan(0);
    expect(screen.queryByText('Main St Branch (archived)')).toBeNull();

    // Archived override renders in the archived group with the derived suffix.
    expect(screen.getAllByText('Old Shop (archived)').length).toBeGreaterThan(0);

    // Both overrides stay deletable.
    const removeButtons = screen.getAllByRole('button', { name: /remove override/i });
    expect(removeButtons).toHaveLength(2);

    // Add-ineligible: creation controls remain absent.
    expect(screen.queryByRole('button', { name: /add .* override/i })).toBeNull();
  });
});

// UX audit S14: removal confirms in a SettingsModal with the consequence, and
// a failure renders inline beside the row — never window.alert.
describe('PerLocationOverridePanel remove override', () => {
  function expandAndOpenRemove() {
    fireEvent.click(screen.getByRole('button', { name: /per-location overrides/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove override' }));
  }

  it('asks for confirmation with the consequence before calling the API', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const alertSpy = vi.spyOn(window, 'alert');
    const onOverrideRemoved = vi.fn();
    const override = makeOverride('loc-1');

    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[override]}
        locationOptions={SINGLE_LOCATION}
        canAddOverrides={false}
        onOverrideRemoved={onOverrideRemoved}
      />,
    );
    expandAndOpenRemove();

    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Remove override' });
    expect(dialog).toHaveTextContent(removeOverrideConsequence(override));
    expect(removeOverrideConsequence(override)).toBe(
      'Main St Branch will go back to your account-wide WhatsApp setting.',
    );

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove override' }));
    await waitFor(() => expect(onOverrideRemoved).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success', title: 'Override removed' }));
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('"Keep override" closes the dialog and sends nothing', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[makeOverride('loc-1')]}
        locationOptions={SINGLE_LOCATION}
        canAddOverrides={false}
      />,
    );
    expandAndOpenRemove();
    fireEvent.click(screen.getByRole('button', { name: 'Keep override' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders a server failure inline beside the row instead of alert()', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Override is still in use.' }), { status: 409 })),
    );
    const alertSpy = vi.spyOn(window, 'alert');
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[makeOverride('loc-1')]}
        locationOptions={SINGLE_LOCATION}
        canAddOverrides={false}
      />,
    );
    expandAndOpenRemove();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove override' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Override is still in use.');
    // The error lives inside the row it belongs to, and the control names it.
    const row = error.closest('.channel-row');
    expect(row).not.toBeNull();
    const remove = within(row as HTMLElement).getByRole('button', { name: 'Remove override' });
    expect(remove).toHaveAccessibleDescription('Override is still in use.');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });
});
