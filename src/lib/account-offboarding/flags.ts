import { readFlag } from '@/lib/config/flags';

export function accountOffboardingEnabled(): boolean {
  return readFlag('ACCOUNT_OFFBOARDING_ENABLED');
}
