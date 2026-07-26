/**
 * Atomic watch-mode Solicitation batch construction.
 *
 * Preparation establishes exact outbox ownership and an attributable parent
 * run. Construction then completion-CASes that same attempt before taking the
 * batch and per-Business locks, evaluates one bounded accumulated-pool window,
 * and commits every authoritative ask plus its run graph as one unit.
 *
 * No contact PII is copied into evidence, run JSONB, results, or logs.
 */

import { v7 as uuidv7 } from 'uuid';
import type { Sql, TransactionSql } from 'postgres';
import {
  completeSolicitationBatchRun,
  failSolicitationBatchRun,
  recordCompletedChildRuns,
  startOrGetSolicitationBatchRun,
} from '@/lib/agents/run-spine';
import {
  getOffboardingState,
  isProcessingBlocked,
  lockAccountBeforeOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import {
  lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned,
} from '@/lib/shared/outbox';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { MAX_DATA_ROWS } from './contacts-csv';
import { solicitationWatchEnabled } from './flags';
import {
  evaluateBatch,
  WITHHOLD_REASONS,
  type AskCandidate,
  type AskDecision,
  type WithholdReason,
} from './restraint-policy';

interface BuildSolicitationBatchInput {
  batchId: string;
  businessId: string;
  outboxId: string;
  attempt: number;
  correlationId?: string;
}

export interface BuiltSolicitationBatchResult {
  status: 'built';
  candidateCount: number;
  // Total business contact pool at build time; poolCount > candidateCount
  // means the MAX_DATA_ROWS evaluation window truncated (S4: never silent).
  poolCount: number;
  sendCount: number;
  withholdCount: number;
  withheldByReason: Record<WithholdReason, number>;
}

type ClosedGateReason =
  | 'flag_disabled'
  | 'subscription_inactive'
  | 'account_offboarding_blocked';

export type BuildSolicitationBatchResult =
  | BuiltSolicitationBatchResult
  | { status: 'stale' }
  | { status: 'missing' }
  | { status: 'already_built' }
  | {
      status: 'gate_closed';
      reason: ClosedGateReason;
      parentTerminalized: boolean;
    };

interface BatchPreparationRow {
  id: string;
  account_id: string;
  business_id: string;
  built_at: string | null;
}

interface ConstructionBatchRow {
  id: string;
  account_id: string;
  business_id: string;
  built_at: string | null;
}

interface CandidateWindowRow {
  contact_id: string;
  last_visit_date: string;
  upload_id: string;
  consent_attested: boolean;
}

interface PriorSendRow {
  contact_id: string;
  prior_batch_id: string | null;
  prior_decision_at: string | null;
}

interface ReadyPreparation {
  status: 'ready';
  parentRunId: string;
  accountId: string;
  businessId: string;
}

type PreparationResult =
  | ReadyPreparation
  | Exclude<BuildSolicitationBatchResult, BuiltSolicitationBatchResult>;

function closedGateReason(
  subscriptionStatus: string,
  processingBlocked: boolean,
): ClosedGateReason | null {
  if (processingBlocked) return 'account_offboarding_blocked';
  if (!solicitationWatchEnabled()) return 'flag_disabled';
  if (!subscriptionGrantsFullAccess(subscriptionStatus)) return 'subscription_inactive';
  return null;
}

/**
 * Sole owner of the batch gate: locks the account row, projects offboarding,
 * and derives the closed-gate reason. Preparation and construction each call it
 * once — the double evaluation is deliberate, and construction's re-check is
 * the load-bearing one, so the result is never cached across the two
 * transactions.
 *
 * Lock order: this takes the `accounts` row lock, so it MUST be called before
 * any other row lock in the same transaction (in preparation, before the
 * `agent_runs` SELECT … FOR UPDATE). Calling it later would invert the
 * accounts-then-agent_runs order that the rest of the lane assumes.
 */
async function evaluateBatchGate(
  tx: TransactionSql,
  ids: { batchId: string; accountId: string },
): Promise<ClosedGateReason | null> {
  const accountExists = await lockAccountBeforeOffboardingProjection(
    tx,
    ids.accountId,
  );
  if (!accountExists) {
    throw new Error(
      `solicitation batch builder: account missing for batch ${ids.batchId}`,
    );
  }

  const [account] = await tx<{ subscription_status: string }[]>`
    SELECT subscription_status
    FROM accounts
    WHERE id = ${ids.accountId}::uuid
  `;
  if (!account) {
    throw new Error(
      `solicitation batch builder: account missing for batch ${ids.batchId}`,
    );
  }

  const offboardingState = await getOffboardingState(ids.accountId, tx);
  return closedGateReason(
    account.subscription_status,
    isProcessingBlocked(offboardingState),
  );
}

async function deleteUnbuiltBatch(
  tx: TransactionSql,
  ids: { batchId: string; accountId: string; businessId: string },
): Promise<void> {
  await tx`
    DELETE FROM solicitation_batches
    WHERE id = ${ids.batchId}::uuid
      AND account_id = ${ids.accountId}::uuid
      AND business_id = ${ids.businessId}::uuid
      AND built_at IS NULL
  `;
}

async function completeOwnedAttempt(
  tx: TransactionSql,
  input: BuildSolicitationBatchInput,
): Promise<boolean> {
  return markOutboxCompletedIfOwned(tx, input.outboxId, input.attempt);
}

async function prepareBatch(
  sql: Sql,
  input: BuildSolicitationBatchInput,
): Promise<PreparationResult> {
  return sql.begin(async (tx) => {
    const ownsAttempt = await lockDispatchedOutboxAttemptIfOwned(
      tx,
      input.outboxId,
      input.attempt,
    );
    if (!ownsAttempt) return { status: 'stale' };

    const [batch] = await tx<BatchPreparationRow[]>`
      SELECT
        sb.id,
        sb.account_id,
        sb.business_id,
        sb.built_at::text AS built_at
      FROM solicitation_batches sb
      WHERE sb.id = ${input.batchId}::uuid
        AND sb.business_id = ${input.businessId}::uuid
      FOR UPDATE OF sb
    `;
    if (!batch) {
      await completeOwnedAttempt(tx, input);
      return { status: 'missing' };
    }
    if (batch.built_at !== null) {
      await completeOwnedAttempt(tx, input);
      return { status: 'already_built' };
    }

    // Before the agent_runs lock below: evaluateBatchGate takes the accounts
    // row lock, and this transaction's order is accounts-then-agent_runs.
    const gateReason = await evaluateBatchGate(tx, {
      batchId: batch.id,
      accountId: batch.account_id,
    });

    const [activeParent] = await tx<{ id: string }[]>`
      SELECT id
      FROM agent_runs
      WHERE account_id = ${batch.account_id}::uuid
        AND business_id = ${batch.business_id}::uuid
        AND kind = 'solicitation_batch'
        AND subject_type = 'solicitation_batch'
        AND subject_id = ${batch.id}
        AND status = 'running'
      FOR UPDATE
    `;

    if (gateReason !== null) {
      const completed = await completeOwnedAttempt(tx, input);
      if (!completed) return { status: 'stale' };

      if (activeParent) {
        await failSolicitationBatchRun(tx, {
          runId: activeParent.id,
          failure: {
            code: 'gate_closed',
            gate: gateReason,
          },
        });
      }
      await deleteUnbuiltBatch(tx, {
        batchId: batch.id,
        accountId: batch.account_id,
        businessId: batch.business_id,
      });
      return {
        status: 'gate_closed',
        reason: gateReason,
        parentTerminalized: activeParent !== undefined,
      };
    }

    if (activeParent) {
      return {
        status: 'ready',
        parentRunId: activeParent.id,
        accountId: batch.account_id,
        businessId: batch.business_id,
      };
    }

    const parent = await startOrGetSolicitationBatchRun(tx, {
      batchId: batch.id,
      accountId: batch.account_id,
      businessId: batch.business_id,
      correlationId: input.correlationId,
    });
    return {
      status: 'ready',
      parentRunId: parent.runId,
      accountId: batch.account_id,
      businessId: batch.business_id,
    };
  });
}

function toCandidate(
  row: CandidateWindowRow,
  priorSend: PriorSendRow | undefined,
): AskCandidate {
  return {
    contactId: row.contact_id,
    lastVisitDate: row.last_visit_date,
    consent: {
      attested: row.consent_attested,
      uploadId: row.upload_id,
    },
    suppression: null,
    matchedReview: null,
    priorBatch:
      priorSend !== undefined &&
      priorSend.prior_batch_id !== null &&
      priorSend.prior_decision_at !== null
        ? {
            batchId: priorSend.prior_batch_id,
            decidedAt: priorSend.prior_decision_at,
          }
        : null,
  };
}

interface CandidatePool {
  candidates: AskCandidate[];
  // Total business contact pool, independent of the window truncation.
  poolCount: number;
}

/**
 * Sole owner of the **Batch candidate window**: each batch draws from the whole
 * accumulated location pool, ordered least-recently-evaluated first and bounded
 * to MAX_DATA_ROWS. Also reports the untruncated pool size so a truncated
 * window is never silent (S4), and joins each candidate's most recent prior
 * send so the restraint policy can reason about repeat asks.
 *
 * Reads only under the caller's batch row lock and per-Business advisory lock.
 * Returns no contact PII beyond the ids the policy needs.
 */
async function loadCandidatePool(
  tx: TransactionSql,
  ids: { accountId: string; businessId: string },
): Promise<CandidatePool> {
  const { accountId, businessId } = ids;

  const candidateWindow = await tx<CandidateWindowRow[]>`
    SELECT
      c.id::text AS contact_id,
      latest_visit.visit_date::text AS last_visit_date,
      latest_visit.upload_id::text AS upload_id,
      (
        u.status = 'completed'
        AND u.attested_at IS NOT NULL
        AND u.attestation_version IS NOT NULL
      ) AS consent_attested
    FROM solicitation_contacts c
    JOIN solicitation_visits latest_visit
      ON latest_visit.contact_id = c.id
     AND latest_visit.business_id = ${businessId}::uuid
     AND latest_visit.id = (
       SELECT candidate_visit.id
       FROM solicitation_visits candidate_visit
       JOIN contact_csv_uploads candidate_upload
         ON candidate_upload.id = candidate_visit.upload_id
        AND candidate_upload.account_id = ${accountId}::uuid
        AND candidate_upload.business_id = ${businessId}::uuid
        AND candidate_upload.status = 'completed'
       WHERE candidate_visit.contact_id = c.id
         AND candidate_visit.business_id = ${businessId}::uuid
       ORDER BY
         candidate_visit.visit_date DESC,
         candidate_visit.upload_id ASC,
         candidate_visit.id ASC
       LIMIT 1
     )
    JOIN contact_csv_uploads u
      ON u.id = latest_visit.upload_id
     AND u.account_id = ${accountId}::uuid
     AND u.business_id = ${businessId}::uuid
     AND u.status = 'completed'
    LEFT JOIN solicitation_asks latest_evaluation
      ON latest_evaluation.contact_id = c.id
     AND latest_evaluation.account_id = ${accountId}::uuid
     AND latest_evaluation.business_id = ${businessId}::uuid
     AND latest_evaluation.id = (
       SELECT candidate_ask.id
       FROM solicitation_asks candidate_ask
       WHERE candidate_ask.contact_id = c.id
         AND candidate_ask.account_id = ${accountId}::uuid
         AND candidate_ask.business_id = ${businessId}::uuid
       ORDER BY
         candidate_ask.decided_at DESC,
         candidate_ask.id DESC
       LIMIT 1
     )
    WHERE c.business_id = ${businessId}::uuid
    ORDER BY
      latest_evaluation.decided_at ASC NULLS FIRST,
      latest_visit.visit_date DESC,
      c.id ASC
    LIMIT ${MAX_DATA_ROWS}
  `;

  const [poolRow] = await tx<{ pool_count: number }[]>`
    SELECT count(*)::int AS pool_count
    FROM solicitation_contacts
    WHERE business_id = ${businessId}::uuid
  `;
  const poolCount = poolRow?.pool_count ?? candidateWindow.length;

  const contactIds = candidateWindow.map((candidate) => candidate.contact_id);
  let priorSends: PriorSendRow[] = [];
  if (contactIds.length > 0) {
    priorSends = await tx<PriorSendRow[]>`
      SELECT DISTINCT ON (send_ask.contact_id)
        send_ask.contact_id::text AS contact_id,
        send_ask.batch_id::text AS prior_batch_id,
        send_ask.decided_at::text AS prior_decision_at
      FROM solicitation_asks send_ask
      WHERE send_ask.business_id = ${businessId}::uuid
        AND send_ask.contact_id = ANY(${contactIds}::uuid[])
        AND send_ask.status = 'send'
      ORDER BY
        send_ask.contact_id,
        send_ask.decided_at DESC,
        send_ask.id DESC
    `;
  }

  const priorSendsByContact = new Map(
    priorSends.map((priorSend) => [priorSend.contact_id, priorSend]),
  );
  return {
    candidates: candidateWindow.map((candidate) =>
      toCandidate(candidate, priorSendsByContact.get(candidate.contact_id)),
    ),
    poolCount,
  };
}

function emptyReasonCounts(): Record<WithholdReason, number> {
  return Object.fromEntries(
    WITHHOLD_REASONS.map((reason) => [reason, 0]),
  ) as Record<WithholdReason, number>;
}

function summarize(
  decisions: readonly AskDecision[],
  poolCount: number,
): BuiltSolicitationBatchResult {
  const withheldByReason = emptyReasonCounts();
  let sendCount = 0;
  for (const decision of decisions) {
    if (decision.decision === 'send') {
      sendCount += 1;
    } else {
      withheldByReason[decision.reason] += 1;
    }
  }
  return {
    status: 'built',
    candidateCount: decisions.length,
    poolCount,
    sendCount,
    withholdCount: decisions.length - sendCount,
    withheldByReason,
  };
}

interface BatchIdentity {
  id: string;
  accountId: string;
  businessId: string;
}

/**
 * Sole owner of the authoritative ask write: the `solicitation_asks` rows, the
 * completed child runs, and the ask→run link are one atomicity unit. Each write
 * asserts its own affected-row count, so a partially applied set aborts the
 * caller's transaction rather than producing an ask without a run (or a run
 * without a link).
 *
 * Ask and run ids are minted here because the link depends on both; the caller
 * never needs them. No contact PII beyond `contact_id` reaches the row set.
 */
async function commitAskDecisions(
  tx: TransactionSql,
  args: {
    batch: BatchIdentity;
    parentRunId: string;
    decisions: readonly AskDecision[];
    decidedAt: string;
  },
): Promise<void> {
  const { batch, parentRunId, decisions, decidedAt } = args;

  const askIds = decisions.map(() => uuidv7());
  const runIds = decisions.map(() => uuidv7());
  const askRows = decisions.map((decision, index) => ({
    id: askIds[index]!,
    account_id: batch.accountId,
    business_id: batch.businessId,
    batch_id: batch.id,
    contact_id: decision.contact_id,
    status: decision.decision,
    withheld_reason: decision.decision === 'withhold' ? decision.reason : null,
    evidence: decision,
    decided_at: decidedAt,
  }));

  if (askRows.length > 0) {
    const insertedAsks = await tx<{ id: string }[]>`
      INSERT INTO solicitation_asks (
        id, account_id, business_id, batch_id, contact_id,
        status, withheld_reason, evidence, decided_at
      )
      SELECT
        ask.id,
        ask.account_id,
        ask.business_id,
        ask.batch_id,
        ask.contact_id,
        ask.status,
        ask.withheld_reason,
        ask.evidence,
        ask.decided_at
      FROM jsonb_to_recordset(${tx.json(askRows as never)}) AS ask(
        id uuid,
        account_id uuid,
        business_id uuid,
        batch_id uuid,
        contact_id uuid,
        status text,
        withheld_reason text,
        evidence jsonb,
        decided_at timestamptz
      )
      RETURNING id
    `;
    if (insertedAsks.count !== askRows.length) {
      throw new Error(
        `solicitation batch builder: expected ${askRows.length} asks, inserted ${insertedAsks.count}`,
      );
    }
  }

  await recordCompletedChildRuns(tx, {
    accountId: batch.accountId,
    businessId: batch.businessId,
    parentRunId,
    children: decisions.map((decision, index) =>
      decision.decision === 'send'
        ? {
            runId: runIds[index]!,
            askId: askIds[index]!,
            decision: 'send',
          }
        : {
            runId: runIds[index]!,
            askId: askIds[index]!,
            decision: 'withhold',
            withheldReason: decision.reason,
          },
    ),
  });

  if (askRows.length > 0) {
    const linkedAsks = await tx<{ id: string }[]>`
      UPDATE solicitation_asks ask
      SET agent_run_id = link.run_id
      FROM unnest(
        ${askIds}::uuid[],
        ${runIds}::uuid[]
      ) AS link(ask_id, run_id)
      WHERE ask.id = link.ask_id
        AND ask.batch_id = ${batch.id}::uuid
        AND ask.account_id = ${batch.accountId}::uuid
        AND ask.business_id = ${batch.businessId}::uuid
      RETURNING ask.id
    `;
    if (linkedAsks.count !== askRows.length) {
      throw new Error(
        `solicitation batch builder: expected ${askRows.length} linked asks, updated ${linkedAsks.count}`,
      );
    }
  }
}

async function constructBatch(
  sql: Sql,
  input: BuildSolicitationBatchInput,
  preparation: ReadyPreparation,
): Promise<BuildSolicitationBatchResult> {
  return sql.begin(async (tx) => {
    // Ownership CAS is deliberately the first statement in construction.
    const ownsAttempt = await completeOwnedAttempt(tx, input);
    if (!ownsAttempt) return { status: 'stale' };

    const [batch] = await tx<ConstructionBatchRow[]>`
      SELECT
        sb.id,
        sb.account_id,
        sb.business_id,
        sb.built_at::text AS built_at
      FROM solicitation_batches sb
      WHERE sb.id = ${input.batchId}::uuid
        AND sb.account_id = ${preparation.accountId}::uuid
        AND sb.business_id = ${preparation.businessId}::uuid
      FOR UPDATE OF sb
    `;
    if (!batch) return { status: 'missing' };
    if (batch.built_at !== null) return { status: 'already_built' };

    // This namespace is intentionally distinct from csv_ingest_<business>.
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtext(${`solicitation_batch_${batch.business_id}`})
      )
    `;

    const accountId = batch.account_id;
    const businessId = batch.business_id;
    // Re-evaluated here on purpose: this is the load-bearing check, taken under
    // the batch row lock and the per-Business advisory lock.
    const gateReason = await evaluateBatchGate(tx, {
      batchId: batch.id,
      accountId,
    });
    if (gateReason !== null) {
      await failSolicitationBatchRun(tx, {
        runId: preparation.parentRunId,
        failure: {
          code: 'gate_closed',
          gate: gateReason,
        },
      });
      await deleteUnbuiltBatch(tx, {
        batchId: batch.id,
        accountId,
        businessId,
      });
      return {
        status: 'gate_closed',
        reason: gateReason,
        parentTerminalized: true,
      };
    }

    const [business] = await tx<{ category: string | null }[]>`
      SELECT category
      FROM businesses
      WHERE id = ${businessId}::uuid
        AND account_id = ${accountId}::uuid
    `;
    if (!business) {
      throw new Error(
        `solicitation batch builder: Business missing for batch ${batch.id}`,
      );
    }

    const { candidates, poolCount } = await loadCandidatePool(tx, {
      accountId,
      businessId,
    });

    const decidedAt = new Date().toISOString();
    const decisions = evaluateBatch(
      candidates,
      {
        decidedAt,
        businessCategory: business.category,
      },
    );
    const summary = summarize(decisions, poolCount);

    await commitAskDecisions(tx, {
      batch: { id: batch.id, accountId, businessId },
      parentRunId: preparation.parentRunId,
      decisions,
      decidedAt,
    });

    await completeSolicitationBatchRun(tx, {
      runId: preparation.parentRunId,
      accountId: batch.account_id,
      businessId: batch.business_id,
      batchId: batch.id,
      candidateCount: summary.candidateCount,
      sendCount: summary.sendCount,
      withholdCount: summary.withholdCount,
      withheldByReason: summary.withheldByReason,
    });

    const built = await tx<{ id: string }[]>`
      UPDATE solicitation_batches
      SET built_at = ${decidedAt}::timestamptz
      WHERE id = ${batch.id}::uuid
        AND account_id = ${batch.account_id}::uuid
        AND business_id = ${batch.business_id}::uuid
        AND built_at IS NULL
      RETURNING id
    `;
    if (built.count !== 1) {
      throw new Error(
        `solicitation batch builder: expected to build batch ${batch.id}, updated ${built.count}`,
      );
    }

    return summary;
  });
}

/**
 * Build one Solicitation batch. Returns only PII-free status/count aggregates;
 * the caller may log the result without exposing contact data.
 */
export async function buildSolicitationBatch(
  sql: Sql,
  input: BuildSolicitationBatchInput,
): Promise<BuildSolicitationBatchResult> {
  const preparation = await prepareBatch(sql, input);
  if (preparation.status !== 'ready') return preparation;
  return constructBatch(sql, input, preparation);
}
