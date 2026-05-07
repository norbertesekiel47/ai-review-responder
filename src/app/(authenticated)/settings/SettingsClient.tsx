'use client';

import { useSettingsForm } from '@/hooks/useSettingsForm';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { GeneralPanel } from '@/components/dashboard/settings/GeneralPanel';
import { BrandVoicePanel } from '@/components/dashboard/settings/BrandVoicePanel';

export function SettingsClient() {
  const f = useSettingsForm();

  if (f.fetchError) {
    return (
      <SettingsShell activeTab="general">
        <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
          <div className="set-section-title" style={{ color: '#991B1B' }}>Error</div>
          <p style={{ fontSize: 13, color: '#B91C1C' }}>{f.fetchError}</p>
        </div>
      </SettingsShell>
    );
  }

  if (!f.data || !f.form) {
    return (
      <SettingsShell activeTab="general">
        <p style={{ textAlign: 'center', color: '#6B7280', padding: '60px 0' }}>Loading settings…</p>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell
      activeTab="general"
      savedFlash={f.savedFlash}
      saveBar={{
        visible: f.dirty,
        dirtyCount: f.dirtyCount,
        saving: f.saving,
        onSave: () => void f.save(),
        onDiscard: f.discard,
      }}
    >
      <GeneralPanel data={f.data} />
      <BrandVoicePanel form={f.form} set={f.set} />
      {f.saveError && (
        <p style={{ fontSize: 13, color: '#DC2626', marginTop: 4 }}>{f.saveError}</p>
      )}
    </SettingsShell>
  );
}
