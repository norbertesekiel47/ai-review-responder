'use client';

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getDisplayLabel } from '@/lib/locations/display-label';
import { useLocationScope } from '@/contexts/LocationContext';
import { asLocationId } from '@/lib/shared/ids';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import type { OwnerConversationTurn } from '@/lib/agents/operator/reads';
import { TURN_STATUS } from '@/lib/agents/operator/schema';
import { StarterActions } from './StarterActions';
import { SummaryPanel } from './SummaryPanel';
import { TurnBody } from './TurnBody';
import { postJson, useOperatorConversation } from './useOperatorConversation';
import { useTurnPoll } from './useTurnPoll';
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

/** What a proposal write answers with, in every status (200 and 409 alike). */
interface ProposalWriteBody {
  proposal?: ProposalView;
}

function writtenProposal(body: unknown): ProposalView | null {
  if (typeof body !== 'object' || body === null) return null;
  const row = (body as ProposalWriteBody).proposal;
  return row ?? null;
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentScope, locations, setLocationScope } = useLocationScope();

  const [disabled, setDisabled] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSubmission | null>(null);
  /**
   * Whether the CURRENT notice is a lost response — the only outcome a retry
   * can fix. A refusal the server actually answered (`unauthorized`,
   * `account_offboarding`, `turn_key_conflict`, `forbidden`,
   * `past_due_read_only`) re-POSTs to the same refusal, so offering "Try
   * again" beside it invited the owner to fail twice (S6).
   */
  const [lostResponse, setLostResponse] = useState(false);
  /** The proposal id whose write is in flight, and the last refusal per card. */
  const [cardBusyId, setCardBusyId] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  const scopedLocationId = currentScope === 'all' ? null : currentScope;
  const composerBlocked = scopedLocationId === null;

  const markDisabled = useCallback(() => { setDisabled(true); }, []);

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

  const conversation = useOperatorConversation({
    disabled,
    scopedLocationId,
    initialConversationId: searchParams.get('conversationId'),
    initialTurnId: searchParams.get('turnId'),
    writeUrl,
    onDisabled: markDisabled,
    onNotice: setNotice,
  });

  const poll = useTurnPoll(conversation.turnId, {
    // A location the account cannot use has no turn worth waiting for (S7).
    halted: disabled || conversation.locationUnavailable,
    onDisabled: markDisabled,
    onTerminal: conversation.finishTurn,
  });

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
        if (result.kind === 'disabled') { setDisabled(true); return; }
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
    [conversation, poll],
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
        const result = await postJson<ProposalWriteBody>(
          `/api/operator/proposals/${proposal.id}/${action}`,
          action === 'apply' ? { expectedVersionToken: proposal.preparedVersionToken } : undefined,
        );
        if (result.kind === 'disabled') { setDisabled(true); return; }
        if (result.kind === 'aborted') return;
        if (result.kind === 'unreachable') {
          setCardErrors((current) => ({ ...current, [proposal.id]: routeErrorSentence(null) }));
          return;
        }
        const row = result.kind === 'ok'
          ? result.value.proposal ?? null
          : writtenProposal(result.body);
        if (row !== null) conversation.patchProposal(row);
        if (result.kind === 'error') {
          setCardErrors((current) => ({
            ...current,
            [proposal.id]: routeErrorSentence(result.code),
          }));
        } else {
          // An Apply moved `businesses.updated_at`, so every SIBLING card on
          // this location is now stale in the database (D11).
          conversation.reloadTranscript();
        }
      } finally {
        setCardBusyId(null);
      }
    },
    [cardBusyId, conversation],
  );

  const startNewConversation = useCallback(() => {
    conversation.startFresh();
    poll.clearTimedOut();
    setPending(null);
    setLostResponse(false);
    setNotice(null);
  }, [conversation, poll]);

  const transcript = conversation.view?.turns ?? [];
  const isEmpty = transcript.length === 0;
  const preparing = conversation.turnId !== null
    && !poll.timedOut
    && !disabled
    && !conversation.locationUnavailable;

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

              {turn.status === TURN_STATUS.FAILED && (
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

          {poll.timedOut && (
            <div className="card op-card" role="alert">
              <p className="op-body">{TIMEOUT_NOTICE}</p>
              <div className="op-actions">
                <button type="button" className="btn btn-secondary op-action" onClick={poll.keepWaiting}>
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
              {/* ONLY a lost response. A refusal the server answered cannot be
                  fixed by sending it again (S6). */}
              {lostResponse && pending !== null && (
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
          summary={conversation.view?.summary ?? null}
          locationLabel={locationLabel}
          hint={composerBlocked ? ALL_LOCATIONS_HINT : null}
        />
      </div>
    </div>
  );
}
