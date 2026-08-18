/**
 * Read model for the owner-facing Requests screen (#544): the most recent
 * Solicitation batch for one location, as a funnel plus its spoilage report,
 * plus each send-ask's current outreach attempt (#628) with app-enforced
 * `moderation_high` redaction (SPEC §3.3 — see AskAttemptView), plus the
 * owner-facing send lane (#629 — see SendLaneView).
 *
 * The send lane and the attempts are one presentation, gated together on the
 * caller's `options.sendLane`. The flag itself is never read here (invariant
 * #13); the route resolves it and passes it in.
 *
 * Domain module — receives its DB client explicitly (invariant #15); it never
 * imports the singleton. Every query carries BOTH account_id and business_id
 * (invariant #8); solicitation_contacts has no account_id column, so its
 * account scope comes from the businesses join exactly as contacts-repo.ts
 * does — the join IS the check.
 *
 * ADR 0012: no star rating, sentiment field, or predicted-sentiment signal is
 * read or returned here. Evidence references a candidate by ID only.
 *
 * NOTE: BATCH_CAP is deliberately NOT imported — the queued panel was dropped,
 * so nothing here needs it.
 */

import type { Sql, TransactionSql } from 'postgres';
import { peekAskRegenBudgetBatch, type RegenBudgetStatus } from '@/lib/costs/tracker';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import type { AskLintClass } from './ask-compliance-lint';
import type { AskInterpolationInputs } from './ask-prompt-policy';
import {
  deriveBatchState,
  parseOutreachInterpolationInputs,
  parseOutreachLintDetail,
  parseOutreachModerationDetail,
  type BatchLifecycleRow,
  type BatchState,
  type OutreachModerationStatus,
  type RenderWithholdReason,
} from './outreach';
import {
  WITHHOLD_REASONS,
  type AskDecision,
  type WithholdReason,
} from './restraint-policy';

/** At most this many evidence rows per withhold reason. */
export const EVIDENCE_ROWS_PER_REASON = 10;

/** Server-side cap on a rendered contact name — the column is unbounded TEXT. */
export const CONTACT_NAME_MAX = 80;

export interface AskRow {
  askId: string;
  contactId: string;
  /** Truncated to CONTACT_NAME_MAX server-side. */
  contactName: string;
  decidedAt: string;
  /**
   * The stored evidence snapshot. `solicitation_asks.evidence` is JSONB NOT
   * NULL and the builder writes a full decision envelope for sends too, so
   * this is AskDecision — never `WithholdEvidence | null`.
   */
  evidence: AskDecision;
}

export interface WithholdGroup {
  /** Verbatim code from the closed enum — never renamed or collapsed. */
  reason: WithholdReason;
  /** Exact total, from the same statement that produced `sample`. */
  total: number;
  /** At most EVIDENCE_ROWS_PER_REASON rows; empty when total is 0. */
  sample: AskRow[];
}

/**
 * The redaction sentinel (SPEC §3.3). Typed against the render lane's reason
 * union so the literal cannot drift from `RenderWithholdReason` (outreach.ts).
 */
const MODERATION_HIGH = 'moderation_high' satisfies RenderWithholdReason;

/**
 * Every `delivery_status` the attempts join can surface — migration 091's
 * CHECK vocabulary (the owner of this fact) minus the `cancelled` rows the
 * join excludes.
 */
type AskAttemptStatus =
  | 'rendered'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'withheld'
  | 'failed'
  | 'unknown';

interface AskAttemptBase {
  outreachId: string;
  askId: string;
  contactId: string;
  /** Truncated to CONTACT_NAME_MAX server-side, like AskRow. */
  contactName: string;
  /** 1-based; a regenerate supersedes and inserts prior + 1. */
  attemptNo: number;
  deliveryStatus: AskAttemptStatus;
  /** 091's status↔reason CHECK owns the vocabulary; NULL for undispatched/sent rows. */
  dispositionReason: string | null;
  renderedAt: string;
}

/**
 * The ask's current outreach attempt as the OWNER may see it.
 *
 * `redacted: true` is the `disposition_reason = 'moderation_high'` arm
 * (SPEC §3.3): the owner sees the row's existence and reason only — subject,
 * body, moderation detail, and interpolation inputs (which carry the visit
 * note's prose) never ride the view. App-enforced here because server reads
 * bypass RLS; 091's owner-SELECT carve-out is the second layer.
 *
 * Every other attempt exposes its bytes: a withheld `lint_failed` row keeps
 * its text and matched classes on purpose — the block teaches the owner
 * (SPEC §5.2).
 */
export type AskAttemptView =
  | (AskAttemptBase & { redacted: true; dispositionReason: typeof MODERATION_HIGH })
  | (AskAttemptBase & {
      redacted: false;
      /** NULL only for bodyless rows (`render_failed`, retention-redacted). */
      subject: string | null;
      body: string | null;
      lintClasses: AskLintClass[];
      moderationStatus: OutreachModerationStatus;
      moderationDetail: Record<string, unknown>;
      /** NULL when never assembled (`render_failed`) or retention-emptied (092). */
      interpolationInputs: AskInterpolationInputs | null;
    });

/**
 * The Halt latch's closed reason set (CONTEXT.md **Halt latch**): one mechanism,
 * five reasons. Migration 091's `solicitation_batches_halt_consistency` CHECK —
 * unchanged by 108, which widened `solicitation_outreach` only — is the
 * database-side owner of the same vocabulary, so a value outside this union
 * cannot be stored; the read below asserts rather than re-validates, exactly
 * like `AskAttemptStatus` and `OutreachModerationStatus` on their row types.
 *
 * The union exists so a consumer can branch exhaustively on WHO stopped the
 * batch. Only `owner_veto`/`owner_halt` are owner-caused; `admin_halt` and the
 * two system reasons (`send_window_elapsed`, `batch_expired`, both actor-less
 * by the same CHECK) are not, so copy that says "you stopped this batch" is
 * wrong for three of the five. `approval.ts` owns the owner-causable subset as
 * `OwnerHaltReason` — the two a consumer branches on to say "you did this" —
 * but that is no longer the whole of what the module writes: since #865 it also
 * writes `admin_halt`, through the private `LatchHaltReason` its two arms
 * share. The module's WRITE union is therefore wider than its EXPORTED one, on
 * purpose: `OwnerHaltReason` stays exactly two members and `LatchHaltReason`
 * stays unexported, so no caller can widen the owner arm by naming a reason.
 * This is the READ side and must name all five.
 */
export type HaltReason =
  | 'owner_veto'
  | 'owner_halt'
  | 'admin_halt'
  | 'send_window_elapsed'
  | 'batch_expired';

/**
 * The send lane as the owner reads it. `null` on the BatchView when
 * SOLICITATION_SEND_ENABLED is off — invariant #13: the browser learns flag
 * state from the response shape, never from a NEXT_PUBLIC companion.
 */
export interface SendLaneView {
  batchState: BatchState;
  /** True when every send Ask has a non-cancelled Outreach row — the
   *  precondition approveBatch re-asserts under its lock. */
  ready: boolean;
  /** Send Asks with no Outreach row yet; 0 once generation settles. */
  pendingRenders: number;
  approvedAt: string | null;
  vetoDeadlineAt: string | null;
  haltedAt: string | null;
  haltReason: HaltReason | null;
  /** moderation_high attempts as a COUNT (D6a) — the owner sees that some were
   *  held without ever seeing the bytes. */
  moderationWithheld: number;
  /**
   * The ask whose regeneration is in flight, or null. Read from the in-flight
   * `job_outbox` row, so it survives a reload and cannot disagree with the
   * enqueue's `already_in_flight` refusal — both read the same row.
   *
   * At most ONE per batch: the dedup is keyed `(topic, aggregate_id = batchId)`
   * by migration 091's partial unique index. A WHOLE-BATCH generation row
   * carries no `ask_id`, so this is null during `preparing`, where the panel
   * offers no per-ask control anyway.
   */
  regeneratingAskId: string | null;
  /**
   * Per-ask daily regenerate budget, keyed by ask id. An ABSENT key means
   * UNKNOWN (Redis unreachable), never "0 remaining" — the panel renders no
   * counter and leaves the control enabled. A plain Record rather than the Map
   * `peekAskRegenBudgetBatch` returns, because this crosses the wire (D12).
   */
  regenBudgets: Record<string, RegenBudgetStatus>;
}

export type BatchView =
  | { state: 'no_batch'; contactsOnFile: number }
  | { state: 'building'; batchId: string; createdAt: string; contactsOnFile: number }
  | {
      state: 'built';
      batchId: string;
      builtAt: string;
      contactsOnFile: number;
      evaluated: number;
      queued: number;
      held: number;
      /** ALWAYS all six reasons in precedence order, zero-total groups included. */
      groups: WithholdGroup[];
      /**
       * Each send-ask's current outreach attempt (#628), at most one per ask.
       * Bounded by the batch builder's send cap; asks not yet generated have
       * no entry.
       *
       * ALWAYS `[]` when `sendLane` is null (#629): the flag masters the whole
       * send-lane presentation, so a batch rendered while send mode was on
       * stops surfacing message bodies the moment it goes off.
       */
      attempts: AskAttemptView[];
      /** null when SOLICITATION_SEND_ENABLED is off — see SendLaneView. */
      sendLane: SendLaneView | null;
    };

interface LatestBatchRow {
  id: string;
  built_at: string | null;
  created_at: string;
}

interface AskAggregateRow {
  queued: number;
  held: number;
  evaluated: number;
  askId: string | null;
  contactId: string | null;
  contactName: string | null;
  decidedAt: string | null;
  evidence: unknown;
  reason: WithholdReason | null;
  groupTotal: number | null;
}

/**
 * Postgres.js behind PgBouncer can hand back JSONB as a string (CLAUDE.md
 * allowlist). The rest of the shape is owned by batch-builder.ts, the only
 * writer of this column.
 *
 * The discriminant is now enforced at WRITE time too — migration 090's
 * `solicitation_asks_evidence_matches_columns` (#593) — so these throws should
 * be unreachable for stored rows. They stay because this is still the parse
 * boundary: the CHECK cannot vouch for what `JSON.parse` returns, and a throw
 * that fires here means the constraint was dropped or bypassed, which is worth
 * a loud failure rather than a rendered blank.
 *
 * Only the `decision` discriminant is validated here — deliberately. The rest
 * of the shape (including #620 §6.1's widened `no_consent` evidence, whose
 * `upload_id` / `attestation_version` are BOTH nullable: case (a) both null,
 * case (b) both populated) belongs to the writer; re-validating it here would
 * be a second owner of the serialization contract.
 */
function parseEvidence(value: unknown, askId: string): AskDecision {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`solicitation_asks.evidence is not an object (ask ${askId})`);
  }
  const decision = (parsed as { decision?: unknown }).decision;
  if (decision !== 'send' && decision !== 'withhold') {
    throw new Error(`solicitation_asks.evidence has no decision discriminant (ask ${askId})`);
  }
  return parsed as AskDecision;
}

interface AskAttemptDbRow {
  outreachId: string;
  askId: string;
  contactId: string;
  contactName: string;
  attemptNo: number;
  deliveryStatus: AskAttemptStatus;
  dispositionReason: string | null;
  renderedAt: string;
  subject: string | null;
  body: string | null;
  lintDetail: unknown;
  moderationStatus: OutreachModerationStatus;
  moderationDetail: unknown;
  interpolationInputs: unknown;
}

/**
 * Second redaction layer, after the SQL CASE: a `moderation_high` row maps to
 * the bare marker without ever TOUCHING its content columns, so even a
 * regression in the SQL layer cannot leak bytes into the view. The JSONB
 * parses run only on the unredacted arm — they are Task 7's shared PgBouncer
 * carve-out sites (outreach.ts), not new inline parsers.
 */
function toAttempts(rows: AskAttemptDbRow[]): AskAttemptView[] {
  const seenAskIds = new Set<string>();
  return rows.map((row): AskAttemptView => {
    // The non-cancelled predicate leans on domain invariants (withheld ends
    // the attempt line; supersede swaps atomically), not on an index — so a
    // second row is corruption and must fail loudly, not render twice.
    if (seenAskIds.has(row.askId)) {
      throw new Error(
        `ask ${row.askId} has more than one non-cancelled outreach attempt`,
      );
    }
    seenAskIds.add(row.askId);

    const base: AskAttemptBase = {
      outreachId: row.outreachId,
      askId: row.askId,
      contactId: row.contactId,
      contactName: row.contactName,
      attemptNo: row.attemptNo,
      deliveryStatus: row.deliveryStatus,
      dispositionReason: row.dispositionReason,
      renderedAt: row.renderedAt,
    };
    if (row.dispositionReason === MODERATION_HIGH) {
      return { ...base, redacted: true, dispositionReason: MODERATION_HIGH };
    }
    return {
      ...base,
      redacted: false,
      subject: row.subject,
      body: row.body,
      lintClasses: parseOutreachLintDetail(row.lintDetail, row.outreachId),
      moderationStatus: row.moderationStatus,
      moderationDetail: parseOutreachModerationDetail(row.moderationDetail, row.outreachId),
      interpolationInputs: parseOutreachInterpolationInputs(
        row.interpolationInputs,
        row.outreachId,
      ),
    };
  });
}

/** Zero-fills the closed enum so the UI can never branch on a missing group. */
function toGroups(rows: AskAggregateRow[]): WithholdGroup[] {
  const byReason = new Map<WithholdReason, WithholdGroup>();

  for (const row of rows) {
    if (row.reason === null || row.askId === null) continue;
    const group = byReason.get(row.reason) ?? {
      reason: row.reason,
      total: row.groupTotal ?? 0,
      sample: [],
    };
    group.sample.push({
      askId: row.askId,
      contactId: row.contactId ?? '',
      contactName: row.contactName ?? '',
      decidedAt: row.decidedAt ?? '',
      evidence: parseEvidence(row.evidence, row.askId),
    });
    byReason.set(row.reason, group);
  }

  return WITHHOLD_REASONS.map(
    (reason) => byReason.get(reason) ?? { reason, total: 0, sample: [] },
  );
}

/**
 * Q5's lifecycle row: the raw `Date` columns `deriveBatchState` compares, the
 * `::text` forms the view ships, and two independent scalar aggregates.
 * Extending `BatchLifecycleRow` rather than re-listing six columns keeps this
 * row and the function that consumes it from drifting apart.
 */
interface SendLaneLifecycleRow extends BatchLifecycleRow {
  approvedAtText: string | null;
  vetoDeadlineAtText: string | null;
  haltedAtText: string | null;
  haltReason: HaltReason | null;
  pendingRenders: number;
  moderationWithheld: number;
}

/**
 * The ask id of the one in-flight per-ask regeneration for this batch, or null.
 *
 * NO tenant predicate, and that is correct rather than an oversight:
 * `job_outbox` is absent from `scripts/ci/tenant-tables.ts`, so a statement
 * referencing only that table is not audited by `ci:tenant-scope` and needs no
 * allowlist entry. Its safety comes from the CALLER — `readLatestBatch` has
 * already resolved this batch through account- and business-scoped reads, so
 * `batchId` is proven, and the only value returned is an ask id belonging to a
 * batch the caller owns.
 *
 * Do NOT "fix" this by joining `solicitation_batches` to make it look scoped:
 * that pulls a tenant table into the statement, makes it auditable, and demands
 * scope keys on a query whose proof lives upstream.
 *
 * `aggregate_id` IS that proven batch id — migration 091's comment contract for
 * this topic — and the partial unique index it backs allows at most one
 * in-flight row per batch, so `LIMIT 1` is the whole answer rather than a
 * truncation.
 *
 * A WHOLE-BATCH generation row's payload has no `ask_id`, so `->>` yields SQL
 * NULL and this returns null: the panel reads that as "preparing", not as a
 * spinning row. `payload->>'ask_id'` returns TEXT, so this is OUTSIDE the
 * PgBouncer JSONB-as-string carve-out — no parse, no guard, and `parseEvidence`
 * above is deliberately not reused here.
 *
 * The status list is spelled by hand, in this order. `ci:outbox-status` checks
 * members AND order at every site, and the set cannot be parameterized (a bind
 * parameter inside an `ON CONFLICT … WHERE` defeats partial-index inference, so
 * every site in the repo re-spells it identically — see
 * `src/lib/shared/job-outbox-status.ts`, the owner of that contract).
 */
async function readRegeneratingAskId(
  db: Sql | TransactionSql,
  batchId: string,
): Promise<string | null> {
  const [row] = await db<{ askId: string | null }[]>`
    SELECT payload->>'ask_id' AS "askId"
      FROM job_outbox
     WHERE topic = ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS}
       AND aggregate_id = ${batchId}::uuid
       AND status IN ('pending', 'dispatching', 'dispatched')
     LIMIT 1
  `;
  return row?.askId ?? null;
}

/**
 * The whole owner-facing send lane: each send-ask's current outreach attempt
 * plus the batch's lifecycle row and its two readiness counts.
 *
 * Extracted from `readBuiltBatch`, which had reached 241 lines and did this
 * work inline behind an `options.sendLane` branch. The caller owns the FLAG
 * decision (whether to call at all); this function owns the READ.
 *
 * THREE statements, all issued on the caller's transaction, which is REPEATABLE
 * READ: each therefore reads the SAME snapshot as the funnel numbers above.
 * A `ready: true` rendered beside attempts that disagree with it is exactly the
 * tear the transaction exists to prevent, and statements inside one snapshot
 * cannot reintroduce it.
 *
 * The third (#860) is an ADVISORY presentation fact, not an input to any gate
 * — the authoritative refusals are the enqueue's `ON CONFLICT` dedup and the
 * worker's Lua INCR. It is read AFTER the tenant-scoped statements rather than
 * woven into them, so it cannot widen or weaken a scoped predicate.
 *
 * The per-ask regenerate counters are the same kind of advisory fact, and for
 * that reason they are NOT read here at all: `attachRegenBudgets` peeks them
 * once this transaction has closed. This function issues Postgres statements
 * and nothing else.
 */
async function readSendLane(
  tx: TransactionSql,
  accountId: string,
  businessId: string,
  batchId: string,
): Promise<{ attempts: AskAttemptView[]; sendLane: SendLaneView }> {
  // Q4 — each send-ask's current outreach attempt (#628). `delivery_status !=
  // 'cancelled'` deliberately, NOT the live-only set: `withheld` rows are
  // terminal yet owner-visible — a lint block teaches the owner (SPEC §5.2).
  // At most one such row exists per ask (withheld ends the attempt line —
  // no regen, rule 6 — and a rendered row is only replaced via the atomic
  // supersede swap), so the result is bounded by the batch's send-ask count.
  //
  // The CASE redaction is the first of two in-process-leak guards: for a
  // `moderation_high` row the content columns (subject, body, lint detail,
  // moderation detail, interpolation inputs — the last carries the visit
  // note's prose) never leave the database (SPEC §3.3). toAttempts() is the
  // second; 091's owner-SELECT RLS carve-out backstops direct client reads.
  const attemptRows = await tx<AskAttemptDbRow[]>`
    SELECT o.id                 AS "outreachId",
           o.ask_id             AS "askId",
           o.contact_id         AS "contactId",
           LEFT(c.name, ${CONTACT_NAME_MAX}) AS "contactName",
           o.attempt_no         AS "attemptNo",
           o.delivery_status    AS "deliveryStatus",
           o.disposition_reason AS "dispositionReason",
           o.rendered_at::text  AS "renderedAt",
           CASE WHEN o.disposition_reason = ${MODERATION_HIGH}
                THEN NULL ELSE o.rendered_subject END      AS "subject",
           CASE WHEN o.disposition_reason = ${MODERATION_HIGH}
                THEN NULL ELSE o.rendered_body END         AS "body",
           CASE WHEN o.disposition_reason = ${MODERATION_HIGH}
                THEN NULL ELSE o.lint_detail END           AS "lintDetail",
           o.moderation_status  AS "moderationStatus",
           CASE WHEN o.disposition_reason = ${MODERATION_HIGH}
                THEN NULL ELSE o.moderation_detail END     AS "moderationDetail",
           CASE WHEN o.disposition_reason = ${MODERATION_HIGH}
                THEN NULL ELSE o.interpolation_inputs END  AS "interpolationInputs"
      FROM solicitation_outreach o
      JOIN solicitation_contacts c
        ON c.id = o.contact_id AND c.business_id = ${businessId}
     WHERE o.account_id = ${accountId}
       AND o.business_id = ${businessId}
       AND o.batch_id = ${batchId}
       AND o.delivery_status <> 'cancelled'
     ORDER BY o.rendered_at, o.id
  `;

  // Q5 — the lifecycle row plus two independent scalar aggregates. Every
  // timestamp is selected TWICE on purpose: `deriveBatchState` compares JS
  // `Date`s, so it needs the raw columns; the VIEW ships the `::text` form
  // because postgres.js truncates microseconds when it decodes timestamptz —
  // only the text ever reaches the wire.
  //
  // Never turn these aggregates into child-table JOINs on `b`. The former join
  // shape multiplied every pending-render candidate by every moderation-held
  // row before COUNT(DISTINCT ...) hid the wrong intermediate. Scalar
  // subqueries keep the two child relations independent, while the query-block
  // aware tenant audit (#859) can now prove their tenant correlations directly.
  const [lane] = await tx<SendLaneLifecycleRow[]>`
    SELECT b.built_at, b.approved_at, b.veto_deadline_at,
           b.sending_started_at, b.send_closed_at, b.halted_at,
           b.approved_at::text       AS "approvedAtText",
           b.veto_deadline_at::text  AS "vetoDeadlineAtText",
           b.halted_at::text         AS "haltedAtText",
           b.halt_reason             AS "haltReason",
           (
             SELECT COUNT(*)::int
               FROM solicitation_asks a
              WHERE a.batch_id = b.id
                AND a.account_id = b.account_id
                AND a.business_id = b.business_id
                AND a.status = 'send'
                AND NOT EXISTS (
                  SELECT 1
                    FROM solicitation_outreach o
                   WHERE o.ask_id = a.id
                     AND o.batch_id = a.batch_id
                     AND o.account_id = ${accountId}::uuid
                     AND o.business_id = ${businessId}::uuid
                     AND o.delivery_status <> 'cancelled'
                )
           ) AS "pendingRenders",
           (
             SELECT COUNT(*)::int
               FROM solicitation_outreach mo
              WHERE mo.batch_id = b.id
                AND mo.account_id = b.account_id
                AND mo.business_id = b.business_id
                AND mo.disposition_reason = ${MODERATION_HIGH}
           ) AS "moderationWithheld"
      FROM solicitation_batches b
     WHERE b.id = ${batchId}::uuid
       AND b.account_id = ${accountId}::uuid
       AND b.business_id = ${businessId}::uuid
  `;

  // readLatestBatch already read this row in this snapshot, so absence is
  // not a lost race — it means the tenant predicate disagreed with the one
  // that selected the batch. Loud beats a blank lane rendered as `pending`.
  if (!lane) {
    throw new Error(`solicitation batch ${batchId} is unreadable in its own snapshot`);
  }

  const attempts = toAttempts(attemptRows);

  // Q6 — the in-flight regeneration row. See readRegeneratingAskId for why it
  // carries no tenant predicate and must not grow one.
  const regeneratingAskId = await readRegeneratingAskId(tx, batchId);

  return {
    attempts,
    sendLane: {
      batchState: deriveBatchState(lane, new Date()),
      // Advisory only: approveBatch re-asserts this precondition under its own
      // lock, because a render can land between this read and the owner's
      // click.
      ready: lane.pendingRenders === 0,
      pendingRenders: lane.pendingRenders,
      approvedAt: lane.approvedAtText,
      vetoDeadlineAt: lane.vetoDeadlineAtText,
      haltedAt: lane.haltedAtText,
      haltReason: lane.haltReason,
      moderationWithheld: lane.moderationWithheld,
      regeneratingAskId,
      // EMPTY here on purpose — the counters are attached AFTER the
      // transaction closes, by `attachRegenBudgets`. Nothing inside a pooled
      // Postgres transaction may await Upstash; see that function for why.
      // An empty record is also the fail-open answer, so a caller that somehow
      // skipped the attach step renders no counter rather than a wrong one.
      regenBudgets: {},
    },
  };
}

async function readBuiltBatch(
  tx: TransactionSql,
  accountId: string,
  businessId: string,
  batch: LatestBatchRow & { built_at: string },
  contactsOnFile: number,
  options: { sendLane: boolean },
): Promise<BatchView> {
  // EVERY ask-derived number in ONE statement — funnel totals, per-reason
  // totals and the bounded evidence sample from a single snapshot.
  //
  // This MUST stay one statement. Splitting the funnel's queued/held counts
  // from the ledger's per-reason totals reintroduces a tear: the owner DELETE
  // in contacts-repo.ts cascades to asks via
  // solicitation_asks_contact_business_fk, so a deletion landing between two
  // statements yields a `held` that disagrees with the sum of its own reason
  // groups.
  //
  // `ranked` carries ids and rank only: the payload columns (evidence JSONB,
  // contact name) are joined back for the <= 6 x EVIDENCE_ROWS_PER_REASON rows
  // that survive, instead of being dragged through the window sort. Repeating
  // the tenant keys on the later joins independently scopes each new physical
  // binding; the audit deliberately will not transfer the `ranked` CTE's proof
  // through a row-id correlation such as a.id = r.id.
  //
  // The LEFT JOIN chain is load-bearing: `totals` always yields exactly one
  // row, so a batch with zero asks (or zero withholds) still returns its
  // counts instead of an empty result the caller would have to special-case.
  const rows = await tx<AskAggregateRow[]>`
    WITH ranked AS (
      SELECT id,
             -- ::int is load-bearing: COUNT(*) OVER returns bigint, which
             -- postgres.js surfaces as a string, breaking the number contract.
             (COUNT(*) OVER (PARTITION BY withheld_reason))::int AS group_total,
             ROW_NUMBER() OVER (PARTITION BY withheld_reason
                                ORDER BY decided_at DESC, id DESC) AS rn
        FROM solicitation_asks
       WHERE account_id = ${accountId}
         AND business_id = ${businessId}
         AND batch_id = ${batch.id}
         AND status = 'withhold'
    ),
    totals AS (
      SELECT COUNT(*) FILTER (WHERE status = 'send')::int     AS queued,
             COUNT(*) FILTER (WHERE status = 'withhold')::int AS held,
             COUNT(*)::int                                    AS evaluated
        FROM solicitation_asks
       WHERE account_id = ${accountId}
         AND business_id = ${businessId}
         AND batch_id = ${batch.id}
    )
    SELECT t.queued, t.held, t.evaluated,
           a.id               AS "askId",
           a.contact_id       AS "contactId",
           LEFT(c.name, ${CONTACT_NAME_MAX}) AS "contactName",
           a.decided_at::text AS "decidedAt",
           a.evidence,
           a.withheld_reason  AS reason,
           r.group_total      AS "groupTotal"
      FROM totals t
      LEFT JOIN ranked r ON r.rn <= ${EVIDENCE_ROWS_PER_REASON}
      LEFT JOIN solicitation_asks a
        ON a.id = r.id
       AND a.account_id = ${accountId}
       AND a.business_id = ${businessId}
      LEFT JOIN solicitation_contacts c
        ON c.id = a.contact_id AND c.business_id = ${businessId}
     ORDER BY a.withheld_reason, r.rn
  `;

  // The SEND LANE is flag-mastered end to end (#629). `options.sendLane`
  // arrives from the ROUTE — the one place SOLICITATION_SEND_ENABLED is read
  // (invariant #13): a read model that read env could not be tested without
  // mutating process.env, and a NEXT_PUBLIC companion is forbidden outright.
  //
  // With the flag off NONE of readSendLane's statements is issued and the view
  // carries `sendLane: null` WITH `attempts: []`. #628 shipped `attempts`
  // unconditional; this narrows it on purpose, so a batch whose drafts were
  // rendered while send mode was on stops surfacing message bodies the instant
  // the flag goes off.
  const lane = options.sendLane
    ? await readSendLane(tx, accountId, businessId, batch.id)
    : null;

  // `totals` is an unfiltered aggregate, so the LEFT JOIN always yields >= 1
  // row and every row repeats the same funnel numbers.
  const totals = rows[0];
  const queued = totals?.queued ?? 0;
  const held = totals?.held ?? 0;

  return {
    state: 'built',
    batchId: batch.id,
    builtAt: batch.built_at,
    contactsOnFile,
    // Equal to queued + held by the status CHECK constraint (migration 088).
    evaluated: totals?.evaluated ?? 0,
    queued,
    held,
    groups: toGroups(rows),
    attempts: lane?.attempts ?? [],
    sendLane: lane?.sendLane ?? null,
  };
}

/**
 * Attach the advisory per-ask regenerate counters to a built send lane.
 *
 * Runs AFTER `readLatestBatch`'s transaction has closed, and the placement is
 * the point (#860 round-1 R3). `peekAskRegenBudgetBatch` is an Upstash `MGET`
 * with a multi-second command timeout; awaiting it inside the read model's
 * `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` block held an
 * admission-gated pooled Postgres connection open across a cross-provider
 * network round trip on EVERY built-batch GET and every 2s poll of a
 * regenerating batch. Under the #773 admission chokepoint pool occupancy is
 * the scarce resource by design — the gate trades latency for never wedging —
 * so spending a slot on a read the snapshot does not need is exactly backwards.
 * The precedent this seam was modelled on, `src/lib/past-replies/load-replies.ts`,
 * performs the identical peek outside any transaction.
 *
 * Nothing is lost by leaving the snapshot. These counters are ADVISORY
 * presentation facts, not inputs to any gate (the authoritative refusals are
 * the enqueue's `ON CONFLICT` dedup and the worker's Lua INCR), so they never
 * had to agree with the funnel numbers the transaction exists to keep
 * consistent — and the peek is read-only, so there is no write to order.
 *
 * Only a RENDERED attempt can be regenerated (a withheld row ends the attempt
 * line, rule 6), so only those need a counter — and an empty id list
 * short-circuits inside the peek without touching Redis at all.
 *
 * NO catch here, deliberately: `peekAskRegenBudgetBatch` has no rejection
 * path. A transport failure AND a synchronous client-construction throw both
 * resolve to an EMPTY map, logged there on the shared
 * `regen_budget_peek_failed` stream. Empty means every key is UNKNOWN, which
 * renders no counter and leaves every control ENABLED — the inverse ("0
 * remaining") would disable the whole lane during an Upstash outage. An absent
 * Redis KEY is a DIFFERENT fact and still arrives as `{ used: 0 }`; inverting
 * those two is the mistake this comment exists to prevent. The authoritative
 * gate is unaffected either way: the worker's `checkAskRegenBudget` still
 * refuses over-budget work before any spend.
 *
 * The result stays a plain `Record` rather than a `Map` (D12): it crosses the
 * wire as JSON.
 */
async function attachRegenBudgets(view: BatchView): Promise<BatchView> {
  // Not built, or the send flag is off: no attempts, no controls, no counters
  // — and no Redis call at all.
  if (view.state !== 'built' || view.sendLane === null) return view;

  const regenBudgets = Object.fromEntries(
    await peekAskRegenBudgetBatch(
      view.attempts
        .filter((attempt) => attempt.deliveryStatus === 'rendered')
        .map((attempt) => attempt.askId),
    ),
  );

  return { ...view, sendLane: { ...view.sendLane, regenBudgets } };
}

/**
 * The latest Solicitation batch for one location, discriminated by whether a
 * batch exists at all, is still building, or is built.
 *
 * All reads run inside ONE read-only REPEATABLE READ transaction: account
 * offboarding purge can delete a batch or its asks between statements, which
 * would otherwise render a "built" batch with zero asks — a legitimate-looking
 * screen describing a batch that no longer exists.
 *
 * `contactsOnFile` is deliberately a present-tense fact, not a funnel rung, so
 * it is allowed to move independently of the batch it is shown beside.
 *
 * `options.sendLane` is SOLICITATION_SEND_ENABLED, resolved by the CALLER
 * (invariant #13). It is a required parameter rather than a defaulted one on
 * purpose: a caller that forgets it should not silently get either answer.
 *
 * The transaction contains Postgres statements ONLY. The one non-Postgres read
 * on this path — the advisory per-ask regenerate peek — runs after it closes,
 * in `attachRegenBudgets`, because a pooled connection must never be held
 * across a call to another provider.
 */
export async function readLatestBatch(
  sql: Sql,
  accountId: string,
  businessId: string,
  options: { sendLane: boolean },
): Promise<BatchView> {
  const view: BatchView = await sql.begin(async (tx): Promise<BatchView> => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

    // created_at is NOT unique (migration 088), so the UUIDv7 id is the
    // tie-break; without it "most recent" is nondeterministic. Timestamps as
    // ::text — postgres.js decodes timestamptz to a JS Date and silently
    // truncates microseconds.
    const batches = await tx<LatestBatchRow[]>`
      SELECT id, built_at::text AS built_at, created_at::text AS created_at
        FROM solicitation_batches
       WHERE account_id = ${accountId} AND business_id = ${businessId}
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    `;

    const contacts = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
        FROM solicitation_contacts c
        JOIN businesses b ON b.id = c.business_id
       WHERE c.business_id = ${businessId} AND b.account_id = ${accountId}
    `;
    const contactsOnFile = contacts[0]?.n ?? 0;

    const batch = batches[0];
    if (!batch) return { state: 'no_batch', contactsOnFile };
    if (batch.built_at === null) {
      // Deliberate divergence from 088's owner-SELECT RLS (which hides
      // pending batches from the anon/authenticated roles): this server-side
      // read runs over Postgres.js and MAY surface the pending id/created_at
      // so the UI can show "building…". Ask-level detail stays gated on
      // built_at (readBuiltBatch below is unreachable for pending batches),
      // so no decision counts or evidence leak before the build completes.
      return {
        state: 'building',
        batchId: batch.id,
        createdAt: batch.created_at,
        contactsOnFile,
      };
    }

    return readBuiltBatch(
      tx,
      accountId,
      businessId,
      { ...batch, built_at: batch.built_at },
      contactsOnFile,
      options,
    );
  });

  // The ONE cross-provider read on this path, deliberately OUTSIDE the
  // transaction above. See attachRegenBudgets.
  return attachRegenBudgets(view);
}

/**
 * The admin/support projection of a location's latest Solicitation batch
 * (#865, plan §3.2) — the READ side of the **Halt latch**'s admin arm.
 *
 * Deliberately NOT `readLatestBatch` with a flag. That view carries
 * `attempts: AskAttemptView[]`, which serializes a customer's rendered subject
 * and body; an operator answering "this owner called, stop their batch" has no
 * business reading those bytes, and reusing the owner view would have made the
 * leak a default rather than a decision (D9). The key set here is CLOSED and
 * carries no message content at all.
 *
 * THREE counts, never one folded number. An earlier draft carried a single
 * `liveOutreachCount` documented as "what a stop would cancel" while including
 * the `sending` rows — precisely the rows the latch does NOT touch (plan round
 * 1, finding 8). Keeping them apart is what stops the panel implying that a
 * stop recalls an in-flight send.
 */
export interface AdminBatchSummary {
  batchId: string;
  batchState: BatchState;
  builtAt: string | null;
  approvedAt: string | null;
  haltedAt: string | null;
  haltReason: HaltReason | null;
  /** **Outreach rows** a stop WOULD cancel: `rendered` + `queued` only. */
  cancellableCount: number;
  /** In flight. A stop does NOT touch these — halt is "no further sends". */
  sendingCount: number;
  /** Already delivered; unreachable by any halt. */
  sentCount: number;
}

/**
 * Every timestamp is read TWICE for the same reason `readSendLane` reads its
 * lifecycle row twice: `deriveBatchState` compares JS `Date`s, so it needs the
 * raw columns, while only the `::text` form ever reaches the wire — postgres.js
 * decodes `timestamptz` to a `Date` and silently truncates microseconds.
 */
interface AdminBatchSummaryRow extends BatchLifecycleRow {
  id: string;
  builtAtText: string | null;
  approvedAtText: string | null;
  haltedAtText: string | null;
  haltReason: HaltReason | null;
  cancellableCount: number;
  sendingCount: number;
  sentCount: number;
}

/**
 * The latest batch for one location, admin projection only. `null` when the
 * location has no batch — and identically `null` when the account/business
 * pair does not own the batch it names, which is what makes the route's 404
 * indistinguishable from "unknown id".
 *
 * ONE statement, so the state and its counts cannot tear apart; the counts are
 * scalar subqueries rather than joins on `b` for the reason `readSendLane`
 * records — a join shape multiplies one child relation by the other, and the
 * query-block aware tenant audit (#859) can prove a subquery's correlation
 * directly. Both tenant predicates are spelled top-level in EVERY block.
 *
 * Ordering follows `readLatestBatch`: `created_at` is not unique (migration
 * 088), so the UUIDv7 id is the tie-break — without it "latest" is
 * nondeterministic.
 */
export async function readAdminBatchSummary(
  sql: Sql,
  accountId: string,
  businessId: string,
): Promise<AdminBatchSummary | null> {
  const [row] = await sql<AdminBatchSummaryRow[]>`
    SELECT b.id,
           b.built_at, b.approved_at, b.veto_deadline_at,
           b.sending_started_at, b.send_closed_at, b.halted_at,
           b.built_at::text     AS "builtAtText",
           b.approved_at::text  AS "approvedAtText",
           b.halted_at::text    AS "haltedAtText",
           b.halt_reason        AS "haltReason",
           (
             SELECT COUNT(*)::int
               FROM solicitation_outreach o
              WHERE o.batch_id = b.id
                AND o.account_id = ${accountId}::uuid
                AND o.business_id = ${businessId}::uuid
                AND o.delivery_status IN ('rendered', 'queued')
           ) AS "cancellableCount",
           (
             SELECT COUNT(*)::int
               FROM solicitation_outreach o
              WHERE o.batch_id = b.id
                AND o.account_id = ${accountId}::uuid
                AND o.business_id = ${businessId}::uuid
                AND o.delivery_status = 'sending'
           ) AS "sendingCount",
           (
             SELECT COUNT(*)::int
               FROM solicitation_outreach o
              WHERE o.batch_id = b.id
                AND o.account_id = ${accountId}::uuid
                AND o.business_id = ${businessId}::uuid
                AND o.delivery_status = 'sent'
           ) AS "sentCount"
      FROM solicitation_batches b
     WHERE b.account_id = ${accountId}::uuid
       AND b.business_id = ${businessId}::uuid
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT 1
  `;

  if (!row) return null;

  return {
    batchId: row.id,
    batchState: deriveBatchState(row, new Date()),
    builtAt: row.builtAtText,
    approvedAt: row.approvedAtText,
    haltedAt: row.haltedAtText,
    haltReason: row.haltReason,
    cancellableCount: row.cancellableCount,
    sendingCount: row.sendingCount,
    sentCount: row.sentCount,
  };
}

/**
 * Records that an owner opened the spoilage report. First-write-wins and
 * idempotent: a second view never moves the timestamp. Returns the number of
 * rows updated so the caller can tell "already reviewed" (0) from "recorded"
 * (1) — a silent 0 must not be indistinguishable from a failure.
 *
 * Both WHERE guards are load-bearing against migration 088's
 * solicitation_batches_reviewed_after_built CHECK: it rejects a reviewed_at on
 * an unbuilt batch, and requires reviewed_at >= built_at. built_at comes from
 * the worker host clock while NOW() is the database clock, so a worker running
 * ahead would otherwise raise a constraint violation on a normal page view.
 */
export async function markBatchReviewed(
  sql: Sql,
  accountId: string,
  businessId: string,
  batchId: string,
): Promise<number> {
  const updated = await sql<{ id: string }[]>`
    UPDATE solicitation_batches
       SET reviewed_at = GREATEST(NOW(), built_at)
     WHERE id = ${batchId}
       AND account_id = ${accountId}
       AND business_id = ${businessId}
       AND built_at IS NOT NULL
       AND reviewed_at IS NULL
    RETURNING id
  `;
  return updated.length;
}
