import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { proxy } from '../proxy';
import { REQUEST_PATHNAME_HEADER } from '@/lib/shared/request-path-header';

const {
  getUser,
  getAuthenticatorAssuranceLevel,
  selfRow,
  setSupabaseCookies,
} = vi.hoisted(() => ({
  getUser: vi.fn(),
  getAuthenticatorAssuranceLevel: vi.fn(),
  selfRow: {
    value: { role: 'sales_partner', account_id: null } as { role: string; account_id: string | null } | null,
  },
  setSupabaseCookies: { value: false },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: {
    cookies?: {
      setAll?: (cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => void;
    };
  }) => {
    if (setSupabaseCookies.value) {
      options.cookies?.setAll?.([
        { name: 'sb-refresh-token', value: 'updated', options: { path: '/' } },
      ]);
    }
    return {
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
    };
  }),
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
    setSupabaseCookies.value = false;
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

  it('redirects unauthenticated account status page requests to owner login', async () => {
    const response = await proxy(request('https://repworth.net/account/offboarding/status'));
    const location = response.headers.get('location');

    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/login');
    expect(redirect.searchParams.get('from')).toBe('/account/offboarding/status');
  });

  it('allows authenticated owners through the account status page', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-owner' } } });
    selfRow.value = { role: 'owner', account_id: 'acct-1' };

    const response = await proxy(request('https://repworth.net/account/offboarding/status'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('forwards refreshed Supabase cookies and the pathname header downstream on pass-through owner pages', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-owner' } } });
    selfRow.value = { role: 'owner', account_id: 'acct-1' };
    setSupabaseCookies.value = true;

    const response = await proxy(request('https://repworth.net/account/offboarding/status'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-request-cookie')).toContain('sb-refresh-token=updated');
    expect(response.headers.get(`x-middleware-request-${REQUEST_PATHNAME_HEADER}`)).toBe(
      '/account/offboarding/status',
    );
    expect(response.headers.get('x-middleware-override-headers')).toContain('cookie');
    expect(response.headers.get('x-middleware-override-headers')).toContain(REQUEST_PATHNAME_HEADER);
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

  it('preserves refreshed Supabase cookies on MFA redirects', async () => {
    process.env.MFA_ENFORCEMENT_ENABLED = 'true';
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-admin' } } });
    selfRow.value = { role: 'admin', account_id: null };
    getAuthenticatorAssuranceLevel.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });
    setSupabaseCookies.value = true;

    const response = await proxy(request('https://repworth.net/admin/overview'));

    expect(response.headers.get('location')).toContain('/mfa/challenge');
    expect(response.headers.get('set-cookie')).toContain('sb-refresh-token=updated');
  });

  it('returns mfa_required for enrolled owner AAL1 sessions on protected Zernio APIs', async () => {
    process.env.MFA_ENFORCEMENT_ENABLED = 'true';
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-owner' } } });
    selfRow.value = { role: 'owner', account_id: 'acct-1' };
    getAuthenticatorAssuranceLevel.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    const response = await proxy(request('https://repworth.net/api/zernio/connect/start'));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'mfa_required' });
  });

  it('allows admins through the mixed-role Zernio disconnect API', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-admin' } } });
    selfRow.value = { role: 'admin', account_id: null };

    const response = await proxy(request('https://repworth.net/api/zernio/disconnect'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('requires MFA for admins on the mixed-role Zernio disconnect API', async () => {
    process.env.MFA_ENFORCEMENT_ENABLED = 'true';
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-admin' } } });
    selfRow.value = { role: 'admin', account_id: null };
    getAuthenticatorAssuranceLevel.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    const response = await proxy(request('https://repworth.net/api/zernio/disconnect'));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'mfa_required' });
  });
});

describe('proxy CSP nonce (F-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: null } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
      error: null,
    });
    selfRow.value = { role: 'owner', account_id: 'acct-1' };
    setSupabaseCookies.value = false;
    process.env.MFA_ENFORCEMENT_ENABLED = 'false';
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('emits a per-request nonce CSP response header on a public page', async () => {
    const response = await proxy(request('https://repworth.net/'));
    const csp = response.headers.get('content-security-policy');

    expect(csp).toBeTruthy();
    expect(csp).toMatch(/script-src[^;]*'nonce-/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    // style-src still permits inline (346 inline style attrs can't be nonced).
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
    // Public route does no Supabase work.
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('forwards the nonce to the renderer via x-nonce + CSP request headers', async () => {
    const response = await proxy(request('https://repworth.net/'));

    expect(response.headers.get('x-middleware-override-headers')).toContain('x-nonce');
    expect(response.headers.get('x-middleware-request-x-nonce')).toBeTruthy();
    // The forwarded request CSP must equal the response CSP so the nonce Next
    // reads from the request matches the one the browser enforces from the response.
    const requestCsp = response.headers.get('x-middleware-request-content-security-policy');
    expect(requestCsp).toBe(response.headers.get('content-security-policy'));
  });

  it('applies the nonce CSP on authenticated protected pages too', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-owner' } } });
    selfRow.value = { role: 'owner', account_id: 'acct-1' };

    const response = await proxy(request('https://repworth.net/dashboard'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toMatch(/script-src[^;]*'nonce-/);
  });

  it('applies the nonce CSP on auth-failure responses (redirects, JSON 401)', async () => {
    const redirect = await proxy(request('https://repworth.net/dashboard'));
    expect(redirect.headers.get('location')).toContain('/login');
    expect(redirect.headers.get('content-security-policy')).toMatch(/script-src[^;]*'nonce-/);

    const unauthorized = await proxy(request('https://repworth.net/api/billing/checkout'));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('content-security-policy')).toMatch(/script-src[^;]*'nonce-/);
  });

  it('emits a fresh nonce per request', async () => {
    const a = await proxy(request('https://repworth.net/'));
    const b = await proxy(request('https://repworth.net/'));
    expect(a.headers.get('content-security-policy')).not.toBe(b.headers.get('content-security-policy'));
  });

  it('does not emit CSP outside production (dev/test HMR preserved)', async () => {
    vi.unstubAllEnvs();
    const response = await proxy(request('https://repworth.net/'));
    expect(response.headers.get('content-security-policy')).toBeNull();
  });
});
