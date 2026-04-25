import { describe, it, expect, beforeEach } from 'vitest';
import { buildPaymentLinkUrl } from '../payment-link';

beforeEach(() => {
  process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'https://buy.stripe.com/test_F';
  process.env.STRIPE_PAYMENT_LINK_STANDARD = 'https://buy.stripe.com/test_S';
});

describe('buildPaymentLinkUrl', () => {
  it('appends client_reference_id + prefilled_email for founding tier', () => {
    const url = buildPaymentLinkUrl('founding', 'biz-123', 'owner@example.com');
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
    const url = buildPaymentLinkUrl('founding', 'biz-789', 'owner@example.com');
    expect(url).toBeNull();
  });

  it('URL-encodes email with special characters', () => {
    const url = buildPaymentLinkUrl('founding', 'biz-001', 'owner+tag@e.com');
    expect(url).not.toBeNull();
    // URLSearchParams encodes '+' as '%2B so the raw query string contains it
    expect(url!).toContain('owner%2Btag%40e.com');
  });

  it('appends with & when base URL already has a query string', () => {
    process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'https://buy.stripe.com/test_F?utm_source=x';
    const url = buildPaymentLinkUrl('founding', 'biz-002', 'owner@example.com');
    expect(url).not.toBeNull();
    expect(url!).toMatch(/\?utm_source=x&/);
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('client_reference_id')).toBe('biz-002');
    expect(parsed.searchParams.get('utm_source')).toBe('x');
  });

  it('returns null when env var is a malformed URL', () => {
    process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'not a url';
    expect(buildPaymentLinkUrl('founding', 'biz-1', 'a@b.com')).toBeNull();
  });
});
