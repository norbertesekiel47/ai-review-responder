'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { useToast } from '@/components/dashboard/shell/toast/ToastProvider';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { useLocationScope } from '@/contexts/LocationContext';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type { BatchView } from '@/lib/solicitation/batch-view';
import type { AttributedReviewView } from '@/lib/solicitation/attribution';
import { ApprovalPanel } from './ApprovalPanel';
import type { LaneRefresh, LaneWriteOutcome } from './lane-writes';
import { AttributedReviews, type AttributedReviewsView } from './AttributedReviews';
import { BatchReport } from './BatchReport';
import { GhostPipeline } from './GhostPipeline';
import { RequestsTabs } from './RequestsTabs';
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
/** Its OWN route, deliberately not folded into BATCH_PATH: that GET is polled
 *  every 2s while a batch builds, and attribution spans batches. */
const ATTRIBUTED_PATH = '/api/dashboard/solicitation/attributed';

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
  /**
   * 404. Deliberately one state for two causes: watch-mode was switched off
   * mid-session, OR the selected location no longer resolves (archived, or a
   * stale `rw_location_scope` cookie — `resolveDashboardLocation`'s
   * uniform-not-found). The two MUST stay indistinguishable (invariant #13: the
   * surface does not exist when the flag is off), so the copy names neither.
   */
  | { kind: 'unavailable' };

const LOADING: Phase = { kind: 'loading' };

/**
 * The two ways this screen may be re-read, and the ONLY difference between them
 * is whether the current screen is torn down first.
 *
 * `replace` shows `<LoadingCard/>` while the read is in flight, which unmounts
 * whatever was rendered — correct for a write that ended the screen anyway
 * (approve, stop) and for the failure cards' own retry. `in_place` leaves the
 * rendered phase alone and swaps the view in when it lands, which is the only
 * form a REGENERATION may take: `ApprovalPanel` holds the owner's exclusion set
 * and its pending-regeneration marker in component state, and a remount resets
 * both — silently re-selecting every ask the owner deselected.
 *
 * `LaneRefresh`'s third member, `none`, never reaches here: it means the panel
 * is reporting on a view the loop has already delivered.
 */
type RefetchMode = Exclude<LaneRefresh, 'none'>;

/**
 * The last thing the approval lane had to say, and which location it was said
 * about. Scope-keyed for the same reason the phase is: an approval that lands
 * after the owner switched location must not be announced against the location
 * they switched to (edge case 13).
 */
interface LaneSentence {
  scope: string;
  /** '' when there is nothing to say. */
  message: string;
  outcome: LaneWriteOutcome;
}

function noLaneSentence(scope: string): LaneSentence {
  return { scope, message: '', outcome: 'settled' };
}

/**
 * Everything this screen says out loud, resolved in ONE place from the loop's
 * announcement and the lane's last sentence.
 *
 * It is a component rather than two derivations in `RequestsClient` because the
 * choice between the three is a single decision, and it belongs beside the lane
 * vocabulary it reads. It renders a fragment at a fixed position, so
 * `LiveRegion` occupies exactly the slot it did inline and is never remounted.
 */
function LaneAnnouncements({
  lane,
  scope,
  announcement,
}: {
  lane: LaneSentence;
  scope: string;
  announcement: string;
}) {
  // Keyed by scope exactly like the loop's own announcement (`superseded` in
  // useLatestBatch): a sentence about the location the owner just left is never
  // said against the one they switched to, including when the write that
  // produced it was still in flight at the switch.
  const sentence = lane.scope === scope ? lane.message : '';
  const unsure = sentence !== '' && lane.outcome === 'unconfirmed';

  return (
    <>
      {/* Mounted unconditionally: a live region only announces changes to a
          region already in the DOM, and the building screen it reports on is
          gone by the time there is anything to say.

          The loop's announcement outranks the lane sentence, and the lane
          sentence is cleared by every refetch that does not carry a new one,
          so neither can mask the other for good. The unsure banner below is
          already a role="alert" and speaks for itself, so it is withheld here
          rather than announced twice. */}
      <LiveRegion message={announcement !== '' ? announcement : unsure ? '' : sentence} />
      {unsure && (
        <p className="rq-lane-unsure" role="alert">
          {sentence}
        </p>
      )}
    </>
  );
}

/**
 * Whether the batch on screen is a SEND-lane batch — `sendLane === null` IS how
 * the browser learns SOLICITATION_SEND_ENABLED is off (invariant #13), so every
 * watch-mode sentence on this screen keys on it (UX audit D6). Null while the
 * phase has no built batch to read it from.
 */
function sendLaneLive(phase: Phase): boolean | null {
  const view =
    phase.kind === 'ready' || phase.kind === 'stalled' ? phase.view : null;
  if (view === null || view.state !== 'built') return null;
  return view.sendLane !== null;
}

const WATCH_SUBTITLE =
  'What RepWorth would ask for, and everyone it held back, with the reason.';
const SEND_SUBTITLE =
  'Who RepWorth is asking for a review, and everyone it held back, with the reason.';

export function RequestsClient() {
  const { currentScope } = useLocationScope();
  const { phase, announcement, refetch } = useLatestBatch(currentScope);
  const attributed = useAttributedReviews(currentScope);
  const [lane, setLane] = useState<LaneSentence>(() => noLaneSentence(currentScope));
  const { toast } = useToast();

  useReviewedPing(phase, currentScope);

  /**
   * The approval panel writes, then hands the refetch straight back — the fetch
   * loop stays the single owner of `phase`, so the panel never has to reconcile
   * a view it just changed.
   *
   * WHICH refetch is the panel's to say, not this handler's: a terminal verb
   * ends the screen and may replace it, a regeneration returns to the very
   * panel the owner is working in and may not. `none` is a report about the
   * view already on screen, so it announces and reads nothing.
   *
   * An `unconfirmed` write is announced AND shown: the panel that would have
   * carried the message may be about to be replaced by the refetch, and this is
   * the one outcome where the owner has to be told something the new screen
   * cannot say by itself.
   */
  const onLaneChanged = useCallback(
    (message: string, outcome: LaneWriteOutcome, refresh: LaneRefresh) => {
      setLane({ scope: currentScope, message, outcome });
      // A settled sentence is confirmation of work the owner just did, and the
      // live region alone gave sighted owners none (UX audit D24). The toast is
      // IN ADDITION to the region, never instead of it; the unconfirmed
      // outcome keeps its own role="alert" banner and is not toasted, because a
      // toast auto-dismisses and that sentence must not.
      if (outcome === 'settled' && message !== '') {
        toast({ tone: refresh === 'none' ? 'info' : 'success', title: message });
      }
      if (refresh !== 'none') refetch(refresh);
    },
    [currentScope, refetch, toast],
  );

  /** Every other refetch clears the lane sentence. Without this, a sentence
   *  about a write that has since been superseded gets re-announced the moment
   *  something else clears the loop's announcement. */
  const reload = useCallback(
    (mode: RefetchMode) => {
      setLane(noLaneSentence(currentScope));
      refetch(mode);
    },
    [currentScope, refetch],
  );

  return (
    <>
      <TopBar
        title="Requests"
        subtitle={sendLaneLive(phase) === true ? SEND_SUBTITLE : WATCH_SUBTITLE}
      />
      {/* The upload surface has to be reachable from every state of this
          screen, not only the empty-state CTA — the screen an owner sits on
          right after uploading is `building`, which has no other path to it.
          A routed tab bar rather than a header link (D28): the two are
          siblings, and Contacts renders the same bar so it has a way back. */}
      <RequestsTabs active="requests" />
      {/* rq-surface scopes this route's reduced-motion opt-out to every card it
          renders, including the ones outside .rq-stack. */}
      <div className="content rq-surface">
        <LaneAnnouncements lane={lane} scope={currentScope} announcement={announcement} />
        {currentScope === 'all' ? (
          <ChooseLocation />
        ) : (
          <>
            <Screen
              phase={phase}
              scope={currentScope}
              onReload={reload}
              onLaneChanged={onLaneChanged}
            />
            {/* BELOW the batch screen and OUTSIDE it: attribution spans
                batches, so the section is a function of the location alone and
                renders in every batch-build state — including the states that
                have no batch at all. Putting it inside `Screen` would tie an
                across-batches list to whichever batch happens to be latest. */}
            <AttributedReviews view={attributed} />
          </>
        )}
      </div>
    </>
  );
}

function Screen({
  phase,
  scope,
  onReload,
  onLaneChanged,
}: {
  phase: Phase;
  scope: string;
  onReload: (mode: RefetchMode) => void;
  onLaneChanged: (
    message: string,
    outcome: LaneWriteOutcome,
    refresh: LaneRefresh,
  ) => void;
}) {
  switch (phase.kind) {
    case 'loading':
      return <LoadingCard />;
    case 'error':
      return (
        <FailureCard
          title="Could not load your latest batch"
          // READ-SCOPED on purpose. This card may claim only what a failed READ
          // can honestly support. It used to add "Nothing was sent, and nothing
          // changed" — a write-scoped promise a read failure cannot make, and
          // the very claim the unconfirmed-write path was changed to stop
          // making. The owner most likely to see this is the one whose approve
          // POST came back unreadable and whose refetch then failed too: the
          // one person for whom "nothing changed" is most likely to be false.
          body="We could not read the latest state of this batch. That does not tell you whether anything changed. Try again."
          actionLabel="Try again"
          onAction={() => onReload('replace')}
        />
      );
    case 'unavailable':
      // Cause-neutral on purpose: a 404 here means the flag is off OR the
      // selected location no longer resolves, and naming either one would both
      // be wrong half the time and leak flag state.
      return (
        <FailureCard
          title="This page isn't available right now"
          body="We could not open Requests for the location you have selected. Reload to get back to your dashboard."
          actionLabel="Reload the page"
          onAction={() => window.location.reload()}
        />
      );
    case 'stalled':
      // A BUILT batch is not building, and the ghost says it is. #860 widened
      // the poll predicate to keep reading a built batch while a regeneration
      // is in flight, which made this arm reachable for a batch that is built
      // and approvable — and the ghost would then replace the approval panel
      // and every rendered message the owner was reading, and take the approve
      // control away. So a built batch keeps its own screen here and gains the
      // check-again affordance instead of being replaced by one.
      if (phase.view !== null && phase.view.state === 'built') {
        return (
          <BuiltBatch
            view={phase.view}
            scope={scope}
            onLaneChanged={onLaneChanged}
            onCheckAgain={() => onReload('in_place')}
          />
        );
      }
      return (
        <GhostPipeline
          mode="building"
          contactsOnFile={phase.view?.contactsOnFile ?? 0}
          stalled
          onCheckAgain={() => onReload('replace')}
        />
      );
    case 'ready': {
      const { view } = phase;
      if (view.state === 'built') {
        return <BuiltBatch view={view} scope={scope} onLaneChanged={onLaneChanged} />;
      }
      return (
        <GhostPipeline
          // A built batch with queued 0 is NOT this screen: it asked for
          // nobody, which is a result, not an absence.
          mode={view.state}
          contactsOnFile={view.contactsOnFile}
        />
      );
    }
  }
}

/** What polling gave up on is never the BUILD here — a built batch is built —
 *  so this says only what is true of every way this arm is reached, and offers
 *  the same recourse the ghost's stalled arm does. "Nothing has been sent" is
 *  a watch-mode fact (D6): with a live send lane the batch may be mid-send, so
 *  that arm claims only what a stale read can support. */
const STALLED_BUILT_NOTE_WATCH =
  'We stopped checking for updates after a few minutes. Nothing has been sent. This is the batch as we last read it.';
const STALLED_BUILT_NOTE_SEND =
  'We stopped checking for updates after a few minutes. This is the batch as we last read it, so check again for the latest.';

/**
 * The built batch, rendered from ONE place so the `ready` and `stalled` arms
 * return the same component at the same position. That is not tidiness: React
 * keeps `ApprovalPanel` mounted across the transition between them only while
 * the element type at that slot does not change, and the panel holds the
 * owner's exclusion set. The stalled note is a slot INSIDE this component for
 * the same reason — a sibling added above would shift the panel by one child
 * and remount it.
 */
function BuiltBatch({
  view,
  scope,
  onLaneChanged,
  onCheckAgain,
}: {
  view: Extract<BatchView, { state: 'built' }>;
  scope: string;
  onLaneChanged: (
    message: string,
    outcome: LaneWriteOutcome,
    refresh: LaneRefresh,
  ) => void;
  /** Present only on the stalled arm — polling stopped, so the owner needs a
   *  way to ask again without losing the panel they are working in. */
  onCheckAgain?: () => void;
}) {
  return (
    <>
      {onCheckAgain !== undefined && (
        <div className="card section-enter section-enter-1 rq-stalled-note">
          <p className="rq-state-body">
            {view.sendLane === null ? STALLED_BUILT_NOTE_WATCH : STALLED_BUILT_NOTE_SEND}
          </p>
          <button
            type="button"
            className="btn btn-secondary rq-action"
            onClick={onCheckAgain}
          >
            Check again
          </button>
        </div>
      )}
      {/* `sendLane === null` IS how the browser learns
          SOLICITATION_SEND_ENABLED is off (invariant #13) — there is no
          NEXT_PUBLIC companion, so the absence of the lane is the flag. */}
      {view.sendLane !== null && (
        <ApprovalPanel
          batchId={view.batchId}
          sendLane={view.sendLane}
          attempts={view.attempts}
          scope={scope}
          onChanged={onLaneChanged}
        />
      )}
      <BatchReport view={view} />
    </>
  );
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

/**
 * Announced only for a batch that finished WHILE the owner was watching. A batch
 * that was already built when the screen opened is not news, and announcing it
 * on every load would train screen-reader users to ignore the region.
 */
const COMPLETION_ANNOUNCEMENT = 'Your batch is ready. Nothing was sent.';

interface ScopedPhase {
  scope: string;
  phase: Phase;
  /** Empty except on the poll tick that observed building → built. */
  announcement: string;
}

/**
 * One poll loop per location scope. Four things the UploadCard precedent does
 * not give for free:
 *
 * 1. The deadline is checked BEFORE the `inFlight` guard — one hung fetch
 *    leaves `inFlight` true forever, so an inFlight-first check means no later
 *    tick ever reaches the ceiling and the bound silently never fires.
 * 2. State is keyed by scope AND the in-flight request is aborted on switch,
 *    so an old location's late answer cannot overwrite the new location.
 * 3. Polling runs while the batch is `building`, and — since #860 — while a
 *    built batch has a per-ask regeneration in flight, so the new copy appears
 *    without a reload. Same bounded ceiling and the same abort-on-scope-switch;
 *    only the predicate is wider. An empty screen still does not poll: a CSV
 *    finishing in another tab will not appear until reload, which is the
 *    accepted trade for not polling forever on an idle screen.
 * 4. The completion announcement is produced HERE, by the loop that actually
 *    observes the transition, and carried on the same state as the phase. A
 *    separate mirror hook could not re-announce: a live region only announces a
 *    CHANGE, so setting the identical string on a second building → built (via
 *    the location switcher) is a React bail-out and says nothing. Carrying it on
 *    the phase means every non-transition tick clears it, and `wasBuilding` is a
 *    per-run local rather than a ref — so it cannot leak across a scope switch
 *    and announce another location's batch as if it had just finished.
 */
function useLatestBatch(currentScope: string): {
  phase: Phase;
  announcement: string;
  refetch: (mode: RefetchMode) => void;
} {
  const [state, setState] = useState<ScopedPhase>({
    scope: currentScope,
    phase: LOADING,
    announcement: '',
  });
  const [attempt, setAttempt] = useState(0);

  // A phase belonging to a superseded scope reads as loading, so no effect is
  // needed to reset it on switch. The announcement is keyed the same way.
  const superseded = state.scope !== currentScope;
  const phase = superseded ? LOADING : state.phase;
  const announcement = superseded ? '' : state.announcement;

  useEffect(() => {
    // The API rejects aggregate scope with a 400, so it is never asked.
    if (currentScope === 'all') return;

    const controller = new AbortController();
    const startedAt = Date.now();
    let stopped = false;
    let inFlight = false;
    let latest: BatchView | null = null;
    let wasBuilding = false;
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
        setState({
          scope: currentScope,
          phase: { kind: 'stalled', view: latest },
          announcement: '',
        });
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
        const building = outcome.kind === 'ready' && outcome.view.state === 'building';
        const justBuilt =
          wasBuilding && outcome.kind === 'ready' && outcome.view.state === 'built';
        wasBuilding = building;

        // #860: a built batch keeps polling while a regeneration is in flight.
        // Spelled with an explicit `sendLane !== null` rather than `?.` — a
        // null lane (SOLICITATION_SEND_ENABLED off, invariant #13) would
        // otherwise read as `undefined !== null` and poll to the ceiling on
        // every built batch.
        const regenerating =
          outcome.kind === 'ready' &&
          outcome.view.state === 'built' &&
          outcome.view.sendLane !== null &&
          outcome.view.sendLane.regeneratingAskId !== null;

        if (outcome.kind === 'ready') latest = outcome.view;
        // Every other outcome ends the loop: no_batch, a settled built batch,
        // error, unavailable and auth.
        if (!building && !regenerating) stop();
        setState({
          scope: currentScope,
          phase: outcome,
          announcement: justBuilt ? COMPLETION_ANNOUNCEMENT : '',
        });
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

  /**
   * Bumping `attempt` is the whole refetch — the effect above tears its loop
   * down and starts a fresh one, ceiling included.
   *
   * `in_place` deliberately does NOT touch `phase`. Setting LOADING renders
   * `<LoadingCard/>` in the built batch's slot, which unmounts `ApprovalPanel`
   * and takes the owner's exclusion set with it; for a write that ended the
   * screen anyway that costs nothing, and for a regeneration it silently
   * re-selects every ask they deselected.
   */
  const refetch = useCallback(
    (mode: RefetchMode) => {
      if (mode === 'replace') {
        setState({ scope: currentScope, phase: LOADING, announcement: '' });
      }
      setAttempt((value) => value + 1);
    },
    [currentScope],
  );

  return { phase, announcement, refetch };
}

type FetchOutcome =
  | { kind: 'ready'; view: BatchView }
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | { kind: 'auth' };

/** Returns null only when the request was aborted — the caller then commits
 *  nothing, because the scope it belonged to is no longer on screen. */
async function fetchLatestBatch(
  scope: string,
  signal: AbortSignal,
): Promise<FetchOutcome | null> {
  try {
    const response = await fetch(withSolicitationScope(BATCH_PATH, scope), { signal });
    if (response.status === 404) return { kind: 'unavailable' };
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

// ── Attributed reviews ──────────────────────────────────────────────────────

const ATTRIBUTED_LOADING: AttributedReviewsView = { kind: 'loading' };

/**
 * One read per location scope, and NOT part of the 2-second build poll: the
 * batch loop exists to watch a build finish, attribution lands days later, and
 * putting a cross-batch read on that cadence would re-run it up to 150 times
 * while a batch builds.
 *
 * Keyed by scope and aborted on switch for the same reason the batch loop is —
 * a superseded location's late answer must never be rendered against the
 * location the owner switched to.
 */
function useAttributedReviews(currentScope: string): AttributedReviewsView {
  const [state, setState] = useState<{ scope: string; view: AttributedReviewsView }>({
    scope: currentScope,
    view: ATTRIBUTED_LOADING,
  });

  useEffect(() => {
    // The API rejects aggregate scope with a 400, so it is never asked — and
    // the aggregate screen renders no location-scoped section at all.
    if (currentScope === 'all') return;

    const controller = new AbortController();
    let stopped = false;

    void (async () => {
      const view = await fetchAttributed(currentScope, controller.signal);
      if (stopped || view === null) return;
      setState({ scope: currentScope, view });
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [currentScope]);

  // A view belonging to a superseded scope reads as loading, exactly as the
  // batch phase does, so no reset effect is needed on switch.
  return state.scope === currentScope ? state.view : ATTRIBUTED_LOADING;
}

/** Returns null only when the request was aborted — the caller then commits
 *  nothing, because the scope it belonged to is no longer on screen. */
async function fetchAttributed(
  scope: string,
  signal: AbortSignal,
): Promise<AttributedReviewsView | null> {
  try {
    const response = await fetch(withSolicitationScope(ATTRIBUTED_PATH, scope), {
      signal,
    });
    // 404 (watch-mode off, or the location no longer resolves) and 401 (the
    // dashboard's own auth redirect owns it) both mean the section does not
    // exist for this owner right now — the SAME outcome as the send flag being
    // off, and deliberately indistinguishable from it (invariant #13).
    if (response.status === 404 || response.status === 401) {
      return { kind: 'ready', enabled: false, reviews: [] };
    }
    if (!response.ok) {
      console.error(`[requests] attributed fetch failed with ${response.status}`);
      return { kind: 'error' };
    }
    const body = (await response.json()) as {
      enabled: boolean;
      attributed: AttributedReviewView[];
    };
    return { kind: 'ready', enabled: body.enabled, reviews: body.attributed };
  } catch (error) {
    if (signal.aborted) return null;
    console.error('[requests] attributed fetch could not reach the server', error);
    return { kind: 'error' };
  }
}

// ── reviewed_at ping ────────────────────────────────────────────────────────

/**
 * Records that a human opened the spoilage report. Fired from an effect, so it
 * runs when BatchReport has actually rendered — not when the fetch resolved.
 *
 * It reads the phase rather than a batch id so the caller hands over one value
 * and never assembles the "is there a report on screen?" condition itself: only
 * a BUILT batch has a report to open, and every other phase pings nothing.
 *
 * The guard is keyed by `batchId`, never a boolean: a scalar "already pinged"
 * flag would mark batch A and then suppress batch B after a location switch.
 *
 * A hidden tab does not ping. That is the entire reason this is a POST rather
 * than a side effect of the GET — the signal has to mean somebody looked.
 */
function useReviewedPing(phase: Phase, scope: string): void {
  const batchId =
    phase.kind === 'ready' && phase.view.state === 'built' ? phase.view.batchId : null;
  const pinged = useRef<string | null>(null);

  useEffect(() => {
    if (batchId === null || pinged.current === batchId) return;

    const send = () => {
      if (pinged.current === batchId) return;
      if (document.visibilityState !== 'visible') return;
      pinged.current = batchId;
      void postReviewed(scope, batchId).then((ok) => {
        // A failed ping must not permanently claim the batch: clearing the
        // ref lets the visibilitychange path retry on the next focus.
        if (!ok && pinged.current === batchId) pinged.current = null;
      });
    };

    send();
    if (pinged.current === batchId) return;

    document.addEventListener('visibilitychange', send);
    return () => document.removeEventListener('visibilitychange', send);
  }, [batchId, scope]);
}

/** Failures are reported, never swallowed: "the owner never opened it" and "the
 *  write failed" must not look the same in the engagement numbers. */
async function postReviewed(scope: string, batchId: string): Promise<boolean> {
  try {
    const response = await fetch(withSolicitationScope(REVIEWED_PATH, scope), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId }),
    });
    if (!response.ok) {
      console.error(`[requests] reviewed ping failed with ${response.status}`);
    }
    return response.ok;
  } catch (error) {
    console.error('[requests] reviewed ping could not reach the server', error);
    return false;
  }
}
