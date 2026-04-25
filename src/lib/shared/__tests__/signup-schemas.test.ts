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

  it('parses successfully with businessName + googleMapsUrl', () => {
    const parsed = BusinessOnboardingSchema.parse({
      businessName: 'Acme',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
    });
    expect(parsed.googleMapsUrl).toBe('https://maps.google.com/?cid=123');
  });

  it('rejects when neither googlePlaceId nor googleMapsUrl is provided (XOR refine)', () => {
    expect(() =>
      BusinessOnboardingSchema.parse({ businessName: 'Acme' }),
    ).toThrow();
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
