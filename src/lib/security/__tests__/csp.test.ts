import { describe, it, expect } from 'vitest';
import { buildContentSecurityPolicy } from '../csp.mjs';

describe('buildContentSecurityPolicy', () => {
  it('returns an empty policy outside production (so dev HMR is not blocked)', () => {
    expect(buildContentSecurityPolicy('development')).toBe('');
    expect(buildContentSecurityPolicy('test')).toBe('');
    expect(buildContentSecurityPolicy(undefined)).toBe('');
  });

  describe('production policy', () => {
    const csp = buildContentSecurityPolicy('production');
    const directive = (name: string): string =>
      csp.split('; ').find((d) => d === name || d.startsWith(name + ' ')) ?? '';

    // Regression: the onboarding location step renders a Google Places
    // PlaceAutocompleteElement, whose loader script + field fetches were blocked
    // by a CSP missing the Maps hosts (caught on staging 2026-05-30).
    it('allows the Google Maps loader script', () => {
      expect(directive('script-src')).toContain('https://maps.googleapis.com');
    });
    it('allows Google Maps Places API fetches via connect-src', () => {
      expect(directive('connect-src')).toContain('https://maps.googleapis.com');
    });
    it('allows the fonts the Places web component pulls', () => {
      expect(directive('font-src')).toContain('https://fonts.gstatic.com');
      expect(directive('style-src')).toContain('https://fonts.googleapis.com');
    });

    // Guard the existing policy so the extraction / Maps additions did not
    // silently widen or drop anything security-relevant.
    it('keeps the Supabase + Sentry connect-src hosts', () => {
      expect(directive('connect-src')).toContain('https://*.supabase.co');
      expect(directive('connect-src')).toContain('https://*.sentry.io');
      expect(directive('connect-src')).toContain('https://o*.ingest.sentry.io');
    });
    it('preserves the lockdown directives', () => {
      expect(directive('default-src')).toBe("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(directive('base-uri')).toBe("base-uri 'self'");
      expect(directive('form-action')).toBe("form-action 'self'");
    });
  });
});
