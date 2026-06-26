import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { notFound } from 'next/navigation';
import { AuthIslandClient } from '@/components/auth/auth-island/AuthIslandClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Log in · RepWorth', robots: noindexRobots };

export default function OwnerLoginPage() {
  if (!selfServeSignupEnabled()) notFound();
  return <AuthIslandClient initialMode="login" />;
}
