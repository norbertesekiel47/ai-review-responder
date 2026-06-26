import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { notFound } from 'next/navigation';
import { ResetPasswordFormClient } from '@/components/auth/ResetPasswordFormClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Set a new password · RepWorth', robots: noindexRobots };

export default function OwnerResetPasswordPage() {
  if (!selfServeSignupEnabled()) notFound();
  return <ResetPasswordFormClient portal="owner" brandName="RepWorth" />;
}
