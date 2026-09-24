// Live proof of the #958 lane protocol, in two halves.
//
// 1. THE REAL LEASE. vitest's `integration` project holds the lane key shared
//    from its globalSetup (vitest.integration-lane.ts). The first block below
//    asserts, from a suite's own beforeAll and afterAll, that the lease is
//    GRANTED to the lane's session — acquisition-before-caller-hooks and
//    release-after-caller-afterAll, observed rather than assumed. It is a
//    top-level `describe.skipIf` block, NOT describeWithDb: the shape of the
//    onboarding-drip required-database sentinel, which a per-suite lease acquired
//    inside describeWithDb never covered.
//
// 2. TWO SESSIONS CONTENDING, on SCRATCH keys — never the real lane or suite
//    key, which this lane and its sibling suites hold: a held lease blocks an
//    exclusive provisioner and vice versa; the database-side timeout fires
//    before the client-side one; and the two-key split does not self-deadlock
//    where one key does.
//
// Advisory-lock calls and catalog reads only — no run-time DDL (#573).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  acquireLaneLease,
  expectedProvisionHash,
  LaneLeaseTimeoutError,
  openPostgresLeaseSession,
  type LaneLease,
} from '@/lib/shared/__tests__/helpers/live-db-lane';

const testDatabaseUrl = resolveTestDatabaseUrl();
const lane = inject('liveDbLane');

/** Rows of pg_locks proving `applicationName`'s session holds a SHARED advisory lock on `key`. */
async function grantedSharedHolds(
  db: postgresType.Sql,
  key: string,
  applicationName: string,
): Promise<number> {
  // A bigint advisory key is split across classid (high 32 bits) and objid
  // (low 32 bits), objsubid 1; hashtext() is int4, so the low half is enough.
  const [row] = await db<{ holds: number }[]>`
    SELECT count(*)::int AS holds
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory'
      AND l.objsubid = 1
      AND l.objid::bigint = (hashtext(${key})::bigint & 4294967295)
      AND l.mode = 'ShareLock'
      AND l.granted
      AND a.application_name = ${applicationName}
  `;
  return row?.holds ?? 0;
}

describe.skipIf(lane === null)('#958 the lane lease spans every caller hook', () => {
  let probe: postgresType.Sql | undefined;

  beforeAll(async () => {
    probe = postgres(assertLocalTestDatabaseUrl(testDatabaseUrl), { max: 1, prepare: false });
    // Acquisition-before-caller-hooks: granted before this beforeAll ran.
    expect(await grantedSharedHolds(probe, lane!.lockKey, lane!.applicationName)).toBe(1);
  }, 30_000);

  afterAll(async () => {
    try {
      // Release-after-caller-afterAll: still granted while this afterAll runs.
      expect(await grantedSharedHolds(probe!, lane!.lockKey, lane!.applicationName)).toBe(1);
    } finally {
      await probe?.end({ timeout: 5 });
    }
  }, 30_000);

  it('the lane session holds the lane key SHARED while tests run', async () => {
    expect(await grantedSharedHolds(probe!, lane!.lockKey, lane!.applicationName)).toBe(1);
  });
});

describeWithDb(
  '#958 lane protocol — two sessions contending (scratch keys)',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    const scratchLane = `repworth_958_lane_${randomUUID()}`;
    const scratchSuite = `repworth_958_suite_${randomUUID()}`;
    let provisioner: postgresType.Sql | undefined;
    let suite: postgresType.Sql | undefined;
    let databaseUrl = '';
    const leases: LaneLease[] = [];

    function lease(overrides: { acquisitionTimeoutMs?: number; hookTimeoutMs?: number } = {}) {
      const acquisitionTimeoutMs = overrides.acquisitionTimeoutMs ?? 20_000;
      return acquireLaneLease({
        lockKey: scratchLane,
        applicationName: `repworth_958_lease_${randomUUID().slice(0, 8)}`,
        acquisitionTimeoutMs,
        hookTimeoutMs: overrides.hookTimeoutMs ?? acquisitionTimeoutMs + 10_000,
        // The lane already validated the real marker; the scratch lease reads
        // the same one, so it must match too.
        expectedHash: expectedProvisionHash(),
        open: (applicationName) =>
          openPostgresLeaseSession(databaseUrl, applicationName, acquisitionTimeoutMs),
      }).then((held) => {
        leases.push(held);
        return held;
      });
    }

    beforeAll(() => {
      databaseUrl = assertLocalTestDatabaseUrl(testDatabaseUrl);
      provisioner = postgres(databaseUrl, { max: 1, prepare: false });
      suite = postgres(databaseUrl, { max: 1, prepare: false });
    }, 30_000);

    afterAll(async () => {
      // Never leak a scratch hold into the sibling suites of this lane.
      for (const held of leases) await held.release().catch(() => undefined);
      for (const client of [provisioner, suite]) {
        if (!client) continue;
        await client`SELECT pg_advisory_unlock_all()`;
        await client.end({ timeout: 5 });
      }
    }, 30_000);

    it('a held lane lease makes an exclusive provisioner WAIT, and releasing it lets the provisioner in', async () => {
      const held = await lease();
      const [blocked] = await provisioner!`
        SELECT pg_try_advisory_lock(hashtext(${scratchLane})) AS acquired
      `;
      expect(blocked?.acquired).toBe(false);

      const waiting = provisioner!`SELECT pg_advisory_lock(hashtext(${scratchLane}))`.then(() => 'granted');
      const early = await Promise.race([
        waiting,
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500)),
      ]);
      expect(early).toBe('still waiting');

      await held.release();
      await expect(waiting).resolves.toBe('granted');
      await provisioner!`SELECT pg_advisory_unlock(hashtext(${scratchLane}))`;
    });

    it('a running provisioner makes a new lane lease WAIT until it finishes', async () => {
      await provisioner!`SELECT pg_advisory_lock(hashtext(${scratchLane}))`;
      let settled = false;
      const pending = lease().then((held) => {
        settled = true;
        return held;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      await provisioner!`SELECT pg_advisory_unlock(hashtext(${scratchLane}))`;
      const held = await pending;
      expect(held.lockKey).toBe(scratchLane);
      await held.release();
    });

    it('the DATABASE-side timeout fires first and closes the session — no lease leaks', async () => {
      await provisioner!`SELECT pg_advisory_lock(hashtext(${scratchLane}))`;
      try {
        const error = await lease({ acquisitionTimeoutMs: 300, hookTimeoutMs: 5_000 }).catch(
          (caught: unknown) => caught,
        );
        expect(error).not.toBeInstanceOf(LaneLeaseTimeoutError);
        expect((error as { code?: string }).code).toBe('57014');
      } finally {
        await provisioner!`SELECT pg_advisory_unlock(hashtext(${scratchLane}))`;
      }
      // Its session is gone, so nothing is left waiting on or holding the key.
      const [row] = await provisioner!<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${scratchLane})) AS acquired
      `;
      expect(row?.acquired).toBe(true);
      await provisioner!`SELECT pg_advisory_unlock(hashtext(${scratchLane}))`;
    });

    it('TWO keys: a suite takes its key exclusive under its own lane lease, while provisioning waits for both', async () => {
      const held = await lease();
      // A suite inside the lane — a different session of the same process —
      // gets the suite key at once: nothing inside a lane holds it shared.
      const [suiteRow] = await suite!<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext(${scratchSuite})) AS acquired
      `;
      expect(suiteRow?.acquired).toBe(true);

      // Provisioning takes lane key, then suite key; it queues on the first.
      const provisioning = (async () => {
        await provisioner!`SELECT pg_advisory_lock(hashtext(${scratchLane}))`;
        await provisioner!`SELECT pg_advisory_lock(hashtext(${scratchSuite}))`;
        return 'provisioned';
      })();
      const early = await Promise.race([
        provisioning,
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500)),
      ]);
      expect(early).toBe('still waiting');

      await suite!`SELECT pg_advisory_unlock(hashtext(${scratchSuite}))`;
      await held.release();
      await expect(provisioning).resolves.toBe('provisioned');
      await provisioner!`SELECT pg_advisory_unlock(hashtext(${scratchSuite}))`;
      await provisioner!`SELECT pg_advisory_unlock(hashtext(${scratchLane}))`;
    });

    it('ONE key would self-deadlock: a suite asking exclusive on the key its own lane holds shared waits out its timeout', async () => {
      const held = await lease();
      await suite!`SET statement_timeout = '300ms'`;
      try {
        await expect(
          suite!`SELECT pg_advisory_lock(hashtext(${scratchLane}))`,
        ).rejects.toMatchObject({ code: '57014' });
      } finally {
        await suite!`RESET statement_timeout`;
        await held.release();
      }
    });
  },
);
