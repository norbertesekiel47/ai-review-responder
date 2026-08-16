import { readFlag } from '@/lib/config/flags';

/**
 * Self-serve signup feature flag. It means exactly one thing: **strangers may
 * mint accounts**.
 *
 * It gates the anonymous account-minting surface only — `/signup` + its
 * sub-pages, `POST /api/auth/{signup,finish-signup,resend-confirmation,verify-otp}`,
 * the trial-eligibility clause (`isTrialEligible`,
 * `src/lib/payments/plan-activation.ts` — one owner since PF-H2, read by BOTH
 * checkout entry points where it used to sit inline in `/api/billing/checkout`
 * alone), and the marketing CTA copy that advertises anonymous signup. It does
 * NOT gate the always-on auth pages (`/login`, `/forgot-password`, `/reset-password`) or the
 * authenticated onboarding funnel: those are reached by admin-invited owners
 * while the flag is off, and each enforces its own authenticated-session +
 * `role = 'owner'` + allowed-state boundary instead.
 *
 * The authoritative per-call-site inventory — kept and removed gates, with the
 * replacement guard for every removed one — is
 * `docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`.
 * Read it before adding a new call site.
 *
 * Invariant #13: server-authoritative, never a `NEXT_PUBLIC_*` companion.
 * Single owner; replaces the inline
 * `process.env.SELF_SERVE_SIGNUP_ENABLED === 'true'` reads.
 */
export function selfServeSignupEnabled(): boolean {
  return readFlag('SELF_SERVE_SIGNUP_ENABLED');
}

/** MFA enforcement gate (proxy/middleware). */
export function mfaEnforcementEnabled(): boolean {
  return readFlag('MFA_ENFORCEMENT_ENABLED');
}
