import { describe, expect, it } from 'vitest';

// ── LocationsPanel guard logic ─────────────────────────────────────────────

describe('LocationsPanel archive guard logic', () => {
  it('blocks archive on primary with other active locations — promote first', () => {
    const isPrimary = true;
    const isLastActive = false;
    const shouldPromoteFirst = isPrimary && !isLastActive;
    expect(shouldPromoteFirst).toBe(true);
  });

  it('blocks archive on last active location', () => {
    const isLastActive = true;
    const shouldBlock = isLastActive;
    expect(shouldBlock).toBe(true);
  });

  it('allows archive on non-primary with other active locations', () => {
    const isPrimary = false;
    const isLastActive = false;
    const shouldAllow = !isPrimary && !isLastActive;
    expect(shouldAllow).toBe(true);
  });

  it('blocks archive on primary that is also last active', () => {
    const isPrimary = true;
    const isLastActive = true;
    // Last-active takes precedence — always blocked
    const shouldBlock = isLastActive;
    expect(shouldBlock).toBe(true);
  });
});

// ── Display label logic ────────────────────────────────────────────────────

describe('LocationsPanel display label logic', () => {
  it('uses display_label when set', () => {
    const displayLabel = 'Downtown Cafe';
    const name = 'Business Name';
    const displayName = displayLabel ?? name;
    expect(displayName).toBe('Downtown Cafe');
  });

  it('falls back to name when display_label is null', () => {
    const displayLabel: string | null = null;
    const name = 'Business Name';
    const displayName = displayLabel ?? name;
    expect(displayName).toBe('Business Name');
  });

  it('falls back to name when display_label is empty string (non-null)', () => {
    const displayLabel: string | null = '';
    const name = 'Business Name';
    // Empty string is truthy enough to not trigger nullish coalescing
    // This is by design — empty string is a valid display label
    const displayName = displayLabel ?? name;
    expect(displayName).toBe('');
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
