'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { FocusEvent } from 'react';
import Link from 'next/link';
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
import {
  SOLICITATION_DEFAULT_VETO_WINDOW_MINUTES,
  autoApprovalThresholdLabel,
  isSolicitationVetoWindowMinutes,
  isVetoWindowMinutes,
} from '@/lib/auto-approval/types';
import type {
  AutoApprovalLocationSettings,
  AutoApprovalPatchRequest,
  AutoApprovalPolicyApiState,
  AutoApprovalReadinessBlockReason,
  AutoApprovalSettingsResponse,
  AutoApprovalThreshold,
  SolicitationAutoApprovalApiState,
  SolicitationVetoWindowMinutes,
  VetoWindowMinutes,
} from '@/lib/auto-approval/types';
import {
  DEFAULT_DAILY_SEND_CAP_ACCOUNT,
  resolveAccountDailySendCap,
} from '@/lib/solicitation/send-caps';
import { readJsonObject } from '@/lib/client-response';

const THRESHOLD_OPTIONS: Array<{ value: AutoApprovalThreshold | null; label: string }> = [
  { value: null, label: autoApprovalThresholdLabel(null) },
  { value: 5, label: autoApprovalThresholdLabel(5) },
  { value: 4, label: autoApprovalThresholdLabel(4) },
];

// Client mirror of the server-side cap validation (the settings zod schema owns it).
const MIN_DAILY_CAP = 1;
const MAX_DAILY_CAP = 50;

const BILLING_HREF = '/settings/billing';

interface ReadinessCopy {
  message: string;
  cta?: { href: string; label: string };
}

/**
 * Owner-language readiness reasons. Each says what is true for the owner and
 * what they can still do; a reason the owner can act on carries the link. The
 * admin panel keeps its own terse ops labels (types.ts) — these never share.
 */
const BLOCK_REASON_COPY: Record<AutoApprovalReadinessBlockReason, ReadinessCopy> = {
  auto_approval_disabled: {
    message: 'Auto-posting is not switched on for RepWorth yet. You can still narrow or turn off what is already set.',
  },
  autopilot_unavailable: {
    message: 'Auto-posting is part of the Autopilot plan. On your current plan you can turn it down or off, not up.',
    cta: { href: BILLING_HREF, label: 'See plans' },
  },
  provider_moderation_disabled: {
    message: 'Safety screening for replies is switched off right now, so auto-posting cannot be widened. Narrowing it still works.',
  },
  provider_moderation_not_validated: {
    message: 'Safety screening for replies has not finished its checks yet. Until it does, you can turn auto-posting down or off, not up.',
  },
  subscription_not_writable: {
    message: 'Your billing needs attention before auto-posting can be widened.',
    cta: { href: BILLING_HREF, label: 'Review billing' },
  },
  policy_suspended: {
    message: 'Auto-posting is paused for this account. Every reply waits for you until the pause is lifted.',
  },
  preview_environment: {
    message: 'This is a preview of RepWorth, so auto-posting cannot be widened here.',
  },
  impersonation_not_allowed: {
    message: 'You are viewing this account as an admin, so auto-posting cannot be changed from here.',
  },
};

/**
 * Every error code PATCH /api/settings/auto-approval can return, as the one
 * sentence the owner reads next to the control that failed. Codes never reach
 * the screen; an unknown code falls through to the generic line.
 */
const SAVE_ERROR_COPY: Record<string, string> = {
  internal_error: 'Something went wrong on our side. Try again in a moment.',
  invalid_body: 'That change could not be understood. Reload the page and try again.',
  auto_approval_confirmation_required: 'This change needs your confirmation first. Pick it again and confirm.',
  account_offboarding_blocked: 'Settings are read-only while your account is being closed.',
  location_inactive: 'This location is archived, so its auto-posting cannot be changed.',
  account_not_found: 'Your account could not be found. Reload the page and try again.',
  location_not_found: 'This location is no longer available. Reload the page and try again.',
  invalid_policy_threshold: 'The saved setting looks wrong on our side. Contact support and we will fix it.',
  invalid_policy_veto_window: 'The saved setting looks wrong on our side. Contact support and we will fix it.',
};

interface Props {
  initialState: AutoApprovalSettingsResponse;
}

// 'exposure_expansion' asks before loosening any trust dial (the server also
// demands a 'standard' confirmation level) and carries before/after so the
// dialog can say exactly what changes. 'location_customize' asks before an
// inheriting location gets its own policy row: the row is created WITH the
// location's current effective threshold, so nothing about what posts changes
// — the owner is only opting the location out of following the account
// default. 'solicitation_expansion' is the same expansion gate for the
// Solicitation lane (#631 D20) with its own copy — what expands is
// review-request SENDING, not reply posting.
type PendingConfirmation =
  | {
      kind: 'exposure_expansion';
      request: AutoApprovalPatchRequest;
      label: string;
      before: PolicyExposure;
      after: PolicyExposure;
    }
  | {
      kind: 'location_customize';
      request: AutoApprovalPatchRequest;
      label: string;
      threshold: AutoApprovalThreshold | null;
    }
  | { kind: 'solicitation_expansion'; request: AutoApprovalPatchRequest };

type SelectValue = 'inherit' | 'manual' | `${AutoApprovalThreshold}`;

interface ClientState {
  data: AutoApprovalSettingsResponse;
  saveError: string | null;
  /** The request key (account / locationId / solicitation) whose save failed — the error renders beside it. */
  saveErrorKey: string | null;
  savingKey: string | null;
  savedFlash: boolean;
  /** `${requestKey}:${operation}` of the save that just landed; the matching field shows "Saved". */
  savedFieldKey: string | null;
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
  | { type: 'save_succeeded'; data: AutoApprovalSettingsResponse; fieldKey: string }
  | { type: 'save_failed'; message: string; key: string }
  | { type: 'clear_saved_flash' }
  | { type: 'set_pending_confirmation'; pending: PendingConfirmation | null }
  | { type: 'cancel_pending_confirmation' }
  | { type: 'discard_cap_draft' };

function clientReducer(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case 'save_started':
      return { ...state, savingKey: action.key, saveError: null, saveErrorKey: null };
    case 'save_succeeded':
      return {
        ...state,
        data: action.data,
        savingKey: null,
        saveError: null,
        saveErrorKey: null,
        savedFlash: true,
        savedFieldKey: action.fieldKey,
      };
    case 'save_failed':
      // Discard cap drafts too: a failed save must not keep displaying an
      // unsaved value on a safety dial (selects snap back on their own).
      return {
        ...state,
        savingKey: null,
        saveError: action.message,
        saveErrorKey: action.key,
        capDraftEpoch: state.capDraftEpoch + 1,
      };
    case 'clear_saved_flash':
      return { ...state, savedFlash: false, savedFieldKey: null };
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
    saveErrorKey: null,
    savingKey: null,
    savedFlash: false,
    savedFieldKey: null,
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
  const readinessCopy = useMemo(
    () =>
      state.data.readiness.blockReasons
        // The suspended status banner owns this message when the account default is suspended.
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
      dispatch({
        type: 'save_succeeded',
        data: body as unknown as AutoApprovalSettingsResponse,
        fieldKey: fieldKey(request),
      });
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => dispatch({ type: 'clear_saved_flash' }), 1800);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'This change did not save. Try again.';
      dispatch({ type: 'save_failed', message, key });
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
      pending: { kind: 'exposure_expansion', request, label, before, after },
    });
  }

  /**
   * Veto-window/cap changes on the account default or on a location that
   * already has its own row. (An inheriting location shows no dials — it opts
   * into its own row first via `requestLocationCustomize`.) Expansions confirm
   * first; contractions submit directly.
   */
  function requestDialChange(
    request: AutoApprovalPatchRequest,
    before: PolicyExposure,
    after: PolicyExposure,
    label: string,
  ) {
    requestChange(request, requestKey(request), before, after, label);
  }

  /**
   * An inheriting location gets its own policy row carrying its CURRENT
   * effective threshold, so the change is exposure-neutral — the row simply
   * stops following the account default. Confirmed first because it is a
   * structural change the owner should opt into knowingly.
   */
  function requestLocationCustomize(location: AutoApprovalLocationSettings) {
    const threshold = location.effective.threshold;
    const request: AutoApprovalPatchRequest = threshold === null
      ? { operation: 'set_location_manual', locationId: location.locationId }
      : { operation: 'set_location_override', locationId: location.locationId, threshold };
    dispatch({
      type: 'set_pending_confirmation',
      pending: { kind: 'location_customize', request, label: location.displayName, threshold },
    });
  }

  /**
   * Solicitation-lane change (#631 D20): expansions (enabling the lane,
   * shortening the veto window, raising the ENFORCED cap) confirm first —
   * the server demands 'standard' for them; contractions submit directly.
   */
  function requestSolicitationSet(
    config: { dailySendCap: number | null; vetoWindowMinutes: SolicitationVetoWindowMinutes },
    expansion: boolean,
  ) {
    const request: AutoApprovalPatchRequest = {
      operation: 'set_solicitation_account_default',
      ...config,
    };
    if (!expansion) {
      void sendPatch(request, 'solicitation');
      return;
    }
    dispatch({
      type: 'set_pending_confirmation',
      pending: { kind: 'solicitation_expansion', request },
    });
  }

  function confirmPending() {
    const pending = state.pendingConfirmation;
    if (!pending) return;
    dispatch({ type: 'set_pending_confirmation', pending: null });
    void sendPatch(
      pending.request,
      requestKey(pending.request),
      pending.kind === 'exposure_expansion' || pending.kind === 'solicitation_expansion'
        ? 'standard'
        : undefined,
    );
  }

  function cancelPending() {
    dispatch({ type: 'cancel_pending_confirmation' });
  }

  function turnOffAutoPosting() {
    const before = policyExposure(data.accountDefault);
    requestChange(
      { operation: 'set_account_manual' },
      'account',
      before,
      { ...before, threshold: null },
      'the account default',
      true,
    );
  }

  const {
    data, saveError, saveErrorKey, savedFlash, savedFieldKey, savingKey, pendingConfirmation, capDraftEpoch,
  } = state;
  const accountSelectValue = thresholdSelectValue(data.accountDefault.threshold);
  const accountSaving = savingKey === 'account';

  return (
    <SettingsShell
      savedFlash={savedFlash}
      saveError={saveError ?? undefined}
    >
      <PolicyStatusBanner
        data={data}
        busy={accountSaving}
        onTurnOff={turnOffAutoPosting}
      />

      <section className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon sage">
            <Icon name="shield" size={18} />
          </div>
          <div>
            <h2 className="set-section-title">Auto-approval</h2>
            <div className="set-section-sub">
              Choose which star ratings can post a reply without waiting for you. Every reply still passes the safety and connection checks first.
            </div>
          </div>
        </div>

        <ReadinessBlock items={readinessCopy} />

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
            Every location follows this unless you give it its own settings below.
          </span>
        </label>

        <div className="auto-policy-dials">
          <VetoWindowField
            ariaLabel="Account default veto window"
            value={data.accountDefault.vetoWindowMinutes}
            disabled={accountSaving}
            expansionBlocked={!data.readiness.canExpand}
            saved={savedFieldKey === 'account:set_account_veto_window'}
            onChange={(minutes) => requestDialChange(
              { operation: 'set_account_veto_window', minutes },
              policyExposure(data.accountDefault),
              { ...policyExposure(data.accountDefault), vetoWindowMinutes: minutes },
              'the account default',
            )}
          />
          <DailyCapField
            key={`account-cap-${capDraftEpoch}-${data.accountDefault.dailyAutoPostCap ?? 'default'}`}
            ariaLabel="Account default daily auto-post cap"
            label="Daily auto-post cap"
            hint={`Most replies posted automatically per day — 1 to 50. Leave blank for the default (${data.accountDefault.effectiveDailyCap}).`}
            placeholder={`Default (${data.accountDefault.effectiveDailyCap})`}
            storedCap={data.accountDefault.dailyAutoPostCap}
            disabled={accountSaving}
            expansionBlocked={!data.readiness.canExpand}
            saved={savedFieldKey === 'account:set_account_daily_cap'}
            onCommit={(cap) => requestDialChange(
              { operation: 'set_account_daily_cap', cap },
              policyExposure(data.accountDefault),
              { ...policyExposure(data.accountDefault), dailyAutoPostCap: cap },
              'the account default',
            )}
            onDiscardDraft={() => dispatch({ type: 'discard_cap_draft' })}
          />
        </div>

        {saveErrorKey === 'account' && saveError && <InlineSaveError message={saveError} />}
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <div className="set-section-icon blue">
            <Icon name="location" size={18} />
          </div>
          <div>
            <div className="set-section-title">Locations</div>
            <div className="set-section-sub">Each active location follows the account default until you give it its own policy.</div>
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
              saveError={saveErrorKey === location.locationId ? saveError : null}
              savedFieldKey={savedFieldKey}
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
                requestDialChange(request, before, after, location.displayName)}
              onRequestCustomize={() => requestLocationCustomize(location)}
              onDiscardCapDraft={() => dispatch({ type: 'discard_cap_draft' })}
            />
          ))}
          {data.locations.length === 0 && (
            <p className="set-section-sub">No active locations are available for this account.</p>
          )}
        </div>
      </section>

      {data.solicitation.available && (
        <SolicitationSection
          state={data.solicitation}
          saving={savingKey === 'solicitation'}
          saveError={saveErrorKey === 'solicitation' ? saveError : null}
          savedFieldKey={savedFieldKey}
          capDraftEpoch={capDraftEpoch}
          onSet={requestSolicitationSet}
          onDisable={() => {
            void sendPatch({ operation: 'clear_solicitation_account_default' }, 'solicitation');
          }}
          onDiscardCapDraft={() => dispatch({ type: 'discard_cap_draft' })}
        />
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
          <ExpansionSummary
            label={pendingConfirmation.label}
            before={pendingConfirmation.before}
            after={pendingConfirmation.after}
            defaultCap={data.accountDefault.effectiveDailyCap}
          />
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

      {pendingConfirmation?.kind === 'solicitation_expansion' && (
        <SettingsModal
          title="Confirm review request auto-approval"
          closeLabel="Cancel review request auto-approval change"
          onClose={cancelPending}
        >
          <div className="set-section-title" style={{ marginBottom: 8 }}>
            Confirm review request auto-approval
          </div>
          <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, marginBottom: 12 }}>
            This expands auto-approval for review requests. Built request batches are approved for
            sending automatically; each batch notifies you and waits out its veto window before
            anything sends, and you can halt it from the Requests page until then.
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

      {pendingConfirmation?.kind === 'location_customize' && (
        <SettingsModal
          title="Give this location its own settings?"
          closeLabel="Cancel location settings change"
          onClose={cancelPending}
        >
          <div className="set-section-title" style={{ marginBottom: 8 }}>
            Give this location its own settings?
          </div>
          <p style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5, marginBottom: 12 }}>
            {pendingConfirmation.label} keeps its current policy ({thresholdLabel(pendingConfirmation.threshold)}) and gets its own veto window and daily cap, starting from the account&apos;s current values. From then on, changing the account default will not affect it.
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

/**
 * The page's headline: what is true right now, in one sentence, with the one
 * action an owner most often wants (turn it off) a tap away. Suspended wins
 * over everything; otherwise the account default decides the sentence and
 * per-location overrides are named so "Off" is never a false comfort.
 */
function describePolicyStatus(data: AutoApprovalSettingsResponse): {
  tone: 'on' | 'off' | 'suspended';
  title: string;
  /** Supporting lines, each rendered on its own so a reason stays findable text. */
  detail: string[];
  canTurnOff: boolean;
} {
  const account = data.accountDefault;
  const postingOverrides = data.locations.filter(
    (location) => location.override.exists && !location.effective.inherited && location.effective.threshold !== null,
  );
  const overrideNames = postingOverrides.map((location) => location.displayName);

  if (account.suspended) {
    return {
      tone: 'suspended',
      title: 'Auto-approval is suspended for this account.',
      detail: [
        'New replies wait for owner review while suspended.',
        account.suspendedReason,
      ].filter((line): line is string => Boolean(line)),
      canTurnOff: false,
    };
  }

  if (account.threshold === null) {
    if (overrideNames.length === 0) {
      return {
        tone: 'off',
        title: 'Off — you approve every reply before it posts.',
        detail: ['Turn it on below by choosing which star ratings can post on their own.'],
        canTurnOff: false,
      };
    }
    return {
      tone: 'on',
      title: `Off by default — ${joinNames(overrideNames)} ${overrideNames.length === 1 ? 'posts' : 'post'} replies automatically with ${overrideNames.length === 1 ? 'its' : 'their'} own settings.`,
      detail: ['Change or remove those settings on the location rows below.'],
      canTurnOff: false,
    };
  }

  const minutes = account.vetoWindowMinutes;
  const detailLines = [
    `Those ${minutes} minutes are your veto window — the time you have to stop a reply before it posts.`,
  ];
  const differing = data.locations.filter(
    (location) => location.override.exists && !location.effective.inherited,
  );
  if (differing.length > 0) {
    detailLines.push(
      `${joinNames(differing.map((location) => location.displayName))} ${differing.length === 1 ? 'uses its' : 'use their'} own settings.`,
    );
  }
  return {
    tone: 'on',
    title: `${autoApprovalThresholdLabel(account.threshold)} reviews post a reply automatically ${minutes} minutes after you're notified, up to ${account.effectiveDailyCap} a day.`,
    detail: detailLines,
    canTurnOff: true,
  };
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function PolicyStatusBanner({
  data,
  busy,
  onTurnOff,
}: {
  data: AutoApprovalSettingsResponse;
  busy: boolean;
  onTurnOff: () => void;
}) {
  const status = describePolicyStatus(data);
  const variant = status.tone === 'suspended' ? 'banner-red' : 'banner-blue';
  const icon = status.tone === 'suspended' ? 'alert' : status.tone === 'on' ? 'sparkle' : 'shield';
  return (
    <div
      className={`banner ${variant}`}
      role={status.tone === 'suspended' ? 'alert' : 'status'}
      data-testid="auto-approval-status"
    >
      <div className="b-icon" aria-hidden>
        <Icon name={icon} size={18} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="b-title">{status.title}</div>
        {status.detail.map((line) => (
          <div key={line} className="b-sub">{line}</div>
        ))}
      </div>
      {status.canTurnOff && (
        <button type="button" className="banner-cta" onClick={onTurnOff} disabled={busy}>
          Turn off auto-posting
        </button>
      )}
    </div>
  );
}

/**
 * What the confirmation is actually agreeing to: each dial that loosens, as
 * before → after, plus one concrete example so "4–5★" reads as a review, not a
 * setting. Exported for its own tests.
 */
function describeExpansion(
  before: PolicyExposure,
  after: PolicyExposure,
  defaultCap: number,
): { changes: string[]; example: string } {
  const changes: string[] = [];
  if (before.threshold !== after.threshold) {
    changes.push(`Auto-posting: ${thresholdLabel(before.threshold)} → ${thresholdLabel(after.threshold)}`);
  }
  if (before.vetoWindowMinutes !== after.vetoWindowMinutes) {
    changes.push(`Veto window: ${before.vetoWindowMinutes} min → ${after.vetoWindowMinutes} min`);
  }
  if (before.dailyAutoPostCap !== after.dailyAutoPostCap) {
    changes.push(`Daily cap: ${capLabel(before.dailyAutoPostCap, defaultCap)} → ${capLabel(after.dailyAutoPostCap, defaultCap)}`);
  }

  const stars = after.threshold ?? before.threshold ?? 5;
  const reviewQuote = stars === 4 ? '“Good food, service was a bit slow”' : '“Best coffee in town, lovely staff”';
  const minutes = after.vetoWindowMinutes;
  let example: string;
  if (before.threshold !== after.threshold) {
    example = `For example: a ${stars}★ review saying ${reviewQuote} gets its reply posted ${minutes} minutes after you're notified, unless you stop it in that time.`;
  } else if (before.vetoWindowMinutes !== after.vetoWindowMinutes) {
    example = `For example: a reply to a ${stars}★ review saying ${reviewQuote} posts after ${minutes} minutes instead of ${before.vetoWindowMinutes} — that is how long you have to stop it.`;
  } else {
    example = `For example: on a busy day, up to ${after.dailyAutoPostCap ?? defaultCap} replies could post without you approving each one.`;
  }
  return { changes, example };
}

function capLabel(cap: number | null, defaultCap: number): string {
  return cap === null ? `${defaultCap} a day (default)` : `${cap} a day`;
}

function ExpansionSummary({
  label,
  before,
  after,
  defaultCap,
}: {
  label: string;
  before: PolicyExposure;
  after: PolicyExposure;
  defaultCap: number;
}) {
  const { changes, example } = describeExpansion(before, after, defaultCap);
  return (
    <div style={{ fontSize: 13, color: 'var(--rw-app-text-muted)', lineHeight: 1.5 }}>
      <p style={{ margin: '0 0 10px' }}>
        This lets more replies post without your approval for {label}. Safety, billing, active location, and Google connection checks still apply to every one.
      </p>
      <ul style={{ margin: '0 0 10px', paddingLeft: 18, color: 'var(--rw-app-text)' }}>
        {changes.map((line) => (
          <li key={line} style={{ fontWeight: 600 }}>{line}</li>
        ))}
      </ul>
      <p style={{ margin: 0 }}>{example}</p>
    </div>
  );
}

function InlineSaveError({ message }: { message: string }) {
  // Visible copy only — SettingsShell's assertive live region announces it.
  return <p className="settings-error-copy settings-error-copy--compact">{message}</p>;
}

function LocationPolicyRow({
  location,
  accountPolicy,
  canExpand,
  saving,
  saveError,
  savedFieldKey,
  capDraftEpoch,
  onRequestChange,
  onRequestDial,
  onRequestCustomize,
  onDiscardCapDraft,
}: {
  location: AutoApprovalLocationSettings;
  accountPolicy: AutoApprovalPolicyApiState;
  canExpand: boolean;
  saving: boolean;
  saveError: string | null;
  savedFieldKey: string | null;
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
  onRequestCustomize: () => void;
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
          {location.effective.inherited ? 'Follows the account default' : 'Has its own settings'} · Effective {thresholdLabel(location.effective.threshold)}
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
          Follow account default
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
      {location.override.exists ? (
        <div className="auto-policy-dials">
          <VetoWindowField
            ariaLabel={`Veto window for ${location.displayName}`}
            value={location.effective.vetoWindowMinutes}
            disabled={saving}
            expansionBlocked={expansionBlocked}
            saved={savedFieldKey === `${location.locationId}:set_location_veto_window`}
            onChange={(minutes) => onRequestDial(
              { operation: 'set_location_veto_window', locationId: location.locationId, minutes },
              beforeExposure,
              { ...beforeExposure, vetoWindowMinutes: minutes },
            )}
          />
          <DailyCapField
            key={`location-cap-${capDraftEpoch}-${location.override.dailyAutoPostCap ?? 'default'}`}
            ariaLabel={`Daily auto-post cap for ${location.displayName}`}
            label="Daily auto-post cap"
            hint={`Most replies posted automatically per day for this location — 1 to 50. Leave blank for the default (${location.effective.effectiveDailyCap}).`}
            placeholder={`Default (${location.effective.effectiveDailyCap})`}
            // The commit baseline is the OVERRIDE's stored value — baselining on
            // the effective cap made retyping it a no-op.
            storedCap={location.override.dailyAutoPostCap}
            disabled={saving}
            expansionBlocked={expansionBlocked}
            saved={savedFieldKey === `${location.locationId}:set_location_daily_cap`}
            onCommit={(cap) => onRequestDial(
              { operation: 'set_location_daily_cap', locationId: location.locationId, cap },
              beforeExposure,
              { ...beforeExposure, dailyAutoPostCap: cap },
            )}
            onDiscardDraft={onDiscardCapDraft}
          />
        </div>
      ) : (
        // No dials while the location inherits: showing them invited a change
        // that silently created an override row and flipped the location to
        // manual approval. The owner opts in first; the row then appears with
        // the dials editable.
        <div style={{ gridColumn: '1 / -1' }}>
          <button
            type="button"
            className="btn btn-tertiary"
            disabled={saving}
            onClick={onRequestCustomize}
          >
            Give {location.displayName} its own veto window and daily cap
          </button>
        </div>
      )}
      {saveError && (
        <div style={{ gridColumn: '1 / -1' }}>
          <InlineSaveError message={saveError} />
        </div>
      )}
    </div>
  );
}

function SavedMark() {
  return (
    <span
      role="status"
      style={{ fontSize: 11, fontWeight: 600, color: 'var(--rw-sage-deep)', display: 'inline-flex', alignItems: 'center', gap: 3 }}
    >
      <Icon name="check" size={11} /> Saved
    </span>
  );
}

function VetoWindowField({
  ariaLabel,
  value,
  disabled,
  expansionBlocked,
  saved,
  onChange,
}: {
  ariaLabel: string;
  value: VetoWindowMinutes;
  disabled: boolean;
  expansionBlocked: boolean;
  saved: boolean;
  onChange: (minutes: VetoWindowMinutes) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">
        Veto window
        {saved && <SavedMark />}
      </span>
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
        How long an approved reply waits before posting — the time you have to stop it.
      </span>
    </label>
  );
}

/**
 * Draft-holding cap input: commits on blur (blank = platform default, submitted
 * as null). Callers remount it via `key` when the stored value or the cap-draft
 * epoch changes — that is the draft-reset mechanism.
 *
 * The CANONICAL cap field for BOTH lanes (R1 standards finding 6): the Reply
 * lane's auto-post caps and the Solicitation lane's send cap render through
 * this one component, so the badInput blur-discard invariant below has exactly
 * one owner. `label`/`hint`/`placeholder` carry the per-lane copy; a caller
 * with no expansion gate passes `expansionBlocked={false}` and that arm
 * no-ops.
 */
function DailyCapField({
  ariaLabel,
  label,
  hint,
  placeholder,
  storedCap,
  disabled,
  expansionBlocked,
  saved,
  onCommit,
  onDiscardDraft,
}: {
  ariaLabel: string;
  label: string;
  hint: string;
  placeholder: string;
  storedCap: number | null;
  disabled: boolean;
  expansionBlocked: boolean;
  saved: boolean;
  onCommit: (cap: number | null) => void;
  onDiscardDraft: () => void;
}) {
  const [draft, setDraft] = useState(storedCap === null ? '' : String(storedCap));
  // Set when a typed value was pulled back into 1..50, so the owner sees that
  // 100 became 50 rather than wondering why the field changed under them.
  const [clampNote, setClampNote] = useState<string | null>(null);

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
    setClampNote(clampNoteFor(draft, normalized));
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
      <span className="field-label">
        {label}
        {saved && <SavedMark />}
      </span>
      <input
        type="number"
        className="input"
        aria-label={ariaLabel}
        min={MIN_DAILY_CAP}
        max={MAX_DAILY_CAP}
        step={1}
        inputMode="numeric"
        placeholder={placeholder}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          setClampNote(null);
        }}
        onBlur={commit}
      />
      <span className="field-hint">{hint}</span>
      {clampNote && (
        <span className="field-hint" style={{ color: 'var(--rw-app-text)' }}>{clampNote}</span>
      )}
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

/** The sentence shown when a typed cap was pulled back into range; null otherwise. */
function clampNoteFor(draft: string, normalized: number | null): string | null {
  if (normalized === null) return null;
  const parsed = Number.parseInt(draft.trim(), 10);
  if (Number.isNaN(parsed) || parsed === normalized) return null;
  if (parsed > MAX_DAILY_CAP) return `Capped at ${MAX_DAILY_CAP} — the most that can post automatically in a day.`;
  return `Raised to ${MIN_DAILY_CAP} — the lowest cap. Use “Off” above to stop auto-posting entirely.`;
}

/**
 * The Solicitation lane's opt-in card (#631 D20). Rendered ONLY when the
 * server says the lane is available (both lane flags AND the Autopilot tier —
 * invariant #13, the client never reads flags). The toggle IS the opt-in: on
 * creates the account-default solicitation policy row, off deletes it.
 * Expansion classification mirrors the server: enabling, shortening the veto
 * window, or raising the ENFORCED cap (resolveAccountDailySendCap's <= 10
 * clamp) confirms first.
 */
function SolicitationSection({
  state,
  saving,
  saveError,
  savedFieldKey,
  capDraftEpoch,
  onSet,
  onDisable,
  onDiscardCapDraft,
}: {
  state: SolicitationAutoApprovalApiState;
  saving: boolean;
  saveError: string | null;
  savedFieldKey: string | null;
  capDraftEpoch: number;
  onSet: (
    config: { dailySendCap: number | null; vetoWindowMinutes: SolicitationVetoWindowMinutes },
    expansion: boolean,
  ) => void;
  onDisable: () => void;
  onDiscardCapDraft: () => void;
}) {
  const currentWindow: SolicitationVetoWindowMinutes =
    isSolicitationVetoWindowMinutes(state.vetoWindowMinutes)
      ? state.vetoWindowMinutes
      : SOLICITATION_DEFAULT_VETO_WINDOW_MINUTES;
  const effectiveDailySendCap = resolveAccountDailySendCap({ dailySendCap: state.dailySendCap });

  return (
    <section className="set-section">
      <div className="set-section-head">
        <div className="set-section-icon violet" aria-hidden>
          <Icon name="sparkle" size={18} />
        </div>
        <div>
          <div className="set-section-title">Review requests</div>
          <div className="set-section-sub">
            Autopilot can approve a built batch of review requests for sending without waiting for your approval.
          </div>
        </div>
      </div>

      <div className="toggle-row">
        <div className="toggle-info">
          <div className="t-title">Auto-approve request batches</div>
          <div className="t-sub">
            Each auto-approved batch notifies you first and waits out its veto window — the time you have to halt it from the Requests page.
          </div>
        </div>
        <button
          type="button"
          className={`switch ${state.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={state.enabled}
          aria-label="Auto-approve request batches"
          disabled={saving}
          onClick={() => {
            if (state.enabled) {
              onDisable();
              return;
            }
            onSet(
              { dailySendCap: null, vetoWindowMinutes: SOLICITATION_DEFAULT_VETO_WINDOW_MINUTES },
              true,
            );
          }}
        />
      </div>

      {state.enabled && (
        <div className="auto-policy-dials">
          <label className="field">
            <span className="field-label">
              Veto window
              {savedFieldKey === 'solicitation:set_solicitation_account_default' && <SavedMark />}
            </span>
            <select
              className="input"
              aria-label="Review request veto window"
              value={`${currentWindow}`}
              disabled={saving}
              onChange={(event) => {
                const minutes = Number(event.target.value);
                if (!isSolicitationVetoWindowMinutes(minutes)) return;
                onSet(
                  { dailySendCap: state.dailySendCap, vetoWindowMinutes: minutes },
                  minutes < currentWindow,
                );
              }}
            >
              <option value="30">30 minutes</option>
              <option value="60">60 minutes</option>
            </select>
            <span className="field-hint">
              How long an auto-approved batch waits after its notice before sending, so you can still halt it.
            </span>
          </label>
          <DailyCapField
            key={`solicitation-cap-${capDraftEpoch}-${state.dailySendCap ?? 'default'}`}
            ariaLabel="Daily review request send cap"
            label="Daily send cap"
            hint={`Most review requests sent per day — 1 to 50. Leave blank for the default; RepWorth never sends more than ${DEFAULT_DAILY_SEND_CAP_ACCOUNT} in a day.`}
            placeholder={`Default (${DEFAULT_DAILY_SEND_CAP_ACCOUNT})`}
            storedCap={state.dailySendCap}
            disabled={saving}
            // This lane's expansion question (raising the ENFORCED cap) is
            // answered by the onCommit's classifier below, not by a readiness
            // block — so the shared field's expansion-discard arm no-ops.
            expansionBlocked={false}
            saved={savedFieldKey === 'solicitation:set_solicitation_account_default'}
            onCommit={(cap) => onSet(
              { dailySendCap: cap, vetoWindowMinutes: currentWindow },
              resolveAccountDailySendCap({ dailySendCap: cap }) > effectiveDailySendCap,
            )}
            onDiscardDraft={onDiscardCapDraft}
          />
        </div>
      )}

      {saveError && <InlineSaveError message={saveError} />}
    </section>
  );
}

function ReadinessBlock({ items }: { items: ReadinessCopy[] }) {
  if (items.length === 0) {
    return (
      <div className="auto-policy-readiness ok">
        <Icon name="check" size={14} /> You can widen or narrow auto-posting whenever you like.
      </div>
    );
  }

  return (
    <div className="auto-policy-readiness blocked">
      <Icon name="alert" size={14} />
      <div style={{ display: 'grid', gap: 4 }}>
        {items.map((item) => (
          <div key={item.message}>
            {item.message}
            {item.cta && (
              <>
                {' '}
                <Link
                  href={item.cta.href}
                  style={{ color: 'inherit', fontWeight: 600, textDecoration: 'underline' }}
                >
                  {item.cta.label}
                </Link>
              </>
            )}
          </div>
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

/**
 * The exposure a location would have after picking `selected`. A fresh
 * override row is seeded from the account's dials (the server's
 * `freshRowSeed` inherits them), so a rowless location's after-state keeps the
 * account's veto window and cap with only the threshold swapped.
 */
function locationExposureAfterSelection(
  location: AutoApprovalLocationSettings,
  accountPolicy: AutoApprovalPolicyApiState,
  selected: SelectValue,
): PolicyExposure {
  if (selected === 'inherit') return policyExposure(accountPolicy);
  const seed = location.override.exists
    ? policyExposure(location.effective)
    : policyExposure(accountPolicy);
  return { ...seed, threshold: thresholdFromValue(selected) };
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
  if (
    request.operation === 'set_solicitation_account_default'
    || request.operation === 'clear_solicitation_account_default'
  ) {
    return 'solicitation';
  }
  return 'locationId' in request ? request.locationId : 'account';
}

/** Which field just saved — scope plus operation — for the inline "Saved" mark. */
function fieldKey(request: AutoApprovalPatchRequest): string {
  return `${requestKey(request)}:${request.operation}`;
}

/** Maps a PATCH failure body onto one owner-facing sentence. Never surfaces a raw code. */
function errorMessage(body: unknown, status: number): string {
  const error = readErrorCode(body);
  if (!error) return `This change did not save (${status}). Try again.`;

  if (error === 'auto_approval_expansion_blocked') {
    return blockedErrorMessage(body) || 'Auto-posting cannot be widened right now. You can still narrow or turn it off.';
  }
  return SAVE_ERROR_COPY[error] ?? 'This change did not save. Try again.';
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
    .map((reason) => BLOCK_REASON_COPY[reason].message)
    .join(' ');
}
