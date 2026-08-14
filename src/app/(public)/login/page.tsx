import type { Metadata } from 'next';
import { AuthIslandClient } from '@/components/auth/auth-island/AuthIslandClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Log in · RepWorth', robots: noindexRobots };

/**
 * Always-on. `SELF_SERVE_SIGNUP_ENABLED` now means only "strangers may mint
 * accounts" (see `docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`),
 * so it must not hide the login page: admin-invited beta owners need to sign in
 * — and to recover a password — while the flag is off.
 */
export default function OwnerLoginPage() {
  return <AuthIslandClient initialMode="login" />;
}
