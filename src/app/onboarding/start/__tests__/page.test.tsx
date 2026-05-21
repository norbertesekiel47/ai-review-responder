import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetUser, mockRedirect, mockSql } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockRedirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  mockSql: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: mockRedirect,
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    getAll: vi.fn(() => []),
  })),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../StartLocationClient', () => ({
  StartLocationClient: () => null,
}));

const { default: OnboardingStartPage } = await import('../page');

describe('OnboardingStartPage guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'auth-123' } },
      error: null,
    });
  });

  it('redirects admin away from owner onboarding to /admin/overview', async () => {
    mockSql.mockResolvedValueOnce([
      {
        role: 'admin',
        subscription_status: 'pending_payment',
        place_id_verified: false,
        google_maps_url: null,
      },
    ]);

    await expect(OnboardingStartPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/admin/overview');
  });

  it('redirects sales_partner away from owner onboarding to /login', async () => {
    mockSql.mockResolvedValueOnce([
      {
        role: 'sales_partner',
        subscription_status: 'pending_payment',
        place_id_verified: false,
        google_maps_url: null,
      },
    ]);

    await expect(OnboardingStartPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/login');
  });
});
