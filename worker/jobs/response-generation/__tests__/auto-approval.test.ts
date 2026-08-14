import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModerationDecision } from '../../../../src/lib/moderation/output-filter';
import type { EffectiveAutoApprovalPolicy } from '../../../../src/lib/auto-approval/types';
import * as autoApprovalFlags from '../../../../src/lib/auto-approval/flags';
import { TRIAGE_SOURCE } from '../../../../src/lib/reviews/triage-schema';
import type { SubscriptionTierValue } from '../../../../src/lib/accounts/tier-config';
import {
  GENERATE_RESPONSE_ORIGIN_LANE,
  GENERATE_RESPONSE_ORIGIN_LANES,
} from '../../../../src/lib/shared/worker-types';
import { createMockSql, mkTaggedResult } from '../../../__tests__/helpers/mock-sql';
import {
  evaluateAutoApprovalCandidate,
  isAutoApprovalCandidate,
  loadAutoApprovalRuntimeState,
  structurallyBlockedDecision,
  type AutoApprovalBlockReason,
  type AutoApprovalCandidateInput,
  type StructuralBlockInput,
} from '../auto-approval';

const CLEAN_MODERATION: ModerationDecision = {
  flagged: false,
  severity: 'low',
  reason: null,
  categories: {},
  score: 0,
  source: 'openai_moderation',
  providerStatus: 'clean',
};

const ENABLED_POLICY: EffectiveAutoApprovalPolicy = {
  source: 'account_default',
  threshold: 4,
  policyId: 'policy-1',
  vetoWindowMinutes: 15,
  dailyAutoPostCap: null,
  suspended: false,
};

type EnvOverrides = Partial<Record<
  'AUTO_APPROVAL_ENABLED' | 'OPENAI_MODERATION_ENABLED',
  string
>>;

interface AutoApprovalMatrixCase {
  reason: AutoApprovalBlockReason;
  overrides: Partial<AutoApprovalCandidateInput>;
  env?: EnvOverrides;
}

function baseInput(overrides: Partial<AutoApprovalCandidateInput> = {}): AutoApprovalCandidateInput {
  return {
    originLane: 'live_ingest_new',
    version: 1,
    suppressNotification: false,
    loadedReviewContentHash: 'hash-1',
    currentReviewContentHash: 'hash-1',
    currentStarRating: 5,
    effectivePolicy: ENABLED_POLICY,
    moderation: CLEAN_MODERATION,
    held: false,
    subscriptionStatus: 'active',
    subscriptionTier: 'autopilot',
    accountPastDueAt: null,
    accountFlags: {},
    activeLocationNow: true,
    activeZernioConnectionNow: true,
    triageSeverity: null,
    triageSource: null,
    autoApprovedTodayCount: 0,
    now: new Date('2026-06-04T00:00:00.000Z'),
    ...overrides,
  };
}

function expectedStructuralReasons(
  input: StructuralBlockInput,
  runtimeEnabled: boolean,
): AutoApprovalBlockReason[] {
  return [
    ...(!runtimeEnabled ? ['auto_approval_disabled' as const] : []),
    ...(input.originLane !== GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW
      ? ['bad_origin_lane' as const]
      : []),
    ...(input.version !== 1 ? ['unsupported_version' as const] : []),
    ...(input.suppressNotification ? ['suppressed_notification' as const] : []),
  ];
}

describe('evaluateAutoApprovalCandidate', () => {
  afterEach(() => {
    delete process.env.AUTO_APPROVAL_ENABLED;
    delete process.env.OPENAI_MODERATION_ENABLED;
  });

  it('treats the exact structurally eligible input as a candidate across all three decision shapes', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    const structuralInput: StructuralBlockInput = {
      originLane: GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW,
      version: 1,
      suppressNotification: false,
    };
    const decision = evaluateAutoApprovalCandidate(baseInput(structuralInput));

    expect(isAutoApprovalCandidate(structuralInput)).toBe(true);
    expect(decision.approved).toBe(true);
    expect(decision.blockReasons).toEqual([]);
    expect(decision.publisherSubscription).toEqual({ allowed: true });
    expect(decision.reviewContentHashMatched).toBe(true);
    expect(() => structurallyBlockedDecision(structuralInput))
      .toThrow('structurally_blocked_decision_called_for_candidate');
  });

  it('property: structural candidate boolean, blocked decision, and total evaluator agree for every candidate-fields input', () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.option(fc.constantFrom(...GENERATE_RESPONSE_ORIGIN_LANES), { nil: null }),
      fc.integer(),
      fc.boolean(),
      (runtimeEnabled, originLane, version, suppressNotification) => {
        process.env.AUTO_APPROVAL_ENABLED = runtimeEnabled ? 'true' : 'false';
        process.env.OPENAI_MODERATION_ENABLED = 'true';

        const structuralInput: StructuralBlockInput = {
          originLane,
          version,
          suppressNotification,
        };
        const expectedReasons = expectedStructuralReasons(structuralInput, runtimeEnabled);
        const isCandidate = isAutoApprovalCandidate(structuralInput);
        const totalDecision = evaluateAutoApprovalCandidate(baseInput(structuralInput));

        expect(isCandidate).toBe(expectedReasons.length === 0);
        if (isCandidate) {
          expect(totalDecision.approved).toBe(true);
          expect(totalDecision.blockReasons).toEqual([]);
          expect(() => structurallyBlockedDecision(structuralInput))
            .toThrow('structurally_blocked_decision_called_for_candidate');
          return;
        }

        const blockedDecision = structurallyBlockedDecision(structuralInput);
        expect(blockedDecision.blockReasons).toEqual(expectedReasons);
        expect(totalDecision.approved).toBe(false);
        expect(totalDecision.blockReasons).toEqual(expectedReasons);
      },
    ));
  });

  it('reads the Auto-approval runtime flag once per structural decision', () => {
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    const runtimeEnabledSpy = vi.spyOn(autoApprovalFlags, 'autoApprovalRuntimeEnabled');
    const structuralInput: StructuralBlockInput = {
      originLane: GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW,
      version: 1,
      suppressNotification: false,
    };

    try {
      runtimeEnabledSpy.mockReturnValueOnce(false).mockReturnValueOnce(true);
      expect(isAutoApprovalCandidate(structuralInput)).toBe(false);
      expect(runtimeEnabledSpy).toHaveBeenCalledTimes(1);

      runtimeEnabledSpy.mockReset();
      runtimeEnabledSpy.mockReturnValueOnce(false).mockReturnValueOnce(true);
      const blockedDecision = structurallyBlockedDecision(structuralInput);
      expect(runtimeEnabledSpy).toHaveBeenCalledTimes(1);
      expect(blockedDecision.runtimeEnabled).toBe(false);
      expect(blockedDecision.blockReasons).toEqual(['auto_approval_disabled']);

      runtimeEnabledSpy.mockReset();
      runtimeEnabledSpy.mockReturnValueOnce(false).mockReturnValueOnce(true);
      const totalDecision = evaluateAutoApprovalCandidate(baseInput(structuralInput));
      expect(runtimeEnabledSpy).toHaveBeenCalledTimes(1);
      expect(totalDecision.runtimeEnabled).toBe(false);
      expect(totalDecision.blockReasons).toEqual(['auto_approval_disabled']);
    } finally {
      runtimeEnabledSpy.mockRestore();
    }
  });

  it('denies Copilot even when every policy, moderation, and runtime gate otherwise passes', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    const decision = evaluateAutoApprovalCandidate(baseInput({ subscriptionTier: 'copilot' }));

    expect(decision.approved).toBe(false);
    expect(decision.blockReasons).toEqual(['autopilot_tier_required']);
  });

  it.each(['copilot', 'autopilot'] as const)(
    'denies invalid publisher subscription status for %s',
    (subscriptionTier) => {
      process.env.AUTO_APPROVAL_ENABLED = 'true';
      process.env.OPENAI_MODERATION_ENABLED = 'true';
      const decision = evaluateAutoApprovalCandidate(baseInput({
        subscriptionTier,
        subscriptionStatus: 'pending_payment',
      }));
      expect(decision.approved).toBe(false);
      expect(decision.blockReasons).toContain('publisher_subscription_denied');
    },
  );

  const fallbackCases: AutoApprovalMatrixCase[] = [
    { reason: 'bad_origin_lane', overrides: { originLane: 'regenerate' } },
    { reason: 'unsupported_version', overrides: { version: 2 } },
    { reason: 'suppressed_notification', overrides: { suppressNotification: true } },
    { reason: 'review_content_changed_before_persist', overrides: { currentReviewContentHash: 'hash-2' } },
    { reason: 'review_content_hash_missing', overrides: { loadedReviewContentHash: null } },
    { reason: 'review_content_hash_missing', overrides: { currentReviewContentHash: null } },
    { reason: 'current_rating_missing', overrides: { currentStarRating: null } },
    { reason: 'rating_below_threshold', overrides: { currentStarRating: 3 } },
    { reason: 'policy_not_enabled', overrides: { effectivePolicy: { source: 'none', threshold: null, policyId: null, vetoWindowMinutes: 15, dailyAutoPostCap: null, suspended: false } } },
    { reason: 'policy_not_enabled', overrides: { effectivePolicy: { source: 'account_default', threshold: null, policyId: 'policy-1', vetoWindowMinutes: 15, dailyAutoPostCap: null, suspended: false } } },
    { reason: 'provider_moderation_disabled', overrides: {}, env: { OPENAI_MODERATION_ENABLED: 'false' } },
    { reason: 'provider_moderation_error', overrides: { moderation: { ...CLEAN_MODERATION, providerStatus: 'error' } } },
    { reason: 'moderation_flagged', overrides: { moderation: { ...CLEAN_MODERATION, flagged: true, severity: 'medium' } } },
    { reason: 'moderation_held', overrides: { moderation: { ...CLEAN_MODERATION, flagged: true, severity: 'high' }, held: true } },
    { reason: 'auto_approval_disabled', overrides: {}, env: { AUTO_APPROVAL_ENABLED: 'false' } },
    { reason: 'publisher_subscription_denied', overrides: { subscriptionStatus: 'pending_payment' } },
    { reason: 'active_zernio_connection_missing', overrides: { activeZernioConnectionNow: false } },
    { reason: 'archived_location', overrides: { activeLocationNow: false } },
    { reason: 'rating_below_positive_quadrant', overrides: { currentStarRating: 3 } },
    // Cap 10 is the platform default derived from ENABLED_POLICY's NULL cap.
    { reason: 'daily_cap_exhausted', overrides: { autoApprovedTodayCount: 10 } },
    { reason: 'policy_suspended', overrides: { effectivePolicy: { ...ENABLED_POLICY, suspended: true } } },
  ];

  it.each(fallbackCases)('falls back to manual when $reason blocks auto', ({ reason, overrides, env = {} }) => {
    process.env.AUTO_APPROVAL_ENABLED = env.AUTO_APPROVAL_ENABLED ?? 'true';
    process.env.OPENAI_MODERATION_ENABLED = env.OPENAI_MODERATION_ENABLED ?? 'true';

    const decision = evaluateAutoApprovalCandidate(baseInput(overrides));

    expect(decision.approved).toBe(false);
    expect(decision.blockReasons).toContain(reason);
  });

  it('blocks with triage_high_severity when triage says high', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    const decision = evaluateAutoApprovalCandidate(baseInput({
      triageSeverity: 'high',
      triageSource: TRIAGE_SOURCE.LLM,
    }));

    expect(decision.approved).toBe(false);
    expect(decision.blockReasons).toContain('triage_high_severity');
  });

  it('blocks with triage_fallback when triage fell back (inconclusive → hold lane)', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    const decision = evaluateAutoApprovalCandidate(baseInput({
      triageSeverity: 'high',
      triageSource: TRIAGE_SOURCE.FALLBACK,
    }));

    expect(decision.approved).toBe(false);
    expect(decision.blockReasons).toEqual(
      expect.arrayContaining(['triage_high_severity', 'triage_fallback']),
    );
  });

  it('does not block on low/medium or untriaged reviews', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    const mediumDecision = evaluateAutoApprovalCandidate(baseInput({
      triageSeverity: 'medium',
      triageSource: TRIAGE_SOURCE.LLM,
    }));
    expect(mediumDecision.approved).toBe(true);
    expect(mediumDecision.blockReasons).not.toContain('triage_high_severity');
    expect(evaluateAutoApprovalCandidate(baseInput({
      triageSeverity: null,
      triageSource: null,
    })).blockReasons.filter((reason) => reason.startsWith('triage'))).toHaveLength(0);
  });

  it('blocks a 3-star review with BOTH rating reasons under a 4-star threshold', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    const decision = evaluateAutoApprovalCandidate(baseInput({ currentStarRating: 3 }));

    expect(decision.approved).toBe(false);
    expect(decision.blockReasons).toEqual(
      expect.arrayContaining(['rating_below_threshold', 'rating_below_positive_quadrant']),
    );
  });

  it.each([1, 2, 3])('hard floor blocks %i-star reviews regardless of the policy threshold', (stars) => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    // The positive-quadrant gate sits ABOVE the dial (WS4 spec §2.2): it must
    // fire independent of whatever the (possibly stale/buggy) policy row says.
    const decision = evaluateAutoApprovalCandidate(baseInput({
      currentStarRating: stars,
      effectivePolicy: { ...ENABLED_POLICY, threshold: 4 },
    }));

    expect(decision.approved).toBe(false);
    expect(decision.blockReasons).toContain('rating_below_positive_quadrant');
  });

  it('does not fire the positive-quadrant gate for 4-star reviews or unrated reviews', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    expect(evaluateAutoApprovalCandidate(baseInput({ currentStarRating: 4 })).approved).toBe(true);
    // Unrated stays blocked by current_rating_missing, not the quadrant gate.
    const unrated = evaluateAutoApprovalCandidate(baseInput({ currentStarRating: null }));
    expect(unrated.blockReasons).toContain('current_rating_missing');
    expect(unrated.blockReasons).not.toContain('rating_below_positive_quadrant');
  });

  it('blocks with daily_cap_exhausted at the stored-cap boundary (count == cap)', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    const decision = evaluateAutoApprovalCandidate(baseInput({
      autoApprovedTodayCount: 10,
      effectivePolicy: { ...ENABLED_POLICY, dailyAutoPostCap: 10 },
    }));

    expect(decision.approved).toBe(false);
    expect(decision.blockReasons).toEqual(['daily_cap_exhausted']);
  });

  it('approves one slot below the stored cap (count == cap - 1)', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    const decision = evaluateAutoApprovalCandidate(baseInput({
      autoApprovedTodayCount: 9,
      effectivePolicy: { ...ENABLED_POLICY, dailyAutoPostCap: 10 },
    }));

    expect(decision.approved).toBe(true);
    expect(decision.blockReasons).toEqual([]);
  });

  it('derives the default cap (10) from a NULL policy cap — blocks at 10, approves at 9', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    // ENABLED_POLICY carries dailyAutoPostCap: null; the evaluator must
    // resolve it to the platform default itself — no separate cap input.
    expect(evaluateAutoApprovalCandidate(baseInput({ autoApprovedTodayCount: 10 })).blockReasons)
      .toEqual(['daily_cap_exhausted']);
    expect(evaluateAutoApprovalCandidate(baseInput({ autoApprovedTodayCount: 9 })).approved).toBe(true);
  });

  it('blocks with policy_suspended when the effective policy is suspended (governor kill switch)', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    // Suspension is read straight off effectivePolicy — there is no separate
    // boolean input a caller could forget to thread, so a suspended policy
    // structurally cannot evaluate as unsuspended.
    const decision = evaluateAutoApprovalCandidate(baseInput({
      effectivePolicy: { ...ENABLED_POLICY, suspended: true },
    }));

    expect(decision.approved).toBe(false);
    expect(decision.blockReasons).toEqual(['policy_suspended']);
  });
});

describe('loadAutoApprovalRuntimeState (mocked sql)', () => {
  const harness = createMockSql();

  function currentStateRow(overrides: Record<string, unknown> = {}) {
    return {
      star_rating: 5,
      review_content_hash: 'hash-1',
      archived_at: null,
      subscription_status: 'active',
      subscription_tier: 'autopilot',
      account_past_due_at: null,
      account_flags: {},
      triage_severity: null,
      triage_source: null,
      ...overrides,
    };
  }

  function policyRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'policy-1',
      account_id: 'acct-1',
      location_id: null,
      auto_approve_min_star: 4,
      veto_window_minutes: 15,
      daily_auto_post_cap: null,
      suspended_at: null,
      ...overrides,
    };
  }

  /** Queue order: state → policies → business lock → cap count → connection. */
  function queueLoaderRows(input: {
    policies?: Record<string, unknown>[];
    autoApprovedToday?: number;
  } = {}) {
    harness.sqlReturnQueue.push(
      mkTaggedResult([currentStateRow()]),
      mkTaggedResult(input.policies ?? [policyRow()]),
      mkTaggedResult([{ id: 'biz-1' }]),
      mkTaggedResult([{ auto_approved_today: input.autoApprovedToday ?? 0 }]),
      mkTaggedResult([{ id: 'conn-1' }]),
    );
  }

  async function runLoader() {
    return loadAutoApprovalRuntimeState(
      harness.mockSql as never,
      { reviewId: 'rev-1', businessId: 'biz-1', accountId: 'acct-1' },
    );
  }

  beforeEach(() => {
    harness.resetMockSql();
  });

  it('maps the migration-074 dial columns into the effective policy and runtime state', async () => {
    queueLoaderRows({
      policies: [policyRow({
        veto_window_minutes: 30,
        daily_auto_post_cap: 7,
        suspended_at: new Date('2026-07-07T00:00:00.000Z'),
      })],
      autoApprovedToday: 3,
    });

    const state = await runLoader();

    expect(state.effectivePolicy.vetoWindowMinutes).toBe(30);
    expect(state.effectivePolicy.dailyAutoPostCap).toBe(7);
    expect(state.effectivePolicy.suspended).toBe(true);
    expect(state.autoApprovedTodayCount).toBe(3);
    expect(state.subscriptionTier).toBe('autopilot');
  });

  it('loads a NULL daily_auto_post_cap as-is (default resolution is the evaluator\'s job)', async () => {
    queueLoaderRows();

    const state = await runLoader();

    expect(state.effectivePolicy.dailyAutoPostCap).toBeNull();
    expect(state.effectivePolicy.suspended).toBe(false);
  });

  it('scopes the policy SELECT to the reply/posting persona and loads the dial columns', async () => {
    queueLoaderRows();

    await runLoader();

    const policySelect = harness.sqlCalls.find((call) => call.text.includes('FROM auto_approval_policies'));
    expect(policySelect).toBeDefined();
    expect(policySelect!.text).toContain('veto_window_minutes');
    expect(policySelect!.text).toContain('daily_auto_post_cap');
    expect(policySelect!.text).toContain('suspended_at');
    expect(policySelect!.text).toContain('persona = ?');
    expect(policySelect!.text).toContain('action_class = ?');
    expect(policySelect!.values).toEqual(expect.arrayContaining(['reply', 'posting']));
  });

  it('fails closed on a non-WS8 tier instead of casting or falling back', async () => {
    const unsupportedTier = 'retired_tier' as unknown as SubscriptionTierValue;
    harness.sqlReturnQueue.push(mkTaggedResult([
      currentStateRow({ subscription_tier: unsupportedTier }),
    ]));

    await expect(runLoader()).rejects.toThrow(
      'auto_approval_invalid_subscription_tier:retired_tier',
    );
    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlCalls[0]!.text).toContain('FROM reviews');
    expect(harness.sqlCalls[0]!.text).not.toContain('auto_approval_policies');
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('takes the business FOR UPDATE lock BEFORE counting, and counts on the UTC day boundary', async () => {
    queueLoaderRows();

    await runLoader();

    const texts = harness.sqlCalls.map((call) => call.text.replace(/\s+/g, ' '));
    const lockIndex = texts.findIndex((text) => text.includes('FROM businesses') && text.includes('FOR UPDATE'));
    const countIndex = texts.findIndex((text) => text.includes('auto_approved_today'));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(countIndex);

    // The counting predicate is the UTC calendar day (WS4 spec §2.3, amended
    // §6) over auto-policy approvals GRANTED today, read from the DURABLE
    // audit rows — pinned so a refactor back to the mutable responses columns
    // (which a veto NULLs, refunding the slot), to a rolling window, or to a
    // local-time day breaks here.
    const countText = texts[countIndex]!;
    expect(countText).toContain('FROM approval_audit_log');
    expect(countText).not.toContain('FROM responses');
    expect(countText).toContain("created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
    expect(countText).toContain('action = ?');
    const countCall = harness.sqlCalls[countIndex]!;
    expect(countCall.values).toEqual(expect.arrayContaining(['auto_approved_by_policy', 'biz-1']));
  });
});
