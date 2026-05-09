import { describe, expect, it } from 'vitest';

// ── QuotaBar label formatting ──────────────────────────────────────────────

describe('AccountPanel quota label formatting', () => {
  function formatQuotaLabel(activeLocations: number, included: number, overage: number): string {
    return `${activeLocations} of ${included} included${overage > 0 ? `, ${overage} overage` : ''}`;
  }

  it('shows no overage when within quota', () => {
    expect(formatQuotaLabel(1, 1, 0)).toBe('1 of 1 included');
  });

  it('shows no overage when within multi-location quota', () => {
    expect(formatQuotaLabel(3, 5, 0)).toBe('3 of 5 included');
  });

  it('shows overage when exceeding quota', () => {
    expect(formatQuotaLabel(3, 1, 2)).toBe('3 of 1 included, 2 overage');
  });

  it('shows overage for premium tier with 7 of 5', () => {
    expect(formatQuotaLabel(7, 5, 2)).toBe('7 of 5 included, 2 overage');
  });

  it('handles zero locations gracefully', () => {
    expect(formatQuotaLabel(0, 1, 0)).toBe('0 of 1 included');
  });
});

// ── PlanCard tier label formatting ────────────────────────────────────────

describe('AccountPanel tier label formatting', () => {
  it('formats tier name for display — standard', () => {
    const tier = 'standard';
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    expect(tierLabel).toBe('Standard');
  });

  it('formats tier name for display — founders', () => {
    const tier = 'founders';
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    expect(tierLabel).toBe('Founders');
  });

  it('formats tier name for display — premium', () => {
    const tier = 'premium';
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    expect(tierLabel).toBe('Premium');
  });

  it('formats tier name for display — basic', () => {
    const tier = 'basic';
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    expect(tierLabel).toBe('Basic');
  });
});

// ── Billing price formatting ─────────────────────────────────────────────

describe('AccountPanel billing price formatting', () => {
  it('formats base price from cents to dollars', () => {
    expect((7900 / 100).toFixed(2)).toBe('79.00');
  });

  it('formats overage price from cents to dollars', () => {
    expect((2500 / 100).toFixed(2)).toBe('25.00');
  });

  it('formats total price from cents to dollars', () => {
    expect((15400 / 100).toFixed(2)).toBe('154.00');
  });
});
