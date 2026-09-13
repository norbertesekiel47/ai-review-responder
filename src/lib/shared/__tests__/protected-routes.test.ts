import { describe, it, expect } from 'vitest';
import {
  isAdminApiRoute,
  isAdminImpersonationApiRoute,
  isProtectedMixedRoleApiRoute,
  isProtectedOwnerApiRoute,
  isProtectedRoute,
  normalizePath,
} from '../protected-routes';

const PUBLIC: string[] = [
  '/admin/login',
  '/admin/forgot-password',
  '/admin/reset-password',
  '/signup',
  '/signup/check-email',
  '/signup/finish',
  '/login',
  '/forgot-password',
  '/reset-password',
  '/',
  '/pricing',
  '/features',
  '/how-it-works',
  // Self-serve signup auth APIs — never under /api/admin, /api/dashboard, or
  // /api/settings, so isProtectedRoute() must return false for each.
  '/api/auth/signup',
  '/api/auth/finish-signup',
  '/api/auth/signup-status',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/resend-confirmation',
  '/api/auth/verify-otp',
  '/api/auth/callback',
  '/api/zernio/connect/callback',
  // API-side onboarding routes follow the same pattern as /api/auth/*:
  // proxy classifies them as public (so it doesn't set up a Supabase
  // client per request) and the route handlers do their own session
  // reads + role checks internally. NOT under /onboarding/* — that prefix
  // gates only the SSR pages.
  '/api/onboarding/business',
  '/api/onboarding/select-plan',
  // Owner offboarding keep-my-data is token-authenticated and clicked from an
  // email by a (logged-out) owner: GET renders a public confirmation page, POST
  // validates the raw token. It must NOT require a session — the route does its
  // own token validation. (Regression for staging dry-run defect D2.)
  '/api/account/offboarding/keep-my-data',
];

const PROTECTED: string[] = [
  '/admin',
  '/admin/impersonate',
  '/admin/impersonate/session/view',
  '/api/admin/businesses',
  '/api/billing',
  '/api/billing/checkout',
  '/api/billing/portal',
  '/api/billing/tier-change',
  '/api/locations',
  '/api/locations/add',
  '/api/locations/archive',
  '/api/locations/promote-primary',
  '/api/locations/reactivate',
  '/dashboard',
  '/dashboard/settings',
  '/settings',
  '/mfa/challenge',
  '/api/dashboard',
  '/api/settings',
  '/api/account/settings',
  '/api/account/offboarding/confirm',
  '/api/account/offboarding/reactivate',
  '/api/account/offboarding/status',
  '/account/offboarding/status',
  '/api/zernio/connect/start',
  '/api/zernio/connect/cancel',
  '/api/zernio/connect/select-location',
  '/api/zernio/disconnect',
  '/onboarding',
  '/onboarding/pay',
  '/onboarding/payment-success',
];

describe('isProtectedRoute', () => {
  PUBLIC.forEach((p) => {
    it(`${p} is public`, () => expect(isProtectedRoute(p)).toBe(false));
  });
  PROTECTED.forEach((p) => {
    it(`${p} is protected`, () => expect(isProtectedRoute(p)).toBe(true));
  });

  // Trailing-slash normalization. Next.js's default trailingSlash: false
  // redirects /x/ → /x, but that runs AFTER proxy sees the path —
  // without normalization the exemption checks miss and public routes
  // wrongly fall through to the protected prefix branches.
  describe('trailing slash normalization', () => {
    it('exempts /admin/login/ (public auth surface, was wrongly protected)', () => {
      expect(isProtectedRoute('/admin/login/')).toBe(false);
    });

    it('exempts /admin/forgot-password/', () => {
      expect(isProtectedRoute('/admin/forgot-password/')).toBe(false);
    });

    it('exempts /admin/reset-password/', () => {
      expect(isProtectedRoute('/admin/reset-password/')).toBe(false);
    });

    it('still protects /admin/impersonate/ (trailing slash on a protected page)', () => {
      expect(isProtectedRoute('/admin/impersonate/')).toBe(true);
    });

    it('still protects /onboarding/ (trailing slash on a protected page)', () => {
      expect(isProtectedRoute('/onboarding/')).toBe(true);
    });

    it('preserves the root path / (single trailing slash IS the path)', () => {
      expect(isProtectedRoute('/')).toBe(false);
    });

    it('handles multiple trailing slashes (/admin/login//)', () => {
      // Defensive: if a misbehaving client sends /admin/login//, the
      // /\/+$/ regex strips ALL trailing slashes so the match still works.
      expect(isProtectedRoute('/admin/login//')).toBe(false);
    });
  });
});

describe('case-insensitive path normalization (F-26)', () => {
  it('normalizePath lowercases and strips trailing slashes', () => {
    expect(normalizePath('/ADMIN/')).toBe('/admin');
    expect(normalizePath('/API/Dashboard')).toBe('/api/dashboard');
    expect(normalizePath('/')).toBe('/');
  });

  it('protects uppercase variants of protected prefixes', () => {
    expect(isProtectedRoute('/ADMIN/secret')).toBe(true);
    expect(isProtectedRoute('/API/ADMIN/businesses')).toBe(true);
    expect(isProtectedRoute('/Dashboard')).toBe(true);
    expect(isProtectedOwnerApiRoute('/API/Dashboard')).toBe(true);
    expect(isProtectedRoute('/MFA/Challenge')).toBe(true);
  });

  it('still exempts the public auth surfaces case-insensitively', () => {
    expect(isProtectedRoute('/ADMIN/LOGIN')).toBe(false);
    expect(isProtectedRoute('/Admin/Forgot-Password')).toBe(false);
    expect(isProtectedRoute('/Admin/Reset-Password')).toBe(false);
  });
});

describe('protected API route roles', () => {
  it('keeps Zernio connect APIs owner-only', () => {
    expect(isProtectedOwnerApiRoute('/api/zernio/connect/start')).toBe(true);
    expect(isProtectedMixedRoleApiRoute('/api/zernio/connect/start')).toBe(false);
  });

  it('keeps Zernio disconnect mixed-role for owner and admin callers', () => {
    expect(isProtectedOwnerApiRoute('/api/zernio/disconnect')).toBe(false);
    expect(isProtectedMixedRoleApiRoute('/api/zernio/disconnect')).toBe(true);
  });

  it('exempts owner offboarding keep-my-data (token-authenticated, email-clicked)', () => {
    // Regression for staging dry-run defect D2: the blanket /api/account/* owner
    // gate trapped this public token-auth route, 401'ing logged-out owners who
    // clicked the keep-my-data link in their email. The sibling confirm/
    // reactivate/status routes stay owner-protected.
    expect(isProtectedOwnerApiRoute('/api/account/offboarding/keep-my-data')).toBe(false);
    expect(isProtectedRoute('/api/account/offboarding/keep-my-data')).toBe(false);
    expect(isProtectedOwnerApiRoute('/api/account/offboarding/confirm')).toBe(true);
  });

  it('isProtectedOwnerApiRoute returns true for /api/operator, /api/operator/turns, /api/operator/conversation and both proposal routes', () => {
    // Architecture pass 2026-09-12, H1-A. Proxy branch 6 (src/proxy.ts:349-364)
    // is the only place getAalGate() runs for an API route, and it keys off
    // THIS predicate. Without the arm, an owner under MFA enforcement answers a
    // 403 on /api/settings and a 200 on /api/operator — while both change the
    // same `businesses` voice columns. ONE allowlist entry, no fourth branch.
    expect(isProtectedOwnerApiRoute('/api/operator')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/turns')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/turns/0199a0f0-0000-7000-8000-000000000001')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/conversation')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/proposals/0199a0f0-0000-7000-8000-000000000002/apply')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/proposals/0199a0f0-0000-7000-8000-000000000002/decline')).toBe(true);
    // Normalization still applies — the gate must not be casing-bypassable.
    expect(isProtectedOwnerApiRoute('/API/Operator/Turns')).toBe(true);
    expect(isProtectedOwnerApiRoute('/api/operator/')).toBe(true);
    // And it must not swallow a neighbouring prefix.
    expect(isProtectedOwnerApiRoute('/api/operators')).toBe(false);
    // isProtectedRoute picks it up through isProtectedAppApiRoute, which is
    // what actually admits the request to the branch chain.
    expect(isProtectedRoute('/api/operator/turns')).toBe(true);
  });
});

describe('isAdminApiRoute', () => {
  // Extracted in #1186 so `src/proxy.ts`'s CORS block and `isProtectedRoute`
  // decide "is this the Admin API?" from ONE definition. It is pinned here as
  // well as from the proxy suite because this module is its home: a mutation
  // that only the proxy tests catch leaves this module's own suite claiming a
  // coverage it does not have (red-team round 2, RT-13).
  it('matches /api/admin and everything under it', () => {
    for (const path of [
      '/api/admin',
      '/api/admin/overview',
      '/api/admin/businesses/abc',
      '/api/admin/impersonation/start',
    ]) {
      expect(isAdminApiRoute(path), path).toBe(true);
    }
  });

  it('does not match a lookalike prefix or a non-admin API path', () => {
    for (const path of ['/api/adminfoo', '/api/adm', '/api', '/admin', '/admin/impersonate', '/']) {
      expect(isAdminApiRoute(path), path).toBe(false);
    }
  });

  it('takes an ALREADY-normalized path — normalization belongs to callers', () => {
    // Its callers (isProtectedRoute above, and src/proxy.ts) both normalize
    // first. Stated as a test so the contract is not just a comment: passing a
    // raw path is a caller bug, not something this function silently absorbs.
    expect(isAdminApiRoute('/API/Admin/overview')).toBe(false);
    expect(isAdminApiRoute(normalizePath('/API/Admin/overview'))).toBe(true);
    expect(isAdminApiRoute('/api/admin/')).toBe(true);
    expect(isAdminApiRoute(normalizePath('/api/admin/'))).toBe(true);
  });

  it('agrees with isProtectedRoute on the whole admin API surface', () => {
    for (const path of ['/api/admin', '/api/admin/overview', '/API/Admin/businesses']) {
      expect(isProtectedRoute(path), path).toBe(true);
    }
    expect(isAdminApiRoute(normalizePath('/api/adminfoo'))).toBe(false);
  });
});

describe('isAdminImpersonationApiRoute', () => {
  it.each(['/api/admin/impersonation', '/api/admin/impersonation/start', '/API/Admin/Impersonation/END/'])(
    'retains the exact normalized exception %s',
    (path) => expect(isAdminImpersonationApiRoute(normalizePath(path))).toBe(true),
  );
  it.each(['/api/admin', '/api/admin/overview', '/api/admin/impersonation-extra', '/api/admin/impersonations/start', '/admin/impersonate'])(
    'does not grant the cookie exception to %s',
    (path) => expect(isAdminImpersonationApiRoute(normalizePath(path))).toBe(false),
  );
});
