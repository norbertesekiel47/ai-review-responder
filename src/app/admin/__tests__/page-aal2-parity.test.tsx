// src/app/admin/__tests__/page-aal2-parity.test.tsx
//
// RUNTIME proof of audit rule P2 for the six pages #1184 flipped.
//
// `ci:admin-aal2` already enforces P2 statically: it parses each page and fails
// when a page whose sibling route gates its GET with `requireAdminWithAal2` does
// not pass `{ aal2: true }`. That check reads SOURCE. This suite calls the page
// functions and asserts what `requireAdminPage` was actually CALLED with, which is
// the half a source scan cannot see — a page could satisfy the parser and still
// pass a different object at runtime (a spread, a conditional, a refactor that
// moves the options behind a helper).
//
// It also pins the ORDER: the gate must be awaited before any data read, because
// these pages query `sql` directly and a read that starts first is a read an
// un-stepped-up caller triggered.
//
// The client components are stubbed rather than rendered — this is about the gate,
// not the markup, and their own suites cover them.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireAdminPage, callOrder } = vi.hoisted(() => {
  const callOrder: string[] = [];
  return {
    callOrder,
    mockRequireAdminPage: vi.fn(async () => {
      callOrder.push('gate');
      return { id: 'admin-1', role: 'admin' };
    }),
  };
});

function service<T>(name: string, value: T) {
  return vi.fn(async () => {
    callOrder.push(name);
    return value;
  });
}

vi.mock('@/lib/auth/page-gate', () => ({ requireAdminPage: mockRequireAdminPage }));
vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));

vi.mock('@/lib/admin/overview-service', () => ({
  getAdminOverview: service('read', { atRisk: [], totals: {} }),
}));
vi.mock('@/lib/admin/nav-counts-service', () => ({
  getAdminNavCounts: service('read', { flaggedOpen: 0, failedJobs: 0 }),
}));
vi.mock('@/lib/admin/business-summary', () => ({
  getBusinessSummaries: service('read', { businesses: [], total: 0 }),
  parseBusinessListFilters: () => ({}),
}));
vi.mock('@/lib/admin/business-detail-service', () => ({
  getBusinessDetail: service('read', null),
}));
vi.mock('@/lib/admin/business-channels-service', () => ({
  getBusinessChannelEnrollments: service('read', { enrollments: [] }),
}));
vi.mock('@/lib/solicitation/batch-view', () => ({
  readAdminBatchSummary: service('read', null),
}));
vi.mock('@/lib/admin/cost-report-service', () => ({
  getCostReport: service('read', { byProvider: [], byDay: [], byBusiness: [] }),
}));
vi.mock('@/lib/admin/margin-service', () => ({ getMarginReport: service('read', null) }));
vi.mock('@/lib/admin/jobs-service', () => ({ getAdminJobsData: service('read', { jobs: [] }) }));
vi.mock('@/lib/admin/queue-health', () => ({
  fetchQueueHealth: service('read', { queueHealth: { unavailable: true }, pool: null }),
}));
vi.mock('@/lib/admin/notifications-service', () => ({
  getAdminNotifications: service('read', { notifications: [], total: 0 }),
}));

// `notFound()` must throw the way Next's does, so a page taking that branch stops
// rather than continuing with null data.
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/link', () => ({ default: ({ children }: { children?: unknown }) => children }));
vi.mock('@/components/admin/ui/AdminPage', () => ({ AdminPage: () => null }));
vi.mock('../overview/OverviewClient', () => ({ OverviewClient: () => null }));
vi.mock('../businesses/BusinessesClient', () => ({ BusinessesClient: () => null }));
vi.mock('../businesses/[id]/BusinessDetailClient', () => ({ BusinessDetailClient: () => null }));
vi.mock('../costs/CostsClient', () => ({ CostsClient: () => null }));
vi.mock('../jobs/JobsClient', () => ({ JobsClient: () => null }));
vi.mock('../notifications/NotificationsClient', () => ({ NotificationsClient: () => null }));

/**
 * The six pages, each with the `from` its sibling-route parity requires.
 *
 * `from` is asserted alongside `aal2` on purpose: it is the `?from=` target of the
 * login and MFA-challenge redirects, so a wrong value sends a stepped-up admin to
 * the wrong page. `/admin/businesses/[id]` deliberately passes the LIST path —
 * `page-gate.ts` requires a static internal path and the detail route is dynamic.
 */
const PAGES = [
  {
    name: '/admin/overview',
    load: () => import('../overview/page'),
    props: undefined as unknown,
    from: '/admin/overview',
  },
  {
    name: '/admin/businesses',
    load: () => import('../businesses/page'),
    props: { searchParams: Promise.resolve({}) },
    from: '/admin/businesses',
  },
  {
    name: '/admin/businesses/[id]',
    load: () => import('../businesses/[id]/page'),
    props: {
      params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
      searchParams: Promise.resolve({}),
    },
    from: '/admin/businesses',
  },
  {
    name: '/admin/costs',
    load: () => import('../costs/page'),
    props: undefined as unknown,
    from: '/admin/costs',
  },
  {
    name: '/admin/jobs',
    load: () => import('../jobs/page'),
    props: undefined as unknown,
    from: '/admin/jobs',
  },
  {
    name: '/admin/notifications',
    load: () => import('../notifications/page'),
    props: undefined as unknown,
    from: '/admin/notifications',
  },
] as const;

describe('admin page gate parity (P2) — proven at runtime, not only in source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    mockRequireAdminPage.mockImplementation(async () => {
      callOrder.push('gate');
      return { id: 'admin-1', role: 'admin' };
    });
  });

  it.each(PAGES)('$name steps up to aal2 before reading anything', async ({ load, props, from }) => {
    const mod = await load();
    // `notFound()` is a legitimate outcome for the detail page against a null
    // fixture; the gate has already run by then, which is what this asserts.
    await (mod.default as (p?: unknown) => Promise<unknown>)(props).catch((err: Error) => {
      if (err.message !== 'NEXT_NOT_FOUND') throw err;
    });

    expect(mockRequireAdminPage).toHaveBeenCalledTimes(1);
    expect(mockRequireAdminPage.mock.calls[0]![1]).toEqual({ from, aal2: true });
    // The gate is first: these pages read the database directly, so a read that
    // starts before the step-up is a read an un-stepped-up caller triggered.
    expect(callOrder[0]).toBe('gate');
  });

  it('a refused step-up stops the page before any data read', async () => {
    // requireAdminPage redirects rather than returning on refusal, and `redirect()`
    // signals that by throwing. The page must not swallow it into a render.
    mockRequireAdminPage.mockImplementation(async () => {
      callOrder.push('gate');
      throw new Error('NEXT_REDIRECT');
    });

    const mod = await import('../overview/page');
    await expect((mod.default as () => Promise<unknown>)()).rejects.toThrow('NEXT_REDIRECT');
    expect(callOrder).toEqual(['gate']);
  });
});
