import type { ReactNode } from 'react';
import { SettingsSidebar } from '@/components/dashboard/settings/SettingsSidebar';
import '@/app/(authenticated)/_styles/settings.css';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="settings-shell-2col">
      <SettingsSidebar />
      <div className="settings-detail">{children}</div>
    </div>
  );
}
