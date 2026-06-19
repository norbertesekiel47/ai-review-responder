'use client';

import Link from 'next/link';
import { type CSSProperties, useCallback, useReducer, useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import type { LocationId } from '@/lib/shared/ids';
import { getDisplayLabel } from '@/lib/locations/display-label';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';
import { ownerFacingLocationError } from '@/lib/locations/duplicate-location';

/** Shared POST for location actions; throws with owner-facing copy on denial. */
async function postLocationAction(
  path: string,
  body: Record<string, unknown>,
  fallbackMessage: string,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const resBody = await res.json().catch(() => ({}));
    throw new Error(ownerFacingLocationError(resBody.error, fallbackMessage));
  }
}


// ── Static styles ───────────────────────────────────────────────────────

const PENDING_APPROVAL_WARNING_STYLE: CSSProperties = {
  marginBottom: 16,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'var(--rw-blush-soft)',
  border: '1px solid var(--rw-blush)',
  fontSize: 13,
  color: 'var(--rw-blush-deep)',
  lineHeight: 1.5,
};

const ADD_LOCATION_CTA_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 16,
  padding: '10px 16px',
  border: `1px dashed var(--rw-app-border)`,
  borderRadius: 8,
  color: 'var(--rw-blue-600)',
  fontSize: 14,
  fontWeight: 500,
  textDecoration: 'none',
  transition: 'background-color 160ms ease, border-color 160ms ease, color 160ms ease',
};

const ARCHIVED_TOGGLE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  padding: '8px 0',
  color: 'var(--rw-app-text-muted)',
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'left',
};

// ── Types ──────────────────────────────────────────────────────────────

export interface LocationEntry {
  id: string;
  name: string;
  displayLabel: string | null;
  address: string | null;
  isPrimary: boolean;
  googlePlaceId: string | null;
  zernioStatus: 'none' | 'pending' | 'active' | 'disconnected';
  /** Count of responses with status 'pending_approval' for this location. */
  pendingApprovalCount: number;
}

export interface ArchivedLocationEntry {
  id: string;
  name: string;
  displayLabel: string | null;
  address: string | null;
  archivedAt: string | null;
}

export type AddLocationState =
  | { kind: 'enabled' }
  | {
      kind: 'locked';
      title: string;
      description: string;
      ctaHref?: string;
      ctaLabel?: string;
    };

interface Props {
  locations: LocationEntry[];
  /** Archived locations for the collapsed section. */
  archivedLocations: ArchivedLocationEntry[];
  /** Total active location count (for last-active guard). */
  activeCount: number;
  /** Account ID for API calls. */
  accountId: string;
  /** Whether the account can add another location, or why the action is locked. */
  addLocationState?: AddLocationState;
  /** Destination for the per-location voice action. */
  voiceHref?: string;
  /** Callback after a location is archived or reactivated (for parent to refetch). */
  onLocationChange: () => void;
}

// ── ArchiveConfirmModal ─────────────────────────────────────────────────

function ArchiveConfirmModal({
  locationName,
  pendingApprovalCount,
  onConfirm,
  onCancel,
  loading,
}: {
  locationName: string;
  pendingApprovalCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    <SettingsModal title="Archive location" closeLabel="Cancel archive" onClose={onCancel}>
      <div className="set-section-title" style={{ marginBottom: 8 }}>
        Archive &ldquo;{locationName}&rdquo;?
      </div>
      <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, marginBottom: 16 }}>
        This location will be archived and its data will become read-only.
        You can restore it later by contacting support.
      </p>
      {/* VAL-LOC-067: Show pending approval count with warning */}
      {pendingApprovalCount > 0 && (
        <div style={PENDING_APPROVAL_WARNING_STYLE}>
          <strong>{pendingApprovalCount} pending approval{pendingApprovalCount !== 1 ? 's' : ''}</strong> will not be published after archiving.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={loading}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={onConfirm}
          disabled={loading}
        >
          {loading ? 'Archiving…' : 'Archive'}
        </button>
      </div>
    </SettingsModal>
  );
}

// ── PromoteFirstModal ──────────────────────────────────────────────────

function PromoteFirstModal({
  locationName,
  onPromote,
  onCancel,
}: {
  locationName: string;
  onPromote: () => void;
  onCancel: () => void;
}) {
  return (
    <SettingsModal title="Promote first" closeLabel="Close promote first dialog" onClose={onCancel}>
      <div className="set-section-title" style={{ marginBottom: 8 }}>
        Promote first
      </div>
      <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, marginBottom: 16 }}>
        &ldquo;{locationName}&rdquo; is your primary location. You must promote
        another location to primary before archiving this one.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={onPromote}>
          Go to Locations
        </button>
      </div>
    </SettingsModal>
  );
}

// ── LocationRow ────────────────────────────────────────────────────────

function PromotePrimaryConfirmModal({
  locationName,
  onConfirm,
  onCancel,
  loading,
}: {
  locationName: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    <SettingsModal title="Make location primary" closeLabel="Cancel primary location change" onClose={onCancel}>
      <div className="set-section-title" style={{ marginBottom: 8 }}>
        Make &quot;{locationName}&quot; primary?
      </div>
      <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, marginBottom: 16 }}>
        This changes the primary marker for the account. Existing reviews,
        Google connections, and billing stay attached to their locations.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={loading}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onConfirm}
          disabled={loading}
        >
          {loading ? 'Promoting...' : 'Confirm primary'}
        </button>
      </div>
    </SettingsModal>
  );
}

interface LocationRowState {
  archiving: boolean;
  promoting: boolean;
  showArchiveConfirm: boolean;
  showPromoteFirst: boolean;
  showPromoteConfirm: boolean;
  error: string | null;
  editingLabel: boolean;
  newLabel: string;
  savingLabel: boolean;
}

type LocationRowAction =
  | { type: 'archiveStart' }
  | { type: 'archiveFinish' }
  | { type: 'promoteStart' }
  | { type: 'promoteFinish' }
  | { type: 'stopEditingLabel' }
  | { type: 'saveLabelStart' }
  | { type: 'saveLabelSuccess' }
  | { type: 'saveLabelFinish' }
  | { type: 'setError'; error: string | null }
  | { type: 'showPromoteFirst' }
  | { type: 'showArchiveConfirm' }
  | { type: 'hideArchiveConfirm' }
  | { type: 'hidePromoteFirst' }
  | { type: 'hidePromoteConfirm' }
  | { type: 'setNewLabel'; newLabel: string }
  | { type: 'startEditingLabel' }
  | { type: 'cancelEditingLabel'; displayName: string }
  | { type: 'openPromoteConfirm' };

function locationRowReducer(state: LocationRowState, action: LocationRowAction): LocationRowState {
  switch (action.type) {
    case 'archiveStart':
      return { ...state, archiving: true, error: null };
    case 'archiveFinish':
      return { ...state, archiving: false, showArchiveConfirm: false };
    case 'promoteStart':
      return { ...state, promoting: true, error: null };
    case 'promoteFinish':
      return { ...state, promoting: false, showPromoteConfirm: false };
    case 'stopEditingLabel':
      return { ...state, editingLabel: false };
    case 'saveLabelStart':
      return { ...state, savingLabel: true, error: null };
    case 'saveLabelSuccess':
      return { ...state, editingLabel: false };
    case 'saveLabelFinish':
      return { ...state, savingLabel: false };
    case 'setError':
      return { ...state, error: action.error };
    case 'showPromoteFirst':
      return { ...state, showPromoteFirst: true };
    case 'showArchiveConfirm':
      return { ...state, showArchiveConfirm: true };
    case 'hideArchiveConfirm':
      return { ...state, showArchiveConfirm: false };
    case 'hidePromoteFirst':
      return { ...state, showPromoteFirst: false };
    case 'hidePromoteConfirm':
      return { ...state, showPromoteConfirm: false };
    case 'setNewLabel':
      return { ...state, newLabel: action.newLabel };
    case 'startEditingLabel':
      return { ...state, editingLabel: true };
    case 'cancelEditingLabel':
      return { ...state, editingLabel: false, newLabel: action.displayName };
    case 'openPromoteConfirm':
      return { ...state, error: null, showPromoteConfirm: true };
  }
}

function LocationRow({
  location,
  isLastActive,
  accountId,
  voiceHref,
  onLocationChange,
}: {
  location: LocationEntry;
  isLastActive: boolean;
  accountId: string;
  voiceHref: string;
  onLocationChange: () => void;
}) {
  const displayName = getDisplayLabel(location);
  const [state, dispatch] = useReducer(locationRowReducer, {
    archiving: false,
    promoting: false,
    showArchiveConfirm: false,
    showPromoteFirst: false,
    showPromoteConfirm: false,
    error: null,
    editingLabel: false,
    newLabel: displayName,
    savingLabel: false,
  });
  const { archiving, promoting, showArchiveConfirm, showPromoteFirst, showPromoteConfirm, error, editingLabel, newLabel, savingLabel } = state;
  const focusLabelInput = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
  }, []);

  async function handleArchive() {
    dispatch({ type: 'archiveStart' });
    try {
      await postLocationAction('/api/locations/archive', { locationId: location.id, accountId }, 'Archive failed');
      onLocationChange();
    } catch (err) {
      dispatch({ type: 'setError', error: err instanceof Error ? err.message : 'Failed to archive location' });
    } finally {
      dispatch({ type: 'archiveFinish' });
    }
  }

  async function handlePromote() {
    dispatch({ type: 'promoteStart' });
    try {
      const res = await fetch('/api/locations/promote-primary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPrimaryId: location.id, accountId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Promotion failed');
      }
      onLocationChange();
    } catch (err) {
      dispatch({ type: 'setError', error: err instanceof Error ? err.message : 'Failed to promote location' });
    } finally {
      dispatch({ type: 'promoteFinish' });
    }
  }

  async function handleSaveLabel() {
    if (newLabel.trim() === displayName) {
      dispatch({ type: 'stopEditingLabel' });
      return;
    }
    dispatch({ type: 'saveLabelStart' });
    try {
      const res = await fetch('/api/locations/display-label', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId: location.id, accountId, displayLabel: newLabel.trim() || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to update label');
      }
      onLocationChange();
      dispatch({ type: 'saveLabelSuccess' });
    } catch (err) {
      dispatch({ type: 'setError', error: err instanceof Error ? err.message : 'Failed to update label' });
    } finally {
      dispatch({ type: 'saveLabelFinish' });
    }
  }

  function handleArchiveClick() {
    if (location.isPrimary && !isLastActive) {
      // Primary with other active locations — must promote first
      dispatch({ type: 'showPromoteFirst' });
    } else if (isLastActive) {
      // Last active location — cannot archive
      dispatch({ type: 'setError', error: 'Cannot archive the last active location.' });
      setTimeout(() => dispatch({ type: 'setError', error: null }), 3000);
    } else {
      // Non-primary — show confirmation dialog
      dispatch({ type: 'showArchiveConfirm' });
    }
  }

  const zernioLabel = {
    none: 'Not connected',
    pending: 'Connecting…',
    active: 'Connected',
    disconnected: 'Disconnected',
  }[location.zernioStatus];

  const zernioClass = {
    none: 'cs-soon',
    pending: 'cs-pick',
    active: 'cs-on',
    disconnected: 'cs-soon',
  }[location.zernioStatus];
  const connectActionLabel = {
    none: 'Connect Google',
    pending: 'Continue setup',
    active: null,
    disconnected: 'Reconnect Google',
  }[location.zernioStatus];
  const connectHref = `/dashboard/connect?locationId=${encodeURIComponent(location.id)}`;

  return (
    <div className={`loc-row ${location.isPrimary ? 'primary' : ''}`}>
      <div className="loc-row-info">
        <div className="loc-row-name-wrap">
          {editingLabel ? (
            <div className="loc-row-edit">
              <input
                ref={focusLabelInput}
                className="input"
                value={newLabel}
                onChange={(e) => dispatch({ type: 'setNewLabel', newLabel: e.target.value })}
                style={{ fontSize: 14, fontWeight: 600 }}
                aria-label="Location display name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveLabel();
                  if (e.key === 'Escape') { dispatch({ type: 'cancelEditingLabel', displayName }); }
                }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={handleSaveLabel}
                disabled={savingLabel}
              >
                {savingLabel ? '…' : 'Save'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => dispatch({ type: 'cancelEditingLabel', displayName })}
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <span className="loc-row-name">{displayName}</span>
              <button
                type="button"
                className="loc-row-edit-btn"
                onClick={() => dispatch({ type: 'startEditingLabel' })}
                title="Edit display label"
              >
                <Icon name="edit" size={12} />
              </button>
            </>
          )}
          {location.isPrimary && <span className="primary-badge">Primary</span>}
        </div>
        <div className="loc-row-meta">
          <span className={`channel-status zernio-status ${zernioClass}`}>
            {zernioLabel}
          </span>
        </div>
        {location.address && (
          <div className="loc-row-address">{location.address}</div>
        )}
      </div>
      <div className="loc-row-actions">
        {!location.isPrimary && (
          <button
            type="button"
            className="btn btn-secondary loc-action-btn"
            onClick={() => dispatch({ type: 'openPromoteConfirm' })}
            disabled={promoting}
            title="Set as primary location"
          >
            <Icon name="check" size={12} /> {promoting ? '…' : 'Make primary'}
          </button>
        )}
        {connectActionLabel && (
          <Link
            href={connectHref}
            className="btn btn-primary loc-action-btn"
            title={`${connectActionLabel} for ${displayName}`}
          >
            <Icon name="google" size={12} /> {connectActionLabel}
          </Link>
        )}
        <a
          href={voiceHref}
          className="btn btn-secondary loc-action-btn"
          title="Edit voice configuration"
        >
          <Icon name="sparkle" size={12} /> Voice
        </a>
        <button
          type="button"
          className="btn-danger loc-action-btn"
          onClick={handleArchiveClick}
          disabled={archiving}
        >
          <Icon name="alert" size={12} /> Archive
        </button>
      </div>
      {error && (
        <div style={{ fontSize: 12, color: 'var(--rw-danger)', marginTop: 4, gridColumn: '1 / -1' }}>
          {error}
        </div>
      )}
      {showArchiveConfirm && (
        <ArchiveConfirmModal
          locationName={displayName}
          pendingApprovalCount={location.pendingApprovalCount}
          onConfirm={handleArchive}
          onCancel={() => dispatch({ type: 'hideArchiveConfirm' })}
          loading={archiving}
        />
      )}
      {showPromoteFirst && (
        <PromoteFirstModal
          locationName={displayName}
          onPromote={() => dispatch({ type: 'hidePromoteFirst' })}
          onCancel={() => dispatch({ type: 'hidePromoteFirst' })}
        />
      )}
      {showPromoteConfirm && (
        <PromotePrimaryConfirmModal
          locationName={displayName}
          onConfirm={handlePromote}
          onCancel={() => dispatch({ type: 'hidePromoteConfirm' })}
          loading={promoting}
        />
      )}
    </div>
  );
}

// ── ArchivedLocationRow ──────────────────────────────────────────────

function ArchivedLocationRow({
  location,
  accountId,
  onLocationChange,
}: {
  location: ArchivedLocationEntry;
  accountId: string;
  onLocationChange: () => void;
}) {
  const displayName = location.displayLabel ?? location.name;
  const [reactivating, setReactivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReactivate() {
    setReactivating(true);
    setError(null);
    try {
      await postLocationAction('/api/locations/reactivate', { locationId: location.id, accountId }, 'Reactivate failed');
      onLocationChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reactivate location');
    } finally {
      setReactivating(false);
    }
  }

  const archivedDate = location.archivedAt
    ? new Date(location.archivedAt).toLocaleDateString()
    : null;

  return (
    <div className="loc-row archived">
      <div className="loc-row-info">
        <div className="loc-row-name-wrap">
          <span className="loc-row-name" style={{ color: 'var(--rw-app-text-soft)' }}>{displayName}</span>
          <span style={{
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--rw-app-text-soft)',
            background: 'var(--rw-recess)',
            padding: '1px 6px',
            borderRadius: 4,
          }}>
            Archived
          </span>
        </div>
        <div className="loc-row-meta">
          {archivedDate && (
            <span style={{ fontSize: 12, color: 'var(--rw-app-text-soft)' }}>
              Archived {archivedDate}
            </span>
          )}
        </div>
        {location.address && (
          <div className="loc-row-address" style={{ color: 'var(--rw-app-text-soft)' }}>{location.address}</div>
        )}
      </div>
      <div className="loc-row-actions">
        <button
          type="button"
          className="btn btn-secondary loc-action-btn"
          onClick={handleReactivate}
          disabled={reactivating}
          title="Reactivate this location"
        >
          <Icon name="check" size={12} /> {reactivating ? '…' : 'Reactivate'}
        </button>
      </div>
      {error && (
        <div style={{ fontSize: 12, color: 'var(--rw-danger)', marginTop: 4, gridColumn: '1 / -1' }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── LocationsPanel ─────────────────────────────────────────────────────

export function LocationsPanel({
  locations,
  archivedLocations,
  activeCount,
  accountId,
  addLocationState = { kind: 'enabled' },
  voiceHref = '/settings/voice',
  onLocationChange,
}: Props) {
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  return (
    <div className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon sage">
          <Icon name="location" size={18} />
        </div>
        <div>
          <div className="set-section-title">Locations</div>
          <div className="set-section-sub">
            Manage your locations. Promote, archive, or edit display names.
          </div>
        </div>
      </div>

      <div className="loc-list">
        {locations.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--rw-app-text-muted)', padding: '24px 0' }}>
            No active locations.
          </p>
        )}
        {locations.map((loc) => (
          <LocationRow
            key={loc.id}
            location={loc}
            isLastActive={activeCount <= 1}
            accountId={accountId}
            voiceHref={voiceHref}
            onLocationChange={onLocationChange}
          />
        ))}
      </div>

      {addLocationState.kind === 'enabled' ? (
        <Link
          href="/dashboard/add-location"
          className="loc-add-cta"
          style={ADD_LOCATION_CTA_STYLE}
        >
          <Icon name="plus" size={14} />
          Add location
        </Link>
      ) : (
        <div
          style={{
            marginTop: 16,
            padding: '12px 14px',
            border: '1px solid var(--rw-app-border)',
            borderRadius: 8,
            background: 'var(--rw-recess)',
          }}
        >
          <div className="set-section-title" style={{ fontSize: 14 }}>
            {addLocationState.title}
          </div>
          <p style={{ margin: '4px 0 0', color: 'var(--rw-app-text-muted)', fontSize: 13, lineHeight: 1.5 }}>
            {addLocationState.description}
          </p>
          {addLocationState.ctaHref && addLocationState.ctaLabel && (
            <Link
              href={addLocationState.ctaHref}
              className="btn btn-secondary"
              style={{ marginTop: 10, display: 'inline-flex', textDecoration: 'none' }}
            >
              {addLocationState.ctaLabel}
            </Link>
          )}
        </div>
      )}

      {/* VAL-SETTINGS-038: Archived locations in collapsed section */}
      {/* VAL-LOC-070: Each archived location has a Reactivate button */}
      {archivedLocations.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <button
            type="button"
            onClick={() => setArchivedExpanded(!archivedExpanded)}
            style={ARCHIVED_TOGGLE_STYLE}
            aria-expanded={archivedExpanded}
            aria-controls="archived-locations-content"
          >
            <span style={{
              transition: 'transform 0.2s',
              transform: archivedExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              display: 'inline-flex',
            }}>
              <Icon name="chevron-down" size={14} />
            </span>
            Archived ({archivedLocations.length})
          </button>

          {archivedExpanded && (
            <div id="archived-locations-content" style={{ marginTop: 4 }}>
              {archivedLocations.map((loc) => (
                <ArchivedLocationRow
                  key={loc.id}
                  location={loc}
                  accountId={accountId}
                  onLocationChange={onLocationChange}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
