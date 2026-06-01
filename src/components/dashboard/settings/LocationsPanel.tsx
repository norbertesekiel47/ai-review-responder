'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/dashboard/Icon';
import type { LocationId } from '@/lib/shared/ids';
import { getDisplayLabel } from '@/lib/locations/display-label';

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
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-backdrop"
        aria-label="Cancel archive"
        onClick={onCancel}
      />
      <div className="modal-content">
        <div className="set-section-title" style={{ marginBottom: 8 }}>
          Archive &ldquo;{locationName}&rdquo;?
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5, marginBottom: 16 }}>
          This location will be archived and its data will become read-only.
          You can restore it later by contacting support.
        </p>
        {/* VAL-LOC-067: Show pending approval count with warning */}
        {pendingApprovalCount > 0 && (
          <div style={{
            marginBottom: 16,
            padding: '10px 12px',
            borderRadius: 8,
            background: '#FEF3C7',
            border: '1px solid #F59E0B',
            fontSize: 13,
            color: '#92400E',
            lineHeight: 1.5,
          }}>
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
      </div>
    </div>
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
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-backdrop"
        aria-label="Close promote first dialog"
        onClick={onCancel}
      />
      <div className="modal-content">
        <div className="set-section-title" style={{ marginBottom: 8 }}>
          Promote first
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5, marginBottom: 16 }}>
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
      </div>
    </div>
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
    <div className="modal-overlay">
      <button
        type="button"
        className="modal-backdrop"
        aria-label="Cancel primary location change"
        onClick={onCancel}
      />
      <div className="modal-content">
        <div className="set-section-title" style={{ marginBottom: 8 }}>
          Make &quot;{locationName}&quot; primary?
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5, marginBottom: 16 }}>
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
      </div>
    </div>
  );
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
  const [archiving, setArchiving] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showPromoteFirst, setShowPromoteFirst] = useState(false);
  const [showPromoteConfirm, setShowPromoteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState(false);
  const [newLabel, setNewLabel] = useState(displayName);
  const [savingLabel, setSavingLabel] = useState(false);

  async function handleArchive() {
    setArchiving(true);
    setError(null);
    try {
      const res = await fetch('/api/locations/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId: location.id, accountId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Archive failed');
      }
      onLocationChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive location');
    } finally {
      setArchiving(false);
      setShowArchiveConfirm(false);
    }
  }

  async function handlePromote() {
    setPromoting(true);
    setError(null);
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
      setError(err instanceof Error ? err.message : 'Failed to promote location');
    } finally {
      setPromoting(false);
      setShowPromoteConfirm(false);
    }
  }

  async function handleSaveLabel() {
    if (newLabel.trim() === displayName) {
      setEditingLabel(false);
      return;
    }
    setSavingLabel(true);
    setError(null);
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
      setEditingLabel(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update label');
    } finally {
      setSavingLabel(false);
    }
  }

  function handleArchiveClick() {
    if (location.isPrimary && !isLastActive) {
      // Primary with other active locations — must promote first
      setShowPromoteFirst(true);
    } else if (isLastActive) {
      // Last active location — cannot archive
      setError('Cannot archive the last active location.');
      setTimeout(() => setError(null), 3000);
    } else {
      // Non-primary — show confirmation dialog
      setShowArchiveConfirm(true);
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
                className="input"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                style={{ fontSize: 14, fontWeight: 600 }}
                aria-label="Location display name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveLabel();
                  if (e.key === 'Escape') { setEditingLabel(false); setNewLabel(displayName); }
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
                onClick={() => { setEditingLabel(false); setNewLabel(displayName); }}
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
                onClick={() => setEditingLabel(true)}
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
            onClick={() => {
              setError(null);
              setShowPromoteConfirm(true);
            }}
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
        <div style={{ fontSize: 12, color: '#DC2626', marginTop: 4, gridColumn: '1 / -1' }}>
          {error}
        </div>
      )}
      {showArchiveConfirm && (
        <ArchiveConfirmModal
          locationName={displayName}
          pendingApprovalCount={location.pendingApprovalCount}
          onConfirm={handleArchive}
          onCancel={() => setShowArchiveConfirm(false)}
          loading={archiving}
        />
      )}
      {showPromoteFirst && (
        <PromoteFirstModal
          locationName={displayName}
          onPromote={() => setShowPromoteFirst(false)}
          onCancel={() => setShowPromoteFirst(false)}
        />
      )}
      {showPromoteConfirm && (
        <PromotePrimaryConfirmModal
          locationName={displayName}
          onConfirm={handlePromote}
          onCancel={() => setShowPromoteConfirm(false)}
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
      const res = await fetch('/api/locations/reactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId: location.id, accountId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Reactivate failed');
      }
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
          <span className="loc-row-name" style={{ color: '#9CA3AF' }}>{displayName}</span>
          <span style={{
            fontSize: 10,
            fontWeight: 500,
            color: '#9CA3AF',
            background: '#F3F4F6',
            padding: '1px 6px',
            borderRadius: 4,
          }}>
            Archived
          </span>
        </div>
        <div className="loc-row-meta">
          {archivedDate && (
            <span style={{ fontSize: 12, color: '#9CA3AF' }}>
              Archived {archivedDate}
            </span>
          )}
        </div>
        {location.address && (
          <div className="loc-row-address" style={{ color: '#9CA3AF' }}>{location.address}</div>
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
        <div style={{ fontSize: 12, color: '#DC2626', marginTop: 4, gridColumn: '1 / -1' }}>
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
          <p style={{ textAlign: 'center', color: '#6B7280', padding: '24px 0' }}>
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
          style={{
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
            transition: 'all 160ms ease',
          }}
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
            background: '#F9FAFB',
          }}
        >
          <div className="set-section-title" style={{ fontSize: 14 }}>
            {addLocationState.title}
          </div>
          <p style={{ margin: '4px 0 0', color: '#6B7280', fontSize: 13, lineHeight: 1.5 }}>
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
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              padding: '8px 0',
              color: '#6B7280',
              fontSize: 13,
              fontWeight: 600,
              textAlign: 'left',
            }}
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
