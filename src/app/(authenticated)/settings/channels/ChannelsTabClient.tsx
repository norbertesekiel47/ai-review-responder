'use client';

import { useSettingsForm } from '@/hooks/useSettingsForm';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { Icon } from '@/components/dashboard/Icon';
import { ChannelsClient, type ChannelsClientProps } from './ChannelsClient';

/**
 * Owns the Notifications tab as a whole:
 *   1. The existing ChannelsClient (Email + Telegram + SMS + WhatsApp rows).
 *   2. Reports & summaries (weekly + monthly toggles).
 *   3. Contact details (phone editable + email locked).
 *
 * Sections 2 and 3 hydrate from `/api/dashboard` via useSettingsForm and save
 * via PUT /api/settings — preserving the patch-shape contract that the legacy
 * Settings General form used.
 */
export function ChannelsTabClient(props: ChannelsClientProps) {
  const f = useSettingsForm();

  if (f.fetchError) {
    return (
      <SettingsShell activeTab="channels">
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
      <SettingsShell activeTab="channels">
        <ChannelsClient {...props} />
        <div className="set-section">
          <p style={{ textAlign: 'center', color: '#6B7280', padding: '24px 0' }}>Loading preferences…</p>
        </div>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell
      activeTab="channels"
      savedFlash={f.savedFlash}
      saveBar={{
        visible: f.dirty,
        dirtyCount: f.dirtyCount,
        saving: f.saving,
        onSave: () => void f.save(),
        onDiscard: f.discard,
      }}
    >
      <ChannelsClient {...props} />

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
            <div className="t-sub">Every Monday — top reviews, response rate, search ranking moves.</div>
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
            <div className="t-sub">A bigger-picture brief on the first of the month — time saved, sentiment trends, suggested actions.</div>
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
            <div className="set-section-sub">Used only for urgent system alerts — never marketing.</div>
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
            <label className="field-label">
              Email <span className="locked-pill">Locked</span>
            </label>
            <input className="input locked" value={f.data.settings.ownerEmail} disabled readOnly />
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
