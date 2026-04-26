import { notFound } from 'next/navigation';
import { LoginFormClient } from '@/components/auth/LoginFormClient';

export default function OwnerLoginPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return (
    <LoginFormClient
      portal="owner"
      brandName="RepWorth"
      showGoogleButton={true}
      defaultRoute="/dashboard"
      allowedRoles={['owner']}
    />
  );
}
