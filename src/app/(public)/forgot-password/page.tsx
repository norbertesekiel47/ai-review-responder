import type { Metadata } from 'next';
import { ForgotPasswordFormClient } from '@/components/auth/ForgotPasswordFormClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Reset your password · RepWorth', robots: noindexRobots };

/**
 * Always-on — see `/login`. Password recovery cannot be gated on
 * `SELF_SERVE_SIGNUP_ENABLED`: under the documented beta posture the flag is
 * off, and an admin-invited owner still needs to reset a forgotten password.
 */
export default function OwnerForgotPasswordPage() {
  return <ForgotPasswordFormClient portal="owner" brandName="RepWorth" />;
}
