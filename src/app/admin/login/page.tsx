import { LoginFormClient } from '@/components/auth/LoginFormClient';
import { adminAppUrl } from '@/lib/config/admin-app-url';

export default function AdminLoginPage() {
  return (
    <LoginFormClient
      portal="admin"
      brandName="RepWorth Admin"
      showGoogleButton={false}
      defaultRoute={adminAppUrl()}
      allowedRoles={['admin']}
    />
  );
}
