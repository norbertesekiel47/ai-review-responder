'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDisplayLabel } from '@/lib/locations/display-label';
import type { LocationInfo } from '@/contexts/LocationContext';
import type { OwnerConversationTurn } from '@/lib/agents/operator/reads';
import { TURN_STATUS } from '@/lib/agents/operator/schema';
import { StarterActions } from './StarterActions';
import { SummaryPanel } from './SummaryPanel';
import { TurnBody, type TurnBodyProps } from './TurnBody';
import { ProposalCard } from './ProposalCard';
import { RulesTimeline } from './RulesTimeline';
import {
  postJson,
  useOperatorConversation,
  useOperatorScreenState,
  useOperatorTimelineRefresh,
  type OperatorConversation,
} from './useOperatorConversation';
import { useProposalWrites, type ProposalWrites } from './useProposalWrites';
import { useTurnPoll, type TurnPoll } from './useTurnPoll';
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
  turnFailureSentence,
} from './wording';
import './operator.css';

const TURNS_PATH = '/api/operator/turns';

/**
 * The submission deadline (C2). The poll loop has had an independent ceiling
 * since RB-02, but the POST that PRECEDES it had none: a request that never
 * settled left `sending` true, no turn id, no poll, and therefore neither the
 * retry affordance nor "Start a new conversation" — an indefinite wait before
 * acceptance is even known. Thirty seconds is well past a healthy accept
 * (the route writes one transaction and returns) and well short of the
 * four-minute reply ceiling.
 */
const POST_DEADLINE_MS = 30_000;

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

/**
 * Whether the screen is WAITING on a reply. Not merely "a turn exists": a
 * timed-out wait, a dead surface and an unusable location each end it.
 */
function isPreparing({ turnId, timedOut, disabled, locationUnavailable }: {
  turnId: string | null;
  timedOut: boolean;
  disabled: boolean;
  locationUnavailable: boolean;
}): boolean {
  return turnId !== null && !timedOut && !disabled && !locationUnavailable;
}

/** The screen's own URL, carrying whichever ids exist (spec §3.2 step 6). */
function operatorUrl(conversationId: string | null, turnId: string | null): string {
  const params = new URLSearchParams();
  if (conversationId !== null) params.set('conversationId', conversationId);
  if (turnId !== null) params.set('turnId', turnId);
  const query = params.toString();
  return query === '' ? '/dashboard/operator' : `/dashboard/operator?${query}`;
}

/**
 * THE SCREEN'S OWN URL: the ids it was opened with, and the one way to move
 * them. Read once on mount, so a refresh resumes the same turn (spec §3.2
 * step 6).
 */
function useOperatorUrl(): {
  initialConversationId: string | null;
  initialTurnId: string | null;
  writeUrl: (conversationId: string | null, turnId: string | null) => void;
} {
  const router = useRouter();
  const searchParams = useSearchParams();
  const writeUrl = useCallback(
    (conversationId: string | null, turnId: string | null) => {
      // `replace`, not `push`: a poll lifecycle is not browser history.
      // `scroll: false` keeps the transcript where the owner left it.
      router.replace(operatorUrl(conversationId, turnId), { scroll: false });
    },
    [router],
  );
  return {
    initialConversationId: searchParams.get('conversationId'),
    initialTurnId: searchParams.get('turnId'),
    writeUrl,
  };
}

interface TurnSubmission {
  draft: string;
  setDraft: (value: string) => void;
  sending: boolean;
  /** True only for a LOST response — the one outcome a retry can fix (S6). */
  canRetry: boolean;
  send: (text: string, locationId: string) => void;
  retry: () => void;
  refreshPlan: (turn: OwnerConversationTurn) => void;
  /** Starting over drops the pending submission and its retry affordance. */
  clear: () => void;
}

/**
 * THE THIRD MACHINE: the composer, the turn POST, its retry, and **Refresh
 * plan**. The two read machines (`useOperatorConversation`, `useTurnPoll`) sit
 * beside it; what the client itself is left with is composition and markup.
 */
function useTurnSubmission({ conversation, poll, onDisabled, setNotice }: {
  conversation: OperatorConversation;
  poll: TurnPoll;
  onDisabled: () => void;
  setNotice: (sentence: string | null) => void;
}): TurnSubmission {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  /**
   * Whether the CURRENT notice is a lost response — the only outcome a retry
   * can fix. A refusal the server actually answered (`unauthorized`,
   * `account_offboarding`, `turn_key_conflict`, `forbidden`,
   * `past_due_read_only`) re-POSTs to the same refusal, so offering "Try
   * again" beside it invited the owner to fail twice (S6).
   */
  const [lostResponse, setLostResponse] = useState(false);

  /**
   * POSTs one submission. `submission` is built ONCE by the caller and reused
   * verbatim on a retry, so a lost response cannot become a second turn
   * (RB-05).
   */
  const post = useCallback(
    async (submission: PendingSubmission) => {
      setSending(true);
      setNotice(null);
      setLostResponse(false);
      setPending(submission);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), POST_DEADLINE_MS);
      try {
        const result = await postJson<{ conversationId?: string; turnId?: string }>(
          TURNS_PATH,
          submission,
          controller.signal,
        );
        if (result.kind === 'disabled') { onDisabled(); return; }
        if (result.kind === 'ok') {
          setDraft('');
          setPending(null);
          // A fresh turn is a fresh wait: the ceiling belongs to THIS turn, and
          // an earlier turn's timeout notice must not survive beside it.
          poll.clearTimedOut();
          conversation.adoptAcceptedTurn({
            conversationId: result.value.conversationId ?? submission.conversationId,
            turnId: result.value.turnId ?? null,
          });
          return;
        }
        if (result.kind === 'error') { setNotice(routeErrorSentence(result.code)); return; }
        // THE LOST RESPONSE — unreachable, or our own deadline, which nothing
        // else aborts. The submission stays in `pending`, so Try again re-POSTs
        // the identical payload and the unique constraint returns the original
        // ids instead of creating a second turn.
        setLostResponse(true);
        setNotice(routeErrorSentence(null));
      } finally {
        clearTimeout(deadline);
        setSending(false);
      }
    },
    [conversation, poll, onDisabled, setNotice],
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
        conversationId: conversation.conversationId ?? crypto.randomUUID(),
        clientTurnKey: crypto.randomUUID(),
        locationId,
        text,
      });
    },
    [conversation.conversationId, post, sending],
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
    (turn: OwnerConversationTurn) => { send(turn.ownerText, turn.locationId); },
    [send],
  );

  const clear = useCallback(() => {
    setPending(null);
    setLostResponse(false);
  }, []);

  /**
   * ONE OBJECT PER CHANGE, like both sibling machines
   * (`useOperatorConversation`, `useTurnPoll`). `startNewConversation` depends
   * on this value, and a fresh literal every render gave that callback — and
   * anything downstream of it — a new identity on every keystroke in the
   * composer. The fields are already individually stable; only the wrapper was
   * not (RT-B6).
   */
  return useMemo(
    () => ({
      draft,
      setDraft,
      sending,
      canRetry: lostResponse && pending !== null,
      send,
      retry,
      refreshPlan,
      clear,
    }),
    [draft, setDraft, sending, lostResponse, pending, send, retry, refreshPlan, clear],
  );
}

/**
 * THE OPERATOR SCREEN: composition plus the three writes.
 *
 * The two read machines live beside it — `useOperatorConversation` owns the
 * transcript, its identity and its epochs, `useTurnPoll` owns the wait — so
 * what is left here is the markup, the composer, and the callbacks that change
 * something: submit a turn, retry a lost one, apply or decline a card (F2).
 */
export function OperatorClient() {
  const {
    currentScope, locations, setLocationScope, disabled, notice, setNotice,
    panel, setPanel, timelineRevision, setTimelineRevision, scopedLocationId,
    composerBlocked, markDisabled, locationLabel, chooseLocation,
  } = useOperatorScreenState();

  const url = useOperatorUrl();

  const conversation = useOperatorConversation({
    disabled,
    scopedLocationId,
    initialConversationId: url.initialConversationId,
    initialTurnId: url.initialTurnId,
    writeUrl: url.writeUrl,
    onDisabled: markDisabled,
    onNotice: setNotice,
  });

  const { reloadAfterProposal, finishTurnAndRefreshTimeline } = useOperatorTimelineRefresh(
    conversation, setTimelineRevision,
  );

  /** All card writes share one in-flight guard and refresh both durable views. */
  const cards = useProposalWrites({
    onDisabled: markDisabled,
    patchProposal: conversation.patchProposal,
    reloadTranscript: reloadAfterProposal,
  });

  const poll = useTurnPoll(conversation.turnId, {
    // A location the account cannot use has no turn worth waiting for (S7).
    halted: disabled || conversation.locationUnavailable,
    onDisabled: markDisabled,
    onTerminal: finishTurnAndRefreshTimeline,
  });

  /** The composer, the submission, its retry and **Refresh plan**. */
  const submission = useTurnSubmission({ conversation, poll, onDisabled: markDisabled, setNotice });

  const startNewConversation = useCallback(() => {
    conversation.startFresh();
    poll.clearTimedOut();
    submission.clear();
    setNotice(null);
  }, [conversation, poll, submission, setNotice]);

  const preparing = isPreparing({
    turnId: conversation.turnId,
    timedOut: poll.timedOut,
    disabled,
    locationUnavailable: conversation.locationUnavailable,
  });

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

      <nav className="op-actions" aria-label="Operator views">
        <button type="button" className={`btn op-action ${panel === 'conversation' ? 'btn-primary' : 'btn-secondary'}`}
          aria-pressed={panel === 'conversation'} onClick={() => setPanel('conversation')}>Conversation</button>
        <button type="button" className={`btn op-action ${panel === 'timeline' ? 'btn-primary' : 'btn-secondary'}`}
          aria-pressed={panel === 'timeline'} onClick={() => setPanel('timeline')}>Rules timeline</button>
      </nav>

      <div className="op-layout">
        {panel === 'timeline' ? <RulesTimeline locationId={scopedLocationId} locationLabel={locationLabel}
          revision={timelineRevision} onDisabled={markDisabled} cards={cards} /> : <section className="op-conversation" aria-label="Conversation">
          <EmptyPrompt
            shown={conversation.turns.length === 0}
            blocked={composerBlocked}
            sending={submission.sending}
            scopedLocationId={scopedLocationId}
            onSend={submission.send}
          />

          {/* THE TRANSCRIPT IS THE SOURCE (RB-07). Failure wording and
              requested-capability cards are read from the stored turn, not
              from an in-flight poll that is gone after a reload. */}
          <Transcript
            turns={conversation.turns}
            locationLabel={locationLabel}
            currentScope={currentScope}
            onChooseLocation={chooseLocation}
            cards={cards}
            onRefreshPlan={submission.refreshPlan}
            onStartNewConversation={startNewConversation}
          />

          <PreparedProposal cards={cards} turns={conversation.turns}
            locationLabel={locationLabel} currentScope={currentScope} />

          <PreparingNotice shown={preparing} />

          <TimeoutNotice
            shown={poll.timedOut}
            onKeepWaiting={poll.keepWaiting}
            onStartNewConversation={startNewConversation}
          />

          <SubmissionNotice
            notice={notice}
            canRetry={submission.canRetry}
            sending={submission.sending}
            onRetry={submission.retry}
          />

          <Composer
            draft={submission.draft}
            blocked={composerBlocked}
            sending={submission.sending}
            scopedLocationId={scopedLocationId}
            onDraftChange={submission.setDraft}
            onSend={submission.send}
          />

          <LocationChooser
            shown={composerBlocked}
            locations={locations}
            onChoose={setLocationScope}
          />
        </section>}

        <SummaryPanel
          summary={conversation.summary}
          locationLabel={locationLabel}
          hint={composerBlocked ? ALL_LOCATIONS_HINT : null}
        />
      </div>
    </div>
  );
}

/** A prepared Restore stays visible until the transcript carries its card. */
function PreparedProposal({ cards, turns, locationLabel, currentScope }: {
  cards: ProposalWrites;
  turns: OwnerConversationTurn[];
  locationLabel: (id: string) => string;
  currentScope: string;
}) {
  const proposal = cards.preparedProposal;
  if (proposal === null) return null;
  if (turns.some((turn) => turn.proposals.some((row) => row.id === proposal.id))) return null;
  return (
    <ProposalCard proposal={proposal} turnLocationId={proposal.locationId ?? ''}
      locationLabel={locationLabel} scopeMoved={currentScope !== proposal.locationId}
      onApply={(row, confirmation) => void cards.write(row, 'apply', confirmation)}
      onDecline={(row) => void cards.write(row, 'decline')}
      onRestore={(row) => void cards.write(row, 'restore')}
      onRefreshPlan={(row) => void cards.write(row, 'restore')}
      busy={cards.busyId === proposal.id} error={cards.errors[proposal.id] ?? null} />
  );
}

/** The first screen: what this is for, and three ways to start (spec §3.1). */
function EmptyPrompt({ shown, blocked, sending, scopedLocationId, onSend }: {
  shown: boolean;
  blocked: boolean;
  sending: boolean;
  scopedLocationId: string | null;
  onSend: (text: string, locationId: string) => void;
}) {
  if (!shown) return null;
  return (
    <div className="card op-card">
      <h2 className="card-h2">What would you like to change?</h2>
      <p className="op-body">{COMPOSER_PLACEHOLDER}</p>
      <StarterActions
        onPick={(message) => {
          if (scopedLocationId !== null) onSend(message, scopedLocationId);
        }}
        disabled={blocked || sending}
      />
    </div>
  );
}

/** The stored transcript, in order, one article per turn. */
function Transcript({
  turns,
  locationLabel,
  currentScope,
  onChooseLocation,
  cards,
  onRefreshPlan,
  onStartNewConversation,
}: {
  turns: OwnerConversationTurn[];
  locationLabel: (id: string) => string;
  currentScope: string;
  onChooseLocation: (id: string) => void;
  cards: ProposalWrites;
  onRefreshPlan: (turn: OwnerConversationTurn) => void;
  onStartNewConversation: () => void;
}) {
  return (
    <>
      {turns.map((turn) => (
        <TurnArticle
          key={turn.id}
          turn={turn}
          locationLabel={locationLabel}
          currentScope={currentScope}
          onChooseLocation={onChooseLocation}
          onApply={(row, confirmationLevel) => void cards.write(row, 'apply', confirmationLevel)}
          onDecline={(row) => void cards.write(row, 'decline')}
          onRefreshPlan={(row) => row.restoreSourceProposalId
            ? void cards.write(row, 'restore') : onRefreshPlan(turn)}
          onRestore={(row) => void cards.write(row, 'restore')}
          cardBusyId={cards.busyId}
          cardErrors={cards.errors}
          onStartNewConversation={onStartNewConversation}
        />
      ))}
    </>
  );
}

/** "Preparing your plan", while a turn is genuinely still being waited on. */
function PreparingNotice({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return <p className="op-preparing" role="status" aria-live="polite">{PREPARING}</p>;
}

/**
 * ONE TURN: the owner's own words, the reply, and — for a failed turn — the
 * stored failure wording plus the recovery it offers.
 *
 * The failure half is read from the DURABLE row, never from an in-flight poll
 * that is gone after a reload (RB-07).
 */
function TurnArticle({
  turn,
  onStartNewConversation,
  ...body
}: TurnBodyProps & { onStartNewConversation: () => void }) {
  return (
    <article className="op-turn">
      <p className="op-owner-text">{turn.ownerText}</p>

      <TurnBody turn={turn} {...body} />

      {turn.status === TURN_STATUS.FAILED && (
        <div className="card op-card" role="alert">
          <p className="op-body">{turnFailureSentence(turn.failureReason)}</p>
          {turn.failureReason !== null
            && OFFERS_NEW_CONVERSATION.has(turn.failureReason) && (
            <div className="op-actions">
              <button
                type="button"
                className="btn btn-primary op-action"
                onClick={onStartNewConversation}
              >
                {START_NEW_CONVERSATION}
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** The four-minute ceiling, and both ways out of it (RB-02, RB2-05). */
function TimeoutNotice({ shown, onKeepWaiting, onStartNewConversation }: {
  shown: boolean;
  onKeepWaiting: () => void;
  onStartNewConversation: () => void;
}) {
  if (!shown) return null;
  return (
    <div className="card op-card" role="alert">
      <p className="op-body">{TIMEOUT_NOTICE}</p>
      <div className="op-actions">
        <button type="button" className="btn btn-secondary op-action" onClick={onKeepWaiting}>
          {KEEP_WAITING}
        </button>
        <button type="button" className="btn btn-primary op-action" onClick={onStartNewConversation}>
          {START_NEW_CONVERSATION}
        </button>
      </div>
    </div>
  );
}

/**
 * What happened to the submission, and — ONLY for a lost response — the retry.
 * A refusal the server answered cannot be fixed by sending it again (S6).
 */
function SubmissionNotice({ notice, canRetry, sending, onRetry }: {
  notice: string | null;
  canRetry: boolean;
  sending: boolean;
  onRetry: () => void;
}) {
  if (notice === null) return null;
  return (
    <div className="card op-card" role="alert">
      <p className="op-notice">{notice}</p>
      {canRetry && (
        <div className="op-actions">
          {/* The SAME payload, so a committed-but-lost first attempt returns
              the original ids instead of a second turn. */}
          <button
            type="button"
            className="btn btn-secondary op-action"
            disabled={sending}
            onClick={onRetry}
          >
            {RETRY_SEND}
          </button>
        </div>
      )}
    </div>
  );
}

/** The composer, disabled under `All locations` — a plan needs one location. */
function Composer({ draft, blocked, sending, scopedLocationId, onDraftChange, onSend }: {
  draft: string;
  blocked: boolean;
  sending: boolean;
  scopedLocationId: string | null;
  onDraftChange: (value: string) => void;
  onSend: (text: string, locationId: string) => void;
}) {
  return (
    <form
      className="op-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (scopedLocationId !== null) onSend(draft, scopedLocationId);
      }}
    >
      <label className="op-label" htmlFor="op-message">Message</label>
      <textarea
        id="op-message"
        className="textarea"
        placeholder={COMPOSER_PLACEHOLDER}
        value={draft}
        disabled={blocked || sending}
        onChange={(event) => onDraftChange(event.target.value)}
      />
      <button
        type="submit"
        className="btn btn-primary op-action"
        disabled={blocked || sending || draft.trim() === ''}
      >
        {sending ? SENDING : SEND}
      </button>
    </form>
  );
}

/**
 * The chooser holds the ACTION; the sentence that explains it is the panel's
 * (`hint`). Printing it in both places put the same line on screen twice,
 * which reads as a rendering bug rather than as emphasis.
 */
function LocationChooser({ shown, locations, onChoose }: {
  shown: boolean;
  locations: LocationInfo[];
  onChoose: (id: LocationInfo['id']) => void;
}) {
  if (!shown) return null;
  return (
    <div className="card op-card" role="group" aria-label="Choose a location">
      <h2 className="card-h2">Choose a location</h2>
      <div className="op-actions">
        {locations.map((location) => (
          <button
            key={location.id}
            type="button"
            className="btn btn-secondary op-action"
            onClick={() => onChoose(location.id)}
          >
            {getDisplayLabel(location)}
          </button>
        ))}
      </div>
    </div>
  );
}
