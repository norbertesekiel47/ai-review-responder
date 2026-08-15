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

// Admin onboarding is invite-only identity capture. The place / voice / tier
// fields the admin used to send — and with them the googlePlaceId isPlaceId
// refine and the googlePlaceId-vs-googleMapsUrl XOR — moved to the OWNER's
// funnel, so all that remains is a three-field contract. These pin that
// contract at the schema layer; the persistence consequence of stripping is
// pinned in src/app/api/admin/businesses/__tests__/route.test.ts.
describe('OnboardBusinessSchema — admin invite contract', () => {
  function validBaseBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Acme Cafe',
      ownerName: 'Jane Smith',
      ownerEmail: 'jane@acme.example',
      ...overrides,
    };
  }

  it('accepts exactly owner email, owner name and business name', () => {
    const result = OnboardBusinessSchema.safeParse(validBaseBody());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(
        ['name', 'ownerEmail', 'ownerName'].sort(),
      );
    }
  });

  it.each(['name', 'ownerName', 'ownerEmail'])('requires %s', (field) => {
    const body = validBaseBody();
    delete (body as Record<string, unknown>)[field];
    expect(OnboardBusinessSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a malformed owner email', () => {
    expect(
      OnboardBusinessSchema.safeParse(validBaseBody({ ownerEmail: 'nope' })).success,
    ).toBe(false);
  });

  // Zod's object default. Deliberate: a stale admin bundle POSTing the old
  // 15-field payload still onboards its owner instead of 400-ing mid-deploy,
  // and stripping is what guarantees the removed fields cannot reach the
  // createBusinessTx write.
  it('strips place, voice and tier fields instead of rejecting them', () => {
    const result = OnboardBusinessSchema.safeParse(
      validBaseBody({
        googlePlaceId: 'ChIJgUbEo8cfqokR5lP9Wh_DaM',
        googleMapsUrl: 'https://www.google.com/maps/place/Acme+Cafe/@40.7,-74.0,15z',
        tone: 'contraband',
        staffNames: 'Carol',
        subscriptionTier: 'autopilot',
        ownerPhone: '+1 555 000 0000',
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(
        ['name', 'ownerEmail', 'ownerName'].sort(),
      );
    }
  });
});
