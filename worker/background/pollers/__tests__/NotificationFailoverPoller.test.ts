import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { runFailoverPollerOnce as RunFailoverPollerOnce } from '../NotificationFailoverPoller';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockSendInternalEmail,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((template: TemplateStringsArray, ..._v: unknown[]) => {
    // pg_advisory_xact_lock is a no-op lock acquisition in tests — return
    // [] without dequeuing so the sqlReturnQueue staging stays aligned with
    // the test's explicit SELECT/INSERT ordering.
    if (template && template[0] && template[0].includes('pg_advisory_xact_lock')) {
      return Promise.resolve([]);
    }
    const result = sqlReturnQueue.shift() ?? [];
    if (Array.isArray(result)) {
      (result as any).count = result.length > 0 ? 1 : 0;
    }
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));
  // The owner-unreachable arm encodes its outbox payload with tx.json(payload).
  // The mock tx IS mockSql, so it needs a pass-through .json or the arm throws
  // "tx.json is not a function".
  mockSql.json = vi.fn((v: unknown) => v);

  return {
    sqlReturnQueue,
    mockSql,
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'mock-admin-1' }),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
}));
vi.mock('../../../../src/lib/notifications/delivery', () => ({
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
      account_id: 'acct-1',
      business_name: 'Test Café',
      reviewer_name: 'Alice',
      star_rating: 2,
    }]);
    // 3: 24h dedup check → no prior alert
    sqlReturnQueue.push([]);
    // 4: claim INSERT (sent_at NULL) — inside tx1
    sqlReturnQueue.push([]);
    // 5: claim sent_at UPDATE — after the send, outside any tx
    sqlReturnQueue.push([]);

    const mod = await import('../NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    // Stale branch now alerts admin instead of queuing an outbox entry
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    expect(mockSendInternalEmail.mock.calls[0]![0].subject).toContain('Test Café');
    // Per-claim Resend idempotency key (claim id is the mocked uuid).
    expect(mockSendInternalEmail.mock.calls[0]![0].idempotencyKey).toBe('admin-alert:test-uuid');
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
      account_id: 'acct-2',
      business_name: 'Test Biz',
      reviewer_name: 'Jane',
      star_rating: 1,
    }]);
    // 2: admin alert dedup check (inside tryClaimAlert tx1) → no recent alert
    sqlReturnQueue.push([]);
    // 3: claim INSERT (inside tx1, sent_at NULL)
    sqlReturnQueue.push([]);
    // 4: claim sent_at UPDATE (after the send, outside any tx)
    sqlReturnQueue.push([]);
    // 5: recoverFailoverCorrelationId → existingSend lookup (none)
    sqlReturnQueue.push([]);
    // 6: recoverFailoverCorrelationId → upstream generate_response lookup (none)
    sqlReturnQueue.push([]);
    // 7: INSERT outbox for all-failed
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 8: stale query → empty (the all-failed response now has an in-flight outbox)
    sqlReturnQueue.push([]);

    const mod = await import('../NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const emailArgs = mockSendInternalEmail.mock.calls[0]![0];
    expect(emailArgs.to).toBe('admin@test.com');
    expect(emailArgs.subject).toContain('Test Biz');
    expect(emailArgs.idempotencyKey).toBe('admin-alert:test-uuid');

    mod.stopNotificationFailoverPoller();
  });

  it('deduplicates admin alerts within 24 hours', async () => {
    // 1: all-failed query → one response
    sqlReturnQueue.push([{
      response_id: 'resp-3',
      business_id: 'biz-3',
      account_id: 'acct-3',
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

    const mod = await import('../NotificationFailoverPoller');
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
      account_id: 'acct-corr',
      business_name: 'Corr Biz',
      reviewer_name: 'Tester',
      star_rating: 4,
    }]);
    // 2: admin alert dedup check (inside tryClaimAlert) → no recent alert
    sqlReturnQueue.push([]);
    // 3: INSERT notification_deliveries (claim row inside tryClaimAlert tx1)
    sqlReturnQueue.push([]);
    // 3b: claim sent_at UPDATE (after the send, outside any tx)
    sqlReturnQueue.push([]);
    // 4: recoverFailoverCorrelationId → existingSend lookup resolves immediately
    sqlReturnQueue.push([{ correlation_id: upstreamCorrelationId }]);
    //    (upstream query NOT issued because lookup #4 already resolved)
    // 5: INSERT outbox for all-failed
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 6: stale query → empty
    sqlReturnQueue.push([]);

    const mod = await import('../NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    // Find the INSERT call and inspect its payload param
    // Topic is an interpolated QUEUE_NAMES value, not a template literal —
    // check the bound values, not the raw strings array.
    const insertCall = mockSql.mock.calls.find(
      (call: any[]) => {
        const text = Array.from(call[0] as TemplateStringsArray).join('');
        return text.includes('INSERT') && call.slice(1).includes('send_notification');
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
      account_id: 'acct-xyz',
      business_name: 'Fallback Biz',
      reviewer_name: 'Reviewer',
      star_rating: 1,
    }]);
    // 2: admin alert dedup check (inside tryClaimAlert) → no recent alert
    sqlReturnQueue.push([]);
    // 3: INSERT notification_deliveries (claim row inside tryClaimAlert tx1)
    sqlReturnQueue.push([]);
    // 3b: claim sent_at UPDATE (after the send, outside any tx)
    sqlReturnQueue.push([]);
    // 4: existingSend lookup → none
    sqlReturnQueue.push([]);
    // 5: upstream generate_response lookup → carries the ID
    sqlReturnQueue.push([{ correlation_id: upstreamCorrelationId }]);
    // 6: INSERT outbox for all-failed
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);
    // 7: stale query → empty
    sqlReturnQueue.push([]);

    const mod = await import('../NotificationFailoverPoller');
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);

    // Topic is an interpolated QUEUE_NAMES value, not a template literal —
    // check the bound values, not the raw strings array.
    const insertCall = mockSql.mock.calls.find(
      (call: any[]) => {
        const text = Array.from(call[0] as TemplateStringsArray).join('');
        return text.includes('INSERT') && call.slice(1).includes('send_notification');
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
    const mod = await import('../NotificationFailoverPoller');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mod.startNotificationFailoverPoller();
    await vi.advanceTimersByTimeAsync(0);
    mod.stopNotificationFailoverPoller();
    // Structured logger emits one JSON line per call via console.log.
    const stoppedLine = consoleSpy.mock.calls
      .map((call) => call[0])
      .find((line) => typeof line === 'string' && line.includes('"message":"Stopped"'));
    expect(stoppedLine).toEqual(expect.stringContaining('"logger":"NotificationFailover"'));
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
    // ADMIN_NOTIFICATION_EMAIL now reads getWorkerConfig() (memoized) — reset the
    // module registry AFTER setting env so the dynamic import below re-parses it
    // (convention #6). The outer beforeEach's reset ran before this env override.
    vi.resetModules();
    // NO vi.useFakeTimers() here — this describe calls runFailoverPollerOnce directly
  });

  it('sends an admin alert and does NOT queue a new send_notification outbox entry', async () => {
    sqlReturnQueue.push([]);  // all-failed branch → empty
    sqlReturnQueue.push([{
      response_id: 'resp-stuck-1',
      business_id: 'biz-1',
      account_id: 'acct-1',
      business_name: 'Gjelina',
      reviewer_name: 'Jane',
      star_rating: 3,
    }]);
    sqlReturnQueue.push([]);  // 24h dedup check → no prior alert
    sqlReturnQueue.push([]);  // claim INSERT (tx1)
    sqlReturnQueue.push([]);  // claim sent_at UPDATE (post-send)

    const mod = await import('../NotificationFailoverPoller');
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
      account_id: 'acct-1',
      business_name: 'Gjelina',
      reviewer_name: 'Jane',
      star_rating: 3,
    }]);
    sqlReturnQueue.push([{ id: 'prior-alert-within-24h' }]);  // dedup HITS

    const mod = await import('../NotificationFailoverPoller');
    await (mod.runFailoverPollerOnce as typeof RunFailoverPollerOnce)();

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });
});

describe('NotificationFailoverPoller — owner-unreachable arm', () => {
  const OWNER_UNREACHABLE_ROW = {
    response_id: 'resp-unreach-1',
    business_id: 'biz-unreach-1',
    account_id: 'acct-unreach-1',
    business_name: 'Unreachable Diner',
    reviewer_name: 'Casey',
    star_rating: 5,
  };

  function outboxInserts(): unknown[] {
    return mockSql.mock.calls.filter(
      ([template]: [TemplateStringsArray]) =>
        Array.isArray(template) && template.join('').includes('INSERT INTO job_outbox'),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockSendInternalEmail.mockReset();
    mockSendInternalEmail.mockResolvedValue({ messageId: 'mock-admin-unreach' });
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.example.com';
    // Reset the module registry AFTER the env override so getWorkerConfig()
    // re-parses ADMIN_NOTIFICATION_EMAIL on the dynamic import below (convention #6).
    vi.resetModules();
    // Keep the all-failed + stale arms inert: both driving SELECTs return empty.
    sqlReturnQueue.push([]); // all-failed query
    sqlReturnQueue.push([]); // stale query
  });

  it('(a) retry path: re-enqueues send_notification AND sends the owner-unreachable admin email', async () => {
    sqlReturnQueue.push([OWNER_UNREACHABLE_ROW]);         // candidate SELECT
    sqlReturnQueue.push([]);                               // recover: existingSend lookup
    sqlReturnQueue.push([]);                               // recover: upstream generate_response lookup
    sqlReturnQueue.push([{ unreachable: true, in_flight: false }]); // locked state re-check
    const insertResult: any = []; insertResult.count = 1;
    sqlReturnQueue.push(insertResult);                     // INSERT INTO job_outbox
    sqlReturnQueue.push([]);                               // tryClaimAlert 24h dedup check
    sqlReturnQueue.push([]);                               // tryClaimAlert claim INSERT (tx1)
    sqlReturnQueue.push([]);                               // tryClaimAlert sent_at UPDATE (post-send)

    const mod = await import('../NotificationFailoverPoller');
    await (mod.runFailoverPollerOnce as typeof RunFailoverPollerOnce)();

    expect(outboxInserts()).toHaveLength(1);
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    const email = mockSendInternalEmail.mock.calls[0]![0];
    expect(email.to).toBe('admin@repworth.example.com');
    expect(email.subject).toContain('Owner unreachable');
    expect(email.subject).toContain('Unreachable Diner');
    // tryClaimAlert dedups on the owner-unreachable template.
    const deliveryInsert = mockSql.mock.calls.find(
      ([template]: [TemplateStringsArray]) =>
        Array.isArray(template) &&
        template.join('').includes('INSERT INTO notification_deliveries'),
    );
    expect(deliveryInsert).toBeDefined();
    expect(deliveryInsert!.slice(1)).toContain('admin_notification_owner_unreachable');
  });

  it('(b) locked re-check no longer unreachable: no re-enqueue and no email', async () => {
    sqlReturnQueue.push([OWNER_UNREACHABLE_ROW]);         // candidate SELECT
    sqlReturnQueue.push([]);                               // recover: existingSend lookup
    sqlReturnQueue.push([]);                               // recover: upstream lookup
    sqlReturnQueue.push([{ unreachable: false, in_flight: false }]); // locked state re-check fails

    const mod = await import('../NotificationFailoverPoller');
    await (mod.runFailoverPollerOnce as typeof RunFailoverPollerOnce)();

    expect(outboxInserts()).toHaveLength(0);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('(c) concurrency race — locked re-check finds a retry already in-flight: no re-enqueue but the admin email still fires', async () => {
    // Steady-state in-flight rows are excluded at the candidate level now; this
    // models the race where a concurrent poller enqueued a retry between our
    // candidate SELECT and our advisory lock — the locked re-check catches it.
    sqlReturnQueue.push([OWNER_UNREACHABLE_ROW]);         // candidate SELECT
    sqlReturnQueue.push([]);                               // recover: existingSend lookup
    sqlReturnQueue.push([]);                               // recover: upstream lookup
    sqlReturnQueue.push([{ unreachable: true, in_flight: true }]); // still unreachable, concurrent retry in-flight
    sqlReturnQueue.push([]);                               // tryClaimAlert 24h dedup check
    sqlReturnQueue.push([]);                               // tryClaimAlert claim INSERT (tx1)
    sqlReturnQueue.push([]);                               // tryClaimAlert sent_at UPDATE (post-send)

    const mod = await import('../NotificationFailoverPoller');
    await (mod.runFailoverPollerOnce as typeof RunFailoverPollerOnce)();

    expect(outboxInserts()).toHaveLength(0);
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
    expect(mockSendInternalEmail.mock.calls[0]![0].subject).toContain('Owner unreachable');
  });
});

// ── tryClaimAlert: claim-before-send contract (#415) ──────────────────────────
// The helper is exported so these cases can drive it directly against the
// mocked sql. Contract under test: the claim row is COMMITTED before the
// provider call; the provider call runs outside the tx; a failed send KEEPS
// the claim (never a DELETE); bookkeeping failures never flip the outcome.
describe('tryClaimAlert — claim-before-send (#415)', () => {
  const CTX = { accountId: 'acct-c', businessId: 'biz-c', responseId: 'resp-c' };
  const RECIPIENT = 'admin@repworth.example.com';
  const TEMPLATE = 'approval_responsiveness_alert';
  const stubLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const originalBegin = mockSql.begin;

  function sqlTexts(): string[] {
    return mockSql.mock.calls
      .map(([template]: [TemplateStringsArray]) => (Array.isArray(template) ? template.join('') : ''));
  }
  async function flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockSql.begin = originalBegin;
    stubLogger.log.mockReset();
    stubLogger.warn.mockReset();
    stubLogger.error.mockReset();
  });

  afterEach(() => {
    mockSql.begin = originalBegin;
  });

  it('(a) sendFn runs only AFTER the claim tx has committed (sql.begin resolved)', async () => {
    let releaseCommit: () => void = () => {};
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    // Deferred COMMIT: the callback resolves, but begin() itself does not
    // resolve until the test releases it — separating "callback done" from
    // "transaction committed".
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => {
      const result = await cb(mockSql);
      await commitGate;
      return result;
    });
    sqlReturnQueue.push([]); // dedup SELECT → none
    sqlReturnQueue.push([]); // claim INSERT
    sqlReturnQueue.push([]); // sent_at UPDATE
    const sendFn = vi.fn(async () => 'msg-1');

    const mod = await import('../NotificationFailoverPoller');
    const pending = mod.tryClaimAlert('resp-c', TEMPLATE, RECIPIENT, sendFn, CTX, stubLogger as any);
    await flush();
    expect(sendFn).not.toHaveBeenCalled();

    releaseCommit();
    expect(await pending).toBe('sent');
    expect(sendFn).toHaveBeenCalledOnce();
    expect(sendFn).toHaveBeenCalledWith('test-uuid');
    expect(mod.adminAlertIdempotencyKey('test-uuid')).toBe('admin-alert:test-uuid');
  });

  it('(b) claim tx rejects (COMMIT failure) → send_error and sendFn is never called', async () => {
    mockSql.begin = vi.fn(async () => { throw new Error('commit failed'); });
    const sendFn = vi.fn(async () => 'msg-never');

    const mod = await import('../NotificationFailoverPoller');
    const outcome = await mod.tryClaimAlert('resp-c', TEMPLATE, RECIPIENT, sendFn, CTX, stubLogger as any);

    expect(outcome).toBe('send_error');
    expect(sendFn).not.toHaveBeenCalled();
    expect(stubLogger.error).toHaveBeenCalledOnce();
  });

  it('(c) post-send sent_at UPDATE rejects → still "sent" (claim keeps dedup), error logged', async () => {
    sqlReturnQueue.push([]); // dedup SELECT → none
    sqlReturnQueue.push([]); // claim INSERT
    // Thenable that rejects when adopted by Promise.resolve — models the UPDATE failing.
    sqlReturnQueue.push({ then: (_: unknown, reject: (e: unknown) => void) => reject(new Error('update boom')) });
    const sendFn = vi.fn(async () => 'msg-2');

    const mod = await import('../NotificationFailoverPoller');
    const outcome = await mod.tryClaimAlert('resp-c', TEMPLATE, RECIPIENT, sendFn, CTX, stubLogger as any);

    expect(outcome).toBe('sent');
    expect(sendFn).toHaveBeenCalledOnce();
    expect(stubLogger.error).toHaveBeenCalledOnce();
    expect(sqlTexts().some((t) => t.includes('DELETE FROM notification_deliveries'))).toBe(false);
  });

  it.each([
    ['a generic provider error', () => new Error('Resend API error: something')],
    ['a send timeout', () => Object.assign(new Error('Resend send exceeded 10000ms timeout'), { name: 'EmailSendTimeoutError' })],
  ])('(d) sendFn rejects with %s → claim KEPT with failed_at, no DELETE, send_error', async (_label, makeErr) => {
    sqlReturnQueue.push([]); // dedup SELECT → none
    sqlReturnQueue.push([]); // claim INSERT
    sqlReturnQueue.push([]); // failed_at UPDATE
    const sendFn = vi.fn(async () => { throw makeErr(); });

    const mod = await import('../NotificationFailoverPoller');
    const outcome = await mod.tryClaimAlert('resp-c', TEMPLATE, RECIPIENT, sendFn, CTX, stubLogger as any);

    expect(outcome).toBe('send_error');
    const texts = sqlTexts();
    expect(texts.some((t) => t.includes('failed_at = NOW()'))).toBe(true);
    expect(texts.some((t) => t.includes('sent_at = NOW()'))).toBe(false);
    expect(texts.some((t) => t.includes('DELETE FROM notification_deliveries'))).toBe(false);
    expect(stubLogger.error).toHaveBeenCalledOnce();
  });

  it('(e) two successive claims get two DIFFERENT idempotency keys (per-claim, not per-tuple)', async () => {
    const { v7 } = await import('uuid');
    vi.mocked(v7).mockReturnValueOnce('claim-1' as any).mockReturnValueOnce('claim-2' as any);
    const seen: string[] = [];
    const sendFn = vi.fn(async (claimId: string) => { seen.push(claimId); return `msg-${claimId}`; });
    // Two claims for the SAME tuple where the dedup SELECT finds nothing both
    // times (models the second claim landing after the 24h window).
    sqlReturnQueue.push([]); sqlReturnQueue.push([]); sqlReturnQueue.push([]);
    sqlReturnQueue.push([]); sqlReturnQueue.push([]); sqlReturnQueue.push([]);

    const mod = await import('../NotificationFailoverPoller');
    expect(await mod.tryClaimAlert('resp-c', TEMPLATE, RECIPIENT, sendFn, CTX, stubLogger as any)).toBe('sent');
    expect(await mod.tryClaimAlert('resp-c', TEMPLATE, RECIPIENT, sendFn, CTX, stubLogger as any)).toBe('sent');

    expect(seen).toEqual(['claim-1', 'claim-2']);
    expect(mod.adminAlertIdempotencyKey(seen[0]!)).not.toBe(mod.adminAlertIdempotencyKey(seen[1]!));
  });
});
