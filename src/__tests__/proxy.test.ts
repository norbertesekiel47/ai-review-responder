import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { addVaryOrigin, proxy } from '../proxy';
import { AdminOriginConfigError, readAdminAppOrigins } from '@/lib/config/admin-origins';
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

describe('trusted Admin home MFA relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ADMIN_APP_URL', 'https://admin.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://repworth.net');
    vi.stubEnv('MFA_ENFORCEMENT_ENABLED', 'true');
    getUser.mockResolvedValue({ data: { user: { id: 'admin-auth' } } });
    selfRow.value = { role: 'admin', account_id: null };
    setSupabaseCookies.value = false;
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('sends an anonymous visitor to Admin login before reading the destination', async () => {
    vi.stubEnv('ADMIN_APP_URL', '');
    getUser.mockResolvedValue({ data: { user: null } });
    const response = await proxy(request('https://repworth.net/admin'));
    expect(response.headers.get('location')).toBe('https://repworth.net/admin/login?from=%2Fadmin');
    expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it.each(['owner', 'sales_partner'])('refuses the %s role before the relay', async (role) => {
    selfRow.value = { role, account_id: 'account-1' };
    const response = await proxy(request('https://repworth.net/admin'));
    expect(response.headers.get('location')).toBe('https://repworth.net/admin/login?from=%2Fadmin');
    expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it.each([
    { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null },
    { data: null, error: { message: 'unavailable' } },
  ])('keeps an insufficient or failed assurance check on the local MFA journey', async (result) => {
    getAuthenticatorAssuranceLevel.mockResolvedValue(result);
    const response = await proxy(request('https://repworth.net/admin'));
    expect(response.headers.get('location')).toBe('https://repworth.net/mfa/challenge?next=%2Fadmin');
  });

  it('relays an AAL2 admin and retains refreshed cookies on the source host', async () => {
    setSupabaseCookies.value = true;
    const response = await proxy(request('https://repworth.net/admin?next=https://evil.example'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://admin.example.com/');
    expect(response.headers.get('set-cookie')).toContain('sb-refresh-token=updated');
    expect(response.headers.get('set-cookie')).not.toMatch(/domain=/i);
  });

  it('returns an expired Admin challenge to Admin login', async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const response = await proxy(request('https://repworth.net/mfa/challenge?next=%2Fadmin'));
    expect(response.headers.get('location')).toBe('https://repworth.net/admin/login?from=%2Fmfa%2Fchallenge');
  });

  it('preserves surviving Admin pages and the actual onboarding redirect', async () => {
    const survivor = await proxy(request('https://repworth.net/admin/impersonate'));
    expect(survivor.headers.get('location')).toBeNull();
    expect(survivor.headers.get('x-middleware-next')).toBe('1');
    const onboarding = await proxy(request('https://repworth.net/onboarding/start'));
    expect(onboarding.headers.get('location')).toBe('https://admin.example.com/');
  });
});

describe('Admin API bearer transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ADMIN_APP_ORIGINS', 'https://admin.example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://repworth.net');
    vi.stubEnv('MFA_ENFORCEMENT_ENABLED', 'true');
    getUser.mockResolvedValue({ data: { user: null } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null,
    });
    selfRow.value = { role: 'owner', account_id: 'account-1' };
    setSupabaseCookies.value = false;
  });

  afterEach(() => vi.unstubAllEnvs());

  it('passes a well-formed bearer without reading the cookie session', async () => {
    const req = new NextRequest('https://repworth.net/api/admin/overview', {
      headers: { authorization: 'Bearer test-token', origin: 'https://admin.example.com', cookie: 'sb-session=owner' },
    });
    const response = await proxy(req);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('x-middleware-request-authorization')).toBe('Bearer test-token');
    expect(response.headers.get(`x-middleware-request-${REQUEST_PATHNAME_HEADER}`)).toBe('/api/admin/overview');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.com');
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('location')).toBeNull();
    expect(createServerClient).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();

    const serverResponse = await proxy(new NextRequest('https://repworth.net/api/admin/overview', {
      headers: { authorization: 'bearer server-token' },
    }));
    expect(serverResponse.headers.get('x-middleware-next')).toBe('1');
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('defers malformed Authorization to the canonical gate without consulting cookies', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'admin-auth' } } });
    selfRow.value = { role: 'admin', account_id: null };
    for (const authorization of ['', 'Basic abc', 'Bearer', 'Bearer a b']) {
      const response = await proxy(new NextRequest('https://repworth.net/api/admin/overview', {
        headers: { authorization, cookie: 'sb-session=valid-admin', origin: 'https://admin.example.com' },
      }));
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('x-middleware-request-authorization')).toBe(authorization);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.com');
      expect(createServerClient).not.toHaveBeenCalled();
    }
  });

  it.each(['/api/admin/overview', '/api/admin/impersonation-extra', '/api/admin/impersonations/start'])(
    'defers cookie-only %s to the bearer gate without refreshing cookies',
    async (path) => {
      setSupabaseCookies.value = true;
      const response = await proxy(new NextRequest(`https://repworth.net${path}`, {
        headers: { cookie: 'sb-session=valid-admin' },
      }));
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(createServerClient).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
    },
  );

  it('keeps impersonation on the cookie path', async () => {
    for (const path of ['/api/admin/impersonation', '/api/admin/impersonation/start', '/api/admin/impersonation/end']) {
      vi.clearAllMocks();
      const response = await proxy(new NextRequest(`https://repworth.net${path}`, {
        headers: { authorization: 'Bearer test-token' },
      }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
      expect(getUser).toHaveBeenCalledOnce();
    }
  });

  it('refuses a disallowed Origin before bearer pass-through', async () => {
    const response = await proxy(new NextRequest('https://repworth.net/api/admin/overview', {
      headers: { authorization: 'Bearer test-token', origin: 'https://evil.example.com' },
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('retains cookie refusals and does not admit owner routes or admin pages by bearer', async () => {
    expect((await proxy(request('https://repworth.net/api/admin/impersonation/start'))).status).toBe(401);
    getUser.mockResolvedValueOnce({ data: { user: { id: 'owner-auth' } } });
    expect((await proxy(request('https://repworth.net/api/admin/impersonation/start'))).status).toBe(403);
    const owner = await proxy(new NextRequest('https://repworth.net/api/billing/checkout', {
      headers: { authorization: 'Bearer test-token' },
    }));
    expect(owner.status).toBe(401);
    const page = await proxy(new NextRequest('https://repworth.net/admin/impersonate', {
      headers: { authorization: 'Bearer test-token' },
    }));
    expect(new URL(page.headers.get('location')!).pathname).toBe('/admin/login');
  });
});

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
    const response = await proxy(request('https://repworth.net/admin/impersonate'));
    const location = response.headers.get('location');

    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.origin).toBe('https://repworth.net');
    expect(redirect.pathname).toBe('/admin/login');
    expect(redirect.searchParams.get('from')).toBe('/admin/impersonate');
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

    const response = await proxy(request('https://repworth.net/admin/impersonate'));
    const location = response.headers.get('location');

    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/admin/login');
    expect(redirect.searchParams.get('from')).toBe('/admin/impersonate');
  });

  it('returns 403 for sales_partner impersonation API requests', async () => {
    getUser.mockResolvedValueOnce({ data: { user: { id: 'auth-sales' } } });

    const response = await proxy(request('https://repworth.net/api/admin/impersonation/start'));

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

    const response = await proxy(request('https://repworth.net/admin/impersonate'));
    const location = response.headers.get('location');

    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    expect(redirect.pathname).toBe('/mfa/challenge');
    expect(redirect.searchParams.get('next')).toBe('/admin/impersonate');
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

    const response = await proxy(request('https://repworth.net/admin/impersonate'));

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

// ─────────────────────────────────────────────────────────────────────────────
// Admin API CORS (#1186 · ADR 0026)
//
// The CORS block is the FIRST thing inside proxy(), ahead of isProtectedRoute.
// `createServerClient` is the probe for "did any Supabase work happen": ADR 0026
// D4 requires a refused origin and an allowlisted preflight to return BEFORE it.
// ─────────────────────────────────────────────────────────────────────────────

const APP_ORIGIN = 'https://repworth.net';
const ADMIN_ORIGIN = 'https://admin.staging.repworth.net';
const EVIL_ORIGIN = 'https://evil.example';
const ADMIN_API_URL = 'https://repworth.net/api/admin/overview';
const IMPERSONATION_API_URL = 'https://repworth.net/api/admin/impersonation/start';

const ALL_ACCESS_CONTROL_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
  'access-control-allow-credentials',
  'access-control-expose-headers',
] as const;

function accessControlHeaderNames(response: Response): string[] {
  return Array.from(response.headers.keys())
    .map((key) => key.toLowerCase())
    .filter((key) => key.startsWith('access-control-'))
    .sort();
}

function corsRequest(
  url: string,
  init: { method?: string; origin?: string; headers?: Record<string, string> } = {},
): NextRequest {
  const parsed = new URL(url);
  const headers: Record<string, string> = { host: parsed.host, ...(init.headers ?? {}) };
  if (init.origin !== undefined) headers.origin = init.origin;
  return new NextRequest(url, { method: init.method ?? 'GET', headers });
}

describe('admin API CORS', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: null } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
      error: null,
    });
    selfRow.value = null;
    setSupabaseCookies.value = false;
    process.env.MFA_ENFORCEMENT_ENABLED = 'false';
    process.env.NEXT_PUBLIC_APP_URL = APP_ORIGIN;
    process.env.ADMIN_APP_ORIGINS = ADMIN_ORIGIN;
    delete process.env.VERCEL_TARGET_ENV;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('echoes Access-Control-Allow-Origin for an allowlisted admin origin', async () => {
    const response = await proxy(corsRequest(ADMIN_API_URL, { origin: ADMIN_ORIGIN }));

    // The route's bearer gate owns authentication; proxy contributes CORS.
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('sends no Access-Control-Allow-Origin for a disallowed origin', async () => {
    const response = await proxy(corsRequest(ADMIN_API_URL, { origin: EVIL_ORIGIN }));

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers an OPTIONS preflight from an allowlisted origin with 204 and the full header set, never reaching branch 4', async () => {
    const response = await proxy(
      corsRequest(ADMIN_API_URL, {
        method: 'OPTIONS',
        origin: ADMIN_ORIGIN,
        headers: {
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
    expect(response.headers.get('access-control-allow-methods')).toBe(
      'GET, POST, PUT, PATCH, OPTIONS',
    );
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type',
    );
    expect(response.headers.get('access-control-max-age')).toBe('600');
    // Branch 4 would have 401'd a cookie-less preflight. It must never run.
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('refuses an OPTIONS preflight from a disallowed origin with 403 origin', async () => {
    const response = await proxy(
      corsRequest(ADMIN_API_URL, { method: 'OPTIONS', origin: EVIL_ORIGIN }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin' });
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('sets Vary: Origin on both the allowed and the refused preflight', async () => {
    const allowed = await proxy(
      corsRequest(ADMIN_API_URL, { method: 'OPTIONS', origin: ADMIN_ORIGIN }),
    );
    const refused = await proxy(
      corsRequest(ADMIN_API_URL, { method: 'OPTIONS', origin: EVIL_ORIGIN }),
    );

    expect(allowed.headers.get('vary')).toBe('Origin');
    expect(refused.headers.get('vary')).toBe('Origin');
  });

  it('refuses a non-OPTIONS admin API request from a disallowed origin with 403 before any Supabase call', async () => {
    const response = await proxy(
      corsRequest(ADMIN_API_URL, { method: 'POST', origin: EVIL_ORIGIN }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin' });
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("lets the cookie-backed impersonation POST past the self-origin CORS allowance", async () => {
    // The permanent impersonation carve-out retains the source app's cookies.
    const response = await proxy(
      corsRequest(IMPERSONATION_API_URL, { method: 'POST', origin: APP_ORIGIN }),
    );

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(401); // branch 4's pre-existing refusal
    expect(createServerClient).toHaveBeenCalledTimes(1);
  });

  it('leaves an admin API request with no Origin header to the canonical bearer gate', async () => {
    const response = await proxy(corsRequest(ADMIN_API_URL));

    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('admits a loopback origin on an arbitrary port outside the production lane', async () => {
    process.env.ADMIN_APP_ORIGINS = '';
    process.env.VERCEL_TARGET_ENV = 'staging';

    const response = await proxy(
      corsRequest(ADMIN_API_URL, { method: 'OPTIONS', origin: 'http://localhost:54321' }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:54321');
  });

  it('refuses a loopback origin inside the production lane', async () => {
    process.env.VERCEL_TARGET_ENV = 'production';

    const response = await proxy(
      corsRequest(ADMIN_API_URL, { method: 'OPTIONS', origin: 'http://localhost:54321' }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'origin' });
  });

  it('sets Vary: Origin on every admin API response, including a branch 4 refusal', async () => {
    // Every exit an /api/admin/** request can take today.
    const noOrigin = await proxy(corsRequest(ADMIN_API_URL));
    const allowed = await proxy(corsRequest(ADMIN_API_URL, { origin: ADMIN_ORIGIN }));
    const refused = await proxy(corsRequest(ADMIN_API_URL, { origin: EVIL_ORIGIN }));

    expect(noOrigin.headers.get('vary')).toBe('Origin');
    expect(allowed.headers.get('vary')).toBe('Origin');
    expect(refused.headers.get('vary')).toBe('Origin');
  });

  it('writes no Access-Control header on a non-admin route', async () => {
    const publicPage = await proxy(corsRequest('https://repworth.net/', { origin: ADMIN_ORIGIN }));
    const ownerApi = await proxy(
      corsRequest('https://repworth.net/api/billing/checkout', {
        method: 'POST',
        origin: ADMIN_ORIGIN,
      }),
    );

    expect(accessControlHeaderNames(publicPage)).toEqual([]);
    expect(accessControlHeaderNames(ownerApi)).toEqual([]);
    expect(publicPage.headers.get('vary')).toBeNull();
  });

  it('validates the entire allowlist before the self-origin, loopback and missing-Origin shortcuts', async () => {
    // ADR 0026 D2: an entry containing '*' is a configuration error caught AT
    // READ. If the read happened only on the path that consults the list, a
    // wildcard would sit undetected for every self-origin and no-Origin request.
    //
    // The parser THROWS (that is D2, and a red-team mutation deleting the throw
    // must still fail); the proxy CATCHES and fails closed with the ordinary
    // refusal envelope, so a misconfiguration is an admin-wide 403 rather than
    // an unhandled proxy exception — a platform 500 with no CORS headers on
    // every request for the life of the deployment. Adversarial review A2.
    process.env.ADMIN_APP_ORIGINS = '*';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      for (const label of ['self-origin', 'loopback', 'no Origin'] as const) {
        vi.clearAllMocks();
        const request =
          label === 'self-origin'
            ? corsRequest(ADMIN_API_URL, { origin: APP_ORIGIN })
            : label === 'loopback'
              ? corsRequest(ADMIN_API_URL, { origin: 'http://localhost:3000' })
              : corsRequest(ADMIN_API_URL);

        const response = await proxy(request);

        expect(response.status, label).toBe(403);
        expect(await response.json()).toEqual({ error: 'origin' });
        expect(response.headers.get('vary')).toBe('Origin');
        expect(accessControlHeaderNames(response)).toEqual([]);
        // Failing closed means no Supabase work either.
        expect(createServerClient).not.toHaveBeenCalled();
      }

      // Not a silent catch: the operator gets a named reason in the logs.
      expect(consoleError).toHaveBeenCalled();
      const [message, context] = consoleError.mock.calls[0] ?? [];
      expect(String(message)).toContain('ADMIN_APP_ORIGINS is invalid');
      expect(JSON.stringify(context)).toContain('wildcard');
    } finally {
      consoleError.mockRestore();
    }

    // The parser itself still throws — the proxy's catch must not be mistaken
    // for the parser having gone permissive (ADR 0026 D2 / D7).
    expect(() => readAdminAppOrigins()).toThrow(AdminOriginConfigError);
  });

  it('does not read ADMIN_APP_ORIGINS on a non-admin request', async () => {
    // A bad value must never take down /admin/login or a public page.
    process.env.ADMIN_APP_ORIGINS = 'https://ok.example, *';

    await expect(proxy(corsRequest('https://repworth.net/admin/login'))).resolves.toBeDefined();
    await expect(proxy(corsRequest('https://repworth.net/'))).resolves.toBeDefined();
  });

  it('refuses empty, literal null, malformed and multi-valued Origin headers without throwing or constructing Supabase', async () => {
    const cases = ['', 'null', 'not a url', `${ADMIN_ORIGIN} ${EVIL_ORIGIN}`, 'file://'];

    for (const origin of cases) {
      vi.clearAllMocks();
      const response = await proxy(corsRequest(ADMIN_API_URL, { method: 'POST', origin }));

      expect(response.status, `origin=${JSON.stringify(origin)}`).toBe(403);
      expect(await response.json()).toEqual({ error: 'origin' });
      expect(response.headers.get('vary')).toBe('Origin');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(createServerClient).not.toHaveBeenCalled();
    }
  });

  it('refuses a disallowed origin on every method, and with cookies, Authorization or same-site fetch metadata present', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS', 'DELETE', 'HEAD']) {
      vi.clearAllMocks();
      const response = await proxy(
        corsRequest(ADMIN_API_URL, {
          method,
          origin: EVIL_ORIGIN,
          headers: {
            cookie: 'sb-access-token=stolen',
            authorization: 'Bearer stolen',
            'sec-fetch-site': 'same-site',
          },
        }),
      );

      expect(response.status, `method=${method}`).toBe(403);
      expect(createServerClient).not.toHaveBeenCalled();
    }
  });

  it('returns the fixed preflight contract regardless of the requested method and headers', async () => {
    const response = await proxy(
      corsRequest(ADMIN_API_URL, {
        method: 'OPTIONS',
        origin: ADMIN_ORIGIN,
        headers: {
          'access-control-request-method': 'DELETE',
          'access-control-request-headers': 'x-admin-override, authorization',
        },
      }),
    );

    // Never echoed: DELETE is absent because no admin route exports one, and the
    // allowed header list is a constant, not the caller's wish list. The exact
    // equalities below already subsume "does not contain DELETE" and "does not
    // contain x-admin-override" — an absence-of-substring assertion beside an
    // exact-match one proves nothing extra and reads as if it did.
    expect(response.headers.get('access-control-allow-methods')).toBe(
      'GET, POST, PUT, PATCH, OPTIONS',
    );
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type',
    );
  });

  it('never sends Allow-Credentials or Expose-Headers, and sends no Access-Control header on a refusal', async () => {
    const preflight = await proxy(
      corsRequest(ADMIN_API_URL, { method: 'OPTIONS', origin: ADMIN_ORIGIN }),
    );
    const actual = await proxy(corsRequest(ADMIN_API_URL, { origin: ADMIN_ORIGIN }));
    const refused = await proxy(corsRequest(ADMIN_API_URL, { origin: EVIL_ORIGIN }));

    // Sweep the whole vocabulary on the refusal, rather than asserting the
    // length of the list that names it — every Access-Control header this repo
    // knows about must be absent, not just the two named in the title.
    for (const header of ALL_ACCESS_CONTROL_HEADERS) {
      expect(refused.headers.get(header), `refusal must not send ${header}`).toBeNull();
    }
    for (const response of [preflight, actual]) {
      expect(response.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response.headers.get('access-control-expose-headers')).toBeNull();
    }
    // Preflight-only headers must not ride on an actual response.
    expect(accessControlHeaderNames(actual)).toEqual(['access-control-allow-origin']);
    // A refusal carries nothing at all.
    expect(accessControlHeaderNames(refused)).toEqual([]);
  });

  it('lets an OPTIONS request with no Origin reach the route handler and adds only Vary', async () => {
    // Not a preflight: no Origin, so no CORS check and no short-circuit.
    const response = await proxy(corsRequest(ADMIN_API_URL, { method: 'OPTIONS' }));

    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(response.headers.get('vary')).toBe('Origin');
    expect(accessControlHeaderNames(response)).toEqual([]);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('preserves every branch 4 outcome and refreshed Supabase cookies while stamping CORS headers', async () => {
    // 401 — no session
    const unauthorized = await proxy(corsRequest(IMPERSONATION_API_URL, { origin: ADMIN_ORIGIN }));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'Unauthorized' });

    // 403 Forbidden — authenticated, not an admin
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: 'auth-owner' } } });
    selfRow.value = { role: 'owner', account_id: 'acct-1' };
    const forbidden = await proxy(corsRequest(IMPERSONATION_API_URL, { origin: ADMIN_ORIGIN }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'Forbidden' });
    expect(forbidden.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);

    // 403 mfa_required — admin at aal1 under enforcement, with refreshed cookies
    vi.clearAllMocks();
    process.env.MFA_ENFORCEMENT_ENABLED = 'true';
    getUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } } });
    selfRow.value = { role: 'admin', account_id: null };
    getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });
    setSupabaseCookies.value = true;
    const mfa = await proxy(corsRequest(IMPERSONATION_API_URL, { origin: ADMIN_ORIGIN }));
    expect(mfa.status).toBe(403);
    expect(await mfa.json()).toEqual({ error: 'mfa_required' });
    expect(mfa.headers.get('set-cookie')).toContain('sb-refresh-token=updated');
    expect(mfa.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
    expect(mfa.headers.get('vary')).toBe('Origin');

    // pass-through — a verified aal2 admin, downstream headers intact
    vi.clearAllMocks();
    process.env.MFA_ENFORCEMENT_ENABLED = 'false';
    getUser.mockResolvedValue({ data: { user: { id: 'auth-admin' } } });
    selfRow.value = { role: 'admin', account_id: null };
    setSupabaseCookies.value = true;
    const passthrough = await proxy(corsRequest(IMPERSONATION_API_URL, { origin: ADMIN_ORIGIN }));
    expect(passthrough.status).toBe(200);
    expect(passthrough.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
    expect(passthrough.headers.get('vary')).toBe('Origin');
    expect(passthrough.headers.get('x-middleware-request-cookie')).toContain(
      'sb-refresh-token=updated',
    );
    expect(passthrough.headers.get(`x-middleware-request-${REQUEST_PATHNAME_HEADER}`)).toBe(
      '/api/admin/impersonation/start',
    );
  });

  it('matches bare and normalized admin API paths and excludes admin lookalike paths', async () => {
    for (const url of [
      'https://repworth.net/api/admin',
      'https://repworth.net/api/admin/',
      'https://repworth.net/API/Admin/Overview',
      'https://repworth.net/api/admin/businesses/abc',
    ]) {
      vi.clearAllMocks();
      const response = await proxy(corsRequest(url, { origin: EVIL_ORIGIN }));
      expect(response.status, `url=${url}`).toBe(403);
      expect(await response.json()).toEqual({ error: 'origin' });
    }

    // /api/adminfoo is not the Admin API. No CORS, no refusal from this block.
    vi.clearAllMocks();
    const lookalike = await proxy(
      corsRequest('https://repworth.net/api/adminfoo', { origin: EVIL_ORIGIN }),
    );
    expect(accessControlHeaderNames(lookalike)).toEqual([]);
    expect(lookalike.headers.get('vary')).toBeNull();
  });

  it('adds Origin to an existing Vary header without dropping or duplicating a token', async () => {
    const cases: Array<[string | null, string]> = [
      [null, 'Origin'],
      ['Accept-Encoding', 'Accept-Encoding, Origin'],
      ['Origin', 'Origin'],
      ['origin', 'origin'],
      ['Accept-Encoding, Origin', 'Accept-Encoding, Origin'],
      ['*', '*'],
    ];

    for (const [existing, expected] of cases) {
      const headers = new Headers();
      if (existing !== null) headers.set('Vary', existing);
      addVaryOrigin(headers);
      expect(headers.get('vary'), `existing=${JSON.stringify(existing)}`).toBe(expected);
    }
  });

  it('echoes the normalized allowed origin, never the raw Origin header', async () => {
    // A browser always sends a canonical origin, so the two agree in practice.
    // What this pins is that the header we WRITE is the origin we DECIDED about.
    //
    // Two fixtures, and the second is the one that matters: WHATWG URL parsing
    // strips tab and newline characters, so a raw header can normalize ONTO an
    // allowlisted origin while differing from it byte for byte. A raw echo would
    // put those bytes in the response; the canonical echo cannot.
    for (const raw of [
      'https://ADMIN.Staging.RepWorth.net',
      'https://admin.stag\ting.repworth.net',
    ]) {
      const response = await proxy(
        corsRequest(ADMIN_API_URL, { method: 'OPTIONS', origin: raw }),
      );

      expect(response.status, `raw=${JSON.stringify(raw)}`).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
    }
  });
});
