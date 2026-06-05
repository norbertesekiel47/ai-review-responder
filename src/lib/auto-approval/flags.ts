export function autoApprovalRuntimeEnabled(): boolean {
  return process.env.AUTO_APPROVAL_ENABLED === 'true';
}

export function providerModerationEnabled(): boolean {
  return process.env.OPENAI_MODERATION_ENABLED === 'true';
}

export function providerModerationValidated(): boolean {
  return process.env.AUTO_APPROVAL_PROVIDER_MODERATION_READY === 'true';
}

// Use VERCEL_TARGET_ENV, not VERCEL_ENV: a preview-type custom environment such
// as `staging` reports VERCEL_ENV='preview' but VERCEL_TARGET_ENV='staging'. Only
// genuine per-PR previews have VERCEL_TARGET_ENV='preview'. Both are runtime-available.
export function isPreviewEnvironment(): boolean {
  return process.env.VERCEL_TARGET_ENV === 'preview';
}
