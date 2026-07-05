// src/lib/admin/__tests__/business-detail.test.ts
//
// Characterization test for getBusinessDetail — captures the FULL
// BusinessDetailResponse DTO before extracting queries/mappers.
// Mocking pattern modelled on denorm-queries.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockComputeChurnRiskScore } = vi.hoisted(() => ({
  mockComputeChurnRiskScore: vi.fn(() => ({
    score: 42,
    level: 'watch',
    breakdown: [{ signal: 'approvalRate', value: '0.5', contribution: 15 }],
  })),
}));

vi.mock('@/lib/shared/churn-score', () => ({
  computeChurnRiskScore: mockComputeChurnRiskScore,
}));

// business-detail-service.ts (and the queries/update modules it composes)
// no longer import the @/lib/db/server singleton — sql is an explicit
// parameter (A+ campaign 2b, T4) — so getBusinessDetail is handed the
// shared mock client directly instead of vi.mock'ing a module import.
const { mockSql, sqlReturnQueue, resetMockSql } = createMockSql();
const sql = mockSql as unknown as Sql;

// ── Helpers ─────────────────────────────────────────────────────────

const BUSINESS_ROW = {
  id: 'biz-abc',
  name: 'Main Street Cafe',
  category: 'restaurant',
  website: 'https://mainstreet.cafe',
  google_place_id: 'ChIJplace123',
  tone: 'friendly',
  products_services: 'coffee, pastries',
  staff_names: '{Alice,Bob}',
  highlight_facts: '{Great parking,Cozy atmosphere}',
  avoid_facts: '{No alcohol}',
  sample_responses: '{Thank you for visiting!}',
  subscription_status: 'active',
  subscription_tier: 'standard',
  owner_name: 'Alice Owner',
  owner_email: 'alice@cafe.com',
  last_sync_at: new Date('2026-05-01T10:00:00Z'),
  tracked_keywords: '{coffee,brunch}',
  google_place_lat: 51.5074,
  google_place_lng: -0.1278,
  ranking_search_location: 'London, UK',
  google_place_address: '1 Main Street, London',
  owner_email_bounced: false,
  account_id: 'acct-xyz',
  display_label: 'Main St',
  is_primary: true,
};

const REVIEW_ROW = {
  id: 'rev-1',
  reviewer_name: 'Happy Customer',
  star_rating: 5,
  review_text: 'Excellent coffee!',
  review_date: '2026-04-20',
  detected_language: 'en',
  review_status: 'response_approved',
  detected_at: new Date('2026-04-20T08:00:00Z'),
  response_id: 'resp-1',
  response_status: 'approved',
  response_text: 'Thank you so much!',
  approved_text: 'Thank you so much! We hope to see you again.',
  approval_method: 'auto_policy',
  version: 2,
};

const RANKING_ROW = {
  keyword: 'coffee shop',
  rank_position: 3,
  snapshot_date: '2026-05-10',
  source: 'google',
};

const ZERNIO_CONNECTION_ROW = {
  status: 'active' as const,
  connected_at: new Date('2026-03-01T09:00:00Z'),
  disconnected_at: null,
  disconnect_reason: null,
  last_error: null,
  last_error_at: null,
  zernio_account_id: 'zern-acct-1',
  zernio_location_id: 'zern-loc-1',
};

const AWAITING_ROW = {
  id: 'resp-2',
  created_at: new Date('2026-05-15T12:00:00Z'),
  draft_text: 'We look forward to seeing you!',
  reviewer_name: 'Pending Customer',
  review_text: 'Nice place.',
  star_rating: 4,
};

const FINALIZE_INCIDENT_ROW = {
  id: 'inc-1',
  finalize_unknown_at: new Date('2026-05-18T14:00:00Z'),
  flow_id: 'flow-abc',
  zernio_profile_id: 'profile-xyz',
};

const METRICS_ROW = {
  approval_rate: 0.75,
  notified_count: 8,
  pending_count: 2,
  days_since_approval: 3,
  account_age_days: 120,
  avg_hours_current: 4.5,
  avg_hours_prev: 3.0,
};

const ACCOUNT_LOCATION_ROWS = [
  {
    id: 'biz-abc',
    name: 'Main Street Cafe',
    display_label: 'Main St',
    is_primary: true,
    archived_at: null,
  },
  {
    id: 'biz-branch',
    name: 'East Branch',
    display_label: null,
    is_primary: false,
    archived_at: new Date('2026-01-01T00:00:00Z'),
  },
];

const APPROVAL_AUDIT_ROW = {
  id: 'aal-1',
  response_id: 'resp-1',
  action: 'auto_approved_by_policy',
  actor_user_id: 'user-owner',
  created_at: new Date('2026-05-05T15:00:00Z'),
  business_id: 'biz-abc',
  account_id: 'acct-xyz',
};

const ACCOUNT_AUDIT_ROW = {
  id: 'aaudit-1',
  event_type: 'auto_approval_policy_changed',
  actor_user_id: null,
  location_id: 'biz-branch',
  payload: { reason: 'closed' },
  created_at: new Date('2026-01-01T10:00:00Z'),
};

const AUTO_APPROVAL_POLICY_ROWS = [
  {
    id: 'auto-policy-account',
    account_id: 'acct-xyz',
    location_id: null,
    auto_approve_min_star: 5,
  },
  {
    id: 'auto-policy-branch',
    account_id: 'acct-xyz',
    location_id: 'biz-branch',
    auto_approve_min_star: null,
  },
];

const AUTO_APPROVAL_ACCOUNT_ROW = {
  subscription_status: 'active',
  past_due_at: null,
  flags: {},
};

/**
 * Queue results for all 12 queries in call order. The order and COUNT are
 * load-bearing: results are consumed positionally as `sql` is invoked
 * (batch-1's 6 parallel queries, then batch-2's 6). Adding/removing a query
 * in queries.ts means updating every manual push sequence in this file.
 */
function queueAllResults() {
  // Batch 1 (6 parallel queries)
  sqlReturnQueue.push([BUSINESS_ROW]);            // 0: business
  sqlReturnQueue.push([REVIEW_ROW]);              // 1: reviews
  sqlReturnQueue.push([RANKING_ROW]);             // 2: ranking_snapshots
  sqlReturnQueue.push([ZERNIO_CONNECTION_ROW]);   // 3: zernio_connections
  sqlReturnQueue.push([AWAITING_ROW]);            // 4: awaiting_owner_connect
  sqlReturnQueue.push([FINALIZE_INCIDENT_ROW]);   // 5: finalize_incidents
  // Batch 2 (4 parallel queries)
  sqlReturnQueue.push([METRICS_ROW]);             // 6: metrics CTE
  sqlReturnQueue.push(ACCOUNT_LOCATION_ROWS);     // 7: account locations
  sqlReturnQueue.push([APPROVAL_AUDIT_ROW]);      // 8: approval_audit_log
  sqlReturnQueue.push([ACCOUNT_AUDIT_ROW]);       // 9: account_audit_log
  sqlReturnQueue.push(AUTO_APPROVAL_POLICY_ROWS); // 10: auto_approval_policies
  sqlReturnQueue.push([AUTO_APPROVAL_ACCOUNT_ROW]); // 11: account readiness
}

// ── Tests ────────────────────────────────────────────────────────────

describe('getBusinessDetail — full DTO characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  it('returns the full BusinessDetailResponse DTO for a populated fixture', async () => {
    const { getBusinessDetail } = await import('@/lib/admin/business-detail-service');

    queueAllResults();

    const result = await getBusinessDetail(sql, 'biz-abc');

    expect(result).not.toBeNull();
    const res = result!;

    // ── business fields ─────────────────────────────────────────────

    expect(res.business.id).toBe('biz-abc');
    expect(res.business.name).toBe('Main Street Cafe');
    expect(res.business.category).toBe('restaurant');
    expect(res.business.website).toBe('https://mainstreet.cafe');
    expect(res.business.googlePlaceId).toBe('ChIJplace123');
    expect(res.business.tone).toBe('friendly');
    expect(res.business.productsServices).toBe('coffee, pastries');

    // parseDbArray: Postgres.js may return a JS array or the raw '{...}' string.
    // The characterization just verifies these are arrays (type guard), not the
    // exact parsed values which depend on the runtime representation in tests.
    expect(Array.isArray(res.business.staffNames)).toBe(true);
    expect(Array.isArray(res.business.highlightFacts)).toBe(true);
    expect(Array.isArray(res.business.avoidFacts)).toBe(true);
    expect(Array.isArray(res.business.sampleResponses)).toBe(true);
    expect(Array.isArray(res.business.trackedKeywords)).toBe(true);

    expect(res.business.subscriptionStatus).toBe('active');
    expect(res.business.subscriptionTier).toBe('standard');
    expect(res.business.ownerName).toBe('Alice Owner');
    expect(res.business.ownerEmail).toBe('alice@cafe.com');
    expect(res.business.lastSyncAt).toBe(new Date('2026-05-01T10:00:00Z').toISOString());
    expect(res.business.googlePlaceLat).toBe(51.5074);
    expect(res.business.googlePlaceLng).toBe(-0.1278);
    expect(res.business.rankingSearchLocation).toBe('London, UK');
    expect(res.business.googlePlaceAddress).toBe('1 Main Street, London');
    expect(res.business.ownerEmailBounced).toBe(false);

    // Env-flag channels — undefined env → boolean false
    expect(typeof res.business.telegramEnabled).toBe('boolean');
    expect(typeof res.business.whatsappEnabled).toBe('boolean');

    // churnScore — mocked to fixed value above
    expect(res.business.churnScore).toEqual({
      score: 42,
      level: 'watch',
      breakdown: [{ signal: 'approvalRate', value: '0.5', contribution: 15 }],
    });

    // ── account context ──────────────────────────────────────────────

    expect(res.account.id).toBe('acct-xyz');
    // displayName uses the primary business.name
    expect(res.account.displayName).toBe('Main Street Cafe');
    expect(res.account.subscriptionTier).toBe('standard');
    expect(res.account.subscriptionStatus).toBe('active');

    expect(res.account.locations).toHaveLength(2);
    expect(res.account.locations[0]).toEqual({
      id: 'biz-abc',
      name: 'Main Street Cafe',
      displayLabel: 'Main St',
      isPrimary: true,
      archivedAt: null,
    });
    expect(res.account.locations[1]).toEqual({
      id: 'biz-branch',
      name: 'East Branch',
      displayLabel: null,
      isPrimary: false,
      archivedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    });

    // ── rankingSnapshots ─────────────────────────────────────────────

    expect(res.rankingSnapshots).toHaveLength(1);
    expect(res.rankingSnapshots[0]).toEqual({
      keyword: 'coffee shop',
      rankPosition: 3,
      snapshotDate: '2026-05-10',
      source: 'google',
    });

    // ── reviews ─────────────────────────────────────────────────────

    expect(res.reviews).toHaveLength(1);
    expect(res.reviews[0]).toEqual({
      id: 'rev-1',
      reviewerName: 'Happy Customer',
      starRating: 5,
      reviewText: 'Excellent coffee!',
      reviewDate: '2026-04-20',
      detectedLanguage: 'en',
      detectedAt: new Date('2026-04-20T08:00:00Z').toISOString(),
      responseId: 'resp-1',
      responseStatus: 'approved',
      responseText: 'Thank you so much!',
      approvedText: 'Thank you so much! We hope to see you again.',
      approvalMethod: 'auto_policy',
      responseVersion: 2,
    });

    // ── zernio panel ─────────────────────────────────────────────────

    expect(res.zernio.connection).not.toBeNull();
    expect(res.zernio.connection).toEqual({
      status: 'active',
      connectedAt: new Date('2026-03-01T09:00:00Z').toISOString(),
      disconnectedAt: null,
      disconnectReason: null,
      lastError: null,
      lastErrorAt: null,
      zernioAccountId: 'zern-acct-1',
      zernioLocationId: 'zern-loc-1',
    });

    expect(res.zernio.awaitingOwnerConnect).toHaveLength(1);
    expect(res.zernio.awaitingOwnerConnect[0]).toEqual({
      responseId: 'resp-2',
      createdAt: new Date('2026-05-15T12:00:00Z').toISOString(),
      draftText: 'We look forward to seeing you!',
      reviewerName: 'Pending Customer',
      reviewText: 'Nice place.',
      starRating: 4,
    });

    expect(res.zernio.unresolvedIncidents).toHaveLength(1);
    expect(res.zernio.unresolvedIncidents[0]).toEqual({
      id: 'inc-1',
      finalizeUnknownAt: new Date('2026-05-18T14:00:00Z').toISOString(),
      flowId: 'flow-abc',
      zernioProfileId: 'profile-xyz',
    });

    // ── approvalAuditLog ─────────────────────────────────────────────

    expect(res.approvalAuditLog).toHaveLength(1);
    expect(res.approvalAuditLog[0]).toEqual({
      id: 'aal-1',
      responseId: 'resp-1',
      action: 'auto_approved_by_policy',
      actorUserId: 'user-owner',
      createdAt: new Date('2026-05-05T15:00:00Z').toISOString(),
    });

    // ── accountAuditLog ──────────────────────────────────────────────

    expect(res.accountAuditLog).toHaveLength(1);
    expect(res.accountAuditLog[0]).toEqual({
      id: 'aaudit-1',
      eventType: 'auto_approval_policy_changed',
      actorUserId: null,
      locationId: 'biz-branch',
      payload: { reason: 'closed' },
      createdAt: new Date('2026-01-01T10:00:00Z').toISOString(),
    });

    // ── autoApproval diagnostics ─────────────────────────────────────

    expect(res.autoApproval.accountDefault).toEqual({
      policyId: 'auto-policy-account',
      threshold: 5,
      exists: true,
    });
    expect(res.autoApproval.locations).toHaveLength(2);
    expect(res.autoApproval.locations[0]).toEqual({
      locationId: 'biz-abc',
      displayName: 'Main St',
      isPrimary: true,
      archivedAt: null,
      override: { policyId: null, threshold: null, exists: false },
      effective: {
        threshold: 5,
        source: 'account_default',
        policyId: 'auto-policy-account',
      },
    });
    expect(res.autoApproval.locations[1]!.override).toEqual({
      policyId: 'auto-policy-branch',
      threshold: null,
      exists: true,
    });
    expect(res.autoApproval.recentApprovalAudit[0]!.action).toBe('auto_approved_by_policy');
    expect(res.autoApproval.recentPolicyChanges[0]!.eventType).toBe('auto_approval_policy_changed');
    expect(res.autoApproval.readiness.runtimeEnabled).toBe(false);
    expect(res.autoApproval.readiness.blockReasons).toContain('auto_approval_disabled');
  });

  it('returns null when the business row is not found (empty batch-1 business query)', async () => {
    const { getBusinessDetail } = await import('@/lib/admin/business-detail-service');

    // Batch 1 — business query returns empty; remaining batch-1 results won't
    // be consumed because Promise.all resolves before the null guard fires.
    sqlReturnQueue.push([]);   // 0: business → empty → returns null
    sqlReturnQueue.push([]);   // 1: reviews (consumed in parallel)
    sqlReturnQueue.push([]);   // 2: ranking_snapshots
    sqlReturnQueue.push([]);   // 3: zernio
    sqlReturnQueue.push([]);   // 4: awaiting_owner_connect
    sqlReturnQueue.push([]);   // 5: finalize_incidents
    // Batch 2 never runs when business is null

    const result = await getBusinessDetail(sql, 'non-existent-id');

    expect(result).toBeNull();
  });

  it('maps responseTimeTrend=slower when avg_hours_current > avg_hours_prev * 1.5', async () => {
    const { getBusinessDetail } = await import('@/lib/admin/business-detail-service');

    queueAllResults();
    // Override the metrics row (index 6) with slower trend data.
    // We queued 12 results; replace index 6 (already queued) — easier to
    // just re-queue all with the override.
    sqlReturnQueue.length = 0;

    sqlReturnQueue.push([BUSINESS_ROW]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    // metrics: current=10h, prev=4h → 10 > 4*1.5=6 → 'slower'
    sqlReturnQueue.push([{
      approval_rate: 0.5,
      notified_count: 5,
      pending_count: 1,
      days_since_approval: 2,
      account_age_days: 60,
      avg_hours_current: 10.0,
      avg_hours_prev: 4.0,
    }]);
    sqlReturnQueue.push([{ id: 'biz-abc', name: 'Main Street Cafe', display_label: 'Main St', is_primary: true, archived_at: null }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([AUTO_APPROVAL_ACCOUNT_ROW]);

    const result = await getBusinessDetail(sql, 'biz-abc');
    expect(result).not.toBeNull();
    // responseTimeTrend is fed into computeChurnRiskScore; assert the derived value.
    expect(mockComputeChurnRiskScore).toHaveBeenCalledWith(
      expect.objectContaining({ responseTimeTrend: 'slower' }),
    );
  });

  it('maps responseTimeTrend=stopped when pending > 0 and days_since_approval > 7 (no current/prev hours)', async () => {
    const { getBusinessDetail } = await import('@/lib/admin/business-detail-service');

    sqlReturnQueue.push([BUSINESS_ROW]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{
      approval_rate: null,
      notified_count: 0,
      pending_count: 3,
      days_since_approval: 10,
      account_age_days: 45,
      avg_hours_current: null,
      avg_hours_prev: null,
    }]);
    sqlReturnQueue.push([{ id: 'biz-abc', name: 'Main Street Cafe', display_label: null, is_primary: true, archived_at: null }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([AUTO_APPROVAL_ACCOUNT_ROW]);

    const result = await getBusinessDetail(sql, 'biz-abc');
    expect(result).not.toBeNull();
    // 'stopped' trend: pending > 0, days_since_approval > 7, no current/prev hours.
    expect(mockComputeChurnRiskScore).toHaveBeenCalledWith(
      expect.objectContaining({ responseTimeTrend: 'stopped' }),
    );
  });

  it('handles null last_sync_at and null detected_at gracefully', async () => {
    const { getBusinessDetail } = await import('@/lib/admin/business-detail-service');

    const businessWithNullDates = { ...BUSINESS_ROW, last_sync_at: null };
    const reviewWithNullDates = { ...REVIEW_ROW, detected_at: null };

    sqlReturnQueue.push([businessWithNullDates]);
    sqlReturnQueue.push([reviewWithNullDates]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ ...METRICS_ROW }]);
    sqlReturnQueue.push([{ id: 'biz-abc', name: 'Main Street Cafe', display_label: null, is_primary: true, archived_at: null }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([AUTO_APPROVAL_ACCOUNT_ROW]);

    const result = await getBusinessDetail(sql, 'biz-abc');
    expect(result).not.toBeNull();
    expect(result!.business.lastSyncAt).toBeNull();
    expect(result!.reviews[0]!.detectedAt).toBeNull();
  });

  it('handles null zernio connection (no zernio rows) — connection field is null', async () => {
    const { getBusinessDetail } = await import('@/lib/admin/business-detail-service');

    sqlReturnQueue.push([BUSINESS_ROW]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]); // no zernio connection row
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ ...METRICS_ROW }]);
    sqlReturnQueue.push([{ id: 'biz-abc', name: 'Main Street Cafe', display_label: null, is_primary: true, archived_at: null }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([AUTO_APPROVAL_ACCOUNT_ROW]);

    const result = await getBusinessDetail(sql, 'biz-abc');
    expect(result).not.toBeNull();
    expect(result!.zernio.connection).toBeNull();
  });
});
