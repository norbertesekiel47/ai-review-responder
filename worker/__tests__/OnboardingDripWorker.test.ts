import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { OnboardingDripPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
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

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('../../src/lib/notifications/email', () => ({
  sendInternalEmail: mockSendInternalEmail,
  buildOnboardingDay1Html: mockBuildOnboardingDay1Html,
  buildOnboardingDay7Html: mockBuildOnboardingDay7Html,
  buildOnboardingDay30Html: mockBuildOnboardingDay30Html,
}));
vi.mock('../../src/lib/notifications/delivery', () => ({
  recordNotificationDelivery: mockRecordNotificationDelivery,
}));
vi.mock('../../src/lib/approval/create-link', () => ({
  createApprovalLink: mockCreateApprovalLink,
}));

import { handleOnboardingDrip } from '../jobs/OnboardingDripWorker';

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
    updated_at: new Date(),
    initial_review_count: 20,
    initial_responded_count: 5,
    subscription_activated_at: new Date('2026-04-01T00:00:00Z'),
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

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-drip-1', 'business_not_found');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('skips when subscription is not active (completes outbox)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleOnboardingDrip(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-drip-1');
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('skips when subscription is pending_payment', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'pending_payment' })]);

    await handleOnboardingDrip(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-drip-1');
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

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-drip-1');

    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'jane@test.com',
      subject: 'Welcome to RepWorth, Jane!',
      bodyHtml: '<html>day1</html>',
      category: 'marketing',
    });

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith({
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

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith({
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
    expect(mockCreateApprovalLink).toHaveBeenCalledWith({
      responseId: 'resp-p1',
      businessId: 'biz-drip-1',
      channel: 'email',
      revokeMode: 'orphaned_only',
    });
    expect(mockCreateApprovalLink).toHaveBeenCalledWith({
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
    sqlReturnQueue.push([{ name: 'Sales Pat' }]);           // 8. sales partner (scoped)
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
      salesPartnerName: 'Sales Pat',
    });

    expect(mockSendInternalEmail).toHaveBeenCalledWith({
      to: 'jane@test.com',
      subject: 'Your first month with RepWorth — Drip Test Biz',
      bodyHtml: '<html>day30</html>',
      category: 'marketing',
    });

    expect(mockRecordNotificationDelivery).toHaveBeenCalledWith({
      businessId: 'biz-drip-1',
      channel: 'email',
      recipient: 'jane@test.com',
      template: 'onboarding_drip_day_30',
      externalMessageId: 'msg-drip-1',
    });
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
    sqlReturnQueue.push([]);                  // 7. no scoped sales partner
    sqlReturnQueue.push([]);                  // 8. no onboarder fallback
    sqlReturnQueue.push([]);                  // 9. UPDATE sent_at

    await handleOnboardingDrip(makeJob({ drip_type: 'day_30' }));

    expect(mockBuildOnboardingDay30Html).toHaveBeenCalledWith({
      businessName: 'Drip Test Biz',
      ownerName: 'Jane',
      totalReviews: 3,
      responseRateBefore: null,
      responseRateNow: 100,
      timeSavedMinutes: 21,
      rankingChange: null,
      salesPartnerName: null,
    });

    expect(mockSendInternalEmail).toHaveBeenCalled();
  });

  // ── Drip log idempotency ───────────────────────────────────────────

  it('skips when drip_log already sent or claimed by another fresh job', async () => {
    sqlReturnQueue.push([mockBusinessRow()]); // 1. business
    sqlReturnQueue.push([]);                  // 2. INSERT conflict — row exists
    sqlReturnQueue.push([]);                  // 3. UPDATE takeover fails (sent or fresh claim by other outbox)

    await handleOnboardingDrip(makeJob({ drip_type: 'day_1' }));

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-drip-1');
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
