import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgresType from 'postgres';

// ─────────────────────────────────────────────────────────────────────────────
// The account daily send cap, as a PROPERTY rather than as three examples
// (#900 task 0, the eval task).
//
// Registered with `it.fails` and carrying a complete body: `runReleaseCycle`
// throws `not implemented` today, and `.fails` runs the body, so the fake
// executor and every arbitrary below are exercised from this commit onward.
// Task 3 deletes the marker.
//
// WHY A FAKE EXECUTOR AND NOT THE LIVE DATABASE. The cap's COUNTING BASIS and
// its UTC-day boundary are live-DB facts and are proved in
// `send-caps.integration.test.ts`. What is left — and what no example test can
// reach — is the ARITHMETIC across an arbitrary sequence of ticks: three
// counters (the per-tick budget, the platform remainder, that account's
// remainder) must each decrement on EVERY successful release, not once per
// tick (round-1 finding 11). A single check at the top of the phase lets a
// budget-two tick overrun a cap with one slot left, and that overrun is only
// visible over a sequence. Driving hundreds of generated sequences against real
// Postgres would be minutes per run; the in-memory model is milliseconds.
//
// The fake routes on the shape of each statement and returns EMPTY for anything
// it does not recognise, so the three sweeps and the backstop are no-ops here.
// The non-vacuity assertion below is what keeps a mis-routed CAS from passing:
// the property asserts not only that the cap is never exceeded but that exactly
// the available capacity IS released, so a fake that never matched would fail
// rather than pass trivially.
// ─────────────────────────────────────────────────────────────────────────────

/** The in-memory account the fake executor speaks for. One batch, N rendered rows. */
interface ReleaseModel {
  accountId: string;
  businessId: string;
  batchId: string;
  /** Outreach ids still `rendered`, oldest first. */
  rendered: string[];
  /** Outreach ids this run moved `rendered` → `queued`, in order. */
  queued: string[];
  /** Dispatch attempts in the current UTC day, the cap's counting basis. */
  attemptsToday: number;
  /** `auto_approval_policies.daily_send_cap` for the account. */
  configuredCap: number;
  sendingStartedAt: Date | null;
}

const spies = vi.hoisted(() => ({
  countAccountDispatchAttemptsToday: vi.fn(),
  countPlatformDispatchAttemptsToday: vi.fn(),
  readSendBreaker: vi.fn(),
  solicitationSendEnabled: vi.fn(),
  isJudgeHealthy: vi.fn(),
  judgeEnabled: vi.fn(),
  enqueueSolicitationSend: vi.fn(),
}));

// The two COUNTERS are stubbed (they are the live-DB seam); the two RESOLVERS
// — `resolveAccountDailySendCap` and `resolvePlatformDailyCap` — stay REAL,
// because the LEAST(configured, 10) dial and the fail-closed platform parse are
// exactly the arithmetic this property is about.
vi.mock('../send-caps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../send-caps')>();
  return {
    ...actual,
    countAccountDispatchAttemptsToday: spies.countAccountDispatchAttemptsToday,
    countPlatformDispatchAttemptsToday: spies.countPlatformDispatchAttemptsToday,
  };
});

vi.mock('../send-breaker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../send-breaker')>();
  return { ...actual, readSendBreaker: spies.readSendBreaker };
});

vi.mock('../flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flags')>();
  return { ...actual, solicitationSendEnabled: spies.solicitationSendEnabled };
});

vi.mock('@/lib/responses/judge-health', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/responses/judge-health')>();
  return { ...actual, isJudgeHealthy: spies.isJudgeHealthy };
});

vi.mock('@/lib/responses/judge-flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/responses/judge-flags')>();
  return { ...actual, judgeEnabled: spies.judgeEnabled };
});

vi.mock('@/lib/shared/job-outbox-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/job-outbox-helpers')>();
  return { ...actual, enqueueSolicitationSend: spies.enqueueSolicitationSend };
});

import { DEFAULT_DAILY_SEND_CAP_ACCOUNT } from '../send-caps';
import {
  RELEASE_PER_TICK_BUDGET,
  RELEASE_SCAN_LIMIT,
  runReleaseCycle,
  type ReleaseCycleReport,
} from '../release';

/**
 * A `postgres.Sql` stand-in that answers the release phase's statements from
 * `model` and returns EMPTY for everything else.
 *
 * Routing is on the DISTINCTIVE fragment of each statement, never on an exact
 * string: the candidate scan is the only `solicitation_batches` SELECT that
 * mentions `'rendered'`, the locked re-read is the only one that mentions
 * `FOR UPDATE`, and the release CAS is the only `UPDATE solicitation_outreach`
 * that mentions `'queued'`. An unrecognised statement resolving to `[]` is the
 * right default here — it is what an empty table returns — and the property's
 * non-vacuity assertion is what catches a route that stopped matching.
 */
function createFakeExecutor(model: ReleaseModel): postgresType.Sql {
  const run = (text: string): unknown[] => {
    const sql = text.replace(/\s+/g, ' ');

    if (sql.includes('solicitation_batches') && sql.includes('FOR UPDATE')) {
      return [batchRow(model)];
    }
    if (sql.includes('FROM solicitation_batches') && sql.includes("'rendered'")) {
      return model.rendered.length > 0 ? [batchRow(model)] : [];
    }
    if (sql.includes('FROM solicitation_outreach') && sql.includes("'rendered'")) {
      return model.rendered.slice(0, RELEASE_SCAN_LIMIT).map((id) => ({
        id,
        account_id: model.accountId,
        business_id: model.businessId,
        batch_id: model.batchId,
      }));
    }
    if (sql.includes('UPDATE solicitation_outreach') && sql.includes("'queued'")) {
      const next = model.rendered.shift();
      if (next === undefined) return [];
      model.queued.push(next);
      model.attemptsToday += 1;
      return [{ id: next }];
    }
    if (sql.includes('UPDATE solicitation_batches') && sql.includes('sending_started_at')) {
      if (model.sendingStartedAt !== null) return [];
      model.sendingStartedAt = new Date();
      return [{ id: model.batchId }];
    }
    if (sql.includes('FROM auto_approval_policies')) {
      return [{
        account_id: model.accountId,
        location_id: null,
        persona: 'solicitation',
        action_class: 'sending',
        daily_send_cap: model.configuredCap,
        veto_window_minutes: 30,
      }];
    }
    if (sql.includes('FROM accounts')) {
      return [{ id: model.accountId, subscription_status: 'active' }];
    }
    return [];
  };

  const tag = (strings: TemplateStringsArray | string[], ...values: unknown[]): unknown => {
    void values;
    return Promise.resolve(run(Array.from(strings).join(' ? ')));
  };

  const executor = tag as unknown as Record<string, unknown>;
  executor.json = (value: unknown) => value;
  executor.unsafe = (text: string) => Promise.resolve(run(text));
  executor.begin = (...args: unknown[]): Promise<unknown> => {
    const callback = args[args.length - 1] as (tx: postgresType.TransactionSql) => Promise<unknown>;
    return Promise.resolve(callback(executor as unknown as postgresType.TransactionSql));
  };
  executor.savepoint = executor.begin;
  return executor as unknown as postgresType.Sql;
}

function batchRow(model: ReleaseModel): Record<string, unknown> {
  return {
    id: model.batchId,
    account_id: model.accountId,
    business_id: model.businessId,
    approved_at: new Date(Date.now() - 60 * 60_000),
    approval_method: 'owner',
    approved_by_user_id: 'owner-user',
    veto_deadline_at: new Date(Date.now() - 45 * 60_000),
    sending_started_at: model.sendingStartedAt,
    send_closed_at: null,
    halted_at: null,
    halt_reason: null,
    built_at: new Date(Date.now() - 2 * 60 * 60_000),
    send_parent_run_id: 'send-parent-run',
  };
}

function newModel(configuredCap: number, alreadyToday: number, candidates: number): ReleaseModel {
  return {
    accountId: 'account-under-cap',
    businessId: 'business-under-cap',
    batchId: 'batch-under-cap',
    rendered: Array.from({ length: candidates }, (_, index) => `outreach-${index + 1}`),
    queued: [],
    attemptsToday: alreadyToday,
    configuredCap,
    sendingStartedAt: null,
  };
}

describe('runReleaseCycle vocabulary', () => {
  it('pins the drip pacing lever and the per-phase scan bound', () => {
    // Both are read by the poller's header comment and by the staging ramp, so
    // a change to either is a decision, not an implementation detail.
    expect(RELEASE_PER_TICK_BUDGET).toBe(2);
    expect(RELEASE_SCAN_LIMIT).toBe(50);
  });
});

// Property tests (fast-check): the house style for invariant-level coverage.
describe('runReleaseCycle invariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spies.solicitationSendEnabled.mockReturnValue(true);
    spies.readSendBreaker.mockResolvedValue({ open: false, trip: null });
    spies.judgeEnabled.mockReturnValue(true);
    spies.isJudgeHealthy.mockResolvedValue(true);
    spies.countPlatformDispatchAttemptsToday.mockResolvedValue(0);
    spies.enqueueSolicitationSend.mockImplementation(() => Promise.resolve('outbox-id'));
    // Platform headroom far above anything the arbitraries generate, so the
    // ONLY binding governor in this property is the account cap.
    process.env.SOLICITATION_PLATFORM_DAILY_CAP = '100000';
  });

  afterEach(() => {
    delete process.env.SOLICITATION_PLATFORM_DAILY_CAP;
  });

  it.fails(
    'property: the account daily send cap is never exceeded across arbitrary release sequences',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            // 1..50 is the schema CHECK's range; the resolver's job is to make
            // anything above the platform default harmless, so the arbitrary
            // deliberately generates values on both sides of 10.
            configuredCap: fc.integer({ min: 1, max: 20 }),
            alreadyToday: fc.integer({ min: 0, max: 14 }),
            candidates: fc.integer({ min: 0, max: 8 }),
            perTickBudget: fc.integer({ min: 1, max: 4 }),
            ticks: fc.integer({ min: 1, max: 5 }),
          }),
          async ({ configuredCap, alreadyToday, candidates, perTickBudget, ticks }) => {
            const model = newModel(configuredCap, alreadyToday, candidates);
            const exec = createFakeExecutor(model);
            spies.countAccountDispatchAttemptsToday.mockImplementation(() =>
              Promise.resolve(model.attemptsToday),
            );

            const reports: ReleaseCycleReport[] = [];
            for (let tick = 0; tick < ticks; tick += 1) {
              reports.push(await runReleaseCycle(exec, { perTickBudget }));
            }

            // The dial moves toward RESTRAINT only: an admin storing 20 is
            // capped at the platform default, never granted it.
            const effectiveCap = Math.min(configuredCap, DEFAULT_DAILY_SEND_CAP_ACCOUNT);
            const remaining = Math.max(0, effectiveCap - alreadyToday);
            const released = model.queued.length;

            // THE INVARIANT. Whatever the ordering of ticks and budgets, the
            // account's dispatch attempts for the UTC day never cross the cap —
            // and an account already over it releases nothing at all.
            expect(released).toBeLessThanOrEqual(remaining);
            expect(model.attemptsToday).toBeLessThanOrEqual(Math.max(alreadyToday, effectiveCap));

            // NON-VACUITY, and it is what stops a fake that stopped matching
            // from passing this property trivially: the cycle must release
            // EXACTLY the capacity available to it — no more (the cap), and no
            // less (the per-tick budget must carry the remainder forward, never
            // drop it).
            expect(released).toBe(Math.min(candidates, remaining, perTickBudget * ticks));
            expect(reports.reduce((total, report) => total + report.released, 0)).toBe(released);
            // Every released id is distinct: no row is released twice across ticks.
            expect(new Set(model.queued).size).toBe(released);
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});
