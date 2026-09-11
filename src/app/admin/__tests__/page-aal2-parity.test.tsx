// src/app/admin/__tests__/page-aal2-parity.test.tsx
//
// RUNTIME proof of audit rule P2 for the surviving pages #1184 flipped.
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

// The two parameters are declared even though the body ignores them: the
// assertions below read `mock.calls[0][1]` (the options object), and a zero-arg
// implementation types `calls` as a 0-tuple, which `next build`'s type check
// rejects with TS2493 even though `pnpm typecheck` lets it through.
//
// THE YIELD BEFORE `callOrder.push('gate')` IS THE POINT OF THIS MOCK, and it was
// missing until red-team round 3 (R3-F1). Without it the body runs synchronously
// to completion the instant the page CALLS the gate, so `'gate'` is recorded even
// when the page never AWAITED it — and a dropped `await` survived on five of the
// six pages with `ci:admin-aal2`, ESLint and `tsc` all clean. That is not a
// cosmetic gap: an unawaited gate lets the page read `sql` before the step-up
// resolves, which is the parallel read path rule P2 exists to close. With the
// yield, an unawaited gate lets a service record first, `callOrder[0]` is
// `'read'`, and the case fails. Do not remove it to "simplify" the mock.
const { mockRequireAdminPage, callOrder, gateImplementation } = vi.hoisted(() => {
  const callOrder: string[] = [];
  // ONE owner for the gate body, so `beforeEach` cannot reinstall a different
  // one. That is not hypothetical: R3-F1's first fix added the yield here and
  // left `beforeEach` restating the synchronous version, and the mutation went
  // on surviving on five of six pages.
  const gateImplementation = async (_sql: unknown, _options: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    callOrder.push('gate');
    return { id: 'admin-1', role: 'admin' };
  };
  return { callOrder, gateImplementation, mockRequireAdminPage: vi.fn(gateImplementation) };
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

vi.mock('next/link', () => ({ default: ({ children }: { children?: unknown }) => children }));
vi.mock('@/components/admin/ui/AdminPage', () => ({ AdminPage: () => null }));
vi.mock('../overview/OverviewClient', () => ({ OverviewClient: () => null }));
vi.mock('../costs/CostsClient', () => ({ CostsClient: () => null }));
vi.mock('../jobs/JobsClient', () => ({ JobsClient: () => null }));
vi.mock('../notifications/NotificationsClient', () => ({ NotificationsClient: () => null }));

/**
 * The surviving pages, each with the `from` its sibling-route parity requires.
 *
 * `from` is asserted alongside `aal2` on purpose: it is the `?from=` target of the
 * login and MFA-challenge redirects, so a wrong value sends a stepped-up admin to
 * the wrong page.
 */
const PAGES = [
  {
    name: '/admin/overview',
    load: () => import('../overview/page'),
    props: undefined as unknown,
    from: '/admin/overview',
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
    // Re-install the SAME yielding body as the hoisted default. Restating it
    // without the yield is what made R3-F1 survive its first fix: the hoisted
    // implementation was corrected, and this line quietly put the synchronous
    // one back before every test.
    mockRequireAdminPage.mockImplementation(gateImplementation);
  });

  it.each(PAGES)('$name steps up to aal2 before reading anything', async ({ load, props, from }) => {
    const mod = await load();
    await (mod.default as (p?: unknown) => Promise<unknown>)(props);

    expect(mockRequireAdminPage).toHaveBeenCalledTimes(1);
    expect(mockRequireAdminPage.mock.calls[0]![1]).toEqual({ from, aal2: true });
    // The gate is first: these pages read the database directly, so a read that
    // starts before the step-up is a read an un-stepped-up caller triggered.
    expect(callOrder[0]).toBe('gate');
  });

  it('a refused step-up stops the page before any data read', async () => {
    // requireAdminPage redirects rather than returning on refusal, and `redirect()`
    // signals that by throwing. The page must not swallow it into a render.
    mockRequireAdminPage.mockImplementation(async (_sql: unknown, _options: unknown) => {
      callOrder.push('gate');
      throw new Error('NEXT_REDIRECT');
    });

    const mod = await import('../overview/page');
    await expect((mod.default as () => Promise<unknown>)()).rejects.toThrow('NEXT_REDIRECT');
    expect(callOrder).toEqual(['gate']);
  });
});
