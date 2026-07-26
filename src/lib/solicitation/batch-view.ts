/**
 * Read model for the owner-facing Requests screen (#544): the most recent
 * Solicitation batch for one location, as a funnel plus its spoilage report.
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
 * allowlist). The discriminant is validated because a decision without one
 * cannot be rendered; the rest of the shape is owned by batch-builder.ts,
 * which is the only writer of this column.
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
 */
export async function readLatestBatch(
  sql: Sql,
  accountId: string,
  businessId: string,
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
