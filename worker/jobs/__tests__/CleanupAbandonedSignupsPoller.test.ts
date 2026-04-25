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
  business_id: string;
  user_id: string;
  owner_email: string;
  auth_id: string;
};

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    business_id: overrides.business_id ?? 'biz-1',
    user_id: overrides.user_id ?? 'user-1',
    owner_email: overrides.owner_email ?? 'owner@example.com',
    auth_id: overrides.auth_id ?? 'auth-1',
  };
}

/**
 * Seed the rows for a "clean" (no refs) candidate: advisory lock result + refs-check row.
 * Caller still provides the candidates list as the first queued row.
 */
function seedCleanCandidateRows() {
  sqlQueue.push([{}]); // pg_advisory_xact_lock
  sqlQueue.push([{ has_onboarded: false, has_demos: false }]); // refs check
  sqlQueue.push([]); // DELETE FROM users
  sqlQueue.push([]); // DELETE FROM businesses
}

function seedRefsCollisionRows(has_onboarded: boolean, has_demos: boolean) {
  sqlQueue.push([{}]); // pg_advisory_xact_lock
  sqlQueue.push([{ has_onboarded, has_demos }]); // refs check — skip branch
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
      expect(String(logCall![0])).toContain('candidates=0');
      expect(String(logCall![0])).toContain('deleted=0');
    });

    it('self-serve candidate with no refs: advisory lock, supabase delete, users+businesses delete', async () => {
      sqlQueue.push([makeCandidate()]); // candidates query
      seedCleanCandidateRows();
      mockSupabaseDeleteUser.mockResolvedValueOnce({ data: null, error: null });

      await runOnce();

      // Advisory lock was requested with hashtext(email+':signup')
      const lockCall = sqlCalls.find((c) => c.template.includes('pg_advisory_xact_lock'));
      expect(lockCall).toBeDefined();
      expect(lockCall!.values).toContain('owner@example.com:signup');

      // Refs check query
      const refsCall = sqlCalls.find(
        (c) =>
          c.template.includes('has_onboarded') &&
          c.template.includes('has_demos'),
      );
      expect(refsCall).toBeDefined();

      // Supabase deleteUser called with the auth_id
      expect(mockSupabaseDeleteUser).toHaveBeenCalledOnce();
      expect(mockSupabaseDeleteUser).toHaveBeenCalledWith('auth-1');

      // DELETE FROM users BEFORE businesses (FK-aware ordering)
      const deleteUsersIdx = sqlCalls.findIndex(
        (c) => c.template.includes('DELETE FROM users'),
      );
      const deleteBusinessesIdx = sqlCalls.findIndex(
        (c) => c.template.includes('DELETE FROM businesses'),
      );
      expect(deleteUsersIdx).toBeGreaterThanOrEqual(0);
      expect(deleteBusinessesIdx).toBeGreaterThanOrEqual(0);
      expect(deleteUsersIdx).toBeLessThan(deleteBusinessesIdx);

      // Run-complete log records 1 deleted
      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(String(logCall![0])).toContain('deleted=1');
      expect(String(logCall![0])).toContain('skipped_refs=0');
    });

    it('candidates SQL filter enforces self-serve scope (onboarded_by IS NULL + auth_id IS NOT NULL)', async () => {
      sqlQueue.push([]); // candidates query — empty result fine for template-assertion

      await runOnce();

      const candidatesCall = sqlCalls[0];
      expect(candidatesCall).toBeDefined();
      expect(candidatesCall!.template).toContain('onboarded_by IS NULL');
      expect(candidatesCall!.template).toContain('auth_id IS NOT NULL');
      expect(candidatesCall!.template).toContain("subscription_status = 'pending_payment'");
      expect(candidatesCall!.template).toContain('stripe_customer_id IS NULL');
      expect(candidatesCall!.template).toContain("INTERVAL '7 days'");
    });

    it('candidate with has_onboarded=true refs: skipped, warn logged, no DB delete, no supabase delete', async () => {
      sqlQueue.push([makeCandidate()]); // candidates query
      seedRefsCollisionRows(true, false);

      await runOnce();

      expect(mockSupabaseDeleteUser).not.toHaveBeenCalled();

      // No DELETE issued
      const deleteUsers = sqlCalls.find((c) => c.template.includes('DELETE FROM users'));
      const deleteBizzes = sqlCalls.find((c) => c.template.includes('DELETE FROM businesses'));
      expect(deleteUsers).toBeUndefined();
      expect(deleteBizzes).toBeUndefined();

      expect(mockLoggerWarn).toHaveBeenCalled();
      const warnCall = mockLoggerWarn.mock.calls.find((args) =>
        String(args[0]).includes('Skipping'),
      );
      expect(warnCall).toBeDefined();

      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(String(logCall![0])).toContain('skipped_refs=1');
      expect(String(logCall![0])).toContain('deleted=0');
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
      expect(String(logCall![0])).toContain('skipped_refs=1');
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
      const deleteBizzes = sqlCalls.find((c) => c.template.includes('DELETE FROM businesses'));
      expect(deleteUsers).toBeDefined();
      expect(deleteBizzes).toBeDefined();

      // Counted as deleted
      const logCall = mockLoggerLog.mock.calls.find((args) =>
        String(args[0]).includes('Run complete'),
      );
      expect(String(logCall![0])).toContain('deleted=1');
    });

    it('Supabase non-404 error: tx rolls back, error logged, loop continues to next candidate', async () => {
      sqlQueue.push([
        makeCandidate({ business_id: 'biz-1', user_id: 'user-1', auth_id: 'auth-1', owner_email: 'a@e.com' }),
        makeCandidate({ business_id: 'biz-2', user_id: 'user-2', auth_id: 'auth-2', owner_email: 'b@e.com' }),
      ]);
      // Candidate 1: refs-check rows then supabase ERRORS (inside tx — throw rolls back)
      sqlQueue.push([{}]); // advisory lock (candidate 1)
      sqlQueue.push([{ has_onboarded: false, has_demos: false }]); // refs check (candidate 1)
      mockSupabaseDeleteUser.mockResolvedValueOnce({
        data: null,
        error: { message: 'permission denied', status: 403 } as any,
      });
      // Candidate 2: clean path succeeds
      sqlQueue.push([{}]); // advisory lock (candidate 2)
      sqlQueue.push([{ has_onboarded: false, has_demos: false }]); // refs check (candidate 2)
      sqlQueue.push([]); // DELETE users
      sqlQueue.push([]); // DELETE businesses
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
      expect(String(logCall![0])).toContain('candidates=2');
      expect(String(logCall![0])).toContain('deleted=1');
      expect(String(logCall![0])).toContain('supabase_failed=1');
    });

    it('CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE env override respected', async () => {
      process.env.CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE = '5';
      sqlQueue.push([]); // candidates query — empty

      await runOnce();

      const candidatesCall = sqlCalls[0];
      expect(candidatesCall).toBeDefined();
      expect(candidatesCall!.values).toContain(5);
    });

    it('default batch size (100) applied when env unset', async () => {
      sqlQueue.push([]);

      await runOnce();

      const candidatesCall = sqlCalls[0];
      expect(candidatesCall!.values).toContain(100);
    });

    it('default batch size applied on non-numeric env value', async () => {
      process.env.CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE = 'not-a-number';
      sqlQueue.push([]);

      await runOnce();

      const candidatesCall = sqlCalls[0];
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
          String(args[0]).includes('timeout for'),
        );
        expect(warnCall).toBeDefined();

        // No DB delete issued (tx rolled back)
        const deleteUsers = sqlCalls.find((c) => c.template.includes('DELETE FROM users'));
        expect(deleteUsers).toBeUndefined();

        const logCall = mockLoggerLog.mock.calls.find((args) =>
          String(args[0]).includes('Run complete'),
        );
        expect(String(logCall![0])).toContain('supabase_failed=1');
        expect(String(logCall![0])).toContain('deleted=0');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('startCleanupAbandonedSignupsPoller', () => {
    it('SELF_SERVE_SIGNUP_ENABLED !== "true": logs and does NOT start interval', () => {
      delete process.env.SELF_SERVE_SIGNUP_ENABLED;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      startCleanupAbandonedSignupsPoller();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(
        logSpy.mock.calls.some((args) =>
          String(args[0]).includes('SELF_SERVE_SIGNUP_ENABLED'),
        ),
      ).toBe(true);

      logSpy.mockRestore();
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
      const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(() => 0 as any);

      startCleanupAbandonedSignupsPoller();

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(setIntervalSpy.mock.calls[0]![1]).toBe(60000);

      logSpy.mockRestore();
      setIntervalSpy.mockRestore();
    });
  });
});
