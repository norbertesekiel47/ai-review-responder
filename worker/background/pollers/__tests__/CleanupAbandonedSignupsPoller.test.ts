// worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts
//
// Unit tests for CleanupAbandonedSignupsPoller.
//
// Mocks sql (Postgres.js tagged-template) and supabaseServer.auth.admin.deleteUser.
// Exercises runOnce() end-to-end for every branch + verifies startXxxPoller
// respects the SELF_SERVE_SIGNUP_ENABLED flag.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// 1. Hoist mutable state so vi.mock factories can close over it.
// ---------------------------------------------------------------------------
const {
  sqlQueue,
  sqlCalls,
  consume,
  beginCalls,
  mockSupabaseDeleteUser,
  mockLoggerLog,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => {
  const sqlQueue: unknown[] = [];
  const sqlCalls: Array<{ template: string; values: unknown[] }> = [];
  const consume = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ template: strings.join('?'), values });
    const next = sqlQueue.shift();
    return Promise.resolve(Array.isArray(next) ? next : []);
  });

  const beginCalls: number[] = [];
  const mockSupabaseDeleteUser = vi.fn();
  const mockLoggerLog = vi.fn();
  const mockLoggerWarn = vi.fn();
  const mockLoggerError = vi.fn();

  return {
    sqlQueue,
    sqlCalls,
    consume,
    beginCalls,
    mockSupabaseDeleteUser,
    mockLoggerLog,
    mockLoggerWarn,
    mockLoggerError,
  };
});

// ---------------------------------------------------------------------------
// 2. Module-level mocks (MUST precede import of module-under-test).
// ---------------------------------------------------------------------------
vi.mock('@/lib/db/server', () => {
  const sql = Object.assign(consume, {
    begin: vi.fn(async (fn: (tx: typeof consume) => Promise<unknown>) => {
      beginCalls.push(Date.now());
      return fn(consume);
    }),
  });
  return {
    sql,
    supabaseServer: {
      auth: {
        admin: {
          deleteUser: mockSupabaseDeleteUser,
        },
      },
    },
  };
});

vi.mock('@/lib/shared/logger', () => ({
  createWorkerLogger: () => ({
    log: mockLoggerLog,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  }),
}));

// ---------------------------------------------------------------------------
// 3. Import AFTER mocks.
// ---------------------------------------------------------------------------
import {
  runOnce,
  startCleanupAbandonedSignupsPoller,
  stopCleanupAbandonedSignupsPoller,
} from '../CleanupAbandonedSignupsPoller';

// ---------------------------------------------------------------------------
// 4. Helpers.
// ---------------------------------------------------------------------------
type Candidate = {
  user_id: string;
  owner_email: string;
  auth_id: string;
};

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    user_id: overrides.user_id ?? 'user-1',
    owner_email: overrides.owner_email ?? 'owner@example.com',
    auth_id: overrides.auth_id ?? 'auth-1',
  };
}

/**
 * Seed the rows for a "clean" (no refs) candidate. The tx now does:
 *   1. pg_advisory_xact_lock(:signup)
 *   2. SELECT users ... FOR UPDATE       (re-validate role + auth_id + account_id)
 *   3. SELECT EXISTS refs                (no orphan-FK collisions)
 *   4. supabase.auth.admin.deleteUser    (mocked separately)
 *   5. DELETE FROM onboarding_demos
 *   6. DELETE FROM users
 *
 * Caller still provides the candidates list as the first queued row.
 */
function seedCleanCandidateRows() {
  const oldEnough = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  sqlQueue.push([{}]); // pg_advisory_xact_lock(:signup)
  sqlQueue.push([{ auth_id: 'auth-1', role: 'owner', account_id: null, created_at: oldEnough }]); // SELECT users FOR UPDATE
  sqlQueue.push([{ has_onboarded: false, has_prospect_demos: false }]); // refs check
  sqlQueue.push([]); // DELETE FROM onboarding_demos (PR #2 explicit cascade)
  sqlQueue.push([]); // DELETE FROM users
}

function seedRefsCollisionRows(has_onboarded: boolean, has_prospect_demos: boolean) {
  const oldEnough = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  sqlQueue.push([{}]); // pg_advisory_xact_lock(:signup)
  sqlQueue.push([{ auth_id: 'auth-1', role: 'owner', account_id: null, created_at: oldEnough }]); // SELECT users FOR UPDATE
  sqlQueue.push([{ has_onboarded, has_prospect_demos }]); // refs check — skip branch
}

beforeEach(() => {
  sqlQueue.length = 0;
  sqlCalls.length = 0;
  beginCalls.length = 0;
  consume.mockClear();
  mockSupabaseDeleteUser.mockReset();
  mockLoggerLog.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerError.mockClear();
  delete process.env.CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE;
  delete process.env.CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS;
  delete process.env.SELF_SERVE_SIGNUP_ENABLED;
  // The poller now runs a top-of-loop "DELETE stale onboarding_demos" query
  // (Task 15 PR #2). Seed an empty result so the first sqlQueue.shift() goes
  // to that query and downstream candidate/seed pushes line up correctly.
  // sqlCalls[0] will be the stale-cleanup DELETE; sqlCalls[1] will be the
  // candidates SELECT.
  sqlQueue.push([]);
});

afterEach(() => {
  stopCleanupAbandonedSignupsPoller();
});

// ---------------------------------------------------------------------------
// 5. Tests.
// ---------------------------------------------------------------------------

describe('CleanupAbandonedSignupsPoller', () => {
  describe('runOnce', () => {
    it('empty candidate list: no-op, logs 0 deleted', async () => {
      sqlQueue.push([]); // candidates query

      await runOnce();

      expect(mockSupabaseDeleteUser).not.toHaveBeenCalled();
      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(logCall).toBeDefined();
      expect(logCall![1]).toMatchObject({ candidates: 0, deleted: 0 });
    });

    it('self-serve candidate with no refs: advisory lock, supabase delete, users delete', async () => {
      sqlQueue.push([makeCandidate()]); // candidates query
      seedCleanCandidateRows();
      mockSupabaseDeleteUser.mockResolvedValueOnce({ data: null, error: null });

      await runOnce();

      // Advisory lock was requested with hashtext(email+':signup')
      const lockCall = sqlCalls.find((c) => c.template.includes('pg_advisory_xact_lock'));
      expect(lockCall).toBeDefined();
      expect(lockCall!.values).toContain('owner@example.com:signup');

      // Refs check query — Task 15 (PR #2) renamed `has_demos` → `has_prospect_demos`.
      const refsCall = sqlCalls.find(
        (c) =>
          c.template.includes('has_onboarded') &&
          c.template.includes('has_prospect_demos'),
      );
      expect(refsCall).toBeDefined();

      // Supabase deleteUser called with the auth_id
      expect(mockSupabaseDeleteUser).toHaveBeenCalledOnce();
      expect(mockSupabaseDeleteUser).toHaveBeenCalledWith('auth-1');

      // DELETE FROM users was issued
      const deleteUsersIdx = sqlCalls.findIndex(
        (c) => c.template.includes('DELETE FROM users'),
      );
      expect(deleteUsersIdx).toBeGreaterThanOrEqual(0);

      // No DELETE FROM businesses (abandoned signups have no account, no business to delete)
      const deleteBusinessesIdx = sqlCalls.findIndex(
        (c) => c.template.includes('DELETE FROM businesses'),
      );
      expect(deleteBusinessesIdx).toBeLessThan(0);

      // Run-complete log records 1 deleted
      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(logCall![1]).toMatchObject({ deleted: 1, skipped_refs: 0 });
    });

    it('candidates SQL filter enforces abandoned-signup scope (no account + auth_id IS NOT NULL)', async () => {
      sqlQueue.push([]); // candidates query — empty result fine for template-assertion

      await runOnce();

      // Candidates SELECT is now sqlCalls[1] — sqlCalls[0] is the
      // top-of-loop stale-onboarding-demos DELETE (Task 15 PR #2).
      const candidatesCall = sqlCalls.find((c) =>
        c.template.includes('SELECT u.id AS user_id'),
      );
      expect(candidatesCall).toBeDefined();
      expect(candidatesCall!.template).toContain('auth_id IS NOT NULL');
      expect(candidatesCall!.template).toContain('a.id IS NULL');
      expect(candidatesCall!.template).toContain("INTERVAL '7 days'");
      // LEFT JOIN accounts is used instead of reading businesses.subscription_status
      expect(candidatesCall!.template).toContain('LEFT JOIN accounts a ON a.owner_user_id = u.id');

      // Stale-cleanup DELETE was the very first query.
      const staleCall = sqlCalls.find((c) =>
        c.template.includes('DELETE FROM onboarding_demos') &&
        c.template.includes("generation_status = 'completed'"),
      );
      expect(staleCall).toBeDefined();
    });

    it('candidate with has_onboarded=true refs: skipped, warn logged, no DB delete, no supabase delete', async () => {
      sqlQueue.push([makeCandidate()]); // candidates query
      seedRefsCollisionRows(true, false);

      await runOnce();

      expect(mockSupabaseDeleteUser).not.toHaveBeenCalled();

      // No DELETE issued
      const deleteUsers = sqlCalls.find((c) => c.template.includes('DELETE FROM users'));
      expect(deleteUsers).toBeUndefined();

      expect(mockLoggerWarn).toHaveBeenCalled();
      const warnCall = mockLoggerWarn.mock.calls.find((args) =>
        String(args[0]).includes('Skipping'),
      );
      expect(warnCall).toBeDefined();

      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(logCall![1]).toMatchObject({ skipped_refs: 1, deleted: 0 });
    });

    it('candidate with has_demos=true refs: skipped, warn logged', async () => {
      sqlQueue.push([makeCandidate()]);
      seedRefsCollisionRows(false, true);

      await runOnce();

      expect(mockSupabaseDeleteUser).not.toHaveBeenCalled();
      const deleteUsers = sqlCalls.find((c) => c.template.includes('DELETE FROM users'));
      expect(deleteUsers).toBeUndefined();

      expect(mockLoggerWarn).toHaveBeenCalled();
      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(logCall![1]).toMatchObject({ skipped_refs: 1 });
    });

    // TOCTOU regression guard — without the FOR UPDATE re-check inside the tx,
    // an account creation between SELECT and DELETE would delete a paid
    // customer's user. This test simulates that race: the candidate list
    // contains the row, but by the time the tx acquires its locks the user
    // has an account_id set (account was created mid-cycle). Expect: no DELETE,
    // no Supabase admin call, run-complete log shows skipped_state_changed=1.
    it('TOCTOU: state changed (account created) between SELECT and tx — skipped, no delete', async () => {
      sqlQueue.push([makeCandidate()]); // candidates query
      sqlQueue.push([{}]); // pg_advisory_xact_lock(:signup)
      // SELECT users FOR UPDATE returns the row but with account_id populated.
      sqlQueue.push([{
        auth_id: 'auth-1',
        role: 'owner',
        account_id: 'acct-new', // ← Account created mid-cycle
        created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      }]);

      await runOnce();

      // Critical: no Supabase admin delete must fire — that would destroy a
      // paying customer's auth user.
      expect(mockSupabaseDeleteUser).not.toHaveBeenCalled();

      // Critical: no DB DELETE either.
      const deleteUsers = sqlCalls.find((c) =>
        c.template.includes('DELETE FROM users'),
      );
      expect(deleteUsers).toBeUndefined();

      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(logCall![1]).toMatchObject({ skipped_state_changed: 1, deleted: 0 });
    });

    it('TOCTOU: user auth_id changed between SELECT and tx — skipped', async () => {
      sqlQueue.push([makeCandidate()]);
      sqlQueue.push([{}]); // pg_advisory_xact_lock(:signup)
      sqlQueue.push([{
        auth_id: 'auth-different', // ← auth_id was changed
        role: 'owner',
        account_id: null,
        created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      }]);

      await runOnce();

      expect(mockSupabaseDeleteUser).not.toHaveBeenCalled();
      const deleteUsers = sqlCalls.find((c) =>
        c.template.includes('DELETE FROM users'),
      );
      expect(deleteUsers).toBeUndefined();
      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(logCall![1]).toMatchObject({ skipped_state_changed: 1 });
    });

    it('TOCTOU: user row vanished between SELECT and tx — skipped (cleanly), no delete', async () => {
      sqlQueue.push([makeCandidate()]);
      sqlQueue.push([{}]); // pg_advisory_xact_lock(:signup)
      sqlQueue.push([]); // SELECT users FOR UPDATE returns NO row

      await runOnce();

      expect(mockSupabaseDeleteUser).not.toHaveBeenCalled();
      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(logCall![1]).toMatchObject({ skipped_state_changed: 1 });
    });

    it('Supabase 404: treated as success, proceeds to DB delete', async () => {
      sqlQueue.push([makeCandidate()]);
      seedCleanCandidateRows();
      mockSupabaseDeleteUser.mockResolvedValueOnce({
        data: null,
        error: { message: 'User not_found', status: 404 } as any,
      });

      await runOnce();

      // DB delete still ran despite the 404
      const deleteUsers = sqlCalls.find((c) => c.template.includes('DELETE FROM users'));
      expect(deleteUsers).toBeDefined();

      // No businesses to delete (abandoned signups have no account)
      const deleteBizzes = sqlCalls.find((c) => c.template.includes('DELETE FROM businesses'));
      expect(deleteBizzes).toBeUndefined();

      // Counted as deleted
      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(logCall![1]).toMatchObject({ deleted: 1 });
    });

    it('Supabase non-404 error: tx rolls back, error logged, loop continues to next candidate', async () => {
      sqlQueue.push([
        makeCandidate({ user_id: 'user-1', auth_id: 'auth-1', owner_email: 'a@e.com' }),
        makeCandidate({ user_id: 'user-2', auth_id: 'auth-2', owner_email: 'b@e.com' }),
      ]);
      const oldEnough = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      // Candidate 1: passes TOCTOU re-check, refs check, then supabase ERRORS.
      sqlQueue.push([{}]); // pg_advisory_xact_lock(:signup) (candidate 1)
      sqlQueue.push([{ auth_id: 'auth-1', role: 'owner', account_id: null, created_at: oldEnough }]); // SELECT users FOR UPDATE
      sqlQueue.push([{ has_onboarded: false, has_prospect_demos: false }]); // refs check
      mockSupabaseDeleteUser.mockResolvedValueOnce({
        data: null,
        error: { message: 'permission denied', status: 403 } as any,
      });
      // Candidate 2: clean path succeeds
      sqlQueue.push([{}]); // pg_advisory_xact_lock(:signup) (candidate 2)
      sqlQueue.push([{ auth_id: 'auth-2', role: 'owner', account_id: null, created_at: oldEnough }]); // SELECT users FOR UPDATE (candidate 2)
      sqlQueue.push([{ has_onboarded: false, has_prospect_demos: false }]); // refs check
      sqlQueue.push([]); // DELETE FROM onboarding_demos (PR #2 explicit cascade)
      sqlQueue.push([]); // DELETE users
      mockSupabaseDeleteUser.mockResolvedValueOnce({ data: null, error: null });

      await runOnce();

      // Error logged for candidate 1
      expect(mockLoggerError).toHaveBeenCalled();
      const errorCall = mockLoggerError.mock.calls.find((args) =>
        String(args[0]).includes('Cleanup tx failed'),
      );
      expect(errorCall).toBeDefined();

      // Candidate 2 still processed
      expect(mockSupabaseDeleteUser).toHaveBeenCalledTimes(2);

      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(logCall![1]).toMatchObject({
        candidates: 2,
        deleted: 1,
        supabase_failed: 1,
      });
    });

    it('CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE env override respected', async () => {
      process.env.CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE = '5';
      sqlQueue.push([]); // candidates query — empty

      await runOnce();

      // sqlCalls[0] is the stale-cleanup DELETE; locate the candidates SELECT.
      const candidatesCall = sqlCalls.find((c) =>
        c.template.includes('SELECT u.id AS user_id'),
      );
      expect(candidatesCall).toBeDefined();
      expect(candidatesCall!.values).toContain(5);
    });

    it('default batch size (100) applied when env unset', async () => {
      sqlQueue.push([]);

      await runOnce();

      const candidatesCall = sqlCalls.find((c) =>
        c.template.includes('SELECT u.id AS user_id'),
      );
      expect(candidatesCall!.values).toContain(100);
    });

    it('default batch size applied on non-numeric env value', async () => {
      process.env.CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE = 'not-a-number';
      sqlQueue.push([]);

      await runOnce();

      const candidatesCall = sqlCalls.find((c) =>
        c.template.includes('SELECT u.id AS user_id'),
      );
      expect(candidatesCall!.values).toContain(100);
    });

    it('Supabase deleteUser timeout: tx rolls back, supabase_failed counted, warn logged', async () => {
      vi.useFakeTimers();
      try {
        sqlQueue.push([makeCandidate()]);
        seedRefsCollisionRows(false, false); // refs check empty so we proceed past it
        // refs check returns has_onboarded:false has_demos:false (but seedRefsCollisionRows
        // pushed advisory + refs only — that's the path we want).
        // Mock deleteUser to NEVER resolve so the 10s timeout fires.
        mockSupabaseDeleteUser.mockImplementationOnce(() => new Promise(() => {}));

        const runPromise = runOnce();
        // Advance past the 10s timeout window.
        await vi.advanceTimersByTimeAsync(10_001);
        await runPromise;

        const warnCall = mockLoggerWarn.mock.calls.find((args) =>
          String(args[0]).includes('deleteUser timeout'),
        );
        expect(warnCall).toBeDefined();

        // No DB delete issued (tx rolled back)
        const deleteUsers = sqlCalls.find((c) => c.template.includes('DELETE FROM users'));
        expect(deleteUsers).toBeUndefined();

        const logCall = mockLoggerLog.mock.calls.find((args) =>
          String(args[0]).includes('Run complete'),
        );
        expect(logCall![1]).toMatchObject({ supabase_failed: 1, deleted: 0 });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('startCleanupAbandonedSignupsPoller', () => {
    it('SELF_SERVE_SIGNUP_ENABLED !== "true": logs and does NOT start interval', () => {
      delete process.env.SELF_SERVE_SIGNUP_ENABLED;
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      startCleanupAbandonedSignupsPoller();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      // start() logs through the mocked structured logger, not console.
      expect(
        mockLoggerLog.mock.calls.some((args) =>
          String(args[0]).includes('SELF_SERVE_SIGNUP_ENABLED'),
        ),
      ).toBe(true);

      setIntervalSpy.mockRestore();
    });

    it('SELF_SERVE_SIGNUP_ENABLED !== "true" (explicit "false"): does NOT start', () => {
      process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      startCleanupAbandonedSignupsPoller();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });

    it('SELF_SERVE_SIGNUP_ENABLED === "true": starts interval + runs once immediately', async () => {
      process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
      sqlQueue.push([]); // candidates query for the immediate initial run

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as any);

      startCleanupAbandonedSignupsPoller();

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      // Default interval is 86_400_000 (24h)
      expect(setIntervalSpy.mock.calls[0]![1]).toBe(86_400_000);

      logSpy.mockRestore();
      setIntervalSpy.mockRestore();
    });

    it('CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS env override respected', () => {
      process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
      process.env.CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS = '60000';
      sqlQueue.push([]);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      // Use a non-zero mock return so `if (timer !== null)` works as
      // intended in production where setInterval returns Timeout objects.
      // Returning 0 specifically tests the literal-zero edge case the
      // !== null check was added to handle.
      const setIntervalSpy = vi
        .spyOn(global, 'setInterval')
        .mockImplementation(() => 12345 as any);

      startCleanupAbandonedSignupsPoller();

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(setIntervalSpy.mock.calls[0]![1]).toBe(60000);

      logSpy.mockRestore();
      setIntervalSpy.mockRestore();
    });

    // B24 — idempotent start: a second start() call should NOT register
    // a second interval (which would leak the first since the module
    // overwrites `timer`). Verify by spying setInterval call count.
    it('idempotent start: second startCleanupAbandonedSignupsPoller() call is a no-op', () => {
      process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
      sqlQueue.push([]); // initial run from first start
      sqlQueue.push([]); // (defensive — shouldn't fire from second start)

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const setIntervalSpy = vi
        .spyOn(global, 'setInterval')
        .mockImplementation(() => 67890 as any);

      startCleanupAbandonedSignupsPoller(); // first call — registers
      startCleanupAbandonedSignupsPoller(); // second call — should bail

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      // The second call logs the duplicate-guard breadcrumb (via the mocked
      // structured logger).
      expect(
        mockLoggerLog.mock.calls.some((args) =>
          String(args[0]).includes('Already started'),
        ),
      ).toBe(true);

      logSpy.mockRestore();
      setIntervalSpy.mockRestore();
    });
  });

  // B24 — single-flight runOnce: if a previous run is still executing,
  // the next runOnce() call short-circuits. Critical with sub-interval
  // tick rates (Scenario H uses 60s) — without this, slow Postgres or
  // Supabase calls would stack scheduled ticks on top of each other.
  describe('single-flight runOnce', () => {
    it('skips if a previous run is still in progress', async () => {
      // Make the candidates query hang so the first runOnce stays in flight.
      let resolveFirst: (v: unknown[]) => void = () => {};
      const firstPromise = new Promise<unknown[]>((resolve) => {
        resolveFirst = resolve;
      });
      consume.mockImplementationOnce(() => firstPromise);

      const firstRun = runOnce();

      // Second runOnce() called while first is still pending.
      await runOnce();

      // The "skipping this tick" log fires exactly once (from the second
      // call). The first call hasn't completed its work log yet.
      const skipCalls = mockLoggerLog.mock.calls.filter((args) =>
        String(args[0]).includes('Previous run still in progress'),
      );
      expect(skipCalls).toHaveLength(1);

      // Let the first run finish so cleanup is clean.
      resolveFirst([]);
      await firstRun;
    });

    it('after first run completes, subsequent runOnce() executes normally', async () => {
      sqlQueue.push([]); // first run candidates — empty list, completes immediately
      sqlQueue.push([]); // second run candidates — also empty
      await runOnce();
      await runOnce();
      // Both runs logged "Run complete" — neither was short-circuited.
      const completedCalls = mockLoggerLog.mock.calls.filter((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(completedCalls).toHaveLength(2);
    });

    // Regression guard: stop() must NOT reset the single-flight flag.
    // Scenario: a graceful-shutdown signal lands while runOnce() is mid-tx,
    // stop() clears the timer, then a fresh start() registers a new
    // interval and its initial runOnce() fires immediately. If stop() had
    // reset inProgress=false, the new run would race in parallel with the
    // still-executing original — defeating the single-flight guarantee
    // that protects against double-deletes on the same candidate. The
    // expected behavior is: the new initial runOnce() short-circuits with
    // the "Previous run still in progress — skipping" log; only after the
    // original finishes can the next tick run.
    it('stop+restart while a run is in flight does NOT race a parallel run', async () => {
      process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';

      // Make the FIRST runOnce's candidates query hang.
      let resolveFirst: (v: unknown[]) => void = () => {};
      const firstHang = new Promise<unknown[]>((resolve) => {
        resolveFirst = resolve;
      });
      consume.mockImplementationOnce(() => firstHang);

      // Kick off the in-flight runOnce.
      const firstRun = runOnce();

      // Operator hits SIGTERM mid-run.
      stopCleanupAbandonedSignupsPoller();

      // Worker restarts: setInterval gets stubbed out so the test stays
      // deterministic; we only care that the immediate initial runOnce()
      // launched by start() short-circuits on the still-set flag.
      const setIntervalSpy = vi
        .spyOn(global, 'setInterval')
        .mockImplementation(() => 99999 as any);
      startCleanupAbandonedSignupsPoller();
      // Yield so the start()'s initial runOnce promise can advance to its
      // single-flight check. The check is sync (no awaits before it), so
      // one microtask is enough.
      await Promise.resolve();
      await Promise.resolve();

      // The new start's initial runOnce must have skipped — exactly one
      // "skipping" log line, zero new candidates queries.
      const skipCalls = mockLoggerLog.mock.calls.filter((args) =>
        String(args[0]).includes('Previous run still in progress'),
      );
      expect(skipCalls).toHaveLength(1);

      // No second candidates query should have been issued (consume only
      // got called once — for the still-hung first run).
      expect(consume).toHaveBeenCalledTimes(1);

      // Drain the first run so cleanup is clean.
      resolveFirst([]);
      await firstRun;

      setIntervalSpy.mockRestore();
    });
  });
});
