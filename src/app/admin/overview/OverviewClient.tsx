'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { OverviewData } from '@/lib/admin/overview-service';
import { navCountsQueryOptions } from '@/components/admin/nav-counts-query';
import { StatTile } from '@/components/admin/ui/StatTile';
import { HealthBadge } from '@/components/admin/ui/HealthBadge';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';
import { RelativeTime } from '@/components/admin/ui/RelativeTime';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminCount } from '@/components/admin/ui/format';
import { LastUpdated } from '@/components/admin/ui/LastUpdated';

/** The pending-outbox depth above which the tile goes red. */
const PENDING_OUTBOX_ALERT_THRESHOLD = 10;

function OverviewContent({ data, flaggedOpen }: { data: OverviewData; flaggedOpen: number }) {
  const { systemHealth, atRisk } = data;

  // Every tile links to the page that resolves it, and the ones that can
  // breach go red — the tile IS the alert (X13). The former "Needs attention"
  // strip restated the same red tiles in prose with its own casing; one list.
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Pending Outbox"
          value={formatAdminCount(systemHealth.pendingOutbox)}
          alert={systemHealth.pendingOutbox > PENDING_OUTBOX_ALERT_THRESHOLD}
          href="/admin/jobs"
        />
        <StatTile
          label="Failed Jobs"
          value={formatAdminCount(systemHealth.failedJobs)}
          alert={systemHealth.failedJobs > 0}
          href="/admin/jobs"
        />
        <StatTile
          label="Flagged Open"
          value={formatAdminCount(flaggedOpen)}
          alert={flaggedOpen > 0}
          sub="held drafts awaiting review"
          href="/admin/flagged"
        />
        <StatTile label="Today's API Cost" value={`$${systemHealth.todayCostUsd.toFixed(2)}`} href="/admin/costs" />
        <StatTile
          label="Notif Failures (24h)"
          value={formatAdminCount(systemHealth.notificationFailures24h)}
          alert={systemHealth.notificationFailures24h > 0}
          href="/admin/notifications"
        />
        <StatTile
          label="Email Health"
          value={`${systemHealth.emailHealth.deliveryRate24h}%`}
          alert={systemHealth.emailHealth.redState}
          href="/admin/notifications"
          sub={
            <>
              {systemHealth.emailHealth.sent24h} sent (24h) ·{' '}
              {systemHealth.emailHealth.hardBounces7d} hard bounces ·{' '}
              {systemHealth.emailHealth.complaints7d} complaints (7d)
            </>
          }
        />
      </div>

      {/* At-risk list (spec §5.1/§5.3): the eligible count N is what the service
          FILTERED to `churnScore.level !== 'healthy'` and then capped, while M is
          the unfiltered business total — so "3 of 128" reads as "3 of your 128
          businesses need a look", and "View all →" is the way to the inventory. */}
      <div className="mt-8">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-semibold text-gray-800">
            At risk ({formatAdminCount(atRisk.length)} of {formatAdminCount(data.totalBusinesses)})
          </h2>
          <Link
            href="/admin/businesses"
            className="text-sm font-medium text-gray-600 underline hover:text-gray-900"
          >
            View all →
          </Link>
        </div>
        <div className="mt-3">
          {atRisk.length === 0 ? (
            <EmptyState
              title="Nothing at risk"
              detail="Every business is scoring healthy right now."
            />
          ) : (
            <ul className="divide-y divide-gray-200 overflow-hidden rounded-md border border-gray-200 bg-white">
              {/* Status and Last activity ride on each row (X14): the two facts
                  that decide whether a row is "call them" or "they churned", so
                  triage no longer opens every row to find out. */}
              {atRisk.map((business) => (
                <li key={business.id}>
                  <Link
                    href={`/admin/businesses/${business.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-gray-50"
                  >
                    <span className="min-w-0 flex-1 text-sm font-medium text-gray-900">{business.name}</span>
                    <StatusBadge vocab="subscription" value={business.subscriptionStatus} />
                    <span className="text-xs text-gray-500">
                      Last activity <RelativeTime value={business.lastActivity} fallback="none" className="text-gray-700" />
                    </span>
                    <HealthBadge
                      level={business.churnScore.level}
                      score={business.churnScore.score}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

export function OverviewClient({
  initialData,
  flaggedOpen,
}: {
  initialData: OverviewData;
  flaggedOpen: number;
}) {
  const { data, isLoading, isError, refetch, dataUpdatedAt, isFetching } = useQuery<OverviewData>({
    queryKey: ['admin-overview'],
    queryFn: async () => {
      const res = await fetch('/api/admin/overview');
      if (!res.ok) throw new Error(`Failed to fetch overview: ${res.status}`);
      return res.json() as Promise<OverviewData>;
    },
    refetchInterval: 30_000,
    initialData,
    staleTime: 30_000,
  });

  // Same cache entry the sidebar's Flagged badge reads (navCountsQueryOptions
  // is the single owner of the queryKey/fetcher/poll cadence) — the Flagged
  // tile must never disagree with the sidebar badge on screen at once. Seeded
  // from the server-provided flaggedOpen prop plus this page's already-fetched
  // failedJobs so the tile never flashes 0 before the shared query resolves.
  const { data: navCounts } = useQuery({
    ...navCountsQueryOptions,
    initialData: { flaggedOpen, failedJobs: initialData.systemHealth.failedJobs },
  });

  // Page chrome (group/title/description + the three static action links) lives
  // on the server page so it renders in the RSC payload, never behind this
  // client's loading state.
  return (
    <>
      <LastUpdated updatedAt={dataUpdatedAt} refreshing={isFetching} onRefresh={() => void refetch()} />
      {isLoading && !data ? (
        <TableSkeleton />
      ) : isError && !data ? (
        <ErrorState
          title="Couldn't load overview"
          detail="GET /api/admin/overview failed"
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <>
          {isError && (
            <div className="mb-4">
              <ErrorState
                title="Last refresh failed"
                detail="GET /api/admin/overview failed — showing the last loaded data."
                onRetry={() => void refetch()}
              />
            </div>
          )}
          <OverviewContent data={data} flaggedOpen={navCounts.flaggedOpen} />
        </>
      ) : null}
    </>
  );
}
