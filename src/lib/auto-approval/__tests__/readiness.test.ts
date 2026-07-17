import { describe, expect, it } from 'vitest';
import { buildAutoApprovalReadiness } from '../readiness';

const readyInput = {
  runtimeEnabled: true,
  autopilotAvailable: true,
  providerModerationEnabled: true,
  providerModerationValidated: true,
  accountWritable: true,
  policySuspended: false,
  previewEnvironment: false,
} as const;

describe('buildAutoApprovalReadiness', () => {
  it('can expand when nothing blocks', () => {
    const readiness = buildAutoApprovalReadiness(readyInput);

    expect(readiness.canExpand).toBe(true);
    expect(readiness.blockReasons).toEqual([]);
  });

  it('blocks expansion with policy_suspended when the policy is suspended (spec §2.4)', () => {
    const readiness = buildAutoApprovalReadiness({ ...readyInput, policySuspended: true });

    expect(readiness.canExpand).toBe(false);
    expect(readiness.blockReasons).toEqual(['policy_suspended']);
  });

  it('adds only autopilot_unavailable when the tier or composed Autopilot gate is unavailable', () => {
    const readiness = buildAutoApprovalReadiness({
      ...readyInput,
      autopilotAvailable: false,
    });

    expect(readiness.canExpand).toBe(false);
    expect(readiness.blockReasons).toEqual(['autopilot_unavailable']);
    expect(readiness).not.toHaveProperty('autopilotPurchasable');
  });

  it('collects every block reason in a stable order', () => {
    const readiness = buildAutoApprovalReadiness({
      runtimeEnabled: false,
      autopilotAvailable: false,
      providerModerationEnabled: false,
      providerModerationValidated: false,
      accountWritable: false,
      policySuspended: true,
      previewEnvironment: true,
      impersonated: true,
    });

    expect(readiness.canExpand).toBe(false);
    expect(readiness.blockReasons).toEqual([
      'auto_approval_disabled',
      'autopilot_unavailable',
      'provider_moderation_disabled',
      'provider_moderation_not_validated',
      'subscription_not_writable',
      'policy_suspended',
      'preview_environment',
      'impersonation_not_allowed',
    ]);
  });
});
