import { notFound } from 'next/navigation';
import { AuthIslandClient } from '@/components/auth/auth-island/AuthIslandClient';

export default function SignupPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <AuthIslandClient initialMode="signup" />;
}
