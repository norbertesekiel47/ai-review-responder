'use client';

// src/components/dashboard/settings/PerLocationOverridePanel.tsx
//
// Per-location channel override panel for the Channels/Notifications tab.
// Shows a collapsed section below the org-level defaults that expands to
// reveal per-location channel overrides.
//
// VAL-SETTINGS-013: Per-location override panel collapsed by default.
// VAL-SETTINGS-014: Adding per-location override clones default values.
// VAL-SETTINGS-015: Per-location override displays location name label.
// VAL-SETTINGS-016: Removing override reverts to org-default.

import { useCallback, useState } from 'react';
import { Icon } from '@/components/dashboard/Icon';

// ── Types ────────────────────────────────────────────────────────────────

export interface PerLocationOverride {
  enrollmentId: string;
  locationId: string;
  locationName: string;
  channel: 'email' | 'sms' | 'telegram' | 'whatsapp';
  handle: string | null;
  status: string;
  verified_at: string | null;
}

export interface LocationOption {
  id: string;
  displayName: string;
  isPrimary: boolean;
}

interface OrgDefaultEnrollment {
  channel: string;
  handle: string | null;
  status: string;
}

interface Props {
  overrides: PerLocationOverride[];
  locationOptions: LocationOption[];
  orgDefaults: OrgDefaultEnrollment[];
  accountId: string;
  onOverrideAdded?: () => void;
  onOverrideRemoved?: () => void;
}

// ── Channel display labels ──────────────────────────────────────────────

const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  telegram: 'Telegram',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
};

const CHANNEL_ICONS: Record<string, string> = {
  email: '✉️',
  telegram: '💬',
  sms: '📱',
  whatsapp: '🟢',
};

// ── Sub-component: Single Override Row ───────────────────────────────────

function OverrideRow({
  override,
  onRemove,
  removing,
}: {
  override: PerLocationOverride;
  onRemove: (enrollmentId: string, locationId: string, channel: string) => void;
  removing: boolean;
}) {
  const isConnected = override.status === 'verified';

  return (
    <div className="channel-row selected" style={{ paddingLeft: 12 }}>
      <div className="channel-icon" aria-hidden>
        {CHANNEL_ICONS[override.channel] ?? '📡'}
      </div>
      <div className="channel-meta">
        <div className="channel-name">
          {CHANNEL_LABELS[override.channel] ?? override.channel}
        </div>
        <div className="channel-handle" style={{ fontSize: 12, color: '#6B7280' }}>
          {override.locationName}
          {isConnected && override.handle && ` · ${override.handle}`}
        </div>
      </div>
      <span className={`channel-status ${isConnected ? 'cs-on' : 'cs-soon'}`}>
        {isConnected ? 'Connected' : override.status}
      </span>
      <button
        type="button"
        className="btn btn-secondary"
        style={{ fontSize: 12, padding: '4px 10px', marginLeft: 8 }}
        onClick={() => onRemove(override.enrollmentId, override.locationId, override.channel)}
        disabled={removing}
      >
        {removing ? 'Removing…' : 'Remove override'}
      </button>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

export function PerLocationOverridePanel({
  overrides,
  locationOptions,
  orgDefaults,
  accountId,
  onOverrideAdded,
  onOverrideRemoved,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [addError, setAddError] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);

  // Group overrides by location
  const overridesByLocation = new Map<string, PerLocationOverride[]>();
  for (const o of overrides) {
    const list = overridesByLocation.get(o.locationId) ?? [];
    list.push(o);
    overridesByLocation.set(o.locationId, list);
  }

  // Only allow adding overrides for channels that have verified org-defaults
  const overridableChannels = orgDefaults
    .filter((d) => d.status === 'verified')
    .map((d) => d.channel);

  // Remove an override
  const handleRemove = useCallback(async (enrollmentId: string, locationId: string, channel: string) => {
    setRemovingIds((prev) => new Set(prev).add(enrollmentId));

    try {
      const res = await fetch('/api/settings/channels/override', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId, channel }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Remove failed (${res.status})`);
      }

      onOverrideRemoved?.();
    } catch (err) {
      console.error('Failed to remove override:', err);
      alert(err instanceof Error ? err.message : 'Failed to remove override');
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(enrollmentId);
        return next;
      });
    }
  }, [onOverrideRemoved]);

  // Add an override for a location
  const handleAdd = useCallback(async (locationId: string, channel: string) => {
    setAddingFor(locationId + ':' + channel);
    setAddError(null);

    try {
      const res = await fetch('/api/settings/channels/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId, channel }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Add failed (${res.status})`);
      }

      onOverrideAdded?.();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add override');
    } finally {
      setAddingFor(null);
    }
  }, [onOverrideAdded]);

  // Don't render the section at all if there are no locations (single-location account)
  if (locationOptions.length <= 1) {
    return null;
  }

  const hasOverrides = overrides.length > 0;
  const overrideCount = overrides.length;

  return (
    <div className="set-section" style={{ marginTop: 16 }}>
      <button
        type="button"
        className="set-section-head"
        style={{ cursor: 'pointer', width: '100%', border: 'none', background: 'none', textAlign: 'left' }}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls="per-location-overrides-content"
      >
        <div className="set-section-icon sage" aria-hidden>
          <Icon name="location" size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <div className="set-section-title">
            Per-location overrides
            {overrideCount > 0 && (
              <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: '#6B7280' }}>
                ({overrideCount})
              </span>
            )}
          </div>
          <div className="set-section-sub">
            Override default channels for individual locations.
          </div>
        </div>
        <div style={{ flexShrink: 0, transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          <Icon name="chevron-down" size={16} />
        </div>
      </button>

      {expanded && (
        <div id="per-location-overrides-content" style={{ marginTop: 8 }}>
          {/* Show existing overrides per location */}
          {locationOptions.map((loc) => {
            const locOverrides = overridesByLocation.get(loc.id) ?? [];
            const overriddenChannels = new Set<string>(locOverrides.map((o) => o.channel));

            // Channels that have verified org-defaults but no per-location override yet
            const availableChannels = overridableChannels.filter(
              (ch) => !overriddenChannels.has(ch),
            );

            return (
              <div key={loc.id} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="location" size={14} />
                  {loc.displayName}
                  {loc.isPrimary && (
                    <span style={{ fontSize: 12, fontWeight: 500, color: '#059669', background: '#ECFDF5', padding: '1px 6px', borderRadius: 4 }}>
                      Primary
                    </span>
                  )}
                </div>

                {/* Existing overrides for this location */}
                {locOverrides.map((o) => (
                  <OverrideRow
                    key={o.enrollmentId}
                    override={o}
                    onRemove={handleRemove}
                    removing={removingIds.has(o.enrollmentId)}
                  />
                ))}

                {/* VAL-SETTINGS-014: Add override button per location per channel */}
                {availableChannels.map((channel) => (
                  <button
                    key={channel}
                    type="button"
                    className="list-add"
                    style={{ marginTop: 4, fontSize: 12, marginLeft: locOverrides.length > 0 ? 0 : 0 }}
                    onClick={() => handleAdd(loc.id, channel)}
                    disabled={addingFor === loc.id + ':' + channel}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    {addingFor === loc.id + ':' + channel
                      ? 'Adding…'
                      : `Add ${CHANNEL_LABELS[channel] ?? channel} override`}
                  </button>
                ))}

                {/* No overrides and no org-defaults to clone */}
                {availableChannels.length === 0 && locOverrides.length === 0 && (
                  <div style={{ fontSize: 12, color: '#9CA3AF', padding: '4px 0' }}>
                    No overrides — uses default channels
                  </div>
                )}
              </div>
            );
          })}

          {addError && (
            <p style={{ fontSize: 13, color: '#DC2626', marginTop: 4 }}>{addError}</p>
          )}
        </div>
      )}
    </div>
  );
}
