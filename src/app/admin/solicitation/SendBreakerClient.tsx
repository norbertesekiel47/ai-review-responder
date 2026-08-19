'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminCount, formatAdminDateTime } from '@/components/admin/ui/format';
import { StatTile } from '@/components/admin/ui/StatTile';
import { LiveRegion } from '@/components/ui/LiveRegion';
import {
  BREAKER_COMPLAINT_RATE,
  BREAKER_HARD_BOUNCE_RATE,
  BREAKER_MIN_SENDS,
  BREAKER_WINDOW_DAYS,
  type BreakerTripReason,
  type BreakerWindow,
} from '@/lib/solicitation/send-breaker';

/**
 * Deliberately NOT imported from `send-breaker.ts`, though that module owns the
 * server-side twin (std-5 / B1.11). It instantiates a worker logger at module
 * scope — `createWorkerLogger` -> `log-context` -> `node:async_hooks` — so
 * importing a FUNCTION from it drags that chain into this client component and
 * Turbopack fails the route build. Proven on #898: exporting the shared helper
 * from there broke `pnpm build`, and reverting to this local copy fixed it.
 *
 * The honest fix is a shared admin formatter in `src/components/admin/ui/`,
 * which needs a surface amendment this branch has not spent; recorded as a
 * follow-up. The real smell it exposes is that the BREAKER_* constants this
 * file already imports live in a module with a top-level logger at all.
 */
const formatRate = (rate: number): string => `${(rate * 100).toFixed(2)}%`;

/** The trip as it arrives over the wire — `trippedAt` is an ISO string. */
interface BreakerTripWire {
  id: string;
  trippedAt: string;
  tripReason: BreakerTripReason;
  metrics: BreakerWindow;
}

interface SendBreakerStateResponse {
  open: boolean;
  trip: BreakerTripWire | null;
}

interface ResetResult {
  reset: boolean;
  tripId: string | null;
}

const QUERY_KEY = ['admin-send-breaker'];


/**
 * The trip reason as prose. The breaker is admin-facing, so the Halt latch's
 * owner-facing "stop" carve-out does not apply: this surface says breaker,
 * tripped and reset, never pause / resume / cancel.
 */
const TRIP_REASON_PROSE: Record<BreakerTripReason, string> = {
  hard_bounce_rate: `Hard bounces exceeded ${formatRate(BREAKER_HARD_BOUNCE_RATE)} of sends over the last ${BREAKER_WINDOW_DAYS} days. Solicitation sending is halted platform-wide.`,
  complaint_rate: `Spam complaints exceeded ${formatRate(BREAKER_COMPLAINT_RATE)} of sends over the last ${BREAKER_WINDOW_DAYS} days. Solicitation sending is halted platform-wide.`,
};

async function fetchBreaker(): Promise<SendBreakerStateResponse> {
  const response = await fetch('/api/admin/solicitation/breaker');
  if (!response.ok) throw new Error(`Failed to load the send breaker: ${response.status}`);
  return response.json() as Promise<SendBreakerStateResponse>;
}

async function requestReset(input: { note: string }): Promise<ResetResult> {
  const response = await fetch('/api/admin/solicitation/breaker/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Only the note travels: the actor is fixed by the session and the route
    // REJECTS a body that names one.
    body: JSON.stringify({ note: input.note }),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<ResetResult> & {
    error?: string;
  };
  if (!response.ok || body.reset !== true) {
    throw new Error(body.error ?? `Reset failed: ${response.status}`);
  }
  return { reset: true, tripId: body.tripId ?? null };
}

function MetricsSnapshot({ metrics }: { metrics: BreakerWindow }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <StatTile
        label={`Sends · last ${BREAKER_WINDOW_DAYS} days`}
        value={formatAdminCount(metrics.sends)}
        sub={`${formatAdminCount(BREAKER_MIN_SENDS)} minimum before any rate is judged`}
      />
      <StatTile
        label="Hard bounce rate"
        value={formatRate(metrics.hardBounceRate)}
        sub={`${formatAdminCount(metrics.hardBounces)} hard bounces · trips above ${formatRate(BREAKER_HARD_BOUNCE_RATE)}`}
        alert={metrics.hardBounceRate > BREAKER_HARD_BOUNCE_RATE}
      />
      <StatTile
        label="Complaint rate"
        value={formatRate(metrics.complaintRate)}
        sub={`${formatAdminCount(metrics.complaints)} complaints · trips above ${formatRate(BREAKER_COMPLAINT_RATE)}`}
        alert={metrics.complaintRate > BREAKER_COMPLAINT_RATE}
      />
    </div>
  );
}

function ResetForm({
  pending,
  onReset,
}: {
  pending: boolean;
  onReset: (input: { note: string }) => void;
}) {
  const [note, setNote] = useState('');
  const trimmedNote = note.trim();

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!trimmedNote) return;
    onReset({ note: trimmedNote });
  }

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-2">
      <label htmlFor="breaker-reset-note" className="text-xs font-semibold text-gray-900">
        Reset note (required)
      </label>
      <p className="text-xs text-gray-500">
        What changed since the trip — the ramp stage you rolled back, the list you
        suppressed. Resetting a still-breached window is allowed and re-trips on the next
        health check, by design.
      </p>
      <textarea
        id="breaker-reset-note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={1_000}
        rows={3}
        required
        className="min-h-20 resize-y rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm outline-none transition focus:border-gray-900 focus:ring-2 focus:ring-gray-900"
      />
      <button
        type="submit"
        disabled={pending || !trimmedNote}
        className="min-h-11 justify-self-start rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? 'Resetting…' : 'Reset breaker'}
      </button>
    </form>
  );
}

function TripPanel({
  trip,
  pending,
  onReset,
}: {
  trip: BreakerTripWire;
  pending: boolean;
  onReset: (input: { note: string }) => void;
}) {
  return (
    <div className="grid gap-5 rounded-md border border-red-300 bg-white p-5">
      <div>
        <span className="inline-flex rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-800">
          Tripped
        </span>
        <p className="mt-2 text-sm leading-6 text-gray-800">{TRIP_REASON_PROSE[trip.tripReason]}</p>
        <p className="mt-2 text-xs text-gray-500">
          Tripped {formatAdminDateTime(trip.trippedAt)}
        </p>
      </div>
      <MetricsSnapshot metrics={trip.metrics} />
      <ResetForm pending={pending} onReset={onReset} />
    </div>
  );
}

function QueryResult({
  data,
  loading,
  failed,
  onRetry,
  pending,
  onReset,
}: {
  data: SendBreakerStateResponse | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  pending: boolean;
  onReset: (input: { note: string }) => void;
}) {
  // Non-blanking error pattern (matches Autonomy/Jobs/Overview): a full-screen
  // ErrorState only when there is no cached data yet; a failed background
  // refetch keeps the panel on screen with an inline notice instead.
  if (loading && !data) return <TableSkeleton rows={3} />;
  if (failed && !data) {
    return (
      <ErrorState
        title="Couldn't load the send breaker"
        detail="GET /api/admin/solicitation/breaker failed"
        onRetry={onRetry}
      />
    );
  }
  if (!data) return null;

  return (
    <>
      {failed && (
        <div className="mb-4">
          <ErrorState
            title="Last refresh failed"
            detail="GET /api/admin/solicitation/breaker failed — showing the last loaded data."
            onRetry={onRetry}
          />
        </div>
      )}
      {/* No open trip means there is nothing to reset, so no reset control is
          rendered — the control exists only where it has an effect. */}
      {data.trip === null ? (
        <EmptyState
          title="Breaker not tripped"
          detail="Solicitation sending is running. The health check re-measures the last 7 days on every tick."
        />
      ) : (
        <TripPanel trip={data.trip} pending={pending} onReset={onReset} />
      )}
    </>
  );
}

export function SendBreakerClient({
  initialData,
}: {
  initialData?: SendBreakerStateResponse;
}) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const [actionError, setActionError] = useState('');
  const query = useQuery<SendBreakerStateResponse>({
    queryKey: QUERY_KEY,
    queryFn: fetchBreaker,
    refetchInterval: 30_000,
    staleTime: 30_000,
    initialData,
  });
  const reset = useMutation({
    mutationFn: requestReset,
    onSuccess: () => {
      setActionError('');
      setOutcome('Breaker reset. Solicitation sending is no longer halted; the next health check re-measures the window.');
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: unknown) => {
      setOutcome('');
      setActionError(error instanceof Error ? error.message : 'Reset failed.');
    },
  });

  return (
    <section aria-label="Solicitation send breaker">
      <LiveRegion message={outcome} />
      {outcome && (
        <p className="mb-4 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
          {outcome}
        </p>
      )}
      {actionError && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
        >
          {actionError}
        </p>
      )}
      <QueryResult
        data={query.data}
        loading={query.isLoading}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        pending={reset.isPending}
        onReset={(input) => reset.mutate(input)}
      />
    </section>
  );
}
