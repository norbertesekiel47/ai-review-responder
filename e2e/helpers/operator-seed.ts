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
import { readPolicySnapshot } from '@/lib/agents/operator/policy-state';
import type { VersionToken } from '@/lib/agents/operator/version-token';
import { completeRun, recordStep, startOrGetActiveRun } from '@/lib/agents/run-spine';
import { getAutoApprovalSettings } from '@/lib/auto-approval/settings';
import { POLICY_ACTION_POSTING, POLICY_PERSONA_REPLY } from '@/lib/auto-approval/types';
import { readVoiceConfig } from '@/lib/responses/voice-settings';
import { randomUUID } from 'node:crypto';
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

/** Synthetic history on this test's disposable account; no generation jobs. */
export async function seedPolicyHistory(input: { accountId: string; businessId: string }): Promise<void> {
  const sql = getE2eSql();
  await sql.begin(async (tx) => {
    await tx`UPDATE accounts SET subscription_tier = 'autopilot' WHERE id = ${input.accountId}::uuid`;
    const fixtures = [
      { stars: 5, origin: 'live' },
      { stars: 4, origin: 'live' },
      { stars: 3, origin: 'live' },
      { stars: 5, origin: 'imported' },
      { stars: 5, origin: null },
    ] as const;
    for (const fixture of fixtures) {
      const reviewId = randomUUID();
      await tx`
        INSERT INTO reviews (
          id, business_id, provider, provider_review_id, provider_review_name,
          provider_location_name, reviewer_name, star_rating, review_text,
          review_date, detected_at, status
        ) VALUES (
          ${reviewId}::uuid, ${input.businessId}::uuid, 'google', ${reviewId},
          ${`e2e-operator-policy/${reviewId}`}, ${`e2e-operator-policy/${input.businessId}`},
          'Synthetic Operator reviewer', ${fixture.stars}, 'Synthetic policy consequence fixture.',
          NOW() - interval '1 day', NOW() - interval '1 day', 'new'
        )
      `;
      if (fixture.origin === null) continue;
      // The newly inserted review is owned by this transaction before its
      // first spine write. The initial marker survives later draft actions.
      const run = await startOrGetActiveRun(tx, {
        kind: 'review_handler', subjectType: 'review', subjectId: reviewId,
        accountId: input.accountId, businessId: input.businessId,
      });
      await recordStep(tx, {
        runId: run.runId, stepKey: 'review_ingested',
        detail: { ingestion_origin: fixture.origin },
      });
      await completeRun(tx, run.runId, 'completed');
    }
  });
}

/** Prepares the same account-default expansion that a validated worker turn builds. */
export async function completeTurnWithPolicyProposal(input: {
  accountId: string;
  userId: string;
}): Promise<Omit<CompletedTurn, 'versionToken'> & { versionToken: VersionToken }> {
  const sql = getE2eSql();
  const turn = await findAcceptedTurn(input.accountId);
  const voice = await readVoiceConfig(sql, { accountId: input.accountId, locationId: turn.locationId });
  const snapshot = await readPolicySnapshot(sql, { accountId: input.accountId, locationId: null });
  if (!voice || !snapshot) throw new Error('operator-seed: policy target or voice row not found');
  const { readiness } = await getAutoApprovalSettings(sql, { accountId: input.accountId, impersonated: false });
  if (!readiness.canExpand) {
    throw new Error(`operator-seed: expansion needs a ready test app: ${readiness.blockReasons.join(', ')}`);
  }
  const operation = proposableOperation('set_auto_reply_scope');
  if (!operation) throw new Error('operator-seed: set_auto_reply_scope left the catalog');
  const parsed = operation.parseInput({ threshold: 4 });
  if (!parsed.ok) throw new Error('operator-seed: scope operation rejected its own input');
  const rows = buildProposalRows({
    conversationId: turn.conversationId, turnId: turn.id,
    accountId: input.accountId, actorUserId: input.userId, locationId: turn.locationId,
  }, [{
    operation, input: parsed.input, scope: { accountId: input.accountId },
    rationale: 'You asked to auto-reply to 4 and 5 star reviews at all locations.',
  }], voice, new Map([[null, { snapshot, blockReasons: readiness.blockReasons }]]));
  const proposal = rows[0];
  if (!proposal) throw new Error('operator-seed: policy builder returned nothing');
  await sql.begin(async (tx) => {
    await insertProposals(tx, rows);
    await tx`
      UPDATE agent_turns SET status = 'completed', completed_at = NOW(),
        reply = ${tx.json([{ type: 'proposal', proposalId: proposal.id }] as never)}
      WHERE id = ${turn.id}::uuid AND account_id = ${input.accountId}::uuid
    `;
  });
  return { conversationId: turn.conversationId, turnId: turn.id,
    proposalId: proposal.id, versionToken: proposal.preparedVersionToken };
}

/** Independent persisted outcomes: rejection/replay must not add a policy audit. */
export async function readPolicyOutcomes(accountId: string): Promise<{
  policy_rows: number; threshold: number | null; policy_audits: number; reviews: number;
}> {
  const sql = getE2eSql();
  const [row] = await sql<{
    policy_rows: number; threshold: number | null; policy_audits: number; reviews: number;
  }[]>`
    SELECT
      (SELECT COUNT(*)::int FROM auto_approval_policies
        WHERE account_id = ${accountId}::uuid AND persona = ${POLICY_PERSONA_REPLY}
          AND action_class = ${POLICY_ACTION_POSTING} AND location_id IS NULL) AS policy_rows,
      (SELECT auto_approve_min_star FROM auto_approval_policies
        WHERE account_id = ${accountId}::uuid AND persona = ${POLICY_PERSONA_REPLY}
          AND action_class = ${POLICY_ACTION_POSTING} AND location_id IS NULL) AS threshold,
      (SELECT COUNT(*)::int FROM account_audit_log
        WHERE account_id = ${accountId}::uuid AND event_type = 'auto_approval_policy_changed') AS policy_audits,
      (SELECT COUNT(*)::int FROM reviews r JOIN businesses b ON b.id = r.business_id
        WHERE b.account_id = ${accountId}::uuid) AS reviews
  `;
  if (!row) throw new Error('operator-seed: policy outcome query returned nothing');
  return row;
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
  await sql`DELETE FROM job_outbox WHERE payload->>'account_id' = ${accountId}`;
  await sql`DELETE FROM agent_unsupported_requests WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_proposals WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_turns WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_conversations WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM auto_approval_policies WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM account_audit_log WHERE account_id = ${accountId}::uuid`;
  await sql`DELETE FROM agent_runs WHERE account_id = ${accountId}::uuid`;
}
