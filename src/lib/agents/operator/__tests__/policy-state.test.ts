// Unit proofs for `consequenceForPolicy`'s dial mapping. They run without a
// database, so the mapping stays pinned when the live-DB lane is skipped.
// The SQL reads are proved in policy-state.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { consequenceForPolicy, type PolicySnapshot } from '../policy-state';
import type { PolicyState } from '../schema';
import { computeAutoApprovalVersionToken } from '../version-token';

const OWN_ROW = '00000000-0000-4000-8000-000000000001';
const INHERITS = '00000000-0000-4000-8000-000000000002';
const DAY = '2026-09-12T00:00:00.000000Z';

function policyState(threshold: 4 | 5 | null, rowExists: boolean): PolicyState {
  return { domain: 'policy', threshold, vetoWindowMinutes: 15, dailyAutoPostCap: null, effectiveDailyCap: 10, rowExists };
}

function review(businessId: string, reviewId: string) {
  return { businessId, reviewId, stars: 5, detectedAt: `2026-09-12T12:00:00.00000${reviewId.slice(-1)}Z`, dayKey: DAY, imported: false };
}

const WINDOW = {
  windowStart: '2026-08-13T12:00:00.123456Z',
  windowEnd: '2026-09-12T12:00:00.123456Z',
  asOf: '2026-09-12T12:00:00.123456Z',
  source: 'reviews_received_30d' as const,
  excludedImported: 2,
  excludedUnknown: 3,
};

describe('consequenceForPolicy', () => {
  it('account target: an overriding location keeps its own state, an inheritor takes the target state', () => {
    const snapshot: PolicySnapshot = {
      accountId: '00000000-0000-4000-8000-0000000000aa',
      locationId: null,
      target: { scope: 'account' },
      state: { accountDefault: policyState(null, false), location: null },
      versionToken: computeAutoApprovalVersionToken({ accountDefaultRow: { id: 'absent' } }),
      targetArchived: false,
      policySuspended: false,
      locations: [
        { id: OWN_ROW, state: policyState(null, true) },
        { id: INHERITS, state: policyState(null, false) },
      ],
      reviews: [review(OWN_ROW, '00000000-0000-4000-8000-000000000011'), review(INHERITS, '00000000-0000-4000-8000-000000000012')],
      ...WINDOW,
    };

    expect(consequenceForPolicy(snapshot, policyState(4, true))).toEqual({
      total: 2,
      eligible: 1,
      held: { below_threshold: 0, cap_reached: 0, manual: 1 },
      byDay: [{ day: DAY, total: 2, eligible: 1, held: 1 }],
      busiestDay: 2,
      ...WINDOW,
    });
  });

  it('location target: the targeted location takes the target state even when it has its own row', () => {
    const snapshot: PolicySnapshot = {
      accountId: '00000000-0000-4000-8000-0000000000aa',
      locationId: OWN_ROW,
      target: { scope: 'location', locationId: OWN_ROW },
      state: { accountDefault: policyState(null, false), location: policyState(null, true) },
      versionToken: computeAutoApprovalVersionToken({ locationRow: { id: 'absent' }, accountDefaultRow: { id: 'absent' } }),
      targetArchived: false,
      policySuspended: false,
      locations: [{ id: OWN_ROW, state: policyState(null, true) }],
      reviews: [review(OWN_ROW, '00000000-0000-4000-8000-000000000011')],
      ...WINDOW,
    };

    expect(consequenceForPolicy(snapshot, policyState(5, true))).toMatchObject({
      total: 1,
      eligible: 1,
      held: { below_threshold: 0, cap_reached: 0, manual: 0 },
    });
  });
});
