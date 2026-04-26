import { notFound } from 'next/navigation';
import { ForgotPasswordFormClient } from '@/components/auth/ForgotPasswordFormClient';

export default function OwnerForgotPasswordPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <ForgotPasswordFormClient portal="owner" brandName="RepWorth" />;
}
