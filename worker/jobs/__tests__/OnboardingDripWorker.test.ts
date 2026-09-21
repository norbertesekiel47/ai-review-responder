import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { OnboardingDripPayload } from '../../../src/lib/shared/worker-types';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxCompletedWithReason,
  mockMarkOutboxFailed,
  mockSendInternalEmail,
  mockRecordNotificationDelivery,
  mockCreateApprovalLink,
  mockBuildOnboardingDay1Html,
  mockBuildOnboardingDay7Html,
  mockBuildOnboardingDay30Html,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  let linkCounter = 0;

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxCompletedWithReason: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockSendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-drip-1' }),
    mockRecordNotificationDelivery: vi.fn(),
    mockCreateApprovalLink: vi.fn().mockImplementation(() => {
      linkCounter++;
      return Promise.resolve({ rawToken: `drip-token-${linkCounter}`, tokenHash: `drip-hash-${linkCounter}` });
    }),
    mockBuildOnboardingDay1Html: vi.fn(() => '<html>day1</html>'),
    mockBuildOnboardingDay7Html: vi.fn(() => '<html>day7</html>'),
    mockBuildOnboardingDay30Html: vi.fn(() => '<html>day30</html>'),
  };
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxCompletedWithReason: mockMarkOutboxCompletedWithReason,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({ outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback, attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined }),
}));
vi.mock('../../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
  buildOnboardingDay1Html: mockBuildOnboardingDay1Html,
  buildOnboardingDay7Html: mockBuildOnboardingDay7Html,
  buildOnboardingDay30Html: mockBuildOnboardingDay30Html,
}));
vi.mock('../../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: mockRecordNotificationDelivery,
}));
vi.mock('../../../src/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));

import { handleOnboardingDrip } from '../OnboardingDripWorker';

// ── Helpers ─────────────────────────────────────────────────────────

function makeJob(overrides: Partial<OnboardingDripPayload> = {}): Job<OnboardingDripPayload> {
  return {
    data: {
      business_id: 'biz-drip-1',
      drip_type: 'day_1',
      ...overrides,
    },
    id: 'outbox-drip-1',
  } as Job<OnboardingDripPayload>;
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-drip-1',
    name: 'Drip Test Biz',
    owner_name: 'Jane',
    owner_email: 'jane@test.com',
    subscription_status: 'active',
    account_updated_at: new Date(),
    initial_review_count: 20,
    initial_responded_count: 5,
    // Relative to now, not a hard-coded date. #719 added a fail-closed Drip
    // staleness cap in the handler, so a fixture pinned to a fixed calendar day
    // starts refusing every drip once wall-clock passes it — the suite would rot
    // silently into "all sends skipped" and still read as a legitimate pass.
    // 12h ago keeps every drip type inside its grace window; cases that WANT the
    // refusal override this explicitly.
    subscription_activated_at: new Date(Date.now() - 12 * 60 * 60 * 1000),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('OnboardingDripWorker – handleOnboardingDrip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <noreply@repworth.com>';
  });

  // ── Common guards ──────────────────────────────────────────────────

  it('marks outbox failed when business not found', async () => {
    sqlReturnQueue.push([]); // business query empty

    await handleOnboardingDrip(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(mockSql, 'outbox-drip-1', 'business_not_found', undefined);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  // ── Drip staleness cap (#719 review A1) ────────────────────────────
  // The scheduler already excludes stale pairs, so this only fires for a row
  // that reached the handler another way: an operator re-drive, a future second
  // producer, or a row minted just inside the boundary and stranded through a
  // multi-day worker outage. Producer-only enforcement is not enforcement.

  it('refuses a drip past the staleness cap and never sends', async () => {
    // day_1 due at activated + 1d, cap at + 4d. 10 days ago is far past it.
    sqlReturnQueue.push([
      mockBusinessRow({
        subscription_activated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      }),
    ]);

    await handleOnboardingDrip(makeJob());

    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledWith(
      mockSql,
      'outbox-drip-1',
      'drip_too_stale',
      undefined,
    );
    // Completed, never failed — a policy refusal is the guard working, so it
    // must not burn watchdog retries the way a genuine error does.
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    // And it must NOT consume the (business_id, drip_type) claim: the guard runs
    // before the drip-log INSERT, so exactly one query — the business lookup —
    // has run by the time it returns.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('sends a drip still inside the staleness window', async () => {
    // Deliberately 5 minutes INSIDE the boundary, not exactly on it.
    //
    // An exact-boundary fixture here is a time RACE, not a boundary check: the
    // cap is `activated + 4 days`, so seeding `Date.now() - 4 days` makes the cap
    // equal to the instant the fixture was built — and `handleOnboardingDrip`
    // then constructs its OWN `new Date()` a few ms later, which is already past
    // it. The guard correctly refuses, the test fails, and nothing is wrong with
    // the code. It passed locally and lost the race on slower CI.
    //
    // Exact equality (`<` vs `<=`) IS pinned, by the scheduler suite's title 12,
    // which can do it honestly because `runOnboardingDripCycle` takes an injected
    // `asOf`. The handler has no such seam — it builds its own clock — so the
    // strongest thing testable here is "comfortably inside still sends".
    sqlReturnQueue.push([
      mockBusinessRow({
        subscription_activated_at: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000),
      }),
    ]);
    sqlReturnQueue.push([{ id: 'claim-1' }]); // drip-log claim
    sqlReturnQueue.push([]); // dashboard-url probe
    sqlReturnQueue.push(Object.assign([], { count: 1 })); // sent_at update

    await handleOnboardingDrip(makeJob());

    expect(mockMarkOutboxCompletedWithReason).not.toHaveBeenCalled();
    expect(mockSendInternalEmail).toHaveBeenCalled();
  });

  it('skips when subscription is not active (completes outbox)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleOnboardingDrip(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-drip-1', undefined);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('skips when subscription is pending_payment', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'pending_payment' })]);

    await handleOnboardingDrip(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-drip-1', undefined);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  // ── Day 1 ──────────────────────────────────────────────────────────

  it('day_1: sends welcome email with dashboard URL when owner has auth', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);       // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);   // 2. claim drip_log — success
    sqlReturnQueue.push([{ id: 'user-1' }]);         // 3. owner with auth
    sqlReturnQueue.push([]);                          // 4. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_1' }));

    expect(mockBuildOnboardingDay1Html).toHaveBeenCalledWith({
      businessName: 'Drip Test Biz',
      ownerName: 'Jane',
      dashboardUrl: 'https://app.repworth.com/dashboard',
    });

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-drip-1', undefined);

    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'jane@test.com',
      subject: 'Welcome to RepWorth, Jane!',
      bodyHtml: '<html>day1</html>',
      category: 'marketing',
      idempotencyKey: 'onboarding_drip_day_1:biz-drip-1',
    });

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith(mockSql, {
      businessId: 'biz-drip-1',
      channel: 'email',
      recipient: 'jane@test.com',
      template: 'onboarding_drip_day_1',
      externalMessageId: 'msg-drip-1',
    });
  });

  it('day_1: sends without dashboard URL when no auth mapping', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);       // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);   // 2. claim drip_log — success
    sqlReturnQueue.push([]);                          // 3. no owner with auth
    sqlReturnQueue.push([]);                          // 4. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_1' }));

    expect(mockBuildOnboardingDay1Html).toHaveBeenCalledWith({
      businessName: 'Drip Test Biz',
      ownerName: 'Jane',
      dashboardUrl: null,
    });

    expect(mockSendInternalEmail).toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  // ── Day 7 ──────────────────────────────────────────────────────────

  it('day_7: sends recap with stats and highlight review', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);       // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);   // 2. claim drip_log — success
    sqlReturnQueue.push([{ id: 'user-1' }]);         // 3. owner with auth

    // day_7 queries:
    sqlReturnQueue.push([{ reviews_handled: 5 }]);         // 4. reviews handled
    sqlReturnQueue.push([{                                  // 5. highlight review
      reviewer_name: 'Alice',
      star_rating: 5,
      review_text: 'Amazing service!',
      approved_text: 'Thank you Alice!',
    }]);
    sqlReturnQueue.push([{ exists: 1 }]);                   // 6. has edits
    sqlReturnQueue.push([]);                                 // 7. no pending reviews
    sqlReturnQueue.push([{ total: 6 }]);                    // 8. total reviews for rate
    sqlReturnQueue.push([]);                                 // 9. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_7' }));

    expect(mockBuildOnboardingDay7Html).toHaveBeenCalledWith({
      businessName: 'Drip Test Biz',
      ownerName: 'Jane',
      reviewsHandled: 5,
      timeSavedMinutes: 35,
      responseRate: 83,
      highlightReview: {
        reviewerName: 'Alice',
        starRating: 5,
        reviewText: 'Amazing service!',
        responseText: 'Thank you Alice!',
      },
      hasEdits: true,
      pendingReviews: [],
    });

    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'jane@test.com',
      subject: 'Your first week with RepWorth — Drip Test Biz',
      bodyHtml: '<html>day7</html>',
      category: 'marketing',
    });

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith(mockSql, {
      businessId: 'biz-drip-1',
      channel: 'email',
      recipient: 'jane@test.com',
      template: 'onboarding_drip_day_7',
      externalMessageId: 'msg-drip-1',
    });
  });

  it('day_7: creates approval links for pending reviews', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);       // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);   // 2. claim drip_log — success
    sqlReturnQueue.push([{ id: 'user-1' }]);         // 3. owner with auth

    sqlReturnQueue.push([{ reviews_handled: 2 }]);          // 4. reviews handled
    sqlReturnQueue.push([]);                                 // 5. no highlight
    sqlReturnQueue.push([]);                                 // 6. no edits
    sqlReturnQueue.push([                                    // 7. 2 pending reviews
      { response_id: 'resp-p1', reviewer_name: 'Bob', star_rating: 3 },
      { response_id: 'resp-p2', reviewer_name: 'Carol', star_rating: null },
    ]);
    sqlReturnQueue.push([{ total: 4 }]);                    // 8. total reviews
    sqlReturnQueue.push([]);                                 // 9. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_7' }));

    expect(mockCreateApprovalLink).toHaveBeenCalledTimes(2);
    expect(mockCreateApprovalLink).toHaveBeenCalledWith(mockSql, {
      responseId: 'resp-p1',
      businessId: 'biz-drip-1',
      channel: 'email',
      revokeMode: 'orphaned_only',
    });
    expect(mockCreateApprovalLink).toHaveBeenCalledWith(mockSql, {
      responseId: 'resp-p2',
      businessId: 'biz-drip-1',
      channel: 'email',
      revokeMode: 'orphaned_only',
    });

    const day7Params = (mockBuildOnboardingDay7Html.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    const pendingReviews = day7Params.pendingReviews as Array<{ reviewerName: string; approvalUrl: string }>;
    expect(pendingReviews).toHaveLength(2);
    expect(pendingReviews[0]!.reviewerName).toBe('Bob');
    expect(pendingReviews[0]!.approvalUrl).toMatch(/^https:\/\/app\.repworth\.com\/approve\/drip-token-/);
    expect(pendingReviews[1]!.reviewerName).toBe('Carol');
  });

  it('day_7: handles zero reviews gracefully', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);       // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);   // 2. claim drip_log — success
    sqlReturnQueue.push([{ id: 'user-1' }]);         // 3. owner with auth

    sqlReturnQueue.push([{ reviews_handled: 0 }]);          // 4. no reviews handled
    sqlReturnQueue.push([]);                                 // 5. no highlight
    sqlReturnQueue.push([]);                                 // 6. no edits
    sqlReturnQueue.push([]);                                 // 7. no pending reviews
    sqlReturnQueue.push([{ total: 0 }]);                    // 8. total reviews = 0
    sqlReturnQueue.push([]);                                 // 9. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_7' }));

    const day7Params = (mockBuildOnboardingDay7Html.mock.calls as unknown[][])[0]![0] as Record<string, unknown>;
    expect(day7Params.reviewsHandled).toBe(0);
    expect(day7Params.timeSavedMinutes).toBe(0);
    expect(day7Params.responseRate).toBe(0);
    expect(day7Params.highlightReview).toBeNull();
    expect(day7Params.hasEdits).toBe(false);
    expect(day7Params.pendingReviews).toEqual([]);

    expect(mockSendInternalEmail).toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  // ── Day 30 ─────────────────────────────────────────────────────────

  it('day_30: sends impact with ranking change when data exists', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);       // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);   // 2. claim drip_log — success
    sqlReturnQueue.push([{ id: 'user-1' }]);         // 3. owner with auth (unused by day_30 but still queried)

    // day_30 queries:
    sqlReturnQueue.push([{ total: 15 }]);                   // 4. total reviews
    sqlReturnQueue.push([{ responded: 12 }]);               // 5. responded
    sqlReturnQueue.push([{ keyword: 'pizza near me', rank_position: 3 }]); // 6. latest ranking
    sqlReturnQueue.push([{ rank_position: 8 }]);            // 7. earliest ranking
    sqlReturnQueue.push([{ name: 'Admin Pat' }]);           // 8. onboarded_by admin sign-off
    sqlReturnQueue.push([]);                                 // 9. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_30' }));

    expect(mockBuildOnboardingDay30Html).toHaveBeenCalledWith({
      businessName: 'Drip Test Biz',
      ownerName: 'Jane',
      totalReviews: 15,
      responseRateBefore: 25,  // 5/20 * 100 = 25
      responseRateNow: 80,     // 12/15 * 100 = 80
      timeSavedMinutes: 84,    // 12 * 7
      rankingChange: { keyword: 'pizza near me', from: 8, to: 3 },
      supportContactName: 'Admin Pat',
    });

    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'jane@test.com',
      subject: 'Your first month with RepWorth — Drip Test Biz',
      bodyHtml: '<html>day30</html>',
      category: 'marketing',
      idempotencyKey: 'onboarding_drip_day_30:biz-drip-1',
    });

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith(mockSql, {
      businessId: 'biz-drip-1',
      channel: 'email',
      recipient: 'jane@test.com',
      template: 'onboarding_drip_day_30',
      externalMessageId: 'msg-drip-1',
    });
  });

  it('day_30: looks up staff sign-off from admin users only', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);       // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);   // 2. claim drip_log — success
    sqlReturnQueue.push([{ id: 'user-1' }]);         // 3. owner with auth

    sqlReturnQueue.push([{ total: 15 }]);            // 4. total reviews
    sqlReturnQueue.push([{ responded: 12 }]);        // 5. responded
    sqlReturnQueue.push([]);                         // 6. no latest ranking
    sqlReturnQueue.push([{ name: 'Admin Pat' }]);    // 7. onboarded_by admin sign-off
    sqlReturnQueue.push([]);                         // 8. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_30' }));

    const statements = mockSql.mock.calls
      .map(([strings]: [TemplateStringsArray]) => strings.join(' ? '))
      .join('\n');
    // The sign-off is resolved from businesses.onboarded_by and still admits
    // only `admin`. The former `WHERE role = 'admin' AND business_id = …`
    // branch read a column migration 034 dropped and is gone (#719).
    expect(statements).toContain("u.role = 'admin'");
    expect(statements).not.toContain('sales_partner');
    expect(mockBuildOnboardingDay30Html).toHaveBeenCalledWith(
      expect.objectContaining({ supportContactName: 'Admin Pat' }),
    );
  });

  it('day_30: sends without ranking when no data', async () => {
    sqlReturnQueue.push([mockBusinessRow({
      initial_review_count: null,
      initial_responded_count: null,
    })]);                                    // 1. business — no baseline
    sqlReturnQueue.push([{ id: 'drip-log-id' }]); // 2. claim drip_log — success
    sqlReturnQueue.push([{ id: 'user-1' }]); // 3. owner with auth

    sqlReturnQueue.push([{ total: 3 }]);     // 4. total reviews
    sqlReturnQueue.push([{ responded: 3 }]); // 5. responded
    sqlReturnQueue.push([]);                  // 6. no latest ranking (skips earliest)
    sqlReturnQueue.push([]);                  // 7. no onboarded_by admin sign-off
    sqlReturnQueue.push([]);                  // 8. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_30' }));

    expect(mockBuildOnboardingDay30Html).toHaveBeenCalledWith({
      businessName: 'Drip Test Biz',
      ownerName: 'Jane',
      totalReviews: 3,
      responseRateBefore: null,
      responseRateNow: 100,
      timeSavedMinutes: 21,
      rankingChange: null,
      supportContactName: null,
    });

    expect(mockSendInternalEmail).toHaveBeenCalled();
  });

  // ── Drip log idempotency ───────────────────────────────────────────

  it('skips when drip_log already sent or claimed by another fresh job', async () => {
    sqlReturnQueue.push([mockBusinessRow()]); // 1. business
    sqlReturnQueue.push([]);                  // 2. INSERT conflict — row exists
    sqlReturnQueue.push([]);                  // 3. UPDATE takeover fails (sent or fresh claim by other outbox)

    await handleOnboardingDrip(makeJob({ drip_type: 'day_1' }));

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-drip-1', undefined);
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
  });

  it('retries stale claim and sends successfully', async () => {
    sqlReturnQueue.push([mockBusinessRow()]); // 1. business
    sqlReturnQueue.push([]);                  // 2. INSERT conflict — row exists
    sqlReturnQueue.push([{ id: 'stale-id' }]); // 3. UPDATE takeover succeeds (stale or same outbox)
    sqlReturnQueue.push([{ id: 'auth-user' }]); // 4. owner auth check
    sqlReturnQueue.push([]);                  // 5. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_1' }));

    expect(mockSendInternalEmail).toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
    expect(mockRecordNotificationDelivery).toHaveBeenCalled();
  });
});

// ── Send idempotency key (#1363) ───────────────────────────────────────────
// The keyed drips (day_1, day_30) send THEN mark sent_at; day_7 marks first and
// carries no key, because its body varies per attempt. A crash in the keyed gap
// leaves sent_at NULL, and the takeover branch re-enters and sends a second
// welcome email — which the key suppresses at the provider. The key is scoped to (business_id, drip_type) — matching
// onboarding_drip_log's UNIQUE constraint — precisely BECAUSE the takeover
// admits a SECOND outbox row, which an outbox-scoped key could not dedupe.

describe('OnboardingDripWorker – Send idempotency key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.repworth.com';
    process.env.RESEND_FROM_EMAIL = 'RepWorth <noreply@repworth.com>';
  });

  /** Queue for a plain day_1 run: business, claim, owner auth, UPDATE sent_at. */
  function queueDay1() {
    sqlReturnQueue.push([mockBusinessRow()]);
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);
    sqlReturnQueue.push([{ id: 'user-1' }]);
    sqlReturnQueue.push([]);
  }

  it('day_1 drip sends with an idempotency key scoped to the business and drip type', async () => {
    queueDay1();

    await handleOnboardingDrip(makeJob({ drip_type: 'day_1' }));

    expect(mockSendInternalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'onboarding_drip_day_1:biz-drip-1' }),
    );
  });

  it('a keyed drip marks sent_at AFTER the send, not before', async () => {
    // The NEGATIVE half of dripBodyVariesPerAttempt. Red-team round 2 found
    // that mutating `if (bodyVaries)` to `if (true)` left all 22 drip tests
    // green: only day_7's ordering had an oracle, so nothing stopped day_1 and
    // day_30 from silently adopting the lossy mark-before-send path.
    queueDay1();

    const sqlTextsBeforeSend: string[] = [];
    mockSendInternalEmail.mockImplementation(() => {
      for (const call of mockSql.mock.calls as unknown[][]) {
        sqlTextsBeforeSend.push((call[0] as string[]).join(''));
      }
      return Promise.resolve({ messageId: 'msg-drip-1' });
    });

    await handleOnboardingDrip(makeJob({ drip_type: 'day_1' }));

    expect(
      sqlTextsBeforeSend.some((text) => /UPDATE onboarding_drip_log SET sent_at/i.test(text)),
    ).toBe(false);
    const allTexts = (mockSql.mock.calls as unknown[][]).map((call) =>
      (call[0] as string[]).join(''),
    );
    expect(allTexts.some((text) => /UPDATE onboarding_drip_log SET sent_at/i.test(text))).toBe(true);
  });

  it('a day_7 send failure records a durable outbox failure instead of a silent completion', async () => {
    // sent_at is already committed, so no retry can deliver this drip. Marking
    // the outbox COMPLETED would record a success for mail that never went out.
    sqlReturnQueue.push([mockBusinessRow()]);      // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);  // 2. claim
    sqlReturnQueue.push([{ id: 'user-1' }]);       // 3. owner auth
    sqlReturnQueue.push([{ reviews_handled: 1 }]); // 4. reviews handled
    sqlReturnQueue.push([]);                       // 5. no highlight
    sqlReturnQueue.push([]);                       // 6. no edits
    sqlReturnQueue.push([]);                       // 7. no pending reviews
    sqlReturnQueue.push([{ total: 2 }]);           // 8. total reviews
    sqlReturnQueue.push([]);                       // 9. UPDATE sent_at (pre-send)
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend 503'));

    await expect(handleOnboardingDrip(makeJob({ drip_type: 'day_7' }))).resolves.toBeUndefined();

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-drip-1',
      expect.stringContaining('send failed after mark'),
      undefined,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockRecordNotificationDelivery).not.toHaveBeenCalled();
  });

  it('a keyed drip send failure still rethrows so BullMQ can retry and deliver', async () => {
    // sent_at is still NULL on the keyed path, so a retry CAN legitimately
    // deliver under the same key. Swallowing here would lose the drip for no
    // reason.
    queueDay1();
    mockSendInternalEmail.mockRejectedValueOnce(new Error('Resend 503'));

    await expect(handleOnboardingDrip(makeJob({ drip_type: 'day_1' }))).rejects.toThrow('Resend 503');

    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('day_7 drip marks sent_at before sending and passes no idempotency key', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);      // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);  // 2. claim
    sqlReturnQueue.push([{ id: 'user-1' }]);       // 3. owner auth
    sqlReturnQueue.push([{ reviews_handled: 2 }]); // 4. reviews handled
    sqlReturnQueue.push([]);                       // 5. no highlight
    sqlReturnQueue.push([]);                       // 6. no edits
    sqlReturnQueue.push([]);                       // 7. no pending reviews
    sqlReturnQueue.push([{ total: 4 }]);           // 8. total reviews
    sqlReturnQueue.push([]);                       // 9. UPDATE sent_at

    // day_7 is the ONLY drip carrying approval links, and createApprovalLink
    // mints a fresh token per call, so its body differs on every attempt. A key
    // would draw Resend's 409 rather than a replay of the original response,
    // and the synthetic message id would break the hard-bounce correlation in
    // worker/ingress/resend.ts. It marks sent_at first instead.
    const sqlCallsBeforeSend: string[] = [];
    mockSendInternalEmail.mockImplementation(() => {
      for (const call of mockSql.mock.calls as unknown[][]) {
        sqlCallsBeforeSend.push((call[0] as string[]).join(''));
      }
      return Promise.resolve({ messageId: 'msg-drip-1' });
    });

    await handleOnboardingDrip(makeJob({ drip_type: 'day_7' }));

    const sendArg = (mockSendInternalEmail.mock.calls as unknown[][])[0]![0] as {
      idempotencyKey?: string;
    };
    expect(sendArg.idempotencyKey).toBeUndefined();
    expect(
      sqlCallsBeforeSend.some((text) => /UPDATE onboarding_drip_log SET sent_at/i.test(text)),
    ).toBe(true);
  });

  it('day_30 drip sends with an idempotency key scoped to the business and drip type', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);     // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]); // 2. claim
    sqlReturnQueue.push([{ id: 'user-1' }]);      // 3. owner auth
    sqlReturnQueue.push([{ total: 15 }]);         // 4. total reviews
    sqlReturnQueue.push([{ responded: 12 }]);     // 5. responded
    sqlReturnQueue.push([]);                      // 6. no ranking
    sqlReturnQueue.push([]);                      // 7. onboarded_by sign-off
    sqlReturnQueue.push([]);                      // 8. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_30' }));

    expect(mockSendInternalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'onboarding_drip_day_30:biz-drip-1' }),
    );
  });

  it('a drip taken over by a second outbox row reuses the same idempotency key', async () => {
    // This is the defect the issue names. Attempt 1 sends and crashes before
    // marking sent_at; 15 minutes later a DIFFERENT outbox row takes the claim
    // over. Two rows, two outbox ids — so only a (business, drip_type) key can
    // dedupe them at the provider.
    queueDay1();
    await handleOnboardingDrip({
      data: { business_id: 'biz-drip-1', drip_type: 'day_1', outbox_id: 'outbox-first' },
      id: 'outbox-first',
    } as unknown as Job<OnboardingDripPayload>);

    sqlReturnQueue.push([mockBusinessRow()]);   // 1. business
    sqlReturnQueue.push([]);                    // 2. INSERT conflict — row exists
    sqlReturnQueue.push([{ id: 'stale-id' }]);  // 3. takeover succeeds
    sqlReturnQueue.push([{ id: 'user-1' }]);    // 4. owner auth
    sqlReturnQueue.push([]);                    // 5. UPDATE sent_at
    await handleOnboardingDrip({
      data: { business_id: 'biz-drip-1', drip_type: 'day_1', outbox_id: 'outbox-second' },
      id: 'outbox-second',
    } as unknown as Job<OnboardingDripPayload>);

    const keys = (mockSendInternalEmail.mock.calls as unknown[][]).map(
      (call) => (call[0] as { idempotencyKey?: string }).idempotencyKey,
    );
    expect(keys).toEqual([
      'onboarding_drip_day_1:biz-drip-1',
      'onboarding_drip_day_1:biz-drip-1',
    ]);
  });

  it('a drip replay logs that the email was already delivered', async () => {
    // Red-team round 1 (P1): the replay branch's worker-side delta — the
    // `idempotentReplay` destructuring and its log line — could be deleted with
    // every test still green, because the durable record (the delivery row's
    // `idempotent-replay:` prefix) is written from `messageId` regardless. The
    // log is the operator's live signal, so it gets its own oracle.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockSendInternalEmail.mockResolvedValueOnce({
        messageId: 'idempotent-replay:onboarding_drip_day_1:biz-drip-1',
        idempotentReplay: true,
      });
      queueDay1();

      await handleOnboardingDrip(makeJob({ drip_type: 'day_1' }));

      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => /already delivered under its idempotency key/.test(line))).toBe(
        true,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a drip replay marks sent_at and records the delivery with an idempotent-replay message id', async () => {
    // Resend refused the send because the key was already used. The email IS
    // delivered, so every downstream fact must still be written — otherwise the
    // claim stays open and a third attempt tries again.
    mockSendInternalEmail.mockResolvedValueOnce({
      messageId: 'idempotent-replay:onboarding_drip_day_1:biz-drip-1',
      idempotentReplay: true,
    });
    queueDay1();

    await handleOnboardingDrip(makeJob({ drip_type: 'day_1' }));

    const sentAtUpdate = (mockSql.mock.calls as unknown[][]).find((call) =>
      /UPDATE onboarding_drip_log SET sent_at/i.test((call[0] as string[]).join('')),
    );
    expect(sentAtUpdate).toBeDefined();
    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        template: 'onboarding_drip_day_1',
        externalMessageId: 'idempotent-replay:onboarding_drip_day_1:biz-drip-1',
      }),
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-drip-1', undefined);
  });

  it('day_7 drip keeps revokeMode orphaned_only now that it no longer relies on a provider key', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);      // 1. business
    sqlReturnQueue.push([{ id: 'drip-log-id' }]);  // 2. claim
    sqlReturnQueue.push([{ id: 'user-1' }]);       // 3. owner auth
    sqlReturnQueue.push([{ reviews_handled: 2 }]); // 4. reviews handled
    sqlReturnQueue.push([]);                       // 5. no highlight
    sqlReturnQueue.push([]);                       // 6. no edits
    sqlReturnQueue.push([                          // 7. one pending review
      { response_id: 'resp-p1', reviewer_name: 'Bob', star_rating: 3 },
    ]);
    sqlReturnQueue.push([{ total: 4 }]);           // 8. total reviews
    sqlReturnQueue.push([]);                       // 9. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_7' }));

    expect(mockCreateApprovalLink).toHaveBeenCalledWith(mockSql, {
      responseId: 'resp-p1',
      businessId: 'biz-drip-1',
      channel: 'email',
      revokeMode: 'orphaned_only',
    });
  });
});
