import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetUser, mockRedirect, mockSql } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockRedirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  mockSql: vi.fn(),
}));

vi.mock('next/navigation', () => ({
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

vi.mock('../BusinessWizardClient', () => ({
  BusinessWizardClient: () => null,
}));

const { default: OnboardingBusinessPage } = await import('../page');

const ownerRow = {
  role: 'owner',
  subscription_status: 'active',
  place_id_verified: true,
  google_maps_url: null,
  category: 'Cafe',
  website: 'https://example.com',
  name: 'RepWorth Cafe',
  subscription_tier: 'copilot',
};

describe('OnboardingBusinessPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'auth-123' } },
      error: null,
    });
  });

  it('redirects a signed-out visitor to /login before touching the database', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(OnboardingBusinessPage()).rejects.toThrow('NEXT_REDIRECT:/login');

    expect(mockSql).not.toHaveBeenCalled();
  });

  it('redirects an admin to /admin/overview', async () => {
    mockSql.mockResolvedValueOnce([{ ...ownerRow, role: 'admin' }]);

    await expect(OnboardingBusinessPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('https://admin.example.com');
  });

  it('redirects an owner who has not paid to /onboarding/pay', async () => {
    mockSql.mockResolvedValueOnce([{ ...ownerRow, subscription_status: 'pending_payment' }]);

    await expect(OnboardingBusinessPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/onboarding/pay');
  });

  it('renders the demo wizard, seeded from the row, when the demo is on and the location is captured', async () => {
    mockSql.mockResolvedValueOnce([ownerRow]);

    const element = await OnboardingBusinessPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(element.props).toEqual({
      initialValues: { category: 'Cafe', website: 'https://example.com', businessName: 'RepWorth Cafe' },
      demoFlowEnabled: true,
      subscriptionTier: 'copilot',
    });
  });

  it('renders the non-demo wizard for a subscribed trial with no location, instead of bouncing to /start', async () => {
    mockSql.mockResolvedValueOnce([
      { ...ownerRow, subscription_status: 'trialing', place_id_verified: false, google_maps_url: null },
    ]);

    const element = await OnboardingBusinessPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(element.props.demoFlowEnabled).toBe(false);
  });

  it('sends an already-onboarded owner to /dashboard when the demo lane is off', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'false';
    mockSql.mockResolvedValueOnce([ownerRow]);

    await expect(OnboardingBusinessPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  it('collapses null seeds to empty strings and passes a null tier through', async () => {
    mockSql.mockResolvedValueOnce([
      { ...ownerRow, category: null, website: null, subscription_tier: null },
    ]);

    const element = await OnboardingBusinessPage();

    expect(element.props.initialValues).toEqual({
      category: '',
      website: '',
      businessName: 'RepWorth Cafe',
    });
    expect(element.props.subscriptionTier).toBeNull();
  });
});
