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
import type { AskLintClass } from './ask-compliance-lint';
import type { AskInterpolationInputs } from './ask-prompt-policy';
import {
  deriveBatchState,
  parseOutreachInterpolationInputs,
  parseOutreachLintDetail,
  parseOutreachModerationDetail,
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
  haltReason: string | null;
  /** moderation_high attempts as a COUNT (D6a) — the owner sees that some were
   *  held without ever seeing the bytes. */
  moderationWithheld: number;
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
  // the tenant keys on that join is also what keeps the scope check visible to
  // ci:tenant-scope, which cannot see inside a CTE body.
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

  // Everything below is the SEND LANE, and it is flag-mastered end to end
  // (#629). `options.sendLane` arrives from the ROUTE — the one place
  // SOLICITATION_SEND_ENABLED is read (invariant #13): a read model that read
  // env could not be tested without mutating process.env, and a NEXT_PUBLIC
  // companion is forbidden outright.
  //
  // With the flag off NEITHER statement is issued and the view carries
  // `sendLane: null` WITH `attempts: []`. #628 shipped `attempts`
  // unconditional; this narrows it on purpose, so a batch whose drafts were
  // rendered while send mode was on stops surfacing message bodies the instant
  // the flag goes off.
  let attempts: AskAttemptView[] = [];
  let sendLane: SendLaneView | null = null;

  if (options.sendLane) {
    // Each send-ask's current outreach attempt (#628). `delivery_status !=
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
    // Same snapshot as the funnel numbers — same REPEATABLE READ transaction.
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
         AND o.batch_id = ${batch.id}
         AND o.delivery_status <> 'cancelled'
       ORDER BY o.rendered_at, o.id
    `;
    attempts = toAttempts(attemptRows);

    // The lifecycle row and both readiness counts in ONE statement, in the
    // SAME snapshot as the funnel and the attempts above: a `ready: true`
    // rendered beside attempts that disagree with it is exactly the tear this
    // transaction exists to prevent.
    //
    // Every timestamp is selected TWICE on purpose. `deriveBatchState`
    // compares JS `Date`s, so it needs the raw columns; the VIEW ships the
    // `::text` form because postgres.js truncates microseconds when it decodes
    // timestamptz — only the text ever reaches the wire.
    //
    // The two counts are LEFT JOINs rather than the obvious scalar subqueries,
    // and every join repeats the tenant keys as bind parameters. That shape is
    // load-bearing twice over: ci:tenant-scope replaces any parenthesised
    // SELECT with a placeholder before it reads predicates, so a tenant table
    // reachable ONLY from inside a subquery is seen as referenced but never as
    // scoped — the audit's whole view is the top-level clauses. Same reason
    // the funnel query above repeats its keys on the `ranked` join.
    //
    // `mo` multiplies the `a`/`o` rows, so both counts are COUNT(DISTINCT …):
    // `pendingRenders` counts send Asks whose live-Outreach join found nothing,
    // `moderationWithheld` counts the held rows themselves. A batch with no
    // asks yields COUNT(DISTINCT NULL) = 0 rather than a missing row, which is
    // why these are LEFT joins onto the single `b` row.
    const [lane] = await tx<{
      built_at: Date | null;
      approved_at: Date | null;
      veto_deadline_at: Date | null;
      sending_started_at: Date | null;
      send_closed_at: Date | null;
      halted_at: Date | null;
      approvedAtText: string | null;
      vetoDeadlineAtText: string | null;
      haltedAtText: string | null;
      haltReason: string | null;
      pendingRenders: number;
      moderationWithheld: number;
    }[]>`
      SELECT b.built_at, b.approved_at, b.veto_deadline_at,
             b.sending_started_at, b.send_closed_at, b.halted_at,
             b.approved_at::text       AS "approvedAtText",
             b.veto_deadline_at::text  AS "vetoDeadlineAtText",
             b.halted_at::text         AS "haltedAtText",
             b.halt_reason             AS "haltReason",
             (COUNT(DISTINCT a.id) FILTER (WHERE o.id IS NULL))::int
               AS "pendingRenders",
             (COUNT(DISTINCT mo.id))::int
               AS "moderationWithheld"
        FROM solicitation_batches b
        LEFT JOIN solicitation_asks a
          ON a.batch_id = b.id
         AND a.account_id = ${accountId}::uuid
         AND a.business_id = ${businessId}::uuid
         AND a.status = 'send'
        LEFT JOIN solicitation_outreach o
          ON o.ask_id = a.id
         AND o.batch_id = a.batch_id
         AND o.account_id = ${accountId}::uuid
         AND o.business_id = ${businessId}::uuid
         AND o.delivery_status <> 'cancelled'
        LEFT JOIN solicitation_outreach mo
          ON mo.batch_id = b.id
         AND mo.account_id = ${accountId}::uuid
         AND mo.business_id = ${businessId}::uuid
         AND mo.disposition_reason = ${MODERATION_HIGH}
       WHERE b.id = ${batch.id}::uuid
         AND b.account_id = ${accountId}::uuid
         AND b.business_id = ${businessId}::uuid
       GROUP BY b.built_at, b.approved_at, b.veto_deadline_at,
                b.sending_started_at, b.send_closed_at, b.halted_at,
                b.halt_reason
    `;

    // readLatestBatch already read this row in this snapshot, so absence is
    // not a lost race — it means the tenant predicate disagreed with the one
    // that selected the batch. Loud beats a blank lane rendered as `pending`.
    if (!lane) {
      throw new Error(`solicitation batch ${batch.id} is unreadable in its own snapshot`);
    }

    sendLane = {
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
    };
  }

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
    attempts,
    sendLane,
  };
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
 */
export async function readLatestBatch(
  sql: Sql,
  accountId: string,
  businessId: string,
  options: { sendLane: boolean },
): Promise<BatchView> {
  return sql.begin(async (tx): Promise<BatchView> => {
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
