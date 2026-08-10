'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { FocusEvent } from 'react';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { SettingsModal } from '@/components/dashboard/settings/SettingsModal';
import { Icon } from '@/components/dashboard/shell/Icon';
import {
  classifyDailyCapExposure,
  classifyPolicyExposure,
  classifyVetoWindowExposure,
  isThresholdExpansion,
  type PolicyExposure,
} from '@/lib/auto-approval/policy';
import { isVetoWindowMinutes } from '@/lib/auto-approval/types';
import type {
  AutoApprovalLocationSettings,
  AutoApprovalPatchRequest,
  AutoApprovalPolicyApiState,
  AutoApprovalReadinessBlockReason,
  AutoApprovalSettingsResponse,
  AutoApprovalThreshold,
  VetoWindowMinutes,
} from '@/lib/auto-approval/types';
import { readJsonObject } from '@/lib/client-response';

const THRESHOLD_OPTIONS: Array<{ value: AutoApprovalThreshold | null; label: string }> = [
  { value: null, label: 'Off' },
  { value: 5, label: '5★ only' },
  { value: 4, label: '4–5★' },
];

// Client mirror of the server-side cap validation (the settings zod schema owns it).
const MIN_DAILY_CAP = 1;
const MAX_DAILY_CAP = 50;

const BLOCK_REASON_COPY: Record<AutoApprovalReadinessBlockReason, string> = {
  auto_approval_disabled: 'Auto-approval is not enabled for this environment.',
  autopilot_unavailable: 'Policy expansion requires an available Autopilot plan.',
  provider_moderation_disabled: 'Provider moderation is not enabled.',
  provider_moderation_not_validated: 'Provider moderation readiness has not been validated.',
  subscription_not_writable: 'The account cannot expand automation while billing is read-only.',
  policy_suspended: 'Auto-approval is suspended for this account.',
  preview_environment: 'Preview environments cannot expand auto-approval.',
  impersonation_not_allowed: 'View-as sessions cannot change auto-approval.',
};

interface Props {
  initialState: AutoApprovalSettingsResponse;
}

// 'exposure_expansion' asks before loosening any trust dial (the server also
// demands a 'standard' confirmation level). 'location_dial' asks before a veto-window or
// cap change creates a location override row: that row shadows the account
// threshold with NULL, silently switching the location to manual approval — the
// owner must opt in before the write happens.
type PendingConfirmation =
  | { kind: 'exposure_expansion'; request: AutoApprovalPatchRequest; label: string }
  | {
      kind: 'location_dial';
      request: AutoApprovalPatchRequest;
      label: string;
    };

type SelectValue = 'inherit' | 'manual' | `${AutoApprovalThreshold}`;

interface ClientState {
  data: AutoApprovalSettingsResponse;
  saveError: string | null;
  savingKey: string | null;
  savedFlash: boolean;
  pendingConfirmation: PendingConfirmation | null;
  /**
   * Bumped whenever an unsaved cap draft must be discarded (confirmation cancel,
   * failed save) — callers key the draft-holding cap inputs on it so a bump
   * remounts them back to server state.
   */
  capDraftEpoch: number;
}

type ClientAction =
  | { type: 'save_started'; key: string }
  | { type: 'save_succeeded'; data: AutoApprovalSettingsResponse }
  | { type: 'save_failed'; message: string }
  | { type: 'clear_saved_flash' }
  | { type: 'set_pending_confirmation'; pending: PendingConfirmation | null }
  | { type: 'cancel_pending_confirmation' }
  | { type: 'discard_cap_draft' };

function clientReducer(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case 'save_started':
      return { ...state, savingKey: action.key, saveError: null };
    case 'save_succeeded':
      return { ...state, data: action.data, savingKey: null, saveError: null, savedFlash: true };
    case 'save_failed':
      // Discard cap drafts too: a failed save must not keep displaying an
      // unsaved value on a safety dial (selects snap back on their own).
      return { ...state, savingKey: null, saveError: action.message, capDraftEpoch: state.capDraftEpoch + 1 };
    case 'clear_saved_flash':
      return { ...state, savedFlash: false };
    case 'set_pending_confirmation':
      return { ...state, pendingConfirmation: action.pending };
    case 'cancel_pending_confirmation':
      return { ...state, pendingConfirmation: null, capDraftEpoch: state.capDraftEpoch + 1 };
    case 'discard_cap_draft':
      // Unparsable cap input (validity.badInput) on blur: remount the cap
      // inputs back to server state instead of committing anything.
      return { ...state, capDraftEpoch: state.capDraftEpoch + 1 };
  }
}

export function AutoApprovalClient({ initialState }: Props) {
  const [state, dispatch] = useReducer(clientReducer, {
    data: initialState,
    saveError: null,
    savingKey: null,
    savedFlash: false,
    pendingConfirmation: null,
    capDraftEpoch: 0,
  });
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount-only cleanup reading a stable ref; the empty dep array is intentional (refs are not reactive deps).
  // react-doctor-disable-next-line react-doctor/exhaustive-deps
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  const accountSuspended = state.data.accountDefault.suspended;
  const blockCopy = useMemo(
    () =>
      state.data.readiness.blockReasons
        // The suspended banner owns this message when the account default is suspended.
        .filter((reason) => reason !== 'policy_suspended' || !accountSuspended)
        .map((reason) => BLOCK_REASON_COPY[reason]),
    [state.data.readiness.blockReasons, accountSuspended],
  );

  async function sendPatch(request: AutoApprovalPatchRequest, key: string, confirmationLevel?: 'standard') {
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
      if (!res.ok) {
        const body = await readJsonObject(res);
        throw new Error(errorMessage(body, res.status));
      }
      const body = await readJsonObject(res);
      dispatch({ type: 'save_succeeded', data: body as unknown as AutoApprovalSettingsResponse });
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
    before: PolicyExposure,
    after: PolicyExposure,
    label: string,
    completeDisable = false,
  ) {
    const actualCompleteDisable = completeDisable
      && before.threshold !== null
      && after.threshold === null;
    if (
      classifyPolicyExposure(before, after, { completeDisable: actualCompleteDisable })
      !== 'expansion'
    ) {
      void sendPatch(request, key);
      return;
    }
    dispatch({
      type: 'set_pending_confirmation',
      pending: { kind: 'exposure_expansion', request, label },
    });
  }

  /**
   * Veto-window/cap changes. On a location still inheriting its threshold (no
   * override row) the write creates one and flips the location to manual, so it
   * needs the owner's explicit confirmation first; account-scope changes and
   * locations that already have an override row submit directly.
   */
  function requestDialChange(
    request: AutoApprovalPatchRequest,
    before: PolicyExposure,
    after: PolicyExposure,
    location?: AutoApprovalLocationSettings,
  ) {
    if (location && !location.override.exists) {
      dispatch({
        type: 'set_pending_confirmation',
        pending: { kind: 'location_dial', request, label: location.displayName },
      });
      return;
    }
    const expansion = classifyPolicyExposure(before, after) === 'expansion';
    if (expansion) {
      dispatch({
        type: 'set_pending_confirmation',
        pending: {
          kind: 'exposure_expansion',
          request,
          label: location?.displayName ?? 'the account default',
        },
      });
      return;
    }
    void sendPatch(request, requestKey(request));
  }

  function confirmPending() {
    const pending = state.pendingConfirmation;
    if (!pending) return;
    dispatch({ type: 'set_pending_confirmation', pending: null });
    void sendPatch(
      pending.request,
      requestKey(pending.request),
      pending.kind === 'exposure_expansion' ? 'standard' : undefined,
    );
  }

  function cancelPending() {
    dispatch({ type: 'cancel_pending_confirmation' });
  }

  const { data, saveError, savedFlash, savingKey, pendingConfirmation, capDraftEpoch } = state;
  const accountSelectValue = thresholdSelectValue(data.accountDefault.threshold);
  const accountSaving = savingKey === 'account';

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

        {accountSuspended && (
          <div className="auto-policy-warning" role="alert">
            <strong>Auto-approval is suspended for this account.</strong> New replies wait for owner review while suspended.
            {data.accountDefault.suspendedReason && (
              <div style={{ marginTop: 4 }}>{data.accountDefault.suspendedReason}</div>
            )}
          </div>
        )}

        <ReadinessBlock copy={blockCopy} />

        <label className="field">
          <span className="field-label">Account default policy</span>
          <select
            className="input"
            aria-label="Account default policy"
            value={accountSelectValue}
            disabled={accountSaving}
            onChange={(event) => {
              const value = event.target.value as SelectValue;
              const threshold = thresholdFromValue(value);
              const request: AutoApprovalPatchRequest = threshold === null
                ? { operation: 'set_account_manual' }
                : { operation: 'set_account_default', threshold };
              requestChange(
                request,
                'account',
                policyExposure(data.accountDefault),
                { ...policyExposure(data.accountDefault), threshold },
                'the account default',
                threshold === null,
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

        <div className="auto-policy-dials">
          <VetoWindowField
            ariaLabel="Account default veto window"
            value={data.accountDefault.vetoWindowMinutes}
            disabled={accountSaving}
            expansionBlocked={!data.readiness.canExpand}
            onChange={(minutes) => requestDialChange(
              { operation: 'set_account_veto_window', minutes },
              policyExposure(data.accountDefault),
              { ...policyExposure(data.accountDefault), vetoWindowMinutes: minutes },
            )}
          />
          <DailyCapField
            key={`account-cap-${capDraftEpoch}-${data.accountDefault.dailyAutoPostCap ?? 'default'}`}
            ariaLabel="Account default daily auto-post cap"
            storedCap={data.accountDefault.dailyAutoPostCap}
            effectiveDailyCap={data.accountDefault.effectiveDailyCap}
            disabled={accountSaving}
            expansionBlocked={!data.readiness.canExpand}
            onCommit={(cap) => requestDialChange(
              { operation: 'set_account_daily_cap', cap },
              policyExposure(data.accountDefault),
              { ...policyExposure(data.accountDefault), dailyAutoPostCap: cap },
            )}
            onDiscardDraft={() => dispatch({ type: 'discard_cap_draft' })}
          />
        </div>
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
              accountPolicy={data.accountDefault}
              canExpand={data.readiness.canExpand}
              saving={savingKey === location.locationId}
              capDraftEpoch={capDraftEpoch}
              onRequestChange={(request, before, after, completeDisable) =>
                requestChange(
                  request,
                  location.locationId,
                  before,
                  after,
                  location.displayName,
                  completeDisable,
                )}
              onRequestDial={(request, before, after) =>
                requestDialChange(request, before, after, location)}
              onDiscardCapDraft={() => dispatch({ type: 'discard_cap_draft' })}
            />
          ))}
          {data.locations.length === 0 && (
            <p className="set-section-sub">No active locations are available for this account.</p>
          )}
        </div>
      </section>

      {saveError && (
        <p className="settings-error-copy settings-error-copy--before">{saveError}</p>
      )}

      {pendingConfirmation?.kind === 'exposure_expansion' && (
        <SettingsModal
          title="Confirm auto-approval change"
          closeLabel="Cancel auto-approval change"
          onClose={cancelPending}
        >
          <div className="set-section-title" style={{ marginBottom: 8 }}>
            Confirm auto-approval change
          </div>
          <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, marginBottom: 12 }}>
            This expands auto-approval for {pendingConfirmation.label}. Matching rated reviews can post to Google automatically without owner review when safety, billing, active location, and Google connection checks pass.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={cancelPending}
            >
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={confirmPending}>
              Confirm auto-approval
            </button>
          </div>
        </SettingsModal>
      )}

      {pendingConfirmation?.kind === 'location_dial' && (
        <SettingsModal
          title="Give this location its own settings?"
          closeLabel="Cancel location settings change"
          onClose={cancelPending}
        >
          <div className="set-section-title" style={{ marginBottom: 8 }}>
            Give this location its own settings?
          </div>
          <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, marginBottom: 12 }}>
            This gives {pendingConfirmation.label} its own settings — it switches to manual approval until you pick a threshold for it.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={cancelPending}
            >
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={confirmPending}>
              Give it its own settings
            </button>
          </div>
        </SettingsModal>
      )}
    </SettingsShell>
  );
}

function LocationPolicyRow({
  location,
  accountPolicy,
  canExpand,
  saving,
  capDraftEpoch,
  onRequestChange,
  onRequestDial,
  onDiscardCapDraft,
}: {
  location: AutoApprovalLocationSettings;
  accountPolicy: AutoApprovalPolicyApiState;
  canExpand: boolean;
  saving: boolean;
  capDraftEpoch: number;
  onRequestChange: (
    request: AutoApprovalPatchRequest,
    before: PolicyExposure,
    after: PolicyExposure,
    completeDisable: boolean,
  ) => void;
  onRequestDial: (
    request: AutoApprovalPatchRequest,
    before: PolicyExposure,
    after: PolicyExposure,
  ) => void;
  onDiscardCapDraft: () => void;
}) {
  const value = location.override.exists
    ? thresholdSelectValue(location.override.threshold)
    : 'inherit';

  // GET/PATCH symmetry: the server 409s expansions for a suspended location
  // (not just a suspended account default), so a location-suspended row must
  // not offer them either. Contraction controls remain available.
  const expansionBlocked = !canExpand || location.effective.suspended;
  const beforeExposure = policyExposure(location.effective);
  const accountExposure = policyExposure(accountPolicy);

  return (
    <div className="auto-policy-location-row">
      <div>
        <div className="auto-policy-location-name">
          {location.displayName}
          {location.effective.suspended && (
            <span
              className="auto-policy-suspended-chip"
              title={location.override.suspendedReason ?? undefined}
            >
              Suspended
            </span>
          )}
        </div>
        <div className="auto-policy-location-sub">
          {location.effective.inherited ? 'Inherited from account' : 'Location override'} · Effective {thresholdLabel(location.effective.threshold)}
        </div>
        {location.effective.suspended && location.override.suspendedReason && (
          <div className="auto-policy-location-sub">{location.override.suspendedReason}</div>
        )}
      </div>
      <select
        className="input auto-policy-location-select"
        aria-label={`Auto-approval policy for ${location.displayName}`}
        value={value}
        disabled={saving}
        onChange={(event) => {
          const selected = event.target.value as SelectValue;
          const after = locationExposureAfterSelection(
            location,
            accountPolicy,
            selected,
          );
          const request = locationRequest(location.locationId, selected);
          onRequestChange(
            request,
            beforeExposure,
            after,
            after.threshold === null,
          );
        }}
      >
        <option
          value="inherit"
          disabled={
            classifyPolicyExposure(beforeExposure, accountExposure, {
              completeDisable:
                beforeExposure.threshold !== null
                && accountExposure.threshold === null,
            }) === 'expansion' && expansionBlocked
          }
        >
          Inherit account default
        </option>
        {THRESHOLD_OPTIONS.map((option) => {
          const optionValue = thresholdSelectValue(option.value);
          const after = locationExposureAfterSelection(
            location,
            accountPolicy,
            optionValue,
          );
          const expands = classifyPolicyExposure(beforeExposure, after, {
            completeDisable:
              beforeExposure.threshold !== null
              && option.value === null,
          }) === 'expansion';
          return (
            <option
              key={optionValue}
              value={optionValue}
              disabled={expands && expansionBlocked}
            >
              {option.label}
            </option>
          );
        })}
      </select>
      <div className="auto-policy-dials">
        <VetoWindowField
          ariaLabel={`Veto window for ${location.displayName}`}
          value={location.effective.vetoWindowMinutes}
          disabled={saving}
          expansionBlocked={location.override.exists && expansionBlocked}
          onChange={(minutes) => onRequestDial(
            { operation: 'set_location_veto_window', locationId: location.locationId, minutes },
            beforeExposure,
            {
              ...locationDialSeed(location, accountPolicy),
              vetoWindowMinutes: minutes,
            },
          )}
        />
        <DailyCapField
          key={`location-cap-${capDraftEpoch}-${location.override.dailyAutoPostCap ?? 'default'}`}
          ariaLabel={`Daily auto-post cap for ${location.displayName}`}
          // The commit baseline is the OVERRIDE's stored value (null while the
          // location has no row) — baselining on the effective (inherited) cap
          // made typing the inherited number a no-op, so the cap could never be
          // pinned onto the location. The effective value still drives the
          // display via the placeholder.
          storedCap={location.override.dailyAutoPostCap}
          effectiveDailyCap={location.effective.effectiveDailyCap}
          disabled={saving}
          expansionBlocked={location.override.exists && expansionBlocked}
          onCommit={(cap) => onRequestDial(
            { operation: 'set_location_daily_cap', locationId: location.locationId, cap },
            beforeExposure,
            { ...locationDialSeed(location, accountPolicy), dailyAutoPostCap: cap },
          )}
          onDiscardDraft={onDiscardCapDraft}
        />
      </div>
    </div>
  );
}

function VetoWindowField({
  ariaLabel,
  value,
  disabled,
  expansionBlocked,
  onChange,
}: {
  ariaLabel: string;
  value: VetoWindowMinutes;
  disabled: boolean;
  expansionBlocked: boolean;
  onChange: (minutes: VetoWindowMinutes) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">Veto window</span>
      <select
        className="input"
        aria-label={ariaLabel}
        value={`${value}`}
        disabled={disabled}
        onChange={(event) => {
          const minutes = Number(event.target.value);
          if (!isVetoWindowMinutes(minutes)) return;
          onChange(minutes);
        }}
      >
        <option
          value="15"
          disabled={
            expansionBlocked
            && classifyVetoWindowExposure(value, 15) === 'expansion'
          }
        >
          15 minutes
        </option>
        <option
          value="30"
          disabled={
            expansionBlocked
            && classifyVetoWindowExposure(value, 30) === 'expansion'
          }
        >
          30 minutes
        </option>
      </select>
      <span className="field-hint">
        How long an auto-approved reply waits before posting, so you can still cancel it.
      </span>
    </label>
  );
}

/**
 * Draft-holding cap input: commits on blur (blank = platform default, submitted
 * as null). Callers remount it via `key` when the stored value or the cap-draft
 * epoch changes — that is the draft-reset mechanism.
 */
function DailyCapField({
  ariaLabel,
  storedCap,
  effectiveDailyCap,
  disabled,
  expansionBlocked,
  onCommit,
  onDiscardDraft,
}: {
  ariaLabel: string;
  storedCap: number | null;
  effectiveDailyCap: number;
  disabled: boolean;
  expansionBlocked: boolean;
  onCommit: (cap: number | null) => void;
  onDiscardDraft: () => void;
}) {
  const [draft, setDraft] = useState(storedCap === null ? '' : String(storedCap));

  function commit(event: FocusEvent<HTMLInputElement>) {
    // A number input holding unparsable text (e.g. a stray 'e') reads as ''
    // — indistinguishable from a deliberate clear by value alone. Committing
    // it would silently turn an explicit strict cap into "Default" from a
    // keystroke, so a badInput blur discards the draft (the epoch bump
    // remounts this field back to the stored value) and never PATCHes. A
    // genuinely emptied field (badInput false) still submits null.
    if (event.currentTarget.validity.badInput) {
      onDiscardDraft();
      return;
    }
    const normalized = normalizeCapDraft(draft);
    setDraft(normalized === null ? '' : String(normalized));
    if (normalized === storedCap) return;
    if (
      expansionBlocked
      && classifyDailyCapExposure(storedCap, normalized) === 'expansion'
    ) {
      onDiscardDraft();
      return;
    }
    onCommit(normalized);
  }

  return (
    <label className="field">
      <span className="field-label">Daily auto-post cap</span>
      <input
        type="number"
        className="input"
        aria-label={ariaLabel}
        min={MIN_DAILY_CAP}
        max={MAX_DAILY_CAP}
        step={1}
        inputMode="numeric"
        placeholder={`Default (${effectiveDailyCap})`}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      <span className="field-hint">
        Most replies auto-posted per day for this scope. Leave blank to use the default.
      </span>
    </label>
  );
}

function normalizeCapDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) return null;
  return Math.min(MAX_DAILY_CAP, Math.max(MIN_DAILY_CAP, parsed));
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

function policyExposure(policy: Pick<
  AutoApprovalPolicyApiState,
  'threshold' | 'vetoWindowMinutes' | 'dailyAutoPostCap'
>): PolicyExposure {
  return {
    threshold: policy.threshold,
    vetoWindowMinutes: policy.vetoWindowMinutes,
    dailyAutoPostCap: policy.dailyAutoPostCap,
  };
}

function locationDialSeed(
  location: AutoApprovalLocationSettings,
  accountPolicy: AutoApprovalPolicyApiState,
): PolicyExposure {
  if (location.override.exists) return policyExposure(location.effective);
  return { ...policyExposure(accountPolicy), threshold: null };
}

function locationExposureAfterSelection(
  location: AutoApprovalLocationSettings,
  accountPolicy: AutoApprovalPolicyApiState,
  selected: SelectValue,
): PolicyExposure {
  if (selected === 'inherit') return policyExposure(accountPolicy);
  return {
    ...locationDialSeed(location, accountPolicy),
    threshold: thresholdFromValue(selected),
  };
}

function thresholdSelectValue(threshold: AutoApprovalThreshold | null): SelectValue {
  return threshold === null ? 'manual' : `${threshold}`;
}

function thresholdFromValue(value: SelectValue): AutoApprovalThreshold | null {
  if (value === 'inherit' || value === 'manual') return null;
  return Number(value) as AutoApprovalThreshold;
}

function thresholdLabel(threshold: AutoApprovalThreshold | null): string {
  return THRESHOLD_OPTIONS.find((option) => option.value === threshold)?.label ?? 'Off';
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
