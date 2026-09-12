// Owner Operator turn persistence. Invariant #15: every function takes `sql` or
// `tx` explicitly and this module never imports @/lib/db/server. Invariant #9:
// EVERY statement over the four new tables carries an `account_id` predicate.
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { getAutoApprovalSettings } from '@/lib/auto-approval/settings';
import type { AutoApprovalThreshold, VetoWindowMinutes } from '@/lib/auto-approval/types';
import { getPendingApprovalCountsForAccount } from '@/lib/dashboard/pending-count';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { readVoiceConfig, type VoiceConfig } from '@/lib/responses/voice-settings';
import { enqueueAgentTurn } from '@/lib/shared/job-outbox-helpers';
import { markOutboxCompletedIfOwned } from '@/lib/shared/outbox';
import { RECENT_COMPLETED_DAYS, readPosted7d } from './context';
import {
  insertProposals,
  insertUnsupported,
  listPendingProposals,
  listProposalsForTurn,
  listUnsupportedForTurn,
  supersedePendingProposals,
  type ProposalRow,
  type UnsupportedRow,
} from './proposals';
import { renderSegments, type RenderedSegment } from './render';
// `markOutboxFailed` is deliberately NOT imported here: it belongs to the
// failed-hook, which owns the failure transition and its ordering.
import { parseReplySegments, TURN_STATUS, type StoredSegment, type TurnFailureReason } from './schema';

type Sql = postgres.Sql;

export interface CreateTurnInput {
  accountId: string;
  actorUserId: string;
  conversationId: string;
  clientTurnKey: string;
  locationId: string;
  text: string;
  correlationId?: string;
}

export type CreateTurnResult =
  | { kind: 'created' | 'existing'; conversationId: string; turnId: string }
  | { kind: 'location_not_found' }
  | { kind: 'conversation_not_found' }
  | { kind: 'turn_key_conflict' };

/** Does a stored turn match this POST byte-for-byte? `text` is compared raw. */
function sameTurnPayload(
  existing: { conversation_id: string; location_id: string; owner_text: string },
  input: CreateTurnInput,
): boolean {
  return existing.conversation_id === input.conversationId
    && existing.location_id === input.locationId
    && existing.owner_text === input.text;
}

/** The unique the turn key owns; migration 120 names it. */
const TURN_KEY_CONSTRAINT = 'agent_turns_account_client_key_uniq';

function isTurnKeyUniqueViolation(error: unknown): boolean {
  const pgError = error as { code?: unknown; constraint_name?: unknown };
  return pgError?.code === '23505' && pgError?.constraint_name === TURN_KEY_CONSTRAINT;
}

/**
 * One transaction: location check → conversation upsert → conversation row lock
 * → idempotency check → sequence → turn INSERT → outbox row (invariant #2).
 *
 * THE ORDER IS LOAD-BEARING, and the obvious order is wrong. Reading the turn
 * key BEFORE taking the conversation lock lets two concurrent identical POSTs
 * both miss `existing`, then serialize on the lock, and the loser's INSERT
 * raises `23505` on `agent_turns_account_client_key_uniq` — a 500 on the exact
 * replay the constraint exists to make a 200. Taking the lock first serializes
 * the two POSTs BEFORE either reads, so the loser sees the winner's row and
 * returns `existing`.
 *
 * The same lock is what makes the sequence safe: it is read under the lock, so
 * two concurrent POSTs can never share one and
 * `agent_turns_conversation_sequence_uniq` is the backstop, not the mechanism.
 *
 * The lock does NOT cover one turn key arriving under two DIFFERENT
 * conversations — those lock different rows. That race is caught as a 23505 by
 * the wrapper below, which is the only reason the wrapper exists.
 *
 * A conversation id the client generated that already exists under ANOTHER
 * account is `conversation_not_found`, never an upsert into the caller's
 * account: the id is client-minted (migration 120), so treating a collision as
 * ownership would hand one account another's transcript.
 */
export async function createTurn(sql: Sql, input: CreateTurnInput): Promise<CreateTurnResult> {
  try {
    return await createTurnInTransaction(sql, input);
  } catch (error) {
    if (!isTurnKeyUniqueViolation(error)) throw error;
    // THE LOCK DOES NOT COVER THIS CASE, which is why the catch exists.
    // Two concurrent POSTs sharing one (account, clientTurnKey) but naming
    // DIFFERENT conversations take FOR UPDATE on different conversation rows,
    // so neither serializes behind the other and both miss the idempotency
    // read. The loser's INSERT then raises 23505 on the turn-key unique — and
    // its transaction is already aborted, so the recovery read must happen out
    // here, on a fresh statement. Re-reading and comparing the payload turns
    // that race back into the 200-or-409 the constraint owes the caller.
    const [existing] = await sql<{
      id: string; conversation_id: string; location_id: string; owner_text: string;
    }[]>`
      SELECT id, conversation_id, location_id, owner_text
      FROM agent_turns
      WHERE account_id = ${input.accountId}::uuid
        AND client_turn_key = ${input.clientTurnKey}::uuid
    `;
    // The winner committed, so the row is there. If it somehow is not, the
    // violation was something this function does not understand: rethrow.
    if (!existing) throw error;
    return sameTurnPayload(existing, input)
      ? { kind: 'existing', conversationId: existing.conversation_id, turnId: existing.id }
      : { kind: 'turn_key_conflict' };
  }
}

async function createTurnInTransaction(sql: Sql, input: CreateTurnInput): Promise<CreateTurnResult> {
  return sql.begin(async (tx): Promise<CreateTurnResult> => {
    const [location] = await tx<{ id: string }[]>`
      SELECT id
      FROM businesses
      WHERE id = ${input.locationId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND archived_at IS NULL
    `;
    if (!location) return { kind: 'location_not_found' };

    await tx`
      INSERT INTO agent_conversations (id, account_id, created_by_user_id)
      VALUES (
        ${input.conversationId}::uuid,
        ${input.accountId}::uuid,
        ${input.actorUserId}::uuid
      )
      ON CONFLICT (id) DO NOTHING
    `;

    const [conversation] = await tx<{ id: string }[]>`
      SELECT id
      FROM agent_conversations
      WHERE id = ${input.conversationId}::uuid
        AND account_id = ${input.accountId}::uuid
      FOR UPDATE
    `;
    // The DO NOTHING above silently loses to a row under another account; the
    // account-scoped re-read is what turns that into a 404.
    if (!conversation) return { kind: 'conversation_not_found' };

    // Idempotent replay, read UNDER the lock: the turn key decides, and it
    // decides account-scoped.
    const [existing] = await tx<{
      id: string; conversation_id: string; location_id: string; owner_text: string;
    }[]>`
      SELECT id, conversation_id, location_id, owner_text
      FROM agent_turns
      WHERE account_id = ${input.accountId}::uuid
        AND client_turn_key = ${input.clientTurnKey}::uuid
    `;
    if (existing) {
      return sameTurnPayload(existing, input)
        ? { kind: 'existing', conversationId: existing.conversation_id, turnId: existing.id }
        : { kind: 'turn_key_conflict' };
    }

    // Indexed access with a non-null assertion rather than the plan's
    // destructure: an aggregate SELECT always returns one row, but
    // noUncheckedIndexedAccess does not know that.
    const sequenceRows = await tx<{ next_sequence: number }[]>`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM agent_turns
      WHERE conversation_id = ${input.conversationId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;
    const nextSequence = sequenceRows[0]!.next_sequence;

    const turnId = uuidv7();
    await tx`
      INSERT INTO agent_turns (
        id, conversation_id, account_id, actor_user_id, location_id,
        client_turn_key, sequence, owner_text, status
      )
      VALUES (
        ${turnId}::uuid,
        ${input.conversationId}::uuid,
        ${input.accountId}::uuid,
        ${input.actorUserId}::uuid,
        ${input.locationId}::uuid,
        ${input.clientTurnKey}::uuid,
        ${nextSequence},
        ${input.text},
        ${TURN_STATUS.ACCEPTED}
      )
    `;

    await tx`
      UPDATE agent_conversations
      SET last_turn_at = NOW()
      WHERE id = ${input.conversationId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;

    await enqueueAgentTurn(tx, {
      turnId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    });

    return { kind: 'created', conversationId: input.conversationId, turnId };
  });
}

// ── Claim / release / fence ───────────────────────────────────────────────

export interface ClaimedTurn {
  turnId: string;
  conversationId: string;
  accountId: string;
  actorUserId: string;
  locationId: string;
  sequence: number;
  ownerText: string;
  attempt: number;
  attemptToken: string;
}

/**
 * The claim (spec §5.2 step 1). Exactly one dispatch wins.
 *
 * `status IN ('accepted','running')` plus the lease predicate is what makes the
 * outbox watchdog's re-dispatch safe: a crashed attempt's row is `running` with
 * a stale `claimed_at`, and the next dispatch takes it over. Returning null is
 * a NORMAL outcome — a live lease is held elsewhere — and the caller must exit
 * without touching the outbox row, which belongs to the holder.
 */
export async function claimTurn(
  sql: Sql,
  input: { turnId: string; accountId: string; leaseSeconds: number },
): Promise<ClaimedTurn | null> {
  const attemptToken = uuidv7();
  const [row] = await sql<{
    id: string; conversation_id: string; account_id: string; actor_user_id: string;
    location_id: string; sequence: number; owner_text: string; attempt: number;
  }[]>`
    UPDATE agent_turns
    SET status = ${TURN_STATUS.RUNNING},
        attempt = attempt + 1,
        attempt_token = ${attemptToken}::uuid,
        claimed_at = NOW()
    WHERE id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND status IN (${TURN_STATUS.ACCEPTED}, ${TURN_STATUS.RUNNING})
      AND (
        claimed_at IS NULL
        OR claimed_at < NOW() - (${input.leaseSeconds} * INTERVAL '1 second')
      )
    RETURNING id, conversation_id, account_id, actor_user_id, location_id,
              sequence, owner_text, attempt
  `;
  if (!row) return null;
  return {
    turnId: row.id,
    conversationId: row.conversation_id,
    accountId: row.account_id,
    actorUserId: row.actor_user_id,
    locationId: row.location_id,
    sequence: row.sequence,
    ownerText: row.owner_text,
    attempt: row.attempt,
    attemptToken,
  };
}

/**
 * Hands the claim back when the predecessor is not terminal yet: status returns
 * to `accepted`, the attempt counter is decremented and the token cleared, so
 * the wait costs nothing and the next dispatch sees a fresh turn. Fenced on the
 * token so a lost lease cannot release someone else's claim.
 */
export async function releaseTurnClaim(
  sql: Sql,
  input: { turnId: string; accountId: string; attemptToken: string },
): Promise<void> {
  await sql`
    UPDATE agent_turns
    SET status = ${TURN_STATUS.ACCEPTED},
        attempt = GREATEST(attempt - 1, 0),
        attempt_token = NULL,
        claimed_at = NULL
    WHERE id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND attempt_token = ${input.attemptToken}::uuid
  `;
}

export interface PredecessorState {
  status: string;
  /** Seconds since the predecessor was claimed, or since it was created. */
  ageSeconds: number;
}

export async function loadPredecessor(
  sql: Sql,
  input: { conversationId: string; accountId: string; sequence: number },
): Promise<PredecessorState | null> {
  const [row] = await sql<{ status: string; age_seconds: number }[]>`
    SELECT
      status,
      EXTRACT(EPOCH FROM (NOW() - COALESCE(claimed_at, created_at)))::int AS age_seconds
    FROM agent_turns
    WHERE conversation_id = ${input.conversationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND sequence = ${input.sequence - 1}
  `;
  return row ? { status: row.status, ageSeconds: row.age_seconds } : null;
}

export function isTerminalTurnStatus(status: string): boolean {
  return status === TURN_STATUS.COMPLETED || status === TURN_STATUS.FAILED;
}

/**
 * The turn's status when a claim missed, account-scoped. `null` means it is
 * still claimable-in-principle (someone holds a live lease); a row means the
 * turn is finished and this dispatch's outbox row has no owner left to
 * complete it.
 */
export async function readTerminalTurn(
  sql: Sql,
  input: { turnId: string; accountId: string },
): Promise<{ status: string } | null> {
  const [row] = await sql<{ status: string }[]>`
    SELECT status
    FROM agent_turns
    WHERE id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND status IN (${TURN_STATUS.COMPLETED}, ${TURN_STATUS.FAILED})
  `;
  return row ?? null;
}

export interface CompleteTurnInput {
  turnId: string;
  accountId: string;
  conversationId: string;
  attemptToken: string;
  /** The STORED union: the model's segments plus any server notice. */
  segments: readonly StoredSegment[];
  proposals: readonly ProposalRow[];
  unsupported: readonly UnsupportedRow[];
  outboxId: string;
  outboxAttempt: number | undefined;
}

/**
 * The fenced completion (spec §5.2 step 7). ONE transaction: the fenced
 * terminal UPDATE, the proposal inserts, the supersession, the unsupported
 * inserts, the conversation touch, and `markOutboxCompletedIfOwned`.
 *
 * `fenced: false` means the lease was lost between the model call and here. The
 * caller discards its output and exits — it must NOT retry, must NOT fail the
 * turn, and must NOT touch the outbox row: the attempt that owns the lease
 * completes it.
 *
 * The reverse asymmetry is deliberate: when the TURN fence matches but
 * `markOutboxCompletedIfOwned` returns false (this dispatch's attempt number
 * was superseded), the domain rows still commit. The turn is genuinely
 * finished, so rolling the reply back to keep an outbox row tidy would throw
 * away real work. The row is then completed by the NEXT dispatch, which finds
 * a terminal turn and takes the `readTerminalTurn` branch in the handler.
 */
export async function completeTurnFenced(
  sql: Sql,
  input: CompleteTurnInput,
): Promise<{ fenced: boolean }> {
  return sql.begin(async (tx) => {
    const fenced = await tx`
      UPDATE agent_turns
      SET status = ${TURN_STATUS.COMPLETED},
          reply = ${tx.json(input.segments as never)},
          failure_reason = NULL,
          completed_at = NOW()
      WHERE id = ${input.turnId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND attempt_token = ${input.attemptToken}::uuid
        AND status = ${TURN_STATUS.RUNNING}
    `;
    if (fenced.count === 0) return { fenced: false };

    await insertProposals(tx, input.proposals);
    await supersedePendingProposals(tx, {
      conversationId: input.conversationId,
      accountId: input.accountId,
      replacements: input.proposals.map((p) => ({
        proposalId: p.id,
        operation: p.operation,
        locationId: p.locationId,
      })),
    });
    await insertUnsupported(tx, input.unsupported);

    await tx`
      UPDATE agent_conversations
      SET last_turn_at = NOW()
      WHERE id = ${input.conversationId}::uuid
        AND account_id = ${input.accountId}::uuid
    `;

    // Claim this exact dispatched attempt in the SAME transaction, so a later
    // failure rolls completion back with the domain writes.
    await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
    return { fenced: true };
  });
}

/** The terminal FAILED transition, fenced the same way. */
export async function failTurnFenced(
  sql: Sql,
  input: {
    turnId: string; accountId: string; attemptToken: string;
    reason: TurnFailureReason; outboxId: string; outboxAttempt: number | undefined;
  },
): Promise<{ fenced: boolean }> {
  return sql.begin(async (tx) => {
    const fenced = await tx`
      UPDATE agent_turns
      SET status = ${TURN_STATUS.FAILED},
          failure_reason = ${input.reason},
          completed_at = NOW()
      WHERE id = ${input.turnId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND attempt_token = ${input.attemptToken}::uuid
        AND status = ${TURN_STATUS.RUNNING}
    `;
    if (fenced.count === 0) return { fenced: false };
    await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
    return { fenced: true };
  });
}

/**
 * The status-guarded FAILED transition, on an open transaction.
 *
 * The two paths that hold NO claim share this: flag-off (the handler returns
 * before claiming) and BullMQ exhaustion (the hook runs after the processor is
 * gone). Neither has an `attempt_token` to present, so `status IN
 * ('accepted','running')` is the guard — it is what keeps either from
 * overwriting a turn that actually completed.
 *
 * It takes `tx`, not `sql`, because each caller has its OWN outbox statement to
 * couple to this one and the two must commit or roll back together. Making the
 * transaction the caller's is what lets both fence on the outbox FIRST and this
 * UPDATE second, inside one `begin`.
 */
export async function failTurnIfNonTerminal(
  tx: postgres.TransactionSql,
  input: { turnId: string; accountId: string; reason: TurnFailureReason },
): Promise<void> {
  await tx`
    UPDATE agent_turns
    SET status = ${TURN_STATUS.FAILED},
        failure_reason = ${input.reason},
        attempt_token = NULL,
        completed_at = NOW()
    WHERE id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND status IN (${TURN_STATUS.ACCEPTED}, ${TURN_STATUS.RUNNING})
  `;
}

/**
 * The flag-off path's whole terminal step: complete the outbox row it owns and
 * fail the turn, in ONE transaction.
 *
 * THE ORDER IS THE POINT, and it is the reverse of the obvious one. The CAS
 * comes FIRST because it answers the only question that matters: does this
 * dispatch still own the row? A watchdog re-dispatch can have superseded this
 * attempt while it sat in the queue, and a newer attempt may be running with
 * the flag back ON. Failing the turn before asking would kill that live
 * attempt's work from a job that lost ownership. When the CAS returns false
 * NOTHING is written — not the turn, not the row.
 *
 * The hook does NOT use this — it needs `markOutboxFailed`, a different
 * terminal transition, so it opens its own `begin` around
 * `failTurnIfNonTerminal` with the same ordering.
 */
export async function failTurnAndCompleteOutbox(
  sql: Sql,
  input: {
    turnId: string;
    accountId: string;
    reason: TurnFailureReason;
    outboxId: string;
    outboxAttempt: number | undefined;
  },
): Promise<void> {
  await sql.begin(async (tx) => {
    const owns = await markOutboxCompletedIfOwned(tx, input.outboxId, input.outboxAttempt);
    if (!owns) return;
    await failTurnIfNonTerminal(tx, input);
  });
}

// ── The owner reads ───────────────────────────────────────────────────────

export interface OwnerTurnView {
  id: string;
  status: string;
  failureReason: string | null;
  locationId: string;
  segments: RenderedSegment[];
  proposals: Awaited<ReturnType<typeof listProposalsForTurn>>;
  unsupported: Awaited<ReturnType<typeof listUnsupportedForTurn>>;
}

/**
 * The polled read. Account-scoped: a turn under another account returns null,
 * which the route renders as a 404 — indistinguishable from one that does not
 * exist, so the read cannot be used to probe for other tenants' ids.
 *
 * NO metrics read happens here, and that is the design. A stored `status`
 * segment carries the value, its reporting period and the instant it was read
 * at, frozen at fenced completion; re-resolving a metric name now would paint
 * TODAY's count — for whatever location the caller passed — onto a sentence the
 * model wrote days ago. The pasted-review notice is stored the same way, so a
 * refresh renders it again rather than re-deriving it.
 */
export async function getTurnForOwner(
  sql: Sql,
  input: { turnId: string; accountId: string },
): Promise<OwnerTurnView | null> {
  const [row] = await sql<{
    id: string; status: string; failure_reason: string | null; location_id: string;
    reply: unknown;
  }[]>`
    SELECT id, status, failure_reason, location_id, reply
    FROM agent_turns
    WHERE id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
  `;
  if (!row) return null;

  // Sequential by design: these share one pooled connection, and
  // CLAUDE.md's ci:pool-fanout rule forbids a Promise combinator over
  // DB-issuing elements.
  const proposals = await listProposalsForTurn(sql, input);
  const unsupported = await listUnsupportedForTurn(sql, input);
  const locations = await getLocationsForAccount(sql, input.accountId);

  return {
    id: row.id,
    status: row.status,
    failureReason: row.failure_reason,
    locationId: row.location_id,
    segments: renderSegments(parseReplySegments(row.reply), {
      proposalIds: proposals.map((p) => p.id),
      locations: locations.map((l) => ({ id: l.id, name: l.name })),
    }),
    proposals,
    unsupported,
  };
}

export interface OwnerConversationTurn {
  id: string;
  sequence: number;
  status: string;
  failureReason: string | null;
  /** The owner's message, stored VERBATIM — the scrub is a read-path transform. */
  ownerText: string;
  segments: RenderedSegment[];
}

export interface OwnerConversationView {
  conversation: { id: string; lastTurnAt: string | null };
  turns: OwnerConversationTurn[];
  summary: {
    pending: { pendingCount: number; draftsWaiting: number };
    recent: { posted7d: number; reportingPeriodDays: number };
    rules: {
      threshold: AutoApprovalThreshold | null;
      // `| null` beyond the plan's `VetoWindowMinutes`: the union is `15 | 30`
      // with no null member, and the no-turns branch below has no location to
      // scope a rule read to. Null there means "no rules to report", the same
      // reading `threshold: null` already carries.
      vetoWindowMinutes: VetoWindowMinutes | null;
      dailyCap: number;
      locationOverrideExists: boolean;
    };
    facts: VoiceConfig | null;
    pendingProposals: Awaited<ReturnType<typeof listPendingProposals>>;
    asOf: string;
  };
}

/**
 * The transcript plus the summary-panel reads.
 *
 * Without `conversationId`, returns the actor's most recent conversation for
 * this account — `idx_agent_conversations_account_recent` is
 * `(account_id, created_by_user_id, last_turn_at DESC)` for exactly this order.
 *
 * `asOf` is the METRICS' own timestamp, never a second `new Date()`: a number
 * and the instant it was read must not be able to disagree.
 */
export async function getConversationForOwner(
  sql: Sql,
  input: { accountId: string; actorUserId: string; conversationId?: string },
): Promise<OwnerConversationView | null> {
  const [conversation] = input.conversationId
    ? await sql<{ id: string; last_turn_at: Date | string | null }[]>`
        SELECT id, last_turn_at
        FROM agent_conversations
        WHERE id = ${input.conversationId}::uuid
          AND account_id = ${input.accountId}::uuid
      `
    : await sql<{ id: string; last_turn_at: Date | string | null }[]>`
        SELECT id, last_turn_at
        FROM agent_conversations
        WHERE account_id = ${input.accountId}::uuid
          AND created_by_user_id = ${input.actorUserId}::uuid
        ORDER BY last_turn_at DESC NULLS LAST
        LIMIT 1
      `;
  if (!conversation) return null;

  const turnRows = await sql<{
    id: string; sequence: number; status: string; failure_reason: string | null;
    location_id: string; owner_text: string; reply: unknown;
  }[]>`
    SELECT id, sequence, status, failure_reason, location_id, owner_text, reply
    FROM agent_turns
    WHERE conversation_id = ${conversation.id}::uuid
      AND account_id = ${input.accountId}::uuid
    ORDER BY sequence ASC
  `;

  // The panel is scoped to the MOST RECENT turn's location: the selector may
  // have moved since, and the transcript's own target is what the owner is
  // looking at. With no turns yet there is nothing to scope to and the summary
  // is omitted rather than guessed.
  const latest = turnRows[turnRows.length - 1];
  if (!latest) {
    return {
      conversation: { id: conversation.id, lastTurnAt: nullableIso(conversation.last_turn_at) },
      turns: [],
      summary: {
        pending: { pendingCount: 0, draftsWaiting: 0 },
        recent: { posted7d: 0, reportingPeriodDays: RECENT_COMPLETED_DAYS },
        rules: { threshold: null, vetoWindowMinutes: null, dailyCap: 0, locationOverrideExists: false },
        facts: null,
        pendingProposals: [],
        asOf: new Date().toISOString(),
      },
    };
  }

  const proposalIdsByTurn = new Map<string, string[]>();
  for (const turn of turnRows) {
    const proposals = await listProposalsForTurn(sql, {
      turnId: turn.id,
      accountId: input.accountId,
    });
    proposalIdsByTurn.set(turn.id, proposals.map((p) => p.id));
  }

  // The SUMMARY panel is a live read and says so with `asOf` — spec §3.1 names
  // `getPendingApprovalCountsForAccount` as its source, and reusing the
  // dashboard's own helper (src/lib/dashboard/pending-count.ts:35) is what
  // keeps the panel's numbers equal to the dashboard's. This is a different
  // question from the TRANSCRIPT, whose `status` segments are frozen values
  // the renderer passes through untouched; the two must not share a source.
  //
  // Sequential by design, like the loop above: one pooled connection, and
  // ci:pool-fanout forbids a Promise combinator over DB-issuing elements.
  const pendingByLocation = await getPendingApprovalCountsForAccount(sql, input.accountId);
  const posted7d = await readPosted7d(sql, {
    accountId: input.accountId,
    locationId: latest.location_id,
  });
  const locations = await getLocationsForAccount(sql, input.accountId);
  const settings = await getAutoApprovalSettings(sql, {
    accountId: input.accountId,
    impersonated: false,
  });
  const locationSettings = settings.locations.find((l) => l.locationId === latest.location_id);
  const facts = await readVoiceConfig(sql, {
    accountId: input.accountId,
    locationId: latest.location_id,
  });
  const pendingProposals = await listPendingProposals(sql, {
    conversationId: conversation.id,
    accountId: input.accountId,
  });

  let draftsWaiting = 0;
  for (const count of pendingByLocation.values()) draftsWaiting += count;
  const asOf = new Date().toISOString();

  return {
    conversation: { id: conversation.id, lastTurnAt: nullableIso(conversation.last_turn_at) },
    turns: turnRows.map((turn) => ({
      id: turn.id,
      sequence: turn.sequence,
      status: turn.status,
      failureReason: turn.failure_reason,
      ownerText: turn.owner_text,
      // A pure mapping: no metrics, because every stored `status` segment
      // already carries the value it was written with.
      segments: renderSegments(parseReplySegments(turn.reply), {
        proposalIds: proposalIdsByTurn.get(turn.id) ?? [],
        locations: locations.map((l) => ({ id: l.id, name: l.name })),
      }),
    })),
    summary: {
      pending: {
        pendingCount: pendingByLocation.get(latest.location_id) ?? 0,
        draftsWaiting,
      },
      recent: { posted7d, reportingPeriodDays: RECENT_COMPLETED_DAYS },
      // `effective`, never `override`: an inheriting location still has rules.
      rules: {
        threshold: locationSettings?.effective.threshold ?? settings.accountDefault.threshold,
        vetoWindowMinutes:
          locationSettings?.effective.vetoWindowMinutes ?? settings.accountDefault.vetoWindowMinutes,
        dailyCap:
          locationSettings?.effective.effectiveDailyCap ?? settings.accountDefault.effectiveDailyCap,
        locationOverrideExists: locationSettings?.override.exists ?? false,
      },
      facts,
      pendingProposals,
      asOf,
    },
  };
}

function nullableIso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}
