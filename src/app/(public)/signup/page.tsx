import { notFound } from 'next/navigation';
import { SignupFormClient } from '@/components/auth/SignupFormClient';

export default function SignupPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <SignupFormClient />;
}
