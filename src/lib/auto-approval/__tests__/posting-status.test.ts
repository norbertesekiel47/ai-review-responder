import { describe, expect, it } from 'vitest';
import { buildAutoApprovalPostingStatus } from '../posting-status';

/** Every structural gate open — the baseline each test knocks one input out of. */
function passingInput() {
  return {
    runtimeEnabled: true,
    judgeEnabled: true,
    tierGrantsAutopilot: true,
    providerModerationEnabled: true,
    publisherSubscriptionAllowed: true,
  };
}

describe('buildAutoApprovalPostingStatus', () => {
  it('reports autopilot_tier_required when the tier does not grant autopilot', () => {
    const status = buildAutoApprovalPostingStatus({ ...passingInput(), tierGrantsAutopilot: false });

    expect(status).toEqual({ blocked: true, reasons: ['autopilot_tier_required'] });
  });

  it('reports runtime_disabled when the auto-approval runtime flag is off', () => {
    const status = buildAutoApprovalPostingStatus({ ...passingInput(), runtimeEnabled: false });

    expect(status).toEqual({ blocked: true, reasons: ['runtime_disabled'] });
  });

  it('reports provider_moderation_disabled when provider moderation is off', () => {
    const status = buildAutoApprovalPostingStatus({
      ...passingInput(),
      providerModerationEnabled: false,
    });

    expect(status).toEqual({ blocked: true, reasons: ['provider_moderation_disabled'] });
  });

  it('reports publisher_subscription_denied when the publisher subscription check denies', () => {
    const status = buildAutoApprovalPostingStatus({
      ...passingInput(),
      publisherSubscriptionAllowed: false,
    });

    expect(status).toEqual({ blocked: true, reasons: ['publisher_subscription_denied'] });
  });

  it('reports judge_disabled when the judge flag is off', () => {
    const status = buildAutoApprovalPostingStatus({ ...passingInput(), judgeEnabled: false });

    expect(status).toEqual({ blocked: true, reasons: ['judge_disabled'] });
  });

  it('reports every applicable reason together, not just the first', () => {
    const status = buildAutoApprovalPostingStatus({
      runtimeEnabled: false,
      judgeEnabled: false,
      tierGrantsAutopilot: false,
      providerModerationEnabled: false,
      publisherSubscriptionAllowed: false,
    });

    expect(status).toEqual({
      blocked: true,
      reasons: [
        'runtime_disabled',
        'judge_disabled',
        'autopilot_tier_required',
        'provider_moderation_disabled',
        'publisher_subscription_denied',
      ],
    });
  });

  it('reports no reason and blocked false when every structural gate passes', () => {
    const status = buildAutoApprovalPostingStatus(passingInput());

    expect(status).toEqual({ blocked: false, reasons: [] });
  });

  // The trap this module exists to avoid: AUTOPILOT_PURCHASABLE=false gives an
  // Autopilot account the readiness reason `autopilot_unavailable` while the
  // runtime keeps posting, because the runtime never reads purchasability.
  // The builder's only tier input is the grant itself, so a paused sale is
  // invisible here — and must stay that way.
  it('does not report a reason for an autopilot tier whose sale is paused', () => {
    const status = buildAutoApprovalPostingStatus({ ...passingInput(), tierGrantsAutopilot: true });

    expect(status.reasons).not.toContain('autopilot_tier_required');
    expect(status.blocked).toBe(false);
  });
});
