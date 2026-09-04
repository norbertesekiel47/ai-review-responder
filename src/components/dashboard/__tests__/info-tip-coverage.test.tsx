// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AnalyticsAggregateView } from '@/components/dashboard/analytics/AnalyticsAggregateView';
import type { AggregateDashboardData } from '@/lib/dashboard/types';

// The same shims `AnalyticsContent.test.tsx` uses. This suite is about tree
// ORDER around the live region, so the shell chrome is stubbed out.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: 'all' }),
}));
vi.mock('@/contexts/PendingCountContext', () => ({
  useSetPendingCount: () => () => {},
}));
vi.mock('@/components/dashboard/shell/TopBar', () => ({
  TopBar: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

const DASHBOARD_ROOT = join(import.meta.dirname, '..');

/**
 * Every file under `src/components/dashboard` that renders an `InfoTip`,
 * DERIVED by scanning rather than listed by hand.
 *
 * The hand-maintained version of this list went stale on the very next branch
 * after it was written: `ValueKpiGrid` gained two tips and nothing went red,
 * which is precisely the enforcement gap the standards review named ("the
 * 'every' is enforced nowhere — a sixth surface can gain a tip with no test").
 * A derived list cannot drift.
 */
function tipBearingSources(dir = DASHBOARD_ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') tipBearingSources(path, out);
    } else if (/\.tsx$/.test(entry.name) && readFileSync(path, 'utf8').includes('<InfoTip')) {
      out.push(path);
    }
  }
  return out;
}

describe('info tip coverage (#1086)', () => {
  it('finds every tip-bearing surface, so this suite cannot silently under-cover', () => {
    const sources = tipBearingSources();

    // A floor, not an equality: a new tip should not have to edit this test.
    // It exists so a REFACTOR that accidentally drops every tip goes red.
    expect(sources.length).toBeGreaterThanOrEqual(5);
    expect(sources.some((f) => f.endsWith('ValueKpiGrid.tsx'))).toBe(true);
  });

  // Intake invariant: a screen reader only announces changes to a region that
  // already existed, so a tip must never displace one.
  //
  // Two arms, because the surfaces divide into two cases.
  it('adding a tip does not move an existing LiveRegion in the tree', () => {
    // Arm 1 — no tip-bearing component mounts a LiveRegion ITSELF, so within
    // those files the invariant is vacuous and stays that way.
    for (const file of tipBearingSources()) {
      expect(
        readFileSync(file, 'utf8').includes('LiveRegion'),
        `${file} now mounts a LiveRegion. The invariant is no longer vacuous `
          + 'inside this file — assert the region\'s position directly.',
      ).toBe(false);
    }

    // Arm 2 — but a PARENT can mount one, and one does: AnalyticsAggregateView
    // renders <LiveRegion> and then the KPI cards that carry two tips. Arm 1
    // alone would have called this safe. Assert the real ordering.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <AnalyticsAggregateView data={aggregateData()} refresh={vi.fn()} />
      </QueryClientProvider>,
    );

    const region = container.querySelector('[role="status"]');
    const tips = container.querySelectorAll('.info-tip');

    expect(region).toHaveTextContent('Analytics ready.');
    expect(tips.length).toBeGreaterThan(0);

    // The region must still come BEFORE every tip in document order. If a tip
    // were ever inserted above it, this flips.
    for (const tip of tips) {
      expect(
        region!.compareDocumentPosition(tip) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });
});

/** Mirrors `AnalyticsContent.test.tsx`'s `baseAggregate`; only the KPI strip
 *  and the live region matter here, so everything else is empty. */
function aggregateData(): AggregateDashboardData {
  return {
    scope: 'aggregate',
    valueSummary: {
      totalReviewsHandled: 1284,
      totalTimeSavedMinutes: 8988,
      currentResponseRate: 92,
      baselineResponseRate: 61,
    },
    ratingBreakdown: {
      counts: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: 0 })),
      total: 0,
    },
    reviewVelocity: [],
    perLocationVelocity: [],
    ranking: [],
    perLocationRanking: [],
    recentReviews: [],
    perLocationBriefs: [],
    locationKpis: [],
    activeLocationCount: 3,
  } as unknown as AggregateDashboardData;
}
