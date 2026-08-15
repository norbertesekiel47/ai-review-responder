import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetUser, mockRedirect, mockNotFound, mockSql } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockRedirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockSql: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({ getAll: vi.fn(() => []) })),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('../PaymentSuccessClient', () => ({ PaymentSuccessClient: () => null }));

const { default: PaymentSuccessPage } = await import('../page');

const searchParams = Promise.resolve({ session_id: 'cs_test_1' });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-123' } }, error: null });
});

describe('PaymentSuccessPage guard', () => {
  it('redirects an anonymous visitor to /login', async () => {
    // The page carried NO auth at all before the flag was removed — the flag
    // was doing all the hiding.
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    await expect(PaymentSuccessPage({ searchParams })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('redirects an admin session to the admin overview', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'admin' }]);

    await expect(PaymentSuccessPage({ searchParams })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mockRedirect).toHaveBeenCalledWith('/admin/overview');
  });

  it('renders for an owner in pending_payment AND post-payment states', async () => {
    // Deliberately no subscription-state narrowing: this page is the crossing
    // point of the Stripe projection, so gating it on one status would bounce
    // the owner in exactly the window its poller exists to cover.
    for (let i = 0; i < 3; i += 1) {
      mockSql.mockResolvedValueOnce([{ role: 'owner' }]);
      const element = await PaymentSuccessPage({ searchParams });
      expect(element).toBeTruthy();
    }
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('renders for an owner when SELF_SERVE_SIGNUP_ENABLED is off', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    mockSql.mockResolvedValueOnce([{ role: 'owner' }]);

    const element = await PaymentSuccessPage({ searchParams });

    expect(element).toBeTruthy();
    expect(mockNotFound).not.toHaveBeenCalled();
  });
});
