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

const { mockRedirect, mockGetUser, mockUserRows } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string) => {
    throw new RedirectSignalRef.value(url);
  }),
  mockGetUser: vi.fn(),
  mockUserRows: { value: [] as unknown[] },
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
  headers: async () => ({ get: () => null }),
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

    await expectRedirect('/admin/overview');
  });

  it('sends any other role to /login', async () => {
    mockUserRows.value = [
      { role: 'sales_partner', account_id: 'acc-1', owner_name: 'Sam', email: 's@example.com' },
    ];

    await expectRedirect('/login');
  });

  it('sends an owner with no account to /admin/login (unchanged)', async () => {
    mockUserRows.value = [
      { role: 'owner', account_id: null, owner_name: 'Ola', email: 'o@example.com' },
    ];

    await expectRedirect('/admin/login');
  });

  it('sends an auth identity with no users row to /admin/login (unchanged)', async () => {
    mockUserRows.value = [];

    await expectRedirect('/admin/login');
  });

  it('sends an unauthenticated visitor to /admin/login (unchanged)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await expectRedirect('/admin/login');
  });
});
