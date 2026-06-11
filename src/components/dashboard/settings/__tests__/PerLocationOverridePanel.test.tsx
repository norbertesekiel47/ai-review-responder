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

function makeOverride(locationId: string): PerLocationOverride {
  return {
    enrollmentId: `enroll-${locationId}`,
    locationId,
    locationName: 'Main St Branch',
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
});
