'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDisplayLabel } from '@/lib/locations/display-label';
import { useLocationScope } from '@/contexts/LocationContext';
import { asLocationId } from '@/lib/shared/ids';
import type { OwnerConversationSummary } from '@/lib/agents/operator/reads';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import type { RenderedSegment } from '@/lib/agents/operator/render';
import { ProposalCard } from './ProposalCard';
import { RequestedCapabilityCard } from './RequestedCapabilityCard';
import { StarterActions } from './StarterActions';
import { SummaryPanel } from './SummaryPanel';
import {
  ALL_LOCATIONS_HINT,
  COMPOSER_PLACEHOLDER,
  KEEP_WAITING,
  NOT_AVAILABLE,
  OFFERS_NEW_CONVERSATION,
  OPERATOR_SUBTITLE,
  OPERATOR_TITLE,
  PREPARING,
  RETRY_SEND,
  SEND,
  SENDING,
  START_NEW_CONVERSATION,
  TIMEOUT_NOTICE,
  routeErrorSentence,
  statusMetricLabel,
  turnFailureSentence,
} from './wording';
import './operator.css';

/**
 * Poll cadence (spec §3.2 step 4). 2 s while a reply is plausibly seconds
 * away, 5 s once it clearly is not, and a HARD STOP at 4 minutes.
 *
 * The ceiling exists because of spec §14's Run B open item CA1: five
 * `OutboxPoller` dispatch failures terminalize the `job_outbox` row while the
 * turn is still `accepted`, so that turn never reaches a terminal status and a
 * loop without a deadline spins forever.
 */
const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 5_000;
const POLL_BACKOFF_AFTER_MS = 30_000;
const POLL_DEADLINE_MS = 4 * 60 * 1_000;

const TURNS_PATH = '/api/operator/turns';
const CONVERSATION_PATH = '/api/operator/conversation';

/**
 * THE RESPONSE SHAPES, declared HERE rather than imported from
 * `@/lib/agents/operator/reads`.
 *
 * This island is an HTTP consumer: what it can rely on is the JSON body the
 * route returns, and the reader's own types are widened by the run's other
 * tracer in the same breath (`locationId` and `unsupported` on a transcript
 * turn, a nullable `conversation` for a first-time owner). Spelling the wire
 * shape locally keeps the two halves independently landable and makes the
 * contract this component actually depends on readable in one place.
 * `OwnerConversationSummary` is passed straight through to the panel, so it is
 * imported rather than restated.
 */
type TurnStatusView = 'accepted' | 'running' | 'completed' | 'failed';

interface UnsupportedRow {
  id: string;
  request: string;
  context: string;
}

interface TranscriptTurn {
  id: string;
  sequence: number;
  status: TurnStatusView;
  failureReason: string | null;
  /** The turn, not the browser, owns the target: frozen at POST. */
  locationId: string;
  ownerText: string;
  segments: RenderedSegment[];
  proposals: ProposalView[];
  unsupported: UnsupportedRow[];
}

interface ConversationViewBody {
  conversation: { id: string; lastTurnAt: string | null } | null;
  turns: TranscriptTurn[];
  summary: OwnerConversationSummary | null;
}

type TurnView = {
  id: string;
  status: TurnStatusView;
  failureReason: string | null;
  segments: RenderedSegment[];
  proposals: ProposalView[];
  unsupported: UnsupportedRow[];
};

/**
 * A POST that has been SENT but whose outcome is not yet known. Retained until
 * the response is read, and reused verbatim on a retry.
 *
 * This is the lost-response case spec §3.2 step 6 and §8.2 require: the server
 * may have committed the turn and the response may still be lost. Generating a
 * fresh `clientTurnKey` on the retry would defeat
 * `agent_turns_account_client_key_uniq` — which deduplicates only on the SAME
 * key AND payload (`src/lib/agents/operator/turns.ts:47-54`) — and create a
 * second turn, a second conversation and a second model charge.
 */
interface PendingSubmission {
  conversationId: string;
  clientTurnKey: string;
  locationId: string;
  text: string;
}

type Fetched<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'disabled' }
  | { kind: 'error'; code: string | null }
  | { kind: 'aborted' };

/**
 * A relative path and `{ signal }` only — that is what makes it same-origin,
 * and it is the shape `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:625`
 * uses. A 404 `operator_disabled` is lifted out of the error union because it
 * ends the session on screen (D3).
 */
async function getJson<T>(url: string, signal: AbortSignal): Promise<Fetched<T>> {
  try {
    const response = await fetch(url, { signal });
    if (response.ok) return { kind: 'ok', value: (await response.json()) as T };
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    const code = typeof body.error === 'string' ? body.error : null;
    if (response.status === 404 && code === 'operator_disabled') return { kind: 'disabled' };
    return { kind: 'error', code };
  } catch (error) {
    if (signal.aborted) return { kind: 'aborted' };
    // Ids only, and there are none in this message (invariant 11).
    console.error('[operator] read could not reach the server', error);
    return { kind: 'error', code: null };
  }
}

export function OperatorClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentScope, locations, setLocationScope } = useLocationScope();

  const [conversationId, setConversationId] = useState<string | null>(
    searchParams.get('conversationId'),
  );
  const [turnId, setTurnId] = useState<string | null>(searchParams.get('turnId'));
  /**
   * The CURRENT active turn, readable at response time. `turnId` inside an
   * async callback is the value captured by the render that ISSUED the
   * request, which is stale by the time a slow conversation GET comes back
   * (RB3-01). Every decision that asks "is a turn already running?" reads the
   * ref; only rendering reads the state.
   */
  const activeTurnIdRef = useRef<string | null>(turnId);
  useEffect(() => { activeTurnIdRef.current = turnId; }, [turnId]);
  /**
   * Bumped on every successful POST. A conversation response whose captured
   * epoch is older than this one describes the world BEFORE that submission
   * and is discarded.
   */
  const loadEpochRef = useRef(0);
  const [view, setView] = useState<ConversationViewBody | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  /**
   * True after "Start a new conversation": the owner asked for an EMPTY
   * screen, so the latest-conversation load is skipped until they send. Without
   * it the bare GET immediately re-adopts the transcript they just left (RB-08).
   */
  const [fresh, setFresh] = useState(false);
  /** Bumped to restart the poll loop with a fresh deadline ("Keep waiting"). */
  const [pollEpoch, setPollEpoch] = useState(0);
  /** Bumped after a terminal turn or a card write, to refetch the transcript. */
  const [reloadEpoch, setReloadEpoch] = useState(0);
  /** The conversation read in flight, so a submission can abort it. */
  const conversationLoadRef = useRef<AbortController | null>(null);
  /** The proposal id whose write is in flight, and the last refusal per card. */
  const [cardBusyId, setCardBusyId] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  const scopedLocationId = currentScope === 'all' ? null : currentScope;
  const composerBlocked = scopedLocationId === null;

  const locationLabel = useCallback(
    (id: string) => {
      const found = locations.find((location) => location.id === id);
      return found ? getDisplayLabel(found) : 'this location';
    },
    [locations],
  );

  /** The roster is typed `LocationId`; a stored id off the wire is a string. */
  const chooseLocation = useCallback(
    (id: string) => { setLocationScope(asLocationId(id)); },
    [setLocationScope],
  );

  /** URL state, so a refresh resumes the same turn (spec §3.2 step 6). */
  const writeUrl = useCallback(
    (nextConversationId: string | null, nextTurnId: string | null) => {
      const params = new URLSearchParams();
      if (nextConversationId !== null) params.set('conversationId', nextConversationId);
      if (nextTurnId !== null) params.set('turnId', nextTurnId);
      const query = params.toString();
      // `replace`, not `push`: a poll lifecycle is not browser history.
      // `scroll: false` keeps the transcript where the owner left it.
      router.replace(
        query === '' ? '/dashboard/operator' : `/dashboard/operator?${query}`,
        { scroll: false },
      );
    },
    [router],
  );

  useEffect(() => {
    if (disabled) return;
    // The owner asked to start over. Loading "the latest conversation" here
    // would hand them the one they just left (RB-08). `startNewConversation`
    // has already emptied the view, so this effect only declines to refill it —
    // a `setView(null)` in an effect body is what `react-hooks/set-state-in-effect`
    // forbids, and it would be redundant besides.
    if (fresh && conversationId === null) return;

    const controller = new AbortController();
    // The epoch this request belongs to. A POST that lands while it is in
    // flight bumps the counter, and the stale answer is dropped below.
    const issuedAt = loadEpochRef.current;
    conversationLoadRef.current = controller;
    void (async () => {
      const params = new URLSearchParams();
      if (conversationId !== null) params.set('id', conversationId);
      // D2 / RB-09: with no conversation the read still returns a summary
      // scoped to this location, so the panel and the connect call to action
      // are on screen before the owner's first message.
      if (scopedLocationId !== null) params.set('locationId', scopedLocationId);
      const query = params.toString();
      const result = await getJson<ConversationViewBody>(
        query === '' ? CONVERSATION_PATH : `${CONVERSATION_PATH}?${query}`,
        controller.signal,
      );
      if (result.kind === 'disabled') { setDisabled(true); return; }
      if (result.kind !== 'ok') {
        // `conversation_not_found` is a legitimate empty screen, not an error.
        if (result.kind === 'error' && result.code !== 'conversation_not_found') {
          setNotice(routeErrorSentence(result.code));
        }
        return;
      }
      // STALE ANSWER. A turn was submitted while this read was outstanding, so
      // it describes the world before that submission — including, possibly,
      // an older unfinished turn. Committing it would overwrite the transcript
      // the POST just established (RB3-01).
      if (issuedAt !== loadEpochRef.current) return;
      setView(result.value);

      const loaded = result.value.conversation;
      if (loaded === null) return;

      // TWO SEPARATE FACTS, deliberately kept apart (RB2-04).
      //
      // (a) IDENTITY. Only the bare GET has an id to adopt — without this the
      //     route shows an existing transcript while the next send opens a
      //     DIFFERENT conversation, and the two disagree about what was said.
      const adopting = conversationId === null;

      // (b) AN UNFINISHED TURN, which is true of ANY load. Tying this to (a)
      //     meant a URL that carried `?conversationId=` but no `turnId` — the
      //     state left behind by a completed poll, a shared link, or a reload
      //     after the turn id was cleared — never resumed a reply that was
      //     still running, and the screen sat silent while the worker worked.
      //
      //     THE REF, NOT THE STATE. The `turnId` a callback closes over is the
      //     value captured by the render that issued this request. If the owner
      //     submitted turn B while it was outstanding, that capture still reads
      //     `null`, and adopting the response's older turn A would replace B in
      //     state AND in the URL and cancel B's polling — the reply the owner is
      //     waiting for would never arrive (RB3-01). The epoch guard above
      //     catches the same race; this is the second half of the same fix, and
      //     it holds even for a response that arrives inside the same epoch.
      const latest = result.value.turns[result.value.turns.length - 1];
      const unfinished = latest && (latest.status === 'accepted' || latest.status === 'running')
        ? latest.id
        : null;
      const activeTurnId = activeTurnIdRef.current;
      const resuming = unfinished !== null && activeTurnId === null;

      if (adopting) setConversationId(loaded.id);
      if (resuming) {
        setTurnId(unfinished);
        activeTurnIdRef.current = unfinished;
      }
      // One URL write for whichever of the two happened; none when neither did,
      // so a plain refetch does not churn the history entry.
      if (adopting || resuming) {
        writeUrl(loaded.id, resuming ? unfinished : activeTurnId);
      }
    })();
    return () => controller.abort();
    // `reloadEpoch` is the explicit "read it again" signal: the poll loop's
    // terminal branch bumps it rather than making `turnId` a dependency here,
    // which would refetch the transcript on every turn the loop starts or ends.
  }, [disabled, fresh, conversationId, scopedLocationId, reloadEpoch, writeUrl]);

  /**
   * The poll loop, with an INDEPENDENT DEADLINE TIMER.
   *
   * The deadline is its own `setTimeout`, armed once when the loop starts, and
   * it is the only thing that can end a stuck poll. Checking the clock at the
   * top of `poll()` is not enough: if `fetch` or `response.json()` never
   * settles, `poll()` never returns, no next tick is ever scheduled, and the
   * screen spins forever with no timer left to notice. The independent timer
   * aborts the controller, which rejects the in-flight request, and shows the
   * recovery actions (RB-02). Both timers are cleared on completion and on
   * unmount.
   */
  useEffect(() => {
    if (turnId === null || disabled) return;

    const controller = new AbortController();
    const startedAt = Date.now();
    let stopped = false;
    let inFlight = false;
    let tick: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      stopped = true;
      if (tick !== null) clearTimeout(tick);
      tick = null;
    };

    const deadline = setTimeout(() => {
      stop();
      controller.abort();
      setTimedOut(true);
    }, POLL_DEADLINE_MS);

    const schedule = () => {
      if (stopped) return;
      const elapsed = Date.now() - startedAt;
      tick = setTimeout(
        () => void poll(),
        elapsed > POLL_BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS,
      );
    };

    const poll = async () => {
      if (stopped || inFlight) { if (!stopped) schedule(); return; }
      inFlight = true;
      try {
        const result = await getJson<TurnView>(`${TURNS_PATH}/${turnId}`, controller.signal);
        if (stopped || result.kind === 'aborted') return;
        if (result.kind === 'disabled') { stop(); setDisabled(true); return; }
        if (result.kind === 'error') { schedule(); return; }

        if (result.value.status === 'completed' || result.value.status === 'failed') {
          stop();
          setTurnId(null);
          activeTurnIdRef.current = null;
          writeUrl(conversationId, null);
          // ONE transcript refetch. Everything the terminal turn produced —
          // its segments, its cards, its failure reason — is durable, and the
          // transcript is where the screen reads it from (RB-07).
          setReloadEpoch((value) => value + 1);
          return;
        }
      } finally {
        inFlight = false;
      }
      schedule();
    };

    void poll();
    return () => {
      stop();
      clearTimeout(deadline);
      controller.abort();
    };
  }, [turnId, disabled, pollEpoch, conversationId, writeUrl]);

  /**
   * POSTs one submission. `submission` is built ONCE by the caller and reused
   * verbatim on a retry, so a lost response cannot become a second turn
   * (RB-05).
   */
  const post = useCallback(
    async (submission: PendingSubmission) => {
      setSending(true);
      setNotice(null);
      setPending(submission);
      try {
        const response = await fetch(TURNS_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submission),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: unknown; conversationId?: string; turnId?: string;
        };
        if (!response.ok) {
          const code = typeof body.error === 'string' ? body.error : null;
          if (response.status === 404 && code === 'operator_disabled') { setDisabled(true); return; }
          setNotice(routeErrorSentence(code));
          return;
        }
        // THE SUBMISSION WINS. Anything the conversation read was about to say
        // predates this turn, so the epoch moves and the outstanding request is
        // abandoned before its answer can overwrite what was just established
        // (RB3-01).
        loadEpochRef.current += 1;
        conversationLoadRef.current?.abort();
        setDraft('');
        setPending(null);
        setFresh(false);
        // A fresh turn is a fresh wait: the ceiling belongs to THIS turn, and
        // an earlier turn's timeout notice must not survive beside it. Cleared
        // here rather than at the top of the poll effect, where it would be a
        // `set-state-in-effect` violation.
        setTimedOut(false);
        setConversationId(body.conversationId ?? submission.conversationId);
        setTurnId(body.turnId ?? null);
        activeTurnIdRef.current = body.turnId ?? null;
        writeUrl(body.conversationId ?? submission.conversationId, body.turnId ?? null);
      } catch (error) {
        // THE LOST RESPONSE. The submission stays in `pending`, so Try again
        // re-POSTs the identical payload and the unique constraint returns the
        // original ids instead of creating a second turn.
        console.error('[operator] send could not reach the server', error);
        setNotice(routeErrorSentence(null));
      } finally {
        setSending(false);
      }
    },
    [writeUrl],
  );

  /**
   * A NEW message. `locationId` is explicit, never read from the composer
   * scope inside here — **Refresh plan** posts with the ORIGINAL turn's stored
   * location, which may not be the one selected now (RB-03).
   */
  const send = useCallback(
    (text: string, locationId: string) => {
      if (text.trim() === '' || sending) return;
      void post({
        conversationId: conversationId ?? crypto.randomUUID(),
        clientTurnKey: crypto.randomUUID(),
        locationId,
        text,
      });
    },
    [conversationId, post, sending],
  );

  /** Re-POSTs the SAME payload. Only a new message allocates a new key. */
  const retry = useCallback(() => {
    if (pending === null || sending) return;
    void post(pending);
  }, [pending, post, sending]);

  /**
   * **Refresh plan**: a new **Operator turn** from the stale Proposal's
   * ORIGINAL `owner_text` AND its original location. Both come from the stored
   * turn, never from the composer: refreshing a Salon plan while the Cafe is
   * selected must not prepare the replacement for the Cafe, and under
   * `All locations` it must still work rather than silently doing nothing.
   */
  const refreshPlan = useCallback(
    (turn: TranscriptTurn) => { send(turn.ownerText, turn.locationId); },
    [send],
  );

  /**
   * One POST, one re-render from the ROW the server returned. Every non-404
   * body carries `proposal`, so a refusal repaints the card with the stored
   * state instead of leaving the browser to guess what a 409 meant.
   */
  const writeProposal = useCallback(
    async (proposal: ProposalView, action: 'apply' | 'decline') => {
      if (cardBusyId !== null) return;
      setCardBusyId(proposal.id);
      setCardErrors((current) => {
        const next = { ...current };
        delete next[proposal.id];
        return next;
      });
      try {
        const response = await fetch(`/api/operator/proposals/${proposal.id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(action === 'apply'
            ? { body: JSON.stringify({ expectedVersionToken: proposal.preparedVersionToken }) }
            : {}),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: unknown; proposal?: ProposalView;
        };
        const code = typeof body.error === 'string' ? body.error : null;
        if (response.status === 404 && code === 'operator_disabled') { setDisabled(true); return; }
        if (body.proposal !== undefined) {
          const row = body.proposal;
          setView((current) => current === null ? current : {
            ...current,
            turns: current.turns.map((turn) => ({
              ...turn,
              proposals: turn.proposals.map((p) => (p.id === row.id ? row : p)),
            })),
          });
        }
        if (!response.ok) {
          setCardErrors((current) => ({ ...current, [proposal.id]: routeErrorSentence(code) }));
        } else {
          // An Apply moved `businesses.updated_at`, so every SIBLING card on
          // this location is now stale in the database (D11).
          setReloadEpoch((value) => value + 1);
        }
      } catch (error) {
        console.error('[operator] proposal write could not reach the server', error);
        setCardErrors((current) => ({ ...current, [proposal.id]: routeErrorSentence(null) }));
      } finally {
        setCardBusyId(null);
      }
    },
    [cardBusyId],
  );

  /**
   * A fresh conversation has NO PREDECESSOR, which is the point: spec §14's
   * stranded turn (CA1) blocks every successor in the SAME conversation with
   * `predecessor_stalled`. The id is allocated client-side so the next send
   * cannot silently rejoin the old thread, and `fresh` keeps the empty screen
   * empty until then (RB-08).
   */
  const startNewConversation = useCallback(() => {
    setFresh(true);
    loadEpochRef.current += 1;
    conversationLoadRef.current?.abort();
    setConversationId(null);
    setTurnId(null);
    activeTurnIdRef.current = null;
    setPending(null);
    setView(null);
    setTimedOut(false);
    setNotice(null);
    writeUrl(null, null);
  }, [writeUrl]);

  const keepWaiting = useCallback(() => {
    setTimedOut(false);
    setPollEpoch((value) => value + 1);
  }, []);

  const transcript = view?.turns ?? [];
  const isEmpty = transcript.length === 0;
  const preparing = turnId !== null && !timedOut && !disabled;

  if (disabled) {
    return (
      <div className="content op-surface">
        <div className="card op-card" role="status">
          <h2 className="card-h2">{OPERATOR_TITLE}</h2>
          <p className="op-body">{NOT_AVAILABLE}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="content op-surface">
      <header className="op-head">
        <h1 className="page-title">{OPERATOR_TITLE}</h1>
        <p className="page-sub">{OPERATOR_SUBTITLE}</p>
      </header>

      <div className="op-layout">
        <section className="op-conversation" aria-label="Conversation">
          {isEmpty && (
            <div className="card op-card">
              <h2 className="card-h2">What would you like to change?</h2>
              <p className="op-body">{COMPOSER_PLACEHOLDER}</p>
              <StarterActions
                onPick={(message) => {
                  if (scopedLocationId !== null) send(message, scopedLocationId);
                }}
                disabled={composerBlocked || sending}
              />
            </div>
          )}

          {/* THE TRANSCRIPT IS THE SOURCE (RB-07). Failure wording and
              requested-capability cards are read from the stored turn, not
              from an in-flight poll that is gone after a reload. */}
          {transcript.map((turn) => (
            <article key={turn.id} className="op-turn">
              <p className="op-owner-text">{turn.ownerText}</p>

              <TurnBody
                turn={turn}
                locationLabel={locationLabel}
                currentScope={currentScope}
                onChooseLocation={chooseLocation}
                onApply={(row) => void writeProposal(row, 'apply')}
                onDecline={(row) => void writeProposal(row, 'decline')}
                onRefreshPlan={() => refreshPlan(turn)}
                cardBusyId={cardBusyId}
                cardErrors={cardErrors}
              />

              {turn.status === 'failed' && (
                <div className="card op-card" role="alert">
                  <p className="op-body">{turnFailureSentence(turn.failureReason)}</p>
                  {turn.failureReason !== null
                    && OFFERS_NEW_CONVERSATION.has(turn.failureReason) && (
                    <div className="op-actions">
                      <button
                        type="button"
                        className="btn btn-primary op-action"
                        onClick={startNewConversation}
                      >
                        {START_NEW_CONVERSATION}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}

          {preparing && (
            <p className="op-preparing" role="status" aria-live="polite">{PREPARING}</p>
          )}

          {timedOut && (
            <div className="card op-card" role="alert">
              <p className="op-body">{TIMEOUT_NOTICE}</p>
              <div className="op-actions">
                <button type="button" className="btn btn-secondary op-action" onClick={keepWaiting}>
                  {KEEP_WAITING}
                </button>
                <button type="button" className="btn btn-primary op-action" onClick={startNewConversation}>
                  {START_NEW_CONVERSATION}
                </button>
              </div>
            </div>
          )}

          {notice !== null && (
            <div className="card op-card" role="alert">
              <p className="op-notice">{notice}</p>
              {pending !== null && (
                <div className="op-actions">
                  {/* The SAME payload, so a committed-but-lost first attempt
                      returns the original ids instead of a second turn. */}
                  <button
                    type="button"
                    className="btn btn-secondary op-action"
                    disabled={sending}
                    onClick={retry}
                  >
                    {RETRY_SEND}
                  </button>
                </div>
              )}
            </div>
          )}

          <form
            className="op-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (scopedLocationId !== null) send(draft, scopedLocationId);
            }}
          >
            <label className="op-label" htmlFor="op-message">Message</label>
            <textarea
              id="op-message"
              className="textarea"
              placeholder={COMPOSER_PLACEHOLDER}
              value={draft}
              disabled={composerBlocked || sending}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary op-action"
              disabled={composerBlocked || sending || draft.trim() === ''}
            >
              {sending ? SENDING : SEND}
            </button>
          </form>

          {/* The chooser holds the ACTION; the sentence that explains it is the
              panel's (`hint`). Printing it in both places put the same line on
              screen twice, which reads as a rendering bug rather than as
              emphasis. */}
          {composerBlocked && (
            <div className="card op-card" role="group" aria-label="Choose a location">
              <h2 className="card-h2">Choose a location</h2>
              <div className="op-actions">
                {locations.map((location) => (
                  <button
                    key={location.id}
                    type="button"
                    className="btn btn-secondary op-action"
                    onClick={() => setLocationScope(location.id)}
                  >
                    {getDisplayLabel(location)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <SummaryPanel
          summary={view?.summary ?? null}
          hint={composerBlocked ? ALL_LOCATIONS_HINT : null}
        />
      </div>
    </div>
  );
}

/**
 * One turn's reply, rendered EXHAUSTIVELY over the `RenderedSegment` union
 * (`src/lib/agents/operator/render.ts:376-382`) and in STORED ORDER.
 *
 * The union has six members and only two of them carry `text`, so a renderer
 * that printed `segment.text` dropped four kinds on the floor: a `status`
 * answer — the frozen count, its reporting period and the instant it was read,
 * which is the whole reason the value is materialized at completion — the
 * scrub `notice`, the `scope_check` chooser, and the `proposal` reference
 * itself. A `proposal` segment names WHERE its card belongs, so the card is
 * rendered AT that position; any proposal no segment references is appended
 * after the segments rather than being lost (RB-06).
 */
function TurnBody({
  turn,
  locationLabel,
  currentScope,
  onChooseLocation,
  onApply,
  onDecline,
  onRefreshPlan,
  cardBusyId,
  cardErrors,
}: {
  turn: TranscriptTurn;
  locationLabel: (id: string) => string;
  currentScope: string;
  onChooseLocation: (id: string) => void;
  onApply: (proposal: ProposalView) => void;
  onDecline: (proposal: ProposalView) => void;
  onRefreshPlan: (proposal: ProposalView) => void;
  cardBusyId: string | null;
  cardErrors: Record<string, string>;
}) {
  const byId = new Map(turn.proposals.map((proposal) => [proposal.id, proposal]));
  const placed = new Set<string>();

  const card = (proposal: ProposalView) => {
    placed.add(proposal.id);
    return (
      <ProposalCard
        key={proposal.id}
        proposal={proposal}
        turnLocationId={turn.locationId}
        locationLabel={locationLabel}
        scopeMoved={currentScope !== turn.locationId}
        onApply={onApply}
        onDecline={onDecline}
        onRefreshPlan={onRefreshPlan}
        busy={cardBusyId === proposal.id}
        error={cardErrors[proposal.id] ?? null}
      />
    );
  };

  const rendered = turn.segments.map((segment, index) => {
    const key = `${turn.id}-${index}`;
    switch (segment.type) {
      case 'text':
        return <p key={key} className="op-body">{segment.text}</p>;
      case 'question':
        return <p key={key} className="op-body op-question">{segment.text}</p>;
      case 'notice':
        return <p key={key} className="op-note">{segment.text}</p>;
      case 'status':
        // FROZEN at completion: the value, its period and the instant it was
        // read. Nothing here re-reads a count.
        return (
          <p key={key} className="op-body">
            <span className="op-kv-value">{segment.value}</span>{' '}
            {statusMetricLabel(segment.metric, segment.reportingPeriodDays)}{' '}
            <span className="op-asof">
              (as of <time dateTime={segment.asOf}>{new Date(segment.asOf).toLocaleString()}</time>)
            </span>
          </p>
        );
      case 'scope_check':
        return (
          <div key={key} className="card op-card" role="group" aria-label="Which location?">
            <p className="op-body">
              Did you mean {segment.locationName}? Choose the location and ask again.
            </p>
            <div className="op-actions">
              <button
                type="button"
                className="btn btn-secondary op-action"
                onClick={() => onChooseLocation(segment.locationId)}
              >
                {segment.locationName}
              </button>
            </div>
          </div>
        );
      case 'proposal': {
        const proposal = byId.get(segment.proposalId);
        // A reference whose row is not in this turn's list is a transcript the
        // reader cannot act on; it is skipped rather than throwing, and the
        // card list below still shows anything that WAS returned.
        return proposal === undefined ? null : card(proposal);
      }
      default: {
        // Exhaustiveness guard: a new RenderedSegment member fails typecheck
        // here rather than disappearing from the screen.
        const _never: never = segment;
        return null;
      }
    }
  });

  return (
    <>
      {rendered}
      {turn.proposals.filter((proposal) => !placed.has(proposal.id)).map(card)}
      {turn.unsupported.map((row) => (
        <RequestedCapabilityCard key={row.id} request={row.request} />
      ))}
    </>
  );
}
