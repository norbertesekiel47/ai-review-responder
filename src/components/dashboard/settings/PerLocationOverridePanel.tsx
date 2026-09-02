'use client';

// src/components/dashboard/settings/PerLocationOverridePanel.tsx
//
// Per-location channel override panel for the Channels/Notifications tab.
// Shows a collapsed section below the org-level defaults that expands to
// reveal per-location channel overrides.
//
// Commit model: add/remove apply immediately. Removal is consequential, so it
// confirms through ConfirmDialog with the consequence spelled out; failures
// render inline beside the row they belong to, never in a browser dialog
// (UX audit S14). Successes confirm through the shared Console toast.
//
// The mutation state machine (in-flight ids, per-row errors, the add error)
// lives in useOverrideMutations; the groupings and the endpoint call are pure
// functions in PerLocationOverridePanel.helpers.ts.
//
// VAL-SETTINGS-013: Per-location override panel collapsed by default.
// VAL-SETTINGS-014: Adding per-location override clones default values.
// VAL-SETTINGS-015: Per-location override displays location name label.
// VAL-SETTINGS-016: Removing override reverts to org-default.

import { useCallback, useState, type ReactNode } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { ConfirmDialog } from '@/components/dashboard/settings/ConfirmDialog';
import { useToast } from '@/components/dashboard/shell/toast/ToastProvider';
import type { PerLocationOverride } from '@/lib/channels/overrides-view';
import type { ChannelId } from '@/lib/notifications/channels/types';
import {
  channelIcon,
  channelLabel,
  formatOverrideLocationLabel,
  groupInactiveOverrides,
  groupOverridesByLocation,
  mutateOverride,
  removeOverrideConsequence,
} from './PerLocationOverridePanel.helpers';

// ── Types ────────────────────────────────────────────────────────────────

// DTO is owned by the override view module (type-only import — client-safe).
export type { PerLocationOverride } from '@/lib/channels/overrides-view';

export interface LocationOption {
  id: string;
  displayName: string;
  isPrimary: boolean;
}

interface Props {
  overrides: PerLocationOverride[];
  locationOptions: LocationOption[];
  /** Org-default channels eligible to spawn overrides (live verified enrollment). */
  verifiedOrgChannels: ChannelId[];
  /** Eligibility to ADD overrides — existing ones stay listable/deletable regardless. */
  canAddOverrides: boolean;
  onOverrideAdded?: () => void;
  onOverrideRemoved?: () => void;
}

// ── Mutation state ───────────────────────────────────────────────────────

/**
 * Add/remove overrides against the endpoint and hold the UI state each leaves
 * behind: which rows are mid-removal, the last removal failure per row, and
 * the last add failure. Success confirms through the toast and the parent
 * refetch callback; failure stays inline (S14).
 */
function useOverrideMutations({
  onOverrideAdded,
  onOverrideRemoved,
}: Pick<Props, 'onOverrideAdded' | 'onOverrideRemoved'>) {
  const { toast } = useToast();
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);

  const remove = useCallback(async (override: PerLocationOverride) => {
    const { enrollmentId, locationId, channel } = override;
    setRemovingIds((prev) => new Set(prev).add(enrollmentId));
    setRemoveErrors((prev) => {
      if (!(enrollmentId in prev)) return prev;
      const next = { ...prev };
      delete next[enrollmentId];
      return next;
    });

    try {
      await mutateOverride('DELETE', 'Remove', locationId, channel);
      toast({
        tone: 'success',
        title: 'Override removed',
        body: removeOverrideConsequence(override),
      });
      onOverrideRemoved?.();
    } catch (err) {
      setRemoveErrors((prev) => ({
        ...prev,
        [enrollmentId]: err instanceof Error ? err.message : 'Failed to remove override',
      }));
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(enrollmentId);
        return next;
      });
    }
  }, [onOverrideRemoved, toast]);

  const add = useCallback(async (locationId: string, channel: string) => {
    setAddingFor(locationId + ':' + channel);
    setAddError(null);

    try {
      await mutateOverride('POST', 'Add', locationId, channel);
      toast({ tone: 'success', title: `${channelLabel(channel)} override added` });
      onOverrideAdded?.();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add override');
    } finally {
      setAddingFor(null);
    }
  }, [onOverrideAdded, toast]);

  return { removingIds, removeErrors, addError, addingFor, remove, add };
}

// ── Sub-component: Single Override Row ───────────────────────────────────

function OverrideRow({
  override,
  onRemove,
  removing,
  error,
}: {
  override: PerLocationOverride;
  onRemove: (override: PerLocationOverride) => void;
  removing: boolean;
  /** The last removal failure for THIS row, rendered inline beside the control. */
  error: string | null;
}) {
  const isConnected = override.status === 'verified';
  const errorId = `override-error-${override.enrollmentId}`;

  return (
    <div className="channel-row selected override-row">
      <div className="channel-icon" aria-hidden>
        {channelIcon(override.channel)}
      </div>
      <div className="channel-meta">
        <div className="channel-name">
          {channelLabel(override.channel)}
        </div>
        <div className="channel-handle">
          {formatOverrideLocationLabel(override)}
          {isConnected && override.handle && ` · ${override.handle}`}
        </div>
        {error && (
          <p id={errorId} role="alert" className="settings-error-copy settings-error-copy--compact settings-error-copy--after">
            {error}
          </p>
        )}
      </div>
      <span className={`channel-status ${isConnected ? 'cs-on' : 'cs-soon'}`}>
        {isConnected ? 'Connected' : override.status}
      </span>
      <button
        type="button"
        className="btn btn-secondary override-remove"
        onClick={() => onRemove(override)}
        disabled={removing}
        aria-describedby={error ? errorId : undefined}
      >
        {removing ? 'Removing…' : 'Remove override'}
      </button>
    </div>
  );
}

// ── Sub-components: per-location groups ──────────────────────────────────

const GROUP_LABEL_STYLE = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--rw-app-text)',
  marginBottom: 4,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
} as const;

/** One active location: its overrides, then an "Add … override" per channel still on the org default. */
function ActiveLocationGroup({
  location,
  rows,
  availableChannels,
  canAddOverrides,
  addingFor,
  onAdd,
}: {
  location: LocationOption;
  rows: ReactNode[];
  /** Channels with a verified org-default but no override for this location yet. */
  availableChannels: string[];
  canAddOverrides: boolean;
  addingFor: string | null;
  onAdd: (locationId: string, channel: string) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={GROUP_LABEL_STYLE}>
        <Icon name="location" size={14} />
        {location.displayName}
        {location.isPrimary && (
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--rw-sage-deep)', background: 'var(--rw-sage-soft)', padding: '1px 6px', borderRadius: 4 }}>
            Primary
          </span>
        )}
      </div>

      {/* Existing overrides for this location */}
      {rows}

      {/* VAL-SETTINGS-014: Add override button per location per channel.
          Creation is gated on canAddOverrides — ineligible owners can
          still view and delete existing overrides, just not add new ones. */}
      {canAddOverrides && availableChannels.map((channel) => {
        const adding = addingFor === location.id + ':' + channel;
        return (
          <button
            key={channel}
            type="button"
            className="list-add"
            style={{ marginTop: 4, fontSize: 12 }}
            onClick={() => onAdd(location.id, channel)}
            disabled={adding}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {adding ? 'Adding…' : `Add ${channelLabel(channel)} override`}
          </button>
        );
      })}

      {/* No overrides and no org-defaults to clone */}
      {availableChannels.length === 0 && rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--rw-app-text-soft)', padding: '4px 0' }}>
          No overrides, uses default channels
        </div>
      )}
    </div>
  );
}

/**
 * E4/E5: overrides on archived locations (DTO archived flag). These stay
 * listable + deletable but get NO "Add override" buttons — you cannot add an
 * override to an inactive location. The " (archived)" suffix is derived from
 * the flag at render time.
 */
function InactiveLocationGroup({
  locationId,
  overrides,
  rows,
}: {
  locationId: string;
  overrides: PerLocationOverride[];
  rows: ReactNode[];
}) {
  const firstOverride = overrides[0];
  const label = firstOverride ? formatOverrideLocationLabel(firstOverride) : locationId;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={GROUP_LABEL_STYLE}>
        <Icon name="location" size={14} />
        {label}
      </div>
      {rows}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

export function PerLocationOverridePanel({
  overrides,
  locationOptions,
  verifiedOrgChannels,
  canAddOverrides,
  onOverrideAdded,
  onOverrideRemoved,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<PerLocationOverride | null>(null);
  const mutations = useOverrideMutations({ onOverrideAdded, onOverrideRemoved });

  // The panel owns its visibility: hidden only when there is nothing to list
  // AND nothing can be added. Once overrides exist they must remain
  // listable+deletable even after losing add-eligibility (flag off, or
  // archiving back to a single location) — creation controls are gated
  // separately below.
  if (overrides.length === 0 && !canAddOverrides) {
    return null;
  }

  const overridesByLocation = groupOverridesByLocation(overrides);
  const inactiveOverridesByLocation = groupInactiveOverrides(
    overrides,
    new Set(locationOptions.map((l) => l.id)),
  );
  const overrideCount = overrides.length;

  const renderRows = (rows: PerLocationOverride[]) => rows.map((o) => (
    <OverrideRow
      key={o.enrollmentId}
      override={o}
      onRemove={setPendingRemoval}
      removing={mutations.removingIds.has(o.enrollmentId)}
      error={mutations.removeErrors[o.enrollmentId] ?? null}
    />
  ));

  // Remove an override — only ever reached from the confirmation dialog.
  const confirmRemoval = (override: PerLocationOverride) => {
    setPendingRemoval(null);
    void mutations.remove(override);
  };

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
              <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: 'var(--rw-app-text-muted)' }}>
                ({overrideCount})
              </span>
            )}
          </div>
          <div className="set-section-sub">
            Override default channels for individual locations. Changes here apply immediately.
          </div>
        </div>
        <div style={{ flexShrink: 0, transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          <Icon name="chevron-down" size={16} />
        </div>
      </button>

      {expanded && (
        <div id="per-location-overrides-content" style={{ marginTop: 8 }}>
          {locationOptions.map((loc) => {
            const locOverrides = overridesByLocation.get(loc.id) ?? [];
            const overriddenChannels = new Set<string>(locOverrides.map((o) => o.channel));
            return (
              <ActiveLocationGroup
                key={loc.id}
                location={loc}
                rows={renderRows(locOverrides)}
                availableChannels={verifiedOrgChannels.filter((ch) => !overriddenChannels.has(ch))}
                canAddOverrides={canAddOverrides}
                addingFor={mutations.addingFor}
                onAdd={mutations.add}
              />
            );
          })}

          {[...inactiveOverridesByLocation.entries()].map(([locId, locOverrides]) => (
            <InactiveLocationGroup
              key={locId}
              locationId={locId}
              overrides={locOverrides}
              rows={renderRows(locOverrides)}
            />
          ))}

          {mutations.addError && (
            <p role="alert" className="settings-error-copy settings-error-copy--after">{mutations.addError}</p>
          )}
        </div>
      )}

      {pendingRemoval && (
        <ConfirmDialog
          title="Remove override"
          closeLabel="Keep this override"
          heading={`Remove the ${channelLabel(pendingRemoval.channel)} override for ${pendingRemoval.locationName}?`}
          body={`${removeOverrideConsequence(pendingRemoval)} You can add it back at any time.`}
          cancelLabel="Keep override"
          confirmLabel="Remove override"
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => confirmRemoval(pendingRemoval)}
        />
      )}
    </div>
  );
}
