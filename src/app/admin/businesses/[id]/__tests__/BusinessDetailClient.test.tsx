// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// useBusinessDetail calls router.refresh() from invalidate(), so an edited
// name/category reaches the server-rendered page chrome. jsdom mounts no app
// router, so stub next/navigation.
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

// Health presentation has ONE owner (src/components/admin/ui/HealthBadge.tsx).
// This spy delegates to the real component, so every other test in this file is
// unaffected — it exists so the two tests at the bottom can assert that the
// detail page RENDERS THROUGH that owner rather than through a private copy.
// A private copy is invisible to a rendering assertion (the markup is
// identical until the day the two diverge), which is exactly how the copy
// deleted in the 2026-08-15 Pathfinder pass (§A1) survived review.
const { healthBadgeProps } = vi.hoisted(() => ({ healthBadgeProps: vi.fn() }));
vi.mock('@/components/admin/ui/HealthBadge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/admin/ui/HealthBadge')>();
  return {
    HealthBadge: (props: Parameters<typeof actual.HealthBadge>[0]) => {
      healthBadgeProps(props);
      return actual.HealthBadge(props);
    },
  };
});

import type { ChurnScore } from '@/lib/shared/churn-score';
import { BusinessDetailClient } from '../BusinessDetailClient';
import type { ChannelEnrollmentRow, DetailData } from '../types';

const BUSINESS_ID = '00000000-0000-0000-0000-0000000000a1';
const SIBLING_ID = '00000000-0000-0000-0000-0000000000a2';

function detail(overrides: Partial<DetailData> = {}): DetailData {
  return {
    business: {
      id: BUSINESS_ID,
      name: 'Main Street Cafe',
      category: 'restaurant',
      website: null,
      googlePlaceId: null,
      tone: 'friendly',
      productsServices: null,
      staffNames: [],
      highlightFacts: [],
      avoidFacts: [],
      sampleResponses: [],
      subscriptionStatus: 'active',
      subscriptionTier: 'copilot',
      ownerName: 'Alice Owner',
      ownerEmail: 'alice@cafe.com',
      lastSyncAt: '2026-08-01T12:30:00.000Z',
      trackedKeywords: [],
      googlePlaceLat: null,
      googlePlaceLng: null,
      rankingSearchLocation: null,
      googlePlaceAddress: null,
      ownerEmailBounced: false,
      telegramEnabled: false,
      whatsappEnabled: false,
      churnScore: {
        score: 12,
        level: 'healthy',
        breakdown: [{ signal: 'approval rate', value: '90%', contribution: 3 }],
      },
      ...overrides.business,
    },
    account: {
      id: 'acct-1',
      displayName: 'Main Street Cafe',
      subscriptionTier: 'copilot',
      subscriptionStatus: 'active',
      locations: [
        { id: BUSINESS_ID, name: 'Main Street Cafe', displayLabel: null, isPrimary: true, archivedAt: null },
      ],
      ...overrides.account,
    },
    reviews: [],
    reviewsTotal: 0,
    rankingSnapshots: [],
    zernio: { connection: null, awaitingOwnerConnect: [], unresolvedIncidents: [] },
    approvalAuditLog: [],
    accountAuditLog: [],
    autoApproval: {
      accountDefault: { policyId: null, threshold: null, exists: false },
      locations: [],
      readiness: {
        runtimeEnabled: false,
        providerModerationEnabled: false,
        providerModerationValidated: false,
        accountWritable: true,
        canExpand: false,
        blockReasons: [],
      },
      recentApprovalAudit: [],
      recentPolicyChanges: [],
    },
    ...overrides,
  };
}

const NO_CHANNELS: ChannelEnrollmentRow[] = [];

function renderClient(data: DetailData, channels: ChannelEnrollmentRow[] = NO_CHANNELS) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BusinessDetailClient
        businessId={BUSINESS_ID}
        initialDetail={data}
        initialChannels={channels}
      />
    </QueryClientProvider>,
  );
}

describe('BusinessDetailClient', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ enrollments: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });

  it('renders the health badge and meta row from initialDetail, with no page <h1> of its own', () => {
    const { container } = renderClient(detail());

    // AdminPage (the server page) owns the title — the client must not render one.
    expect(container.querySelector('h1')).toBeNull();
    // Twice by design: the meta row badge and the Engagement section badge.
    expect(screen.getAllByText('Healthy')).toHaveLength(2);
    expect(screen.getAllByText('12')).toHaveLength(2);
    // Also echoed by ProfileEditor's read-only summary, hence getAllByText.
    expect(screen.getAllByText('restaurant').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Back to Businesses/ })).toHaveAttribute(
      'href',
      '/admin/businesses',
    );
  });

  it('renders one chip per location for a multi-location account, marking the current one', () => {
    const data = detail();
    data.account.locations = [
      { id: BUSINESS_ID, name: 'Main Street Cafe', displayLabel: null, isPrimary: true, archivedAt: null },
      { id: SIBLING_ID, name: 'Second Ave Cafe', displayLabel: null, isPrimary: false, archivedAt: null },
    ];

    renderClient(data);

    expect(screen.getByText('Account (2 locations)')).toBeInTheDocument();
    const current = screen.getByRole('link', { name: /Main Street Cafe/ });
    const sibling = screen.getByRole('link', { name: /Second Ave Cafe/ });
    // The active-location chip is the neutralized solid one; siblings are outlined.
    expect(current.className).toContain('bg-gray-900');
    expect(sibling.className).not.toContain('bg-gray-900');
    expect(sibling).toHaveAttribute('href', `/admin/businesses/${SIBLING_ID}`);
  });

  it('renders approval audit entries through DataTable', () => {
    const data = detail();
    data.approvalAuditLog = [
      {
        id: 'audit-1',
        responseId: 'resp-1',
        action: 'auto_approved_by_policy',
        actorUserId: 'user-7',
        createdAt: '2026-07-01T10:00:00.000Z',
      },
    ];

    renderClient(data);

    expect(screen.getByText('Approval Audit Log')).toBeInTheDocument();
    // Underscores are humanized by the Event column renderer.
    expect(screen.getByText('auto approved by policy')).toBeInTheDocument();
    expect(screen.getByText('user-7')).toBeInTheDocument();
  });

  it('renders the bounce-flag banner only when ownerEmailBounced is set', () => {
    const { unmount } = renderClient(detail());
    expect(screen.queryByText(/Owner email is bouncing/)).not.toBeInTheDocument();
    unmount();

    const bounced = detail();
    bounced.business.ownerEmailBounced = true;
    renderClient(bounced);

    expect(screen.getByText(/Owner email is bouncing/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Clear bounce flag/ }),
    ).toBeInTheDocument();
  });

  it('renders the Resend invite button only while the account is pending_payment', () => {
    // `active` (the default fixture) is past the invite stage.
    const { unmount } = renderClient(detail());
    expect(screen.queryByRole('button', { name: /Resend invite/ })).not.toBeInTheDocument();
    unmount();

    const pending = detail();
    pending.account.subscriptionStatus = 'pending_payment';
    renderClient(pending);

    expect(screen.getByRole('button', { name: /Resend invite/ })).toBeEnabled();
    expect(screen.getByText('Owner invite')).toBeInTheDocument();
  });

  it('POSTs the resend and shows the outcome inline, with no browser dialog', async () => {
    const confirmSpy = vi.fn(() => true);
    const alertSpy = vi.fn();
    vi.stubGlobal('confirm', confirmSpy);
    vi.stubGlobal('alert', alertSpy);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              String(url).endsWith('/resend-invite')
                ? { success: true, ownerEmailRedacted: 'a***@cafe.com' }
                : { enrollments: [] },
            ),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const pending = detail();
    pending.account.subscriptionStatus = 'pending_payment';
    renderClient(pending);

    fireEvent.click(screen.getByRole('button', { name: /Resend invite/ }));

    expect(await screen.findByText('Invite re-sent to a***@cafe.com.')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('surfaces the server-mapped resend error inline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/resend-invite')
          ? new Response(
              JSON.stringify({
                error: 'This owner has already signed in, so the invite was accepted.',
                code: 'OWNER_ALREADY_SIGNED_IN',
              }),
              { status: 409, headers: { 'content-type': 'application/json' } },
            )
          : new Response(JSON.stringify({ enrollments: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );

    const pending = detail();
    pending.account.subscriptionStatus = 'pending_payment';
    renderClient(pending);

    fireEvent.click(screen.getByRole('button', { name: /Resend invite/ }));

    expect(
      await screen.findByText(
        'This owner has already signed in, so the invite was accepted.',
      ),
    ).toBeInTheDocument();
  });

  // ── Health presentation has ONE owner ───────────────────────────────
  //
  // Both surfaces on this page (the meta row and the Engagement section) must
  // render through src/components/admin/ui/HealthBadge.tsx, the component
  // /admin/businesses' Health column and /admin/overview's at-risk list already
  // use. Spec §5.1 names "would disagree with the Health column on
  // /admin/businesses" as a real failure mode.

  it('renders both health badges through the shared HealthBadge owner', () => {
    healthBadgeProps.mockClear();

    renderClient(detail());

    // A private copy would render identical markup and satisfy every
    // label/class assertion — only the module boundary catches it.
    expect(healthBadgeProps.mock.calls.map(([props]) => props)).toEqual([
      { level: 'healthy', score: 12 },
      { level: 'healthy', score: 12 },
    ]);
  });

  it('does not paint an unrecognised churn level in the healthy green', () => {
    // The deleted private copy was keyed `Record<string, string>` and fell back
    // with `?? HEALTH_BADGE_STYLES.healthy`, so a level the UI did not know
    // rendered in confident green — the worst possible default for a churn
    // signal, and worse still because the label fell back to the raw level, so
    // the pill LOOKED deliberate. The shared owner is keyed on
    // ChurnScore['level'], which makes a new level a COMPILE error upstream;
    // the cast below is this test standing in for data the type system forbids.
    const data = detail();
    data.business.churnScore = {
      score: 91,
      level: 'imploding' as unknown as ChurnScore['level'],
      breakdown: [],
    };

    renderClient(data);

    // Two badges (meta row + Engagement), each `<span class="…"><span>91</span></span>`.
    const pills = screen.getAllByText('91').map((el) => el.parentElement!);
    expect(pills).toHaveLength(2);
    for (const pill of pills) {
      expect(pill.className).not.toContain('bg-green-100');
      expect(pill.textContent).not.toContain('Healthy');
    }
  });
});
