import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CheckEmailClient } from '@/components/auth/CheckEmailClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Check your email · RepWorth', robots: noindexRobots };

export default function CheckEmailPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <CheckEmailClient />;
}
