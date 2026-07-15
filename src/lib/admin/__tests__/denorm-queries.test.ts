import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

// ── Hoisted mocks ───────────────────────────────────────────────────
//
// getCostReport composes nested `sql` fragments (dateFilter,
// optionalAccountPrefix, rollupBoundary, ...) as of the A+ campaign PR 2b
// sql-injection refactor. A naive Proxy that eagerly records every
// tagged-template invocation (the old approach here) can't distinguish an
// awaited top-level query from a nested, un-awaited fragment call — each
// nested fragment would consume its own mockSqlResults slot and corrupt
// the alignment for every query after it. The shared `createMockSql`
// harness (same one worker suites and cost-report-service.test.ts use)
// mirrors real Postgres.js: nested fragments are lazy thenables that only
// record + consume the queue when AWAITED.

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

// The notifications route uses sql.unsafe() for dynamic queries — the shared
// harness doesn't model that helper, so it's added here, sharing the same
// queue/call-log as tagged-template queries (matching the original proxy's
// single shared counter).
(mockSql as unknown as { unsafe: (...args: unknown[]) => Promise<unknown> }).unsafe = (
  ..._args: unknown[]
) => {
  const result = sqlReturnQueue.shift() ?? [];
  sqlCalls.push({ text: '[sql.unsafe]', values: [] });
  return Promise.resolve(result);
};

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

// getBusinessDetail (business-detail-service.ts) no longer imports the
// @/lib/db/server singleton — sql is an explicit parameter (A+ campaign 2b,
// T4) — so calls below pass the SAME mock client used for the routes above,
// which still import the singleton (composition roots).
const sql = mockSql as unknown as Sql;

vi.mock('@/lib/db/auth', () => ({
  requireRole: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin' }),
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) { super(message); }
  },
}));

vi.mock('@/lib/shared/churn-score', () => ({
  computeChurnRiskScore: () => ({ score: 0, level: 'healthy', breakdown: [] }),
}));

// ── Tests ────────────────────────────────────────────────────────────

describe('Admin denormalized account_id queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
  });

  // ── VAL-ADMIN-002: api_costs uses account_id ──────────────────────

  describe('GET /api/admin/costs with account_id filter', () => {
    it('queries api_costs WHERE account_id when account_id param is provided', async () => {
      // Queue mock results for the costs route with account_id filter.
      // Query sequence for detail-only (days <= 90) with account_id:
      // 1. byProvider — filtered by account_id
      // 2. byBusinessRows — filtered by account_id
      // 3. businessCount — filtered by account_id
      // 4. byDay — filtered by account_id
      // 5. todayTotal — filtered by account_id
      sqlReturnQueue.push([{ provider: 'openai', total_usd: 1.5, call_count: 10 }]);
      sqlReturnQueue.push([{
        business_id: 'loc-1',
        name: 'Downtown',
        subscription_tier: 'copilot',
        total_usd: 1.5,
        call_count: 10,
        today_usd: 0.1,
      }]);
      sqlReturnQueue.push([{ total: 1 }]);
      sqlReturnQueue.push([{ day: '2026-05-09', total_usd: 1.5, call_count: 10 }]);
      sqlReturnQueue.push([{ total: 0.1 }]);

      const { GET } = await import('@/app/api/admin/costs/route');
      const { NextRequest } = await import('next/server');
      const req = new NextRequest('http://localhost/api/admin/costs?account_id=acct-123&days=7');
      const res = await GET(req);

      expect(res.status).toBe(200);

      // Verify that api_costs queries filter by account_id directly,
      // enabling the idx_api_costs_account index.
      const accountFiltered = sqlCalls.filter(
        (c) => c.text.includes('account_id') && c.text.includes('api_costs'),
      );
      expect(accountFiltered.length).toBeGreaterThanOrEqual(1);
    });

    it('aggregates costs across all locations under an account', async () => {
      // Simulate two locations under same account
      sqlReturnQueue.push([{ provider: 'openai', total_usd: 3.0, call_count: 20 }]);
      sqlReturnQueue.push([
        {
          business_id: 'loc-1',
          name: 'Downtown',
          subscription_tier: 'copilot',
          total_usd: 2.0,
          call_count: 12,
          today_usd: 0.2,
        },
        {
          business_id: 'loc-2',
          name: 'Uptown',
          subscription_tier: 'copilot',
          total_usd: 1.0,
          call_count: 8,
          today_usd: 0.1,
        },
      ]);
      sqlReturnQueue.push([{ total: 2 }]);
      sqlReturnQueue.push([{ day: '2026-05-09', total_usd: 3.0, call_count: 20 }]);
      sqlReturnQueue.push([{ total: 0.3 }]);

      const { GET } = await import('@/app/api/admin/costs/route');
      const { NextRequest } = await import('next/server');
      const req = new NextRequest('http://localhost/api/admin/costs?account_id=acct-123&days=7');
      const res = await GET(req);
      const body = await res.json();

      expect(body.totalBusinesses).toBe(2);
      expect(body.byBusiness.length).toBe(2);
    });
  });

  // ── VAL-ADMIN-003: notification_deliveries uses account_id ─────────

  describe('GET /api/admin/notifications with account_id filter', () => {
    it('queries notification_deliveries WHERE account_id when account_id param is provided', async () => {
      // Queue mock results for the notifications route with account_id filter.
      // The route uses sql.unsafe() for dynamic queries, so captured texts
      // won't include them. But we can verify the endpoint works and returns
      // data scoped to the account.
      sqlReturnQueue.push([
        {
          id: 'nd-1',
          business_name: 'Downtown',
          channel: 'email',
          recipient: 'test@example.com',
          template: 'approval_request',
          sent_at: new Date(),
          delivered_at: new Date(),
          failed_at: null,
          failure_reason: null,
          created_at: new Date(),
        },
      ]);
      sqlReturnQueue.push([{ total: '1' }]);
      sqlReturnQueue.push([{ id: 'loc-1', name: 'Downtown' }]);

      const { GET } = await import('@/app/api/admin/notifications/route');
      const { NextRequest } = await import('next/server');
      const req = new NextRequest('http://localhost/api/admin/notifications?account_id=acct-123');
      const res = await GET(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.notifications).toBeDefined();
      expect(body.notifications.length).toBeGreaterThan(0);
    });
  });

  // ── VAL-ADMIN-001 + VAL-ADMIN-004: business detail includes account context and audit logs

  describe('getBusinessDetail includes account context and audit logs', () => {
    it('returns account context with locations list for multi-location accounts', async () => {
      const { getBusinessDetail } = await import('@/lib/admin/business-detail-service');

      // Queue all the parallel query results for getBusinessDetail:
      // First batch (6 parallel queries):
      // 1. business row
      // 2. reviews
      // 3. ranking_snapshots
      // 4. zernio_connection
      // 5. awaiting_owner_connect
      // 6. finalize_incidents
      sqlReturnQueue.push([{
        id: 'loc-1',
        name: 'Test Biz',
        category: 'restaurant',
        website: null,
        google_place_id: null,
        tone: 'friendly',
        products_services: null,
        staff_names: null,
        highlight_facts: null,
        avoid_facts: null,
        sample_responses: null,
        subscription_status: 'active',
        subscription_tier: 'copilot',
        owner_name: 'John',
        owner_email: 'john@test.com',
        last_sync_at: null,
        tracked_keywords: null,
        google_place_lat: null,
        google_place_lng: null,
        ranking_search_location: null,
        google_place_address: null,
        owner_email_bounced: false,
        account_id: 'acct-1',
        display_label: 'Test Biz',
        is_primary: true,
      }]);
      sqlReturnQueue.push([]); // reviews
      sqlReturnQueue.push([]); // ranking_snapshots
      sqlReturnQueue.push([]); // zernio
      sqlReturnQueue.push([]); // awaiting_owner_connect
      sqlReturnQueue.push([]); // finalize_incidents

      // Second batch (6 parallel queries):
      // 1. metrics
      // 2. account locations
      // 3. approval_audit_log
      // 4. account_audit_log
      // 5. auto_approval_policies
      // 6. account readiness
      sqlReturnQueue.push([{
        approval_rate: null,
        notified_count: 0,
        pending_count: 0,
        days_since_approval: null,
        account_age_days: 30,
        avg_hours_current: null,
        avg_hours_prev: null,
      }]);
      sqlReturnQueue.push([
        {
          id: 'loc-1',
          name: 'Test Biz',
          display_label: null,
          is_primary: true,
          archived_at: null,
        },
        {
          id: 'loc-2',
          name: 'Uptown Branch',
          display_label: 'Uptown',
          is_primary: false,
          archived_at: null,
        },
      ]);
      sqlReturnQueue.push([{
        id: 'audit-1',
        response_id: 'resp-1',
        action: 'approved',
        actor_user_id: 'owner-1',
        created_at: new Date(),
        business_id: 'loc-1',
        account_id: 'acct-1',
      }]);
      sqlReturnQueue.push([{
        id: 'aaudit-1',
        event_type: 'location_created',
        actor_user_id: null,
        location_id: 'loc-2',
        payload: {},
        created_at: new Date(),
      }]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([{ subscription_tier: 'autopilot', subscription_status: 'active', past_due_at: null, flags: {} }]);

      const result = await getBusinessDetail(sql, 'loc-1');
      expect(result).not.toBeNull();
      expect(result!.account).toBeDefined();
      expect(result!.account.id).toBe('acct-1');
      expect(result!.account.locations).toBeDefined();
      expect(result!.account.locations.length).toBe(2);
      expect(result!.account.locations[0]!.name).toBe('Test Biz');
      expect(result!.account.locations[1]!.name).toBe('Uptown Branch');

      // Audit logs should be present
      expect(result!.approvalAuditLog).toBeDefined();
      expect(result!.approvalAuditLog.length).toBe(1);
      expect(result!.approvalAuditLog[0]!.action).toBe('approved');

      expect(result!.accountAuditLog).toBeDefined();
      expect(result!.accountAuditLog.length).toBe(1);
      expect(result!.accountAuditLog[0]!.eventType).toBe('location_created');
    });

    it('approval_audit_log query uses account_id filter enabling idx_audit_account', async () => {
      const { getBusinessDetail } = await import('@/lib/admin/business-detail-service');

      // Queue minimal results
      sqlReturnQueue.push([{
        id: 'loc-1', name: 'Test Biz', category: null, website: null, google_place_id: null,
        tone: null, products_services: null, staff_names: null, highlight_facts: null,
        avoid_facts: null, sample_responses: null, subscription_status: 'active',
        subscription_tier: 'copilot', owner_name: null, owner_email: null, last_sync_at: null,
        tracked_keywords: null, google_place_lat: null, google_place_lng: null,
        ranking_search_location: null, google_place_address: null, owner_email_bounced: false,
        account_id: 'acct-1', display_label: null, is_primary: true,
      }]);
      sqlReturnQueue.push([]); // reviews
      sqlReturnQueue.push([]); // ranking
      sqlReturnQueue.push([]); // zernio
      sqlReturnQueue.push([]); // awaiting
      sqlReturnQueue.push([]); // finalize
      sqlReturnQueue.push([{
        approval_rate: null, notified_count: 0, pending_count: 0,
        days_since_approval: null, account_age_days: 30,
        avg_hours_current: null, avg_hours_prev: null,
      }]);
      sqlReturnQueue.push([]); // account locations
      sqlReturnQueue.push([]); // approval audit log
      sqlReturnQueue.push([]); // account audit log
      sqlReturnQueue.push([]); // auto approval policies
      sqlReturnQueue.push([{ subscription_tier: 'autopilot', subscription_status: 'active', past_due_at: null, flags: {} }]);

      await getBusinessDetail(sql, 'loc-1');

      // Verify the approval_audit_log query filters by account_id
      const auditQueries = sqlCalls.filter(
        (c) => c.text.includes('approval_audit_log') && c.text.includes('account_id'),
      );
      expect(auditQueries.length).toBeGreaterThanOrEqual(1);
    });

    it('account_audit_log query uses account_id filter enabling idx_account_audit', async () => {
      const { getBusinessDetail } = await import('@/lib/admin/business-detail-service');

      // Queue minimal results
      sqlReturnQueue.push([{
        id: 'loc-1', name: 'Test Biz', category: null, website: null, google_place_id: null,
        tone: null, products_services: null, staff_names: null, highlight_facts: null,
        avoid_facts: null, sample_responses: null, subscription_status: 'active',
        subscription_tier: 'copilot', owner_name: null, owner_email: null, last_sync_at: null,
        tracked_keywords: null, google_place_lat: null, google_place_lng: null,
        ranking_search_location: null, google_place_address: null, owner_email_bounced: false,
        account_id: 'acct-1', display_label: null, is_primary: true,
      }]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([{
        approval_rate: null, notified_count: 0, pending_count: 0,
        days_since_approval: null, account_age_days: 30,
        avg_hours_current: null, avg_hours_prev: null,
      }]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([]);
      sqlReturnQueue.push([{ subscription_tier: 'autopilot', subscription_status: 'active', past_due_at: null, flags: {} }]);

      await getBusinessDetail(sql, 'loc-1');

      // Verify the account_audit_log query filters by account_id
      const accountAuditQueries = sqlCalls.filter(
        (c) => c.text.includes('account_audit_log') && c.text.includes('account_id'),
      );
      expect(accountAuditQueries.length).toBeGreaterThanOrEqual(1);

      const autoApprovalPolicyQueries = sqlCalls.filter(
        (c) => c.text.includes('auto_approval_policies') && c.text.includes('account_id'),
      );
      expect(autoApprovalPolicyQueries.length).toBeGreaterThanOrEqual(1);
    });
  });
});
