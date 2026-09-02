'use client';

// usePendingApprovals — the Needs Action queue's data hook (UX audit D2).
// Pages through GET /api/dashboard/reviews/pending for the current scope and
// exposes the flattened rows plus the authoritative totals. Load more appends
// the next 50; a refetch re-reads every loaded page so an approve/regenerate
// settles in place instead of resetting the owner's scroll.

import { useCallback } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { LocationScope } from '@/contexts/LocationContext';
import type { PendingApprovalsPage } from '@/lib/dashboard/pending-approvals';

export const PENDING_APPROVALS_QUERY_KEY = 'dashboard-pending-approvals';

export interface PendingApprovalsQueue {
  items: PendingApprovalsPage['items'] | null;
  total: number;
  pendingTotal: number;
  /** No page loaded yet for this scope. */
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  refetch: () => Promise<unknown>;
}

function buildUrl(scope: LocationScope | null, offset: number): string {
  const params = new URLSearchParams();
  if (scope !== null) params.set('scope', scope);
  if (offset > 0) params.set('offset', String(offset));
  const query = params.toString();
  return query ? `/api/dashboard/reviews/pending?${query}` : '/api/dashboard/reviews/pending';
}

async function fetchPage(
  scope: LocationScope | null,
  offset: number,
  signal: AbortSignal,
): Promise<PendingApprovalsPage> {
  const res = await fetch(buildUrl(scope, offset), {
    headers: { Accept: 'application/json' },
    signal,
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = body && typeof body === 'object' ? Reflect.get(body, 'error') : null;
    throw new Error(typeof error === 'string' ? error : `Request failed (${res.status})`);
  }
  if (!isPage(body)) throw new Error('Pending approvals response was incomplete');
  return body;
}

function isPage(value: unknown): value is PendingApprovalsPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Record<string, unknown>;
  return Array.isArray(page.items)
    && Number.isInteger(page.total)
    && Number.isInteger(page.pendingTotal)
    && Number.isInteger(page.limit)
    && Number.isInteger(page.offset);
}

export function usePendingApprovals(scope: LocationScope | null): PendingApprovalsQueue {
  const query = useInfiniteQuery({
    queryKey: [PENDING_APPROVALS_QUERY_KEY, scope],
    queryFn: ({ pageParam, signal }) => fetchPage(scope, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.offset + last.items.length;
      return last.items.length > 0 && next < last.total ? next : undefined;
    },
  });

  const pages = query.data?.pages ?? null;
  const lastPage = pages?.at(-1) ?? null;
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  return {
    items: pages ? pages.flatMap((page) => page.items) : null,
    total: lastPage?.total ?? 0,
    pendingTotal: lastPage?.pendingTotal ?? 0,
    loading: query.isPending,
    error: query.error instanceof Error ? query.error.message : null,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore,
    refetch: query.refetch,
  };
}
