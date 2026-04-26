import { LoginFormClient } from '@/components/auth/LoginFormClient';

export default function AdminLoginPage() {
  return (
    <LoginFormClient
      portal="admin"
      brandName="RepWorth Admin"
      showGoogleButton={false}
      defaultRoute="/admin/overview"
      allowedRoles={['admin', 'sales_partner']}
    />
  );
}
