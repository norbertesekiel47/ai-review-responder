import { readFlag } from '@/lib/config/flags';

/**
 * Self-serve signup feature flag — gates the entire public signup/onboarding flow
 * (invariant #13: server-authoritative, never NEXT_PUBLIC). Single owner; replaces
 * the inline `process.env.SELF_SERVE_SIGNUP_ENABLED === 'true'` reads.
 */
export function selfServeSignupEnabled(): boolean {
  return readFlag('SELF_SERVE_SIGNUP_ENABLED');
}

/** MFA enforcement gate (proxy/middleware). */
export function mfaEnforcementEnabled(): boolean {
  return readFlag('MFA_ENFORCEMENT_ENABLED');
}
