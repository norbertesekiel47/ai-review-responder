import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlCalls, sqlReturnQueue, resetMockSql } = await vi.hoisted(async () => {
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
// `importOriginal`, not a bare replacement: the catalog builds its input
// schemas from this module's `VOICE_FIELD_LIMITS` at import time, and dropping
// the constant makes every zod `.max()` read `undefined`.
vi.mock('@/lib/responses/voice-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/responses/voice-settings')>()),
  readVoiceConfig,
}));

import { SubscriptionTier } from '@/lib/accounts/tier-config';
import type {
  AutoApprovalLocationSettings,
  AutoApprovalPolicyApiState,
  AutoApprovalSettingsResponse,
} from '@/lib/auto-approval/types';
import { buildSnapshot, projectOperatingRules, projectPolicyStates } from '../context';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const HISTORICAL_TURN = '44444444-4444-4444-8444-444444444444';

/** Account default: 4 and 5 star, 30-minute window, explicit cap 20. */
const ACCOUNT_DEFAULT: AutoApprovalPolicyApiState = {
  policyId: '55555555-5555-4555-8555-555555555555',
  threshold: 4,
  exists: true,
  vetoWindowMinutes: 30,
  dailyAutoPostCap: 20,
  effectiveDailyCap: 20,
  suspended: false,
  suspendedReason: null,
};

/** A DELIBERATE manual override: its own row, threshold null, its own dials. */
const MANUAL_OVERRIDE: AutoApprovalLocationSettings = {
  locationId: LOCATION,
  displayName: 'Salon',
  override: {
    policyId: '66666666-6666-4666-8666-666666666666',
    threshold: null,
    exists: true,
    vetoWindowMinutes: 15,
    dailyAutoPostCap: null,
    effectiveDailyCap: 10,
    suspended: false,
    suspendedReason: null,
  },
  effective: {
    threshold: null,
    source: 'location_override',
    inherited: false,
    vetoWindowMinutes: 15,
    dailyAutoPostCap: null,
    effectiveDailyCap: 10,
    suspended: false,
  },
};

/** No override row: the effective policy is the account default's. */
const INHERITING: AutoApprovalLocationSettings = {
  locationId: LOCATION,
  displayName: 'Salon',
  override: {
    policyId: null,
    threshold: null,
    exists: false,
    vetoWindowMinutes: 15,
    dailyAutoPostCap: null,
    effectiveDailyCap: 10,
    suspended: false,
    suspendedReason: null,
  },
  effective: {
    threshold: 4,
    source: 'account_default',
    inherited: true,
    vetoWindowMinutes: 30,
    dailyAutoPostCap: 20,
    effectiveDailyCap: 20,
    suspended: false,
  },
};

function settings(locations: AutoApprovalLocationSettings[]): AutoApprovalSettingsResponse {
  return {
    accountDefault: ACCOUNT_DEFAULT,
    locations,
    readiness: {
      runtimeEnabled: true,
      providerModerationEnabled: true,
      providerModerationValidated: true,
      accountWritable: true,
      canExpand: false,
      blockReasons: ['autopilot_unavailable'],
    },
    solicitation: { available: false, enabled: false, dailySendCap: null, vetoWindowMinutes: null },
  };
}

const SNAPSHOT_INPUT = {
  accountId: ACCOUNT,
  locationId: LOCATION,
  locationName: 'Salon',
  conversationId: CONVERSATION,
  sequence: 3,
  subscriptionTier: SubscriptionTier.COPILOT,
};

describe('operator context snapshot', () => {
  beforeEach(() => {
    resetMockSql();
    vi.clearAllMocks();
    getAutoApprovalSettings.mockResolvedValue(settings([INHERITING]));
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
    // ONE historical turn, so the BATCHED proposal read actually issues its
    // statement: `listProposalsForTurns` returns early on an empty id list, and
    // a zero-turn fixture therefore hides the fifth read from the closed list
    // below entirely. The queue is positional — star bands, posted_7d, recent
    // turns, then the two proposal reads.
    sqlReturnQueue.push(
      [],
      [],
      [{
        id: HISTORICAL_TURN,
        sequence: 1,
        owner_text: 'Warmer, please.',
        reply: [{ type: 'text', text: 'Done.' }],
      }],
    );

    await buildSnapshot(mockSql as unknown as postgres.Sql, {
      accountId: ACCOUNT,
      locationId: LOCATION,
      locationName: 'Salon',
      conversationId: CONVERSATION,
      sequence: 3,
      subscriptionTier: SubscriptionTier.COPILOT,
    });

    // Five statements: star bands, posted_7d, recent turns, the BATCHED
    // per-turn proposal read, pending proposals. Not a count for its own sake —
    // a sixth, unscoped read is exactly the regression this asserts against, so
    // the list has to be closed, and it only closes over the batched read when
    // the fixture gives it a turn to batch.
    expect(sqlCalls).toHaveLength(5);
    for (const call of sqlCalls) {
      expect(call.values, call.text).toContain(ACCOUNT);
    }

    // The batched read is keyed by the TURN IDS the history read returned, and
    // carries the account beside them — one `turn_id = ANY(...)` statement, not
    // one query per turn.
    const batched = sqlCalls.filter((call) => call.text.includes('turn_id = ANY'));
    expect(batched).toHaveLength(1);
    expect(batched[0]!.values).toContainEqual([HISTORICAL_TURN]);
    expect(batched[0]!.values).toContain(ACCOUNT);

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

  it('a deliberate manual location override stays manual under an enabled account default, in the projection and the snapshot', async () => {
    // The regression: `effective.threshold ?? account.threshold` read null as
    // "unset" and reported 4 and 5 star for a location that auto-posts nothing.
    expect(projectOperatingRules(settings([MANUAL_OVERRIDE]), LOCATION)).toEqual({
      account: { threshold: 4, vetoWindowMinutes: 30, dailyCap: 20 },
      location: { threshold: null, vetoWindowMinutes: 15, dailyCap: 10 },
      locationOverrideExists: true,
    });
    expect(projectPolicyStates(settings([MANUAL_OVERRIDE]), LOCATION)).toEqual({
      accountDefault: {
        domain: 'policy', threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: 20, effectiveDailyCap: 20, rowExists: true,
      },
      location: {
        domain: 'policy', threshold: null, vetoWindowMinutes: 15, dailyAutoPostCap: null, effectiveDailyCap: 10, rowExists: true,
      },
    });

    getAutoApprovalSettings.mockResolvedValueOnce(settings([MANUAL_OVERRIDE]));
    const snapshot = await buildSnapshot(mockSql as unknown as postgres.Sql, SNAPSHOT_INPUT);
    expect(snapshot.operatingRules.location.threshold).toBeNull();
    expect(snapshot.operatingRules.account.threshold).toBe(4);
  });

  it('an inheriting location reports the account default and no row, and so does a location absent from the settings', () => {
    const inherited = {
      domain: 'policy', threshold: 4, vetoWindowMinutes: 30, dailyAutoPostCap: 20, effectiveDailyCap: 20, rowExists: false,
    };
    expect(projectPolicyStates(settings([INHERITING]), LOCATION).location).toEqual(inherited);
    expect(projectPolicyStates(settings([]), LOCATION).location).toEqual(inherited);
    expect(projectOperatingRules(settings([INHERITING]), LOCATION)).toEqual({
      account: { threshold: 4, vetoWindowMinutes: 30, dailyCap: 20 },
      location: { threshold: 4, vetoWindowMinutes: 30, dailyCap: 20 },
      locationOverrideExists: false,
    });
  });

  it('the snapshot attaches the settings readiness to the policy operations and still lists them on Copilot', async () => {
    const snapshot = await buildSnapshot(mockSql as unknown as postgres.Sql, SNAPSHOT_INPUT);
    expect(snapshot.allowedOperations.find((op) => op.id === 'set_auto_reply_scope')).toMatchObject({
      kind: 'proposable',
      scopeRule: 'account_or_location',
      expansionBlockedBy: ['autopilot_unavailable'],
    });
    expect(snapshot.allowedOperations.find((op) => op.id === 'set_tone')).not.toHaveProperty('expansionBlockedBy');
  });
});
