import { describe, it, expect } from 'vitest';
import {
  AUTH_FLOWS,
  isAuthFlow,
  loginUrlForFlow,
  resetPasswordPathForFlow,
} from '../auth-flow';

describe('AUTH_FLOWS', () => {
  it('equals [owner, admin]', () => {
    expect(AUTH_FLOWS).toEqual(['owner', 'admin']);
  });
});

describe('isAuthFlow', () => {
  it('returns true for owner', () => {
    expect(isAuthFlow('owner')).toBe(true);
  });

  it('returns true for admin', () => {
    expect(isAuthFlow('admin')).toBe(true);
  });

  it('returns false for owners', () => {
    expect(isAuthFlow('owners')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isAuthFlow('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAuthFlow(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAuthFlow(undefined)).toBe(false);
  });
});

describe('loginUrlForFlow', () => {
  it('returns /admin/login for admin', () => {
    expect(loginUrlForFlow('admin')).toBe('/admin/login');
  });

  it('returns /login for owner', () => {
    expect(loginUrlForFlow('owner')).toBe('/login');
  });

  it('returns /admin/login for undefined (legacy admin default — spec §3.5)', () => {
    expect(loginUrlForFlow(undefined)).toBe('/admin/login');
  });
});

describe('resetPasswordPathForFlow', () => {
  it('returns /admin/reset-password for admin', () => {
    expect(resetPasswordPathForFlow('admin')).toBe('/admin/reset-password');
  });

  it('returns /reset-password for owner', () => {
    expect(resetPasswordPathForFlow('owner')).toBe('/reset-password');
  });
});
