import { describe, it, expect } from 'vitest';
import { isProtectedRoute } from '../protected-routes';

describe('isProtectedRoute', () => {
  it('matches /admin and sub-paths', () => {
    expect(isProtectedRoute('/admin')).toBe(true);
    expect(isProtectedRoute('/admin/businesses')).toBe(true);
    expect(isProtectedRoute('/admin/businesses/123')).toBe(true);
  });

  it('does not match /admin/login', () => {
    expect(isProtectedRoute('/admin/login')).toBe(false);
  });

  it('does not match /administration (segment boundary)', () => {
    expect(isProtectedRoute('/administration')).toBe(false);
  });

  it('matches /api/admin paths', () => {
    expect(isProtectedRoute('/api/admin')).toBe(true);
    expect(isProtectedRoute('/api/admin/users')).toBe(true);
  });

  it('matches /api/dashboard and /api/settings paths', () => {
    expect(isProtectedRoute('/api/dashboard')).toBe(true);
    expect(isProtectedRoute('/api/dashboard/reviews')).toBe(true);
    expect(isProtectedRoute('/api/settings')).toBe(true);
    expect(isProtectedRoute('/api/settings/profile')).toBe(true);
  });

  it('matches /dashboard and /settings paths', () => {
    expect(isProtectedRoute('/dashboard')).toBe(true);
    expect(isProtectedRoute('/dashboard/reviews')).toBe(true);
    expect(isProtectedRoute('/settings')).toBe(true);
    expect(isProtectedRoute('/settings/notifications')).toBe(true);
  });

  it('does not match public paths', () => {
    expect(isProtectedRoute('/')).toBe(false);
    expect(isProtectedRoute('/privacy')).toBe(false);
    expect(isProtectedRoute('/terms')).toBe(false);
    expect(isProtectedRoute('/features')).toBe(false);
    expect(isProtectedRoute('/pricing')).toBe(false);
    expect(isProtectedRoute('/book-a-demo')).toBe(false);
    expect(isProtectedRoute('/how-it-works')).toBe(false);
  });
});
