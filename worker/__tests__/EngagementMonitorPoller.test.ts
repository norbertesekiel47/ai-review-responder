import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ───────────────────────────────────────────────
const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    if (Array.isArray(result) && !('count' in result)) {
      (result as any).count = result.length > 0 ? 1 : 0;
    }
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return { sqlReturnQueue, mockSql };
});

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

function metricsRow(overrides: Record<string, unknown> = {}) {
  return {
    business_id: 'biz-1',
    owner_email_bounced: false,
    days_since_approval: null,
    pending_count: 0,
    oldest_pending_age_days: null,
    notified_count: 0,
    approved_count: 0,
    ...overrides,
  };
}

describe('EngagementMonitorPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when no active businesses', async () => {
    // Metrics query returns empty
    sqlReturnQueue.push([]);

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    // Only the metrics query was called, no inserts
    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('fires owner_nudge when activity_age >= 3 AND pending > 0', async () => {
    sqlReturnQueue.push([metricsRow({ days_since_approval: 4, pending_count: 2 })]);
    // Atomic INSERT ... WHERE NOT EXISTS (cooldown + dedup built-in)
    sqlReturnQueue.push(Object.assign([], { count: 1 }));

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('job_outbox') && text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(1);
  });

  it('fires partner_engagement_alert when activity_age >= 7 AND pending > 0', async () => {
    sqlReturnQueue.push([metricsRow({ days_since_approval: 8, pending_count: 1 })]);
    // Atomic INSERT for owner_nudge + partner_engagement_alert
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // owner_nudge inserted
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // partner_engagement_alert inserted

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('job_outbox') && text.includes('INSERT');
    });
    // Both owner_nudge and partner_engagement_alert fire
    expect(insertCalls).toHaveLength(2);
  });

  it('fires partner_escalation_alert when activity_age >= 14 AND (pending > 0 OR notified > 0)', async () => {
    // No pending, but notified > 0 (keep notified < 3 to avoid triggering low_engagement)
    sqlReturnQueue.push([metricsRow({ days_since_approval: 15, pending_count: 0, notified_count: 2 })]);
    // Atomic INSERT for escalation only (owner_nudge and partner_engagement need pending > 0)
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // escalation inserted

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('job_outbox') && text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(1);
  });

  it('fires partner_low_engagement when approval_rate < 50% AND notified >= 3', async () => {
    // notified=4, approved=1 → rate=25%
    sqlReturnQueue.push([metricsRow({ notified_count: 4, approved_count: 1 })]);
    // Atomic INSERT for low_engagement
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // low_engagement inserted

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('job_outbox') && text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(1);
  });

  it('does NOT fire owner_nudge when activity_age < 3', async () => {
    sqlReturnQueue.push([metricsRow({ days_since_approval: 2, pending_count: 3 })]);

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('does NOT fire owner_nudge when owner_email_bounced is true', async () => {
    // activity_age=5, pending=2 would normally trigger owner_nudge, but email bounced
    sqlReturnQueue.push([metricsRow({ days_since_approval: 5, pending_count: 2, owner_email_bounced: true })]);

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('job_outbox') && text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('still fires partner rules when owner_email_bounced is true', async () => {
    // activity_age=8, pending=1: owner_nudge + partner_engagement would fire normally,
    // but bounce suppresses owner_nudge — only partner_engagement_alert should fire
    sqlReturnQueue.push([metricsRow({ days_since_approval: 8, pending_count: 1, owner_email_bounced: true })]);
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // partner_engagement_alert inserted

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('job_outbox') && text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(1);
  });

  it('does NOT fire low_engagement when notified_count < 3 (insufficient sample)', async () => {
    // notified=2, approved=0 → rate=0%, but notified < 3
    sqlReturnQueue.push([metricsRow({ notified_count: 2, approved_count: 0 })]);

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('does NOT fire when activityAgeDays is null (no approvals AND no pending)', async () => {
    // days_since_approval=null, oldest_pending_age_days=null, pending=0
    sqlReturnQueue.push([metricsRow()]);

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(0);
  });

  it('skips alert when cooldown is active (INSERT returns count=0)', async () => {
    sqlReturnQueue.push([metricsRow({ days_since_approval: 5, pending_count: 1 })]);
    // Atomic INSERT WHERE NOT EXISTS → cooldown active, nothing inserted
    sqlReturnQueue.push(Object.assign([], { count: 0 }));

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    // INSERT was still called (the query runs), but count=0 means no row was inserted
    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('job_outbox') && text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(1); // query ran but inserted nothing
  });

  it('can fire multiple alert types for the same business in one cycle', async () => {
    // activity_age=15, pending=2, notified=4, approved=1 → rate=25%
    // Should fire: owner_nudge (>=3, pending>0), partner_engagement (>=7, pending>0),
    //              partner_escalation (>=14, pending>0), partner_low_engagement (rate<50%, notified>=3)
    sqlReturnQueue.push([metricsRow({
      days_since_approval: 15,
      pending_count: 2,
      notified_count: 4,
      approved_count: 1,
    })]);

    // Atomic INSERT for all 4 rules (one per rule, no separate cooldown SELECT)
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // owner_nudge
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // partner_engagement_alert
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // partner_escalation_alert
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // partner_low_engagement

    const mod = await import('../jobs/EngagementMonitorPoller');
    mod.startEngagementMonitorPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopEngagementMonitorPoller();

    const insertCalls = mockSql.mock.calls.filter((call: any[]) => {
      const text = Array.from(call[0] as TemplateStringsArray).join('');
      return text.includes('job_outbox') && text.includes('INSERT');
    });
    expect(insertCalls).toHaveLength(4);
  });
});
