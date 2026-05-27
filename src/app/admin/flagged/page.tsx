'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface FlaggedItem {
  id: string;
  responseId: string;
  businessId: string;
  accountId: string;
  reviewId: string;
  source: string;
  reason: string | null;
  severity: string;
  status: string;
  createdAt: string;
  responseText: string;
  version: number;
  reviewerName: string;
  starRating: number;
  businessName: string;
}

type DispositionAction =
  | 'approved_for_owner_review'
  | 'dismissed_false_positive'
  | 'requires_regeneration';

const ACTION_LABELS: Record<DispositionAction, string> = {
  approved_for_owner_review: 'Approve (notify owner)',
  dismissed_false_positive: 'Dismiss (false positive)',
  requires_regeneration: 'Needs regeneration',
};

export default function FlaggedQueuePage() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery<{ flagged: FlaggedItem[] }>({
    queryKey: ['admin-flagged'],
    queryFn: async () => {
      const res = await fetch('/api/admin/flagged?limit=50&offset=0');
      if (!res.ok) throw new Error(`Failed to fetch flagged queue: ${res.status}`);
      return res.json() as Promise<{ flagged: FlaggedItem[] }>;
    },
    refetchInterval: 30_000,
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

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900">Flagged Responses</h1>
        <p className="mt-1 text-sm text-gray-500">
          High-confidence unsafe drafts held out of the owner approval path. Approve to release
          to the owner, dismiss a false positive, or mark for regeneration.
        </p>

        {actionError && (
          <p className="mt-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {actionError}
          </p>
        )}

        {isLoading && <p className="mt-6 text-gray-500">Loading...</p>}
        {isError && <p className="mt-6 text-red-600">Failed to load flagged queue.</p>}

        {data && data.flagged.length === 0 && (
          <p className="mt-6 rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-gray-400">
            No open flagged responses.
          </p>
        )}

        <div className="mt-6 space-y-4">
          {data?.flagged.map((item) => (
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
                    key={action}
                    onClick={() => disposition.mutate({ flaggedId: item.id, action })}
                    disabled={disposition.isPending}
                    className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {ACTION_LABELS[action]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
