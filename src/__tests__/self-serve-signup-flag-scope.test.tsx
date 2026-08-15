import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `SELF_SERVE_SIGNUP_ENABLED` means exactly one thing: **strangers may mint
 * accounts**. This suite pins BOTH halves of that scope at the page boundary,
 * which is why it lives here rather than beside any one page — the invariant is
 * the relationship between the surfaces, not a property of a single file.
 *
 * - The always-on auth pages must render with the flag OFF: they are how an
 *   admin-invited beta owner signs in and recovers a password. Under the
 *   documented beta posture the flag is off, so a gate on `/reset-password`
 *   404'd the invite email's own `redirectTo` target.
 * - `/signup` must still 404 with the flag off: it IS the anonymous
 *   account-minting entry point, and the re-scope must not widen it.
 *
 * Inventory of record:
 * `docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`.
 */

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock('@/components/auth/auth-island/AuthIslandClient', () => ({
  AuthIslandClient: () => null,
}));

vi.mock('@/components/auth/ForgotPasswordFormClient', () => ({
  ForgotPasswordFormClient: () => null,
}));

vi.mock('@/components/auth/ResetPasswordFormClient', () => ({
  ResetPasswordFormClient: () => null,
}));

const { default: OwnerLoginPage } = await import('../app/(public)/login/page');
const { default: OwnerForgotPasswordPage } = await import(
  '../app/(public)/forgot-password/page'
);
const { default: OwnerResetPasswordPage } = await import(
  '../app/(public)/reset-password/page'
);
const { default: SignupPage } = await import('../app/(public)/signup/page');

beforeEach(() => {
  process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
});

describe('SELF_SERVE_SIGNUP_ENABLED page scope', () => {
  it('login page renders when SELF_SERVE_SIGNUP_ENABLED is off', () => {
    expect(OwnerLoginPage()).toBeTruthy();
  });

  it('forgot-password page renders when SELF_SERVE_SIGNUP_ENABLED is off', () => {
    expect(OwnerForgotPasswordPage()).toBeTruthy();
  });

  it('reset-password page renders when SELF_SERVE_SIGNUP_ENABLED is off', () => {
    expect(OwnerResetPasswordPage()).toBeTruthy();
  });

  it('signup page 404s when SELF_SERVE_SIGNUP_ENABLED is off', () => {
    // Regression guard on a KEPT gate.
    expect(() => SignupPage()).toThrow('NEXT_NOT_FOUND');
  });

  it('signup page renders when SELF_SERVE_SIGNUP_ENABLED is on', () => {
    // The other half of the kept gate — without this the 404 test would also
    // pass against a page that is simply broken.
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    expect(SignupPage()).toBeTruthy();
  });
});
