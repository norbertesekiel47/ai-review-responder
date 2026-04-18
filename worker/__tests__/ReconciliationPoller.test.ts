import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock sql (tagged template) ──────────────────────────────────────
// Postgres.js `sql` is a tagged template function that also has a
// `.begin()` method. We mock it as a callable that tracks invocations.
const mockSqlCalls: { text: string; values: unknown[] }[] = [];
const mockSqlResult: { count: number } & unknown[] = Object.assign([], { count: 0 });

function createMockSql() {
  const fn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = Array.isArray(_strings) ? _strings.join('?') : '';
    mockSqlCalls.push({ text, values: _values });
    return Promise.resolve(mockSqlResult);
  });
  return fn;
}

const mockSql = createMockSql();

vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql, jsonb: (v: unknown) => v }));

vi.mock('../../src/lib/shared/mock-mode', () => ({
  isMockMode: vi.fn(() => false),
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'test-uuid-v7'),
}));

import { isMockMode } from '../../src/lib/shared/mock-mode';

// We need to test the internal pollBusinesses function.
// Since it's not exported, we test via start/stop lifecycle and
// verify SQL calls or lack thereof.

describe('ReconciliationPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSqlCalls.length = 0;
    // Reset the module-level state by re-importing
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getIntervalMs (via env)', () => {
    it('uses default 3_600_000 when env not set', async () => {
      delete process.env.RECONCILIATION_INTERVAL_MS;
      const mod = await import('../jobs/ReconciliationPoller');
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mod.startReconciliationPoller();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('interval=3600000ms'),
      );
      mod.stopReconciliationPoller();
      consoleSpy.mockRestore();
    });

    it('uses custom interval from env', async () => {
      process.env.RECONCILIATION_INTERVAL_MS = '120000';
      const mod = await import('../jobs/ReconciliationPoller');
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mod.startReconciliationPoller();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('interval=120000ms'),
      );
      mod.stopReconciliationPoller();
      consoleSpy.mockRestore();
      delete process.env.RECONCILIATION_INTERVAL_MS;
    });

    it('falls back to default on invalid env value', async () => {
      process.env.RECONCILIATION_INTERVAL_MS = 'not-a-number';
      const mod = await import('../jobs/ReconciliationPoller');
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mod.startReconciliationPoller();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('interval=3600000ms'),
      );
      mod.stopReconciliationPoller();
      consoleSpy.mockRestore();
      delete process.env.RECONCILIATION_INTERVAL_MS;
    });

    it('falls back to default on negative env value', async () => {
      process.env.RECONCILIATION_INTERVAL_MS = '-5000';
      const mod = await import('../jobs/ReconciliationPoller');
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mod.startReconciliationPoller();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('interval=3600000ms'),
      );
      mod.stopReconciliationPoller();
      consoleSpy.mockRestore();
      delete process.env.RECONCILIATION_INTERVAL_MS;
    });
  });

  describe('mock mode', () => {
    it('skips DB queries when mock mode is enabled', async () => {
      vi.mocked(isMockMode).mockReturnValue(true);
      const mod = await import('../jobs/ReconciliationPoller');
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mod.startReconciliationPoller();
      // Flush the immediate invocation
      await vi.advanceTimersByTimeAsync(0);

      // Should have logged mock skip, no SQL calls for candidates
      expect(consoleSpy).toHaveBeenCalledWith(
        '[ReconciliationPoller] Mock mode — skipping',
      );
      // The only SQL call would be the candidates query — should NOT have happened
      const candidateQueries = mockSqlCalls.filter((c) =>
        c.text.includes('subscription_status'),
      );
      expect(candidateQueries).toHaveLength(0);

      mod.stopReconciliationPoller();
      consoleSpy.mockRestore();
    });
  });

  describe('lifecycle', () => {
    it('stopReconciliationPoller clears the interval', async () => {
      const mod = await import('../jobs/ReconciliationPoller');
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mod.startReconciliationPoller();
      mod.stopReconciliationPoller();
      expect(consoleSpy).toHaveBeenCalledWith('[ReconciliationPoller] Stopped');
      consoleSpy.mockRestore();
    });

    it('stopReconciliationPoller is safe to call when not started', async () => {
      const mod = await import('../jobs/ReconciliationPoller');
      // Should not throw
      mod.stopReconciliationPoller();
    });
  });
});
