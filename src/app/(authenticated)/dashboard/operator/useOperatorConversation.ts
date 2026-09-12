'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProposalView } from '@/lib/agents/operator/proposals';
import type { OwnerConversationView } from '@/lib/agents/operator/reads';
import { TURN_STATUS } from '@/lib/agents/operator/schema';
import { LOCATION_UNAVAILABLE, routeErrorSentence } from './wording';

/**
 * THE TRANSCRIPT HALF of the Operator screen: the conversation read, the load
 * epoch that decides which answer is still current, the adopt/resume protocol,
 * and the `location_not_found` outcome.
 *
 * Split out of `OperatorClient` (F2), which carried three machines in one
 * component. The client keeps composition and the WRITE callbacks; this module
 * owns everything about reading and identity, and the state it owns is
 * reachable only through the small command surface below — nothing outside can
 * set `conversationId` without also writing the URL, or refetch without saying
 * why.
 *
 * The same-origin JSON transport lives here too, because both halves of the
 * screen speak it and the working rules' "no new file" default says one more
 * module for two functions is not worth the page in the directory map.
 */

export const CONVERSATION_PATH = '/api/operator/conversation';

/**
 * FIVE outcomes, not two. `disabled` is lifted out because a 404
 * `operator_disabled` ends the session on screen (D3); `unreachable` is kept
 * apart from `error` because a POST that never reached the server may still
 * have committed, and only that case may offer a retry (S6, C2).
 */
export type Fetched<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'disabled' }
  | { kind: 'error'; code: string | null; body: unknown }
  | { kind: 'unreachable' }
  | { kind: 'aborted' };

function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as { error?: unknown }).error;
  return typeof value === 'string' ? value : null;
}

/**
 * ONE decode for every Operator request, which is what makes `operator_disabled`
 * a single decision rather than the same three lines in three callbacks (F5).
 * The parsed body travels on the error branch: a refused proposal write still
 * carries the stored row, and repainting the card from it is how a 409 becomes
 * something the owner can read.
 */
async function decode<T>(response: Response): Promise<Fetched<T>> {
  if (response.ok) return { kind: 'ok', value: (await response.json()) as T };
  const body: unknown = await response.json().catch(() => ({}));
  const code = errorCode(body);
  if (response.status === 404 && code === 'operator_disabled') return { kind: 'disabled' };
  return { kind: 'error', code, body };
}

/**
 * A relative path and `{ signal }` only — that is what makes it same-origin,
 * and it is the shape `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx:625`
 * uses.
 */
export async function getJson<T>(url: string, signal: AbortSignal): Promise<Fetched<T>> {
  try {
    return await decode<T>(await fetch(url, { signal }));
  } catch (error) {
    if (signal.aborted) return { kind: 'aborted' };
    // Ids only, and there are none in this message (invariant 11).
    console.error('[operator] read could not reach the server', error);
    return { kind: 'unreachable' };
  }
}

/**
 * The write half. `body` is optional because Decline posts none, and `signal`
 * is optional because only the turn submission carries a deadline (C2).
 */
export async function postJson<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Fetched<T>> {
  try {
    return await decode<T>(await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    }));
  } catch (error) {
    if (signal?.aborted === true) return { kind: 'aborted' };
    console.error('[operator] write could not reach the server', error);
    return { kind: 'unreachable' };
  }
}

export interface OperatorConversation {
  conversationId: string | null;
  turnId: string | null;
  view: OwnerConversationView | null;
  /** True when `?locationId=` named a location this account cannot use (S7). */
  locationUnavailable: boolean;
  /** A POST was accepted: adopt the server's ids and refetch the transcript. */
  adoptAcceptedTurn: (ids: { conversationId: string; turnId: string | null }) => void;
  /** The poll loop reached a terminal status: release the turn, refetch once. */
  finishTurn: () => void;
  /** A card write landed: refetch, because an Apply staled every sibling (D11). */
  reloadTranscript: () => void;
  /** "Start a new conversation": an empty screen that STAYS empty (RB-08). */
  startFresh: () => void;
  /** Repaint one Proposal from the row the server just returned. */
  patchProposal: (row: ProposalView) => void;
}

export interface OperatorConversationInput {
  disabled: boolean;
  scopedLocationId: string | null;
  /** URL state, read once: a refresh resumes the same turn (spec §3.2 step 6). */
  initialConversationId: string | null;
  initialTurnId: string | null;
  writeUrl: (conversationId: string | null, turnId: string | null) => void;
  onDisabled: () => void;
  onNotice: (sentence: string) => void;
}

export function useOperatorConversation({
  disabled,
  scopedLocationId,
  initialConversationId,
  initialTurnId,
  writeUrl,
  onDisabled,
  onNotice,
}: OperatorConversationInput): OperatorConversation {
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [turnId, setTurnId] = useState<string | null>(initialTurnId);
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
  /** The conversation read in flight, so a submission can abort it. */
  const conversationLoadRef = useRef<AbortController | null>(null);
  const [view, setView] = useState<OwnerConversationView | null>(null);
  const [locationUnavailable, setLocationUnavailable] = useState(false);
  /**
   * True after "Start a new conversation": the owner asked for an EMPTY
   * screen, so the latest-conversation load is skipped until they send. Without
   * it the bare GET immediately re-adopts the transcript they just left (RB-08).
   */
  const [fresh, setFresh] = useState(false);
  /** Bumped after a terminal turn, an accepted POST or a card write. */
  const [reloadEpoch, setReloadEpoch] = useState(0);

  useEffect(() => {
    if (disabled) return;
    // The owner asked to start over. Loading "the latest conversation" here
    // would hand them the one they just left (RB-08). `startFresh` has already
    // emptied the view, so this effect only declines to refill it — a
    // `setView(null)` in an effect body is what `react-hooks/set-state-in-effect`
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
      const result = await getJson<OwnerConversationView>(
        query === '' ? CONVERSATION_PATH : `${CONVERSATION_PATH}?${query}`,
        controller.signal,
      );
      if (result.kind === 'disabled') { onDisabled(); return; }
      if (result.kind === 'aborted') return;
      if (result.kind === 'unreachable') { onNotice(routeErrorSentence(null)); return; }
      if (result.kind === 'error') {
        // THREE ANSWERS, THREE SCREENS. `conversation_not_found` is a
        // legitimate empty screen; `location_not_found` is a location the
        // account cannot use, which is owed a sentence AND must not leave a
        // poll running against it (S7); anything else is a plain failure.
        if (result.code === 'location_not_found') {
          setLocationUnavailable(true);
          onNotice(LOCATION_UNAVAILABLE);
          return;
        }
        if (result.code !== 'conversation_not_found') onNotice(routeErrorSentence(result.code));
        return;
      }
      // STALE ANSWER. A turn was submitted while this read was outstanding, so
      // it describes the world before that submission — including, possibly,
      // an older unfinished turn. Committing it would overwrite the transcript
      // the POST just established (RB3-01).
      if (issuedAt !== loadEpochRef.current) return;
      setLocationUnavailable(false);
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
      const unfinished = latest
        && (latest.status === TURN_STATUS.ACCEPTED || latest.status === TURN_STATUS.RUNNING)
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
  }, [disabled, fresh, conversationId, scopedLocationId, reloadEpoch, writeUrl, onDisabled, onNotice]);

  const adoptAcceptedTurn = useCallback(
    (ids: { conversationId: string; turnId: string | null }) => {
      // THE SUBMISSION WINS. Anything the conversation read was about to say
      // predates this turn, so the epoch moves and the outstanding request is
      // abandoned before its answer can overwrite what was just established
      // (RB3-01).
      loadEpochRef.current += 1;
      conversationLoadRef.current?.abort();
      setFresh(false);
      setConversationId(ids.conversationId);
      setTurnId(ids.turnId);
      activeTurnIdRef.current = ids.turnId;
      // AND REFETCH. For the SECOND message in a conversation the id does not
      // change, so nothing else here would re-run the read — the composer
      // emptied, the transcript still showed only the previous exchange, and
      // the owner's own words were on no part of the screen for the twenty to
      // sixty seconds the turn takes (S3).
      setReloadEpoch((value) => value + 1);
      writeUrl(ids.conversationId, ids.turnId);
    },
    [writeUrl],
  );

  const finishTurn = useCallback(() => {
    setTurnId(null);
    activeTurnIdRef.current = null;
    writeUrl(conversationId, null);
    // ONE transcript refetch. Everything the terminal turn produced — its
    // segments, its cards, its failure reason — is durable, and the transcript
    // is where the screen reads it from (RB-07).
    setReloadEpoch((value) => value + 1);
  }, [conversationId, writeUrl]);

  const reloadTranscript = useCallback(() => {
    setReloadEpoch((value) => value + 1);
  }, []);

  /**
   * A fresh conversation has NO PREDECESSOR, which is the point: spec §14's
   * stranded turn (CA1) blocks every successor in the SAME conversation with
   * `predecessor_stalled`. The id is allocated client-side on the next send so
   * it cannot silently rejoin the old thread, and `fresh` keeps the empty
   * screen empty until then (RB-08).
   */
  const startFresh = useCallback(() => {
    setFresh(true);
    loadEpochRef.current += 1;
    conversationLoadRef.current?.abort();
    setConversationId(null);
    setTurnId(null);
    activeTurnIdRef.current = null;
    setView(null);
    setLocationUnavailable(false);
    writeUrl(null, null);
  }, [writeUrl]);

  const patchProposal = useCallback((row: ProposalView) => {
    setView((current) => current === null ? current : {
      ...current,
      turns: current.turns.map((turn) => ({
        ...turn,
        proposals: turn.proposals.map((p) => (p.id === row.id ? row : p)),
      })),
    });
  }, []);

  return useMemo(
    () => ({
      conversationId,
      turnId,
      view,
      locationUnavailable,
      adoptAcceptedTurn,
      finishTurn,
      reloadTranscript,
      startFresh,
      patchProposal,
    }),
    [
      conversationId, turnId, view, locationUnavailable,
      adoptAcceptedTurn, finishTurn, reloadTranscript, startFresh, patchProposal,
    ],
  );
}
