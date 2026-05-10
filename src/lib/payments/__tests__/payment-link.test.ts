import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildPaymentLinkUrl } from '../payment-link';

// Snapshot any pre-existing env values so this test suite can't leak its
// dummy STRIPE_PAYMENT_LINK_* values into other tests sharing the vitest
// worker. afterEach restores; setting `undefined` directly would coerce
// to the literal string "undefined" so we delete keys whose snapshot was
// undefined.
const _origFounding = process.env.STRIPE_PAYMENT_LINK_FOUNDING;
const _origStandard = process.env.STRIPE_PAYMENT_LINK_STANDARD;

beforeEach(() => {
  process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'https://buy.stripe.com/test_F';
  process.env.STRIPE_PAYMENT_LINK_STANDARD = 'https://buy.stripe.com/test_S';
});

afterEach(() => {
  if (_origFounding === undefined) {
    delete process.env.STRIPE_PAYMENT_LINK_FOUNDING;
  } else {
    process.env.STRIPE_PAYMENT_LINK_FOUNDING = _origFounding;
  }
  if (_origStandard === undefined) {
    delete process.env.STRIPE_PAYMENT_LINK_STANDARD;
  } else {
    process.env.STRIPE_PAYMENT_LINK_STANDARD = _origStandard;
  }
});

describe('buildPaymentLinkUrl', () => {
  it('appends client_reference_id + prefilled_email for founders tier', () => {
    const url = buildPaymentLinkUrl('founders', 'biz-123', 'owner@example.com');
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('client_reference_id')).toBe('biz-123');
    expect(parsed.searchParams.get('prefilled_email')).toBe('owner@example.com');
    expect(parsed.origin + parsed.pathname).toBe('https://buy.stripe.com/test_F');
  });

  it('uses standard env var for standard tier', () => {
    const url = buildPaymentLinkUrl('standard', 'biz-456', 'owner@example.com');
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('client_reference_id')).toBe('biz-456');
    expect(parsed.origin + parsed.pathname).toBe('https://buy.stripe.com/test_S');
  });

  it('returns null when env var is unset', () => {
    delete process.env.STRIPE_PAYMENT_LINK_FOUNDING;
    const url = buildPaymentLinkUrl('founders', 'biz-789', 'owner@example.com');
    expect(url).toBeNull();
  });

  it('URL-encodes email with special characters', () => {
    const url = buildPaymentLinkUrl('founders', 'biz-001', 'owner+tag@e.com');
    expect(url).not.toBeNull();
    // URLSearchParams encodes '+' as '%2B so the raw query string contains it
    expect(url!).toContain('owner%2Btag%40e.com');
  });

  it('appends with & when base URL already has a query string', () => {
    process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'https://buy.stripe.com/test_F?utm_source=x';
    const url = buildPaymentLinkUrl('founders', 'biz-002', 'owner@example.com');
    expect(url).not.toBeNull();
    expect(url!).toMatch(/\?utm_source=x&/);
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('client_reference_id')).toBe('biz-002');
    expect(parsed.searchParams.get('utm_source')).toBe('x');
  });

  it('returns null when env var is a malformed URL', () => {
    process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'not a url';
    expect(buildPaymentLinkUrl('founders', 'biz-1', 'a@b.com')).toBeNull();
  });

  // Scheme enforcement — Stripe Payment Links are always https://. The URL
  // constructor accepts other schemes but the result flows into a
  // window.location.href + clickable <a href>, so we have to fail closed
  // on anything but https to keep XSS / phishing / downgrade attempts out.
  describe('scheme enforcement (https-only)', () => {
    it('rejects javascript: URL (XSS vector)', () => {
      process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'javascript:alert(1)';
      expect(buildPaymentLinkUrl('founders', 'biz-1', 'a@b.com')).toBeNull();
    });

    it('rejects data: URL (phishing vector)', () => {
      process.env.STRIPE_PAYMENT_LINK_FOUNDING =
        'data:text/html,<script>alert(1)</script>';
      expect(buildPaymentLinkUrl('founders', 'biz-1', 'a@b.com')).toBeNull();
    });

    it('rejects http: URL (downgrade attack)', () => {
      process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'http://buy.stripe.com/test_F';
      expect(buildPaymentLinkUrl('founders', 'biz-1', 'a@b.com')).toBeNull();
    });

    it('rejects file: URL', () => {
      process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'file:///etc/passwd';
      expect(buildPaymentLinkUrl('founders', 'biz-1', 'a@b.com')).toBeNull();
    });

    it('rejects ftp: URL', () => {
      process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'ftp://buy.stripe.com/test_F';
      expect(buildPaymentLinkUrl('founders', 'biz-1', 'a@b.com')).toBeNull();
    });

    it('accepts a real https:// Stripe Payment Link', () => {
      process.env.STRIPE_PAYMENT_LINK_FOUNDING =
        'https://buy.stripe.com/test_F';
      const url = buildPaymentLinkUrl('founders', 'biz-1', 'a@b.com');
      expect(url).not.toBeNull();
      expect(url!.startsWith('https://')).toBe(true);
    });
  });
});
