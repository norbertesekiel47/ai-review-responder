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
import { afterAll, beforeAll, expect, it } from 'vitest';
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

/** Evaluate the composable predicate the way a real consumer would. */
async function derivedState(): Promise<ImportConsentState | null> {
  const [row] = await sql()<{ state: ImportConsentState }[]>`
    SELECT ${importConsentStateSql(sql(), 'b')} AS state
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
          SELECT ${importConsentStateSql(tx, 'b')} AS state
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
  it.todo('a self-healed offer starts its seven days at the repair, not at the failed junction write');

  // The classification race the businesses row lock exists to remove: under READ
  // COMMITTED a concurrent self-heal could turn a NULL deadline into a live one
  // between the guarded UPDATE and the re-read, making the classifier report
  // already_answered for a row that is still answerable.
  it.todo('a concurrent self-heal during a decision does not misclassify a live pending offer as already answered');
});
