import type { Metadata } from 'next';
import { ResetPasswordFormClient } from '@/components/auth/ResetPasswordFormClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Set a new password · RepWorth', robots: noindexRobots };

/**
 * Always-on — see `/login`. This is the landing page of the invite email's
 * `redirectTo` (`/api/auth/callback?flow=owner&next=/reset-password`); gating it
 * on `SELF_SERVE_SIGNUP_ENABLED` 404'd every invited owner under the beta
 * posture. The API behind the form still requires a live recovery session.
 */
export default function OwnerResetPasswordPage() {
  return <ResetPasswordFormClient portal="owner" brandName="RepWorth" />;
}
