import { describe, expect, it } from 'vitest';
import { deriveNavSection } from '../active-nav';

describe('deriveNavSection', () => {
  it('folds nested routes into their section', () => {
    expect(deriveNavSection('/dashboard/reviews')).toBe('reviews');
    expect(deriveNavSection('/dashboard/reviews/history')).toBe('reviews');
    expect(deriveNavSection('/dashboard/requests')).toBe('requests');
    expect(deriveNavSection('/dashboard/requests/contacts')).toBe('requests');
    expect(deriveNavSection('/dashboard/analytics')).toBe('analytics');
    expect(deriveNavSection('/settings')).toBe('settings');
    expect(deriveNavSection('/settings/voice')).toBe('settings');
  });

  it('falls back to dashboard for /dashboard and any unmatched child route', () => {
    expect(deriveNavSection('/dashboard')).toBe('dashboard');
    expect(deriveNavSection('/dashboard/something-new')).toBe('dashboard');
  });

  // The catch-all is tested LAST in the implementation; if it ever moved above
  // the specific sections every /dashboard/* route would highlight Dashboard.
  it('prefers the specific section over the dashboard catch-all', () => {
    for (const [pathname, expected] of [
      ['/dashboard/reviews/history', 'reviews'],
      ['/dashboard/requests/contacts', 'requests'],
      ['/dashboard/analytics', 'analytics'],
    ] as const) {
      expect(deriveNavSection(pathname)).toBe(expected);
    }
  });

  it('returns exactly one section, so two nav rows can never highlight at once', () => {
    const sections = ['/dashboard', '/dashboard/reviews', '/dashboard/requests', '/settings'].map(
      deriveNavSection,
    );
    expect(new Set(sections).size).toBe(sections.length);
  });

  it('returns null outside the dashboard and settings trees', () => {
    expect(deriveNavSection('/')).toBeNull();
    expect(deriveNavSection('/admin/login')).toBeNull();
    expect(deriveNavSection('')).toBeNull();
  });

  it('folds /dashboard/operator into the operator section', () => {
    expect(deriveNavSection('/dashboard/operator')).toBe('operator');
    expect(deriveNavSection('/dashboard/operator/')).toBe('operator');
    // `usePathname()` never carries a query string, but a stray one must still
    // resolve rather than silently dropping the nav highlight.
    expect(deriveNavSection('/dashboard/operator?conversationId=x')).toBe('operator');
  });

  it('keeps the operator arm above the /dashboard catch-all', () => {
    // THE ORDERING THIS CASE EXISTS FOR. `/dashboard/operator` also matches the
    // `startsWith('/dashboard/')` catch-all, so an arm placed BELOW it returns
    // `'dashboard'` and the Operator row never highlights. A reordering that
    // breaks it fails here, not in a screenshot.
    expect(deriveNavSection('/dashboard/operator')).not.toBe('dashboard');
    // Every other section is unmoved.
    expect(deriveNavSection('/dashboard')).toBe('dashboard');
    expect(deriveNavSection('/dashboard/reviews/history')).toBe('reviews');
    expect(deriveNavSection('/dashboard/requests/contacts')).toBe('requests');
    expect(deriveNavSection('/dashboard/analytics')).toBe('analytics');
    expect(deriveNavSection('/settings/voice')).toBe('settings');
    // The old TOP-LEVEL path is not a section: the page lives under /dashboard.
    expect(deriveNavSection('/operator')).toBeNull();
    expect(deriveNavSection('/help/contact')).toBeNull();
  });
});

// #1092. The Review QR surface moves from /settings/review-qr to
// /dashboard/requests/qr, so it must stop highlighting Settings and start
// highlighting Requests.
describe('deriveNavSection — the moved Review QR route', () => {
  it('deriveNavSection folds the moved Review QR route into requests', () => {
    expect(deriveNavSection('/dashboard/requests/qr')).toBe('requests');
    expect(deriveNavSection('/dashboard/requests/qr/print/abc-123')).toBe('requests');
  });

  it('no longer treats a Review QR path as a Settings path', () => {
    // The old path only ever redirects now, but a stale bookmark still renders
    // the shell for a moment, and it must not light Settings and Requests both.
    expect(deriveNavSection('/dashboard/requests/qr')).not.toBe('settings');
  });
});

