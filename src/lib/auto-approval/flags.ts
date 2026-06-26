import { readFlag } from '@/lib/config/flags';

export function autoApprovalRuntimeEnabled(): boolean {
  return readFlag('AUTO_APPROVAL_ENABLED');
}

export function providerModerationEnabled(): boolean {
  return readFlag('OPENAI_MODERATION_ENABLED');
}

export function providerModerationValidated(): boolean {
  return readFlag('AUTO_APPROVAL_PROVIDER_MODERATION_READY');
}

// isPreviewEnvironment moved to @/lib/config/flags (the one home for the
// VERCEL_TARGET_ENV target-env resolution). Consumers import it from there.
