import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { notFound } from 'next/navigation';
import { AuthIslandClient } from '@/components/auth/auth-island/AuthIslandClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Sign up · RepWorth', robots: noindexRobots };

export default function SignupPage() {
  if (!selfServeSignupEnabled()) notFound();
  return <AuthIslandClient initialMode="signup" />;
}
