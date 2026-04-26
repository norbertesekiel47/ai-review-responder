import { describe, it, expect } from 'vitest';
import {
  SignupSchema,
  FinishSignupSchema,
  BusinessOnboardingSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  ResendConfirmationSchema,
} from '../schemas';

describe('SignupSchema (identity-only)', () => {
  it('lowercases + trims email before validation', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: '  Owner@Example.COM  ',
      ownerName: 'Jane',
      password: 'password123',
    });
    expect(parsed.ownerEmail).toBe('owner@example.com');
  });

  it('rejects empty password', () => {
    expect(() =>
      SignupSchema.parse({
        ownerEmail: 'a@b.com',
        ownerName: 'J',
        password: '',
      }),
    ).toThrow();
  });

  it('requires password >= 8 chars', () => {
    expect(() =>
      SignupSchema.parse({
        ownerEmail: 'a@b.com',
        ownerName: 'J',
        password: 'short',
      }),
    ).toThrow();
  });

  it('parses successfully with only the three identity fields', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: 'a@b.com',
      ownerName: 'Jane',
      password: 'password123',
    });
    expect(parsed.ownerEmail).toBe('a@b.com');
    expect(parsed.ownerName).toBe('Jane');
    expect(parsed.password).toBe('password123');
  });

  it('accepts optional ownerPhone', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: 'a@b.com',
      ownerName: 'J',
      password: 'password123',
      ownerPhone: '+1-555-0100',
    });
    expect(parsed.ownerPhone).toBe('+1-555-0100');
  });

  it('strips legacy business fields silently (Zod default behavior)', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: 'a@b.com',
      ownerName: 'J',
      password: 'password123',
      // Stale frontends may still send these — must not error and must not leak through.
      businessName: 'Acme',
      googlePlaceId: 'ChIJtest1234567890ab',
      tone: 'casual',
    });
    expect((parsed as { businessName?: string }).businessName).toBeUndefined();
    expect((parsed as { googlePlaceId?: string }).googlePlaceId).toBeUndefined();
    expect((parsed as { tone?: string }).tone).toBeUndefined();
  });
});

describe('FinishSignupSchema (identity-only — Google session supplies email)', () => {
  it('parses with only ownerName', () => {
    const parsed = FinishSignupSchema.parse({ ownerName: 'Jane' });
    expect(parsed.ownerName).toBe('Jane');
  });

  it('accepts optional ownerPhone', () => {
    const parsed = FinishSignupSchema.parse({
      ownerName: 'Jane',
      ownerPhone: '+1-555-0100',
    });
    expect(parsed.ownerPhone).toBe('+1-555-0100');
  });

  it('rejects missing ownerName', () => {
    expect(() => FinishSignupSchema.parse({})).toThrow();
  });

  it('strips legacy business fields silently', () => {
    const parsed = FinishSignupSchema.parse({
      ownerName: 'Jane',
      businessName: 'Acme',
      googlePlaceId: 'ChIJtest1234567890ab',
    });
    expect((parsed as { businessName?: string }).businessName).toBeUndefined();
    expect((parsed as { googlePlaceId?: string }).googlePlaceId).toBeUndefined();
  });

  it('strips ownerEmail if supplied (Google session provides it)', () => {
    const parsed = FinishSignupSchema.parse({
      ownerName: 'J',
      ownerEmail: 'should-be-ignored@example.com',
    });
    expect((parsed as { ownerEmail?: string }).ownerEmail).toBeUndefined();
  });
});

describe('BusinessOnboardingSchema', () => {
  it('parses successfully with businessName + googlePlaceId', () => {
    const parsed = BusinessOnboardingSchema.parse({
      businessName: 'Acme',
      googlePlaceId: 'ChIJtest1234567890ab',
    });
    expect(parsed.businessName).toBe('Acme');
    expect(parsed.googlePlaceId).toBe('ChIJtest1234567890ab');
  });

  it('parses successfully with businessName + googleMapsUrl (resolver-ready /place/+@coords)', () => {
    const url =
      'https://www.google.com/maps/place/Acme+Cafe/@40.7128,-74.0060,15z';
    const parsed = BusinessOnboardingSchema.parse({
      businessName: 'Acme',
      googleMapsUrl: url,
    });
    expect(parsed.googleMapsUrl).toBe(url);
  });

  it('parses successfully with /maps/place URL containing canonical Place ID in !1s data', () => {
    const url =
      'https://www.google.com/maps/place/Acme/@40.7,-74.0,15z/data=!4m6!3m5!1sChIJgUbEo8cfqokR5lP9Wh_DaM';
    const parsed = BusinessOnboardingSchema.parse({
      businessName: 'Acme',
      googleMapsUrl: url,
    });
    expect(parsed.googleMapsUrl).toBe(url);
  });

  it('rejects when neither googlePlaceId nor googleMapsUrl is provided (XOR refine)', () => {
    expect(() =>
      BusinessOnboardingSchema.parse({ businessName: 'Acme' }),
    ).toThrow();
  });

  // B18 finding #1 — googleMapsUrl must be resolver-ready, not just a valid
  // host. The PlaceIdValidationWorker can only resolve URLs that contain
  // either a Place ID OR (businessName + coordinates).
  describe('googleMapsUrl resolver-readiness', () => {
    it('rejects bare https://maps.google.com/ (no resolvable data)', () => {
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          googleMapsUrl: 'https://maps.google.com/',
        }),
      ).toThrow();
    });

    it('rejects https://maps.google.com/?cid=123 (cid is not parseable by url-parser)', () => {
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          googleMapsUrl: 'https://maps.google.com/?cid=123',
        }),
      ).toThrow();
    });

    it('rejects https://maps.app.goo.gl/<id> (shortlink — needs expansion the worker doesn\'t do)', () => {
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          googleMapsUrl: 'https://maps.app.goo.gl/abc123',
        }),
      ).toThrow();
    });

    it('rejects https://goo.gl/maps/<id> (legacy shortlink — same expansion issue)', () => {
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          googleMapsUrl: 'https://goo.gl/maps/abc123',
        }),
      ).toThrow();
    });

    it('rejects https://google.com/search?q=... (host shape passes, resolver stage fails)', () => {
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          // Note: this URL would already fail the host-shape stage too
          // (no /maps/), but we assert anyway as defense-in-depth.
          googleMapsUrl: 'https://google.com/search?q=acme+cafe',
        }),
      ).toThrow();
    });

    it('accepts a real /maps/place/<name>/@<lat>,<lng>/data=...!1s<id> URL', () => {
      const url =
        'https://www.google.com/maps/place/Pike+Place+Market/@47.6097,-122.3422,17z/data=!3m1!4b1!4m6!3m5!1sChIJgUbEo8cfqokR5lP9Wh_DaM!8m2!3d47.6097!4d-122.34';
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Pike Place',
          googleMapsUrl: url,
        }),
      ).not.toThrow();
    });

    // B19 finding — schema/worker mismatch: parseGoogleMapsUrl extracts the
    // ?q=place_id:<x> / ?placeid=<x> / ?place_id=<x> values verbatim, but
    // the worker's downstream `isPlaceId()` check rejects malformed
    // identifiers. Schema must mirror the isPlaceId gate to prevent the
    // "wizard says onboarded, worker says unresolvable" stuck state.
    it('rejects ?q=place_id:bad (invalid embedded Place ID format)', () => {
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          googleMapsUrl:
            'https://www.google.com/maps/place/?q=place_id:bad',
        }),
      ).toThrow();
    });

    it('rejects ?placeid=bad (invalid embedded Place ID format)', () => {
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          googleMapsUrl:
            'https://www.google.com/maps/place/?placeid=bad',
        }),
      ).toThrow();
    });

    it('rejects ?place_id=bad (invalid embedded Place ID format)', () => {
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          googleMapsUrl:
            'https://www.google.com/maps/place/?place_id=bad',
        }),
      ).toThrow();
    });

    it('rejects ?q=place_id:<too-short> even if alphanumeric (mirrors isPlaceId 20+ char rule)', () => {
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          googleMapsUrl:
            'https://www.google.com/maps/place/?q=place_id:ChIJtoo_short',
        }),
      ).toThrow();
    });

    it('accepts ?q=place_id:<valid 20+ char ID> when no name+coords are present', () => {
      const url =
        'https://www.google.com/maps/place/?q=place_id:ChIJgUbEo8cfqokR5lP9Wh_DaM';
      expect(() =>
        BusinessOnboardingSchema.parse({
          businessName: 'Acme',
          googleMapsUrl: url,
        }),
      ).not.toThrow();
    });
  });

  it('applies tone default when omitted', () => {
    const parsed = BusinessOnboardingSchema.parse({
      businessName: 'X',
      googlePlaceId: 'ChIJtest1234567890ab',
    });
    expect(parsed.tone).toBe('professional and friendly');
  });

  it('rejects garbage googlePlaceId via isPlaceId refine', () => {
    expect(() =>
      BusinessOnboardingSchema.parse({
        businessName: 'X',
        googlePlaceId: 'garbage',
      }),
    ).toThrow();
  });

  it('rejects too-short googlePlaceId (under 20 chars)', () => {
    expect(() =>
      BusinessOnboardingSchema.parse({
        businessName: 'X',
        googlePlaceId: 'ChIJabc',
      }),
    ).toThrow();
  });

  it('accepts a canonical ChIJ place ID', () => {
    const parsed = BusinessOnboardingSchema.parse({
      businessName: 'X',
      googlePlaceId: 'ChIJgUbEo8cfqokR5lP9_Wh_DaM',
    });
    expect(parsed.googlePlaceId).toBe('ChIJgUbEo8cfqokR5lP9_Wh_DaM');
  });

  it('accepts optional category, products, staff, facts, sample responses, website', () => {
    const parsed = BusinessOnboardingSchema.parse({
      businessName: 'Acme',
      googlePlaceId: 'ChIJtest1234567890ab',
      category: 'Restaurant',
      productsServices: 'Coffee, pastries',
      staffNames: 'Jane, John',
      highlightFacts: 'Open 24/7',
      avoidFacts: 'No parking',
      sampleResponses: 'Thank you!',
      website: 'https://example.com',
    });
    expect(parsed.category).toBe('Restaurant');
    expect(parsed.productsServices).toBe('Coffee, pastries');
    expect(parsed.website).toBe('https://example.com');
  });

  it('rejects javascript: schemes in website (XSS guard)', () => {
    expect(() =>
      BusinessOnboardingSchema.parse({
        businessName: 'Acme',
        googlePlaceId: 'ChIJtest1234567890ab',
        website: 'javascript:alert(1)',
      }),
    ).toThrow();
  });
});

describe('ForgotPasswordSchema', () => {
  it('normalizes email + requires role', () => {
    const parsed = ForgotPasswordSchema.parse({ email: 'Owner@Example.COM', role: 'owner' });
    expect(parsed.email).toBe('owner@example.com');
    expect(parsed.role).toBe('owner');
  });

  it('rejects unknown role', () => {
    expect(() => ForgotPasswordSchema.parse({ email: 'a@b.com', role: 'hacker' })).toThrow();
  });
});

describe('ResetPasswordSchema', () => {
  it('requires password >= 8 chars', () => {
    expect(() => ResetPasswordSchema.parse({ password: 'short' })).toThrow();
    expect(ResetPasswordSchema.parse({ password: 'password123' }).password).toBe('password123');
  });
});

describe('ResendConfirmationSchema', () => {
  it('normalizes email + requires flow', () => {
    const parsed = ResendConfirmationSchema.parse({ email: 'Owner@Example.COM', flow: 'owner' });
    expect(parsed.email).toBe('owner@example.com');
    expect(parsed.flow).toBe('owner');
  });
});

// ── Edge-case coverage ─────────────────────────────────────────────────

describe('email normalization edge cases', () => {
  // Minimal valid extras for SignupSchema so each test isolates the email check.
  const baseSignupBody = {
    ownerName: 'Jane',
    password: 'password123',
  };

  it('rejects number as email', () => {
    expect(() =>
      SignupSchema.parse({ ...baseSignupBody, ownerEmail: 42 }),
    ).toThrow();
  });

  it('rejects whitespace-only email', () => {
    expect(() =>
      SignupSchema.parse({ ...baseSignupBody, ownerEmail: '   ' }),
    ).toThrow();
  });

  it('rejects null email', () => {
    expect(() =>
      SignupSchema.parse({ ...baseSignupBody, ownerEmail: null }),
    ).toThrow();
  });

  it('rejects empty-string email', () => {
    expect(() =>
      SignupSchema.parse({ ...baseSignupBody, ownerEmail: '' }),
    ).toThrow();
  });

  it('also rejects these on ForgotPasswordSchema', () => {
    expect(() =>
      ForgotPasswordSchema.parse({ email: 42, role: 'owner' }),
    ).toThrow();
    expect(() =>
      ForgotPasswordSchema.parse({ email: '', role: 'owner' }),
    ).toThrow();
    expect(() =>
      ForgotPasswordSchema.parse({ email: null, role: 'owner' }),
    ).toThrow();
  });
});
