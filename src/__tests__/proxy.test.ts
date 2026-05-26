import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { proxy } from '../proxy';

const { getUser, getAuthenticatorAssuranceLevel, selfRow } = vi.hoisted(() => ({
  getUser: vi.fn(),
  getAuthenticatorAssuranceLevel: vi.fn(),
  selfRow: {
    value: { role: 'sales_partner', account_id: null } as { role: string; account_id: string | null } | null,
  },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser,
      mfa: {
        getAuthenticatorAssuranceLevel,
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            single: () => Promise.resolve({
              data: selfRow.value,
              error: null,
            }),
          }),
        }),
      }),
    }),
  })),
}));

function request(url: string): NextRequest {
  const parsed = new URL(url);
  return new NextRequest(url, {
    headers: {
      host: parsed.host,
    },
  });
}

function hasComingSoonProxyHeader(response: Response): boolean {
  return Array.from(response.headers.entries()).some(([key, value]) => {
    return key.toLowerCase().includes('coming-soon') || value.toLowerCase().includes('x-coming-soon');
  });
}

describe('proxy public launch host behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: null } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
      error: null,
    });
    selfRow.value = { role: 'sales_partner', account_id: null };
    process.env.MFA_ENFORCEMENT_ENABLED = 'false';
  });

  it('does not inject coming-soon headers for repworth.net public pages', async () => {
    const response = await proxy(request('https://repworth.net/'));

    expect(response.headers.get('location')).toBeNull();
    expect(hasComingSoonProxyHeader(response)).toBe(false);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('allows repworth.net owner login to pass through as a public route', async () => {
    const response = await proxy(request('https://repworth.net/login'));

    expect(response.headers.get('location')).toBeNull();
    expect(hasComingSoonProxyHeader(response)).toBe(false);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('uses normal admin auth redirect behavior on repworth.net protected pages', async () => {
    const response = await proxy(request('https://repworth.net/admin/overview'));
    const location = response.headers.get('location');

    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.origin).toBe('https://repworth.net');
    expect(redirect.pathname).toBe('/admin/login');
    expect(redirect.searchParams.get('from')).toBe('/admin/overview');
  });

  it('returns 401 for unauthenticated billing API requests', async () => {
    const response = await proxy(request('https://repworth.net/api/billing/checkout'));

    expect(response.status).toBe(401);
    expect(createServerClient).toHaveBeenCalledTimes(1);
  });

  it('returns 401 for unauthenticated location API requests', async () => {
    const response = await proxy(request('https://repworth.net/api/locations/add'));

    expect(response.status).toBe(401);
    expect(createServerClient).toHaveBeenCalledTimes(1);
  });

  it('redirects sales_partner away from protected admin pages', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-sales' } } });

    const response = await proxy(request('https://repworth.net/admin/overview'));
    const location = response.headers.get('location');

    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/admin/login');
    expect(redirect.searchParams.get('from')).toBe('/admin/overview');
  });

  it('returns 403 for sales_partner admin API requests', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-sales' } } });

    const response = await proxy(request('https://repworth.net/api/admin/overview'));

    expect(response.status).toBe(403);
  });

  it('redirects sales_partner away from protected onboarding pages', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-sales' } } });

    const response = await proxy(request('https://repworth.net/onboarding/start'));
    const location = response.headers.get('location');

    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/login');
    expect(redirect.searchParams.get('from')).toBe('/onboarding/start');
  });

  it('redirects unauthenticated MFA challenge requests to owner login', async () => {
    const response = await proxy(request('https://repworth.net/mfa/challenge'));
    const location = response.headers.get('location');

    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/login');
    expect(redirect.searchParams.get('from')).toBe('/mfa/challenge');
  });

  it('redirects enrolled admin AAL1 sessions to MFA challenge when enforcement is enabled', async () => {
    process.env.MFA_ENFORCEMENT_ENABLED = 'true';
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-admin' } } });
    selfRow.value = { role: 'admin', account_id: null };
    getAuthenticatorAssuranceLevel.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    const response = await proxy(request('https://repworth.net/admin/overview'));
    const location = response.headers.get('location');

    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/mfa/challenge');
    expect(redirect.searchParams.get('next')).toBe('/admin/overview');
  });
});
