// worker/jobs/notification/__tests__/context-archived.test.ts
//
// Tests for VAL-LOC-044: Location with in-flight approvals can be archived.
// When a location is archived, the notification worker skips dispatch.
// Pending responses remain pending_approval — they are NOT modified.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  return { mockSql: sqlFn };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
}));

import { loadNotificationContext } from '../context';

// ── Helpers ────────────────────────────────────────────────────────────────

const RESPONSE_ID = 'rrrrrrrr-0000-0000-0000-000000000001';
const BUSINESS_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const _ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function mockLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  };
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('loadNotificationContext — archived location', () => {
  // VAL-LOC-044: Skip notification dispatch for archived locations
  it('returns skip when the business is archived', async () => {
    const logger = mockLogger();

    // First query: response row (found, pending_approval)
    mockSql.mockResolvedValueOnce([{
      id: RESPONSE_ID,
      response_text: 'Thank you for your review!',
      status: 'pending_approval',
      resp_business_id: BUSINESS_ID,
      review_id: 'rvvvvvvv-0000-0000-0000-000000000001',
      reviewer_name: 'John D.',
      star_rating: 5,
      review_text: 'Great place!',
      review_date: '2026-05-01',
    }]);

    // Second query: business row (archived)
    mockSql.mockResolvedValueOnce([{
      name: 'Downtown Cafe',
      owner_email_bounced: false,
      archived_at: new Date('2026-05-05T12:00:00Z'),
      subscription_status: 'active',
      account_updated_at: new Date('2026-05-01'),
    }]);

    const result = await loadNotificationContext(
      { responseId: RESPONSE_ID, businessId: BUSINESS_ID },
      logger,
    );

    expect(result.kind).toBe('skip');
    // Verify the archived_at was checked
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('archived'),
    );
  });

  // Not archived: dispatch continues normally
  it('returns ok when the business is not archived', async () => {
    const logger = mockLogger();

    // First query: response row (found, pending_approval)
    mockSql.mockResolvedValueOnce([{
      id: RESPONSE_ID,
      response_text: 'Thank you!',
      status: 'pending_approval',
      resp_business_id: BUSINESS_ID,
      review_id: 'rvvvvvvv-0000-0000-0000-000000000001',
      reviewer_name: 'John D.',
      star_rating: 5,
      review_text: 'Great place!',
      review_date: '2026-05-01',
    }]);

    // Second query: business row (active, not archived)
    mockSql.mockResolvedValueOnce([{
      name: 'Downtown Cafe',
      owner_email_bounced: false,
      archived_at: null,
      subscription_status: 'active',
      account_updated_at: new Date('2026-05-01'),
    }]);

    const result = await loadNotificationContext(
      { responseId: RESPONSE_ID, businessId: BUSINESS_ID },
      logger,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.business.archived_at).toBeNull();
    }
  });

  // The business query includes archived_at column
  it('business query includes archived_at column', async () => {
    const logger = mockLogger();

    mockSql.mockResolvedValueOnce([{
      id: RESPONSE_ID,
      response_text: 'Thank you!',
      status: 'pending_approval',
      resp_business_id: BUSINESS_ID,
      review_id: 'rvvvvvvv-0000-0000-0000-000000000001',
      reviewer_name: 'John D.',
      star_rating: 5,
      review_text: 'Great place!',
      review_date: '2026-05-01',
    }]);

    mockSql.mockResolvedValueOnce([{
      name: 'Downtown Cafe',
      owner_email_bounced: false,
      archived_at: null,
      subscription_status: 'active',
      account_updated_at: new Date('2026-05-01'),
    }]);

    await loadNotificationContext(
      { responseId: RESPONSE_ID, businessId: BUSINESS_ID },
      logger,
    );

    // Find the business query call
    const businessCall = mockSql.mock.calls[1];
    expect(businessCall).toBeDefined();
    const template = (businessCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('archived_at');
  });
});
