// src/components/admin/nav-counts-query.ts
//
// Single owner of the admin nav-badge counts fetch (GET /api/admin/nav-counts)
// and its react-query wiring. AdminSidebar's Flagged/failed-job badges and
// OverviewClient's needs-attention strip must read the SAME cache entry — same
// query key, same fetcher, same poll cadence — or the two can disagree on
// screen at once. Consumers spread `navCountsQueryOptions` into their own
// `useQuery` call (OverviewClient adds `initialData` seeded from its
// server-rendered props; AdminSidebar does not).

export interface NavCounts {
  flaggedOpen: number;
  failedJobs: number;
}

async function fetchNavCounts(): Promise<NavCounts> {
  const response = await fetch('/api/admin/nav-counts');
  if (!response.ok) throw new Error(`nav-counts failed (${response.status})`);
  return response.json();
}

export const navCountsQueryOptions = {
  queryKey: ['admin', 'nav-counts'] as const,
  queryFn: fetchNavCounts,
  refetchInterval: 60_000,
  staleTime: 30_000,
  retry: 1,
};
