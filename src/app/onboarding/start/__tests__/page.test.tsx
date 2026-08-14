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
const { PLACEHOLDER_BUSINESS_NAME } = await import('@/lib/onboarding/create-business');

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

  it('redirects a past_due owner to the dashboard', async () => {
    // The allowed state for this step is exactly pending_payment. past_due used
    // to fall through every negative check and render a form whose POST answers
    // 409 — stating the rule positively closes that.
    mockSql.mockResolvedValueOnce([
      {
        role: 'owner',
        subscription_status: 'past_due',
        place_id_verified: false,
        google_maps_url: null,
        name: PLACEHOLDER_BUSINESS_NAME,
      },
    ]);

    await expect(OnboardingStartPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  it('onboarding start prefills the business name when it is not the placeholder', async () => {
    // An admin-invited owner's Business row already carries the real name the
    // admin typed; a self-serve owner's carries '(pending setup)'. Only the
    // former is a real answer, so only the former seeds the input — and it is a
    // server-rendered prop, never a client fetch.
    mockSql.mockResolvedValueOnce([
      {
        role: 'owner',
        subscription_status: 'pending_payment',
        place_id_verified: false,
        google_maps_url: null,
        name: 'Acme Dental',
      },
    ]);

    const element = await OnboardingStartPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(element.props.initialBusinessName).toBe('Acme Dental');
  });

  it('does not prefill the business name when it is still the placeholder', async () => {
    mockSql.mockResolvedValueOnce([
      {
        role: 'owner',
        subscription_status: 'pending_payment',
        place_id_verified: false,
        google_maps_url: null,
        name: PLACEHOLDER_BUSINESS_NAME,
      },
    ]);

    const element = await OnboardingStartPage();

    expect(element.props.initialBusinessName).toBe('');
  });

  it('renders for a pending_payment owner when SELF_SERVE_SIGNUP_ENABLED is off', async () => {
    // The demo lane's double gate collapsed to a single ONBOARDING_DEMO_ENABLED
    // gate; the re-scoped signup flag no longer hides the funnel.
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    mockSql.mockResolvedValueOnce([
      {
        role: 'owner',
        subscription_status: 'pending_payment',
        place_id_verified: false,
        google_maps_url: null,
        name: PLACEHOLDER_BUSINESS_NAME,
      },
    ]);

    const element = await OnboardingStartPage();

    expect(element).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
