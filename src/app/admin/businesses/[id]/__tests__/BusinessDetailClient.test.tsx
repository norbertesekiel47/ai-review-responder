// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// useBusinessDetail calls router.refresh() from invalidate(), so an edited
// name/category reaches the server-rendered page chrome. jsdom mounts no app
// router, so stub next/navigation.
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

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
});
