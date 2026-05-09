import { describe, it, expect } from 'vitest';
import { isProtectedRoute } from '../protected-routes';

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
  // API-side onboarding routes follow the same pattern as /api/auth/*:
  // middleware classifies them as public (so it doesn't set up a Supabase
  // client per request) and the route handlers do their own session
  // reads + role checks internally. NOT under /onboarding/* — that prefix
  // gates only the SSR pages.
  '/api/onboarding/business',
  '/api/onboarding/select-plan',
];

const PROTECTED: string[] = [
  '/admin',
  '/admin/overview',
  '/admin/businesses',
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
  '/api/dashboard',
  '/api/settings',
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
  // redirects /x/ → /x, but that runs AFTER middleware sees the path —
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

    it('still protects /admin/overview/ (trailing slash on a protected page)', () => {
      expect(isProtectedRoute('/admin/overview/')).toBe(true);
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
