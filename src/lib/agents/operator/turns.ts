// Owner Operator turn WRITES: `createTurn`'s transaction, the claim / release /
// predecessor protocol and the terminal transitions. The account-scoped owner
// READS live in `reads.ts`.
//
// Invariant #15: every function takes `sql` or `tx` explicitly and this module
// never imports @/lib/db/server. Invariant #9: EVERY statement over the four
// new tables carries an `account_id` predicate.
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { enqueueAgentTurn } from '@/lib/shared/job-outbox-helpers';
import { markOutboxCompletedIfOwned } from '@/lib/shared/outbox';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import type { SnapshotMetrics } from './context';
import { completeOperatorRefusals } from './refusal-completion';
import { materializeReply, type ParsedRestoreRequest } from './render';
import { createRestoreProposalInTransaction } from './restore';
import {
  insertProposals,
  insertUnsupported,
  supersedePendingProposals,
  type ProposalRow,
  type UnsupportedRow,
} from './proposals';
// `markOutboxFailed` is deliberately NOT imported here: it belongs to the
// failed-hook, which owns the failure transition and its ordering.
import {
  TURN_STATUS,
  TURN_FAILURE_REASON,
  asTurnStatus,
  type StoredSegment,
  type Segment,
  type TurnFailureReason,
  type TurnStatus,
} from './schema';

type Sql = postgres.Sql;

/**
 * The poller calls this only for terminal CAS winners, on the same transaction.
 * Read identities from that stored row; reject malformed account UUIDs and
 * compare other payload identities as text without unsafe casts. Live or locked
 * work retains a recoverable outbox, including if the worker later crashes.
 */
export async function reconcileTurnForFailedOutbox(
  tx: postgres.TransactionSql,
  outboxId: string,
  leaseSeconds: number,
): Promise<'failed' | 'deferred' | 'unchanged'> {
  const [outbox] = await tx<{
    account_id: string | null; conversation_id: string | null; turn_id: string;
  }[]>`
    SELECT payload->>'account_id' AS account_id,
           payload->>'conversation_id' AS conversation_id,
           aggregate_id::text AS turn_id
    FROM job_outbox
    WHERE id = ${outboxId}::uuid AND status = 'failed'
      AND topic = ${QUEUE_NAMES.AGENT_TURN} AND aggregate_type = topic
      AND aggregate_id::text = payload->>'turn_id'
  `;
  if (!outbox) return 'unchanged';
  const accountId = z.uuid().safeParse(outbox.account_id);
  if (!accountId.success) return 'unchanged';
  const [locked] = await tx<{ status: string; expired: boolean }[]>`
    SELECT status, COALESCE(claimed_at < NOW() - make_interval(secs => ${leaseSeconds}), false) AS expired
    FROM agent_turns
    WHERE id = ${outbox.turn_id}::uuid AND account_id = ${accountId.data}::uuid
      AND conversation_id::text = ${outbox.conversation_id}
    FOR UPDATE SKIP LOCKED
  `;
  // Completion locks turn before outbox. Never wait for that lock in reverse
  // order, and never mistake SKIP LOCKED for an absent turn.
  const [visible] = locked ? [locked] : await tx<{ status: string }[]>`
    SELECT status FROM agent_turns
    WHERE id = ${outbox.turn_id}::uuid AND account_id = ${accountId.data}::uuid
      AND conversation_id::text = ${outbox.conversation_id}
  `;
  if (!visible || (visible.status !== TURN_STATUS.ACCEPTED && visible.status !== TURN_STATUS.RUNNING)) return 'unchanged';
  if (!locked || (locked.status === TURN_STATUS.RUNNING && !locked.expired)) {
    await tx`
      UPDATE job_outbox
      SET status = 'dispatched', completed_at = NULL, dispatched_at = NOW()
      WHERE id = ${outboxId}::uuid AND status = 'failed'
    `;
    return 'deferred';
  }
  // The current turn claim is locked: no renewal can race this expiry decision.
  await tx`
    UPDATE agent_turns
    SET status = ${TURN_STATUS.FAILED},
        failure_reason = ${TURN_FAILURE_REASON.DISPATCH_EXHAUSTED},
        attempt_token = NULL, claimed_at = NULL, completed_at = NOW()
    WHERE id = ${outbox.turn_id}::uuid
      AND account_id = ${accountId.data}::uuid
      AND conversation_id::text = ${outbox.conversation_id}
  `;
  return 'failed';
}

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
 * Yields only the current turn token and its exact outbox attempt together.
 * A failed outbox can follow an ambiguous enqueue while the worker is running;
 * reconcile that failure when the worker yields, never kill its live work from
 * the poller. Healthy releases cost no claim attempt or queue retry.
 */
export async function releaseTurnClaim(
  sql: Sql,
  input: {
    turnId: string; accountId: string; attemptToken: string;
    outboxId: string; outboxAttempt: number | undefined; leaseSeconds: number;
    /** Only a healthy predecessor recheck proves liveness; transient errors do not. */
    refreshLiveness?: boolean;
  },
): Promise<'released' | 'failed' | 'lost'> {
  const outboxAttempt = input.outboxAttempt;
  if (outboxAttempt === undefined) return 'lost';
  return sql.begin(async (tx) => {
    const [outbox] = await tx<{ status: string; conversation_id: string | null }[]>`
      SELECT status, payload->>'conversation_id' AS conversation_id
      FROM job_outbox
      WHERE id = ${input.outboxId}::uuid AND attempts = ${outboxAttempt}
        AND status IN ('dispatching', 'dispatched', 'failed') -- outbox-status-audit-ignore: claim yield includes terminal failure reconciliation, not the in-flight dedup set
        AND topic = ${QUEUE_NAMES.AGENT_TURN} AND aggregate_type = topic
        AND aggregate_id::text = ${input.turnId}
        AND payload->>'turn_id' = ${input.turnId}
        AND payload->>'account_id' = ${input.accountId}
      FOR UPDATE
    `;
    if (!outbox) return 'lost';
    // Fenced completion takes turn then outbox. Do not wait for a turn it
    // already owns while holding the reverse order; let that writer finish.
    const [turn] = await tx<{ id: string }[]>`
      SELECT id FROM agent_turns
      WHERE id = ${input.turnId}::uuid AND account_id = ${input.accountId}::uuid
        AND conversation_id::text = ${outbox.conversation_id}
        AND attempt_token = ${input.attemptToken}::uuid
        AND status = ${TURN_STATUS.RUNNING}
      FOR UPDATE SKIP LOCKED
    `;
    if (!turn) return 'lost';
    await tx`
      UPDATE agent_turns
      SET status = ${TURN_STATUS.ACCEPTED}, attempt = GREATEST(attempt - 1, 0),
          attempt_token = NULL, claimed_at = NULL
      WHERE id = ${input.turnId}::uuid AND account_id = ${input.accountId}::uuid
        AND attempt_token = ${input.attemptToken}::uuid
        AND status = ${TURN_STATUS.RUNNING}
    `;
    if (outbox.status === 'failed') {
      const reconciled = await reconcileTurnForFailedOutbox(tx, input.outboxId, input.leaseSeconds);
      if (reconciled !== 'failed') throw new Error('operator yielded claim lost its locked outbox identity');
      return 'failed';
    }
    if (input.refreshLiveness) {
      await tx`
        UPDATE job_outbox SET dispatched_at = NOW()
        WHERE id = ${input.outboxId}::uuid AND attempts = ${outboxAttempt}
          AND status IN ('dispatching', 'dispatched') -- outbox-status-audit-ignore: only an already claimed dispatch can heartbeat; pending is not worker-owned
      `;
    }
    return 'released';
  });
}

export interface PredecessorState {
  status: TurnStatus;
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
  return row ? { status: asTurnStatus(row.status), ageSeconds: row.age_seconds } : null;
}

/** `TurnStatus`, not `string`: `isTerminalTurnStatus('completd')` must not compile. */
export function isTerminalTurnStatus(status: TurnStatus): boolean {
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
): Promise<{ status: TurnStatus } | null> {
  const [row] = await sql<{ status: string }[]>`
    SELECT status
    FROM agent_turns
    WHERE id = ${input.turnId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND status IN (${TURN_STATUS.COMPLETED}, ${TURN_STATUS.FAILED})
  `;
  return row ? { status: asTurnStatus(row.status) } : null;
}

export interface TurnReplyPlan {
  segments: readonly Segment[];
  metrics: SnapshotMetrics;
  scrubbed: boolean;
  /** Original model indices; null slots are filled by fenced Restore preparation. */
  proposalIds: readonly (string | null)[];
  restoreRequests: readonly ParsedRestoreRequest[];
}

export interface CompleteTurnInput {
  turnId: string;
  accountId: string;
  conversationId: string;
  attemptToken: string;
  /** The STORED union: the model's segments plus any server notice. */
  segments: readonly StoredSegment[];
  replyPlan?: TurnReplyPlan;
  proposals: readonly ProposalRow[];
  unsupported: readonly UnsupportedRow[];
  outboxId: string;
  outboxAttempt: number | undefined;
}

interface CompletedTurnRow {
  account_id: string;
  actor_user_id: string;
  location_id: string;
  conversation_id: string;
  completed_at: Date;
}

type ProposalReplacement = { proposalId: string; operation: string; locationId: string | null };

async function prepareFencedRestores(
  tx: postgres.TransactionSql,
  turn: CompletedTurnRow,
  turnId: string,
  plan: TurnReplyPlan,
): Promise<{ proposalIds: (string | null)[]; replacements: ProposalReplacement[]; restoreUnavailable: boolean }> {
  const proposalIds = [...plan.proposalIds];
  const replacements: ProposalReplacement[] = [];
  let restoreUnavailable = false;
  // All allowed location requests target this one stored business. Acquire its
  // lock before an account-only request can acquire the account lock first.
  const requests = [...plan.restoreRequests].sort((a, b) => Number(a.scope.locationId === undefined) - Number(b.scope.locationId === undefined));
  for (const request of requests) {
    if (request.scope.accountId !== turn.account_id
      || (request.scope.locationId !== undefined && request.scope.locationId !== turn.location_id)
      || !Number.isInteger(request.index) || request.index < 0 || request.index >= proposalIds.length
      || proposalIds[request.index] !== null) {
      throw new Error('agents/operator: restore request does not match the winning turn');
    }
    const result = await createRestoreProposalInTransaction(tx, {
      accountId: turn.account_id,
      actorUserId: turn.actor_user_id,
      locationId: request.scope.locationId ?? null,
      owner: { conversationId: turn.conversation_id, turnId },
    });
    if (result.kind !== 'prepared') {
      restoreUnavailable = true;
      continue;
    }
    proposalIds[request.index] = result.proposal.id;
    replacements.push({ proposalId: result.proposal.id, operation: result.proposal.operation, locationId: result.proposal.locationId });
  }
  return { proposalIds, replacements, restoreUnavailable };
}

async function materializeFencedReply(
  tx: postgres.TransactionSql,
  input: CompleteTurnInput,
  turn: CompletedTurnRow,
): Promise<ProposalReplacement[]> {
  if (!input.replyPlan) {
    if (input.segments.some((segment) => segment.type === 'refusal')) {
      throw new Error('agents/operator: refusal subjects require fenced ledger materialization');
    }
    return [];
  }
  const plan = input.replyPlan;
  const restored = await prepareFencedRestores(tx, turn, input.turnId, plan);
  const refusalIds = await completeOperatorRefusals(tx, {
    turn: { accountId: turn.account_id, locationId: turn.location_id },
    // The fence stores NOW() on this same transaction. Passing its returned
    // JS Date back would silently discard PostgreSQL's microseconds.
    decidedAt: 'transaction_time',
    references: plan.segments.filter((segment) => segment.type === 'refusal_ref'),
  });
  const reply = materializeReply({ ...plan, ...restored, refusalIds });
  await tx`
    UPDATE agent_turns SET reply = ${tx.json(reply as never)}
    WHERE id = ${input.turnId}::uuid AND account_id = ${turn.account_id}::uuid
      AND attempt_token = ${input.attemptToken}::uuid AND status = ${TURN_STATUS.COMPLETED}
  `;
  return restored.replacements;
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
    const [completed] = await tx<CompletedTurnRow[]>`
      UPDATE agent_turns
      SET status = ${TURN_STATUS.COMPLETED},
          reply = ${tx.json(input.segments as never)},
          failure_reason = NULL,
          completed_at = NOW()
      WHERE id = ${input.turnId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND attempt_token = ${input.attemptToken}::uuid
        AND status = ${TURN_STATUS.RUNNING}
      RETURNING account_id, actor_user_id, location_id, conversation_id, completed_at
    `;
    if (!completed) return { fenced: false };

    const restored = await materializeFencedReply(tx, input, completed);
    await insertProposals(tx, input.proposals);
    await supersedePendingProposals(tx, {
      conversationId: completed.conversation_id,
      accountId: input.accountId,
      // Every proposal of THIS turn is exempt: two same-scope proposals in one
      // reply are siblings, not a correction of one another.
      turnId: input.turnId,
      replacements: [...input.proposals.map((p) => ({
        proposalId: p.id,
        operation: p.operation,
        locationId: p.locationId,
      })), ...restored],
    });
    await insertUnsupported(tx, input.unsupported);

    await tx`
      UPDATE agent_conversations
      SET last_turn_at = NOW()
      WHERE id = ${completed.conversation_id}::uuid
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
