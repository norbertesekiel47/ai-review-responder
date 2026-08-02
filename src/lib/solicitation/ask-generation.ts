/**
 * Ask-generation orchestration (#628): the deep module behind the
 * `generate_solicitation_asks` topic. Two doors:
 *
 *  - `generateAsksForBatch` — whole-batch generation, enqueued by the build
 *    transaction (EXEC D21). Children run SEQUENTIALLY (SPEC §7.3 — no shared
 *    reply concurrency slot), each through the same per-child pipeline:
 *    interpolation (§1.1) → cost guard → LLM → footer assembly → lint (§2) →
 *    moderation (§3) → one `solicitation_outreach` row.
 *  - `regenerateAsk` — the per-ask LLM re-roll (SPEC §8.2, AMEND B2), with NO
 *    transaction spanning the LLM call (decision 7).
 *
 * Idempotency is the DATABASE, not Redis (SPEC §7.4): before reserving a cent,
 * each ask is probed for ANY non-cancelled outreach row — stricter than the
 * spec's "live render" wording by locked decision 5, because a `withheld` row
 * is terminal for the batch and must never be re-generated on retry.
 *
 * Outbox contract (decisions 8+9): the FINALE transaction completes the owned
 * outbox attempt itself, CAS FIRST (`markOutboxCompletedIfOwned` as the
 * transaction's first statement — batch-builder `constructBatch` precedent);
 * a false CAS is a stale attempt and aborts with ZERO domain writes. Every
 * no-op early return also completes the attempt in a minimal transaction — a
 * no-op is a SUCCESS, never a stranded dispatched row.
 *
 * Lock order (AMEND B11 + closeBatchIfSettled contract): outbox CAS (job_outbox
 * row — no purge stage holds the advisory key across it) → per-business
 * advisory lock → batch row FOR UPDATE → spine (agent_runs) locks. Batch → run
 * is the sole order in this lane; recordGenerationSteps/recordStep lock the
 * parent run row, so the batch row lock is always taken first.
 *
 * Domain module (invariant #15): takes `sql: Sql` explicitly; every query is
 * tenant-scoped by the payload's business_id (the tenant proof — a bare batch
 * UUID proves nothing) plus the account_id resolved from the batch row.
 */

import type { Fragment, Sql, TransactionSql } from 'postgres';
import {
  lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned,
  markOutboxFailed,
} from '@/lib/shared/outbox';
import { createWorkerLogger } from '@/lib/shared/logger';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import {
  isSubscriptionTier,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import { withCostGuard } from '@/lib/costs/cost-guard';
import {
  checkAskRegenBudget,
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  RegenBudgetExceededError,
} from '@/lib/costs/tracker';
import { calculateCostUsd, recordApiCost } from '@/lib/costs/audit';
import { LLMStructuredOutputError, runLlmTask } from '@/lib/llm/run-task';
import type { LLMCallResult } from '@/lib/llm/types';
import { moderateResponse } from '@/lib/moderation/moderate';
import type { ModerationDecision } from '@/lib/moderation/output-filter';
import { openaiModerationEnabled } from '@/lib/moderation/flags';
import {
  recordGenerationSteps,
  recordStep,
  startOrGetSolicitationSendBatchRun,
} from '@/lib/agents/run-spine';
import { solicitationSendEnabled } from './flags';
import { acquireSolicitationBatchLock } from './batch-builder';
import {
  ASK_LINT_VERSION,
  assessNoteAdmissibility,
  lintAsk,
  type AskLintClass,
} from './ask-compliance-lint';
import { assembleAskBody } from './ask-render';
import {
  buildAskPrompt,
  daysSinceVisitBucket,
  SOLICITATION_ASK_PROMPT_VERSION,
  solicitationAskPromptHash,
  type AskInterpolationInputs,
} from './ask-prompt-policy';
import { SolicitationAskOutputSchema } from './ask-schema';
import { resolveVertical } from './restraint-policy';
import {
  closeBatchIfSettled,
  deriveBatchState,
  insertOutreachRender,
  supersedeLiveRender,
  type BatchLifecycleRow,
  type BatchState,
  type CloseBatchIfSettledResult,
  type InsertOutreachRenderInput,
  type OutreachModerationStatus,
  type RenderWithholdReason,
} from './outreach';

/**
 * Task-scoped pessimistic reservation — SPEC §7.1/§7.2: ~40× the actual
 * ~0.024¢ ask cost, covering the Anthropic fallback and a long admissible
 * note. NEVER the tracker's 15¢ reply estimate: 25 children × 15¢ would
 * reserve $3.75 per batch and ~26 batches would trip the GLOBAL breaker,
 * halting reply generation platform-wide.
 */
export const SOLICITATION_ASK_ESTIMATE_CENTS = 1;

/**
 * `extractOutboxHandle`'s result (src/lib/shared/outbox.ts). Part of this
 * module's interface because the finale transaction completes the owned
 * attempt itself (decision 9) — the handle is the module's to spend, not the
 * worker handler's. Declared here (structurally identical) because
 * shared/outbox.ts is outside this ticket's edit surface.
 */
export interface OutboxHandle {
  outboxId: string;
  /** undefined for legacy BullMQ jobs enqueued before the attempt-guard rollout. */
  attempt: number | undefined;
}

export interface GenerateAsksResult {
  rendered: number;
  withheld: number;
  failed: number;
  skippedExisting: number;
}

export interface GenerateAsksForBatchInput {
  batchId: string;
  /** Tenant proof from the queue payload (invariant #8) — the batch UUID
   *  alone proves nothing; every query is scoped by it. */
  businessId: string;
  outboxHandle: OutboxHandle;
  correlationId?: string;
}

export interface RegenerateAskInput {
  batchId: string;
  businessId: string;
  askId: string;
  outboxHandle: OutboxHandle;
  correlationId?: string;
}

// ── Context loading ──────────────────────────────────────────────────────────

interface BatchGenerationContext {
  batchId: string;
  accountId: string;
  businessId: string;
  subscriptionStatus: string;
  subscriptionTier: SubscriptionTierValue;
  businessName: string;
  businessCategory: string | null;
  postalAddress: string | null;
  lifecycle: BatchLifecycleRow;
}

interface BatchContextRow {
  id: string;
  account_id: string;
  business_id: string;
  subscription_status: string;
  subscription_tier: string;
  business_name: string;
  business_category: string | null;
  postal_address: string | null;
  built_at: Date | null;
  approved_at: Date | null;
  veto_deadline_at: Date | null;
  sending_started_at: Date | null;
  send_closed_at: Date | null;
  halted_at: Date | null;
}

async function loadBatchContext(
  sql: Sql,
  batchId: string,
  businessId: string,
): Promise<BatchGenerationContext | null> {
  const [row] = await sql<BatchContextRow[]>`
    SELECT
      sb.id,
      sb.account_id,
      sb.business_id,
      a.subscription_status,
      a.subscription_tier,
      b.name AS business_name,
      b.category AS business_category,
      -- #627 lands businesses.solicitation_postal_address; until that
      -- migration is at head everywhere, this jsonb projection reads NULL
      -- instead of raising 42703 — the lane stays inert-but-executable and a
      -- NULL postal address fails the render closed (missing_required_element,
      -- #622 §7.6). Replace with a direct column read once #627 has landed.
      to_jsonb(b) ->> 'solicitation_postal_address' AS postal_address,
      sb.built_at,
      sb.approved_at,
      sb.veto_deadline_at,
      sb.sending_started_at,
      sb.send_closed_at,
      sb.halted_at
    FROM solicitation_batches sb
    JOIN businesses b ON b.id = ${businessId}::uuid AND b.account_id = sb.account_id
    JOIN accounts a ON a.id = b.account_id
    WHERE sb.id = ${batchId}::uuid
      AND sb.business_id = ${businessId}::uuid
  `;
  if (!row) return null;
  if (!isSubscriptionTier(row.subscription_tier)) {
    throw new Error(
      `ask generation: invalid subscription tier for batch ${batchId}`,
    );
  }
  return {
    batchId: row.id,
    accountId: row.account_id,
    businessId: row.business_id,
    subscriptionStatus: row.subscription_status,
    subscriptionTier: row.subscription_tier,
    businessName: row.business_name,
    businessCategory: row.business_category,
    postalAddress: row.postal_address,
    lifecycle: {
      built_at: row.built_at,
      approved_at: row.approved_at,
      veto_deadline_at: row.veto_deadline_at,
      sending_started_at: row.sending_started_at,
      send_closed_at: row.send_closed_at,
      halted_at: row.halted_at,
    },
  };
}

interface SendAskRow {
  ask_id: string;
  contact_id: string;
  decided_at: Date;
  contact_name: string;
  visit_date: string | null;
  visit_note: string | null;
}

/**
 * NEW query on purpose (SPEC §1.1): the existing candidate window deliberately
 * selects no PII, so generation loads its own inputs — contact name (only the
 * first whitespace token ever reaches the model) and the LATEST visit per
 * contact. LEFT JOIN so a send ask that somehow lost its visit surfaces as a
 * legible render_failed row instead of silently vanishing from the batch.
 *
 * The tenant scope lives INSIDE this shared fragment (not in the callers) so
 * the ci:tenant-scope audit — which analyzes each sql template as one unit —
 * sees every referenced table scoped where it is read.
 */
const sendAskQuery = (
  sql: Sql | TransactionSql,
  ctx: BatchGenerationContext,
  extra: Fragment,
) => sql<SendAskRow[]>`
  SELECT
    ask.id AS ask_id,
    ask.contact_id,
    ask.decided_at,
    c.name AS contact_name,
    v.visit_date::text AS visit_date,
    v.note AS visit_note
  FROM solicitation_asks ask
  JOIN solicitation_contacts c
    ON c.id = ask.contact_id AND c.business_id = ${ctx.businessId}::uuid
  LEFT JOIN solicitation_visits v
    ON v.contact_id = ask.contact_id
   AND v.business_id = ${ctx.businessId}::uuid
   AND v.id = (
     SELECT sv.id
     FROM solicitation_visits sv
     WHERE sv.contact_id = ask.contact_id
       AND sv.business_id = ${ctx.businessId}::uuid
     ORDER BY sv.visit_date DESC, sv.id DESC
     LIMIT 1
   )
  WHERE ask.batch_id = ${ctx.batchId}::uuid
    AND ask.account_id = ${ctx.accountId}::uuid
    AND ask.business_id = ${ctx.businessId}::uuid
    AND ask.status = 'send'
    ${extra}
`;

async function loadSendAsks(
  sql: Sql,
  ctx: BatchGenerationContext,
): Promise<SendAskRow[]> {
  return sendAskQuery(sql, ctx, sql`ORDER BY ask.created_at, ask.id`);
}

async function loadSendAskById(
  sql: Sql,
  ctx: BatchGenerationContext,
  askId: string,
): Promise<SendAskRow | null> {
  const rows = await sendAskQuery(sql, ctx, sql`AND ask.id = ${askId}::uuid`);
  return rows[0] ?? null;
}

interface ExistingRenderProbe {
  nonCancelled: number;
  maxAttempt: number;
}

/**
 * The SPEC §7.4 idempotency probe, per locked decision 5: ANY non-cancelled
 * outreach row — live OR terminal — means this ask was already decided and a
 * retried job must not reserve a cent for it. `maxAttempt` spans cancelled
 * rows too, so an insert after a supersede history lands at max + 1 instead
 * of colliding on attempt_no.
 */
async function probeExistingRenders(
  sql: Sql,
  ctx: BatchGenerationContext,
  askId: string,
): Promise<ExistingRenderProbe> {
  const [row] = await sql<{ non_cancelled: number; max_attempt: number }[]>`
    SELECT
      COUNT(*) FILTER (WHERE delivery_status <> 'cancelled')::int AS non_cancelled,
      COALESCE(MAX(attempt_no), 0)::int AS max_attempt
    FROM solicitation_outreach
    WHERE ask_id = ${askId}::uuid
      AND account_id = ${ctx.accountId}::uuid
      AND business_id = ${ctx.businessId}::uuid
  `;
  return {
    nonCancelled: row?.non_cancelled ?? 0,
    maxAttempt: row?.max_attempt ?? 0,
  };
}

// ── Per-child pipeline ───────────────────────────────────────────────────────

interface AssembledChild {
  inputs: AskInterpolationInputs;
  /** Every §1.1 value the prompt saw — the lint's §2.5 exemption corpus. */
  interpolationValues: string[];
  /** The PII-capable subset barred from the subject (B5): the admitted note. */
  subjectDisallowedValues: string[];
}

/**
 * Build the §1.1 interpolation snapshot. Returns null when the ask has no
 * visit on file — the inputs cannot be assembled and the caller withholds
 * `render_failed` with an empty snapshot.
 *
 * The bucket instant is the ask row's `decided_at` (SPEC §1.1 "batch
 * decided_at" — the restraint decision instant), NOT the render clock:
 * deterministic across job retries, and the phrasing the owner approves is
 * anchored to the decision the policy actually made.
 */
function assembleInterpolation(
  ctx: BatchGenerationContext,
  ask: SendAskRow,
): AssembledChild | null {
  if (ask.visit_date === null) return null;
  const firstName = ask.contact_name.trim().split(/\s+/)[0] ?? '';
  const { vertical } = resolveVertical(ctx.businessCategory);
  const visitDate = new Date(`${ask.visit_date}T00:00:00Z`);
  const bucket = daysSinceVisitBucket(visitDate, ask.decided_at);
  const note = assessNoteAdmissibility(ask.visit_note);
  const visitNote = note.admissible ? ask.visit_note : null;

  const inputs: AskInterpolationInputs = {
    contact_first_name: firstName,
    business_name: ctx.businessName,
    days_since_visit_bucket: bucket,
    vertical,
    visit_note: visitNote,
    note_disposition: note.disposition,
  };
  return {
    inputs,
    interpolationValues: [
      firstName,
      ctx.businessName,
      bucket,
      vertical,
      ...(visitNote !== null ? [visitNote] : []),
    ],
    subjectDisallowedValues: visitNote !== null ? [visitNote] : [],
  };
}

interface ChildLlmMeta {
  provider: LLMCallResult['provider'];
  model: string;
  usage: LLMCallResult['usage'];
  costUsd: number;
  latencyMs: number;
}

interface ChildRenderShared {
  lintDetail: readonly AskLintClass[];
  moderationStatus: OutreachModerationStatus;
  moderationDetail: Record<string, unknown>;
  interpolationInputs: AskInterpolationInputs | Record<string, never>;
  /**
   * Every provider completion the child was BILLED for — one api_costs row
   * each. A successful render carries exactly one; a structured-output
   * failure carries one per validation-failed attempt (primary + fallback);
   * empty when no provider ever returned tokens (never ran, transport
   * failure, budget stop).
   */
  llmAttempts: readonly ChildLlmMeta[];
}

type ChildRenderOutcome = ChildRenderShared &
  (
    | { status: 'rendered'; dispositionReason?: null; subject: string; body: string }
    | {
        status: 'withheld';
        dispositionReason: RenderWithholdReason;
        subject: string | null;
        body: string | null;
      }
  );

/**
 * Locked decision-2 fills for a child whose render never produced an artifact:
 * subject/body NULL, `lint_detail` `[]`, `moderation_status` 'error' (091 has
 * no "not run" member; candidate vocabulary widening is recorded in the
 * deviations file), `moderation_detail` `{}`, and the snapshot the prompt saw
 * — or `{}` when the ask was never assembled (budget-stop rows, decision 6).
 */
function renderFailedOutcome(
  inputs: AskInterpolationInputs | Record<string, never>,
  llmAttempts: readonly ChildLlmMeta[] = [],
): ChildRenderOutcome {
  return {
    status: 'withheld',
    dispositionReason: 'render_failed',
    subject: null,
    body: null,
    lintDetail: [],
    moderationStatus: 'error',
    moderationDetail: {},
    interpolationInputs: inputs,
    llmAttempts,
  };
}

function moderationDetailOf(decision: ModerationDecision): Record<string, unknown> {
  return {
    flagged: decision.flagged,
    severity: decision.severity,
    reason: decision.reason,
    categories: decision.categories,
    score: decision.score,
    source: decision.source,
    provider_status: decision.providerStatus,
  };
}

/**
 * One child through reserve → LLM → assembly → lint → moderation.
 *
 * Returns an outcome for every TERMINAL-per-child result (rendered, withheld,
 * render_failed — SPEC §7.5's LLMStructuredOutputError arm). Throws upward
 * everything the CALLER must classify: TransientLLMError /
 * CostInfraUnavailableError (BullMQ retry), CostLimitExceededError /
 * GlobalCostLimitExceededError (decision 6 budget stop).
 */
async function generateChildRender(
  ctx: BatchGenerationContext,
  assembled: AssembledChild,
): Promise<ChildRenderOutcome> {
  const prompt = buildAskPrompt(assembled.inputs);

  type GuardedLlm =
    | { kind: 'ok'; result: LLMCallResult; usd: number; ms: number }
    | { kind: 'structured_failure'; attempts: readonly ChildLlmMeta[] };

  const guarded = await withCostGuard<GuardedLlm>(
    {
      businessId: ctx.businessId,
      subscriptionTier: ctx.subscriptionTier,
      // SPEC §7.3: children are sequential inside one job — never contend
      // for the latency-critical reply-generation concurrency slots.
      withConcurrency: false,
      estimateCents: SOLICITATION_ASK_ESTIMATE_CENTS,
      // SPEC §7.5: the render is produced and about to be persisted; a
      // finalize flake must not discard it (a retry would re-spend). The
      // reservation ages out via the 24h TTL.
      onFinalizeError: 'log-and-return-value',
    },
    async () => {
      const startedAt = Date.now();
      try {
        const result = await runLlmTask('solicitation_ask', prompt);
        const usd = calculateCostUsd(
          result.model,
          result.usage.promptTokens,
          result.usage.completionTokens,
        );
        return {
          value: { kind: 'ok' as const, result, usd, ms: Date.now() - startedAt },
          actualCostCents: Math.ceil(usd * 100),
        };
      } catch (err) {
        if (err instanceof LLMStructuredOutputError) {
          // Terminal for THIS child (SPEC §7.5), but the providers BILLED the
          // invalid completions — return through the guard (not throw past
          // it) so the real spend is FINALIZED against the reservation
          // instead of released, and each billed attempt gets its api_costs
          // audit row (codex round-2 finding 1). latencyMs is the whole
          // guarded call — per-attempt timing is not carried on the error.
          const ms = Date.now() - startedAt;
          const attempts: ChildLlmMeta[] = err.billedAttempts.map((attempt) => ({
            provider: attempt.provider,
            model: attempt.model,
            usage: attempt.usage,
            costUsd: calculateCostUsd(
              attempt.model,
              attempt.usage.promptTokens,
              attempt.usage.completionTokens,
            ),
            latencyMs: ms,
          }));
          const totalUsd = attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
          return {
            value: { kind: 'structured_failure' as const, attempts },
            actualCostCents: Math.ceil(totalUsd * 100),
          };
        }
        throw err;
      }
    },
  );

  if (guarded.kind === 'structured_failure') {
    // The batch continues; the withheld row rides with the billed attempts.
    return renderFailedOutcome(assembled.inputs, guarded.attempts);
  }
  const llm = guarded.result;

  const llmMeta: ChildLlmMeta = {
    provider: llm.provider,
    model: llm.model,
    usage: llm.usage,
    costUsd: guarded.usd,
    latencyMs: guarded.ms,
  };

  const parsed = SolicitationAskOutputSchema.safeParse(llm.structured);
  // A whitespace-only body passes zod's min(1) AND the lint (Task 5 known
  // gap), so effectively-empty structured output is treated here as
  // LLMStructuredOutputError-equivalent: withheld render_failed.
  if (!parsed.success || parsed.data.body.trim().length === 0) {
    return renderFailedOutcome(assembled.inputs, [llmMeta]);
  }
  const { subject, body: llmBody } = parsed.data;

  const assembledBody = assembleAskBody(llmBody, {
    businessName: ctx.businessName,
    postalAddress: ctx.postalAddress,
  });
  if (assembledBody === null) {
    // No attested postal address (#622 §7.6): fail closed. Bodies stay NULL —
    // 091 pairs subject/body and no assembled artifact exists to store.
    // Decision 4: moderation is never called on copy already known
    // non-compliant, so the never-ran fills apply.
    return {
      status: 'withheld',
      dispositionReason: 'lint_failed',
      subject: null,
      body: null,
      lintDetail: ['missing_required_element'],
      moderationStatus: 'error',
      moderationDetail: {},
      interpolationInputs: assembled.inputs,
      llmAttempts: [llmMeta],
    };
  }

  const verdict = lintAsk({
    subject,
    body: assembledBody,
    interpolationValues: assembled.interpolationValues,
    subjectDisallowedValues: assembled.subjectDisallowedValues,
  });
  if (verdict.blockedReason !== null) {
    // AMEND B1: all seven content classes fold to one coarse `lint_failed`
    // reason with the matched classes in lint_detail. Decision 4: no provider
    // round-trip on copy already known non-compliant.
    return {
      status: 'withheld',
      dispositionReason: 'lint_failed',
      subject,
      body: assembledBody,
      lintDetail: verdict.matches,
      moderationStatus: 'error',
      moderationDetail: {},
      interpolationInputs: assembled.inputs,
      llmAttempts: [llmMeta],
    };
  }

  // SPEC §3.1/§3.2: ONE moderation call over subject + body, so a
  // subject-only violation cannot slip past.
  const providerEnabled = openaiModerationEnabled();
  const decision = await moderateResponse(`${subject}\n${assembledBody}`);
  const moderationDetail = moderationDetailOf(decision);

  if (decision.severity === 'high') {
    // Absolute veto, mirroring invariant #4 — moderation keeps its own reason.
    return {
      status: 'withheld',
      dispositionReason: 'moderation_high',
      subject,
      body: assembledBody,
      lintDetail: [],
      moderationStatus: 'flagged',
      moderationDetail,
      interpolationInputs: assembled.inputs,
      llmAttempts: [llmMeta],
    };
  }

  // SPEC §3.2/§3.4 fail-deferred mapping: 'disabled' and 'error' rows are
  // produced but NOT dispatchable — a clean provider verdict is a DISPATCH
  // precondition (#630 re-moderates), never a generation precondition.
  const moderationStatus: OutreachModerationStatus = !providerEnabled
    ? 'disabled'
    : decision.providerStatus === 'error'
      ? 'error'
      : decision.flagged
        ? 'flagged'
        : 'clean';

  return {
    status: 'rendered',
    dispositionReason: null,
    subject,
    body: assembledBody,
    lintDetail: [],
    moderationStatus,
    moderationDetail,
    interpolationInputs: assembled.inputs,
    llmAttempts: [llmMeta],
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

interface ChildIdentity {
  askId: string;
  contactId: string;
}

function toInsertInput(
  ctx: BatchGenerationContext,
  child: ChildIdentity,
  outcome: ChildRenderOutcome,
  attemptNo: number,
  parentRunId: string,
): InsertOutreachRenderInput {
  const base = {
    accountId: ctx.accountId,
    businessId: ctx.businessId,
    batchId: ctx.batchId,
    askId: child.askId,
    contactId: child.contactId,
    attemptNo,
    promptVersion: SOLICITATION_ASK_PROMPT_VERSION,
    promptHash: solicitationAskPromptHash(),
    askLintVersion: ASK_LINT_VERSION,
    lintDetail: outcome.lintDetail,
    moderationStatus: outcome.moderationStatus,
    moderationDetail: outcome.moderationDetail,
    interpolationInputs: outcome.interpolationInputs,
    renderedAt: new Date(),
    agentRunId: parentRunId,
  };
  return outcome.status === 'rendered'
    ? {
        ...base,
        deliveryStatus: 'rendered',
        renderedSubject: outcome.subject,
        renderedBody: outcome.body,
      }
    : {
        ...base,
        deliveryStatus: 'withheld',
        dispositionReason: outcome.dispositionReason,
        renderedSubject: outcome.subject,
        renderedBody: outcome.body,
      };
}

type PersistChildResult =
  | { kind: 'inserted'; outreachId: string }
  | { kind: 'stale_attempt' }
  | { kind: 'stopped'; state: BatchState };

/**
 * Persist one child render behind the full revalidation ladder (codex round-2
 * finding 2), all in the SAME transaction as the insert: outbox attempt
 * ownership → advisory lock → batch row lock → lifecycle re-check. A halt,
 * expiry or close that commits while this child's LLM call was in flight must
 * not gain a live row afterward — the closer already evaluated the settled
 * predicate, and a resurrected `rendered` row would wedge the batch behind it
 * with no writer left to join. Only `built` admits an insert: every other
 * state either forbids new renders outright (halted/closed/expired) or cannot
 * legitimately coexist with in-flight generation (approved/veto_window/
 * sending arrive via #629/#630 after generation settles — refusing them here
 * is the fail-closed arm, not a supported flow).
 */
async function persistChildRender(
  sql: Sql,
  ctx: BatchGenerationContext,
  child: ChildIdentity,
  outcome: ChildRenderOutcome,
  attemptNo: number,
  parentRunId: string,
  handle: { outboxId: string; attempt: number },
): Promise<PersistChildResult> {
  return sql.begin(async (tx) => {
    const owns = await lockDispatchedOutboxAttemptIfOwned(
      tx,
      handle.outboxId,
      handle.attempt,
    );
    if (!owns) return { kind: 'stale_attempt' as const };

    await acquireSolicitationBatchLock(tx, ctx.businessId);
    const [batch] = await tx<BatchLifecycleRow[]>`
      SELECT built_at, approved_at, veto_deadline_at,
             sending_started_at, send_closed_at, halted_at
      FROM solicitation_batches
      WHERE id = ${ctx.batchId}::uuid
        AND account_id = ${ctx.accountId}::uuid
        AND business_id = ${ctx.businessId}::uuid
      FOR UPDATE
    `;
    if (!batch) {
      throw new Error(`ask generation: batch ${ctx.batchId} vanished before child persist`);
    }
    const state = deriveBatchState(batch, new Date());
    if (state !== 'built') return { kind: 'stopped' as const, state };

    const outreachId = await insertOutreachRender(
      tx,
      toInsertInput(ctx, child, outcome, attemptNo, parentRunId),
    );
    return { kind: 'inserted' as const, outreachId };
  });
}

type AskGenerationLogger = ReturnType<typeof createWorkerLogger>;

/**
 * SPEC §7.6: `api_costs` is the reconciled audit trail, best-effort relative
 * to the render persistence — its own log-and-swallow try/catch so a telemetry
 * failure never flips a completed generation to `failed` (repo gotcha:
 * best-effort work after the primary side effect).
 */
async function recordChildApiCost(
  sql: Sql,
  ctx: BatchGenerationContext,
  llmAttempts: readonly ChildLlmMeta[],
  logger: AskGenerationLogger,
): Promise<void> {
  for (const llm of llmAttempts) {
    try {
      await recordApiCost(sql, {
        businessId: ctx.businessId,
        accountId: ctx.accountId,
        provider: llm.provider,
        endpoint: llm.provider === 'openai' ? 'chat.completions' : 'messages',
        inputTokens: llm.usage.promptTokens,
        outputTokens: llm.usage.completionTokens,
        costUsd: llm.costUsd,
        responseId: null,
        systemPromptHash: solicitationAskPromptHash(),
        promptVersion: SOLICITATION_ASK_PROMPT_VERSION,
        latencyMs: llm.latencyMs,
      });
    } catch (err) {
      logger.warn('api_costs write failed after render persistence — swallowing', {
        business_id: ctx.businessId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Outbox completion helpers ────────────────────────────────────────────────

function requireAttempt(handle: OutboxHandle, door: string): number {
  if (handle.attempt === undefined) {
    throw new Error(`${door} requires an exact outbox_attempt`);
  }
  return handle.attempt;
}

/**
 * A no-op / refusal is a SUCCESS: complete the owned attempt in a minimal
 * transaction so the row can never strand in `dispatched`. A stale attempt
 * no-ops inside the CAS itself.
 */
async function completeOutboxNoop(
  sql: Sql,
  outboxId: string,
  attempt: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    await markOutboxCompletedIfOwned(tx, outboxId, attempt);
  });
}

// ── generateAsksForBatch ─────────────────────────────────────────────────────

function isBudgetExceeded(
  err: unknown,
): err is CostLimitExceededError | GlobalCostLimitExceededError {
  return (
    err instanceof CostLimitExceededError ||
    err instanceof GlobalCostLimitExceededError
  );
}

/**
 * Decision 6: once the daily budget is exceeded mid-batch, STOP generating and
 * settle the current + every remaining un-generated ask as withheld
 * `render_failed` — a same-day retry would fail identically, so the job
 * COMPLETES rather than rethrowing. Only the first entry (the ask whose
 * reservation was refused) was ever assembled; the rest snapshot `{}`.
 */
async function settleBudgetStop(
  sql: Sql,
  ctx: BatchGenerationContext,
  remaining: readonly SendAskRow[],
  currentInputs: AskInterpolationInputs,
  parentRunId: string,
  result: GenerateAsksResult,
  handle: { outboxId: string; attempt: number },
): Promise<{ kind: 'settled' } | Exclude<PersistChildResult, { kind: 'inserted' }>> {
  for (const [index, ask] of remaining.entries()) {
    const probe = await probeExistingRenders(sql, ctx, ask.ask_id);
    if (probe.nonCancelled > 0) {
      // index 0 is the ask whose reservation was just refused — the caller
      // probed it clean moments ago, so a hit here is unreachable and must
      // not double-count it; later entries were never probed and a hit is a
      // genuine skip.
      if (index > 0) result.skippedExisting += 1;
      continue;
    }
    const outcome = renderFailedOutcome(index === 0 ? currentInputs : {});
    const persisted = await persistChildRender(
      sql,
      ctx,
      { askId: ask.ask_id, contactId: ask.contact_id },
      outcome,
      probe.maxAttempt + 1,
      parentRunId,
      handle,
    );
    if (persisted.kind !== 'inserted') return persisted;
    result.failed += 1;
  }
  return { kind: 'settled' as const };
}

/**
 * A stop (halt/expiry/close) won a race against this job. A halt already
 * terminalized the parent through its own close call, but an EXPIRED batch
 * has no other closer until #629/#630's batch_expired latch lands — so every
 * stopped-after-parent path closes-if-settled here to avoid an orphan running
 * parent (codex round-3 finding 2). Live rows keep the batch open on purpose:
 * rendered copy stays approvable until expiry machinery cancels it.
 */
async function closeStoppedLane(sql: Sql, ctx: BatchGenerationContext): Promise<void> {
  await sql.begin(async (tx) => {
    await acquireSolicitationBatchLock(tx, ctx.businessId);
    await closeBatchIfSettled(tx, {
      batchId: ctx.batchId,
      accountId: ctx.accountId,
      businessId: ctx.businessId,
    });
  });
}

interface RenderTally {
  alive: number;
  failed_count: number;
  withheld_count: number;
}

/** One snapshot answering both "anything live?" and the failure's two counts. */
async function readRenderTally(
  tx: TransactionSql,
  ids: { batchId: string; accountId: string; businessId: string },
): Promise<RenderTally> {
  const [tally] = await tx<RenderTally[]>`
    SELECT
      COUNT(*) FILTER (
        WHERE delivery_status IN ('rendered', 'queued', 'sending', 'sent')
      )::int AS alive,
      COUNT(*) FILTER (
        WHERE delivery_status = 'withheld' AND disposition_reason = 'render_failed'
      )::int AS failed_count,
      COUNT(*) FILTER (
        WHERE delivery_status = 'withheld'
          AND disposition_reason IN ('lint_failed', 'moderation_high')
      )::int AS withheld_count
    FROM solicitation_outreach
    WHERE batch_id = ${ids.batchId}::uuid
      AND account_id = ${ids.accountId}::uuid
      AND business_id = ${ids.businessId}::uuid
  `;
  return tally ?? { alive: 0, failed_count: 0, withheld_count: 0 };
}

// ACKNOWLEDGED DEBT (#628 → refactor ticket): 294 lines / 43 cognitive is over
// threshold and fallow is right about it. Suppressed rather than decomposed
// because this is the lane's transaction-ordered orchestrator — mint →
// per-child render → finale, each arm carrying its own lock order and
// idempotency contract — and it is the exact code five rounds of adversarial
// review examined arm by arm. Splitting it to satisfy a metric would reopen
// validated concurrency handling for no behavioural gain. Decompose it behind
// its own tests in its own change, never as a gate-clearing edit.
// fallow-ignore-next-line complexity
export async function generateAsksForBatch(
  sql: Sql,
  input: GenerateAsksForBatchInput,
): Promise<GenerateAsksResult> {
  const logger = createWorkerLogger('[AskGeneration]', input.correlationId);
  const { outboxId } = input.outboxHandle;
  const attempt = requireAttempt(input.outboxHandle, 'generate_solicitation_asks');
  const result: GenerateAsksResult = {
    rendered: 0,
    withheld: 0,
    failed: 0,
    skippedExisting: 0,
  };
  // Every gate below is a no-op SUCCESS: complete the outbox attempt, log,
  // return the (empty) tallies — the batch-door twin of the regen door's
  // `refuse` closure. `warn` is reserved for states that should not exist.
  const noop = async (
    message: string,
    detail: Record<string, unknown> = {},
    level: 'log' | 'warn' = 'log',
  ): Promise<GenerateAsksResult> => {
    await completeOutboxNoop(sql, outboxId, attempt);
    logger[level](message, { batch_id: input.batchId, ...detail });
    return result;
  };

  // Gate: flag flipped between enqueue and run ⇒ no-op SUCCESS. Checked before
  // any load so the loader (and its #627-dependent column projection) never
  // runs while the lane is switched off.
  if (!solicitationSendEnabled()) {
    return noop('ask generation no-op: send flag disabled');
  }

  const ctx = await loadBatchContext(sql, input.batchId, input.businessId);
  if (!ctx) {
    return noop('ask generation no-op: batch missing', {}, 'warn');
  }

  // Gate: subscription (invariant #11).
  if (!subscriptionGrantsFullAccess(ctx.subscriptionStatus)) {
    return noop('ask generation no-op: subscription does not grant access', {
      subscription_status: ctx.subscriptionStatus,
    });
  }

  const asks = await loadSendAsks(sql, ctx);
  // Defensive: the build tx does not enqueue for zero send asks (D21).
  if (asks.length === 0) {
    return noop('ask generation no-op: batch has no send asks');
  }

  // Send parent run in its own short tx, gated on attempt ownership
  // (prepareBatch precedent) AND on the LOCKED batch state (codex round-3
  // finding 2): a stale replay whose finale already terminalized the parent
  // must not mint a second, forever-running send parent, and a delayed job
  // for a batch that was halted/expired/closed since enqueue must not mint
  // one either — the persist revalidation would refuse every child, leaving
  // an active parent nothing terminalizes. The close call inside the stopped
  // arm terminalizes any orphan parent a PRIOR attempt left, when settled.
  const minted = await sql.begin(
    async (
      tx,
    ): Promise<
      | { kind: 'stale' }
      | { kind: 'stopped'; state: BatchState }
      | { kind: 'minted'; runId: string }
    > => {
      const owns = await lockDispatchedOutboxAttemptIfOwned(tx, outboxId, attempt);
      if (!owns) return { kind: 'stale' };
      await acquireSolicitationBatchLock(tx, ctx.businessId);
      const [batchRow] = await tx<BatchLifecycleRow[]>`
        SELECT built_at, approved_at, veto_deadline_at,
               sending_started_at, send_closed_at, halted_at
        FROM solicitation_batches
        WHERE id = ${ctx.batchId}::uuid
          AND account_id = ${ctx.accountId}::uuid
          AND business_id = ${ctx.businessId}::uuid
        FOR UPDATE
      `;
      if (!batchRow) {
        throw new Error(`ask generation: batch ${ctx.batchId} vanished before parent mint`);
      }
      const state = deriveBatchState(batchRow, new Date());
      if (state !== 'built') {
        await closeBatchIfSettled(tx, {
          batchId: ctx.batchId,
          accountId: ctx.accountId,
          businessId: ctx.businessId,
        });
        return { kind: 'stopped', state };
      }
      const run = await startOrGetSolicitationSendBatchRun(tx, {
        batchId: ctx.batchId,
        accountId: ctx.accountId,
        businessId: ctx.businessId,
        correlationId: input.correlationId,
      });
      return { kind: 'minted', runId: run.runId };
    },
  );
  if (minted.kind === 'stale') {
    logger.warn('ask generation: stale outbox attempt — nothing done', {
      batch_id: ctx.batchId,
      outbox_id: outboxId,
      outbox_attempt: attempt,
    });
    return result;
  }
  if (minted.kind === 'stopped') {
    return noop('ask generation no-op: batch not generatable at start', {
      batch_state: minted.state,
    });
  }
  const parentRunId = minted.runId;

  // Children, SEQUENTIAL (SPEC §7.3).
  for (const [index, ask] of asks.entries()) {
    const probe = await probeExistingRenders(sql, ctx, ask.ask_id);
    if (probe.nonCancelled > 0) {
      // Decision 5: any non-cancelled row — live OR terminal withheld — means
      // this child is done; no reservation, no regeneration on retry.
      result.skippedExisting += 1;
      continue;
    }

    const assembled = assembleInterpolation(ctx, ask);
    let outcome: ChildRenderOutcome;
    if (assembled === null) {
      logger.warn('ask generation: send ask has no visit — withheld render_failed', {
        batch_id: ctx.batchId,
        ask_id: ask.ask_id,
      });
      outcome = renderFailedOutcome({});
    } else {
      try {
        outcome = await generateChildRender(ctx, assembled);
      } catch (err) {
        if (isBudgetExceeded(err)) {
          logger.warn('ask generation: daily budget exceeded — settling remaining asks', {
            batch_id: ctx.batchId,
            ask_id: ask.ask_id,
            scope: err instanceof GlobalCostLimitExceededError ? 'global' : 'account',
          });
          const settled = await settleBudgetStop(
            sql,
            ctx,
            asks.slice(index),
            assembled.inputs,
            parentRunId,
            result,
            { outboxId, attempt },
          );
          if (settled.kind === 'stale_attempt') {
            logger.warn('ask generation: stale outbox attempt during budget settle', {
              batch_id: ctx.batchId,
              outbox_id: outboxId,
              outbox_attempt: attempt,
            });
            return result;
          }
          if (settled.kind === 'stopped') {
            await closeStoppedLane(sql, ctx);
            return noop('ask generation stopped mid-settle: batch left generatable state', {
              batch_state: settled.state,
            });
          }
          break;
        }
        // TransientLLMError / CostInfraUnavailableError (and anything
        // unexpected): rethrow — BullMQ retries and the §7.4 idempotency
        // resumes at the first ask lacking a row. The outbox row is NOT
        // completed here.
        throw err;
      }
    }

    const persisted = await persistChildRender(
      sql,
      ctx,
      { askId: ask.ask_id, contactId: ask.contact_id },
      outcome,
      probe.maxAttempt + 1,
      parentRunId,
      { outboxId, attempt },
    );
    if (persisted.kind === 'stale_attempt') {
      // A newer dispatch owns the batch: audit this child's spend, write
      // nothing else, and leave the outbox row to its new owner.
      await recordChildApiCost(sql, ctx, outcome.llmAttempts, logger);
      logger.warn('ask generation: stale outbox attempt at child persist — stopping', {
        batch_id: ctx.batchId,
        ask_id: ask.ask_id,
        outbox_id: outboxId,
        outbox_attempt: attempt,
      });
      return result;
    }
    if (persisted.kind === 'stopped') {
      // Halt/expiry/close won the race (codex round-2 finding 2): the render
      // is discarded — residual exposure is this one child's LLM call, the
      // same contract the halt latch documents — but its spend is audited,
      // and the lane closes-if-settled so no orphan parent survives the stop
      // (codex round-3 finding 2).
      await recordChildApiCost(sql, ctx, outcome.llmAttempts, logger);
      await closeStoppedLane(sql, ctx);
      return noop('ask generation stopped: batch left generatable state mid-run', {
        ask_id: ask.ask_id,
        batch_state: persisted.state,
      });
    }
    if (outcome.status === 'rendered') result.rendered += 1;
    else if (outcome.dispositionReason === 'render_failed') result.failed += 1;
    else result.withheld += 1;
    await recordChildApiCost(sql, ctx, outcome.llmAttempts, logger);
  }

  // Finale — ONE transaction (decisions 8+9).
  const finale = await sql.begin(async (tx) => {
    // CAS FIRST: a false result is a stale attempt — abort with ZERO domain
    // writes (batch-builder constructBatch precedent).
    const owns = await markOutboxCompletedIfOwned(tx, outboxId, attempt);
    if (!owns) return { stale: true as const };

    // B11 global order: advisory lock before any row lock (the offboarding
    // purge holds this key and then row-locks these batches).
    await acquireSolicitationBatchLock(tx, ctx.businessId);
    // Batch row BEFORE any agent_runs lock — batch → run is the sole order in
    // this lane (closeBatchIfSettled contract), and recordGenerationSteps
    // locks the parent run row.
    const lockedBatch = await tx<{ id: string }[]>`
      SELECT id FROM solicitation_batches
      WHERE id = ${ctx.batchId}::uuid
        AND account_id = ${ctx.accountId}::uuid
        AND business_id = ${ctx.businessId}::uuid
      FOR UPDATE
    `;
    if (lockedBatch.count === 0) {
      throw new Error(`ask generation: batch ${ctx.batchId} vanished before the finale`);
    }

    // Database-derived steps (Task 7) — NOT idempotent by itself, which is
    // exactly why it runs behind the CAS above.
    await recordGenerationSteps(tx, {
      parentRunId,
      accountId: ctx.accountId,
      businessId: ctx.businessId,
      batchId: ctx.batchId,
    });

    // k = 0 (D14/D21): no releasable-or-released row means every render
    // failed or was withheld — the send parent terminalizes
    // `generation_failed`. Derived from the DB, not the in-memory tallies, so
    // a resumed retry over prior partial progress still decides correctly.
    const tally = await readRenderTally(tx, ctx);

    // Decision 8: closeBatchIfSettled is called ALONE — it owns the failure
    // transition internally; never call failSolicitationBatchRun for the send
    // parent from here (batch → run lock-order contract on its `failure`).
    const close = await closeBatchIfSettled(tx, {
      batchId: ctx.batchId,
      accountId: ctx.accountId,
      businessId: ctx.businessId,
      ...(tally.alive === 0
        ? {
            failure: {
              code: 'generation_failed' as const,
              failedCount: tally.failed_count,
              withheldCount: tally.withheld_count,
            },
          }
        : {}),
    });
    return { stale: false as const, close };
  });

  if (finale.stale) {
    logger.warn('ask generation finale: stale outbox attempt — no domain writes', {
      batch_id: ctx.batchId,
      outbox_id: outboxId,
      outbox_attempt: attempt,
    });
    return result;
  }

  logger.log('ask generation finished', {
    batch_id: ctx.batchId,
    rendered: result.rendered,
    withheld: result.withheld,
    failed: result.failed,
    skipped_existing: result.skippedExisting,
    close_status: finale.close.status,
  });
  return result;
}

// ── regenerateAsk ────────────────────────────────────────────────────────────

/**
 * AMEND B2: regeneration is possible while the batch is un-approved (`built`)
 * or post-approval for still-`rendered` rows (`approved` / `veto_window` /
 * `sending`). Halted, expired, closed, and unbuilt batches refuse.
 */
const REGENERABLE_BATCH_STATES: ReadonlySet<BatchState> = new Set([
  'built',
  'approved',
  'veto_window',
  'sending',
]);

/** Control-flow sentinel: aborts the swap tx (rolling back its writes). */
class RegenSwapAbort extends Error {
  constructor(public readonly reason: string) {
    super(`ask regeneration swap aborted: ${reason}`);
    this.name = 'RegenSwapAbort';
  }
}

/** What a committed swap transaction hands back for the success log line. */
interface RegenSwapResult {
  outreachId: string;
  attemptNo: number;
}

interface CurrentOutreachRow {
  delivery_status: string;
  attempt_no: number;
}

async function loadCurrentOutreach(
  sql: Sql | TransactionSql,
  ctx: BatchGenerationContext,
  askId: string,
  forUpdate: boolean,
): Promise<CurrentOutreachRow | null> {
  const [row] = await sql<CurrentOutreachRow[]>`
    SELECT delivery_status, attempt_no
    FROM solicitation_outreach
    WHERE ask_id = ${askId}::uuid
      AND account_id = ${ctx.accountId}::uuid
      AND business_id = ${ctx.businessId}::uuid
      AND delivery_status <> 'cancelled'
    ORDER BY attempt_no DESC
    LIMIT 1
    ${forUpdate ? sql`FOR UPDATE` : sql``}
  `;
  return row ?? null;
}

/**
 * Per-ask LLM re-roll (SPEC §8.2, AMEND B2; decision 7 shape):
 *
 *  1. Pre-checks with NO transaction — worker-enforced regen budget (outbox
 *     replay cannot bypass it), flag/subscription gates, ask + current-row
 *     eligibility. Every refusal completes the outbox attempt (a refusal is a
 *     SUCCESS) and leaves the existing render untouched.
 *  2. The replacement is generated entirely OUTSIDE any transaction.
 *  3. ONE swap transaction: outbox CAS first, then the B11 lock order
 *     (advisory → batch row → outreach row), re-verify eligibility under the
 *     locks, then supersede + insert at `attempt_no + 1` — UNCONDITIONAL of
 *     the new verdict (a blocked replacement leaves the ask with no live
 *     render: terminal), plus one regen step on the send parent. A failed
 *     re-verification rolls the domain writes back but still completes the
 *     outbox row, logging the discarded spend (accepted rare waste).
 */
// ACKNOWLEDGED DEBT (#628 → refactor ticket): same reasoning as
// generateAsksForBatch above. The swap is a single ordered transaction —
// attempt CAS, lifecycle revalidation, terminalize prior attempt, insert
// attempt_no + 1, join — whose steps cannot be reordered or separated without
// re-deriving the ordering proof the review rounds already checked.
// fallow-ignore-next-line complexity
export async function regenerateAsk(
  sql: Sql,
  input: RegenerateAskInput,
): Promise<void> {
  const logger = createWorkerLogger('[AskRegeneration]', input.correlationId);
  const { outboxId } = input.outboxHandle;
  const attempt = requireAttempt(input.outboxHandle, 'regenerate_solicitation_ask');

  const refuse = async (
    reason: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> => {
    await completeOutboxNoop(sql, outboxId, attempt);
    logger.log('ask regeneration refused', {
      batch_id: input.batchId,
      ask_id: input.askId,
      reason,
      ...detail,
    });
  };

  if (!solicitationSendEnabled()) {
    await refuse('send_flag_disabled');
    return;
  }

  // SPEC §8.2 r3: budget is enforced HERE in the worker — an API-only limiter
  // is bypassable via outbox replay. Exceeded is terminal: refuse, keep the
  // existing render live. Charged per logical request (the outbox row), so
  // BullMQ retries of one regeneration consume one unit, not one per attempt.
  try {
    await checkAskRegenBudget(input.askId, outboxId);
  } catch (err) {
    if (err instanceof RegenBudgetExceededError) {
      await refuse('regen_budget_exhausted');
      return;
    }
    throw err; // Redis transport failure → BullMQ retry
  }

  const ctx = await loadBatchContext(sql, input.batchId, input.businessId);
  if (!ctx) {
    await refuse('batch_missing');
    return;
  }
  if (!subscriptionGrantsFullAccess(ctx.subscriptionStatus)) {
    await refuse('subscription_inactive', {
      subscription_status: ctx.subscriptionStatus,
    });
    return;
  }

  const preState = deriveBatchState(ctx.lifecycle, new Date());
  if (!REGENERABLE_BATCH_STATES.has(preState)) {
    await refuse('batch_not_regenerable', { batch_state: preState });
    return;
  }

  const ask = await loadSendAskById(sql, ctx, input.askId);
  if (!ask) {
    await refuse('ask_missing_or_not_send');
    return;
  }

  const current = await loadCurrentOutreach(sql, ctx, input.askId, false);
  if (!current) {
    await refuse('no_render_to_regenerate');
    return;
  }
  if (current.delivery_status !== 'rendered') {
    // SPEC §8.2 r6: blocked is terminal — a withheld row cannot be re-rolled
    // (that would launder the fail-closed lint); AMEND B2: a released row
    // (queued/sending/sent) is never superseded.
    await refuse('current_attempt_not_rendered', {
      delivery_status: current.delivery_status,
    });
    return;
  }

  const assembled = assembleInterpolation(ctx, ask);
  if (assembled === null) {
    await refuse('ask_has_no_visit');
    return;
  }

  // Decision 7: the replacement is generated entirely OUTSIDE any transaction.
  let outcome: ChildRenderOutcome;
  try {
    outcome = await generateChildRender(ctx, assembled);
  } catch (err) {
    if (isBudgetExceeded(err)) {
      // Terminal for today; the existing rendered copy stays live.
      await refuse('daily_cost_budget_exhausted');
      return;
    }
    throw err; // transient → BullMQ retry; the outbox row is NOT completed
  }

  let swapped: RegenSwapResult | null = null;
  try {
    swapped = await sql.begin(async (tx): Promise<RegenSwapResult> => {
      // CAS-before-mutation: the transaction's FIRST statement.
      const owns = await markOutboxCompletedIfOwned(tx, outboxId, attempt);
      if (!owns) {
        throw new RegenSwapAbort('stale_outbox_attempt');
      }
      // B11 global lock order: advisory first, then row locks.
      await acquireSolicitationBatchLock(tx, ctx.businessId);
      const [batchRow] = await tx<BatchLifecycleRow[]>`
        SELECT built_at, approved_at, veto_deadline_at,
               sending_started_at, send_closed_at, halted_at
        FROM solicitation_batches
        WHERE id = ${ctx.batchId}::uuid
          AND account_id = ${ctx.accountId}::uuid
          AND business_id = ${ctx.businessId}::uuid
        FOR UPDATE
      `;
      if (!batchRow) throw new RegenSwapAbort('batch_missing');
      const lockedState = deriveBatchState(batchRow, new Date());
      if (!REGENERABLE_BATCH_STATES.has(lockedState)) {
        throw new RegenSwapAbort(`batch_not_regenerable:${lockedState}`);
      }
      const lockedRow = await loadCurrentOutreach(tx, ctx, input.askId, true);
      if (!lockedRow || lockedRow.delivery_status !== 'rendered') {
        throw new RegenSwapAbort('current_attempt_not_rendered');
      }

      // The send parent carries the regen step; the batch row lock above keeps
      // this agent_runs lock in the lane's sole batch → run order.
      const [parent] = await tx<{ id: string }[]>`
        SELECT id FROM agent_runs
        WHERE kind = 'solicitation_send_batch'
          AND subject_type = 'solicitation_batch'
          AND subject_id = ${ctx.batchId}
          AND account_id = ${ctx.accountId}::uuid
          AND business_id = ${ctx.businessId}::uuid
        ORDER BY started_at DESC
        LIMIT 1
      `;
      if (!parent) {
        // A rendered row implies generation ran under a send parent.
        throw new Error(
          `ask regeneration: no send parent run for batch ${ctx.batchId}`,
        );
      }

      const prior = await supersedeLiveRender(tx, {
        askId: input.askId,
        accountId: ctx.accountId,
        businessId: ctx.businessId,
      });
      if (!prior) throw new RegenSwapAbort('current_attempt_not_rendered');

      // AMEND B2 mechanics: the replacement inserts UNCONDITIONALLY of its
      // verdict — a blocked replacement leaves the ask with no live render
      // (terminal for this batch; the contact stays a candidate later).
      const attemptNo = prior.priorAttemptNo + 1;
      const outreachId = await insertOutreachRender(
        tx,
        toInsertInput(
          ctx,
          { askId: input.askId, contactId: ask.contact_id },
          outcome,
          attemptNo,
          parent.id,
        ),
      );
      await recordStep(tx, {
        runId: parent.id,
        stepKey: 'ask_generated',
        detail: {
          ask_id: input.askId,
          outreach_id: outreachId,
          attempt_no: attemptNo,
          delivery_status: outcome.status,
          disposition_reason: outcome.dispositionReason ?? null,
          regenerated: true,
        },
      });
      // A withheld replacement TERMINALIZES this ask, and every writer that
      // terminalizes an Outreach row joins in the SAME transaction
      // (outreach.ts single-join contract, D11) — without this, blocking the
      // batch's last live render would strand it un-settled until expiry. A
      // rendered replacement leaves a live row and the call no-ops
      // (`not_settled`). No `failure` is passed: a batch the owner regenerated
      // out of live renders settles `exhausted`, not `generation_failed` —
      // renders existed and were approvable.
      await closeBatchIfSettled(tx, {
        batchId: ctx.batchId,
        accountId: ctx.accountId,
        businessId: ctx.businessId,
      });
      return { outreachId, attemptNo };
    });
  } catch (err) {
    if (!(err instanceof RegenSwapAbort)) throw err;
    // The sentinel's reason is the ONE owner of why the swap aborted.
    if (err.reason === 'stale_outbox_attempt') {
      logger.warn('ask regeneration: stale outbox attempt — no domain writes', {
        batch_id: ctx.batchId,
        ask_id: input.askId,
        outbox_id: outboxId,
        outbox_attempt: attempt,
      });
    } else {
      // Eligibility died between generation and the swap: the render is
      // discarded (accepted rare waste — the spend is logged below via
      // api_costs) but the outbox attempt still completes.
      await completeOutboxNoop(sql, outboxId, attempt);
      logger.warn('ask regeneration discarded after generation', {
        batch_id: ctx.batchId,
        ask_id: input.askId,
        reason: err.reason,
      });
    }
  }

  // The LLM spend happened whether or not the swap survived — audit it either
  // way (best-effort, SPEC §7.6).
  await recordChildApiCost(sql, ctx, outcome.llmAttempts, logger);

  if (swapped !== null) {
    logger.log('ask regenerated', {
      batch_id: ctx.batchId,
      ask_id: input.askId,
      outreach_id: swapped.outreachId,
      attempt_no: swapped.attemptNo,
      delivery_status: outcome.status,
      disposition_reason: outcome.dispositionReason ?? null,
    });
  }
}

// ── Dead-letter settlement (codex round-2 finding 4) ─────────────────────────

export interface SettleGenerationExhaustionInput {
  batchId: string;
  businessId: string;
  outboxHandle: OutboxHandle;
  /** Bounded constructor name of the exhausting error (failed-hook supplied). */
  errorClass: string;
}

export type SettleGenerationExhaustionResult =
  | { status: 'stale' }
  | { status: 'batch_missing' }
  | { status: 'settled'; filled: number; close: CloseBatchIfSettledResult };

/**
 * Terminal-exhaustion settlement for a WHOLE-BATCH generation job (codex
 * round-2 finding 4): when every in-band BullMQ attempt failed on a
 * non-retryable class, marking only the outbox row failed leaves a partially
 * generated batch — send asks with no outreach row — behind a running send
 * parent with no automatic re-driver. One transaction restores a consistent
 * state: outbox ownership CAS FIRST (build failed-hook precedent), then the
 * B11 lock order, then a withheld `render_failed` row for every send ask that
 * has no non-cancelled row (the budget-stop fills), generation steps on the
 * spine when a send parent exists, and `closeBatchIfSettled` with the
 * `generation_failed` failure.
 *
 * Deliberately NOT a halt: rows that DID render stay live — they are real,
 * approvable copy, so the parent then legitimately keeps running toward
 * approval or expiry (partial generation is a degraded batch, not a poisoned
 * one). Only when nothing is live does the batch close `generation_failed`.
 *
 * REGENERATION exhaustion must never come here: its batch has a healthy live
 * render and a healthy parent; filling "holes" would fabricate failures for
 * asks the whole-batch pass already handled.
 */
export async function settleGenerationExhaustion(
  sql: Sql,
  input: SettleGenerationExhaustionInput,
): Promise<SettleGenerationExhaustionResult> {
  const attempt = requireAttempt(
    input.outboxHandle,
    'generate_solicitation_asks dead-letter',
  );
  return sql.begin(async (tx) => {
    // CAS FIRST — only the owner of the exact dispatched attempt may settle;
    // a stale hook (the watchdog already re-dispatched) writes nothing.
    const owns = await markOutboxFailed(
      tx,
      input.outboxHandle.outboxId,
      `generate_solicitation_asks_exhausted:${input.errorClass}`,
      attempt,
    );
    if (!owns) return { status: 'stale' as const };

    await acquireSolicitationBatchLock(tx, input.businessId);
    const [batch] = await tx<{ account_id: string }[]>`
      SELECT account_id
      FROM solicitation_batches
      WHERE id = ${input.batchId}::uuid
        AND business_id = ${input.businessId}::uuid
      FOR UPDATE
    `;
    // Missing batch: keep the committed outbox CAS (operators still get the
    // failed row to diagnose) and skip domain writes — there is nothing to
    // settle.
    if (!batch) return { status: 'batch_missing' as const };
    const accountId = batch.account_id;

    // Send asks with NO non-cancelled outreach row — the holes terminal
    // exhaustion left. MAX(attempt_no) runs over ALL rows (attempt numbers
    // are never reused, cancelled included).
    const holes = await tx<
      { ask_id: string; contact_id: string; next_attempt: number }[]
    >`
      SELECT
        ask.id AS ask_id,
        ask.contact_id,
        (COALESCE(MAX(o.attempt_no), 0) + 1)::int AS next_attempt
      FROM solicitation_asks ask
      LEFT JOIN solicitation_outreach o
        ON o.ask_id = ask.id
       AND o.account_id = ${accountId}::uuid
       AND o.business_id = ${input.businessId}::uuid
      WHERE ask.batch_id = ${input.batchId}::uuid
        AND ask.account_id = ${accountId}::uuid
        AND ask.business_id = ${input.businessId}::uuid
        AND ask.status = 'send'
      GROUP BY ask.id, ask.contact_id
      HAVING COUNT(*) FILTER (WHERE o.delivery_status <> 'cancelled') = 0
    `;

    // The send parent may not exist (the job can die before minting it);
    // batch row is already locked, so this keeps the lane's batch → run order.
    const [parent] = await tx<{ id: string }[]>`
      SELECT id FROM agent_runs
      WHERE kind = 'solicitation_send_batch'
        AND subject_type = 'solicitation_batch'
        AND subject_id = ${input.batchId}
        AND account_id = ${accountId}::uuid
        AND business_id = ${input.businessId}::uuid
      ORDER BY started_at DESC
      LIMIT 1
    `;

    for (const hole of holes) {
      // The decision-2 never-produced fills (renderFailedOutcome shape);
      // interpolation snapshot {} — these asks were never assembled.
      await insertOutreachRender(tx, {
        accountId,
        businessId: input.businessId,
        batchId: input.batchId,
        askId: hole.ask_id,
        contactId: hole.contact_id,
        attemptNo: hole.next_attempt,
        promptVersion: SOLICITATION_ASK_PROMPT_VERSION,
        promptHash: solicitationAskPromptHash(),
        askLintVersion: ASK_LINT_VERSION,
        lintDetail: [],
        moderationStatus: 'error',
        moderationDetail: {},
        interpolationInputs: {},
        renderedAt: new Date(),
        agentRunId: parent?.id ?? null,
        deliveryStatus: 'withheld',
        dispositionReason: 'render_failed',
        renderedSubject: null,
        renderedBody: null,
      });
    }

    if (parent) {
      // Receipt for everything the lane actually did (prior partial renders +
      // these fills) — safe here because the outbox CAS above is this
      // transaction's idempotency guard, same as the finale's.
      await recordGenerationSteps(tx, {
        parentRunId: parent.id,
        accountId,
        businessId: input.businessId,
        batchId: input.batchId,
      });
    }

    const tally = await readRenderTally(tx, {
      batchId: input.batchId,
      accountId,
      businessId: input.businessId,
    });
    const close = await closeBatchIfSettled(tx, {
      batchId: input.batchId,
      accountId,
      businessId: input.businessId,
      ...(tally.alive === 0
        ? {
            failure: {
              code: 'generation_failed' as const,
              failedCount: tally.failed_count,
              withheldCount: tally.withheld_count,
            },
          }
        : {}),
    });

    return { status: 'settled' as const, filled: holes.length, close };
  });
}
