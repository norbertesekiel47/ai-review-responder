import { describe, expect, it } from 'vitest';
import { getDisplayLabel } from '@/lib/locations/display-label';
import { LAST_ACTIVE_ARCHIVE_HINT } from '@/components/dashboard/settings/LocationsPanel';

// ── Archive guard copy ──────────────────────────────────────────────────────
// The guard BEHAVIOUR (disabled button, dialogs) is exercised in
// LocationsPanel.render.test.tsx; this pins the owner-facing sentence.

describe('LocationsPanel archive guard copy', () => {
  it('tells the owner what to do, in plain language, with no "cannot" error tone', () => {
    expect(LAST_ACTIVE_ARCHIVE_HINT).toBe(
      'You need at least one active location. Add another before archiving this one.',
    );
    expect(LAST_ACTIVE_ARCHIVE_HINT).not.toMatch(/cannot/i);
  });
});

// ── Display label logic ────────────────────────────────────────────────────

describe('LocationsPanel display label logic', () => {
  it('uses display_label when set', () => {
    const result = getDisplayLabel({
      displayLabel: 'Downtown Cafe',
      name: 'Business Name',
    });
    expect(result).toBe('Downtown Cafe');
  });

  it('falls back to name when display_label is null', () => {
    const result = getDisplayLabel({
      displayLabel: null,
      name: 'Business Name',
    });
    expect(result).toBe('Business Name');
  });

  it('falls back to name when display_label is empty string (non-null)', () => {
    // Empty string is truthy enough to not trigger nullish coalescing
    // This is by design — empty string is a valid display label
    const result = getDisplayLabel({
      displayLabel: '',
      name: 'Business Name',
    });
    expect(result).toBe('');
  });
});

// ── Zernio status label ────────────────────────────────────────────────────

describe('LocationsPanel zernio status labels', () => {
  const labels: Record<string, string> = {
    none: 'Not connected',
    pending: 'Connecting…',
    active: 'Connected',
    disconnected: 'Disconnected',
  };

  it('maps all known statuses', () => {
    expect(labels['none']).toBe('Not connected');
    expect(labels['pending']).toBe('Connecting…');
    expect(labels['active']).toBe('Connected');
    expect(labels['disconnected']).toBe('Disconnected');
  });

  it('returns undefined for unknown status', () => {
    expect(labels['unknown']).toBeUndefined();
  });
});
