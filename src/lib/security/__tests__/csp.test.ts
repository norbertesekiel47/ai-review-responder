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
      // The PlaceAutocompleteElement RPCs (AutocompletePlaces, fetchFields) go
      // to the NEW Places API host, not maps.googleapis.com — caught on staging
      // 2026-05-31 as a blocked places.googleapis.com request.
      expect(directive('connect-src')).toContain('https://maps.googleapis.com');
      expect(directive('connect-src')).toContain('https://places.googleapis.com');
    });
    // #799: fonts are self-hosted (#795), so no Google font host is allowlisted
    // any more. The Maps widget still REQUESTS fonts.googleapis.com and is
    // blocked — measured against the live PlaceAutocompleteElement, blocking it
    // leaves predictions, icons, the attribution dialog and the
    // gmp-select → fetchFields path all working; only the widget's own
    // typography falls back to the system sans. The three CSP console errors
    // per widget mount are that block working, not a regression.
    it('does not allowlist the Google font CDN', () => {
      expect(directive('style-src')).not.toContain('https://fonts.googleapis.com');
      expect(directive('font-src')).not.toContain('https://fonts.gstatic.com');
    });
    it('still allows the maps.gstatic.com widget chrome', () => {
      // Dropping this one WOULD visibly break the widget — it is not a Google
      // font host and is unrelated to #795/#799.
      expect(directive('style-src')).toContain('https://maps.gstatic.com');
      expect(directive('font-src')).toContain('https://maps.gstatic.com');
    });

    // Guard the existing policy so the extraction / Maps additions did not
    // silently widen or drop anything security-relevant.
    it('keeps the Supabase + Sentry connect-src hosts', () => {
      expect(directive('connect-src')).toContain('https://*.supabase.co');
      expect(directive('connect-src')).toContain('https://*.sentry.io');
    });
    it('drops the invalid partial-wildcard Sentry source (browser ignored it)', () => {
      // 'o*.ingest.sentry.io' is an illegal CSP source; '*.sentry.io' covers it.
      expect(csp).not.toContain('o*.ingest.sentry.io');
    });
    it('preserves the lockdown directives', () => {
      expect(directive('default-src')).toBe("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(directive('base-uri')).toBe("base-uri 'self'");
      expect(directive('form-action')).toBe("form-action 'self'");
    });
  });
});
