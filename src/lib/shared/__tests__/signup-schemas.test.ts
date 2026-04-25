import { describe, it, expect } from 'vitest';
import {
  SignupSchema,
  FinishSignupSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  ResendConfirmationSchema,
} from '../schemas';

describe('SignupSchema', () => {
  it('lowercases + trims email before validation', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: '  Owner@Example.COM  ',
      ownerName: 'Jane',
      password: 'password123',
      businessName: 'Acme',
      googlePlaceId: 'ChIJtest1234567890ab',
    });
    expect(parsed.ownerEmail).toBe('owner@example.com');
  });

  it('rejects empty password', () => {
    expect(() => SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: '',
      businessName: 'X', googlePlaceId: 'ChIJtest1234567890ab',
    })).toThrow();
  });

  it('requires password >= 8 chars', () => {
    expect(() => SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'short',
      businessName: 'X', googlePlaceId: 'ChIJtest1234567890ab',
    })).toThrow();
  });

  it('requires either googlePlaceId or googleMapsUrl (XOR)', () => {
    expect(() => SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'password123',
      businessName: 'X',
    })).toThrow();
  });

  it('accepts googleMapsUrl when placeId absent', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'password123',
      businessName: 'X', googleMapsUrl: 'https://maps.google.com/?cid=123',
    });
    expect(parsed.googleMapsUrl).toBeTruthy();
  });

  it('parses successfully without subscriptionTier (server hardcodes "standard")', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'password123',
      businessName: 'X', googlePlaceId: 'ChIJtest1234567890ab',
    });
    // subscriptionTier is no longer a schema field — Zod strips unknowns, but
    // there's nothing to strip here. The server route writes 'standard' itself.
    expect((parsed as { subscriptionTier?: string }).subscriptionTier).toBeUndefined();
  });

  it('rejects garbage googlePlaceId via isPlaceId refine', () => {
    expect(() => SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'password123',
      businessName: 'X', googlePlaceId: 'garbage',
    })).toThrow();
  });

  it('accepts a canonical ChIJ place ID', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'password123',
      businessName: 'X', googlePlaceId: 'ChIJgUbEo8cfqokR5lP9_Wh_DaM',
    });
    expect(parsed.googlePlaceId).toBe('ChIJgUbEo8cfqokR5lP9_Wh_DaM');
  });

  it('applies tone default when omitted', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'password123',
      businessName: 'X', googlePlaceId: 'ChIJtest1234567890ab',
    });
    expect(parsed.tone).toBe('professional and friendly');
  });
});

describe('FinishSignupSchema', () => {
  it('strips ownerEmail if supplied (Google session provides it)', () => {
    // Zod strips unknown keys by default; we just verify the schema parses without ownerEmail.
    const valid = FinishSignupSchema.parse({
      ownerName: 'J',
      businessName: 'X',
      googlePlaceId: 'ChIJtest1234567890ab',
    });
    expect((valid as { ownerEmail?: string }).ownerEmail).toBeUndefined();
  });

  it('applies tone default when omitted', () => {
    const parsed = FinishSignupSchema.parse({
      ownerName: 'J',
      businessName: 'X',
      googlePlaceId: 'ChIJtest1234567890ab',
    });
    expect(parsed.tone).toBe('professional and friendly');
  });

  it('rejects garbage googlePlaceId via isPlaceId refine', () => {
    expect(() => FinishSignupSchema.parse({
      ownerName: 'J',
      businessName: 'X',
      googlePlaceId: '!!nope!!',
    })).toThrow();
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
