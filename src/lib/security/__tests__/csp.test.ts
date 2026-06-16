import { describe, it, expect } from 'vitest';
import { buildContentSecurityPolicy, generateCspNonce } from '../csp.mjs';

describe('buildContentSecurityPolicy', () => {
  it('returns an empty policy outside production (so dev HMR is not blocked)', () => {
    expect(buildContentSecurityPolicy('development')).toBe('');
    expect(buildContentSecurityPolicy('test')).toBe('');
    expect(buildContentSecurityPolicy(undefined)).toBe('');
    // Nonce is irrelevant outside production — still empty (HMR needs inline eval).
    expect(buildContentSecurityPolicy('development', 'NONCEABC')).toBe('');
  });

  describe('script-src nonce (F-11)', () => {
    const directive = (csp: string, name: string): string =>
      csp.split('; ').find((d) => d === name || d.startsWith(name + ' ')) ?? '';

    it('uses a per-request nonce and drops script-src unsafe-inline when a nonce is given', () => {
      const csp = buildContentSecurityPolicy('production', 'NONCEABC123');
      expect(directive(csp, 'script-src')).toContain("'nonce-NONCEABC123'");
      expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
      // Maps loader stays host-allowlisted (no 'strict-dynamic').
      expect(directive(csp, 'script-src')).toContain('https://maps.googleapis.com');
    });

    it('keeps style-src unsafe-inline (346 inline style attributes; nonces cannot cover style attrs)', () => {
      const csp = buildContentSecurityPolicy('production', 'NONCEABC123');
      expect(directive(csp, 'style-src')).toContain("'unsafe-inline'");
    });

    it('fails CLOSED with no nonce in production (no nonce AND no unsafe-inline)', () => {
      const csp = buildContentSecurityPolicy('production');
      expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
      expect(directive(csp, 'script-src')).not.toContain("'nonce-");
      expect(directive(csp, 'script-src')).toContain('https://maps.googleapis.com');
    });
  });

  describe('generateCspNonce', () => {
    it('returns a non-empty base64 string', () => {
      const nonce = generateCspNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(nonce.length).toBeGreaterThan(16);
    });
    it('produces a fresh value each call (per-request unguessable)', () => {
      expect(generateCspNonce()).not.toBe(generateCspNonce());
    });
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
    it('allows the fonts the Places web component pulls', () => {
      expect(directive('font-src')).toContain('https://fonts.gstatic.com');
      expect(directive('style-src')).toContain('https://fonts.googleapis.com');
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
