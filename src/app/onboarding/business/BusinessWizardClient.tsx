'use client';

import { useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StepLocation } from './StepLocation';
import { StepProfile } from './StepProfile';
import { StepVoice } from './StepVoice';
import { StepConnect } from './StepConnect';
import { wizardFlowCopy, wizardStepLabel, type WizardStep } from './StepHeading';
import {
  buildBusinessWizardPayload,
  initialWizardFormData,
  type BusinessWizardPayloadData,
  type WizardInitialValues,
} from './payload';
import { tierGrantsAutopilot } from '@/lib/accounts/tier-config';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
import { errorBannerClass } from '../_shared/field-styles';
import {
  ONBOARDING_CONNECTION_FAILED,
  mapOnboardingApiError,
} from '../_shared/onboarding-error-copy';

// The form state IS the payload input — one shape, owned by payload.ts.
// Location fields are legacy-3-step only (empty/unused in the post-pay flow).
export type WizardFormData = BusinessWizardPayloadData;

interface BusinessWizardClientProps {
  /** Pre-filled values from server-side businesses row. */
  initialValues?: WizardInitialValues;
  /**
   * When true, the wizard runs as 3-step (Profile, Voice, Connect Zernio) —
   * location was already captured at /onboarding/start. When false, the
   * wizard runs as 3-step (Location, Profile, Voice) — the legacy
   * single-pass flow with no Connect step.
   */
  demoFlowEnabled?: boolean;
  /**
   * The account's subscription tier, read server-side. Drives the Connect
   * step's promise: Copilot owners approve every reply; Autopilot owners are
   * told that in-policy replies post after the veto window (A12).
   */
  subscriptionTier?: string | null;
}

interface WizardState {
  step: WizardStep;
  submitting: boolean;
  error: string;
  voiceSkipped: boolean;
}

const initialWizardState: WizardState = {
  step: 1,
  submitting: false,
  error: '',
  voiceSkipped: false,
};

type WizardAction =
  | { type: 'goToStep'; step: WizardStep }
  | { type: 'submitStart' }
  | { type: 'setSubmitting'; submitting: boolean }
  | { type: 'setError'; error: string }
  | { type: 'advanceToConnect'; voiceSkipped: boolean };

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'goToStep':
      return { ...state, step: action.step };
    case 'submitStart':
      return { ...state, submitting: true, error: '' };
    case 'setSubmitting':
      return { ...state, submitting: action.submitting };
    case 'setError':
      return { ...state, error: action.error };
    case 'advanceToConnect':
      return { ...state, voiceSkipped: action.voiceSkipped, step: 3 };
    default:
      return state;
  }
}

export function BusinessWizardClient({
  initialValues,
  demoFlowEnabled = false,
  subscriptionTier = null,
}: BusinessWizardClientProps) {
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState);
  const { step, submitting, error, voiceSkipped } = state;
  const router = useRouter();

  const copy = wizardFlowCopy(demoFlowEnabled);
  const label = (n: WizardStep) => wizardStepLabel(n, copy.stepNames[n]);
  const goToStep = (n: WizardStep) => () => dispatch({ type: 'goToStep', step: n });
  const autopilot = tierGrantsAutopilot(subscriptionTier);

  const [data, setData] = useState<WizardFormData>(() => initialWizardFormData(initialValues));

  const update = (patch: Partial<WizardFormData>) =>
    setData((prev) => ({ ...prev, ...patch }));

  // Tracks which Profile fields the user has manually edited so /start's
  // place-prefill (legacy 3-step) doesn't stomp typing in flight.
  const dirtyRef = useRef({ category: false, website: false });

  /**
   * POSTs Profile + (optionally) Voice fields to /api/onboarding/business.
   * Returns true on success, false on validation/network failure (with
   * `error` state populated). Does NOT navigate — the caller chooses
   * what to do after the save (advance to Connect step, redirect to
   * Zernio OAuth, or land on /dashboard).
   */
  async function saveProfileAndVoice(opts: { skipVoice?: boolean } = {}): Promise<boolean> {
    dispatch({ type: 'submitStart' });
    try {
      const payload = buildBusinessWizardPayload(data, {
        demoFlowEnabled,
        skipVoice: opts.skipVoice,
      });

      const res = await fetch('/api/onboarding/business', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (body.redirectTo) {
          router.push(body.redirectTo);
          return false;
        }
        dispatch({ type: 'setError', error: mapOnboardingApiError(body) });
        return false;
      }

      return true;
    } catch {
      dispatch({ type: 'setError', error: ONBOARDING_CONNECTION_FAILED });
      return false;
    } finally {
      dispatch({ type: 'setSubmitting', submitting: false });
    }
  }

  // Legacy flow: Voice submit/skip POSTs and lands on /dashboard.
  async function legacySubmit(opts: { skipVoice?: boolean } = {}) {
    const ok = await saveProfileAndVoice(opts);
    if (ok) router.push('/dashboard');
  }

  // Demo flow: Voice submit/skip stores intent and advances to Connect step
  // (no POST yet — the POST happens at the Connect step's terminal action).
  function advanceToConnect(opts: { skipVoice?: boolean } = {}) {
    dispatch({ type: 'advanceToConnect', voiceSkipped: Boolean(opts.skipVoice) });
  }

  // Demo flow Step 3: "Connect Google Business Profile" — save then redirect
  // to Zernio OAuth. The user lands on Zernio's consent screen, then comes
  // back through /api/zernio/connect/callback → /dashboard/connect/select-location.
  async function handleConnectZernio() {
    const saved = await saveProfileAndVoice({ skipVoice: voiceSkipped });
    if (!saved) return;
    dispatch({ type: 'setSubmitting', submitting: true });
    try {
      const res = await fetch('/api/zernio/connect/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.authUrl) {
        dispatch({
          type: 'setError',
          error: 'Could not start the Google connection. You can try again from the dashboard.',
        });
        // Best UX on failure: don't block them — Profile/Voice is already
        // saved, send them to /dashboard so they can retry from there.
        router.push('/dashboard');
        return;
      }
      window.location.href = body.authUrl;
    } catch {
      dispatch({
        type: 'setError',
        error: "Couldn't reach RepWorth. Your details are saved — taking you to your dashboard.",
      });
      router.push('/dashboard');
    } finally {
      dispatch({ type: 'setSubmitting', submitting: false });
    }
  }

  // Demo flow Step 3: "Skip for now" — save then go to /dashboard.
  async function handleSkipConnect() {
    const saved = await saveProfileAndVoice({ skipVoice: voiceSkipped });
    if (saved) router.push('/dashboard');
  }

  return (
    <OnboardingFunnelShell step="setup" showThread={demoFlowEnabled}>
      {/* One heading, one subtitle, then the step. The funnel thread above the
          card is the only progress graphic; the sub-step renders as text inside
          each step's h2 via StepHeading (A10). */}
      <h1 className="text-3xl md:text-4xl font-medium text-center text-rw-ink mb-2">
        Set up your business
      </h1>
      <p className="text-center text-rw-ink-soft mb-8">{copy.subtitle}</p>

      {error && <div className={`${errorBannerClass} mb-4`}>{error}</div>}

      {demoFlowEnabled ? (
        <>
          {step === 1 && (
            <StepProfile
              stepLabel={label(1)}
              data={data}
              update={update}
              dirtyRef={dirtyRef}
              onNext={goToStep(2)}
            />
          )}
          {step === 2 && (
            <StepVoice
              stepLabel={label(2)}
              data={data}
              update={update}
              onBack={goToStep(1)}
              onSubmit={() => advanceToConnect()}
              onSkip={() => advanceToConnect({ skipVoice: true })}
              submitting={submitting}
              // Voice is NOT the last step here — Connect follows (A11).
              submitLabel={copy.voiceSubmitLabel}
            />
          )}
          {step === 3 && (
            <StepConnect
              stepLabel={label(3)}
              autopilot={autopilot}
              onBack={goToStep(2)}
              onConnect={handleConnectZernio}
              onSkip={handleSkipConnect}
              submitting={submitting}
            />
          )}
        </>
      ) : (
        <>
          {step === 1 && (
            <StepLocation
              stepLabel={label(1)}
              data={data}
              update={update}
              dirtyRef={dirtyRef}
              onNext={goToStep(2)}
            />
          )}
          {step === 2 && (
            <StepProfile
              stepLabel={label(2)}
              data={data}
              update={update}
              dirtyRef={dirtyRef}
              onBack={goToStep(1)}
              onNext={goToStep(3)}
            />
          )}
          {step === 3 && (
            <StepVoice
              stepLabel={label(3)}
              data={data}
              update={update}
              onBack={goToStep(2)}
              onSubmit={() => legacySubmit()}
              onSkip={() => legacySubmit({ skipVoice: true })}
              submitting={submitting}
              submitLabel={copy.voiceSubmitLabel}
            />
          )}
        </>
      )}
    </OnboardingFunnelShell>
  );
}
