import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ResetPasswordFormClient } from '@/components/auth/ResetPasswordFormClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Set a new password · RepWorth', robots: noindexRobots };

export default function OwnerResetPasswordPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <ResetPasswordFormClient brandName="RepWorth" />;
}
