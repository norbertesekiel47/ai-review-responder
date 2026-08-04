'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminFlaggedData } from '@/lib/admin/flagged-service';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { PaginationFooter, serverPaginationFooterState } from '@/components/admin/ui/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';

type FlaggedData = AdminFlaggedData & { limit: number; offset: number };

type DispositionAction =
  | 'approved_for_owner_review'
  | 'dismissed_false_positive'
  | 'requires_regeneration';

const ACTION_LABELS: Record<DispositionAction, string> = {
  approved_for_owner_review: 'Approve (notify owner)',
  dismissed_false_positive: 'Dismiss (false positive)',
  requires_regeneration: 'Needs regeneration',
};

export const PAGE_SIZE = 50 as const;

function FlaggedContent({
  data,
  offset,
  onOffsetChange,
  onDispose,
  disposing,
}: {
  data: FlaggedData;
  offset: number;
  onOffsetChange: (offset: number) => void;
  onDispose: (vars: { flaggedId: string; action: DispositionAction }) => void;
  disposing: boolean;
}) {
  // The route is offset-based; the shared footer is page-based. Convert at this
  // boundary only — `offset` stays the state shape AND the query key.
  const page = Math.floor(offset / PAGE_SIZE);
  const footer = serverPaginationFooterState({
    page,
    pageSize: PAGE_SIZE,
    rowsOnPage: data.flagged.length,
    totalRows: data.total,
  });

  return (
    <>
      {data.flagged.length === 0 ? (
        <EmptyState
          title="No open flagged responses"
          detail="Every held draft has been dispositioned."
        />
      ) : (
        <div className="space-y-4">
          {data.flagged.map((item) => (
            <div key={item.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-xs font-semibold ${
                    item.severity === 'high'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-yellow-100 text-yellow-800'
                  }`}
                >
                  {item.severity}
                </span>
                <span className="text-sm font-medium text-gray-800">{item.businessName}</span>
                <span className="text-sm text-gray-500">
                  {item.starRating}★ from {item.reviewerName}
                </span>
                <span className="ml-auto text-xs text-gray-400">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </div>

              <p className="mt-2 text-xs text-gray-500">
                Reason: <span className="font-medium text-gray-700">{item.reason ?? '—'}</span>{' '}
                · Source: {item.source} · Draft v{item.version}
              </p>

              <p className="mt-3 whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm text-gray-800">
                {item.responseText}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                {(Object.keys(ACTION_LABELS) as DispositionAction[]).map((action) => (
                  <button
                    type="button"
                    key={action}
                    onClick={() => onDispose({ flaggedId: item.id, action })}
                    disabled={disposing}
                    className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {ACTION_LABELS[action]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {footer.show && (
        <div className="mt-6">
          <PaginationFooter
            page={page}
            pageCount={footer.pageCount}
            label={footer.label}
            onPageChange={(nextPage) => onOffsetChange(nextPage * PAGE_SIZE)}
          />
        </div>
      )}
    </>
  );
}

export function FlaggedClient({ initialData }: { initialData: FlaggedData }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const { data, isLoading, isError, refetch } = useQuery<FlaggedData>({
    queryKey: ['admin-flagged', offset],
    queryFn: async () => {
      const res = await fetch(`/api/admin/flagged?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error(`Failed to fetch flagged queue: ${res.status}`);
      return res.json() as Promise<FlaggedData>;
    },
    refetchInterval: 30_000,
    initialData: offset === 0 ? initialData : undefined,
    staleTime: 30_000,
  });

  const disposition = useMutation({
    mutationFn: async (vars: { flaggedId: string; action: DispositionAction }) => {
      const res = await fetch('/api/admin/flagged', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(vars),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Disposition failed: ${res.status}`);
      }
      return res.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-flagged'] });
    },
    onError: (err: unknown) => {
      setActionError(err instanceof Error ? err.message : 'Disposition failed');
    },
  });

  // Page chrome (group/title/description) lives on the server page so it
  // renders in the RSC payload, never behind this client's loading state.
  return (
    <>
      {actionError && (
        <p
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
        >
          {actionError}
        </p>
      )}
      <LiveRegion level="polite" message={disposition.isSuccess ? 'Disposition applied.' : ''} />

      {isLoading && !data ? (
        <TableSkeleton />
      ) : isError && !data ? (
        <ErrorState
          title="Couldn't load flagged queue"
          detail="GET /api/admin/flagged failed"
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <>
          {isError && (
            <div className="mb-4">
              <ErrorState
                title="Last refresh failed"
                detail="GET /api/admin/flagged failed — showing the last loaded data."
                onRetry={() => void refetch()}
              />
            </div>
          )}
          <FlaggedContent
            data={data}
            offset={offset}
            onOffsetChange={setOffset}
            onDispose={(vars) => disposition.mutate(vars)}
            disposing={disposition.isPending}
          />
        </>
      ) : null}
    </>
  );
}
