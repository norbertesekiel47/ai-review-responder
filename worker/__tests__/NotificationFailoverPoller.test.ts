import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { runFailoverPollerOnce as RunFailoverPollerOnce } from '../jobs/NotificationFailoverPoller';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockSendInternalEmail,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    if (Array.isArray(result)) {
      (result as any).count = result.length > 0 ? 1 : 0;
    }
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'mock-admin-1' }),
  };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
}));
vi.mock('../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: vi.fn(),
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

describe('NotificationFailoverPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@test.com';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <test@test.com>';
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // NOTE: Execution order is all-failed FIRST, then stale.
  // This ensures all-failed responses get admin alerts before the stale
  // query creates outbox entries that would shadow them.

  it('sends admin alert for stale response (multi-channel: no outbox re-dispatch)', async () => {
    // 1: all-failed query → empty (no all-failed responses)
    sqlReturnQueue.push([]);
    // 2: stale query → one response (now includes richer fields for alert email)
    sqlReturnQueue.push([{
      response_id: 'resp-1',
      business_id: 'biz-1',
      business_name: 'Test Café',
      reviewer_name: 'Alice',
      star_rating: 2,
    }]);
    // 3: 24h dedup check → no prior alert
    sqlReturnQueue.push([]);
    // 4: recordNotificationDelivery INSERT
    sqlReturnQueue.push([]);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    // Stale branch now alerts admin instead of queuing an outbox entry
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    expect(mockSendInternalEmail.mock.calls[0]![0].subject).toContain('Test Café');
    const insertCalls = mockSql.mock.calls.filter(
      (call: any[]) => {
        const text = Array.from(call[0] as TemplateStringsArray).join('');
        return text.includes('job_outbox') && text.includes('INSERT');
      },
    );
    expect(insertCalls).toHaveLength(0);

    mod.stopNotificationFailoverPoller();
  });

  it('sends admin alert and creates failover outbox for all-failed deliveries', async () => {
    // 1: all-failed query → one response
    sqlReturnQueue.push([{
      response_id: 'resp-2',
      business_id: 'biz-2',
      business_name: 'Test Biz',
      reviewer_name: 'Jane',
      star_rating: 1,
    }]);
    // 2: admin alert dedup check → no recent alert
    sqlReturnQueue.push([]);
    // 3: recoverFailoverCorrelationId → existingSend lookup (none)
    sqlReturnQueue.push([]);
    // 4: recoverFailoverCorrelationId → upstream generate_response lookup (none)
    sqlReturnQueue.push([]);
    // 5: INSERT outbox for all-failed
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 6: stale query → empty (the all-failed response now has an in-flight outbox)
    sqlReturnQueue.push([]);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.to).toBe('admin@test.com');
    expect(emailArgs.subject).toContain('Test Biz');

    mod.stopNotificationFailoverPoller();
  });

  it('deduplicates admin alerts within 24 hours', async () => {
    // 1: all-failed query → one response
    sqlReturnQueue.push([{
      response_id: 'resp-3',
      business_id: 'biz-3',
      business_name: 'Dup Biz',
      reviewer_name: 'Bob',
      star_rating: 2,
    }]);
    // 2: admin alert dedup check → existing alert found
    sqlReturnQueue.push([{ id: 'existing-alert' }]);
    // 3: recoverFailoverCorrelationId → existingSend lookup (none)
    sqlReturnQueue.push([]);
    // 4: recoverFailoverCorrelationId → upstream generate_response lookup (none)
    sqlReturnQueue.push([]);
    // 5: INSERT outbox for all-failed (still created — only admin email is deduped)
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 6: stale query → empty
    sqlReturnQueue.push([]);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSendInternalEmail).not.toHaveBeenCalled();

    mod.stopNotificationFailoverPoller();
  });

  // ── Regression: Sprint 6 correlation preservation (all-failed branch) ──
  // Failover send_notification jobs must carry the ORIGINAL correlation_id
  // from the upstream review chain, not a fresh uuidv7(). Otherwise a
  // `SELECT ... WHERE payload->>'correlation_id' = ?` trace misses the
  // failover step.
  // NOTE: The stale branch was replaced in Phase 0 with admin alerting (no
  // outbox insert), so correlation tests now exercise the all-failed branch.
  it('preserves upstream correlation_id from existing send_notification (all-failed branch)', async () => {
    const upstreamCorrelationId = 'upstream-corr-abc';

    // 1: all-failed query → one response
    sqlReturnQueue.push([{
      response_id: 'resp-corr',
      business_id: 'biz-corr',
      business_name: 'Corr Biz',
      reviewer_name: 'Tester',
      star_rating: 4,
    }]);
    // 2: admin alert dedup check → no recent alert
    sqlReturnQueue.push([]);
    // 3: recoverFailoverCorrelationId → existingSend lookup resolves immediately
    sqlReturnQueue.push([{ correlation_id: upstreamCorrelationId }]);
    //    (upstream query NOT issued because lookup #3 already resolved)
    // 4: INSERT outbox for all-failed
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 5: stale query → empty
    sqlReturnQueue.push([]);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    // Find the INSERT call and inspect its payload param
    const insertCall = mockSql.mock.calls.find(
      (call: any[]) => {
        const text = Array.from(call[0] as TemplateStringsArray).join('');
        return text.includes('INSERT') && text.includes('send_notification');
      },
    );
    expect(insertCall).toBeDefined();
    // Payload is now bound via jsonb(payload) — test mock returns the OBJECT
    // pass-through, so look for the object arg with a correlation_id property.
    const payloadArg = insertCall!.find((arg: any) =>
      arg && typeof arg === 'object' && !Array.isArray(arg) && 'correlation_id' in arg,
    );
    expect(payloadArg).toBeDefined();
    expect((payloadArg as { correlation_id: string }).correlation_id).toBe(upstreamCorrelationId);

    mod.stopNotificationFailoverPoller();
  });

  it('falls back to upstream generate_response correlation when no prior send_notification (all-failed branch)', async () => {
    const upstreamCorrelationId = 'gen-resp-corr-xyz';

    // 1: all-failed query → one response
    sqlReturnQueue.push([{
      response_id: 'resp-no-prior',
      business_id: 'biz-xyz',
      business_name: 'Fallback Biz',
      reviewer_name: 'Reviewer',
      star_rating: 1,
    }]);
    // 2: admin alert dedup check → no recent alert
    sqlReturnQueue.push([]);
    // 3: existingSend lookup → none
    sqlReturnQueue.push([]);
    // 4: upstream generate_response lookup → carries the ID
    sqlReturnQueue.push([{ correlation_id: upstreamCorrelationId }]);
    // 5: INSERT outbox for all-failed
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 6: stale query → empty
    sqlReturnQueue.push([]);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    const insertCall = mockSql.mock.calls.find(
      (call: any[]) => {
        const text = Array.from(call[0] as TemplateStringsArray).join('');
        return text.includes('INSERT') && text.includes('send_notification');
      },
    );
    expect(insertCall).toBeDefined();
    const payloadArg = insertCall!.find((arg: any) =>
      arg && typeof arg === 'object' && !Array.isArray(arg) && 'correlation_id' in arg,
    );
    expect(payloadArg).toBeDefined();
    expect((payloadArg as { correlation_id: string }).correlation_id).toBe(upstreamCorrelationId);

    mod.stopNotificationFailoverPoller();
  });

  it('lifecycle: start and stop work without errors', async () => {
    sqlReturnQueue.push([]); // all-failed
    sqlReturnQueue.push([]); // stale
    const mod = await import('../jobs/NotificationFailoverPoller');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopNotificationFailoverPoller();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[NotificationFailover] Stopped'));
    consoleSpy.mockRestore();
  });
});

describe('NotificationFailoverPoller — stale branch (multi-channel era)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockSendInternalEmail.mockReset();
    mockSendInternalEmail.mockResolvedValue({ messageId: 'mock-admin-1' });
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.example.com';
    // NO vi.useFakeTimers() here — this describe calls runFailoverPollerOnce directly
  });

  it('sends an admin alert and does NOT queue a new send_notification outbox entry', async () => {
    sqlReturnQueue.push([]);  // all-failed branch → empty
    sqlReturnQueue.push([{
      response_id: 'resp-stuck-1',
      business_id: 'biz-1',
      business_name: 'Gjelina',
      reviewer_name: 'Jane',
      star_rating: 3,
    }]);
    sqlReturnQueue.push([]);  // 24h dedup check → no prior alert
    sqlReturnQueue.push([]);  // notification_deliveries insert

    const mod = await import('../jobs/NotificationFailoverPoller');
    await (mod.runFailoverPollerOnce as typeof RunFailoverPollerOnce)();

    expect(mockSendInternalEmail).toHaveBeenCalledTimes(1);
    expect(mockSendInternalEmail.mock.calls[0]![0].to).toBe('admin@repworth.example.com');
    expect(mockSendInternalEmail.mock.calls[0]![0].subject).toMatch(/unresponsive|no response|approval_responsiveness|stuck/i);
    const outboxInserts = mockSql.mock.calls.filter(
      ([template]: [TemplateStringsArray]) =>
        Array.isArray(template) && template.join('').includes('INSERT INTO job_outbox'),
    );
    expect(outboxInserts).toHaveLength(0);
  });

  it('dedups within 24h — does not re-alert the same stuck response', async () => {
    sqlReturnQueue.push([]);  // all-failed branch
    sqlReturnQueue.push([{
      response_id: 'resp-stuck-1',
      business_id: 'biz-1',
      business_name: 'Gjelina',
      reviewer_name: 'Jane',
      star_rating: 3,
    }]);
    sqlReturnQueue.push([{ id: 'prior-alert-within-24h' }]);  // dedup HITS

    const mod = await import('../jobs/NotificationFailoverPoller');
    await (mod.runFailoverPollerOnce as typeof RunFailoverPollerOnce)();

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });
});
