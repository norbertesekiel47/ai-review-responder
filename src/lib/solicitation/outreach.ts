/**
 * Send-mode batch lifecycle (#624; executor design 2026-07-28 §2 D2, §5 D11/D14)
 * and the Outreach render persistence seam (#628 §5-as-amended).
 *
 * What lives here and nothing else:
 *
 *  - `deriveBatchState` — the read-time answer to "what is my batch doing".
 *    `solicitation_batches` deliberately has no `status` column: the monotone
 *    timestamps already own that fact, and a column would be a second owner
 *    needing its own transition CHECK to stay consistent with them. This is the
 *    one place that reads them, in one fixed precedence order.
 *  - `closeBatchIfSettled` — the single join. Every writer that terminalizes an
 *    Outreach row calls it in the SAME transaction, so there is no window
 *    between terminalizing and joining; the releaser tick calls the same
 *    function as a backstop. One implementation, two callers, no join poller.
 *  - `insertOutreachRender` / `supersedeLiveRender` — the ONLY writers of a
 *    render-lane `solicitation_outreach` row, plus the three read-boundary
 *    parsers for its JSONB columns.
 *
 * Domain module: the caller supplies the transaction (invariant #15) and the
 * tenant ids (invariant #8). A batch id is a bare UUID carrying no tenant
 * proof, so taking `accountId`/`businessId` explicitly is what makes this safe
 * to call from a worker that read its batch id off a queue payload.
 */

import { v7 as uuidv7 } from 'uuid';
import type { TransactionSql } from 'postgres';
import { completeRun, failSolicitationBatchRun, recordStep } from '@/lib/agents/run-spine';
import type { SolicitationBatchRunFailure } from '@/lib/agents/run-spine';
import { ASK_LINT_CLASSES, type AskLintClass } from './ask-compliance-lint';
import type { AskInterpolationInputs } from './ask-prompt-policy';

/**
 * Approval window, anchored on `built_at`. Past it, neither lane may approve.
 *
 * Two readers evaluate it — `deriveBatchState` in JS and `closeBatchIfSettled`
 * in SQL — so both derive the interval from this constant AND spell the same
 * boundary: the instant `built_at + window` is already expired (`>=` / `<=`).
 * A boundary that disagreed would let the owner's screen read `expired` while
 * the join derived `exhausted` and terminalized the parent `completed`, which
 * the closure CAS then makes permanent.
 */
export const BATCH_APPROVAL_WINDOW_DAYS = 7;

/**
 * Send window, anchored on `approved_at`. Past it, every unsent child
 * terminalizes through the halt path with reason `send_window_elapsed`. Owned
 * here with its sibling so the two windows that bound a drip to ≤10 days by
 * construction have one home; the releaser (#630) is its first reader.
 */
export const BATCH_SEND_WINDOW_HOURS = 72;

/** Fixed precedence, highest first. */
export const BATCH_STATES = [
  'halted',
  'closed',
  'sending',
  'veto_window',
  'approved',
  'expired',
  'built',
  'pending',
] as const;
export type BatchState = (typeof BATCH_STATES)[number];

/**
 * The lifecycle timestamps that decide the state. `created_at` and
 * `reviewed_at` are deliberately absent: neither moves the batch through this
 * union, and a parameter the function ignores is a reader's false lead.
 */
export interface BatchLifecycleRow {
  built_at: Date | null;
  approved_at: Date | null;
  veto_deadline_at: Date | null;
  sending_started_at: Date | null;
  send_closed_at: Date | null;
  halted_at: Date | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The owner-facing batch state. Pure — `now` is a parameter so the caller owns
 * the clock and the precedence stays testable without freezing time.
 *
 * The order of the early returns IS the precedence, which is what lets each
 * branch below stay narrow: `expired` never has to re-check "and not approved"
 * because the `approved_at` branch already returned.
 */
export function deriveBatchState(row: BatchLifecycleRow, now: Date): BatchState {
  if (row.halted_at !== null) return 'halted';
  if (row.send_closed_at !== null) return 'closed';
  if (row.sending_started_at !== null) return 'sending';
  if (row.approved_at !== null) {
    const inVetoWindow =
      row.veto_deadline_at !== null && now.getTime() < row.veto_deadline_at.getTime();
    return inVetoWindow ? 'veto_window' : 'approved';
  }
  if (row.built_at === null) return 'pending';
  const approvalDeadline = row.built_at.getTime() + BATCH_APPROVAL_WINDOW_DAYS * MS_PER_DAY;
  return now.getTime() >= approvalDeadline ? 'expired' : 'built';
}

/**
 * Closed union mapping 1:1 onto the send parent's terminal status.
 *
 * A plain union rather than a `typeof [...] [number]` derivation: nothing
 * iterates these at runtime, so the array was a value with no consumer.
 * Exhaustiveness is still enforced — `PARENT_TERMINAL_BY_DISPOSITION` below
 * `satisfies Record<BatchDisposition, ParentTerminalStatus>`, so adding a
 * member here without mapping it is a compile error.
 *
 * Module-private, matching `ParentTerminalStatus` and
 * `TERMINAL_DELIVERY_STATUSES` below: all three surface through
 * `CloseBatchIfSettledResult` structurally and none has an external consumer.
 * Export one when a caller needs to name it — not before.
 */
type BatchDisposition =
  | 'halted'
  | 'expired'
  | 'generation_failed'
  | 'gate_closed'
  | 'exhausted';

type ParentTerminalStatus = 'completed' | 'cancelled' | 'failed';

const PARENT_TERMINAL_BY_DISPOSITION = {
  exhausted: 'completed',
  halted: 'cancelled',
  expired: 'cancelled',
  generation_failed: 'failed',
  gate_closed: 'failed',
} as const satisfies Record<BatchDisposition, ParentTerminalStatus>;

/** The five statuses an Outreach row can be settled in. */
const TERMINAL_DELIVERY_STATUSES = [
  'sent',
  'withheld',
  'cancelled',
  'failed',
  'unknown',
] as const;
type TerminalDeliveryStatus = (typeof TERMINAL_DELIVERY_STATUSES)[number];

function isTerminalDeliveryStatus(value: string): value is TerminalDeliveryStatus {
  return (TERMINAL_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/**
 * The close receipt's evidence — NOT its decision. Counting cannot separate
 * `exhausted` from `generation_failed` (both can tally zero sends), which is
 * why the disposition comes from explicit sources instead.
 */
export interface OutreachStatusCounts {
  sent: number;
  withheld: number;
  cancelled: number;
  failed: number;
  unknown: number;
  withheldByReason: Record<string, number>;
}

export interface CloseBatchIfSettledInput {
  batchId: string;
  accountId: string;
  businessId: string;
  /**
   * The failure that ended this batch's send lane, when one did.
   *
   * This arrives as a PARAMETER rather than being read back off
   * `agent_runs.error`, and that is a deadlock fix, not a style choice. Reading
   * it back required the lane to record the failure on the send parent *before*
   * calling in — which takes the `agent_runs` row lock first and then the batch
   * lock, while every other caller (a last-child close, the releaser backstop)
   * takes batch-then-run. Two live paths, opposite orders, same two rows: ABBA.
   *
   * Worse than the deadlock was its aftermath. If Postgres chose the failure
   * transaction as the victim, the surviving closer saw no error code, derived
   * `exhausted`, CAS'd `send_closed_at` and filed the parent `completed` — a
   * failed batch permanently recorded as a successful drip, unrepairable
   * because both the CAS and the terminal transition no-op on retry.
   *
   * Passing it in makes **batch → run** the sole lock order and turns an
   * unenforceable temporal contract into a signature that cannot be called
   * wrongly. Do NOT call `failSolicitationBatchRun` for the send parent before
   * this function; hand the failure over and let this own the whole close.
   */
  failure?: SolicitationBatchRunFailure;
}

export type CloseBatchIfSettledResult =
  | { status: 'no_send_parent' }
  | { status: 'not_settled'; liveCount: number }
  | { status: 'already_closed' }
  | {
      status: 'closed';
      parentRunId: string;
      disposition: BatchDisposition;
      parentStatus: ParentTerminalStatus;
      counts: OutreachStatusCounts;
    };

interface BatchClosureRow {
  halted: boolean;
  approval_window_elapsed: boolean;
}

interface SendParentRow {
  id: string;
}

interface OutreachTallyRow {
  delivery_status: string;
  disposition_reason: string | null;
  total: number;
}

function emptyCounts(): OutreachStatusCounts {
  return {
    sent: 0,
    withheld: 0,
    cancelled: 0,
    failed: 0,
    unknown: 0,
    withheldByReason: {},
  };
}

function tallyOutreach(
  rows: readonly OutreachTallyRow[],
  batchId: string,
): { liveCount: number; counts: OutreachStatusCounts } {
  const counts = emptyCounts();
  let liveCount = 0;

  for (const row of rows) {
    if (!isTerminalDeliveryStatus(row.delivery_status)) {
      liveCount += row.total;
      continue;
    }
    counts[row.delivery_status] += row.total;
    if (row.delivery_status !== 'withheld') continue;

    // The status/reason CHECK (migration 091) makes this unreachable for stored
    // rows. It stays because dropping such a row would make the receipt lie
    // about why asks were withheld, and a loud failure beats a quiet gap.
    if (row.disposition_reason === null) {
      throw new Error(
        `closeBatchIfSettled: withheld outreach with no disposition_reason on batch ${batchId}`,
      );
    }
    counts.withheldByReason[row.disposition_reason] =
      (counts.withheldByReason[row.disposition_reason] ?? 0) + row.total;
  }

  return { liveCount, counts };
}

/**
 * Ordered precedence over explicit sources, highest first.
 *
 * `halted` and `expired` are facts about the batch row. `generation_failed` and
 * `gate_closed` have no batch column and are NOT derivable from the outreach
 * tallies — `exhausted` (everything dispatched, some withheld naturally) can
 * produce identical status totals to `generation_failed` (nothing ever
 * rendered). They therefore arrive as `input.failure`, whose docstring explains
 * why that is a parameter and not a read of `agent_runs.error`.
 *
 * `build_failed` is deliberately absent: it attributes the *build* run (kind
 * `solicitation_batch`), never the send parent, and a batch that failed to build
 * has no send parent at all — the `no_send_parent` guard catches it first.
 */
function deriveDisposition(
  batch: BatchClosureRow,
  failure: SolicitationBatchRunFailure | undefined,
): BatchDisposition {
  if (batch.halted) return 'halted';
  if (batch.approval_window_elapsed) return 'expired';
  if (failure?.code === 'generation_failed') return 'generation_failed';
  if (failure?.code === 'gate_closed') return 'gate_closed';
  return 'exhausted';
}

/**
 * Close one send batch if no Outreach row is still `rendered`, `queued` or
 * `sending`, and terminalize its send parent run.
 *
 * Called by every writer that terminalizes an Outreach row, in that writer's
 * own transaction, and by the releaser tick as a backstop.
 *
 * Order is load-bearing, and **batch → run is the sole order in this lane**.
 * Nothing may take the `agent_runs` row lock for the send parent before calling
 * in — see `CloseBatchIfSettledInput.failure` for the ABBA deadlock that
 * requirement exists to prevent. This function owns the parent's error write,
 * its receipt step, and its terminal transition, all after the batch lock.
 *
 *  1. lock the batch row (domain-before-spine, the order the halt path already
 *     takes). The lock also serializes new Outreach rows against this join —
 *     inserting one takes FOR KEY SHARE on the batch it references, which
 *     conflicts with FOR UPDATE.
 *  2. resolve the send parent BEFORE the settled predicate. `NOT EXISTS` is
 *     vacuously true over zero rows, so a batch with no outreach and no send
 *     parent would otherwise be counted, stamped and terminalized.
 *  3. the `send_closed_at` CAS gates every write that follows. `recordStep`
 *     always appends, so a serialized second caller would add a duplicate
 *     receipt even though the timestamp and the terminal transition both
 *     correctly no-op — idempotent means "no observable second effect".
 */
export async function closeBatchIfSettled(
  tx: TransactionSql,
  input: CloseBatchIfSettledInput,
): Promise<CloseBatchIfSettledResult> {
  const [batch] = await tx<BatchClosureRow[]>`
    SELECT
      halted_at IS NOT NULL AS halted,
      (
        approved_at IS NULL
        AND built_at IS NOT NULL
        AND built_at <= NOW() - make_interval(days => ${BATCH_APPROVAL_WINDOW_DAYS})
      ) AS approval_window_elapsed
    FROM solicitation_batches
    WHERE id = ${input.batchId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND business_id = ${input.businessId}::uuid
    FOR UPDATE
  `;
  if (!batch) {
    throw new Error(
      `closeBatchIfSettled: batch ${input.batchId} not found for its account and business`,
    );
  }

  // subject_id is TEXT (migration 071) — a polymorphic subject key, not a uuid
  // column. The send parent is the sibling of the build parent: same subject,
  // different kind.
  const [parent] = await tx<SendParentRow[]>`
    SELECT id
    FROM agent_runs
    WHERE kind = 'solicitation_send_batch'
      AND subject_type = 'solicitation_batch'
      AND subject_id = ${input.batchId}
      AND account_id = ${input.accountId}::uuid
      AND business_id = ${input.businessId}::uuid
    ORDER BY started_at DESC
    LIMIT 1
  `;
  if (!parent) return { status: 'no_send_parent' };

  // One grouped read answers the join condition AND carries the receipt's
  // evidence, so the decision and the counts come from one snapshot.
  const tallyRows = await tx<OutreachTallyRow[]>`
    SELECT delivery_status, disposition_reason, COUNT(*)::int AS total
    FROM solicitation_outreach
    WHERE batch_id = ${input.batchId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND business_id = ${input.businessId}::uuid
    GROUP BY delivery_status, disposition_reason
  `;
  const { liveCount, counts } = tallyOutreach(tallyRows, input.batchId);
  if (liveCount > 0) return { status: 'not_settled', liveCount };

  const closed = await tx<{ id: string }[]>`
    UPDATE solicitation_batches
    SET send_closed_at = NOW()
    WHERE id = ${input.batchId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND send_closed_at IS NULL
    RETURNING id
  `;
  if (closed.count === 0) return { status: 'already_closed' };

  const disposition = deriveDisposition(batch, input.failure);
  const parentStatus = PARENT_TERMINAL_BY_DISPOSITION[disposition];

  await recordStep(tx, {
    runId: parent.id,
    stepKey: 'send_batch_closed',
    detail: {
      disposition,
      sent: counts.sent,
      withheld: counts.withheld,
      cancelled: counts.cancelled,
      failed: counts.failed,
      unknown: counts.unknown,
      withheld_by_reason: counts.withheldByReason,
    },
  });

  // One terminalization, and the failure's error payload rides with it. Both
  // arms write agent_runs only AFTER the batch lock, which is what keeps this
  // lane single-ordered. `failSolicitationBatchRun` transitions to 'failed' and
  // is the only writer of the error jsonb, so a failure disposition goes through
  // it rather than through completeRun.
  //
  // Branch on the resolved DISPOSITION, never on `input.failure` being present:
  // `halted` and `expired` outrank both failure arms, so a halted batch that was
  // also handed a failure must still terminalize `cancelled`. Branching on the
  // parameter would write 'failed' while returning parentStatus 'cancelled' —
  // the row and the receipt disagreeing about the same run.
  if (parentStatus === 'failed' && input.failure) {
    await failSolicitationBatchRun(tx, { runId: parent.id, failure: input.failure });
  } else {
    await completeRun(tx, parent.id, parentStatus);
  }

  return { status: 'closed', parentRunId: parent.id, disposition, parentStatus, counts };
}

// ── Render persistence (#628) ────────────────────────────────────────────────

/**
 * The three reasons the RENDER lane can withhold with. A subset of 091's
 * withheld vocabulary on purpose: `no_consent` / `suppressed` / `unsubscribed`
 * are dispatch-time facts and belong to #630's send lane, so this type refuses
 * to let a render writer spell them.
 */
export const RENDER_WITHHOLD_REASONS = [
  'moderation_high',
  'render_failed',
  'lint_failed',
] as const;
export type RenderWithholdReason = (typeof RENDER_WITHHOLD_REASONS)[number];

export type OutreachModerationStatus = 'clean' | 'flagged' | 'error' | 'disabled';

interface InsertOutreachRenderBase {
  accountId: string;
  businessId: string;
  batchId: string;
  askId: string;
  contactId: string;
  /** Starts at 1; a supersede inserts `priorAttemptNo + 1` (B2). */
  attemptNo: number;
  promptVersion: string;
  promptHash: string;
  askLintVersion: string;
  /** The matched lint classes; `[]` for clean and `render_failed` rows. */
  lintDetail: readonly AskLintClass[];
  moderationStatus: OutreachModerationStatus;
  /** Provider category map, or `{}` when moderation never ran cleanly. */
  moderationDetail: Record<string, unknown>;
  /**
   * The §5.3 snapshot the prompt actually saw, or `{}` for an ask that was
   * never assembled (budget-stop `render_failed` rows — locked decision 6).
   */
  interpolationInputs: AskInterpolationInputs | Record<string, never>;
  renderedAt: Date;
  /** The send parent run, when the caller has one (ON DELETE SET NULL later). */
  agentRunId: string | null;
}

/**
 * Discriminated on `deliveryStatus` so 091's CHECKs are unrepresentable to
 * violate in TS: a rendered row cannot carry a reason and MUST carry both
 * bodies (a bodyless `rendered` input is uncompilable, not a runtime 23514);
 * a withheld row must carry one of the render lane's three reasons and may be
 * bodied (`moderation_high` / `lint_failed`) or bodyless (`render_failed`) —
 * there the subject/body PAIR rule stays DB-enforced by 091's body-presence
 * CHECK.
 */
export type InsertOutreachRenderInput = InsertOutreachRenderBase &
  (
    | {
        deliveryStatus: 'rendered';
        dispositionReason?: null;
        renderedSubject: string;
        renderedBody: string;
      }
    | {
        deliveryStatus: 'withheld';
        dispositionReason: RenderWithholdReason;
        renderedSubject: string | null;
        renderedBody: string | null;
      }
  );

/**
 * Persist one render attempt. Deliberately UNCONDITIONAL — no `ON CONFLICT`
 * against `solicitation_outreach_one_live_per_ask` (spec §5.2 note): the
 * existence check happens upstream in the generation lane, the worker is
 * single-replica by invariant, and a second live insert racing past both is a
 * bug that must surface as 23505, not be silently absorbed.
 *
 * Returns the new row's id (UUIDv7, time-ordered PK convention).
 */
export async function insertOutreachRender(
  tx: TransactionSql,
  input: InsertOutreachRenderInput,
): Promise<string> {
  const outreachId = uuidv7();
  await tx`
    INSERT INTO solicitation_outreach (
      id, account_id, business_id, batch_id, ask_id, contact_id,
      attempt_no, rendered_subject, rendered_body,
      prompt_version, prompt_hash, interpolation_inputs, rendered_at,
      ask_lint_version, lint_detail, moderation_status, moderation_detail,
      delivery_status, disposition_reason, agent_run_id
    ) VALUES (
      ${outreachId}::uuid, ${input.accountId}::uuid, ${input.businessId}::uuid,
      ${input.batchId}::uuid, ${input.askId}::uuid, ${input.contactId}::uuid,
      ${input.attemptNo}, ${input.renderedSubject}, ${input.renderedBody},
      ${input.promptVersion}, ${input.promptHash},
      ${tx.json(input.interpolationInputs as never)}, ${input.renderedAt},
      ${input.askLintVersion}, ${tx.json(input.lintDetail as never)},
      ${input.moderationStatus}, ${tx.json(input.moderationDetail as never)},
      ${input.deliveryStatus}, ${input.dispositionReason ?? null},
      ${input.agentRunId}::uuid
    )
  `;
  return outreachId;
}

export interface SupersedeLiveRenderInput {
  askId: string;
  accountId: string;
  businessId: string;
}

/**
 * Cancel the ask's live RENDERED attempt so a regenerate can insert
 * `priorAttemptNo + 1` in the same transaction (B2's update-then-insert
 * contract). `delivery_status = 'rendered'` only — a released row (`queued` /
 * `sending`) is never superseded (AMEND B2), and a terminal row has nothing to
 * supersede. Returns null when no live rendered row exists, which the caller
 * must treat as a refusal; at most one row can match, guaranteed by
 * `solicitation_outreach_one_live_per_ask`.
 */
export async function supersedeLiveRender(
  tx: TransactionSql,
  input: SupersedeLiveRenderInput,
): Promise<{ priorAttemptNo: number } | null> {
  const [superseded] = await tx<{ attempt_no: number }[]>`
    UPDATE solicitation_outreach
    SET delivery_status = 'cancelled',
        disposition_reason = 'superseded',
        updated_at = NOW()
    WHERE ask_id = ${input.askId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND delivery_status = 'rendered'
    RETURNING attempt_no
  `;
  return superseded ? { priorAttemptNo: superseded.attempt_no } : null;
}

// ── JSONB read boundary (#628) ───────────────────────────────────────────────
//
// Postgres.js behind PgBouncer can hand back JSONB as a string (CLAUDE.md
// allowlist), so each parser starts with the sanctioned string guard and then
// NARROWS, throwing on a shape the writer above cannot have produced — the
// `parseEvidence` posture (batch-view.ts): a loud failure at the parse boundary
// beats a quietly wrong read model.

const LINT_CLASS_VOCABULARY: ReadonlySet<string> = new Set(ASK_LINT_CLASSES);

/** `solicitation_outreach.lint_detail`: the matched lint-class array. */
export function parseOutreachLintDetail(
  value: unknown,
  outreachId: string,
): AskLintClass[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `solicitation_outreach.lint_detail is not an array (outreach ${outreachId})`,
    );
  }
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !LINT_CLASS_VOCABULARY.has(entry)) {
      throw new Error(
        `solicitation_outreach.lint_detail carries a non-lint-class entry (outreach ${outreachId})`,
      );
    }
  }
  return parsed as AskLintClass[];
}

/** `solicitation_outreach.moderation_detail`: provider category map or `{}`. */
export function parseOutreachModerationDetail(
  value: unknown,
  outreachId: string,
): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `solicitation_outreach.moderation_detail is not an object (outreach ${outreachId})`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * `solicitation_outreach.interpolation_inputs`: the §5.3 snapshot, or null for
 * the two legal empty-object states — a never-assembled `render_failed` row
 * (locked decision 6) and a redacted row (092 empties the snapshot with the
 * prose). Anything else without the snapshot's discriminant fields throws.
 */
export function parseOutreachInterpolationInputs(
  value: unknown,
  outreachId: string,
): AskInterpolationInputs | null {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `solicitation_outreach.interpolation_inputs is not an object (outreach ${outreachId})`,
    );
  }
  if (Object.keys(parsed).length === 0) return null;
  const candidate = parsed as { contact_first_name?: unknown; note_disposition?: unknown };
  if (
    typeof candidate.contact_first_name !== 'string'
    || typeof candidate.note_disposition !== 'string'
  ) {
    throw new Error(
      `solicitation_outreach.interpolation_inputs has no snapshot discriminant (outreach ${outreachId})`,
    );
  }
  return parsed as AskInterpolationInputs;
}
