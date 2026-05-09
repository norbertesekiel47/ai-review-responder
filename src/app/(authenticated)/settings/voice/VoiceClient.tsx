'use client';

// src/app/(authenticated)/settings/voice/VoiceClient.tsx
//
// Voice tab client component. For multi-location accounts, renders a
// location selector dropdown at the top, with each location's voice
// config independently editable via BrandVoicePanel.
// For single-location accounts, renders one BrandVoicePanel without selector.
//
// VAL-SETTINGS-017: Voice tab renders per-location voice config sections.
// VAL-SETTINGS-018: Voice config for each location is independently editable.
// VAL-SETTINGS-036: Voice tab for single-location account when MULTI_LOCATION_ENABLED=true.
// VAL-SETTINGS-045: Voice tab per-location section headers resolve display_label ?? name.

import { useLocationVoiceForm } from '@/hooks/useLocationVoiceForm';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { BrandVoicePanel } from '@/components/dashboard/settings/BrandVoicePanel';
import { Icon } from '@/components/dashboard/Icon';

export function VoiceClient() {
  const f = useLocationVoiceForm();

  // Error state
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

  // Loading state
  if (f.loading || !f.form) {
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
      {/* Location selector — only shown for multi-location accounts */}
      {f.isMultiLocation && (
        <div className="set-section" style={{ paddingBottom: 8 }}>
          <div className="set-section-head">
            <div className="set-section-icon blue">
              <Icon name="location" size={18} />
            </div>
            <div>
              <div className="set-section-title">Location</div>
              <div className="set-section-sub">
                Choose which location&apos;s voice to configure.
              </div>
            </div>
          </div>
          <select
            className="input"
            value={f.selectedLocationId ?? ''}
            onChange={(e) => f.setSelectedLocationId(e.target.value)}
            style={{ width: '100%' }}
            aria-label="Select location for voice configuration"
          >
            {f.locations.map((loc) => (
              <option key={loc.locationId} value={loc.locationId}>
                {loc.displayName}
                {loc.isPrimary ? ' (Primary)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Per-location voice config header — shows location name */}
      {f.isMultiLocation && f.selectedDisplayName && (
        <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 600, color: 'var(--rw-app-text-heading, #1F2937)' }}>
          Voice for {f.selectedDisplayName}
        </div>
      )}

      {/* BrandVoicePanel — scoped to the currently selected location */}
      <BrandVoicePanel form={f.form} set={f.set} />

      {f.saveError && (
        <p style={{ fontSize: 13, color: '#DC2626', marginTop: 4 }}>{f.saveError}</p>
      )}
    </SettingsShell>
  );
}
