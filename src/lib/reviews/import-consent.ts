// src/lib/reviews/import-consent.ts
//
// Import consent: the ONE owner of spec §5.3's derived-expiry predicate, the
// junction offer write, and the acceptance transaction (#677, map #667).
//
// Delete this module and the derivation reappears at six call sites — the offer
// view, the decision route, the three enqueue gates, and #679's worker guard.
// Spec §5.3 exists precisely to forbid that.
//
// Two access shapes, ONE derivation: `importConsentStateSql` for consumers that
// compose the predicate into a larger query (`import-offer-view.ts` now, #679's
// `guardImportConsent` next), `readImportConsent` for consumers that only need
// the row. Not two derivations.
//
// EXPIRY IS DERIVED, NEVER STORED (#670, migration 101). `import_decision` is
// three-valued — `pending | accepted | declined`. "Expired" is computed on read
// as `pending AND import_offer_expires_at <= now()`: no poller, no stored
// 'expired', and nothing fires at the expiry moment.
//
// NO ANALYTICS EVENTS IN THIS MODULE (deviations D7, owner decision 2026-08-07).
// `import_offer_created` / `import_decision_recorded` need the
// `analytics_events.event_name` CHECK extended, which needs a migration this
// ticket's non-goals forbid — #679 carries them. Adding an
// `enqueueAnalyticsEvent` call here would raise a CHECK violation INSIDE the
// acceptance transaction and roll back a legitimate consent decision.
//
import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import type { ZernioInitialBackfillPayload } from '@/lib/shared/worker-types';

type SqlExecutor = Sql | TransactionSql;

/**
 * The Import offer window: 7 days from creation.
 *
 * There is NO junction anchor. Revisions 2–3 of the plan tried to anchor the
 * deadline to the junction so a self-healed offer would carry the deadline the
 * junction *would* have produced; the owner dropped it (2026-08-06) after it
 * produced two High findings across two review rounds — `connected_at` is
 * mutable on reconnect (`finalize-tx.ts:123-132`), and `MIN(created_at)` is
 * ambiguous across the real disconnect lifecycle, where disconnect preserves the
 * old row as `disconnected` (`disconnect/route.ts:251-262`) and finalize INSERTs
 * a fresh active one.
 *
 * It was never needed: `createImportOffer` writes the deadline exactly once —
 * only when it is NULL — so the anchor never applied to the normal path at all.
 * It only ever governed locations whose junction-time write FAILED and were later
 * repaired by the GET self-heal, and for that population starting the clock at
 * the repair gives the owner a full 7 days from when they could first have seen
 * the offer. That is the more defensible behaviour anyway.
 */
export const IMPORT_OFFER_WINDOW_DAYS = 7;

/** Three stored values plus the one derived on read. */
export type ImportConsentState = 'pending' | 'accepted' | 'declined' | 'expired';

export interface ImportConsentRow {
  state: ImportConsentState;
  decidedAt: Date | null;
  expiresAt: Date | null;
}

/** What `recordImportDecisionAndEnqueue` did, from the caller's point of view. */
export type ImportDecisionOutcome =
  | 'recorded'
  | 'already_answered'
  | 'expired'
  | 'no_offer';

/**
 * Spec §5.3's derivation, spelled ONCE, as a composable fragment.
 *
 * **The caller MUST alias its `businesses` row as `b`.** The fragment hardcodes
 * that alias and takes no interpolation at all.
 *
 * An earlier draft took an `alias` parameter and injected it with postgres.js's
 * identifier form, `db(alias)`. That is the correct postgres.js API and it worked
 * against real Postgres — but this helper is called from four producers whose
 * suites use hand-rolled `sql` mocks (`vi.fn((strings, ...values) => …)`), and
 * those mocks implement only the tagged-template call form. `db('b')` reaches
 * them as a bare string and dies on `strings.join is not a function`, in test
 * files across several directories. A fragment this widely called should not
 * require every mock in the repo to grow identifier support, so the alias is a
 * fixed contract instead of a parameter. No interpolation also means nothing to
 * bind wrong.
 *
 * `now()` is POSTGRES's, never a JS `Date`. postgres.js decodes `timestamptz`
 * into a JS Date and silently truncates microseconds to milliseconds (CLAUDE.md
 * gotcha), so a comparison against a JS-side clock can mis-order by <1ms. That
 * class must not reach this boundary — the deadline is evaluated entirely
 * in-database.
 *
 * The boundary is `<=`, inclusive, exactly as §5.3 writes it: a deadline that has
 * arrived has passed.
 */
export function importConsentStateSql(db: SqlExecutor) {
  return db`CASE
    WHEN b.import_decision = 'pending'
      AND b.import_offer_expires_at IS NOT NULL
      AND b.import_offer_expires_at <= now()
    THEN 'expired'
    ELSE b.import_decision
  END`;
}

/**
 * The row, with expiry already derived. `null` when the business does not exist
 * **or does not belong to `accountId`**.
 *
 * Every function in this module takes `accountId` and binds it directly, rather
 * than inferring tenancy by correlating to a `businesses` row (invariant #8,
 * enforced by `ci:tenant-scope`). An earlier draft scoped by `b.id` alone on the
 * theory that callers had already resolved owner scope — true today, but this is
 * the table that gates whether a customer's review history gets imported, and
 * "the caller checked" is not a property the next caller inherits. A missing
 * account predicate here is a cross-tenant consent read.
 */
export async function readImportConsent(
  db: SqlExecutor,
  businessId: string,
  accountId: string,
): Promise<ImportConsentRow | null> {
  const [row] = await db<{
    state: ImportConsentState;
    decided_at: Date | null;
    expires_at: Date | null;
  }[]>`
    SELECT
      ${importConsentStateSql(db)} AS state,
      b.import_decision_at AS decided_at,
      b.import_offer_expires_at AS expires_at
    FROM businesses b
    WHERE b.id = ${businessId}::uuid
      AND b.account_id = ${accountId}::uuid
  `;

  if (!row) return null;
  return { state: row.state, decidedAt: row.decided_at, expiresAt: row.expires_at };
}

/**
 * Create the Import offer for a location that has just reached the junction.
 *
 * Idempotent. Stamps ONLY a `pending` row whose deadline is NULL, AND ONLY when
 * the junction has actually been reached — activation non-NULL **and** an active
 * connection, both proven in this helper's own SQL. Deadline is
 * `now() + IMPORT_OFFER_WINDOW_DAYS`; there is no junction anchor.
 *
 * **The caller must hold the `businesses` row lock.** `TransactionSql` in the
 * signature is the type-level half of that requirement; the source tripwire
 * (`__tests__/import-consent-lock-order-source.test.ts`) is the other half.
 * `SELECT … FOR UPDATE` is a NO-OP outside `sql.begin()` under Supabase's
 * transaction pooling (CLAUDE.md gotcha) — PgBouncer drops the row lock the
 * instant the SELECT returns — so a producer without its own transaction is not
 * "mostly safe", it is unprotected.
 *
 * WHY THE JUNCTION IS PROVEN HERE AND NOT BY CALLERS (round-2 High). The GET
 * self-heal runs from a read path with no junction of its own, so "the callers
 * are all junction sites" stopped being true. Requiring both halves in this
 * statement means a location holding only ONE half can never be handed an offer —
 * which matters because migration 100 gives EVERY business row `pending` + a NULL
 * deadline by DEFAULT, so `pending + NULL` alone does not distinguish
 * "junction reached, offer not yet written" from "nowhere near a junction".
 */
export async function createImportOffer(
  tx: TransactionSql,
  businessId: string,
  accountId: string,
): Promise<'created' | 'unchanged'> {
  // The junction halves are joined rather than tested with EXISTS subqueries, so
  // every tenant key is bound in a TOP-LEVEL predicate. Two reasons, and the
  // second is the one that mattered: it reads as one flat list of what must be
  // true, and `ci:tenant-scope` evaluates scope only over top-level predicates
  // (it strips subqueries before analysis) — the EXISTS form left `accounts` and
  // `zernio_connections` looking unscoped and would have needed allowlist
  // entries on the query that gates a customer's review import.
  //
  // Equivalent to the EXISTS form because both joins are at-most-one-row:
  // `accounts.id` is the primary key, and `zernio_connections` has a UNIQUE
  // partial index on `(business_id) WHERE status IN ('pending','active')`
  // (`zernio_connections_one_active_per_business`), so an `active` row is unique
  // per business. No row multiplication, so no double update.
  const rows = await tx<{ id: string }[]>`
    UPDATE businesses b
    SET import_offer_expires_at = now() + ${`${IMPORT_OFFER_WINDOW_DAYS} days`}::interval
    FROM accounts a, zernio_connections zc
    WHERE b.id = ${businessId}::uuid
      AND b.account_id = ${accountId}::uuid
      AND a.id = ${accountId}::uuid
      AND zc.business_id = ${businessId}::uuid
      AND b.import_decision = 'pending'
      AND b.import_offer_expires_at IS NULL
      AND b.archived_at IS NULL
      AND a.subscription_activated_at IS NOT NULL
      AND zc.status = 'active'
    RETURNING b.id
  `;

  return rows.length > 0 ? 'created' : 'unchanged';
}

/**
 * Record the owner's answer and, on acceptance, enqueue the Review import — as
 * ONE transaction.
 *
 * Owns the whole thing (`sql.begin` → row lock → guarded transition → deduped
 * `job_outbox` INSERT) so the route can validate, call this once, and map the
 * outcome (invariant #12). Round 1 found the route being handed `sql.begin` plus
 * the transition plus a raw outbox insert while the plan simultaneously claimed
 * routes only "parse, call one module, map".
 *
 * THE GUARDED PREDICATE, and why `IS NOT NULL` is load-bearing (round-1
 * Critical). Migration 100 gives every business row `pending` + a NULL deadline
 * by DEFAULT (`100_….sql:47-63`). A predicate that admitted NULL would let a
 * direct POST manufacture `accepted` consent for a location that was never
 * offered anything — and would make the advertised `no_offer` outcome
 * unreachable. An offer must EXIST before it can be answered.
 *
 * The zero-rows case is then classified by re-reading the locked row. That
 * re-read is race-free ONLY because of the row lock: under READ COMMITTED a
 * concurrent self-heal could turn NULL into a live deadline between the UPDATE
 * and the re-read, and the classifier would report `already_answered` for a row
 * that is in fact still answerable. The fix is serialization, not a wider
 * classifier.
 */
export async function recordImportDecisionAndEnqueue(
  sql: Sql,
  businessId: string,
  accountId: string,
  decision: 'accepted' | 'declined',
): Promise<ImportDecisionOutcome> {
  return sql.begin(async (tx) => {
    // The row lock, FIRST. This single discipline retires three separate
    // round-2 findings: the `INSERT … WHERE NOT EXISTS` check-then-insert race,
    // the unresolved transaction-shape finding (F107), and the zero-row
    // classification race below. Account-scoped per invariant #8 — a foreign
    // business id finds no row and cannot be answered.
    const [locked] = await tx<{ id: string }[]>`
      SELECT id
      FROM businesses
      WHERE id = ${businessId}::uuid
        AND account_id = ${accountId}::uuid
      FOR UPDATE
    `;
    if (!locked) return 'no_offer';

    const transitioned = await tx<{ id: string }[]>`
      UPDATE businesses
      SET import_decision = ${decision},
          import_decision_at = now()
      WHERE id = ${businessId}::uuid
        AND import_decision = 'pending'
        AND import_offer_expires_at IS NOT NULL
        AND import_offer_expires_at > now()
      RETURNING id
    `;

    if (transitioned.length === 0) {
      // Zero rows has four distinct causes and the owner-visible message differs
      // for each. Re-read rather than guess.
      const current = await readImportConsent(tx, businessId, accountId);
      if (!current) return 'no_offer';
      if (current.state === 'pending' && current.expiresAt === null) return 'no_offer';
      if (current.state === 'expired') return 'expired';
      return 'already_answered';
    }

    if (decision === 'declined') return 'recorded';

    await enqueueInitialImport(tx, businessId, accountId);
    return 'recorded';
  });
}

/**
 * The accepted-path enqueue. Raw `INSERT INTO job_outbox` on purpose: no typed
 * helper exists for `ZERNIO_INITIAL_BACKFILL`, and minting one would turn all
 * four raw producers red under `ci:outbox-seam` and force migrating them in this
 * PR (invariant #2's explicit carve-out).
 *
 * Enqueues only when there is no completed run and no in-flight row — the
 * accept-then-reconnect duplicate (round-1 High, F101). The in-flight status set
 * is re-spelled byte-for-byte from `OUTBOX_IN_FLIGHT_STATUSES` and never
 * parameterized: a bind parameter inside such a predicate defeats partial-index
 * inference (invariant #2's byte-for-byte contract).
 *
 * `backfill_reason: 'initial'` is explicit. Reactivation's catch-up uses
 * `'reactivation'` and is deliberately NOT deduped by the worker's
 * `ON CONFLICT … WHERE run_reason = 'initial'`.
 */
async function enqueueInitialImport(
  tx: TransactionSql,
  businessId: string,
  accountId: string,
): Promise<void> {
  // Every table binds its tenant key DIRECTLY (`b.account_id`, `a.id`,
  // `zc.business_id`, `br.business_id`) rather than reaching it through the JOIN
  // graph. `worker/ingress/stripe/shared.ts` runs the same shape with
  // correlation-only scoping and carries three `ci:tenant-scope` allowlist
  // entries for it; binding directly is equivalent SQL that needs none.
  const [target] = await tx<{
    zernio_account_id: string;
    zernio_location_id: string;
    subscription_tier: string;
    subscription_activated_at: Date;
  }[]>`
    SELECT
      zc.zernio_account_id,
      zc.zernio_location_id,
      a.subscription_tier,
      a.subscription_activated_at
    FROM zernio_connections zc
    JOIN businesses b ON b.id = zc.business_id
    JOIN accounts a ON a.id = b.account_id
    LEFT JOIN zernio_backfill_runs br
      ON br.business_id = ${businessId}::uuid
     AND br.completed_at IS NOT NULL
    WHERE zc.business_id = ${businessId}::uuid
      AND b.account_id = ${accountId}::uuid
      AND a.id = ${accountId}::uuid
      AND zc.status = 'active'
      AND b.archived_at IS NULL
      AND a.subscription_activated_at IS NOT NULL
      AND br.id IS NULL
    LIMIT 1
  `;

  // No active connection, or a completed run already exists. The consent write
  // still stands — consent and enqueue eligibility are different questions, and
  // the connect/activation producers will enqueue when the junction completes.
  if (!target) return;

  if (!isSubscriptionTier(target.subscription_tier)) {
    throw new Error(`invalid_ws8_subscription_tier:${target.subscription_tier}`);
  }

  const payload = {
    business_id: businessId,
    zernio_account_id: target.zernio_account_id,
    zernio_location_id: target.zernio_location_id,
    subscription_tier: target.subscription_tier,
    subscription_activated_at: target.subscription_activated_at.toISOString(),
    backfill_reason: 'initial',
    correlation_id: uuidv7(),
  } satisfies ZernioInitialBackfillPayload;

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT
      ${uuidv7()},
      ${QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL},
      'business',
      ${businessId}::uuid,
      ${tx.json(payload)},
      'pending'
    WHERE NOT EXISTS (
      SELECT 1 FROM job_outbox jo
      WHERE jo.aggregate_id = ${businessId}::uuid
        AND jo.topic = ${QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL}
        AND jo.status IN ('pending', 'dispatching', 'dispatched')
    )
  `;
}
