import { notFound } from 'next/navigation';
import { CheckEmailClient } from '@/components/auth/CheckEmailClient';

export default function CheckEmailPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <CheckEmailClient />;
}
