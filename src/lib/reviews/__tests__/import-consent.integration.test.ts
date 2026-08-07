// src/lib/reviews/__tests__/import-consent.integration.test.ts
//
// T0 EVAL suite for #677 — Import consent: the predicate, the offer, the
// acceptance transaction. Titles 1–13, 57–60, 62 of the intake's 69
// (`tests_to_add`), authored VERBATIM before any implementation.
//
// WHY LIVE POSTGRES (plan §2): this feature's load-bearing semantics are in the
// SQL, not in the bindings. The expiry derivation is evaluated by Postgres
// `now()`; the F3 terminal-state contract is a `WHERE` predicate on an `UPDATE`;
// the acceptance is a transaction that must roll back as a unit; and titles 11,
// 12 and 62 are races. A mocked `sql` tag cannot falsify any of those.
//
// There is deliberately NO mocked twin for import-consent.ts (plan §2). That
// makes titles 8–9 load-bearing here: this suite must itself assert business-id
// binding and the no-row / no-offer classifications, because no other suite does.
//
// Live-DB conventions (CLAUDE.md gotcha, `ci:live-db-suites`): named
// `*.integration.test.ts`, gated by describeWithDb, asserts its schema via
// assertSchemaReady, and NEVER applies migration SQL.
//
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  MIGRATION_100_IMPORT_CONSENT,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import {
  createImportOffer,
  importConsentStateSql,
  IMPORT_OFFER_WINDOW_DAYS,
  readImportConsent,
  recordImportDecisionAndEnqueue,
  type ImportConsentState,
} from '../import-consent';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

let db: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const businessId = randomUUID();

function sql(): postgresType.Sql {
  if (!db) throw new Error('import-consent integration database was not initialized');
  return db;
}

// ── Fixture controls ────────────────────────────────────────────────────────
//
// Every helper writes through SQL rather than through the module under test, so
// a broken writer cannot set up its own passing precondition.

/**
 * Set the three consent columns directly.
 *
 * The deadline and decision timestamp are passed as SQL EXPRESSIONS (`null` =>
 * SQL NULL), never JS Dates: postgres.js truncates timestamptz microseconds to
 * milliseconds (CLAUDE.md gotcha), so a JS-Date-seeded fixture carries zero µs
 * and cannot exercise the sub-millisecond boundary these predicates live on.
 * Values are test-controlled literals, so `unsafe` interpolation is appropriate
 * here and keeps the helper legible.
 */
async function setConsent(opts: {
  decision?: 'pending' | 'accepted' | 'declined';
  /** e.g. `now() + interval '3 days'`. `null` => SQL NULL. */
  expiresAtSql?: string | null;
  /** e.g. `now()`. `null` => SQL NULL. */
  decidedAtSql?: string | null;
}): Promise<void> {
  const decision = opts.decision ?? 'pending';
  const expires = opts.expiresAtSql ? `(${opts.expiresAtSql})` : 'NULL';
  const decided = opts.decidedAtSql ? `(${opts.decidedAtSql})` : 'NULL';
  await sql().unsafe(
    `UPDATE businesses
        SET import_decision = '${decision}',
            import_decision_at = ${decided},
            import_offer_expires_at = ${expires}
      WHERE id = '${businessId}'::uuid`,
  );
}

async function setActivated(activated: boolean): Promise<void> {
  if (activated) {
    await sql()`
      UPDATE accounts SET subscription_activated_at = now()
      WHERE id = ${tenant!.accountId}::uuid
    `;
    return;
  }
  await sql()`
    UPDATE accounts SET subscription_activated_at = NULL
    WHERE id = ${tenant!.accountId}::uuid
  `;
}

async function setConnection(status: 'active' | 'disconnected' | null): Promise<void> {
  await sql()`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
  if (status === null) return;
  await sql()`
    INSERT INTO zernio_connections (
      id, business_id, zernio_profile_id, zernio_account_id,
      zernio_location_id, status, connected_at
    ) VALUES (
      ${randomUUID()}::uuid, ${businessId}::uuid, 'prof-import-consent',
      'acct-import-consent', 'loc-import-consent', ${status}, now()
    )
  `;
}

/** The junction: activation + an active connection. */
async function atJunction(): Promise<void> {
  await setActivated(true);
  await setConnection('active');
}

async function readRaw(id: string = businessId) {
  const [row] = await sql()<{
    import_decision: string;
    import_decision_at: Date | null;
    import_offer_expires_at: Date | null;
  }[]>`
    SELECT import_decision, import_decision_at, import_offer_expires_at
    FROM businesses WHERE id = ${id}::uuid
  `;
  return row!;
}

async function outboxCount(): Promise<number> {
  const [row] = await sql()<{ n: string }[]>`
    SELECT count(*)::text AS n FROM job_outbox
    WHERE aggregate_id = ${businessId}::uuid
      AND topic = 'zernio_initial_backfill'
  `;
  return Number(row!.n);
}

async function clearOutbox(): Promise<void> {
  await sql()`DELETE FROM job_outbox WHERE aggregate_id = ${businessId}::uuid`;
}

/**
 * Seed a `zernio_backfill_runs` row. The four provenance columns are NOT NULL
 * with no defaults, so a run cannot be seeded without them.
 *
 * `runReason` is the whole point of the round-1 A4 titles: the DB carries a
 * UNIQUE partial index on `(business_id) WHERE run_reason = 'initial'` and
 * deliberately does NOT dedup anything else, so `'reactivation'` rows RECUR.
 */
async function seedRun(opts: {
  runReason: 'initial' | 'reactivation';
  completed: boolean;
}): Promise<void> {
  await sql().unsafe(
    `INSERT INTO zernio_backfill_runs (
       id, business_id, zernio_account_id, zernio_location_id,
       subscription_tier, subscription_activated_at, run_reason, completed_at
     ) VALUES (
       '${randomUUID()}'::uuid, '${businessId}'::uuid,
       'zacct-import-consent', 'zloc-import-consent',
       'copilot', now() - interval '60 days',
       '${opts.runReason}',
       ${opts.completed ? 'now()' : 'NULL'}
     )`,
  );
}

async function clearRuns(): Promise<void> {
  await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
}

// ── Analytics fixtures (#679 T2) ────────────────────────────────────────────
//
// `import_offer_created` / `import_decision_recorded` were deferred out of #677
// (deviations D7) because they need the analytics_events.event_name CHECK
// extended, which needed a migration that ticket's non-goals forbade. They are
// emitted from INSIDE the two writers — never from their callers — for the same
// reason `recordSuppression` does: moving them out repeats the event key, the
// properties and the "only when actually written" condition at three
// createImportOffer sites.

interface AnalyticsRow {
  event_key: string;
  event_name: string;
  account_id: string | null;
  distinct_id: string;
  properties: unknown;
}

/** Postgres.js + PgBouncer can hand JSONB back as a string (CLAUDE.md gotcha). */
function analyticsProperties(row: AnalyticsRow): Record<string, unknown> {
  const { properties } = row;
  return (
    typeof properties === 'string' ? JSON.parse(properties) : properties
  ) as Record<string, unknown>;
}

async function readAnalytics(
  eventName: 'import_offer_created' | 'import_decision_recorded',
  exec: postgresType.Sql | postgresType.TransactionSql = sql(),
): Promise<AnalyticsRow[]> {
  return exec<AnalyticsRow[]>`
    SELECT event_key, event_name, account_id, distinct_id, properties
    FROM analytics_events
    WHERE account_id = ${tenant!.accountId}::uuid
      AND event_name = ${eventName}
    ORDER BY event_key
  `;
}

async function clearAnalytics(): Promise<void> {
  await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant!.accountId}::uuid`;
}

/** Evaluate the composable predicate the way a real consumer would. */
async function derivedState(): Promise<ImportConsentState | null> {
  const [row] = await sql()<{ state: ImportConsentState }[]>`
    SELECT ${importConsentStateSql(sql())} AS state
    FROM businesses b WHERE b.id = ${businessId}::uuid
  `;
  return row?.state ?? null;
}

describeWithDb('import consent against live Postgres', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    db = postgres(testDatabaseUrl!, { max: 4, prepare: false });
    // max:4, not max:1 — titles 11, 61 and 62 are concurrency races that need
    // genuinely separate sessions. A single-connection pool serializes them and
    // the race silently cannot occur, which is how a green run proves nothing.
    await assertSchemaReady(db, [MIGRATION_100_IMPORT_CONSENT]);
    tenant = await seedTenantAccount(db, {
      userName: 'Import Consent Owner',
      accountDisplayName: 'Import Consent Account',
    });

    await sql()`
      INSERT INTO businesses (
        id, name, owner_name, owner_email, account_id, subscription_status
      ) VALUES (
        ${businessId}::uuid, 'Import Consent Location', 'Import Consent Owner',
        ${tenant.ownerEmail}, ${tenant.accountId}::uuid, 'active'
      )
    `;
  });

  afterAll(async () => {
    if (!db) return;
    if (tenant) {
      await sql()`DELETE FROM analytics_events WHERE account_id = ${tenant.accountId}::uuid`;
      await sql()`DELETE FROM zernio_backfill_runs WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM job_outbox WHERE aggregate_id::text = ${businessId}`;
      await sql()`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
      await sql()`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await db.end({ timeout: 5 });
  });

  // ── The derived-expiry predicate (spec §5.3) ────────────────────────────────

  it('importConsentStateSql derives expired only for a pending offer whose deadline has passed', async () => {
    await setConsent({ decision: 'pending', expiresAtSql: "now() - interval '1 second'" });
    expect(await derivedState()).toBe('expired');

    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '1 second'" });
    expect(await derivedState()).toBe('pending');
  });

  it('importConsentStateSql returns the stored decision unchanged for accepted and declined rows whatever the deadline', async () => {
    // A terminal decision is terminal. The deadline is irrelevant once answered —
    // if it were not, an accepted offer would read as `expired` a week later and
    // #679's worker guard would refuse a legitimately consented import.
    for (const decision of ['accepted', 'declined'] as const) {
      await setConsent({ decision, expiresAtSql: "now() - interval '30 days'", decidedAtSql: 'now()' });
      expect(await derivedState()).toBe(decision);

      await setConsent({ decision, expiresAtSql: "now() + interval '30 days'", decidedAtSql: 'now()' });
      expect(await derivedState()).toBe(decision);

      await setConsent({ decision, expiresAtSql: null, decidedAtSql: 'now()' });
      expect(await derivedState()).toBe(decision);
    }
  });

  it('importConsentStateSql treats a pending offer with a NULL deadline as pending never expired', async () => {
    // Migration 100's DEFAULT for every business row. It is `pending`, but it is
    // NOT an answerable offer — the guarded UPDATE's IS NOT NULL is what makes
    // that distinction, and title 9 pins it.
    await setConsent({ decision: 'pending', expiresAtSql: null });
    expect(await derivedState()).toBe('pending');
  });

  it('importConsentStateSql evaluates the deadline with Postgres now at the inclusive boundary', async () => {
    // §5.3 writes the boundary as `<=`: a deadline that has ARRIVED has passed.
    //
    // BOTH assertions run INSIDE ONE TRANSACTION, and that is the whole method.
    // `now()` is the transaction timestamp, so writing the deadline and
    // evaluating the predicate in the same transaction is the only way to hit
    // deadline == now() exactly — which is the ONLY case that distinguishes `<=`
    // from `<`. Across two statements wall-clock advances and every margin
    // smaller than the gap reads as passed (the first draft of this test failed
    // for exactly that reason).
    await sql().begin(async (tx) => {
      const state = async () => {
        const [row] = await tx<{ state: ImportConsentState }[]>`
          SELECT ${importConsentStateSql(tx)} AS state
          FROM businesses b WHERE b.id = ${businessId}::uuid
        `;
        return row!.state;
      };

      // Exactly at the deadline → expired. `<` would say pending here.
      await tx`
        UPDATE businesses
        SET import_decision = 'pending', import_decision_at = NULL,
            import_offer_expires_at = now()
        WHERE id = ${businessId}::uuid
      `;
      expect(await state()).toBe('expired');

      // 419µs past it → still pending. This is the µs-precision half: postgres.js
      // truncates timestamptz to MILLISECONDS (CLAUDE.md gotcha), so an
      // implementation that read the timestamp into JS and compared there would
      // truncate 419µs to 0, land back on the equal case, and wrongly say
      // expired. Staying `pending` proves the comparison happens in Postgres.
      await tx`
        UPDATE businesses
        SET import_offer_expires_at = now() + interval '419 microseconds'
        WHERE id = ${businessId}::uuid
      `;
      expect(await state()).toBe('pending');
    });
  });

  // ── createImportOffer: the junction write ───────────────────────────────────

  it('createImportOffer stamps a deadline seven days out on a pending row with no deadline', async () => {
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: null });

    const result = await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId));
    expect(result).toBe('created');

    const [check] = await sql()<{ days: string; decision: string; decided: Date | null }[]>`
      SELECT
        round(extract(epoch FROM (import_offer_expires_at - now())) / 86400)::text AS days,
        import_decision AS decision,
        import_decision_at AS decided
      FROM businesses WHERE id = ${businessId}::uuid
    `;
    expect(Number(check!.days)).toBe(IMPORT_OFFER_WINDOW_DAYS);
    // Creating an offer is not answering it.
    expect(check!.decision).toBe('pending');
    expect(check!.decided).toBeNull();
  });

  it('createImportOffer is idempotent on a second junction and never extends the deadline', async () => {
    await atJunction();
    // A deadline already 6 days in: a reconnect must NOT push it back to 7.
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '6 days'" });
    const before = (await readRaw()).import_offer_expires_at;

    const result = await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId));

    expect(result).toBe('unchanged');
    expect((await readRaw()).import_offer_expires_at).toEqual(before);
  });

  it('createImportOffer never writes to a row whose import decision is already answered', async () => {
    await atJunction();
    for (const decision of ['accepted', 'declined'] as const) {
      await setConsent({ decision, expiresAtSql: null, decidedAtSql: 'now()' });
      const before = await readRaw();

      const result = await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId));

      expect(result).toBe('unchanged');
      // Spec §7: re-connect after declining stays declined. A helper that
      // re-offered here would let a reconnect resurrect a declined offer.
      expect(await readRaw()).toEqual(before);
    }
  });

  it('readImportConsent binds the requested business and returns null for a business with no row', async () => {
    await setConsent({ decision: 'declined', expiresAtSql: "now() + interval '2 days'", decidedAtSql: 'now()' });

    const mine = await readImportConsent(sql(), businessId, tenant!.accountId);
    expect(mine).not.toBeNull();
    expect(mine!.state).toBe('declined');
    expect(mine!.decidedAt).not.toBeNull();
    expect(mine!.expiresAt).not.toBeNull();

    // The binding assertion. There is no mocked twin for this module, so if the
    // business id were ignored — or bound into the wrong placeholder — nothing
    // else in the repo would notice.
    expect(await readImportConsent(sql(), randomUUID(), tenant!.accountId)).toBeNull();

    // And the account predicate is real, not decorative: the RIGHT business under
    // the WRONG account reads as absent. This is the cross-tenant consent read
    // that invariant #8 exists to make impossible.
    expect(await readImportConsent(sql(), businessId, randomUUID())).toBeNull();
  });

  // ── recordImportDecision: the F3 guarded transition ─────────────────────────

  it('recordImportDecision rejects a pending row with a NULL deadline as no offer and leaves every consent column unchanged', async () => {
    // THE ROUND-1 CRITICAL. Migration 100 DEFAULTs every business row to
    // `pending` + NULL deadline, so a predicate that admitted NULL would let a
    // direct POST manufacture `accepted` consent for a location that was never
    // offered anything — and would make `no_offer` unreachable.
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: null });
    await clearOutbox();
    const before = await readRaw();

    const outcome = await recordImportDecisionAndEnqueue(
      sql(), businessId, tenant!.accountId, 'accepted',
    );

    expect(outcome).toBe('no_offer');
    expect(await readRaw()).toEqual(before);
    // The assertion that matters most: no import was enqueued. Asserting only
    // the decision column would pass on an implementation that refused the write
    // but enqueued anyway.
    expect(await outboxCount()).toBe(0);
  });

  it('recordImportDecision rejects at the exact deadline boundary and leaves the row byte-identical', async () => {
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: 'now()' });
    await clearOutbox();
    const before = await readRaw();

    const outcome = await recordImportDecisionAndEnqueue(
      sql(), businessId, tenant!.accountId, 'accepted',
    );

    // The read-side derivation says `expired` at the boundary (title 4), and the
    // write-side guard must agree: `> now()`, so a deadline that has arrived is
    // not answerable. If the two disagreed, the banner would offer a button that
    // silently does nothing.
    expect(outcome).toBe('expired');
    expect(await readRaw()).toEqual(before);
    expect(await outboxCount()).toBe(0);
  });

  it('concurrent accept and decline preserve the first committed terminal decision and the loser writes nothing', async () => {
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearOutbox();

    // Genuinely concurrent: the pool is max:4, so these are separate sessions
    // racing for the same businesses row lock.
    const [a, b] = await Promise.all([
      recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'),
      recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'declined'),
    ]);

    // Exactly one wins; the loser reports the terminal state it found.
    expect([a, b].filter((r) => r === 'recorded')).toHaveLength(1);
    expect([a, b].filter((r) => r === 'already_answered')).toHaveLength(1);

    const after = await readRaw();
    expect(['accepted', 'declined']).toContain(after.import_decision);

    // And the outbox agrees with the decision — an accepted race must enqueue
    // exactly one import, a declined race none. This is where a lost update
    // would show up as a decision of 'declined' alongside a queued import.
    expect(await outboxCount()).toBe(after.import_decision === 'accepted' ? 1 : 0);
  });

  it('property: no sequence of import consent writes ever overwrites a terminal decision', async () => {
    // Sequences, not a single accept-then-decline example: the F3 contract is
    // "the FIRST terminal write is the last one that ever lands", and a
    // two-element example cannot distinguish that from "the last write wins on
    // ties". Kept as an explicit loop over generated sequences rather than
    // fast-check's async runner because each step is a live transaction.
    const decisions = ['accepted', 'declined'] as const;
    for (let run = 0; run < 12; run += 1) {
      await atJunction();
      await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
      await clearOutbox();

      const sequence = Array.from(
        { length: 2 + (run % 4) },
        (_, i) => decisions[(run + i) % 2]!,
      );

      let firstTerminal: string | null = null;
      for (const decision of sequence) {
        const outcome = await recordImportDecisionAndEnqueue(
          sql(), businessId, tenant!.accountId, decision,
        );
        if (firstTerminal === null) {
          expect(outcome).toBe('recorded');
          firstTerminal = decision;
        } else {
          // Every subsequent write, whatever its direction, is refused.
          expect(outcome).toBe('already_answered');
        }
        expect((await readRaw()).import_decision).toBe(firstTerminal);
      }

      expect(await outboxCount()).toBe(firstTerminal === 'accepted' ? 1 : 0);
    }
  });

  // ── Schema contract ─────────────────────────────────────────────────────────
  //
  // The ONE title in this file that is meaningful before any implementation
  // lands, and it is asserted rather than deferred on purpose (plan §2, round-1
  // F113): MIGRATION_100_IMPORT_CONSENT proves the columns and the constraint
  // NAME, and migration 101 did not change the name — so a DB stopped at 100
  // passes assertSchemaReady while still carrying the four-valued CHECK. This
  // asserts the constraint DEFINITION instead of trusting the helper.
  //
  // 'expired' must NOT be a storable value: expiry is derived, never stored
  // (#670). A four-valued CHECK would let a writer persist 'expired' and split
  // the single source of truth the derivation exists to be.
  it('the import consent suite asserts the three-valued import_decision CHECK from migration 101', async () => {
    const [row] = await sql()<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'businesses_import_decision_check'
        AND conrelid = 'businesses'::regclass
    `;

    expect(row, 'businesses_import_decision_check is absent — DB is behind migration 100').toBeDefined();

    const definition = row!.definition;
    expect(definition).toContain("'pending'");
    expect(definition).toContain("'accepted'");
    expect(definition).toContain("'declined'");
    // The assertion that migration 101 exists at all, and the one the named
    // schema requirement structurally cannot make.
    expect(definition).not.toContain("'expired'");
  });

  // ── Junction eligibility inside createImportOffer's SQL (round-2 High) ──────
  //
  // Both halves are proven by the helper, not by its callers: activation
  // non-NULL AND an active zernio_connections row. Titles 57 and 58 are the two
  // one-sided cases.

  it('createImportOffer creates no offer when the subscription is activated but no active connection exists', async () => {
    await setConsent({ decision: 'pending', expiresAtSql: null });
    await setActivated(true);

    // No connection row at all.
    await setConnection(null);
    expect(await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId))).toBe('unchanged');
    expect((await readRaw()).import_offer_expires_at).toBeNull();

    // And a DISCONNECTED row is not a junction either — this is the half that
    // matters after a disconnect, which leaves the old row in place rather than
    // deleting it (disconnect/route.ts:251-262).
    await setConnection('disconnected');
    expect(await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId))).toBe('unchanged');
    expect((await readRaw()).import_offer_expires_at).toBeNull();
  });

  it('createImportOffer creates no offer when a connection exists but the subscription was never activated', async () => {
    await setConsent({ decision: 'pending', expiresAtSql: null });
    await setConnection('active');
    await setActivated(false);

    expect(await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId))).toBe('unchanged');
    expect((await readRaw()).import_offer_expires_at).toBeNull();
  });

  it('createImportOffer never rewrites a deadline that already exists', async () => {
    await atJunction();
    // A deadline in the PAST, i.e. a derived-expired offer. Re-stamping it would
    // silently resurrect a lapsed offer on the next reconnect — and because
    // nothing fires at the expiry moment (#670), an expired row looks exactly
    // like a live one to any code that forgets the IS NULL guard.
    await setConsent({ decision: 'pending', expiresAtSql: "now() - interval '5 days'" });
    const before = (await readRaw()).import_offer_expires_at;

    expect(await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId))).toBe('unchanged');

    expect((await readRaw()).import_offer_expires_at).toEqual(before);
    expect(await derivedState()).toBe('expired');
  });

  // Revision 4 (owner adjudication): there is NO junction anchor. A self-healed
  // offer deliberately starts a fresh 7 days at the repair, which gives the
  // owner a full window from the first moment they could have seen the offer.
  // This title pins that behaviour so a future reader does not "fix" it back
  // into an anchor — the anchor was self-invented and cost two review rounds.
  it('a self-healed offer starts its seven days at the repair, not at the failed junction write', async () => {
    // The junction happened in the past and its offer write FAILED — the
    // connection is old, the activation is old, and the deadline is still NULL.
    await setActivated(true);
    await sql()`DELETE FROM zernio_connections WHERE business_id = ${businessId}::uuid`;
    await sql()`
      INSERT INTO zernio_connections (
        id, business_id, zernio_profile_id, zernio_account_id,
        zernio_location_id, status, connected_at, created_at
      ) VALUES (
        ${randomUUID()}::uuid, ${businessId}::uuid, 'prof-old', 'acct-old',
        'loc-old', 'active', now() - interval '20 days', now() - interval '20 days'
      )
    `;
    await sql()`
      UPDATE accounts SET subscription_activated_at = now() - interval '20 days'
      WHERE id = ${tenant!.accountId}::uuid
    `;
    await setConsent({ decision: 'pending', expiresAtSql: null });

    // The repair (what the GET self-heal does).
    expect(await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId)))
      .toBe('created');

    // 7 days from NOW, not from the 20-day-old junction — which under an anchor
    // would have produced a deadline 13 days in the PAST, i.e. an offer that was
    // already expired the first time the owner could see it.
    const [check] = await sql()<{ days_out: string }[]>`
      SELECT round(extract(epoch FROM (import_offer_expires_at - now())) / 86400)::text AS days_out
      FROM businesses WHERE id = ${businessId}::uuid
    `;
    expect(Number(check!.days_out)).toBe(IMPORT_OFFER_WINDOW_DAYS);
    expect(await derivedState()).toBe('pending');
  });

  // The classification race the businesses row lock exists to remove: under READ
  // COMMITTED a concurrent self-heal could turn a NULL deadline into a live one
  // between the guarded UPDATE and the re-read, making the classifier report
  // already_answered for a row that is still answerable.
  it('a concurrent self-heal during a decision does not misclassify a live pending offer as already answered', async () => {
    await atJunction();
    await clearOutbox();

    // The race: a decision arrives while the row still has a NULL deadline, at the
    // same moment a self-heal stamps one. Both take the same businesses row lock,
    // so they serialize — and the ONLY two legal outcomes are
    //   heal-then-decide  → 'recorded'  (the offer became answerable first), or
    //   decide-then-heal  → 'no_offer'  (there was genuinely no offer yet).
    // 'already_answered' is the bug: it would mean the classifier re-read a row
    // that changed under it and concluded someone else had answered, when nobody
    // had. That is what the lock exists to make impossible.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await setConsent({ decision: 'pending', expiresAtSql: null });
      await clearOutbox();

      const [outcome] = await Promise.all([
        recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'),
        sql().begin(async (tx) => {
          await tx`
            SELECT id FROM businesses
            WHERE id = ${businessId}::uuid AND account_id = ${tenant!.accountId}::uuid
            FOR UPDATE
          `;
          return createImportOffer(tx, businessId, tenant!.accountId);
        }),
      ]);

      expect(['recorded', 'no_offer'], `attempt ${attempt} returned ${outcome}`)
        .toContain(outcome);

      // And the row never lands in a state the outcome contradicts.
      const row = await readRaw();
      if (outcome === 'recorded') {
        expect(row.import_decision).toBe('accepted');
        expect(await outboxCount()).toBe(1);
      } else {
        expect(row.import_decision).toBe('pending');
        expect(await outboxCount()).toBe(0);
      }
    }
  });

  // ── enqueueInitialImport: the shared enqueue's completed-run guard ──────────
  //
  // Round-1 A4. Three producers each spelled this guard differently and none of
  // them matched `readImportOfferView`'s. Round-1 O3 collapsed them into
  // `enqueueInitialImport`; these two titles are why the collapse was worth
  // doing, and they are LIVE because the whole question is which rows the
  // anti-join keeps — a mocked `sql` tag returns what it is told and cannot
  // falsify a predicate.

  it('a completed reactivation run does not suppress the one-time initial import', async () => {
    // THE A4 BUG, end to end. Accept → archive before the worker runs (the
    // `initial` run row exists with completed_at NULL) → reactivate → the
    // catch-up runs and COMPLETES with run_reason 'reactivation'. Under the old
    // unscoped guard every producer then saw "a completed run" and refused the
    // initial import forever, while the banner — correctly scoped to `initial`
    // — kept reporting `importing` on a 4s poll. Reactivation runs recur by
    // design; only `initial` is once per business.
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await seedRun({ runReason: 'reactivation', completed: true });
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });

    const outcome = await recordImportDecisionAndEnqueue(
      sql(), businessId, tenant!.accountId, 'accepted',
    );

    expect(outcome).toBe('recorded');
    expect(await outboxCount()).toBe(1);
  });

  it('a completed initial run does suppress the import, and an incomplete one does not', async () => {
    // The other side of the same predicate, so the fix cannot be read as
    // "dropped the guard". Both halves matter: `completed_at IS NOT NULL` is what
    // makes an interrupted run retryable (the row exists, the import never
    // finished), and `run_reason = 'initial'` is what keeps it once-per-business.
    await atJunction();

    await clearRuns();
    await clearOutbox();
    await seedRun({ runReason: 'initial', completed: true });
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });

    // The consent write still stands — consent and enqueue eligibility are
    // different questions — but nothing is queued.
    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
      .toBe('recorded');
    expect((await readRaw()).import_decision).toBe('accepted');
    expect(await outboxCount()).toBe(0);

    await clearRuns();
    await clearOutbox();
    await seedRun({ runReason: 'initial', completed: false });
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });

    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
      .toBe('recorded');
    expect(await outboxCount()).toBe(1);

    await clearRuns();
  });

  // ── Tenant scope on the two statements that WRITE (round-1 A9) ──────────────

  it('a decision under a foreign account writes nothing and enqueues nothing', async () => {
    // The module header states that every function binds `accountId` DIRECTLY
    // rather than inferring tenancy from a preceding read. Round 1 found the
    // guarded UPDATE and the outbox INSERT doing exactly what that paragraph
    // forbids. They bind it now — and this is the behaviour that must hold
    // whichever statement is the one enforcing it.
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearOutbox();
    const before = await readRaw();

    const outcome = await recordImportDecisionAndEnqueue(
      sql(), businessId, randomUUID(), 'accepted',
    );

    expect(outcome).toBe('no_offer');
    expect(await readRaw()).toEqual(before);
    expect(await outboxCount()).toBe(0);
    // And the offer is still answerable by its real owner — a cross-tenant POST
    // must not consume the one-time offer either.
    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'declined'))
      .toBe('recorded');
  });

  // ── The rejected-decision log line (`observability` item 2, round-1 A2) ─────

  it('every rejected decision emits one structured log line naming the rejection class and business id', async () => {
    // The intake names this signal and the exact support ticket it exists for:
    // "the owner says the button did nothing" must resolve to an expiry or a
    // missing offer rather than an outage. Nothing throws on these paths, so
    // reportCaughtError never fires — without this line Railway is silent.
    //
    // Asserted across ALL THREE classes rather than one, because the value of
    // the signal is telling them apart.
    await atJunction();

    const cases: Array<{ rejection: string; arrange: () => Promise<void>; accountId: string }> = [
      {
        rejection: 'no_offer',
        // Migration 100's DEFAULT: pending with a NULL deadline is not an offer.
        arrange: () => setConsent({ decision: 'pending', expiresAtSql: null }),
        accountId: tenant!.accountId,
      },
      {
        rejection: 'expired',
        arrange: () => setConsent({ decision: 'pending', expiresAtSql: "now() - interval '1 second'" }),
        accountId: tenant!.accountId,
      },
      {
        rejection: 'already_answered',
        arrange: () => setConsent({
          decision: 'declined',
          expiresAtSql: "now() + interval '3 days'",
          decidedAtSql: 'now()',
        }),
        accountId: tenant!.accountId,
      },
    ];

    for (const testCase of cases) {
      await testCase.arrange();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const outcome = await recordImportDecisionAndEnqueue(
          sql(), businessId, testCase.accountId, 'accepted',
        );
        expect(outcome).toBe(testCase.rejection);

        // ONE line, and it must parse as the structured record createWorkerLogger
        // emits — a bare console.log string would satisfy "a log exists" while
        // being unqueryable in Railway, which is the whole point of the item.
        const lines = spy.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('Import decision rejected'));
        expect(lines, `no rejection line for ${testCase.rejection}`).toHaveLength(1);

        const record = JSON.parse(lines[0]!) as {
          logger: string;
          data?: Record<string, unknown>;
        };
        expect(record.logger).toBe('import-consent');
        expect(record.data).toMatchObject({
          business_id: businessId,
          rejection: testCase.rejection,
        });
      } finally {
        spy.mockRestore();
      }
    }
  });

  // ── #679 T2: the two Import offer analytics events ──────────────────────────
  //
  // The offer-created → decision-recorded ratio is the offer-to-answer churn
  // signal #677's intake named and D7 deferred here (`observability` item 2).
  // Both events are emitted from INSIDE the writing transaction, so an event
  // can never outlive the fact it reports.
  //
  // These titles are LIVE because every property that matters is a transaction
  // boundary or an ON CONFLICT: a mocked `sql` tag can prove the call was made
  // and nothing else.

  it('createImportOffer records import_offer_created in the same transaction', async () => {
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: null });
    await clearAnalytics();

    const seen = await sql().begin(async (tx) => {
      const result = await createImportOffer(tx, businessId, tenant!.accountId);
      // Read INSIDE the same transaction. Reading after the commit would pass
      // just as well for an emission that used the OUTER `sql` handle and
      // therefore committed independently of the offer write.
      return { result, rows: await readAnalytics('import_offer_created', tx) };
    });

    expect(seen.result).toBe('created');
    expect(seen.rows).toHaveLength(1);
    const event = seen.rows[0]!;
    // distinct_id is the account id, matching every other account-scoped event.
    expect(event.distinct_id).toBe(tenant!.accountId);
    expect(event.account_id).toBe(tenant!.accountId);
    expect(analyticsProperties(event)).toEqual({ window_days: IMPORT_OFFER_WINDOW_DAYS });
  });

  it('createImportOffer records no analytics event when the offer already exists', async () => {
    // The idempotent re-entry. `createImportOffer` runs on EVERY dashboard mount
    // through the GET self-heal, so an emission on the `unchanged` branch would
    // re-mint an offer-created event on every render and destroy the ratio the
    // event exists to measure.
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '6 days'" });
    await clearAnalytics();

    const seen = await sql().begin(async (tx) => {
      const result = await createImportOffer(tx, businessId, tenant!.accountId);
      return { result, rows: await readAnalytics('import_offer_created', tx) };
    });

    expect(seen.result).toBe('unchanged');
    expect(seen.rows).toHaveLength(0);
  });

  it('recordImportDecisionAndEnqueue records import_decision_recorded on an accepted decision', async () => {
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
      .toBe('recorded');

    const rows = await readAnalytics('import_decision_recorded');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.distinct_id).toBe(tenant!.accountId);
    expect(analyticsProperties(rows[0]!)).toEqual({ decision: 'accepted' });
  });

  it('recordImportDecisionAndEnqueue records import_decision_recorded on a declined decision', async () => {
    // A decline is an ANSWER, not a rejection: it is the denominator half of the
    // churn ratio, and it takes the early-return branch before the enqueue — the
    // branch an emission placed next to `enqueueInitialImport` would miss.
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'declined'))
      .toBe('recorded');

    const rows = await readAnalytics('import_decision_recorded');
    expect(rows).toHaveLength(1);
    expect(analyticsProperties(rows[0]!)).toEqual({ decision: 'declined' });
    expect(await outboxCount()).toBe(0);
  });

  it('recordImportDecisionAndEnqueue records no analytics event when the decision is rejected', async () => {
    // All three rejection classes, because the value of the event is that its
    // count equals the number of decisions that actually landed.
    await atJunction();
    await clearRuns();

    const cases: Array<{ rejection: string; arrange: () => Promise<void> }> = [
      { rejection: 'no_offer', arrange: () => setConsent({ decision: 'pending', expiresAtSql: null }) },
      {
        rejection: 'expired',
        arrange: () => setConsent({ decision: 'pending', expiresAtSql: "now() - interval '1 second'" }),
      },
      {
        rejection: 'already_answered',
        arrange: () => setConsent({
          decision: 'declined',
          expiresAtSql: "now() + interval '3 days'",
          decidedAtSql: 'now()',
        }),
      },
    ];

    for (const testCase of cases) {
      await testCase.arrange();
      await clearOutbox();
      await clearAnalytics();

      expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
        .toBe(testCase.rejection);

      expect(await readAnalytics('import_decision_recorded'), testCase.rejection).toHaveLength(0);
    }
  });

  it('recordImportDecisionAndEnqueue rolls back import_decision_recorded when the decision transaction aborts', async () => {
    // THE EXECUTOR-IDENTITY BUG, pinned BEHAVIOURALLY. `recordImportDecision-
    // AndEnqueue` has both `sql` and `tx` in scope; an emission written against
    // the outer `sql` passes every happy-path test above while COMMITTING
    // independently of a decision that later rolls back — a recorded decision
    // that never happened. Observing a committed event after a successful call
    // cannot tell the two apart, so force the abort instead.
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    // A deferred CHECK that rejects the import topic makes the enqueue raise
    // INSIDE the acceptance transaction, without touching production code.
    await sql().unsafe(`
      ALTER TABLE job_outbox ADD CONSTRAINT tmp_block_import_topic_analytics
        CHECK (topic <> 'zernio_initial_backfill') NOT VALID
    `);
    try {
      await expect(
        recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'),
      ).rejects.toThrow();
    } finally {
      await sql().unsafe('ALTER TABLE job_outbox DROP CONSTRAINT tmp_block_import_topic_analytics');
    }

    expect(await readAnalytics('import_decision_recorded')).toHaveLength(0);
    // And the decision itself did not survive either — the event and the fact
    // it reports live and die together.
    expect((await readRaw()).import_decision).toBe('pending');
    expect(await outboxCount()).toBe(0);
  });

  it('import_offer_created uses a business-scoped event key so a replayed offer mints once', async () => {
    // Both events are at-most-once per business by construction (the offer write
    // requires a NULL deadline; the decision write requires `pending`), so the
    // key needs no discriminator — and a replay must drop on
    // `ON CONFLICT (event_key) DO NOTHING` rather than double-count.
    await atJunction();
    await setConsent({ decision: 'pending', expiresAtSql: null });
    await clearAnalytics();

    expect(await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId)))
      .toBe('created');
    const first = await readAnalytics('import_offer_created');
    expect(first).toHaveLength(1);
    expect(first[0]!.event_key).toContain(businessId);

    // The replay: the deadline is cleared and the offer written a second time.
    // The WRITE succeeds again; the EVENT must not.
    await setConsent({ decision: 'pending', expiresAtSql: null });
    expect(await sql().begin((tx) => createImportOffer(tx, businessId, tenant!.accountId)))
      .toBe('created');

    const after = await readAnalytics('import_offer_created');
    expect(after).toHaveLength(1);
    expect(after[0]!.event_key).toBe(first[0]!.event_key);
  });

  it('import_decision_recorded uses a business-scoped event key so a replayed decision mints once', async () => {
    await atJunction();
    await clearRuns();
    await clearOutbox();
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearAnalytics();

    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
      .toBe('recorded');
    const first = await readAnalytics('import_decision_recorded');
    expect(first).toHaveLength(1);
    expect(first[0]!.event_key).toContain(businessId);

    // The replay: the row is put back to `pending` and answered again. Nothing
    // in production does this, which is the point — the key, not the caller, is
    // what makes the count right.
    await setConsent({ decision: 'pending', expiresAtSql: "now() + interval '3 days'" });
    await clearOutbox();
    expect(await recordImportDecisionAndEnqueue(sql(), businessId, tenant!.accountId, 'accepted'))
      .toBe('recorded');

    const after = await readAnalytics('import_decision_recorded');
    expect(after).toHaveLength(1);
    expect(after[0]!.event_key).toBe(first[0]!.event_key);
  });
});
