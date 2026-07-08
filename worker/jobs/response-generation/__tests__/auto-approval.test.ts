import { afterEach, describe, expect, it } from 'vitest';
import type { ModerationDecision } from '../../../../src/lib/moderation/output-filter';
import type { EffectiveAutoApprovalPolicy } from '../../../../src/lib/auto-approval/types';
import { TRIAGE_SOURCE } from '../../../../src/lib/reviews/triage-schema';
import {
  evaluateAutoApprovalCandidate,
  type AutoApprovalBlockReason,
  type AutoApprovalCandidateInput,
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
    accountPastDueAt: null,
    accountFlags: {},
    activeLocationNow: true,
    activeZernioConnectionNow: true,
    triageSeverity: null,
    triageSource: null,
    now: new Date('2026-06-04T00:00:00.000Z'),
    ...overrides,
  };
}

describe('evaluateAutoApprovalCandidate', () => {
  afterEach(() => {
    delete process.env.AUTO_APPROVAL_ENABLED;
    delete process.env.OPENAI_MODERATION_ENABLED;
  });

  it('approves only when every runtime gate is satisfied', () => {
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    process.env.OPENAI_MODERATION_ENABLED = 'true';

    const decision = evaluateAutoApprovalCandidate(baseInput());

    expect(decision.approved).toBe(true);
    expect(decision.blockReasons).toEqual([]);
    expect(decision.publisherSubscription).toEqual({ allowed: true });
    expect(decision.reviewContentHashMatched).toBe(true);
  });

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
});
