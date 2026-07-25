'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { useLocationScope } from '@/contexts/LocationContext';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type { BatchView } from '@/lib/solicitation/batch-view';
import { BatchReport } from './BatchReport';
import { GhostPipeline } from './GhostPipeline';
import './requests.css';

/**
 * Client island for /dashboard/requests (#544): reads the latest Solicitation
 * batch for the selected location and renders one screen per outcome.
 *
 * The whole screen is a function of `phase`, and `phase` is keyed by the
 * location scope it was fetched for — a superseded location's response can
 * never be rendered against the location the owner switched to.
 */

const BATCH_PATH = '/api/dashboard/solicitation/batch';
const REVIEWED_PATH = '/api/dashboard/solicitation/batch/reviewed';

/** UploadCard's cadence and ceiling — one owner would be better, but the two
 *  surfaces poll different routes for different reasons, so they are pinned
 *  independently rather than coupled through a shared constant. */
const POLL_INTERVAL_MS = 2_000;
const POLL_CEILING_MS = 5 * 60 * 1_000;

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; view: BatchView }
  /** Polling gave up. `view` is null when even the first read never answered. */
  | { kind: 'stalled'; view: BatchView | null }
  | { kind: 'error' }
  /** 404 — watch-mode was switched off mid-session, so the route is gone. */
  | { kind: 'gone' };

const LOADING: Phase = { kind: 'loading' };

export function RequestsClient() {
  const { currentScope } = useLocationScope();
  const { phase, retry } = useLatestBatch(currentScope);

  const builtBatchId =
    phase.kind === 'ready' && phase.view.state === 'built' ? phase.view.batchId : null;
  useReviewedPing(builtBatchId, currentScope);
  const announcement = useCompletionAnnouncement(phase);

  return (
    <>
      <TopBar
        title="Requests"
        subtitle="What RepWorth would ask for — and everyone it held back, with the reason."
      />
      <div className="content">
        {/* Mounted unconditionally: a live region only announces changes to a
            region already in the DOM, and the building screen it reports on is
            gone by the time there is anything to say. */}
        <LiveRegion message={announcement} />
        {currentScope === 'all' ? <ChooseLocation /> : <Screen phase={phase} onRetry={retry} />}
      </div>
    </>
  );
}

function Screen({ phase, onRetry }: { phase: Phase; onRetry: () => void }) {
  switch (phase.kind) {
    case 'loading':
      return <LoadingCard />;
    case 'error':
      return (
        <FailureCard
          title="Could not load your latest batch"
          body="Something went wrong reading it. Nothing was sent, and nothing changed."
          actionLabel="Try again"
          onAction={onRetry}
        />
      );
    case 'gone':
      return (
        <FailureCard
          title="This screen is no longer available"
          body="Review requests have been switched off for your account. Reload to get back to your dashboard."
          actionLabel="Reload the page"
          onAction={() => window.location.reload()}
        />
      );
    case 'stalled':
      return (
        <GhostPipeline
          mode="building"
          contactsOnFile={phase.view?.contactsOnFile ?? 0}
          stalled
          onCheckAgain={onRetry}
        />
      );
    case 'ready':
      if (phase.view.state === 'built') return <BatchReport view={phase.view} />;
      return (
        <GhostPipeline
          // A built batch with queued 0 is NOT this screen: it asked for
          // nobody, which is a result, not an absence.
          mode={phase.view.state}
          contactsOnFile={phase.view.contactsOnFile}
        />
      );
  }
}

// ── Screens without a batch to show ─────────────────────────────────────────

function ChooseLocation() {
  return (
    <div className="card section-enter section-enter-1">
      <h2 className="card-h2">Choose a location</h2>
      <p className="rq-state-body">
        Review requests are built per location. Pick one from the switcher to see
        its latest batch.
      </p>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="card section-enter section-enter-1 rq-ghost" aria-busy="true">
      <h2 className="card-h2">Loading the latest batch…</h2>
      <div className="rq-skeleton" aria-hidden="true">
        <span className="rq-skeleton-bar rq-skeleton-bar--wide" />
        <span className="rq-skeleton-bar" />
        <span className="rq-skeleton-bar rq-skeleton-bar--short" />
      </div>
    </div>
  );
}

function FailureCard({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="card section-enter section-enter-1" role="alert">
      <h2 className="card-h2">{title}</h2>
      <p className="rq-state-body">{body}</p>
      <button type="button" className="btn btn-secondary rq-action" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}

// ── Fetching and bounded polling ────────────────────────────────────────────

interface ScopedPhase {
  scope: string;
  phase: Phase;
}

/**
 * One poll loop per location scope. Three things the UploadCard precedent does
 * not give for free:
 *
 * 1. The deadline is checked BEFORE the `inFlight` guard — one hung fetch
 *    leaves `inFlight` true forever, so an inFlight-first check means no later
 *    tick ever reaches the ceiling and the bound silently never fires.
 * 2. State is keyed by scope AND the in-flight request is aborted on switch,
 *    so an old location's late answer cannot overwrite the new location.
 * 3. Polling runs only while the batch is `building`. An empty screen does not
 *    poll: a CSV finishing in another tab will not appear until reload, which
 *    is the accepted trade for not polling forever on an idle screen.
 */
function useLatestBatch(currentScope: string): { phase: Phase; retry: () => void } {
  const [state, setState] = useState<ScopedPhase>({ scope: currentScope, phase: LOADING });
  const [attempt, setAttempt] = useState(0);

  // A phase belonging to a superseded scope reads as loading, so no effect is
  // needed to reset it on switch.
  const phase = state.scope === currentScope ? state.phase : LOADING;

  useEffect(() => {
    // The API rejects aggregate scope with a 400, so it is never asked.
    if (currentScope === 'all') return;

    const controller = new AbortController();
    const startedAt = Date.now();
    let stopped = false;
    let inFlight = false;
    let latest: BatchView | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    };

    const poll = async () => {
      if (stopped) return;
      if (Date.now() - startedAt > POLL_CEILING_MS) {
        stop();
        controller.abort();
        setState({ scope: currentScope, phase: { kind: 'stalled', view: latest } });
        return;
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const outcome = await fetchLatestBatch(currentScope, controller.signal);
        if (stopped || outcome === null) return;
        if (outcome.kind === 'auth') {
          // The dashboard's own auth redirect owns this; another error screen
          // would race it and blame the owner for being logged out.
          stop();
          return;
        }
        if (outcome.kind === 'ready') latest = outcome.view;
        if (outcome.kind !== 'ready' || outcome.view.state !== 'building') stop();
        setState({ scope: currentScope, phase: outcome });
      } finally {
        inFlight = false;
      }
    };

    void poll();
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stop();
      controller.abort();
    };
  }, [currentScope, attempt]);

  const retry = useCallback(() => {
    setState({ scope: currentScope, phase: LOADING });
    setAttempt((value) => value + 1);
  }, [currentScope]);

  return { phase, retry };
}

type FetchOutcome =
  | { kind: 'ready'; view: BatchView }
  | { kind: 'error' }
  | { kind: 'gone' }
  | { kind: 'auth' };

/** Returns null only when the request was aborted — the caller then commits
 *  nothing, because the scope it belonged to is no longer on screen. */
async function fetchLatestBatch(
  scope: string,
  signal: AbortSignal,
): Promise<FetchOutcome | null> {
  try {
    const response = await fetch(withSolicitationScope(BATCH_PATH, scope), { signal });
    if (response.status === 404) return { kind: 'gone' };
    if (response.status === 401) return { kind: 'auth' };
    if (!response.ok) {
      console.error(`[requests] batch fetch failed with ${response.status}`);
      return { kind: 'error' };
    }
    return { kind: 'ready', view: (await response.json()) as BatchView };
  } catch (error) {
    if (signal.aborted) return null;
    console.error('[requests] batch fetch could not reach the server', error);
    return { kind: 'error' };
  }
}

// ── Completion announcement ─────────────────────────────────────────────────

/** Announces built-after-building only. A batch that was already built when the
 *  screen opened is not news, and announcing it on every load would train
 *  screen-reader users to ignore the region. */
function useCompletionAnnouncement(phase: Phase): string {
  const wasBuilding = useRef(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (phase.kind !== 'ready') return;
    if (phase.view.state === 'building') {
      wasBuilding.current = true;
      return;
    }
    if (phase.view.state === 'built' && wasBuilding.current) {
      wasBuilding.current = false;
      setMessage('Your batch is ready. Nothing was sent.');
    }
  }, [phase]);

  return message;
}

// ── reviewed_at ping ────────────────────────────────────────────────────────

/**
 * Records that a human opened the spoilage report. Fired from an effect, so it
 * runs when BatchReport has actually rendered — not when the fetch resolved.
 *
 * The guard is keyed by `batchId`, never a boolean: a scalar "already pinged"
 * flag would mark batch A and then suppress batch B after a location switch.
 *
 * A hidden tab does not ping. That is the entire reason this is a POST rather
 * than a side effect of the GET — the signal has to mean somebody looked.
 */
function useReviewedPing(batchId: string | null, scope: string): void {
  const pinged = useRef<string | null>(null);

  useEffect(() => {
    if (batchId === null || pinged.current === batchId) return;

    const send = () => {
      if (pinged.current === batchId) return;
      if (document.visibilityState !== 'visible') return;
      pinged.current = batchId;
      void postReviewed(scope, batchId);
    };

    send();
    if (pinged.current === batchId) return;

    document.addEventListener('visibilitychange', send);
    return () => document.removeEventListener('visibilitychange', send);
  }, [batchId, scope]);
}

/** Failures are reported, never swallowed: "the owner never opened it" and "the
 *  write failed" must not look the same in the engagement numbers. */
async function postReviewed(scope: string, batchId: string): Promise<void> {
  try {
    const response = await fetch(withSolicitationScope(REVIEWED_PATH, scope), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId }),
    });
    if (!response.ok) {
      console.error(`[requests] reviewed ping failed with ${response.status}`);
    }
  } catch (error) {
    console.error('[requests] reviewed ping could not reach the server', error);
  }
}
