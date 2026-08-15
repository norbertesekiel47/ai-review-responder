import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  assertSchemaReady,
  MIGRATION_105_CHECKOUT_ATTEMPT_COUPON,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import { cleanupTenantAccount, seedTenantAccount } from '@/lib/shared/__tests__/live-db-tenant';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

// Shape suite for migration 105 — `accounts.checkout_attempt_coupon_id`, the
// beta comp coupon carried on the Checkout attempt snapshot (admin-invite-funnel
// plan step 2 / T1; the constraint rewrite is review-log round 2 finding 5).
//
// The subject is one column and one CHECK, and the asymmetry between the CHECK's
// two branches IS the design:
//
//  1. The NULL-AT-REST branch names the new column. 077's first branch
//     enumerates every attempt column so a cleared attempt is cleared WHOLE —
//     that is the attempt-completeness invariant. A column missing from it would
//     let a row hold no attempt but a live coupon snapshot, which the next
//     attempt's writer has no reason to read and no obligation to overwrite.
//
//  2. The ACTIVE branch does NOT name it. NULL there is not a missing value: it
//     is the explicit "no coupon" decision `applyTierSnapshot` records for every
//     account that is not an admin invitee (or when BETA_COMP_COUPON_ID is
//     unset). A full-price attempt is a COMPLETE attempt.
//
// Those two facts are what the four tests below pin — the first against the
// catalog (column shape + the constraint's own definition), the last three
// behaviourally, because a definition can be read two ways but a rejected UPDATE
// cannot.
//
// No migration SQL is applied here (#573): `pnpm test:db:setup` provisions the
// container to head and this suite ASSERTS with `assertSchemaReady`. It executes
// NO DDL at run time, which is also why it deliberately does not take
// `acquireLiveDbLock` — it only reads the catalog and writes rows under its own
// seeded tenant (the lock helper's own rule; plan T1 says the same). Both
// accepting writes run inside a transaction that is always rolled back, so the
// single fixture account stays at rest for whichever test runs next, and the
// whole tenant is swept in `afterAll`.

const testDatabaseUrl = resolveTestDatabaseUrl();

const HOOK_TIMEOUT_MS = 60_000;

/** A coupon id shaped like the Stripe one, but unmistakably a fixture. */
const TEST_COUPON_ID = 'beta_comp_test';

let db: postgresType.Sql | undefined;
let accountId: string | undefined;
let userId: string | undefined;
let ownerEmail: string | undefined;

/** Rollback signal — distinguishable from a real failure by identity. */
class RollbackSignal extends Error {}

/**
 * Runs `work` in a transaction that is ALWAYS rolled back. A constraint failure
 * inside `work` is a non-`RollbackSignal` error and propagates unchanged, so a
 * rejecting UPDATE still fails its test with the real SQLSTATE.
 */
async function inRolledBackTx(
  work: (tx: postgresType.TransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await db!.begin(async (tx) => {
      await work(tx);
      throw new RollbackSignal('rollback');
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) throw error;
  }
}

/**
 * Writes a COMPLETE active attempt — every column the CHECK's active branch
 * requires — with the given coupon decision. The tuple mirrors the UPDATE
 * `applyTierSnapshot` issues (`src/lib/payments/plan-activation.ts`), so a
 * rejection can only ever come from the coupon column under test.
 */
function writeActiveAttempt(
  tx: postgresType.TransactionSql,
  couponId: string | null,
): Promise<unknown> {
  return tx`
    UPDATE accounts
    SET checkout_attempt_id = ${randomUUID()}::uuid,
        checkout_session_id = NULL,
        checkout_attempt_state = 'creating',
        checkout_attempt_tier = 'copilot',
        checkout_attempt_price_variant = 'list',
        checkout_attempt_base_price_id = 'price_base_105_fixture',
        checkout_attempt_overage_price_id = 'price_overage_105_fixture',
        checkout_attempt_base_price_cents = 2900,
        checkout_attempt_overage_price_cents = 1500,
        checkout_attempt_locations_included = 1,
        checkout_attempt_locations_paid = 0,
        checkout_attempt_overage_quantity = 0,
        checkout_attempt_trial_period_days = NULL,
        checkout_attempt_tax_enabled = FALSE,
        checkout_attempt_customer_email = ${ownerEmail!},
        checkout_attempt_success_url = 'https://test.local/onboarding/payment-success',
        checkout_attempt_cancel_url = 'https://test.local/onboarding/pay',
        checkout_attempt_updated_at = NOW(),
        checkout_attempt_coupon_id = ${couponId},
        updated_at = NOW()
    WHERE id = ${accountId!}::uuid
  `;
}

describeWithDb(
  'migration 105 checkout attempt coupon',
  { enabled: Boolean(testDatabaseUrl), timeout: 120_000 },
  () => {
    beforeAll(async () => {
      const databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      db = postgres(databaseUrl, { max: 1, prepare: false });
      await assertSchemaReady(db, [MIGRATION_105_CHECKOUT_ATTEMPT_COUPON]);
      // pending_payment is the only status an attempt is ever minted under
      // (`applyTierSnapshot` refuses every other one), so the fixture describes
      // a row the funnel could actually produce.
      const seed = await seedTenantAccount(db, {
        userName: 'Checkout Coupon Shape Owner',
        accountDisplayName: 'Checkout Coupon Shape Fixture',
        subscriptionStatus: SubscriptionStatus.PENDING_PAYMENT,
      });
      accountId = seed.accountId;
      userId = seed.userId;
      ownerEmail = seed.ownerEmail;
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      try {
        if (db && accountId && userId) {
          await cleanupTenantAccount(db, { accountId, userId });
        }
      } finally {
        if (db) await db.end({ timeout: 5 });
      }
    }, HOOK_TIMEOUT_MS);

    it('migration 105 adds nullable accounts.checkout_attempt_coupon_id', async () => {
      const [column] = await db!<
        { data_type: string; is_nullable: string; column_default: string | null }[]
      >`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'accounts'
          AND column_name = 'checkout_attempt_coupon_id'
      `;
      expect(column?.data_type).toBe('text');
      // Nullable and defaultless are both load-bearing: NULL is the recorded
      // "no coupon" decision, and a DEFAULT would put a value on every account
      // that never chose one.
      expect(column?.is_nullable).toBe('YES');
      expect(column?.column_default).toBeNull();

      // The DEFINITION, not the name: `accounts_checkout_attempt_complete_check`
      // has existed under that name since 077, so presence proves nothing about
      // 105 (which is why the SchemaRequirement above deliberately omits it).
      const [check] = await db!<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'public.accounts'::regclass
          AND conname = 'accounts_checkout_attempt_complete_check'
      `;
      const def = check?.def.replace(/\s+/g, ' ') ?? '';
      const mentions = def.match(/checkout_attempt_coupon_id/g) ?? [];
      const nullPredicates = def.match(/checkout_attempt_coupon_id IS NULL/g) ?? [];
      // Exactly ONE mention, and it is an IS NULL predicate: the column is
      // constrained in one branch only. WHICH branch is proven behaviourally by
      // the three tests below — an `IS NULL` in the active branch instead would
      // satisfy these counts and then reject the coupon in the last test.
      expect(mentions).toHaveLength(1);
      expect(nullPredicates).toHaveLength(1);
    });

    it('null-at-rest attempt rejects a retained coupon snapshot', async () => {
      // The fixture has never held an attempt, and the two accepting tests below
      // roll back, so this is genuinely the at-rest shape 077's first branch
      // describes.
      const [atRest] = await db!<{ checkout_attempt_state: string | null }[]>`
        SELECT checkout_attempt_state FROM accounts WHERE id = ${accountId!}::uuid
      `;
      expect(atRest?.checkout_attempt_state).toBeNull();

      // A cleared attempt that keeps its coupon is the defect finding 5 named:
      // no attempt, but a live comp decision no later writer is obliged to
      // overwrite. The database refuses to represent it.
      await expect(
        db!`
          UPDATE accounts
          SET checkout_attempt_coupon_id = ${TEST_COUPON_ID}
          WHERE id = ${accountId!}::uuid
        `,
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('active attempt accepts a null coupon (no-coupon is a complete attempt)', async () => {
      // The common case, and the reason the active branch leaves the column
      // unconstrained: a full-price attempt records an explicit NULL decision
      // and is complete without a coupon.
      await inRolledBackTx(async (tx) => {
        await writeActiveAttempt(tx, null);
        const [row] = await tx<
          { checkout_attempt_state: string | null; checkout_attempt_coupon_id: string | null }[]
        >`
          SELECT checkout_attempt_state, checkout_attempt_coupon_id
          FROM accounts WHERE id = ${accountId!}::uuid
        `;
        expect(row?.checkout_attempt_state).toBe('creating');
        expect(row?.checkout_attempt_coupon_id).toBeNull();
      });
    });

    it('active attempt accepts a coupon id', async () => {
      await inRolledBackTx(async (tx) => {
        await writeActiveAttempt(tx, TEST_COUPON_ID);
        const [row] = await tx<{ checkout_attempt_coupon_id: string | null }[]>`
          SELECT checkout_attempt_coupon_id FROM accounts WHERE id = ${accountId!}::uuid
        `;
        // Snapshotted verbatim: the Session's `discounts` are built from this
        // value, not from a live env read at session-creation time.
        expect(row?.checkout_attempt_coupon_id).toBe(TEST_COUPON_ID);
      });
    });
  },
);
