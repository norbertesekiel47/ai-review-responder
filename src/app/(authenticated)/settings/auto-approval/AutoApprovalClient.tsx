'use client';

import { useEffect, useMemo, useReducer, useRef } from 'react';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';
import { Icon } from '@/components/dashboard/shell/Icon';
import { isThresholdExpansion } from '@/lib/auto-approval/policy';
import type {
  AutoApprovalConfirmationLevel,
  AutoApprovalLocationSettings,
  AutoApprovalPatchRequest,
  AutoApprovalReadinessBlockReason,
  AutoApprovalSettingsResponse,
  AutoApprovalThreshold,
} from '@/lib/auto-approval/types';

const THRESHOLD_OPTIONS: Array<{ value: AutoApprovalThreshold | null; label: string }> = [
  { value: null, label: 'Off/manual' },
  { value: 5, label: '5-star only' },
  { value: 4, label: '4-5' },
  { value: 3, label: '3-5' },
  { value: 2, label: '2-5' },
  { value: 1, label: 'All rated' },
];

const BLOCK_REASON_COPY: Record<AutoApprovalReadinessBlockReason, string> = {
  auto_approval_disabled: 'Auto-approval is not enabled for this environment.',
  provider_moderation_disabled: 'Provider moderation is not enabled.',
  provider_moderation_not_validated: 'Provider moderation readiness has not been validated.',
  subscription_not_writable: 'The account cannot expand automation while billing is read-only.',
  preview_environment: 'Preview environments cannot expand auto-approval.',
  impersonation_not_allowed: 'View-as sessions cannot change auto-approval.',
};

interface Props {
  initialState: AutoApprovalSettingsResponse;
  multiLocationEnabled?: boolean;
  locationsSettingsEnabled?: boolean;
}

interface PendingConfirmation {
  request: AutoApprovalPatchRequest;
  required: AutoApprovalConfirmationLevel;
  label: string;
}

type SelectValue = 'inherit' | 'manual' | `${AutoApprovalThreshold}`;

interface ClientState {
  data: AutoApprovalSettingsResponse;
  saveError: string | null;
  savingKey: string | null;
  savedFlash: boolean;
  pendingConfirmation: PendingConfirmation | null;
}

type ClientAction =
  | { type: 'save_started'; key: string }
  | { type: 'save_succeeded'; data: AutoApprovalSettingsResponse }
  | { type: 'save_failed'; message: string }
  | { type: 'clear_saved_flash' }
  | { type: 'set_pending_confirmation'; pending: PendingConfirmation | null };

function clientReducer(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case 'save_started':
      return { ...state, savingKey: action.key, saveError: null };
    case 'save_succeeded':
      return { ...state, data: action.data, savingKey: null, saveError: null, savedFlash: true };
    case 'save_failed':
      return { ...state, savingKey: null, saveError: action.message };
    case 'clear_saved_flash':
      return { ...state, savedFlash: false };
    case 'set_pending_confirmation':
      return { ...state, pendingConfirmation: action.pending };
  }
}

export function AutoApprovalClient({ initialState }: Props) {
  const [state, dispatch] = useReducer(clientReducer, {
    data: initialState,
    saveError: null,
    savingKey: null,
    savedFlash: false,
    pendingConfirmation: null,
  });
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount-only cleanup reading a stable ref; the empty dep array is intentional (refs are not reactive deps).
  // react-doctor-disable-next-line react-doctor/exhaustive-deps
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  const blockCopy = useMemo(
    () => state.data.readiness.blockReasons.map((reason) => BLOCK_REASON_COPY[reason]),
    [state.data.readiness.blockReasons],
  );

  async function sendPatch(
    request: AutoApprovalPatchRequest,
    key: string,
    confirmationLevel?: AutoApprovalConfirmationLevel,
  ) {
    dispatch({ type: 'save_started', key });
    try {
      const res = await fetch('/api/settings/auto-approval', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...request,
          ...(confirmationLevel ? { confirmationLevel } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(errorMessage(body, res.status));
      }
      dispatch({ type: 'save_succeeded', data: body as AutoApprovalSettingsResponse });
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => dispatch({ type: 'clear_saved_flash' }), 1800);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save auto-approval settings';
      dispatch({ type: 'save_failed', message });
    }
  }

  function requestChange(
    request: AutoApprovalPatchRequest,
    key: string,
    before: AutoApprovalThreshold | null,
    after: AutoApprovalThreshold | null,
    label: string,
  ) {
    if (!isThresholdExpansion(before, after)) {
      void sendPatch(request, key);
      return;
    }

    const required = after === 1 ? 'all_ratings' : 'standard';
    dispatch({ type: 'set_pending_confirmation', pending: { request, required, label } });
  }

  function confirmPending() {
    if (!state.pendingConfirmation) return;
    const key = requestKey(state.pendingConfirmation.request);
    const confirmation = state.pendingConfirmation.required;
    const request = state.pendingConfirmation.request;
    dispatch({ type: 'set_pending_confirmation', pending: null });
    void sendPatch(request, key, confirmation);
  }

  const { data, saveError, savedFlash, savingKey, pendingConfirmation } = state;
  const accountSelectValue = thresholdSelectValue(data.accountDefault.threshold);

  return (
    <SettingsShell
      savedFlash={savedFlash}
      saveError={saveError ?? undefined}
    >
      <section className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon sage">
            <Icon name="shield" size={18} />
          </div>
          <div>
            <h2 className="set-section-title">Auto-approval</h2>
            <div className="set-section-sub">
              Matching rated reviews can post to Google automatically without owner review after safety and connection checks pass.
            </div>
          </div>
        </div>

        <ReadinessBlock copy={blockCopy} />

        <label className="field">
          <span className="field-label">Account default policy</span>
          <select
            className="input"
            aria-label="Account default policy"
            value={accountSelectValue}
            disabled={savingKey === 'account'}
            onChange={(event) => {
              const value = event.target.value as SelectValue;
              const threshold = thresholdFromValue(value);
              const request: AutoApprovalPatchRequest = threshold === null
                ? { operation: 'set_account_manual' }
                : { operation: 'set_account_default', threshold };
              requestChange(
                request,
                'account',
                data.accountDefault.threshold,
                threshold,
                'the account default',
              );
            }}
          >
            {THRESHOLD_OPTIONS.map((option) => {
              const value = thresholdSelectValue(option.value);
              const expands = isThresholdExpansion(data.accountDefault.threshold, option.value);
              return (
                <option
                  key={value}
                  value={value}
                  disabled={expands && !data.readiness.canExpand}
                >
                  {option.label}
                </option>
              );
            })}
          </select>
          <span className="field-hint">
            New and reactivated active locations inherit this default unless they have a location override.
          </span>
        </label>
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon blue">
            <Icon name="location" size={18} />
          </div>
          <div>
            <div className="set-section-title">Locations</div>
            <div className="set-section-sub">Each active location can inherit the account default or use its own manual/threshold policy.</div>
          </div>
        </div>

        <div className="auto-policy-location-list">
          {data.locations.map((location) => (
            <LocationPolicyRow
              key={location.locationId}
              location={location}
              accountThreshold={data.accountDefault.threshold}
              canExpand={data.readiness.canExpand}
              saving={savingKey === location.locationId}
              onRequestChange={(request, before, after) =>
                requestChange(request, location.locationId, before, after, location.displayName)}
            />
          ))}
          {data.locations.length === 0 && (
            <p className="set-section-sub">No active locations are available for this account.</p>
          )}
        </div>
      </section>

      {saveError && (
        <p style={{ fontSize: 13, color: '#DC2626', marginTop: -8 }}>{saveError}</p>
      )}

      {pendingConfirmation && (
        <SettingsModal
          title="Confirm auto-approval change"
          closeLabel="Cancel auto-approval change"
          onClose={() => dispatch({ type: 'set_pending_confirmation', pending: null })}
        >
          <div className="set-section-title" style={{ marginBottom: 8 }}>
            Confirm auto-approval change
          </div>
          <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.5, marginBottom: 12 }}>
            This expands auto-approval for {pendingConfirmation.label}. Matching rated reviews can post to Google automatically without owner review when safety, billing, active location, and Google connection checks pass.
          </p>
          {pendingConfirmation.required === 'all_ratings' && (
            <div className="auto-policy-warning">
              All rated includes every rated review, including 1-star and 2-star reviews, when all runtime safety checks pass.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => dispatch({ type: 'set_pending_confirmation', pending: null })}
            >
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={confirmPending}>
              Confirm auto-approval
            </button>
          </div>
        </SettingsModal>
      )}
    </SettingsShell>
  );
}

function LocationPolicyRow({
  location,
  accountThreshold,
  canExpand,
  saving,
  onRequestChange,
}: {
  location: AutoApprovalLocationSettings;
  accountThreshold: AutoApprovalThreshold | null;
  canExpand: boolean;
  saving: boolean;
  onRequestChange: (
    request: AutoApprovalPatchRequest,
    before: AutoApprovalThreshold | null,
    after: AutoApprovalThreshold | null,
  ) => void;
}) {
  const value = location.override.exists
    ? thresholdSelectValue(location.override.threshold)
    : 'inherit';

  return (
    <div className="auto-policy-location-row">
      <div>
        <div className="auto-policy-location-name">{location.displayName}</div>
        <div className="auto-policy-location-sub">
          {location.effective.inherited ? 'Inherited from account' : 'Location override'} · Effective {thresholdLabel(location.effective.threshold)}
        </div>
      </div>
      <select
        className="input auto-policy-location-select"
        aria-label={`Auto-approval policy for ${location.displayName}`}
        value={value}
        disabled={saving}
        onChange={(event) => {
          const selected = event.target.value as SelectValue;
          const after = selected === 'inherit'
            ? accountThreshold
            : thresholdFromValue(selected);
          const request = locationRequest(location.locationId, selected);
          onRequestChange(request, location.effective.threshold, after);
        }}
      >
        <option
          value="inherit"
          disabled={isThresholdExpansion(location.effective.threshold, accountThreshold) && !canExpand}
        >
          Inherit account default
        </option>
        {THRESHOLD_OPTIONS.map((option) => {
          const optionValue = thresholdSelectValue(option.value);
          const expands = isThresholdExpansion(location.effective.threshold, option.value);
          return (
            <option
              key={optionValue}
              value={optionValue}
              disabled={expands && !canExpand}
            >
              {option.label}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function ReadinessBlock({ copy }: { copy: string[] }) {
  if (copy.length === 0) {
    return (
      <div className="auto-policy-readiness ok">
        <Icon name="check" size={14} /> Expansion changes are available.
      </div>
    );
  }

  return (
    <div className="auto-policy-readiness blocked">
      <Icon name="alert" size={14} />
      <div>
        {copy.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
    </div>
  );
}

function thresholdSelectValue(threshold: AutoApprovalThreshold | null): SelectValue {
  return threshold === null ? 'manual' : `${threshold}`;
}

function thresholdFromValue(value: SelectValue): AutoApprovalThreshold | null {
  if (value === 'inherit' || value === 'manual') return null;
  return Number(value) as AutoApprovalThreshold;
}

function thresholdLabel(threshold: AutoApprovalThreshold | null): string {
  return THRESHOLD_OPTIONS.find((option) => option.value === threshold)?.label ?? 'Off/manual';
}

function locationRequest(locationId: string, value: SelectValue): AutoApprovalPatchRequest {
  if (value === 'inherit') return { operation: 'delete_location_override', locationId };
  if (value === 'manual') return { operation: 'set_location_manual', locationId };
  return { operation: 'set_location_override', locationId, threshold: Number(value) as AutoApprovalThreshold };
}

function requestKey(request: AutoApprovalPatchRequest): string {
  return 'locationId' in request ? request.locationId : 'account';
}

function errorMessage(body: unknown, status: number): string {
  const error = readErrorCode(body);
  if (!error) return `Save failed (${status})`;

  if (error === 'auto_approval_expansion_blocked') {
    return blockedErrorMessage(body) || error.replace(/_/g, ' ');
  }
  if (error === 'auto_approval_confirmation_required') {
    return 'This change needs confirmation before it can be saved.';
  }
  return error.replace(/_/g, ' ');
}

function readErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  return 'error' in body && typeof body.error === 'string' ? body.error : null;
}

function blockedErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object' || !('blockReasons' in body) || !Array.isArray(body.blockReasons)) {
    return '';
  }

  return body.blockReasons
    .filter((reason): reason is AutoApprovalReadinessBlockReason => typeof reason === 'string' && reason in BLOCK_REASON_COPY)
    .map((reason) => BLOCK_REASON_COPY[reason])
    .join(' ');
}
