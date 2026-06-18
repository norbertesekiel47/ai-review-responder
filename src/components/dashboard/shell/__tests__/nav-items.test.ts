import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, resolveActiveNavId, type NavId } from '@/components/dashboard/shell/nav-items';

describe('NAV_ITEMS config', () => {
  it('declares the four owner destinations with unique ids and absolute hrefs', () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    expect(ids).toEqual(['dashboard', 'insights', 'past-replies', 'settings']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith('/')).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it('flags only past-replies as server-gated', () => {
    const flagged = NAV_ITEMS.filter((i) => i.flagged).map((i) => i.id);
    expect(flagged).toEqual(['past-replies']);
  });
});

describe('resolveActiveNavId — every route in the §1 contract', () => {
  const cases: Array<[string, NavId | null]> = [
    ['/dashboard', 'dashboard'],
    ['/dashboard/', 'dashboard'],
    ['/dashboard/insights', 'insights'],
    ['/dashboard/insights/', 'insights'],
    ['/dashboard/past-replies', 'past-replies'],
    ['/dashboard/past-replies/abc', 'past-replies'],
    // Wizards keep their parent's active item.
    ['/dashboard/connect', 'dashboard'],
    ['/dashboard/connect/select-location', 'dashboard'],
    ['/dashboard/add-location', 'settings'],
    // Settings catches every sub-page.
    ['/settings', 'settings'],
    ['/settings/auto-approval', 'settings'],
    ['/settings/channels', 'settings'],
    ['/settings/locations', 'settings'],
    ['/settings/voice', 'settings'],
    ['/settings/security', 'settings'],
    // Offboarding status renders without a nav shell → nothing highlighted.
    ['/account/offboarding/status', null],
  ];

  it.each(cases)('%s → %s', (pathname, expected) => {
    expect(resolveActiveNavId(pathname)).toBe(expected);
  });

  it('insights is never resolved as dashboard (the prior bug)', () => {
    expect(resolveActiveNavId('/dashboard/insights')).not.toBe('dashboard');
  });
});
