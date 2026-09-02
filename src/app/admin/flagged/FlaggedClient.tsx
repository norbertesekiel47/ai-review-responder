'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminFlaggedData } from '@/lib/admin/flagged-service';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { PaginationFooter, serverPaginationFooterState } from '@/components/admin/ui/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminDateTime } from '@/components/admin/ui/format';
import { LastUpdated } from '@/components/admin/ui/LastUpdated';
import { FLAGGED_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

type FlaggedData = AdminFlaggedData & { limit: number; offset: number };
type FlaggedItem = FlaggedData['flagged'][number];

type DispositionAction =
  | 'approved_for_owner_review'
  | 'dismissed_false_positive'
  | 'requires_regeneration';

interface DispositionSpec {
  /** The first-step button. */
  label: string;
  /** The confirm-step button — names the act, not "OK". */
  confirmLabel: string;
  /** What happens to the draft and the owner. Shown before the confirm button. */
  consequence: string;
  /**
   * Approve is the one disposition that reaches a customer, so it alone takes
   * a one-line reason before the confirm button enables. The route does not
   * yet carry the reason (its body schema is `{flaggedId, action}` and its audit
   * payload `{action, response_id}`), so the field is a deliberate-action gate
   * on the client, not a recorded note. Wire it through when the route grows a
   * `note` field — do not send it silently into a schema that strips it.
   */
  requiresReason: boolean;
  /** The card's status line once the action is in flight or done. */
  actedCopy: string;
}

const DISPOSITIONS: Record<DispositionAction, DispositionSpec> = {
  approved_for_owner_review: {
    label: 'Approve',
    confirmLabel: 'Approve and notify owner',
    consequence:
      'Sends the owner a notification with this draft, exactly as written. It leaves the safety hold and lands in their approval queue.',
    requiresReason: true,
    actedCopy: 'Approved — notifying the owner.',
  },
  dismissed_false_positive: {
    label: 'Dismiss as false positive',
    confirmLabel: 'Dismiss flag',
    consequence: 'Closes this flag without releasing the draft. The owner is not notified.',
    requiresReason: false,
    actedCopy: 'Dismissed — flag closed.',
  },
  requires_regeneration: {
    label: 'Regenerate',
    confirmLabel: 'Discard and regenerate',
    consequence:
      'Discards this draft and generates a new one. The owner hears nothing until the new draft passes review.',
    requiresReason: false,
    actedCopy: 'Regenerating — this draft is discarded.',
  },
};

const DISPOSITION_ORDER: readonly DispositionAction[] = [
  'approved_for_owner_review',
  'dismissed_false_positive',
  'requires_regeneration',
];

const PRIMARY_BUTTON =
  'rounded-md bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_BUTTON =
  'rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50';

/** Per-card outcome of the last disposition attempt. */
type CardOutcome =
  | { kind: 'acted'; action: DispositionAction }
  | { kind: 'failed'; error: string };

function FlaggedCard({
  item,
  outcome,
  onDispose,
}: {
  item: FlaggedItem;
  outcome: CardOutcome | undefined;
  onDispose: (action: DispositionAction) => void;
}) {
  const [armed, setArmed] = useState<DispositionAction | null>(null);
  const [reason, setReason] = useState('');

  const acted = outcome?.kind === 'acted' ? DISPOSITIONS[outcome.action] : null;
  const armedSpec = armed ? DISPOSITIONS[armed] : null;
  const reasonMissing = Boolean(armedSpec?.requiresReason) && reason.trim().length === 0;
  const reasonId = `flag-${item.id}-reason`;

  function disarm() {
    setArmed(null);
    setReason('');
  }

  function confirmDisposition() {
    if (!armed || reasonMissing) return;
    onDispose(armed);
    disarm();
  }

  return (
    <div
      className={`rounded-lg border border-gray-200 bg-white p-5 ${acted ? 'opacity-70' : ''}`}
      aria-busy={acted ? true : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold ${
            item.severity === 'high' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'
          }`}
        >
          {item.severity}
        </span>
        <span className="text-sm font-medium text-gray-800">{item.businessName}</span>
        <span className="text-sm text-gray-500">
          {item.starRating}★ from {item.reviewerName}
        </span>
        <span className="ml-auto text-xs text-gray-400">{formatAdminDateTime(item.createdAt)}</span>
      </div>

      <p className="mt-2 text-xs text-gray-500">
        Reason: <span className="font-medium text-gray-700">{item.reason ?? '—'}</span> · Source:{' '}
        {item.source} · Draft v{item.version}
      </p>

      <p className="mt-3 whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm text-gray-800">
        {item.responseText}
      </p>

      {acted ? (
        // Optimistic: the card is marked the instant the request leaves, and
        // disappears on the next successful refetch (the route closes the flag,
        // so it no longer lists as open). Without this the operator sees no
        // change until the 30 s poll and cannot tell which card they acted on.
        <p className="mt-4 text-sm font-medium text-green-800">{acted.actedCopy}</p>
      ) : armed && armedSpec ? (
        <div className="mt-4 rounded-md border border-gray-300 bg-gray-50 p-3">
          <p className="text-sm text-gray-800">{armedSpec.consequence}</p>
          {armedSpec.requiresReason && (
            <label htmlFor={reasonId} className="mt-3 block text-sm font-medium text-gray-700">
              Reason (one line, required)
              <input
                id={reasonId}
                type="text"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={200}
                autoFocus
                required
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              />
            </label>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={confirmDisposition} disabled={reasonMissing} className={PRIMARY_BUTTON}>
              {armedSpec.confirmLabel}
            </button>
            <button type="button" onClick={disarm} className={SECONDARY_BUTTON}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {DISPOSITION_ORDER.map((action) => (
            <button
              type="button"
              key={action}
              onClick={() => setArmed(action)}
              // Approve is the one that reaches a customer — it reads as the
              // primary act; the two that keep the draft held stay secondary.
              className={action === 'approved_for_owner_review' ? PRIMARY_BUTTON : SECONDARY_BUTTON}
            >
              {DISPOSITIONS[action].label}
            </button>
          ))}
        </div>
      )}

      {outcome?.kind === 'failed' && (
        <p
          role="alert"
          className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {outcome.error}
        </p>
      )}
    </div>
  );
}

function FlaggedContent({
  data,
  offset,
  onOffsetChange,
  onDispose,
  outcomes,
}: {
  data: FlaggedData;
  offset: number;
  onOffsetChange: (offset: number) => void;
  onDispose: (vars: { flaggedId: string; action: DispositionAction }) => void;
  outcomes: Record<string, CardOutcome>;
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
            <FlaggedCard
              key={item.id}
              item={item}
              outcome={outcomes[item.id]}
              onDispose={(action) => onDispose({ flaggedId: item.id, action })}
            />
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
  const [offset, setOffset] = useState(0);
  // Keyed by flag id so one in-flight disposition touches ONE card: the acted
  // card is marked, its neighbours stay fully interactive.
  const [outcomes, setOutcomes] = useState<Record<string, CardOutcome>>({});
  const [announcement, setAnnouncement] = useState('');

  const { data, isLoading, isError, refetch, dataUpdatedAt, isFetching } = useQuery<FlaggedData>({
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
    onMutate: ({ flaggedId, action }) => {
      setOutcomes((current) => ({ ...current, [flaggedId]: { kind: 'acted', action } }));
      setAnnouncement(DISPOSITIONS[action].actedCopy);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-flagged'] });
    },
    onError: (err: unknown, { flaggedId }) => {
      // Roll the optimistic mark back on the one card it belonged to; the
      // failure reads there, beside the buttons that are live again.
      const error = err instanceof Error ? err.message : 'Disposition failed';
      setOutcomes((current) => ({ ...current, [flaggedId]: { kind: 'failed', error } }));
      setAnnouncement('');
    },
  });

  // Page chrome (group/title/description) lives on the server page so it
  // renders in the RSC payload, never behind this client's loading state.
  return (
    <>
      <LastUpdated
        updatedAt={dataUpdatedAt}
        refreshing={isFetching}
        onRefresh={() => void refetch()}
      />
      <LiveRegion level="polite" message={announcement} />

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
            outcomes={outcomes}
          />
        </>
      ) : null}
    </>
  );
}
