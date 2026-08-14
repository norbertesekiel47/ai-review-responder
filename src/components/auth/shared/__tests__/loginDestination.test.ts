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
      applySubscriptionGuard('admin', {
        subscriptionStatus: 'pending_payment',
        funnelUrl: '/onboarding/start',
      }),
    ).toBeNull();
  });

  it('applySubscriptionGuard uses the server-supplied funnelUrl', () => {
    // The guard no longer re-derives the destination from subscriptionStatus:
    // that branch was demo-blind and sent every pending_payment owner to
    // /onboarding/pay. Whatever the server computed wins — including the two
    // demo destinations the browser could never have known about.
    for (const funnelUrl of [
      '/onboarding/start',
      '/onboarding/demo',
      '/onboarding/pay',
      '/onboarding/business',
    ]) {
      expect(
        applySubscriptionGuard('owner', { subscriptionStatus: 'pending_payment', funnelUrl }),
      ).toBe(funnelUrl);
    }

    // subscriptionStatus is NOT consulted — a stale/absent status cannot
    // override the server's answer.
    expect(
      applySubscriptionGuard('owner', { funnelUrl: '/onboarding/demo' }),
    ).toBe('/onboarding/demo');
    expect(
      applySubscriptionGuard('owner', {
        subscriptionStatus: 'active',
        businessOnboarded: true,
        funnelUrl: '/onboarding/business',
      }),
    ).toBe('/onboarding/business');
  });

  it('treats a /dashboard funnelUrl as "no override" so a valid from still wins', () => {
    expect(
      applySubscriptionGuard(
        'owner',
        { subscriptionStatus: 'active', businessOnboarded: true, funnelUrl: '/dashboard' },
        '/settings/voice',
      ),
    ).toBeNull();
  });

  it('does not override an explicit onboarding return path for pending_payment owners', () => {
    expect(
      applySubscriptionGuard(
        'owner',
        { subscriptionStatus: 'pending_payment', funnelUrl: '/onboarding/pay' },
        '/onboarding/start',
      ),
    ).toBeNull();
  });

  it('returns null when funnelUrl is absent (older cached response → soft-fail)', () => {
    // Documented absence rule: a missing funnelUrl means NO override, the same
    // posture useLoginSubmit already takes when the status fetch soft-fails.
    expect(
      applySubscriptionGuard('owner', { subscriptionStatus: 'pending_payment' }),
    ).toBeNull();
    expect(
      applySubscriptionGuard('owner', { subscriptionStatus: 'active', businessOnboarded: false }),
    ).toBeNull();
  });

  it('rejects a funnelUrl that is not a same-origin absolute path', () => {
    // The result is handed straight to router.push.
    expect(
      applySubscriptionGuard('owner', { funnelUrl: '//evil.example.com' }),
    ).toBeNull();
    expect(
      applySubscriptionGuard('owner', { funnelUrl: 'https://evil.example.com' }),
    ).toBeNull();
  });

  it('returns null when status is past_due or cancelled (banner handles it)', () => {
    expect(
      applySubscriptionGuard('owner', { subscriptionStatus: 'past_due', funnelUrl: '/dashboard' }),
    ).toBeNull();
    expect(
      applySubscriptionGuard('owner', { subscriptionStatus: 'cancelled', funnelUrl: '/dashboard' }),
    ).toBeNull();
  });

  it('returns null for an undefined status payload', () => {
    expect(applySubscriptionGuard('owner', undefined)).toBeNull();
  });
});
