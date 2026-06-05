import type { AutoApprovalReadiness, AutoApprovalReadinessBlockReason } from './types';

interface BuildAutoApprovalReadinessInput {
  runtimeEnabled: boolean;
  providerModerationEnabled: boolean;
  providerModerationValidated: boolean;
  accountWritable: boolean;
  previewEnvironment: boolean;
  impersonated?: boolean;
}

export function buildAutoApprovalReadiness({
  runtimeEnabled,
  providerModerationEnabled,
  providerModerationValidated,
  accountWritable,
  previewEnvironment,
  impersonated = false,
}: BuildAutoApprovalReadinessInput): AutoApprovalReadiness {
  const blockReasons: AutoApprovalReadinessBlockReason[] = [];

  if (!runtimeEnabled) blockReasons.push('auto_approval_disabled');
  if (!providerModerationEnabled) blockReasons.push('provider_moderation_disabled');
  if (!providerModerationValidated) blockReasons.push('provider_moderation_not_validated');
  if (!accountWritable) blockReasons.push('subscription_not_writable');
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
