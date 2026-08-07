// src/lib/reviews/import-offer-view.ts
//
// The Import offer banner's read model (#677, deviations D2).
//
// One three-table join (`businesses` × `zernio_backfill_runs` × `job_outbox`)
// collapsed into a discriminated union, so the banner renders a state rather than
// re-deriving one. Delete this module and ~40 lines of precedence mapping land in
// a route handler, which invariant #12 forbids.
//
// WHY NOT `DashboardDataActive`: `getActiveDashboardData` is Redis-cached
// (`src/lib/dashboard/service.ts:118`), so a declined offer would keep
// re-rendering for the whole TTL. `src/lib/dashboard/**` is deliberately absent
// from this feature's edit surface for that reason.
//
// The three precedence rules below are each a round-1 review finding, not a
// preference. Read them before changing the query.
//
import type { Sql, TransactionSql } from 'postgres';
import { OUTBOX_IN_FLIGHT_STATUSES } from '@/lib/shared/job-outbox-status';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { importConsentStateSql, type ImportConsentState } from './import-consent';

type SqlExecutor = Sql | TransactionSql;

export type ImportOfferView =
  | { state: 'none' }
  | { state: 'offer'; expiresAt: string }
  | { state: 'importing' }
  | { state: 'imported'; count: number }
  | { state: 'empty' }
  | { state: 'failed' };

/**
 * Exactly the columns the join below selects. `consent_state` REFERENCES the
 * exported union rather than re-spelling it — `importConsentStateSql` produces
 * that union's values, so a fourth stored value would have to change one type,
 * not two. The outbox status is deliberately absent: it comes from a second,
 * conditional query further down and is typed at its own call site.
 */
interface ViewRow {
  consent_state: ImportConsentState;
  expires_at: Date | null;
  run_completed_at: Date | null;
  imported_count: number | null;
}

/**
 * Resolve the banner state for one location.
 *
 * `businessId` + `accountId` are both bound (invariant #8): the caller has
 * resolved owner scope, and this query re-proves it rather than trusting that.
 *
 * ROW SELECTION IS EXPLICIT (round-1 finding). The run and outbox rows are scoped
 * to THIS business and account and taken newest-first via correlated
 * `ORDER BY … LIMIT 1` subqueries. A stale run from a previous import, or a
 * foreign account's row, must never win the join.
 *
 * RUN ROWS ARE SCOPED TO `run_reason = 'initial'`, which the plan did not specify
 * and which a live-DB fixture forced into the open: the DB carries
 * `zernio_backfill_runs_one_initial_per_business`, a UNIQUE partial index on
 * `(business_id) WHERE run_reason = 'initial'`, so a location has AT MOST ONE
 * initial run — but it may accumulate any number of `'reactivation'` runs, which
 * recur by design (see `reactivateLocationTransaction`). Taking simply the newest
 * run would flip this banner back to "Importing your reviews…" every time an
 * archived location is reactivated, months after the one-time import finished.
 * The banner's subject is the **Import offer**, and the offer is the initial
 * import; reactivation catch-ups are a different mechanism and are deliberately
 * invisible here.
 *
 * The outbox read is NOT similarly filtered, and that is a knowing limit: the
 * topic is shared and `backfill_reason` lives inside the JSONB payload. It only
 * matters for a location that is `accepted`, has no completed initial run, and has
 * a reactivation row in flight — where reporting `importing` is still the honest
 * answer. Filtering on a JSONB field to sharpen that would cost an expression
 * index for no behavioural gain.
 */
export async function readImportOfferView(
  db: SqlExecutor,
  businessId: string,
  accountId: string,
): Promise<ImportOfferView> {
  // A plain LEFT JOIN, not a scalar subquery, and both halves of that matter:
  //
  //  - It is SAFE because `zernio_backfill_runs_one_initial_per_business` is a
  //    UNIQUE partial index on `(business_id) WHERE run_reason = 'initial'`, so
  //    this join adds at most one row. No aggregation needed, no row
  //    multiplication possible.
  //  - It is NECESSARY because `ci:tenant-scope` strips subqueries before
  //    analysing predicates, so a `business_id` bound inside a scalar subquery is
  //    invisible to it and the table reads as unscoped. An `ON` clause is
  //    top-level and visible. Binding `${businessId}` rather than correlating to
  //    `b.id` keeps the scope explicit at the join.
  const [row] = await db<ViewRow[]>`
    SELECT
      ${importConsentStateSql(db)} AS consent_state,
      b.import_offer_expires_at AS expires_at,
      br.completed_at AS run_completed_at,
      br.imported_count AS imported_count
    FROM businesses b
    LEFT JOIN zernio_backfill_runs br
      ON br.business_id = ${businessId}::uuid
     AND br.run_reason = 'initial'
    WHERE b.id = ${businessId}::uuid
      AND b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
  `;

  if (!row) return { state: 'none' };

  // An offer only exists while it is pending AND carries a live deadline. A
  // `pending` row with a NULL deadline is migration 100's DEFAULT, not an offer —
  // showing a banner for it would invite a POST the guarded transition then
  // rejects as `no_offer` (the round-1 Critical, from the UI side).
  if (row.consent_state === 'pending') {
    return row.expires_at
      ? { state: 'offer', expiresAt: row.expires_at.toISOString() }
      : { state: 'none' };
  }

  // Declined and derived-expired both mean "nothing to show, ever again". The
  // banner is not a place to re-litigate a decision.
  if (row.consent_state !== 'accepted') return { state: 'none' };

  // ── accepted: report on the import itself ────────────────────────────────

  // `completed_at` DECIDES DONE, NEVER `imported_count` (round-1 finding).
  // `imported_count` DEFAULTs to 0 (`100_….sql:65-67`) and is written
  // INCREMENTALLY (`ZernioBackfillWorker.ts:379`), so a mid-run read with a
  // positive partial count is still `importing`. Reading a positive count as
  // "done" is the most natural wrong implementation here.
  if (row.run_completed_at) {
    const count = row.imported_count ?? 0;
    // `empty` requires completed AND zero — a distinct OUTCOME, not a count of
    // zero, because "Imported 0 reviews" reads as a bug to an owner.
    return count === 0 ? { state: 'empty' } : { state: 'imported', count };
  }

  // No completed run. The outbox row decides whether work is still coming — read
  // as a SECOND query rather than joined, because a business can have many outbox
  // rows and only the newest matters. Joining would multiply rows and need an
  // aggregate; a scalar subquery would hide its `aggregate_id` binding from
  // `ci:tenant-scope`. Issued only on this branch, so the common completed-run
  // path still costs one round trip.
  const [outbox] = await db<{ status: string }[]>`
    SELECT jo.status
    FROM job_outbox jo
    WHERE jo.aggregate_id = ${businessId}::uuid
      AND jo.topic = ${QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL}
    ORDER BY jo.created_at DESC
    LIMIT 1
  `;

  if (outbox?.status) {
    const outboxStatus = outbox.status;
    // Status maps per the draft-status precedent (`:95-143`): the in-flight set →
    // importing, every terminal non-`completed` status → failed. The set is
    // IMPORTED, never re-spelled — this is a JS comparison, not a SQL predicate,
    // so invariant #2's byte-for-byte requirement does not apply and the constant
    // is the right tool.
    if ((OUTBOX_IN_FLIGHT_STATUSES as readonly string[]).includes(outboxStatus)) {
      return { state: 'importing' };
    }
    // `completed` outbox with no completed RUN means the worker finished the job
    // but the run row is not final — still importing from the owner's point of
    // view, and the `completed_at IS NULL` sentinel keeps it retryable (spec §5.1).
    if (outboxStatus === 'completed') return { state: 'importing' };
    return { state: 'failed' };
  }

  // Accepted with neither a run nor an outbox row: the enqueue has not landed
  // yet (a producer will place it) — importing is the honest thing to show, and
  // it is what the owner just asked for.
  return { state: 'importing' };
}
