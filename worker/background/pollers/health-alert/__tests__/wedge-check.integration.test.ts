// #773 wedge alert against live Postgres.
//
// A mock cannot validate this check at all: its whole body is a
// `pg_stat_activity` predicate over `state`, `wait_event`, `clock_timestamp()`
// and `make_interval(secs => $1)`. A stubbed `sql` returns whatever the test
// pushes regardless of whether that SQL is even executable.
//
// The second case is the one that matters. `wait_event='ClientRead'` with a
// GROWING age is not by itself a wedge — an ordinary open transaction sitting
// between statements looks exactly like that, and the pooler keeps such
// sessions around constantly. Only `state='active'` makes it the #773
// signature. So this suite parks a real idle-in-transaction session, lets its
// age exceed the threshold, and asserts the check stays quiet: if the `state`
// filter were ever dropped, the alert would fire on healthy traffic and be
// muted within a day.
//
// No DDL: reads a catalog view and holds one transaction (#573).

import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  assertLocalTestDatabaseUrl,
  resolveTestDatabaseUrl,
} from '@/lib/shared/__tests__/helpers/live-db-lock';
import {
  checkWedgedClientRead,
  resolveHealthAlertConfig,
  WEDGED_CLIENT_READ_AGE_DEFAULT_S,
  type HealthAlertConfig,
} from '../checks';

const testDatabaseUrl = resolveTestDatabaseUrl();

let probe: postgresType.Sql | undefined;
let holder: postgresType.Sql | undefined;

function sql(): postgresType.Sql {
  if (!probe) throw new Error('wedge-check integration database was not initialized');
  return probe;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

describeWithDb(
  'checkWedgedClientRead against live Postgres (#773)',
  { enabled: Boolean(testDatabaseUrl), timeout: 60_000 },
  () => {
    let cfg: HealthAlertConfig;

    beforeAll(() => {
      assertLocalTestDatabaseUrl(testDatabaseUrl!);
      probe = postgres(testDatabaseUrl!, { max: 1, prepare: false });
      holder = postgres(testDatabaseUrl!, { max: 1, prepare: false });
      cfg = resolveHealthAlertConfig();
    });

    afterAll(async () => {
      await Promise.allSettled([probe?.end({ timeout: 5 }), holder?.end({ timeout: 5 })]);
    });

    it('executes against a real pg_stat_activity and returns a well-formed quiet result', async () => {
      // Default 10s threshold on an idle local database: nothing is wedged, so
      // the check must be silent. Reaching this line at all proves the predicate
      // is valid SQL on real Postgres.
      expect(cfg.wedgedClientReadAgeS).toBe(WEDGED_CLIENT_READ_AGE_DEFAULT_S);
      expect(await checkWedgedClientRead(sql(), cfg)).toBeNull();
    });

    it('does NOT fire on an idle-in-transaction session, however old its ClientRead wait', async () => {
      let release!: () => void;
      const held = holder!.begin(async (tx) => {
        await tx`SELECT 1`;
        // Parked between statements: state='idle in transaction',
        // wait_event='ClientRead', age climbing past the threshold below.
        await new Promise<void>((resolve) => { release = resolve; });
      });

      try {
        await sleep(2500);

        // Sanity: the session really is parked in ClientRead with an age over
        // the threshold, so the next assertion is not vacuous.
        const [parked] = await sql()<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND state = 'idle in transaction'
            AND wait_event = 'ClientRead'
            AND clock_timestamp() - state_change > interval '1 second'
        `;
        expect(parked!.count).toBeGreaterThan(0);

        // The check itself, at a threshold this session's age clears easily.
        // Quiet, because it is not state='active'.
        expect(await checkWedgedClientRead(sql(), { ...cfg, wedgedClientReadAgeS: 1 })).toBeNull();
      } finally {
        release();
        await held;
      }
    });
  },
);
