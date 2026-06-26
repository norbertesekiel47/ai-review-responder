import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { notFound } from 'next/navigation';
import { CheckEmailClient } from '@/components/auth/CheckEmailClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Check your email · RepWorth', robots: noindexRobots };

export default function CheckEmailPage() {
  if (!selfServeSignupEnabled()) notFound();
  return <CheckEmailClient />;
}
