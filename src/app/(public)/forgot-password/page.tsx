import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ForgotPasswordFormClient } from '@/components/auth/ForgotPasswordFormClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Reset your password · RepWorth', robots: noindexRobots };

export default function OwnerForgotPasswordPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <ForgotPasswordFormClient portal="owner" brandName="RepWorth" />;
}
