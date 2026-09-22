import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetUser, mockRedirect, mockSql, mockPaywall } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockRedirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
  mockSql: vi.fn(),
  mockPaywall: vi.fn(() => null),
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

vi.mock('../PaywallWithDemoClient', () => ({
  PaywallWithDemoClient: mockPaywall,
}));

const { default: OnboardingDemoPage } = await import('../page');
const { NO_DEMO_SENTINEL_STATUS } = await import('@/lib/demos/types');

describe('OnboardingDemoPage guard', () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.stubEnv('ADMIN_APP_URL', 'https://admin.example.com');
    vi.clearAllMocks();
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'auth-123' } },
      error: null,
    });
  });

  it('redirects admin away from owner onboarding to the configured Admin app', async () => {
    mockSql.mockResolvedValueOnce([
      {
        role: 'admin',
        subscription_status: 'pending_payment',
        place_id_verified: true,
        google_maps_url: null,
        business_name: 'Admin Business',
      },
    ]);

    await expect(OnboardingDemoPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('https://admin.example.com');
  });

  it('redirects sales_partner away from owner onboarding to /login', async () => {
    mockSql.mockResolvedValueOnce([
      {
        role: 'sales_partner',
        subscription_status: 'pending_payment',
        place_id_verified: true,
        google_maps_url: null,
        business_name: 'Legacy Partner Business',
      },
    ]);

    await expect(OnboardingDemoPage()).rejects.toThrow('NEXT_REDIRECT');

    expect(mockRedirect).toHaveBeenCalledWith('/login');
  });
});

describe('OnboardingDemoPage — no demo row (#1104)', () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'auth-123' } },
      error: null,
    });
  });

  const owner = {
    user_id: 'user-1',
    business_id: 'biz-1',
    role: 'owner',
    subscription_status: 'pending_payment',
    google_maps_url: null,
    business_name: 'Bella Vista',
  };

  it('renders the paywall with the in-memory sentinel status when the location is captured but no row exists', async () => {
    mockSql
      .mockResolvedValueOnce([{ ...owner, place_id_verified: true }])
      .mockResolvedValueOnce([]);

    // A Server Component returns an element; the client island is not invoked
    // here, so assert on the element's type and props.
    const element = (await OnboardingDemoPage()) as unknown as {
      type: unknown;
      props: { initialDemo: { id: string; generation_status: string }; isStale: boolean };
    };

    expect(element.type).toBe(mockPaywall);
    const props = element.props;
    expect(props.initialDemo.generation_status).toBe(NO_DEMO_SENTINEL_STATUS);
    expect(props.initialDemo.id).toBe('no-demo-sentinel');
    expect(props.isStale).toBe(false);
    // Two reads (owner, demo) and nothing else: the sentinel is never written.
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('redirects to /onboarding/start when there is no row AND no captured location', async () => {
    mockSql
      .mockResolvedValueOnce([{ ...owner, place_id_verified: false }])
      .mockResolvedValueOnce([]);

    await expect(OnboardingDemoPage()).rejects.toThrow('NEXT_REDIRECT:/onboarding/start');
    expect(mockPaywall).not.toHaveBeenCalled();
  });
});
