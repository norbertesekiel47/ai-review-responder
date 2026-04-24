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
];

const PROTECTED: string[] = [
  '/admin',
  '/admin/overview',
  '/admin/businesses',
  '/api/admin/businesses',
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
});
