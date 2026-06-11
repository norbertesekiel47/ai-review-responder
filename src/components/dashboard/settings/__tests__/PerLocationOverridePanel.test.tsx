// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  PerLocationOverridePanel,
  type PerLocationOverride,
  type LocationOption,
} from '@/components/dashboard/settings/PerLocationOverridePanel';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SINGLE_LOCATION: LocationOption[] = [
  { id: 'loc-1', displayName: 'Main St Branch', isPrimary: true },
];

const TWO_LOCATIONS: LocationOption[] = [
  { id: 'loc-1', displayName: 'Main St Branch', isPrimary: true },
  { id: 'loc-2', displayName: 'Park Ave Branch', isPrimary: false },
];

const VERIFIED_ORG_DEFAULTS = [
  { channel: 'email', handle: 'owner@example.com', status: 'verified' },
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

const BASE_PROPS = {
  orgDefaults: VERIFIED_ORG_DEFAULTS,
  accountId: 'acct-1',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PerLocationOverridePanel visibility gating', () => {
  it('renders null when there are no overrides and only one location', () => {
    const { container } = render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[]}
        locationOptions={SINGLE_LOCATION}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the panel when in multi-location mode (no overrides yet)', () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[]}
        locationOptions={TWO_LOCATIONS}
      />,
    );
    // The heading should be present
    expect(screen.getByText(/per-location overrides/i)).toBeInTheDocument();
  });

  it('renders the panel when there are overrides even with a single location', () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[makeOverride('loc-1')]}
        locationOptions={SINGLE_LOCATION}
      />,
    );
    expect(screen.getByText(/per-location overrides/i)).toBeInTheDocument();
  });

  it('shows the Remove override control in the list when single-location with existing overrides', async () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[makeOverride('loc-1')]}
        locationOptions={SINGLE_LOCATION}
      />,
    );

    // Expand the panel to see the list
    const toggle = screen.getByRole('button', { name: /per-location overrides/i });
    toggle.click();

    // Delete control should be present
    expect(await screen.findByRole('button', { name: /remove override/i })).toBeInTheDocument();
  });

  it('does NOT show Add override creation controls when single-location with existing overrides', async () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[makeOverride('loc-1')]}
        locationOptions={SINGLE_LOCATION}
        // org default for email is verified → normally an "Add email override" button would appear
        orgDefaults={[{ channel: 'email', handle: 'owner@example.com', status: 'verified' }]}
      />,
    );

    const toggle = screen.getByRole('button', { name: /per-location overrides/i });
    toggle.click();

    // The "Add … override" creation button should NOT appear
    expect(screen.queryByRole('button', { name: /add .* override/i })).toBeNull();
  });

  it('shows Add override creation controls when multi-location', async () => {
    render(
      <PerLocationOverridePanel
        {...BASE_PROPS}
        overrides={[]}
        locationOptions={TWO_LOCATIONS}
        orgDefaults={[{ channel: 'email', handle: 'owner@example.com', status: 'verified' }]}
      />,
    );

    const toggle = screen.getByRole('button', { name: /per-location overrides/i });
    toggle.click();

    // Should show at least one "Add … override" button
    const addButtons = await screen.findAllByRole('button', { name: /add .* override/i });
    expect(addButtons.length).toBeGreaterThan(0);
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
        orgDefaults={[{ channel: 'email', handle: 'owner@example.com', status: 'verified' }]}
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
        orgDefaults={[{ channel: 'email', handle: 'owner@example.com', status: 'verified' }]}
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

    // Single-location: creation controls remain absent.
    expect(screen.queryByRole('button', { name: /add .* override/i })).toBeNull();
  });
});
