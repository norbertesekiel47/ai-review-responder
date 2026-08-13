// #773 admission chokepoint against a REAL postgres.js client and a real
// database. Mocks cannot cover this class: `max_pipeline: 0` — the first
// mitigation tried for the wedge — looked correct in every unit test and broke
// EVERY `sql.begin()` in production, because it short-circuits before
// postgres.js invokes `onexecute`, the only hook that binds a transaction to
// its connection. Anything that wraps this client has to prove transactions
// still commit against live Postgres, not against a stand-in.
//
// Wraps its OWN client rather than importing the `sql` singleton, so the suite
// tests the wrapper without pulling the app's pool into the test process.
// No DDL: it writes rows under a seeded tenant and removes them (#573).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  cleanupTenantAccount,
  seedTenantAccount,
  type TenantSeed,
} from '@/lib/shared/__tests__/live-db-tenant';
import { admissionStats, withAdmissionControl } from '../admission';

const testDatabaseUrl = resolveTestDatabaseUrl();

/** Deliberately tiny: the interesting behaviour only appears above the cap. */
const CAP = 2;

let raw: postgresType.Sql | undefined;
let gated: postgresType.Sql | undefined;
let tenant: TenantSeed | undefined;
const committedBusinessId = randomUUID();
const rolledBackBusinessId = randomUUID();

function sql(): postgresType.Sql {
  if (!gated) throw new Error('admission integration database was not initialized');
  return gated;
}

function accountId(): string {
  if (!tenant) throw new Error('admission integration tenant was not seeded');
  return tenant.accountId;
}

async function insertBusiness(tx: postgresType.TransactionSql, id: string, name: string): Promise<void> {
  await tx`
    INSERT INTO businesses (id, name, owner_name, owner_email, account_id, subscription_status)
    VALUES (${id}::uuid, ${name}, 'Admission Owner', ${tenant!.ownerEmail}, ${accountId()}::uuid, 'active')
  `;
}

describeWithDb(
  'db admission chokepoint against live Postgres (#773)',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
  beforeAll(async () => {
    assertLocalTestDatabaseUrl(testDatabaseUrl!);
    raw = postgres(testDatabaseUrl!, { max: CAP, prepare: false });
    gated = withAdmissionControl(raw, { cap: CAP, clientName: 'admission-integration' });
    // seedTenantAccount runs a deferred-constraints transaction — so the seed
    // itself is the first proof that `begin` survives the wrapper.
    tenant = await seedTenantAccount(sql(), {
      userName: 'Admission Owner',
      accountDisplayName: 'Admission Account',
    });
  });

  afterAll(async () => {
    if (gated && tenant) {
      await sql()`DELETE FROM businesses WHERE account_id = ${accountId()}::uuid`;
      await cleanupTenantAccount(sql(), tenant);
    }
    await raw?.end({ timeout: 5 });
  });

  it('sql.begin() still commits through the gate', async () => {
    const returned = await sql().begin(async (tx) => {
      await insertBusiness(tx, committedBusinessId, 'Admission Committed');
      // Same transaction => same snapshot timestamp. Proves these statements
      // ran inside ONE transaction on ONE connection, not as autocommitted
      // singles — the exact binding `max_pipeline: 0` destroyed.
      const [first] = await tx<{ t: Date }[]>`SELECT now() AS t`;
      const [second] = await tx<{ t: Date }[]>`SELECT now() AS t`;
      expect(second!.t.getTime()).toBe(first!.t.getTime());
      return 'committed';
    });

    expect(returned).toBe('committed');

    const rows = await sql()<{ id: string }[]>`
      SELECT id FROM businesses WHERE id = ${committedBusinessId}::uuid
    `;
    expect(rows).toHaveLength(1);
  });

  it('a failing transaction still rolls back through the gate', async () => {
    await expect(
      sql().begin(async (tx) => {
        await insertBusiness(tx, rolledBackBusinessId, 'Admission Rolled Back');
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    const rows = await sql()<{ id: string }[]>`
      SELECT id FROM businesses WHERE id = ${rolledBackBusinessId}::uuid
    `;
    expect(rows).toHaveLength(0);

    // The failed transaction released its slot.
    expect(admissionStats(sql())).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  it('serves far more concurrent callers than the pool without exceeding it', async () => {
    const CALLERS = 24;
    let observedPeak = 0;
    const sampler = setInterval(() => {
      const stats = admissionStats(sql());
      if (stats) observedPeak = Math.max(observedPeak, stats.inFlight);
    }, 5);

    try {
      const results = await Promise.all(
        Array.from(
          { length: CALLERS },
          (_, i) => sql()<{ n: number }[]>`SELECT ${i}::int AS n, pg_sleep(0.02)`,
        ),
      );
      expect(results).toHaveLength(CALLERS);
      expect(results.map((rows) => rows[0]!.n)).toEqual(
        Array.from({ length: CALLERS }, (_, i) => i),
      );
    } finally {
      clearInterval(sampler);
    }

    expect(observedPeak).toBeGreaterThan(0);
    expect(observedPeak).toBeLessThanOrEqual(CAP);
    expect(admissionStats(sql())).toMatchObject({ inFlight: 0, waiting: 0, timeouts: 0 });
  });

  it('a transaction running alongside a burst of queries does not deadlock', async () => {
    // The regression this whole design risks: a transaction holds a slot for
    // its duration while queued callers wait for one. If slots were counted per
    // QUERY rather than per connection, this hangs instead of finishing.
    const burst = Array.from(
      { length: 12 },
      () => sql()<{ ok: number }[]>`SELECT 1 AS ok, pg_sleep(0.01)`,
    );

    const transaction = sql().begin(async (tx) => {
      await tx`SELECT 1`;
      await tx`SELECT pg_sleep(0.05)`;
      await tx`SELECT 1`;
      return 'done';
    });

    await expect(Promise.all([transaction, ...burst])).resolves.toHaveLength(13);
    expect(admissionStats(sql())).toMatchObject({
      inFlight: 0,
      waiting: 0,
      timeouts: 0,
      reentrantBypasses: 0,
    });
  });
  },
);
