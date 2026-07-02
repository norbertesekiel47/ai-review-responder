import { describe, it, expect } from 'vitest';
import { MARKETING_LINKS, NAV_LINKS } from '../marketing-links';

describe('marketing links single source', () => {
  it('declares each public marketing page exactly once', () => {
    expect(MARKETING_LINKS.features).toEqual({ label: 'Features', href: '/features' });
    expect(MARKETING_LINKS.howItWorks).toEqual({ label: 'How it works', href: '/how-it-works' });
    expect(MARKETING_LINKS.pricing).toEqual({ label: 'Pricing', href: '/pricing' });
  });

  it('header-nav order covers every link exactly once', () => {
    expect(NAV_LINKS).toEqual([
      MARKETING_LINKS.features,
      MARKETING_LINKS.howItWorks,
      MARKETING_LINKS.pricing,
    ]);
  });
});
