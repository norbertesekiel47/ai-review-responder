/**
 * Single authoritative owner for the onboarding-demo feature flag.
 * Mirrors the `<feature>/flags.ts` convention (see `auto-approval/flags.ts`),
 * a one-line wrapper over the shared `readFlag` primitive (byte-for-byte
 * `process.env[name] === 'true'`).
 *
 *   - onboardingDemoEnabled(): the pre-pay onboarding demo lane (the
 *     start/business/demo pages + their routes) is on.
 *
 * Server-authoritative (invariant #13): never expose via a `NEXT_PUBLIC_*`
 * companion; the browser learns the state through API responses / props.
 */
import { readFlag } from '@/lib/config/flags';

export function onboardingDemoEnabled(): boolean {
  return readFlag('ONBOARDING_DEMO_ENABLED');
}
