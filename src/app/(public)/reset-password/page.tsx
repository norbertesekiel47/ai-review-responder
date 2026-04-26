import { notFound } from 'next/navigation';
import { ResetPasswordFormClient } from '@/components/auth/ResetPasswordFormClient';

export default function OwnerResetPasswordPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <ResetPasswordFormClient brandName="RepWorth" />;
}
