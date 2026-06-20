'use client';

import { useSettingsForm } from '@/hooks/useSettingsForm';
import { ProfilePanel } from '@/components/dashboard/settings/ProfilePanel';
import { SettingsSkeleton } from '@/components/dashboard/settings/SettingsSkeleton';

export function ProfileClient() {
  const f = useSettingsForm();

  if (f.fetchError) {
    return (
      <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
        <div className="set-section-title" style={{ color: '#991B1B' }}>Error</div>
        <p style={{ fontSize: 13, color: '#B91C1C' }}>{f.fetchError}</p>
      </div>
    );
  }
  if (!f.data) {
    return <SettingsSkeleton />;
  }
  return <ProfilePanel data={f.data} />;
}
