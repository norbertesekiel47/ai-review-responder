import type { AutoApprovalReadiness, AutoApprovalReadinessBlockReason } from './types';

interface BuildAutoApprovalReadinessInput {
  runtimeEnabled: boolean;
  /** Tier entitlement plus the composed server-side Autopilot sale/runtime gate. */
  autopilotAvailable: boolean;
  providerModerationEnabled: boolean;
  providerModerationValidated: boolean;
  accountWritable: boolean;
  /**
   * System kill switch (spec §2.4): true when the relevant policy row carries
   * `suspended_at`. Blocks expansion; contractions stay allowed so an owner
   * can always turn auto-approval off.
   */
  policySuspended: boolean;
  previewEnvironment: boolean;
  impersonated?: boolean;
}

export function buildAutoApprovalReadiness({
  runtimeEnabled,
  autopilotAvailable,
  providerModerationEnabled,
  providerModerationValidated,
  accountWritable,
  policySuspended,
  previewEnvironment,
  impersonated = false,
}: BuildAutoApprovalReadinessInput): AutoApprovalReadiness {
  const blockReasons: AutoApprovalReadinessBlockReason[] = [];

  if (!runtimeEnabled) blockReasons.push('auto_approval_disabled');
  if (!autopilotAvailable) blockReasons.push('autopilot_unavailable');
  if (!providerModerationEnabled) blockReasons.push('provider_moderation_disabled');
  if (!providerModerationValidated) blockReasons.push('provider_moderation_not_validated');
  if (!accountWritable) blockReasons.push('subscription_not_writable');
  if (policySuspended) blockReasons.push('policy_suspended');
  if (previewEnvironment) blockReasons.push('preview_environment');
  if (impersonated) blockReasons.push('impersonation_not_allowed');

  return {
    runtimeEnabled,
    providerModerationEnabled,
    providerModerationValidated,
    accountWritable,
    canExpand: blockReasons.length === 0,
    blockReasons,
  };
}
