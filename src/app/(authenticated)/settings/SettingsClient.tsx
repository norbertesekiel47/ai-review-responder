'use client';

import { useSettingsForm } from '@/hooks/useSettingsForm';
import { useAccountData } from '@/hooks/useAccountData';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { GeneralPanel } from '@/components/dashboard/settings/GeneralPanel';
import { AccountPanel } from '@/components/dashboard/settings/AccountPanel';
import { BrandVoicePanel } from '@/components/dashboard/settings/BrandVoicePanel';
import type { SettingsTab } from '@/components/dashboard/SettingsTabs';

interface Props {
  locationsSettingsEnabled: boolean;
  multiLocationEnabled: boolean;
}

export function SettingsClient({ locationsSettingsEnabled, multiLocationEnabled }: Props) {
  const f = useSettingsForm();
  const accountData = useAccountData();

  const activeTab: SettingsTab = multiLocationEnabled
    ? 'account'
    : locationsSettingsEnabled
      ? 'account'
      : 'general';

  if (f.fetchError) {
    return (
      <SettingsShell
        activeTab={activeTab}
        locationsSettingsEnabled={locationsSettingsEnabled}
        multiLocationEnabled={multiLocationEnabled}
      >
        <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
          <div className="set-section-title" style={{ color: '#991B1B' }}>Error</div>
          <p style={{ fontSize: 13, color: '#B91C1C' }}>{f.fetchError}</p>
        </div>
      </SettingsShell>
    );
  }

  if (!f.data || !f.form) {
    return (
      <SettingsShell
        activeTab={activeTab}
        locationsSettingsEnabled={locationsSettingsEnabled}
        multiLocationEnabled={multiLocationEnabled}
      >
        <p style={{ textAlign: 'center', color: '#6B7280', padding: '60px 0' }}>Loading settings…</p>
      </SettingsShell>
    );
  }

  // Multi-location: Account panel only (Voice is on separate /settings/voice route)
  // No save bar needed — all fields are read-only on the Account tab
  if (multiLocationEnabled) {
    return (
      <SettingsShell
        activeTab={activeTab}
        locationsSettingsEnabled={locationsSettingsEnabled}
        multiLocationEnabled
      >
        <AccountPanel
          data={f.data}
          accountData={accountData.data}
          accountLoading={accountData.loading}
          accountError={accountData.error}
          onAccountRefetch={accountData.refetch}
        />
      </SettingsShell>
    );
  }

  // Single-location: General + Brand Voice on the same page (existing redesign layout)
  return (
    <SettingsShell
      activeTab={activeTab}
      locationsSettingsEnabled={locationsSettingsEnabled}
      savedFlash={f.savedFlash}
      saveBar={{
        visible: f.dirty,
        dirtyCount: f.dirtyCount,
        saving: f.saving,
        onSave: () => void f.save(),
        onDiscard: f.discard,
      }}
    >
      {locationsSettingsEnabled ? (
        <AccountPanel
          data={f.data}
          accountData={accountData.data}
          accountLoading={accountData.loading}
          accountError={accountData.error}
          onAccountRefetch={accountData.refetch}
        />
      ) : (
        <GeneralPanel data={f.data} />
      )}
      <BrandVoicePanel form={f.form} set={f.set} />
      {f.saveError && (
        <p style={{ fontSize: 13, color: '#DC2626', marginTop: 4 }}>{f.saveError}</p>
      )}
    </SettingsShell>
  );
}
