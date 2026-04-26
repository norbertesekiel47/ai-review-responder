import { describe, it, expect } from 'vitest';
import { OnboardBusinessSchema, websiteUrlSchema } from '../schemas';

describe('websiteUrlSchema', () => {
  it('accepts https:// URLs', () => {
    expect(websiteUrlSchema.safeParse('https://example.com').success).toBe(true);
    expect(websiteUrlSchema.safeParse('https://example.com/path?q=1').success).toBe(true);
  });

  it('accepts http:// URLs', () => {
    // Legacy small-business sites sometimes still use HTTP.
    expect(websiteUrlSchema.safeParse('http://example.com').success).toBe(true);
  });

  it('rejects javascript: URLs (XSS vector)', () => {
    const result = websiteUrlSchema.safeParse('javascript:alert(1)');
    expect(result.success).toBe(false);
  });

  it('rejects data: URLs (XSS vector)', () => {
    const result = websiteUrlSchema.safeParse('data:text/html,<script>alert(1)</script>');
    expect(result.success).toBe(false);
  });

  it('rejects ftp:// URLs', () => {
    const result = websiteUrlSchema.safeParse('ftp://example.com');
    expect(result.success).toBe(false);
  });

  it('rejects mailto: URLs', () => {
    const result = websiteUrlSchema.safeParse('mailto:owner@example.com');
    expect(result.success).toBe(false);
  });

  it('rejects file:// URLs', () => {
    const result = websiteUrlSchema.safeParse('file:///etc/passwd');
    expect(result.success).toBe(false);
  });

  it('rejects plain strings that are not URLs', () => {
    expect(websiteUrlSchema.safeParse('not a url').success).toBe(false);
    expect(websiteUrlSchema.safeParse('example.com').success).toBe(false); // no scheme
  });

  it('rejects strings longer than 500 chars', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(500);
    const result = websiteUrlSchema.safeParse(longUrl);
    expect(result.success).toBe(false);
  });

  it('rejects empty string', () => {
    const result = websiteUrlSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('accepts unusual but legal http(s) URLs', () => {
    expect(websiteUrlSchema.safeParse('https://sub.example.co.uk:8080/path').success).toBe(true);
  });
});

// B25 — admin OnboardBusinessSchema's googlePlaceId now validates with
// isPlaceId() at the schema layer, mirroring BusinessOnboardingSchema (owner).
// Pre-fix it was z.string().min(1).optional() — any non-empty string passed.
// The route still has its own isPlaceId check as belt-and-suspenders, but
// pinning the schema-level validation keeps the two onboarding contracts
// in lockstep + protects future callers of OnboardBusinessSchema.parse().
describe('OnboardBusinessSchema — googlePlaceId validation', () => {
  function validBaseBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Acme Cafe',
      ownerName: 'Jane Smith',
      ownerEmail: 'jane@acme.example',
      ...overrides,
    };
  }

  it('accepts a real Place ID (ChIJ-prefixed, 27 chars)', () => {
    const result = OnboardBusinessSchema.safeParse(
      validBaseBody({ googlePlaceId: 'ChIJgUbEo8cfqokR5lP9Wh_DaM' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a real Place ID (non-ChIJ prefix — GhIJ, Eic, etc.)', () => {
    // Real Google Place IDs use multiple prefixes, not just ChIJ.
    const result = OnboardBusinessSchema.safeParse(
      validBaseBody({ googlePlaceId: 'GhIJabc1234567890ABC' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a hex CID (worker requires resolution to canonical Place ID first)', () => {
    const result = OnboardBusinessSchema.safeParse(
      validBaseBody({ googlePlaceId: '0x1234abcd:0x5678efab' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects too-short string (< 20 chars)', () => {
    const result = OnboardBusinessSchema.safeParse(
      validBaseBody({ googlePlaceId: 'ChIJtoo_short' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects bare slug "abc" (the original bug — any non-empty string used to pass)', () => {
    const result = OnboardBusinessSchema.safeParse(
      validBaseBody({ googlePlaceId: 'abc' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/Invalid Google Place ID/i);
    }
  });

  it('rejects entries starting with a digit (Place IDs always start with a letter)', () => {
    const result = OnboardBusinessSchema.safeParse(
      validBaseBody({ googlePlaceId: '1bIJgUbEo8cfqokR5lP9Wh_DaM' }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts the schema when googleMapsUrl is provided instead (XOR — googlePlaceId omitted)', () => {
    const result = OnboardBusinessSchema.safeParse(
      validBaseBody({
        googleMapsUrl:
          'https://www.google.com/maps/place/Acme+Cafe/@40.7,-74.0,15z',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects when both googlePlaceId AND googleMapsUrl are provided (XOR refine)', () => {
    const result = OnboardBusinessSchema.safeParse(
      validBaseBody({
        googlePlaceId: 'ChIJgUbEo8cfqokR5lP9Wh_DaM',
        googleMapsUrl:
          'https://www.google.com/maps/place/Acme+Cafe/@40.7,-74.0,15z',
      }),
    );
    expect(result.success).toBe(false);
  });
});
