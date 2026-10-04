import { describe, it, expect } from 'vitest';
import { CLOSED_NOTICE_CTA, EARLY_ACCESS_CTA, MARKETING_LINKS, NAV_LINKS } from '../marketing-links';

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

  it('declares the one early-access door: one phrase, pointed at the lead-capture route', () => {
    expect(EARLY_ACCESS_CTA).toEqual({ label: 'Get early access', href: '/book-a-demo' });
  });

  it('declares the one closed-notice door the reachable surfaces use since the shutdown', () => {
    expect(CLOSED_NOTICE_CTA).toEqual({ label: 'RepWorth has closed', href: '/closed' });
  });
});
