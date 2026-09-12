// Owner Operator turn persistence. Invariant #15: every function takes `sql` or
// `tx` explicitly and this module never imports @/lib/db/server. Invariant #9:
// EVERY statement over the four new tables carries an `account_id` predicate.
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { enqueueAgentTurn } from '@/lib/shared/job-outbox-helpers';
import { TURN_STATUS } from './schema';

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
