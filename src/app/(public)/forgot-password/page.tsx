import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { notFound } from 'next/navigation';
import { ForgotPasswordFormClient } from '@/components/auth/ForgotPasswordFormClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Reset your password · RepWorth', robots: noindexRobots };

export default function OwnerForgotPasswordPage() {
  if (!selfServeSignupEnabled()) notFound();
  return <ForgotPasswordFormClient portal="owner" brandName="RepWorth" />;
}
