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
// It also owns `enqueueInitialImport` — the ONE initial-import enqueue, shared
// by all three producers that honour consent (round-1 O3, deviations D11). The
// reactivation catch-up in `src/lib/locations/archive-location-tx.ts` is
// deliberately NOT one of them: it enqueues `backfill_reason: 'reactivation'`,
// which the worker's `ON CONFLICT … WHERE run_reason = 'initial'` does not dedup
// because the archived-period catch-up is SUPPOSED to run again.
//
// EXPIRY IS DERIVED, NEVER STORED (#670, migration 101). `import_decision` is
// three-valued — `pending | accepted | declined`. "Expired" is computed on read
// as `pending AND import_offer_expires_at <= now()`: no poller, no stored
// 'expired', and nothing fires at the expiry moment.
//
// TWO ANALYTICS EVENTS, BOTH EMITTED FROM INSIDE THE WRITING TRANSACTION (#679
// T2, restoring #677's deferred D7). `createImportOffer` emits
// `import_offer_created` on — and only on — the `'created'` branch;
// `recordImportDecisionAndEnqueue` emits `import_decision_recorded` on — and only
// on — the `'recorded'` path. Every other branch emits nothing: an event here is
// a count of facts that actually landed, not of calls that were made.
//
// They live in the WRITERS, not at the call sites, because `createImportOffer`
// has three producers and emitting at each would repeat the key, the properties
// and the only-when-written condition three times over:
//
//   1. `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts:208` — the
//      connect junction, inside the Zernio connect transaction.
//   2. `worker/ingress/stripe/shared.ts:159` — the Stripe §5.2 activation resume.
//   3. `src/app/api/dashboard/import-offer/route.ts` — the GET self-heal.
//
// `src/lib/locations/add-location-tx.ts` is NOT a producer, although an earlier
// revision of this header listed it as one. That file only MENTIONS this helper
// in prose explaining why it stamps `import_offer_expires_at` itself; it neither
// imports nor calls it. Precedent for writer-owned emission: `recordSuppression`
// (`src/lib/solicitation/suppression.ts`).
//
// Both keys are business-scoped — `import_offer_created_<businessId>`,
// `import_decision_recorded_<businessId>` — and at-most-once per business by
// construction (the offer write requires a NULL deadline, the decision write
// requires `pending`), so a replay drops on `ON CONFLICT (event_key) DO NOTHING`
// rather than double-counting, and the key needs no discriminator.
//
// EACH EMISSION RUNS IN ITS OWN SAVEPOINT (`emitConsentEvent`), and that is a
// SAFETY property rather than a tidiness one. The database's
// `analytics_events_event_name_check` must ADMIT both names (migration 102); an
// unregistered name raises `23514` INSIDE the enclosing transaction. Unguarded,
// the consequence is NOT the "rolled-back consent decision" this header used to
// claim — it is a CONNECT OUTAGE. `createImportOffer` runs inside
// `finalizeConnectionTx`, and `select-location/route.ts` rethrows anything that
// is not `23505`, so on a project whose migration 102 had not landed NO owner
// with an activated subscription could connect a Google Business Profile at all.
// A missing metric must never poison the success path (CLAUDE.md working rules).
//
// THE SAVEPOINT CONTAINS THE BLAST RADIUS, so the residual risk is now the
// METRIC, not the feature: a failed emission rolls back only itself, and
// consent, connect and Review import all keep working while the offer-to-answer
// counts under-report. Migration 102 should still reach a Supabase project
// BEFORE the emitting code does — staging first, prod in lockstep at promotion —
// but that ordering is no longer the difference between shipping and an outage.
//
// AND THE UNDER-REPORTING ANNOUNCES ITSELF (#697). It used to do so only into a
// `warn` on stdout, which nothing reads, so a project that got the migration
// order wrong could undercount both one-shot events indefinitely with nothing
// alerting. `emitConsentEvent` now ALSO captures to Sentry — `level: 'warning'`,
// tagged `subsystem: import_consent_analytics` so the runbook's alert rule can
// route it — inside its own `try`/`catch`, because an alert that can throw is
// the connect outage above, re-opened one layer out.
//
// ATOMICITY ON THE SUCCESS PATH IS UNCHANGED. A savepoint that COMMITS commits
// with its parent, so an event still dies with a decision that rolls back for
// any other reason — which is exactly what "…rolls back
// import_decision_recorded when the decision transaction aborts" pins.
//
// AND THE EMISSION MUST USE THE TRANSACTION HANDLE, NEVER THE OUTER `sql`.
// `recordImportDecisionAndEnqueue` has both in scope; an event written against
// `sql` would pass every happy-path test while committing independently of a
// decision that later rolls back — a recorded decision that never happened. The
// savepoint handle is derived FROM `tx` and inherits that property; passing the
// outer `sql` into `emitConsentEvent` would forfeit it. Pinned behaviourally by
// the abort test above, not by executor identity.
//
import type { Sql, TransactionSql } from 'postgres';
import * as Sentry from '@sentry/node';
import { v7 as uuidv7 } from 'uuid';
import { enqueueAnalyticsEvent, type EnqueueAnalyticsEventInput } from '@/lib/analytics/enqueue';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import { createWorkerLogger } from '@/lib/shared/logger';
import { errorStringProperty } from '@/lib/payments/stripe-error-inspect';
import type { ZernioInitialBackfillPayload } from '@/lib/shared/worker-types';

type SqlExecutor = Sql | TransactionSql;

const LOG_PREFIX = '[import-consent]';

/**
 * The two operator-facing strings of the swallowed-emission alert (#697).
 *
 * `EMISSION_FAILURE_SUBSYSTEM` is not decoration: every Sentry alert rule in this
 * project routes on `tags.subsystem` (`docs/runbooks/beta-launch-alerting.md` §1
 * — `health_alert`, `llm_circuit_breaker`, `stripe_reconciliation`), so a capture
 * without one is durable but unpaged. Renaming either string silently unhooks the
 * configured Discord rule, which is why `import-offer-analytics.integration.test.ts`
 * spells both out a second time rather than importing them.
 */
const EMISSION_FAILURE_MESSAGE = 'Import consent analytics emission failed';
const EMISSION_FAILURE_SUBSYSTEM = 'import_consent_analytics';

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
 * Every outcome that is NOT a recorded decision, i.e. every rejection class.
 *
 * Module-private: it names the two rejection helpers' shared shape, and callers
 * consume the wider `ImportDecisionOutcome` instead. Exporting it left a type
 * with no consumer, which is a `fallow` dead-code finding (CI gate, #675 D14).
 */
type ImportDecisionRejection = Exclude<ImportDecisionOutcome, 'recorded'>;

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

  if (rows.length === 0) return 'unchanged';

  // ONLY the `'created'` branch emits. This helper runs on EVERY dashboard mount
  // through the GET self-heal, and on every 4s poll tick while importing, so an
  // emission on `unchanged` would re-mint the same fact on every render and
  // destroy the offer-to-answer ratio the event exists to measure.
  //
  // `tx`, so the event lands in the caller's transaction: an Import offer that
  // rolls back takes its event with it, and one that commits can never be
  // missing from the numerator. Savepointed, so the reverse is NOT true — this
  // helper runs inside `finalizeConnectionTx`, and a failing emission here must
  // not be able to take a Google Business Profile connection down with it.
  await emitConsentEvent(tx, {
    eventName: 'import_offer_created',
    eventKey: `import_offer_created_${businessId}`,
    distinctId: accountId,
    accountId,
    businessId,
    properties: { window_days: IMPORT_OFFER_WINDOW_DAYS },
  });

  return 'created';
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
 *
 * EVERY REJECTION IS LOGGED, from inside the transaction, via `logRejection`.
 * That is the intake's `observability` item 2 and it is the whole diagnostic
 * loop for this feature's most likely support ticket: the owner clicks and
 * nothing happens. Without it the route answers 404/409 and Railway is silent,
 * so "the button did nothing" cannot be resolved to an expiry or a missing
 * offer rather than an outage. `reportCaughtError` does not cover it — none of
 * these outcomes throws.
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
    if (!locked) return logRejection('no_offer', businessId, decision);

    // `account_id` is bound here too, even though the `FOR UPDATE` above already
    // proved ownership. The module header states that every function binds
    // `accountId` directly rather than inferring tenancy from a preceding read,
    // and this is the statement that WRITES consent — "the caller checked" is not
    // a property the next caller inherits.
    const transitioned = await tx<{ id: string }[]>`
      UPDATE businesses
      SET import_decision = ${decision},
          import_decision_at = now()
      WHERE id = ${businessId}::uuid
        AND account_id = ${accountId}::uuid
        AND import_decision = 'pending'
        AND import_offer_expires_at IS NOT NULL
        AND import_offer_expires_at > now()
      RETURNING id
    `;

    if (transitioned.length === 0) {
      // Zero rows has four distinct causes and the owner-visible message differs
      // for each. Re-read rather than guess.
      const current = await readImportConsent(tx, businessId, accountId);
      return logRejection(classifyRejection(current), businessId, decision);
    }

    // The decision LANDED — emit before the branch, so a decline (which returns
    // early, without an enqueue) is counted too. A decline is an ANSWER: it is
    // the denominator half of the offer-to-answer ratio, and an emission placed
    // next to `enqueueInitialImport` would silently miss it.
    //
    // `tx`, never the outer `sql` — see the module header. Emitting BEFORE the
    // enqueue is also what keeps that boundary observable: an enqueue failure
    // must be able to take this row down with it. The savepoint does not weaken
    // that — it only stops the arrow pointing the other way, from a failed
    // metric back onto the owner's answer.
    await emitConsentEvent(tx, {
      eventName: 'import_decision_recorded',
      eventKey: `import_decision_recorded_${businessId}`,
      distinctId: accountId,
      accountId,
      businessId,
      properties: { decision },
    });

    if (decision === 'declined') return 'recorded';

    await enqueueInitialImport(tx, businessId, accountId);
    return 'recorded';
  });
}

/** The zero-rows classifier, extracted so the one rejection sink is total. */
function classifyRejection(current: ImportConsentRow | null): ImportDecisionRejection {
  if (!current) return 'no_offer';
  if (current.state === 'pending' && current.expiresAt === null) return 'no_offer';
  if (current.state === 'expired') return 'expired';
  return 'already_answered';
}

/**
 * The rejected-decision signal (`observability` item 2), shaped like the three
 * enqueue-gate lines: the rejection class plus `business_id`, nothing else.
 *
 * Returns the class it logged so both rejection sites stay single-expression
 * returns — a branch cannot reject without passing through here, which is the
 * property that keeps the signal from rotting the next time an outcome is added.
 *
 * `log`, not `warn`: a late click is the ORDINARY case on this feature (expiry
 * is derived and nothing fires at the deadline, #670), and `observability` item
 * 5 is explicit that a decline or an expiry is an expected outcome, not an
 * error. No review text, no tokens — only the ids the support loop needs.
 */
function logRejection(
  rejection: ImportDecisionRejection,
  businessId: string,
  decision: 'accepted' | 'declined',
): ImportDecisionRejection {
  createWorkerLogger(LOG_PREFIX).log('Import decision rejected', {
    business_id: businessId,
    rejection,
    decision,
  });
  return rejection;
}

/**
 * Emit one Import consent analytics event inside ITS OWN SAVEPOINT.
 *
 * The single reason this function exists: both emissions run inside a caller's
 * transaction that is doing something far more important than counting. Postgres
 * aborts the WHOLE transaction on any error, so an unguarded emission makes the
 * analytics table a hard dependency of connecting a Google Business Profile —
 * `createImportOffer` is called by `finalizeConnectionTx`, and
 * `select-location/route.ts` rethrows anything that is not `23505`. See the
 * module header for the full failure mode; the rule it violates is CLAUDE.md's
 * "observability must never poison the success path".
 *
 * `tx.savepoint` is postgres.js's `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` pair
 * (v3.4.9, `TransactionSql.savepoint(cb)`): on throw it rolls back to the
 * savepoint and rethrows, leaving the parent transaction usable. Catching that
 * rethrow is what turns a fatal emission into a lost metric.
 *
 * IT DOES NOT MAKE THE EVENT INDEPENDENT. A savepoint that commits commits with
 * its parent, so an event still dies with the fact it reports — the property
 * "…rolls back import_decision_recorded when the decision transaction aborts"
 * pins. The guard is one-directional by construction, which is the whole point.
 *
 * `warn`, not `log`: unlike `logRejection`'s expiries and declines this is never
 * an ordinary outcome. It means the emitting code reached a database whose
 * `analytics_events_event_name_check` does not admit the name (migration 102 not
 * applied) — a human should look. Only the business id, the event name and the
 * error text are logged: no review text, no tokens, no handles, and not the
 * properties.
 *
 * TWO SINKS, AND THE SENTRY ONE IS THE POINT (#697). "A human should look" was
 * the claim; a `warn` alone could not deliver it. `createWorkerLogger.warn`
 * writes structured JSON to stdout and nothing reads it, while the documented
 * paging route for this project is Sentry (`docs/runbooks/beta-launch-alerting.md`
 * §1) — so persistent schema drift could undercount BOTH one-shot events
 * indefinitely with nothing alerting. The capture is `level: 'warning'` (the
 * caller committed; only a metric was lost — a P2 to read, not a page) and
 * tagged `subsystem` + `event_name`, because a Sentry alert rule matches on
 * tags and an untagged capture is durable but unroutable.
 *
 * IT CARRIES ITS OWN CATCH, and that is load-bearing rather than defensive.
 * Adding an alert to this path re-opens the exact hazard the savepoint closed:
 * `createImportOffer` runs inside `finalizeConnectionTx`, `select-location/
 * route.ts` rethrows anything that is not `23505`, and a capture that throws
 * would therefore break Google Business Profile connect outright. CLAUDE.md's
 * "observability must never poison the success path" is the rule; the inner
 * `try`/`catch` is the enforcement, pinned by "a Sentry capture that throws does
 * not resurface into the caller transaction".
 *
 * ONLY an error carrying a string `code` is swallowed — which is broader than
 * "a Postgres error", and deliberately so: it also covers postgres.js
 * connection-lifecycle errors (`CONNECTION_CLOSED`/`_ENDED`/`_DESTROYED`/
 * `CONNECT_TIMEOUT`, minted on plain `Error`s at
 * `node_modules/postgres/src/errors.js:16-27`) and Node OS-socket codes
 * (`ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`). Those are infrastructure failures, not
 * schema drift, and they land under the same `warn` — and now under the same
 * Sentry tag. That imprecision SURVIVES #697 and was left deliberately: #697's
 * scope was the missing sink, not the classifier, and an infrastructure error
 * reaching this alert is never a false positive in the way that matters, because
 * a lost connection independently rejects the enclosing `begin` and therefore
 * always arrives alongside a real failure of its own. Swallowing them is still
 * correct here for the same reason: it can never be converted into a quiet
 * success.
 *
 * Round 2 found the catch unbounded, and it
 * was already hiding a real one: `import-offer-junction.test.ts`'s `mockTx` has
 * no `savepoint`, so five of its six tests threw `TypeError: tx.savepoint is not
 * a function`, emitted nothing, and stayed green. A handle without `.savepoint`
 * (root `sql`, `sql.reserve()`, a `Sql`-shaped mock) is a wiring bug, not schema
 * drift, and swallowing it kills both events forever behind a warn that reads
 * like a missing migration. Postgres errors carry a string `code`; a `TypeError`
 * does not — that is the whole discriminator, spelled with the established
 * `errorStringProperty` helper, which `src/lib/db/transient-error.ts:61` already
 * uses for exactly this "does this error carry a string `code`" question. It is
 * NOT the `duplicate-location.ts:24` / `create-business.ts:62` shape: those
 * narrow to one SPECIFIC code, this one only asks whether a code exists.
 * This is `.claude/commands/feature.md:55`'s "assert impossible states, don't
 * branch around them".
 *
 * Three error classes reach this catch, and only the first is swallowed:
 *   1. Postgres errors — SQLSTATEs (`23514` when 102 is unapplied, `23503`),
 *      `57014` statement timeouts, postgres.js `CONNECTION_*`, and Node socket
 *      errors (`ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`). All carry a string `code`.
 *      Round 3 verified this against the driver source: nothing transient
 *      escapes, so the narrowing cannot resurrect the connect outage. A lost
 *      connection still rejects the enclosing `begin` on its own, so it is
 *      never converted into a quiet success.
 *   2. A `TypeError` from a handle without `.savepoint` — a wiring bug.
 *   3. `enqueueAnalyticsEvent`'s own plain `Error` on an unregistered name
 *      (`src/lib/analytics/enqueue.ts:24-26`). Unreachable while `eventName` is
 *      typed `AnalyticsEventName` — deleting a name from the registry fails
 *      compilation at the call site before it can fail at runtime.
 * 2 and 3 are impossible states and are rethrown deliberately.
 */
async function emitConsentEvent(
  tx: TransactionSql,
  input: EnqueueAnalyticsEventInput,
): Promise<void> {
  try {
    await tx.savepoint((sp) => enqueueAnalyticsEvent(sp, input));
  } catch (error) {
    if (errorStringProperty(error, 'code') === undefined) throw error;
    const detail = {
      business_id: input.businessId ?? null,
      event_name: input.eventName,
      error: error instanceof Error ? error.message : String(error),
    };
    // Sentry FIRST, in its own catch, then the log line — both sinks, neither
    // able to reach the caller. `@sentry/node` routes to whichever client is
    // initialized (Next server via `src/instrumentation.ts`, worker via
    // `worker/sentry.ts`); `@sentry/nextjs` re-exports this same module
    // instance, which is why one import serves both lanes this code runs in
    // (`report-caught-error.ts:9-13` documents the same property).
    try {
      Sentry.captureMessage(EMISSION_FAILURE_MESSAGE, {
        level: 'warning',
        tags: { subsystem: EMISSION_FAILURE_SUBSYSTEM, event_name: input.eventName },
        extra: detail,
      });
    } catch {
      // The savepoint's whole purpose, one layer out: an alerting failure must
      // not resurface into the caller's transaction. `createImportOffer` runs
      // inside `finalizeConnectionTx` and `select-location/route.ts` rethrows
      // anything that is not `23505`, so an escaping capture is a connect
      // outage — the same one the savepoint closed. Shape follows
      // `llmCircuitBreaker.emitTransition` (`src/lib/llm/circuit-breaker.ts`).
    }
    // OUTSIDE the guard above, deliberately: this is the fallback sink for the
    // one case the durable sink cannot cover — Sentry itself being unreachable.
    // Moving it inside that `try` reads like tidying and deletes the last signal
    // on exactly that path. Pinned by "a Sentry capture that throws does not
    // resurface into the caller transaction".
    createWorkerLogger(LOG_PREFIX).warn(EMISSION_FAILURE_MESSAGE, detail);
  }
}

/**
 * THE initial-import enqueue. One implementation, three producers.
 *
 * The acceptance transaction above, `finalizeConnectionTx` (connect) and
 * `maybeEnqueueBackfillResume` (Stripe activation) all delegate here. Until
 * round 1 they each carried their own copy and the copies had already diverged:
 * the completed-run guard was spelled three different ways, and none of them
 * matched `readImportOfferView`'s. That divergence is the A4 bug — a completed
 * REACTIVATION run permanently suppressed the one-time initial import while the
 * banner, correctly scoped to `initial`, kept reporting `importing` forever on a
 * 4s poll. It also hands #679 ONE chokepoint for its fail-closed worker guard
 * instead of three.
 *
 * The handoff recorded a blocker here that was FALSE (deviations D11):
 * `scripts/ci/outbox-seam-audit.ts` pins `HELPER_MODULE` to
 * `src/lib/shared/job-outbox-helpers.ts` and derives helper coverage ONLY from
 * that file. Minting a helper THERE would turn every raw `ZERNIO_INITIAL_BACKFILL`
 * producer red; a shared function HERE is not a helper to the audit, so one raw
 * `INSERT INTO job_outbox` remains for a topic with no helper — invariant #2's
 * explicit carve-out. Do not "finish the job" by moving this into
 * `job-outbox-helpers.ts`: the reactivation producer
 * (`archive-location-tx.ts`) is deliberately NOT a caller of this function and
 * would turn red the moment a helper exists.
 *
 * **The caller must already hold the `businesses` row lock inside its own
 * transaction.** `TransactionSql` is the type-level half; the source tripwire
 * (`__tests__/import-consent-lock-order-source.test.ts`) is the other half.
 *
 * Enqueues only when there is no completed INITIAL run and no in-flight row —
 * the accept-then-reconnect duplicate (round-1 High, F101). The in-flight status
 * set is re-spelled byte-for-byte from `OUTBOX_IN_FLIGHT_STATUSES` and never
 * parameterized: a bind parameter inside such a predicate defeats partial-index
 * inference (invariant #2's byte-for-byte contract).
 *
 * `backfill_reason: 'initial'` is explicit. Reactivation's catch-up uses
 * `'reactivation'`, is deliberately NOT deduped by the worker's
 * `ON CONFLICT … WHERE run_reason = 'initial'`, and for the same reason is NOT
 * routed through this function.
 */
export async function enqueueInitialImport(
  tx: TransactionSql,
  businessId: string,
  accountId: string,
): Promise<void> {
  // The payload is resolved HERE, under the caller's row lock, rather than being
  // passed in. Three producers reached this point holding three different
  // snapshots of the same facts; re-reading makes the enqueue impossible to
  // issue for a business with no active connection, no activation, or an
  // archived row — states a parameter list can only ask callers to check.
  //
  // Every table binds its tenant key DIRECTLY (`b.account_id`, `a.id`,
  // `zc.business_id`, `br.business_id`) rather than reaching it through the JOIN
  // graph, so `ci:tenant-scope` needs no allowlist entry for any of them.
  //
  // `br.run_reason = 'initial'` is load-bearing and matches
  // `readImportOfferView` (`import-offer-view.ts:96`) exactly. Reactivation runs
  // RECUR by design — the DB carries a UNIQUE partial index
  // `zernio_backfill_runs_one_initial_per_business` on `(business_id) WHERE
  // run_reason = 'initial'` and deliberately does not dedup the rest — so an
  // unscoped "any completed run" guard lets one archive/reactivate cycle
  // suppress the one-time import permanently.
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
     AND br.run_reason = 'initial'
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

  // No active connection, or a completed initial run already exists. The consent
  // write still stands — consent and enqueue eligibility are different
  // questions, and the connect/activation producers will enqueue when the
  // junction completes.
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

  // The row source is the account-scoped `businesses` row, not a bare value
  // list: `account_id` is bound in a TOP-LEVEL predicate so the INSERT itself
  // refuses a foreign tenant, and the dedup subquery correlates to that same
  // verified row (`jo.aggregate_id = b.id`) rather than re-binding the raw id.
  // Still exactly one row or zero — `businesses.id` is the primary key.
  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT
      ${uuidv7()},
      ${QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL},
      'business',
      b.id,
      ${tx.json(payload)},
      'pending'
    FROM businesses b
    WHERE b.id = ${businessId}::uuid
      AND b.account_id = ${accountId}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.aggregate_id = b.id
          AND jo.topic = ${QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL}
          AND jo.status IN ('pending', 'dispatching', 'dispatched')
      )
  `;
}
