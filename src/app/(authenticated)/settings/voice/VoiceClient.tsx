'use client';

import { useSettingsForm } from '@/hooks/useSettingsForm';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { BrandVoicePanel } from '@/components/dashboard/settings/BrandVoicePanel';

export function VoiceClient() {
  const f = useSettingsForm();

  if (f.fetchError) {
    return (
      <SettingsShell activeTab="voice" multiLocationEnabled>
        <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
          <div className="set-section-title" style={{ color: '#991B1B' }}>Error</div>
          <p style={{ fontSize: 13, color: '#B91C1C' }}>{f.fetchError}</p>
        </div>
      </SettingsShell>
    );
  }

  if (!f.data || !f.form) {
    return (
      <SettingsShell activeTab="voice" multiLocationEnabled>
        <p style={{ textAlign: 'center', color: '#6B7280', padding: '60px 0' }}>Loading voice settings…</p>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell
      activeTab="voice"
      multiLocationEnabled
      savedFlash={f.savedFlash}
      saveBar={{
        visible: f.dirty,
        dirtyCount: f.dirtyCount,
        saving: f.saving,
        onSave: () => void f.save(),
        onDiscard: f.discard,
      }}
    >
      <BrandVoicePanel form={f.form} set={f.set} />
      {f.saveError && (
        <p style={{ fontSize: 13, color: '#DC2626', marginTop: 4 }}>{f.saveError}</p>
      )}
    </SettingsShell>
  );
}
