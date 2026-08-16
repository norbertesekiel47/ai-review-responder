'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { OverviewData } from '@/lib/admin/overview-service';
import { navCountsQueryOptions } from '@/components/admin/nav-counts-query';
import { StatTile } from '@/components/admin/ui/StatTile';
import { HealthBadge } from '@/components/admin/ui/HealthBadge';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminCount } from '@/components/admin/ui/format';

function OverviewContent({ data, flaggedOpen }: { data: OverviewData; flaggedOpen: number }) {
  const { systemHealth, atRisk } = data;

  const attention = [
    systemHealth.failedJobs > 0 && {
      href: '/admin/jobs',
      label: `${systemHealth.failedJobs} failed job(s)`,
    },
    flaggedOpen > 0 && {
      href: '/admin/flagged',
      label: `${flaggedOpen} flagged response(s) awaiting review`,
    },
    systemHealth.pendingOutbox > 10 && {
      href: '/admin/jobs',
      label: `${systemHealth.pendingOutbox} outbox rows pending`,
    },
    (systemHealth.notificationFailures24h > 0 || systemHealth.emailHealth.redState) && {
      href: '/admin/notifications',
      label: 'notification delivery needs a look',
    },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile
          label="Pending Outbox"
          value={formatAdminCount(systemHealth.pendingOutbox)}
          alert={systemHealth.pendingOutbox > 10}
        />
        <StatTile
          label="Failed Jobs"
          value={formatAdminCount(systemHealth.failedJobs)}
          alert={systemHealth.failedJobs > 0}
        />
        <StatTile label="Today's API Cost" value={`$${systemHealth.todayCostUsd.toFixed(2)}`} />
        <StatTile
          label="Notif Failures (24h)"
          value={formatAdminCount(systemHealth.notificationFailures24h)}
          alert={systemHealth.notificationFailures24h > 0}
        />
        <StatTile
          label="Email Health"
          value={`${systemHealth.emailHealth.deliveryRate24h}%`}
          alert={systemHealth.emailHealth.redState}
          sub={
            <>
              {systemHealth.emailHealth.sent24h} sent (24h) ·{' '}
              {systemHealth.emailHealth.hardBounces7d} hard bounces ·{' '}
              {systemHealth.emailHealth.complaints7d} complaints (7d)
            </>
          }
        />
      </div>

      {attention.length > 0 && (
        <div className="mt-4 rounded-md border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Needs attention</h2>
          <ul className="mt-2 space-y-1">
            {attention.map((item) => (
              <li key={item.href + item.label}>
                <Link href={item.href} className="text-sm text-gray-900 underline hover:text-gray-600">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

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
              {atRisk.map((business) => (
                <li key={business.id}>
                  <Link
                    href={`/admin/businesses/${business.id}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-gray-50"
                  >
                    <span className="text-sm font-medium text-gray-900">{business.name}</span>
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
  const { data, isLoading, isError, refetch } = useQuery<OverviewData>({
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
  // is the single owner of the queryKey/fetcher/poll cadence) — the
  // needs-attention strip's flagged-response line must never disagree with
  // the sidebar badge on screen at once. Seeded from the server-provided
  // flaggedOpen prop plus this page's already-fetched failedJobs so the tile
  // never flashes 0 before the shared query resolves.
  const { data: navCounts } = useQuery({
    ...navCountsQueryOptions,
    initialData: { flaggedOpen, failedJobs: initialData.systemHealth.failedJobs },
  });

  // Page chrome (group/title/description + the three static action links) lives
  // on the server page so it renders in the RSC payload, never behind this
  // client's loading state.
  return (
    <>
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
