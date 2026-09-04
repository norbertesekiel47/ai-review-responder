import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type postgresType from 'postgres';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import {
  assertSchemaReady,
  type SchemaRequirement,
} from '@/lib/shared/__tests__/helpers/schema-ready';
import type {
  StripeCustomerLike,
  StripeCustomerRedactionClient,
  StripePaymentMethodLike,
  StripePaymentMethodListResult,
} from '@/lib/account-offboarding/stripe-customer-redaction';
import type { AccountOffboardingPurgeRow } from '../purge-stages';

// BEHAVIOURAL coverage for the shared-customer guard (D1) in
// `runStripeCustomerRedactionPurgeStage`. This suite exists because red-team
// round 2's P0 (R03) was a predicate defect that shipped through a green gate:
// the guard's ONLY pin was a byte-for-byte SQL string in
// `tenant-scope-allowlist.ts`, which tracks the text and asserts NOTHING about
// meaning, and the stage's unit suite mocks `sql` and pushes `{count: 0}` /
// `{count: 1}` — so it decides the guard's answer instead of measuring it.
//
// The property under test is not "the SQL reads as intended". It is: given a
// real co-tenant row in a real lifecycle state, does the stage redact a shared
// Stripe Customer, or skip it? That question is only answerable against
// Postgres, so this is a live-DB suite.
//
// Two of the cases below FAIL against the predicate this suite was written
// alongside replacing (`ao.status IN ('purge_scheduled','purged')`):
//   - `leaves a sibling in the purge grace window alone` (R03/W1)
//   - `redacts past a terminally failed sibling` (R03/W2)
// They are the regression pins. The others hold under both predicates and are
// here so a future narrowing cannot quietly trade one defect for another.
//
// Gated on TEST_DATABASE_POOL_URL; skips cleanly without one. Asserts the
// schema, never applies it (#573), and executes no DDL.
const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;

// Local-host refusal guard (same shape as checks.integration.test.ts): accept
// only localhost/127.0.0.1 Postgres (dev + CI service container), refuse any
// remote/pooler host. Never widen to remote hosts.
function assertExactLocalDatabaseUrl(databaseUrl: string | undefined): string {
  let parsed: URL | undefined;
  try {
    parsed = databaseUrl === undefined ? undefined : new URL(databaseUrl);
  } catch {
    parsed = undefined;
  }
  const isLocalPostgres =
    parsed !== undefined &&
    (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') &&
    (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (databaseUrl === undefined || !isLocalPostgres) {
    throw new Error(
      'stripe-customer-redaction guard integration requires a local (localhost) test database',
    );
  }
  return databaseUrl;
}

// The guard reads `account_offboardings.purge_started_at` / `purge_cancelled_at`
// — the point-of-no-return markers migration 056 introduced alongside the
// delete_data lane. Declared inline rather than added to schema-ready.ts: this
// is the only suite that needs it.
const OFFBOARDING_PURGE_MARKERS: SchemaRequirement = {
  migration: '056_account_offboarding',
  tables: ['account_offboardings'],
  columns: [
    'account_offboardings.mode',
    'account_offboardings.status',
    'account_offboardings.purge_started_at',
    'account_offboardings.purge_cancelled_at',
    'account_offboardings.provider_dispositions',
    'accounts.stripe_customer_id',
  ],
};

let db: postgresType.Sql | undefined;

function sql(): postgresType.Sql {
  if (!db) throw new Error('redaction guard integration database was not initialized');
  return db;
}

/** Tenants seeded by the current test, torn down in afterEach. */
const seeded: TenantSeed[] = [];

async function seedAccountSharingCustomer(customerId: string): Promise<TenantSeed> {
  const tenant = await seedTenantAccount(sql(), {
    userName: 'Redaction Guard Owner',
    accountDisplayName: 'Redaction Guard Account',
  });
  seeded.push(tenant);
  await sql()`
    UPDATE accounts SET stripe_customer_id = ${customerId} WHERE id = ${tenant.accountId}::uuid
  `;
  return tenant;
}

interface OffboardingFixture {
  accountId: string;
  mode: 'delete_data' | 'cancel_only';
  status: 'pending' | 'tearing_down' | 'purge_scheduled' | 'failed';
  purgeStarted: boolean;
  purgeCancelled?: boolean;
}

async function insertOffboarding(fixture: OffboardingFixture): Promise<string> {
  const id = randomUUID();
  // `failed_step` is NOT NULL exactly when status = 'failed'
  // (account_offboardings_failed_step_check); 'purge' is the step a terminal
  // purge failure records.
  const failedStep = fixture.status === 'failed' ? 'purge' : null;
  await sql()`
    INSERT INTO account_offboardings
      (id, account_id, mode, status, failed_step, purge_started_at, purge_cancelled_at, purge_after)
    VALUES (
      ${id}::uuid,
      ${fixture.accountId}::uuid,
      ${fixture.mode},
      ${fixture.status},
      ${failedStep},
      ${fixture.purgeStarted ? sql()`NOW()` : null},
      ${fixture.purgeCancelled ? sql()`NOW()` : null},
      NOW()
    )
  `;
  return id;
}

interface StripeSpy {
  client: StripeCustomerRedactionClient;
  updates: string[];
  detached: string[];
}

/**
 * A Stripe double that records what the stage asked it to do. The whole test is
 * the difference between `updates.length === 1` (the Customer's PII was erased)
 * and `updates.length === 0` (the guard skipped) — so this deliberately never
 * throws, and a skip is proven by absence rather than by a rejected call.
 */
function stripeSpy(customerId: string): StripeSpy {
  const updates: string[] = [];
  const detached: string[] = [];
  const customer: StripeCustomerLike = {
    id: customerId,
    email: 'owner@example.com',
    name: 'Guard Fixture Owner',
    metadata: {},
  };
  return {
    updates,
    detached,
    client: {
      customers: {
        retrieve: async () => customer,
        update: async (id: string) => {
          updates.push(id);
          return customer;
        },
      },
      paymentMethods: {
        list: async (): Promise<StripePaymentMethodListResult> => ({
          data: [],
          has_more: false,
        }),
        detach: async (paymentMethodId: string): Promise<StripePaymentMethodLike> => {
          detached.push(paymentMethodId);
          return { id: paymentMethodId };
        },
      },
    },
  };
}

function purgeRow(
  offboardingId: string,
  accountId: string,
  customerId: string,
): AccountOffboardingPurgeRow {
  return {
    id: offboardingId,
    account_id: accountId,
    mode: 'delete_data',
    status: 'purge_scheduled',
    terminal_at: null,
    teardown_completed_at: new Date(),
    purge_started_at: new Date(),
    purge_cancelled_at: null,
    auth_user_id: null,
    recipient_email: null,
    provider_dispositions: [],
    stripe_customer_id: customerId,
    stripe_subscription_id: null,
    zernio_account_ids: null,
    zernio_profile_ids: null,
    location_ids: null,
    stripe_step: null,
    zernio_accounts_step: null,
    zernio_profiles_step: null,
    location_archival_step: null,
  };
}

/** The outcome the stage appended to `provider_dispositions`. */
async function recordedOutcome(offboardingId: string): Promise<string | undefined> {
  const [row] = await sql()<{ outcome: string | null }[]>`
    SELECT disposition.value->>'outcome' AS outcome
    FROM account_offboardings ao
    CROSS JOIN LATERAL jsonb_array_elements(ao.provider_dispositions) AS disposition(value)
    WHERE ao.id = ${offboardingId}::uuid
      AND disposition.value->>'type' = 'stripe_customer_redaction'
    ORDER BY disposition.value->>'recorded_at' DESC
    LIMIT 1
  `;
  return row?.outcome ?? undefined;
}

/**
 * Seed a purging account A plus one co-tenant B in `sibling`'s state, run the
 * real stage against the real database, and report what the Stripe double saw.
 */
async function runGuard(
  sibling: Omit<OffboardingFixture, 'accountId'> | null,
): Promise<{ updates: string[]; outcome: string | undefined }> {
  const customerId = `cus_guard_${randomUUID().replaceAll('-', '')}`;
  const purging = await seedAccountSharingCustomer(customerId);
  const purgingOffboardingId = await insertOffboarding({
    accountId: purging.accountId,
    mode: 'delete_data',
    status: 'purge_scheduled',
    purgeStarted: true,
  });

  if (sibling) {
    const coTenant = await seedAccountSharingCustomer(customerId);
    await insertOffboarding({ ...sibling, accountId: coTenant.accountId });
  }

  const spy = stripeSpy(customerId);
  const { runStripeCustomerRedactionPurgeStage } = await import('../purge-stages');
  await runStripeCustomerRedactionPurgeStage(
    sql(),
    () => spy.client,
    purgeRow(purgingOffboardingId, purging.accountId, customerId),
  );

  return { updates: spy.updates, outcome: await recordedOutcome(purgingOffboardingId) };
}

const SUITE = testDatabaseUrl ? describe : describe.skip;

SUITE('the shared-customer redaction guard, against live Postgres', () => {
  beforeAll(async () => {
    process.env.DATABASE_POOL_URL = testDatabaseUrl;
    db = postgres(assertExactLocalDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    await assertSchemaReady(db, [OFFBOARDING_PURGE_MARKERS]);
  }, 30_000);

  afterEach(async () => {
    // `account_offboardings.account_id` is ON DELETE CASCADE, so dropping the
    // accounts drops their offboardings with them.
    for (const tenant of seeded.splice(0)) {
      await cleanupTenantAccount(sql(), tenant);
    }
  });

  afterAll(async () => {
    if (db) await db.end({ timeout: 5 });
  });

  // ---- R03/W1: the defect this suite was written for -----------------------

  it('leaves a sibling in the purge grace window alone — it can still Keep my data', async () => {
    // `purge_scheduled` with `purge_started_at IS NULL` is the MODAL state of a
    // delete_data offboarding between teardown and `purge_after`. It is exactly
    // keep-my-data.ts's admission set, so this co-tenant can still cancel and
    // stay a paying customer. Redacting on its behalf destroys a live billing
    // contact with nothing recorded against that account.
    const { updates, outcome } = await runGuard({
      mode: 'delete_data',
      status: 'purge_scheduled',
      purgeStarted: false,
    });

    expect(updates).toEqual([]);
    expect(outcome).toBe('skipped_shared_customer');
  });

  it('leaves a sibling in the pre-teardown window alone', async () => {
    const { updates, outcome } = await runGuard({
      mode: 'delete_data',
      status: 'tearing_down',
      purgeStarted: false,
    });

    expect(updates).toEqual([]);
    expect(outcome).toBe('skipped_shared_customer');
  });

  // ---- R03/W2: both-siblings-skip, one status over ------------------------

  it('redacts past a terminally failed sibling — it is past the point of no return', async () => {
    // `markPurgeTerminalFailure` leaves status='failed' with purge_started_at
    // set. Such a sibling can never come back, so counting it as a live
    // co-tenant is the both-siblings-skip defect: the Stripe PII becomes
    // permanent with no local id left to retry from.
    const { updates, outcome } = await runGuard({
      mode: 'delete_data',
      status: 'failed',
      purgeStarted: true,
    });

    expect(updates).toHaveLength(1);
    expect(outcome).toBe('redacted');
  });

  // ---- the round-1 case the fix must not regress ---------------------------

  it('redacts when a sibling purge has been claimed concurrently', async () => {
    // AccountOffboardingPurgePoller stamps `purge_started_at` in the claim
    // transaction, before the outbox row dispatches — so by the time either
    // sibling's PurgeWorker runs, the other is already marked. This is what
    // keeps two concurrent purges from both skipping.
    const { updates, outcome } = await runGuard({
      mode: 'delete_data',
      status: 'purge_scheduled',
      purgeStarted: true,
    });

    expect(updates).toHaveLength(1);
    expect(outcome).toBe('redacted');
  });

  // ---- the escape hatch re-admits a sibling as live ------------------------

  it('leaves a sibling alone once its purge is cancelled', async () => {
    // No writer produces `purge_started_at` and `purge_cancelled_at` together
    // today — keep-my-data.ts gates on `purge_started_at IS NULL`. The clause is
    // what keeps the guard correct if a second cancellation path is ever added,
    // and this pins that intent rather than the current reachability.
    const { updates, outcome } = await runGuard({
      mode: 'delete_data',
      status: 'purge_scheduled',
      purgeStarted: true,
      purgeCancelled: true,
    });

    expect(updates).toEqual([]);
    expect(outcome).toBe('skipped_shared_customer');
  });

  // ---- cancel_only is a live co-tenant however far it has run --------------

  it('leaves a cancel_only sibling alone — it retains its data and can reactivate', async () => {
    const { updates, outcome } = await runGuard({
      mode: 'cancel_only',
      status: 'tearing_down',
      purgeStarted: false,
    });

    expect(updates).toEqual([]);
    expect(outcome).toBe('skipped_shared_customer');
  });

  // ---- the ordinary ends of the range -------------------------------------

  it('leaves a sibling with no offboarding at all alone', async () => {
    const customerId = `cus_guard_${randomUUID().replaceAll('-', '')}`;
    const purging = await seedAccountSharingCustomer(customerId);
    const offboardingId = await insertOffboarding({
      accountId: purging.accountId,
      mode: 'delete_data',
      status: 'purge_scheduled',
      purgeStarted: true,
    });
    await seedAccountSharingCustomer(customerId); // a plain paying co-tenant

    const spy = stripeSpy(customerId);
    const { runStripeCustomerRedactionPurgeStage } = await import('../purge-stages');
    await runStripeCustomerRedactionPurgeStage(
      sql(),
      () => spy.client,
      purgeRow(offboardingId, purging.accountId, customerId),
    );

    expect(spy.updates).toEqual([]);
    expect(await recordedOutcome(offboardingId)).toBe('skipped_shared_customer');
  });

  it('redacts when no other account shares the customer', async () => {
    const { updates, outcome } = await runGuard(null);

    expect(updates).toHaveLength(1);
    expect(outcome).toBe('redacted');
  });
});
