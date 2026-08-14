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

vi.mock('../PlanPickerClient', () => ({ PlanPickerClient: () => null }));
vi.mock('../../_shared/OnboardingFunnelShell', () => ({
  OnboardingFunnelShell: () => null,
}));

const { default: OnboardingPayPage } = await import('../page');

const searchParams = Promise.resolve({});

const pendingOwnerRow = {
  business_id: 'biz-1',
  price_variant: 'founding',
  subscription_status: 'pending_payment',
  place_id_verified: false,
  google_maps_url: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  mockGetUser.mockResolvedValue({
    data: { user: { id: 'auth-123', email_confirmed_at: '2026-08-01T00:00:00Z' } },
    error: null,
  });
});

describe('OnboardingPayPage guard', () => {
  it('onboarding pay page 404s for a non-owner user', async () => {
    // The page query gained `AND u.role = 'owner'`; before that an admin or
    // sales_partner session read whichever business their account pointed at
    // and was offered a plan picker for it (Codex round-1 finding 8).
    //
    // A non-owner session gets exactly the missing-row treatment — the page is
    // never served. Mechanically that is the /signup redirect, and /signup
    // itself 404s while SELF_SERVE_SIGNUP_ENABLED is off, which is the beta
    // posture this ticket targets.
    mockSql.mockResolvedValueOnce([]); // owner-filtered query finds nothing

    await expect(OnboardingPayPage({ searchParams })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mockRedirect).toHaveBeenCalledWith('/signup');

    const callArgs = mockSql.mock.calls[0] as unknown[];
    const query = (callArgs[0] as TemplateStringsArray).join('?');
    expect(query).toContain("u.role = 'owner'");
    expect(callArgs.slice(1)).toContain('auth-123');
  });

  it('onboarding pay page renders for a pending_payment owner when SELF_SERVE_SIGNUP_ENABLED is off', async () => {
    // The re-scoped flag gates anonymous account-minting only; an
    // admin-invited owner picks a plan here while it is off.
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    mockSql.mockResolvedValueOnce([pendingOwnerRow]);

    const element = await OnboardingPayPage({ searchParams });

    expect(element).toBeTruthy();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('redirects an entitled owner away from the plan picker', async () => {
    mockSql.mockResolvedValueOnce([
      { ...pendingOwnerRow, subscription_status: 'active' },
    ]);

    await expect(OnboardingPayPage({ searchParams })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mockRedirect).toHaveBeenCalledWith('/onboarding/business');
  });

  it('redirects a past_due owner to the dashboard rather than the picker', async () => {
    // A click here would create a duplicate Stripe subscription; billing
    // recovery lives on the dashboard side.
    mockSql.mockResolvedValueOnce([
      { ...pendingOwnerRow, subscription_status: 'past_due' },
    ]);

    await expect(OnboardingPayPage({ searchParams })).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });
});
