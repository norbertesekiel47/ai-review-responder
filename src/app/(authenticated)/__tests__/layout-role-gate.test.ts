// src/app/(authenticated)/__tests__/layout-role-gate.test.ts
//
// The owner shell's role gate. Before the H5 bundle `AuthenticatedLayout` read
// `users.account_id` and nothing else, so `role === 'owner'` for owner pages
// came solely from `proxy.ts`'s owner-page block — while the 10 pages rendered
// INSIDE this shell that call `requireOwnerAccess` got a role check too. Two
// postures under one layout.
//
// These pin the shell's half. They are the layout's ONLY tests: rendering it
// needs fonts, Redis-backed counts and four client providers, and none of that
// is what the gate is about — every case here redirects before the first
// element is built.

import { describe, it, expect, vi, beforeEach } from 'vitest';

class RedirectSignal extends Error {
  constructor(public readonly url: string) {
    super(`redirect:${url}`);
  }
}

const { mockRedirect, mockGetUser, mockUserRows, mockPathname } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string) => {
    throw new RedirectSignalRef.value(url);
  }),
  mockGetUser: vi.fn(),
  mockUserRows: { value: [] as unknown[] },
  mockPathname: { value: null as string | null },
}));

// `vi.hoisted` runs before the class declaration above is evaluated, so the
// factory closes over a box rather than the binding itself.
const RedirectSignalRef = { value: RedirectSignal };

vi.mock('next/navigation', () => ({ redirect: mockRedirect }));

vi.mock('next/font/local', () => ({
  default: () => ({ variable: '--test-font', className: 'test-font' }),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
  headers: async () => ({ get: () => mockPathname.value }),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: mockGetUser } }),
}));

vi.mock('@/lib/db/server', () => ({
  sql: () => Promise.resolve(mockUserRows.value),
}));

// Everything past the gate — never reached by these cases, but the module
// imports them at load time.
vi.mock('@/lib/auth/get-request-scope', () => ({
  getRequestScope: vi.fn(async () => ({
    accountId: 'acc-1',
    currentLocationId: 'loc-1',
    activeLocations: [],
  })),
}));
vi.mock('@/lib/dashboard/pending-count', () => ({
  getPendingApprovalCount: vi.fn(async () => 0),
}));
vi.mock('@/lib/account-offboarding/flags', () => ({
  accountOffboardingEnabled: () => false,
}));

import AuthenticatedLayout from '../layout';

async function renderLayout(): Promise<void> {
  // The layout is an async server component; awaiting it runs the gate.
  await AuthenticatedLayout({ children: null });
}

async function expectRedirect(to: string): Promise<void> {
  await expect(renderLayout()).rejects.toThrow(`redirect:${to}`);
  expect(mockRedirect).toHaveBeenCalledWith(to);
}

describe('AuthenticatedLayout role gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname.value = null;
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1', email: 'o@example.com' } } });
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-test';
  });

  it('sends an admin-role user to the admin console, not the owner shell', async () => {
    // The behaviour change: an admin session that reached an owner page used to
    // render the owner shell around it.
    mockUserRows.value = [
      { role: 'admin', account_id: 'acc-1', owner_name: 'Ada', email: 'a@example.com' },
    ];

    await expectRedirect('https://admin.example.com');
  });

  it('sends any other role to /login', async () => {
    mockUserRows.value = [
      { role: 'sales_partner', account_id: 'acc-1', owner_name: 'Sam', email: 's@example.com' },
    ];

    await expectRedirect('/login');
  });

  // UX audit D4: neither of these is an admin — the owner login, with `from`
  // and a mapped reason (`mapInitialQueryError('account_not_found')`).
  it('sends an owner with no account to the owner login with an account_not_found reason', async () => {
    mockUserRows.value = [
      { role: 'owner', account_id: null, owner_name: 'Ola', email: 'o@example.com' },
    ];
    mockPathname.value = '/settings/billing';

    await expectRedirect('/login?from=%2Fsettings%2Fbilling&error=account_not_found');
  });

  it('sends an auth identity with no users row to the owner login with an account_not_found reason', async () => {
    mockUserRows.value = [];

    await expectRedirect('/login?error=account_not_found');
  });

  // UX audit D4: an owner whose session expired goes to the OWNER login (the
  // admin login rejects owner credentials), carrying the page they were on.
  it('sends an unauthenticated visitor to the owner login with the current path as `from`', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockPathname.value = '/dashboard/reviews';

    await expectRedirect('/login?from=%2Fdashboard%2Freviews');
  });

  it('sends an unauthenticated visitor to a bare /login when the path is unknown', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await expectRedirect('/login');
  });
});
