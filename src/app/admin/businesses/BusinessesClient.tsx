'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required); the
// server page additionally gates with requireAdminPage.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_HEALTH_FILTERS,
  type BusinessHealthFilter,
  type BusinessSummariesFilters,
  type BusinessSummariesResult,
} from '@/lib/admin/business-summary';
import { SubscriptionStatus, type SubscriptionStatusValue } from '@/lib/shared/subscription-status';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { FilterBar, FILTER_SELECT_CLASS, type FilterChip } from '@/components/admin/ui/FilterBar';
import { StatusBadge, statusLabel } from '@/components/admin/ui/StatusBadge';
import { HealthBadge, HEALTH_BADGE_LABELS } from '@/components/admin/ui/HealthBadge';
import { RelativeTime } from '@/components/admin/ui/RelativeTime';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminDate } from '@/components/admin/ui/format';

// Mirrors src/app/api/admin/businesses/route.ts's GET body: the list, total and
// response-metrics window come from BusinessSummariesResult (single owner:
// business-summary.ts, shared with /admin/overview); limit/offset are
// request-echo fields the route adds on top.
type BusinessListData = BusinessSummariesResult & {
  limit: number;
  offset: number;
};

type BusinessRow = BusinessListData['businesses'][number];

import { BUSINESSES_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

/** Keystrokes settle for this long before a search round-trips to the server. */
const SEARCH_DEBOUNCE_MS = 300;

// A function, not a module constant: the window-labelled header derives its
// `N` from BusinessSummariesResult.responseMetricsWindowDays (single owner:
// src/lib/admin/business-summary.ts), which is only known at render.
//
// Eight columns, down from eleven (X5): Category rides under the name and the
// average response time under the response rate — both are context for the
// value beside them, not something an operator scans a column for.
function buildColumns(windowDays: number): DataTableColumn<BusinessRow>[] {
  return [
    {
      key: 'name',
      header: 'Name',
      render: (b) => (
        <span className="block">
          <span className="font-medium">{b.name}</span>
          {b.category && <span className="block text-xs text-gray-500">{b.category}</span>}
        </span>
      ),
      sortValue: (b) => b.name,
    },
    {
      key: 'status',
      header: 'Status',
      render: (b) => <StatusBadge vocab="subscription" value={b.subscriptionStatus} />,
    },
    {
      key: 'health',
      header: 'Health',
      render: (b) => <HealthBadge level={b.churnScore.level} score={b.churnScore.score} />,
      sortValue: (b) => b.churnScore.score,
    },
    {
      key: 'pending',
      header: 'Pending',
      render: (b) =>
        b.pendingApprovalCount > 0 ? (
          <span className="inline-block rounded bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
            {b.pendingApprovalCount}
          </span>
        ) : (
          <span className="text-gray-400">0</span>
        ),
      sortValue: (b) => b.pendingApprovalCount,
    },
    {
      key: 'reconnect',
      header: 'Reconnect',
      render: (b) =>
        b.pendingReconnectCount >= 3 ? (
          <span className="inline-block rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
            {b.pendingReconnectCount}
          </span>
        ) : b.pendingReconnectCount > 0 ? (
          <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            {b.pendingReconnectCount}
          </span>
        ) : (
          <span className="text-gray-400">{'—'}</span>
        ),
    },
    {
      key: 'responseRate',
      header: `Response rate (${windowDays}d)`,
      render: (b) => (
        <span className="block">
          <span className="text-gray-700">{b.responseRate}%</span>
          {b.avgResponseTimeHours !== null && (
            <span className="block text-xs text-gray-500">avg {b.avgResponseTimeHours}h to reply</span>
          )}
        </span>
      ),
      sortValue: (b) => b.responseRate,
    },
    // Header carries the zone: `formatAdminDate` deliberately does not self-label
    // (see src/components/admin/ui/format.ts), and repeating "UTC" per row would
    // be noise in a date-only column.
    { key: 'lastSync', header: 'Last Sync (UTC)', render: (b) => formatAdminDate(b.lastSyncAt, 'Never') },
    {
      key: 'lastActivity',
      header: 'Last activity',
      // RelativeTime captures "now" after mount (X29) so the server and client
      // renders never disagree on a relative label.
      render: (b) => <RelativeTime value={b.lastActivity} className="text-gray-500" />,
      sortValue: (b) => b.lastActivity ?? '',
    },
  ];
}

interface Filters {
  search: string;
  status: SubscriptionStatusValue | '';
  health: BusinessHealthFilter | '';
}

function filtersFromServer(initial: BusinessSummariesFilters | undefined): Filters {
  return {
    search: initial?.search ?? '',
    status: initial?.status ?? '',
    health: initial?.health ?? '',
  };
}

function sameFilters(a: Filters, b: Filters): boolean {
  return a.search === b.search && a.status === b.status && a.health === b.health;
}

function anyFilterActive(filters: Filters): boolean {
  return filters.search !== '' || filters.status !== '' || filters.health !== '';
}

/** The GET the route parses with `parseBusinessListFilters` — only present filters are sent. */
async function fetchBusinessesPage(page: number, filters: Filters): Promise<BusinessListData> {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  if (filters.search) params.set('q', filters.search);
  if (filters.status) params.set('status', filters.status);
  if (filters.health) params.set('health', filters.health);
  const res = await fetch(`/api/admin/businesses?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch businesses: ${res.status}`);
  return res.json() as Promise<BusinessListData>;
}

/** One removable chip per active select filter; the search box is its own chip-less control. */
function filterChips(filters: Filters, applyFilter: (patch: Partial<Filters>) => void): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filters.status) {
    chips.push({
      id: 'status',
      label: `Status: ${statusLabel('subscription', filters.status)}`,
      onRemove: () => applyFilter({ status: '' }),
    });
  }
  if (filters.health) {
    chips.push({
      id: 'health',
      label: `Health: ${HEALTH_BADGE_LABELS[filters.health]}`,
      onRemove: () => applyFilter({ health: '' }),
    });
  }
  return chips;
}

/** Search box + status/health selects + chips + the "N businesses" count (X5). */
function BusinessesFilterBar({
  searchInput,
  onSearchChange,
  filters,
  applyFilter,
  total,
}: {
  searchInput: string;
  onSearchChange: (value: string) => void;
  filters: Filters;
  applyFilter: (patch: Partial<Filters>) => void;
  total: number;
}) {
  return (
    <FilterBar
      search={searchInput}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search by name…"
      searchLabel="Search businesses by name"
      rowCount={total}
      rowNoun="businesses"
      chips={filterChips(filters, applyFilter)}
      controls={
        <>
          <select
            aria-label="Status"
            value={filters.status}
            onChange={(event) => applyFilter({ status: event.target.value as Filters['status'] })}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">All statuses</option>
            {Object.values(SubscriptionStatus).map((status) => (
              <option key={status} value={status}>
                {statusLabel('subscription', status)}
              </option>
            ))}
          </select>
          <select
            aria-label="Health"
            value={filters.health}
            onChange={(event) => applyFilter({ health: event.target.value as Filters['health'] })}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">All health levels</option>
            {BUSINESS_HEALTH_FILTERS.map((level) => (
              <option key={level} value={level}>
                {HEALTH_BADGE_LABELS[level]}
              </option>
            ))}
          </select>
        </>
      }
    />
  );
}

/** The loaded page: an optional stale-data notice above the bounded, server-paginated table. */
function BusinessesTable({
  data,
  page,
  onPageChange,
  filtered,
  refetchFailed,
  onRetry,
}: {
  data: BusinessListData;
  page: number;
  onPageChange: (page: number) => void;
  filtered: boolean;
  refetchFailed: boolean;
  onRetry: () => void;
}) {
  return (
    <>
      {refetchFailed && (
        <div className="mb-4">
          <ErrorState
            title="Last refresh failed"
            detail="GET /api/admin/businesses failed — showing the last loaded data."
            onRetry={onRetry}
          />
        </div>
      )}
      <DataTable
        columns={buildColumns(data.responseMetricsWindowDays)}
        rows={data.businesses}
        rowKey={(b) => b.id}
        rowHref={(b) => `/admin/businesses/${b.id}`}
        maxHeight="70vh"
        serverPagination={{
          page,
          pageSize: PAGE_SIZE,
          totalRows: data.total,
          onPageChange,
        }}
        emptyState={
          filtered ? (
            <EmptyState title="No businesses match" detail="Clear a filter or try a shorter name." />
          ) : (
            <EmptyState title="No businesses found" detail="Add one with + Add Business." />
          )
        }
      />
    </>
  );
}

export function BusinessesClient({
  initialData,
  initialFilters,
}: {
  initialData: BusinessListData;
  /** The filters the server page rendered `initialData` under, so the first client query is a cache hit. */
  initialFilters?: BusinessSummariesFilters;
}) {
  const serverFilters = filtersFromServer(initialFilters);
  const [page, setPage] = useState(0);
  // `searchInput` is what the box shows; `filters.search` is what the server
  // was last asked for. They diverge for SEARCH_DEBOUNCE_MS after a keystroke.
  const [searchInput, setSearchInput] = useState(serverFilters.search);
  const [filters, setFilters] = useState<Filters>(serverFilters);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  function applyFilter(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(0);
  }

  function onSearchChange(value: string) {
    setSearchInput(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => applyFilter({ search: value.trim() }), SEARCH_DEBOUNCE_MS);
  }

  const { data, isLoading, isError, refetch } = useQuery<BusinessListData>({
    queryKey: ['admin-businesses', page, filters.search, filters.status, filters.health],
    queryFn: () => fetchBusinessesPage(page, filters),
    staleTime: 30_000,
    initialData: page === 0 && sameFilters(filters, serverFilters) ? initialData : undefined,
  });

  const filterBar = (
    <BusinessesFilterBar
      searchInput={searchInput}
      onSearchChange={onSearchChange}
      filters={filters}
      applyFilter={applyFilter}
      total={data?.total ?? 0}
    />
  );

  if (isLoading && !data) {
    return (
      <>
        {filterBar}
        <TableSkeleton />
      </>
    );
  }
  if (isError && !data) {
    return (
      <>
        {filterBar}
        <ErrorState
          title="Couldn't load businesses"
          detail="GET /api/admin/businesses failed"
          onRetry={() => void refetch()}
        />
      </>
    );
  }
  if (!data) return null;

  return (
    <>
      {filterBar}
      <BusinessesTable
        data={data}
        page={page}
        onPageChange={setPage}
        filtered={anyFilterActive(filters)}
        refetchFailed={isError}
        onRetry={() => void refetch()}
      />
    </>
  );
}
