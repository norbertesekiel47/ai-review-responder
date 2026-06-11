'use client';

// src/app/(authenticated)/settings/channels/ChannelsTabClient.tsx
//
// Owns the Notifications tab as a whole:
//   1. The existing ChannelsClient (Email + Telegram + WhatsApp rows) — org-level defaults.
//   2. Per-location channel overrides (collapsible panel).
//   3. Reports & summaries (weekly + monthly toggles).
//   4. Contact details (phone editable + email locked).
//
// Sections 2–4 hydrate from `/api/dashboard` via useSettingsForm and save
// via PUT /api/settings — preserving the patch-shape contract that the legacy
// Settings General form used.
//
// VAL-SETTINGS-012: Channels tab shows org-level defaults at top.
// VAL-SETTINGS-013: Per-location override panel collapsed by default.
// VAL-SETTINGS-032: Channels tab org-default section shows only Telegram and email.

import { useState } from 'react';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { SettingsSkeleton } from '@/components/dashboard/settings/SettingsSkeleton';
import { Icon } from '@/components/dashboard/shell/Icon';
import { ChannelsClient, type ChannelsClientProps } from './ChannelsClient';
import {
  PerLocationOverridePanel,
  type PerLocationOverride,
  type LocationOption,
} from '@/components/dashboard/settings/PerLocationOverridePanel';
import type { ChannelOverridesView } from '@/lib/channels/overrides-view';
import type { ChannelId } from '@/lib/notifications/channels/types';

interface Props extends ChannelsClientProps {
  multiLocationEnabled: boolean;
  locationsSettingsEnabled: boolean;
  /** Computed once by the page: multi-location mode AND >1 active location. */
  canAddOverrides: boolean;
  perLocationOverrides: PerLocationOverride[];
  locationOptions: LocationOption[];
  verifiedOrgChannels: ChannelId[];
}

export function ChannelsTabClient(props: Props) {
  const f = useSettingsForm();

  // Track the override view in local state so we can update after add/remove
  // without a full page reload. The initial values come from SSR.
  const [overrides, setOverrides] = useState<PerLocationOverride[]>(props.perLocationOverrides);
  const [locationOptions, setLocationOptions] = useState<LocationOption[]>(props.locationOptions);
  const [verifiedOrgChannels, setVerifiedOrgChannels] = useState<ChannelId[]>(
    props.verifiedOrgChannels,
  );

  // Refresh the full override view from the server after add/remove — not just
  // the override list, so verified-org-channel changes are never stale.
  const refreshOverrides = async () => {
    try {
      const res = await fetch('/api/settings/channels/overrides');
      if (res.ok) {
        const view = (await res.json()) as ChannelOverridesView;
        setOverrides(view.overrides ?? []);
        setLocationOptions((view.locations ?? []).filter((location) => !location.archived));
        setVerifiedOrgChannels(view.verifiedOrgChannels ?? []);
      }
    } catch {
      // Fallback: full page reload
      window.location.reload();
    }
  };

  if (f.fetchError) {
    return (
      <SettingsShell
        activeTab="channels"
        multiLocationEnabled={props.multiLocationEnabled}
        locationsSettingsEnabled={props.locationsSettingsEnabled}
      >
        <ChannelsClient {...props} />
        <div className="set-section" style={{ borderColor: '#FCA5A5' }}>
          <div className="set-section-title" style={{ color: '#991B1B' }}>Couldn&apos;t load notification preferences</div>
          <p style={{ fontSize: 13, color: '#B91C1C' }}>{f.fetchError}</p>
        </div>
      </SettingsShell>
    );
  }

  if (!f.form || !f.data) {
    return (
      <SettingsShell
        activeTab="channels"
        multiLocationEnabled={props.multiLocationEnabled}
        locationsSettingsEnabled={props.locationsSettingsEnabled}
      >
        <ChannelsClient {...props} />
        <div className="set-section">
          <SettingsSkeleton />
        </div>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell
      activeTab="channels"
      multiLocationEnabled={props.multiLocationEnabled}
      locationsSettingsEnabled={props.locationsSettingsEnabled}
      savedFlash={f.savedFlash}
      saveBar={{
        visible: f.dirty,
        dirtyCount: f.dirtyCount,
        saving: f.saving,
        onSave: () => void f.save(),
        onDiscard: f.discard,
      }}
    >
      {/* Org-level defaults — the existing ChannelsClient */}
      <ChannelsClient {...props} />

      {/* Per-location overrides — collapsed by default. The panel owns its
          own visibility (hidden when there is nothing to list and nothing
          can be added). */}
      <PerLocationOverridePanel
        overrides={overrides}
        locationOptions={locationOptions}
        verifiedOrgChannels={verifiedOrgChannels}
        canAddOverrides={props.canAddOverrides}
        onOverrideAdded={refreshOverrides}
        onOverrideRemoved={refreshOverrides}
      />

      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon sage" aria-hidden>
            <Icon name="clock" size={18} />
          </div>
          <div>
            <div className="set-section-title">Reports &amp; summaries</div>
            <div className="set-section-sub">
              Optional digests delivered to {f.data.settings.ownerEmail}.
            </div>
          </div>
        </div>

        <div className="toggle-row">
          <div className="toggle-info">
            <div className="t-title">Weekly summary</div>
            <div className="t-sub">Every Monday: top reviews, response rate, search ranking moves.</div>
          </div>
          <Switch
            on={f.form.weeklySummaryEnabled}
            onChange={(v) => f.set('weeklySummaryEnabled', v)}
            label="Weekly summary"
          />
        </div>

        <div className="toggle-row">
          <div className="toggle-info">
            <div className="t-title">Monthly impact report</div>
            <div className="t-sub">A bigger-picture brief on the first of the month: time saved, sentiment trends, suggested actions.</div>
          </div>
          <Switch
            on={f.form.monthlyImpactEnabled}
            onChange={(v) => f.set('monthlyImpactEnabled', v)}
            label="Monthly impact report"
          />
        </div>
      </div>

      <div className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon peach" aria-hidden>
            <Icon name="alert" size={18} />
          </div>
          <div>
            <div className="set-section-title">Contact details</div>
            <div className="set-section-sub">Used only for urgent system alerts, never marketing.</div>
          </div>
        </div>

        <div className="two-col">
          <div className="field">
            <label className="field-label" htmlFor="ownerPhone">Phone number</label>
            <input
              id="ownerPhone"
              className="input"
              type="tel"
              value={f.form.ownerPhone}
              onChange={(e) => f.set('ownerPhone', e.target.value)}
              placeholder="+44 7700 900000"
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="ownerEmail">
              Email <span className="locked-pill">Locked</span>
            </label>
            <input
              id="ownerEmail"
              className="input locked"
              value={f.data.settings.ownerEmail}
              disabled
              readOnly
            />
          </div>
        </div>
      </div>

      {f.saveError && (
        <p style={{ fontSize: 13, color: '#DC2626', marginTop: 4 }}>{f.saveError}</p>
      )}
    </SettingsShell>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className={`switch ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}
