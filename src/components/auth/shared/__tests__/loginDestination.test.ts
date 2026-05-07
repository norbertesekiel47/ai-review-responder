import { describe, expect, it } from 'vitest';
import { resolvePostLoginDestination, applySubscriptionGuard } from '../loginDestination';

describe('resolvePostLoginDestination (owner)', () => {
  it('returns from when it is an allowed owner prefix', () => {
    expect(
      resolvePostLoginDestination('owner', '/dashboard/x', '/dashboard'),
    ).toBe('/dashboard/x');
  });
  it('falls back to defaultRoute when from is not allow-listed', () => {
    expect(
      resolvePostLoginDestination('owner', '/admin/overview', '/dashboard'),
    ).toBe('/dashboard');
  });
  it('rejects protocol-relative URLs', () => {
    expect(
      resolvePostLoginDestination('owner', '//evil.com', '/dashboard'),
    ).toBe('/dashboard');
  });
  it('rejects non-absolute paths', () => {
    expect(
      resolvePostLoginDestination('owner', 'dashboard', '/dashboard'),
    ).toBe('/dashboard');
  });
});

describe('resolvePostLoginDestination (admin)', () => {
  it('accepts /admin paths that are not auth pages', () => {
    expect(
      resolvePostLoginDestination('admin', '/admin/overview', '/admin/overview'),
    ).toBe('/admin/overview');
  });
  it('rejects admin auth pages to avoid login loops', () => {
    expect(
      resolvePostLoginDestination('admin', '/admin/login', '/admin/overview'),
    ).toBe('/admin/overview');
    expect(
      resolvePostLoginDestination('admin', '/admin/forgot-password', '/admin/overview'),
    ).toBe('/admin/overview');
  });
  it('rejects non-/admin paths', () => {
    expect(
      resolvePostLoginDestination('admin', '/dashboard', '/admin/overview'),
    ).toBe('/admin/overview');
  });
});

describe('applySubscriptionGuard', () => {
  it('returns null for admin portal', () => {
    expect(
      applySubscriptionGuard('admin', { subscriptionStatus: 'pending_payment' }),
    ).toBeNull();
  });
  it('returns /onboarding/pay for pending_payment owners', () => {
    expect(
      applySubscriptionGuard('owner', { subscriptionStatus: 'pending_payment' }),
    ).toBe('/onboarding/pay');
  });
  it('returns /onboarding/business for active+!businessOnboarded owners', () => {
    expect(
      applySubscriptionGuard('owner', {
        subscriptionStatus: 'active',
        businessOnboarded: false,
      }),
    ).toBe('/onboarding/business');
  });
  it('returns null when active and businessOnboarded', () => {
    expect(
      applySubscriptionGuard('owner', {
        subscriptionStatus: 'active',
        businessOnboarded: true,
      }),
    ).toBeNull();
  });
  it('returns null when status is past_due or cancelled (banner handles it)', () => {
    expect(applySubscriptionGuard('owner', { subscriptionStatus: 'past_due' })).toBeNull();
    expect(applySubscriptionGuard('owner', { subscriptionStatus: 'cancelled' })).toBeNull();
  });
  it('returns null for an undefined status payload', () => {
    expect(applySubscriptionGuard('owner', undefined)).toBeNull();
  });
});
