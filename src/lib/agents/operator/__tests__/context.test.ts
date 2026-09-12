import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

// The three collaborators buildSnapshot delegates to. They are mocked at the
// SEAM rather than driven through the recording double because each is a whole
// subsystem with its own result shape (auto-approval settings alone issues four
// reads and maps a readiness projection) — driving them off an empty queue
// would test their null-handling, not this module's scoping. Their own account
// scoping is asserted below through the arguments they were called with.
const { getAutoApprovalSettings, getLocationsForAccount, readVoiceConfig } = vi.hoisted(() => ({
  getAutoApprovalSettings: vi.fn(),
  getLocationsForAccount: vi.fn(),
  readVoiceConfig: vi.fn(),
}));
vi.mock('@/lib/auto-approval/settings', () => ({ getAutoApprovalSettings }));
vi.mock('@/lib/locations/repo', () => ({ getLocationsForAccount }));
vi.mock('@/lib/responses/voice-settings', () => ({ readVoiceConfig }));

import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { buildSnapshot } from '../context';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

describe('operator context snapshot', () => {
  beforeEach(() => {
    resetMockSql();
    vi.clearAllMocks();
    getAutoApprovalSettings.mockResolvedValue({
      accountDefault: { threshold: null, vetoWindowMinutes: 15, effectiveDailyCap: 10 },
      locations: [],
      readiness: {},
      solicitation: {},
    });
    getLocationsForAccount.mockResolvedValue([{ id: LOCATION, name: 'Salon' }]);
    readVoiceConfig.mockResolvedValue({
      tone: 'warm',
      productsServices: null,
      avoidFacts: [],
      highlightFacts: [],
      sampleResponses: ['never in a prompt'],
      updatedAt: '2026-09-11T00:00:00.000Z',
    });
  });

  it('buildSnapshot scopes every read to the stored account and location', async () => {
    await buildSnapshot(mockSql as unknown as postgres.Sql, {
      accountId: ACCOUNT,
      locationId: LOCATION,
      locationName: 'Salon',
      conversationId: CONVERSATION,
      sequence: 3,
      subscriptionTier: SubscriptionTier.COPILOT,
    });

    // Four statements: star bands, posted_7d, recent turns, pending proposals.
    // Not a count for its own sake — a fifth, unscoped read is exactly the
    // regression this asserts against, so the list has to be closed.
    expect(sqlCalls).toHaveLength(4);
    for (const call of sqlCalls) {
      expect(call.values, call.text).toContain(ACCOUNT);
    }

    // The per-location read binds the LOCATION too: the star-band query is
    // grouped per location and narrowed in JS, but posted_7d is not.
    const posted = sqlCalls.find((call) => call.text.includes('posted_at'));
    expect(posted?.values).toContain(LOCATION);

    // The conversation-scoped reads carry the account beside the conversation,
    // so a conversation id from another tenant reads nothing.
    const conversationScoped = sqlCalls.filter((call) => call.values.includes(CONVERSATION));
    expect(conversationScoped).toHaveLength(2);
    for (const call of conversationScoped) {
      expect(call.values, call.text).toContain(ACCOUNT);
    }

    // The three mocked collaborators are scoped by the caller, not by luck.
    expect(getAutoApprovalSettings).toHaveBeenCalledWith(
      mockSql,
      { accountId: ACCOUNT, impersonated: false },
    );
    expect(getLocationsForAccount).toHaveBeenCalledWith(mockSql, ACCOUNT);
    expect(readVoiceConfig).toHaveBeenCalledWith(
      mockSql,
      { accountId: ACCOUNT, locationId: LOCATION },
    );
  });
});
