import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
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

  it('creates failover outbox entry for stale response with no delivery', async () => {
    // 1: all-failed query → empty (no all-failed responses)
    sqlReturnQueue.push([]);
    // 2: stale query → one response
    sqlReturnQueue.push([{ response_id: 'resp-1', business_id: 'biz-1' }]);
    // 3: INSERT outbox for stale
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    const insertCalls = mockSql.mock.calls.filter(
      (call: any[]) => {
        const text = Array.from(call[0] as TemplateStringsArray).join('');
        return text.includes('job_outbox') && text.includes('INSERT');
      },
    );
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();

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
    // 3: INSERT outbox for all-failed
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 4: stale query → empty (the all-failed response now has an in-flight outbox)
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
    // 3: INSERT outbox for all-failed (still created — only admin email is deduped)
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 4: stale query → empty
    sqlReturnQueue.push([]);

    const mod = await import('../jobs/NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSendInternalEmail).not.toHaveBeenCalled();

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
