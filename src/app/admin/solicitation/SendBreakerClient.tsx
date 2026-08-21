'use client';

import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminCount, formatAdminDateTime } from '@/components/admin/ui/format';
import { StatTile } from '@/components/admin/ui/StatTile';
import { LiveRegion } from '@/components/ui/LiveRegion';
// TYPE-ONLY, and that is load-bearing rather than incidental. `send-breaker.ts`
// instantiates a worker logger at module scope — `createWorkerLogger` ->
// `log-context` -> `node:async_hooks` — so a single RUNTIME import from it
// drags that chain into this client chunk and Turbopack fails the route build
// ("the chunking context (unknown) does not support external modules"). Type
// imports are erased, so they cost nothing. Every runtime fact this panel needs
// arrives as a prop from `page.tsx`, which is a server component and may read
// that module freely.
import type { BreakerTripReason, BreakerWindow } from '@/lib/solicitation/send-breaker';

/**
 * Deliberately NOT imported from `send-breaker.ts`, though that module owns the
 * server-side twin (std-5 / B1.11) — for exactly the reason above: importing a
 * FUNCTION from there is the runtime edge that breaks the build. Proven on
 * #898: exporting the shared helper from there broke `pnpm build`, and
 * reverting to this local copy fixed it.
 *
 * The honest fix is a shared admin formatter in `src/components/admin/ui/`,
 * which needs a surface amendment this branch has not spent; recorded as a
 * follow-up.
 */
const formatRate = (rate: number): string => `${(rate * 100).toFixed(2)}%`;

/**
 * The breaker's enforcement thresholds, handed down from the server component.
 *
 * They are NOT re-declared here. `send-breaker.ts` remains the single owner of
 * the four numbers — `page.tsx` reads the BREAKER_* constants from it and
 * passes them in — so the panel can only ever display the threshold the send
 * path actually enforces. A local copy would let the screen and the governor
 * disagree, which is worse than not showing a number at all.
 */
export interface BreakerThresholds {
  windowDays: number;
  minSends: number;
  hardBounceRate: number;
  complaintRate: number;
}

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
 *
 * A function of the passed thresholds rather than a module-scope map, because
 * the numbers are now props: the `Record` is still built exhaustively, so a
 * third BreakerTripReason remains a type error here rather than an undefined
 * paragraph on the screen.
 */
function tripReasonProse(reason: BreakerTripReason, thresholds: BreakerThresholds): string {
  const tail = `of sends over the last ${thresholds.windowDays} days. Solicitation sending is halted platform-wide.`;
  const prose: Record<BreakerTripReason, string> = {
    hard_bounce_rate: `Hard bounces exceeded ${formatRate(thresholds.hardBounceRate)} ${tail}`,
    complaint_rate: `Spam complaints exceeded ${formatRate(thresholds.complaintRate)} ${tail}`,
  };
  return prose[reason];
}

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

function MetricsSnapshot({
  metrics,
  thresholds,
}: {
  metrics: BreakerWindow;
  thresholds: BreakerThresholds;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <StatTile
        label={`Sends · last ${thresholds.windowDays} days`}
        value={formatAdminCount(metrics.sends)}
        sub={`${formatAdminCount(thresholds.minSends)} minimum before any rate is judged`}
      />
      <StatTile
        label="Hard bounce rate"
        value={formatRate(metrics.hardBounceRate)}
        sub={`${formatAdminCount(metrics.hardBounces)} hard bounces · trips above ${formatRate(thresholds.hardBounceRate)}`}
        alert={metrics.hardBounceRate > thresholds.hardBounceRate}
      />
      <StatTile
        label="Complaint rate"
        value={formatRate(metrics.complaintRate)}
        sub={`${formatAdminCount(metrics.complaints)} complaints · trips above ${formatRate(thresholds.complaintRate)}`}
        alert={metrics.complaintRate > thresholds.complaintRate}
      />
    </div>
  );
}

function ResetForm({
  thresholds,
  pending,
  onReset,
}: {
  thresholds: BreakerThresholds;
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
        suppressed.
      </p>
      {/* This copy is load-bearing, not decoration: an operator who believes a
          reset is futile will not press it during a platform-wide halt, and an
          operator who believes it is a free look will use it to "check" the
          breach and instead zero the measurement. Both errors are closed here.
          The runbook's long form is §8.4 of solicitation-sending-domain.md. */}
      <p className="text-xs text-gray-500">
        Resetting is a real recovery. The measured window&rsquo;s lower edge moves to the
        moment you reset, so only sending from that point on is counted, and the breaker
        stays quiet until {formatAdminCount(thresholds.minSends)} fresh sends accumulate —
        a bounded half-open probe, not a blind re-arm. Roll the platform daily cap down
        first so those sends go out at reduced volume. Bounces for earlier sends that land
        after the reset fall outside the new window and are not counted.
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
  thresholds,
  pending,
  onReset,
}: {
  trip: BreakerTripWire;
  thresholds: BreakerThresholds;
  pending: boolean;
  onReset: (input: { note: string }) => void;
}) {
  return (
    <div className="grid gap-5 rounded-md border border-red-300 bg-white p-5">
      <div>
        <span className="inline-flex rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-800">
          Tripped
        </span>
        <p className="mt-2 text-sm leading-6 text-gray-800">
          {tripReasonProse(trip.tripReason, thresholds)}
        </p>
        <p className="mt-2 text-xs text-gray-500">
          Tripped {formatAdminDateTime(trip.trippedAt)}
        </p>
      </div>
      <MetricsSnapshot metrics={trip.metrics} thresholds={thresholds} />
      <ResetForm thresholds={thresholds} pending={pending} onReset={onReset} />
    </div>
  );
}

function QueryResult({
  data,
  thresholds,
  loading,
  failed,
  onRetry,
  pending,
  onReset,
}: {
  data: SendBreakerStateResponse | undefined;
  thresholds: BreakerThresholds;
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
          detail={`Solicitation sending is running. The health check re-measures the last ${thresholds.windowDays} days on every tick.`}
        />
      ) : (
        <TripPanel
          trip={data.trip}
          thresholds={thresholds}
          pending={pending}
          onReset={onReset}
        />
      )}
    </>
  );
}

export function SendBreakerClient({
  initialData,
  thresholds,
}: {
  initialData?: SendBreakerStateResponse;
  /**
   * Required, unlike `initialData`. The seed is optional because a failed
   * server read legitimately hands the fetch to the client; the thresholds are
   * constants and have no failure mode, so a missing-thresholds fallback would
   * only be a second place for the numbers to live.
   */
  thresholds: BreakerThresholds;
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
        thresholds={thresholds}
        loading={query.isLoading}
        failed={query.isError}
        onRetry={() => void query.refetch()}
        pending={reset.isPending}
        onReset={(input) => reset.mutate(input)}
      />
    </section>
  );
}
