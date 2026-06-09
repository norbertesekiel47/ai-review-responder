export function accountOffboardingEnabled(): boolean {
  return process.env.ACCOUNT_OFFBOARDING_ENABLED === 'true';
}
