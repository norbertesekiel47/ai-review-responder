// e2e/helpers/operator-seed.ts
//
// The WORKER STAND-IN for the Operator e2e flows. A Playwright run has no
// Railway worker and no provider key, so these helpers do with SQL what
// `AgentTurnWorker` would have done — but THROUGH THE PRODUCTION BUILDERS, not
// by hand-typing rows.
//
// That distinction is the point. `AgentTurnWorker` builds a Proposal from
// `readVoiceConfig`'s result (`worker/jobs/agent-turn/AgentTurnWorker.ts:211-214`),
// whose type is `VoiceConfig & { updatedAt }`; `preview` returns that object as
// `before` and spreads it into `after` (`src/lib/agents/operator/catalog.ts:96-98`);
// and `buildProposalRows` stores both (`src/lib/agents/operator/proposals.ts:77-78`).
// A hand-typed five-key fixture silently omits that sixth key and cannot catch
// a reader that rejects the real shape. So the helper calls the same three
// functions the worker calls.
//
// The OWNER still sends the turn, through the UI. This file only completes it.
import { buildProposalRows, insertProposals } from '@/lib/agents/operator/proposals';
import { proposableOperation } from '@/lib/agents/operator/catalog';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { getE2eSql } from '../seed';

export interface CompletedTurn {
  conversationId: string;
  turnId: string;
  proposalId: string;
  /** The token the card will send back on Apply. */
  versionToken: { businessId: string; updatedAt: string };
}

/** The most recent non-terminal turn for an account — the one the UI just POSTed. */
export async function findAcceptedTurn(accountId: string): Promise<{
  id: string; conversationId: string; locationId: string; ownerText: string;
}> {
  const sql = getE2eSql();
  const [row] = await sql<{
    id: string; conversation_id: string; location_id: string; owner_text: string;
  }[]>`
    SELECT id, conversation_id, location_id, owner_text
    FROM agent_turns
    WHERE account_id = ${accountId}::uuid
      AND status IN ('accepted', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!row) throw new Error('operator-seed: no accepted turn — did the UI send one?');
  return {
    id: row.id,
    conversationId: row.conversation_id,
    locationId: row.location_id,
    ownerText: row.owner_text,
  };
}

/**
 * Completes an ALREADY-SENT turn the way the worker would: one `set_tone`
 * **Proposal** built by `buildProposalRows`, and a stored reply whose
 * `proposal` segment references it.
 */
export async function completeTurnWithProposal(input: {
  accountId: string;
  userId: string;
  tone?: string;
}): Promise<CompletedTurn> {
  const sql = getE2eSql();
  const turn = await findAcceptedTurn(input.accountId);
  const tone = input.tone ?? 'warm and brief';

  const voice = await readVoiceConfig(sql, {
    accountId: input.accountId,
    locationId: turn.locationId,
  });
  if (!voice) throw new Error('operator-seed: voice row not found');

  const operation = proposableOperation('set_tone');
  if (!operation) throw new Error('operator-seed: set_tone left the catalog');
  const parsed = operation.parseInput({ tone });
  if (!parsed.ok) throw new Error('operator-seed: set_tone rejected its own input');

  const rows = buildProposalRows(
    {
      conversationId: turn.conversationId,
      turnId: turn.id,
      accountId: input.accountId,
      actorUserId: input.userId,
      locationId: turn.locationId,
    },
    [{
      operation,
      input: parsed.input,
      scope: { accountId: input.accountId, locationId: turn.locationId },
      rationale: 'You asked for warmer replies.',
    }],
    voice,
  );
  const proposal = rows[0];
  if (!proposal) throw new Error('operator-seed: buildProposalRows returned nothing');

  await sql.begin(async (tx) => {
    await insertProposals(tx, rows);
    await tx`
      UPDATE agent_turns
      SET status = 'completed',
          reply = ${tx.json([
            { type: 'text', text: 'Here is a plan for your reply tone.' },
            { type: 'proposal', proposalId: proposal.id },
          ] as never)},
          completed_at = NOW()
      WHERE id = ${turn.id}::uuid AND account_id = ${input.accountId}::uuid
    `;
  });

  return {
    conversationId: turn.conversationId,
    turnId: turn.id,
    proposalId: proposal.id,
    versionToken: { businessId: turn.locationId, updatedAt: voice.updatedAt },
  };
}

/**
 * Moves `businesses.updated_at` the way a settings-form PUT would — the STALE
 * fixture. It writes a real voice column so the move is a genuine write and
 * not a bare timestamp touch, which is what a real concurrent edit looks like.
 */
export async function moveVoiceRow(input: {
  accountId: string;
  businessId: string;
  tone: string;
}): Promise<void> {
  const sql = getE2eSql();
  await sql`
    UPDATE businesses
    SET tone = ${input.tone}, updated_at = NOW()
    WHERE id = ${input.businessId}::uuid AND account_id = ${input.accountId}::uuid
  `;
}

/** Row-state assertions the browser flow checks its claims against. */
export async function readProposalRow(proposalId: string): Promise<{
  status: string; failure_reason: string | null; receipt: unknown; decided_by_user_id: string | null;
}> {
  const sql = getE2eSql();
  const [row] = await sql<{
    status: string; failure_reason: string | null; receipt: unknown; decided_by_user_id: string | null;
  }[]>`
    SELECT status, failure_reason, receipt, decided_by_user_id
    FROM agent_proposals WHERE id = ${proposalId}::uuid
  `;
  if (!row) throw new Error('operator-seed: proposal row not found');
  return row;
}

export async function readTone(businessId: string): Promise<string | null> {
  const sql = getE2eSql();
  const [row] = await sql<{ tone: string | null }[]>`
    SELECT tone FROM businesses WHERE id = ${businessId}::uuid
  `;
  return row?.tone ?? null;
}

export async function countTurns(accountId: string): Promise<number> {
  const sql = getE2eSql();
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM agent_turns WHERE account_id = ${accountId}::uuid
  `;
  return row?.count ?? 0;
}

/**
 * Removes every row these helpers created for one account. Runs BEFORE
 * `deleteOwnerUser`, which deletes the businesses and the account those rows
 * reference by foreign key.
 */
export async function cleanupOperatorSeed(accountId: string): Promise<void> {
  const sql = getE2eSql();
  await sql`DELETE FROM agent_unsupported_requests WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_proposals WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_turns WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_conversations WHERE account_id = ${accountId}::uuid`;
}
