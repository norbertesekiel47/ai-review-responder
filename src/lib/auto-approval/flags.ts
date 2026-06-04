export function autoApprovalRuntimeEnabled(): boolean {
  return process.env.AUTO_APPROVAL_ENABLED === 'true';
}

export function providerModerationEnabled(): boolean {
  return process.env.OPENAI_MODERATION_ENABLED === 'true';
}

export function providerModerationValidated(): boolean {
  return process.env.AUTO_APPROVAL_PROVIDER_MODERATION_READY === 'true';
}

export function isPreviewEnvironment(): boolean {
  return process.env.VERCEL_ENV === 'preview';
}
