'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProgressDots } from './ProgressDots';
import { StepLocation } from './StepLocation';
import { StepProfile } from './StepProfile';
import { StepVoice } from './StepVoice';
import { StepConnect } from './StepConnect';

export interface WizardFormData {
  // Location (legacy 3-step only — empty/unused in post-pay flow)
  inputMode: 'autocomplete' | 'url';
  googlePlaceId: string;
  googlePlaceAddress: string;
  googleMapsUrl: string;

  // Profile
  businessName: string;
  category: string;
  website: string;

  // Voice (all optional/skippable)
  tone: string;
  productsServices: string;
  staffNames: string;
  highlightFacts: string;
  avoidFacts: string;
  sampleResponses: string;
}

interface BusinessWizardClientProps {
  /** Pre-filled values from server-side businesses row. */
  initialValues?: {
    category: string;
    website: string;
    businessName: string;
  };
  /**
   * When true, the wizard runs as 3-step (Profile, Voice, Connect Zernio) —
   * location was already captured at /onboarding/start. When false, the
   * wizard runs as 3-step (Location, Profile, Voice) — the legacy
   * single-pass flow with no Connect step.
   */
  demoFlowEnabled?: boolean;
}

type Step = 1 | 2 | 3;

export function BusinessWizardClient({
  initialValues,
  demoFlowEnabled = false,
}: BusinessWizardClientProps) {
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  // Both flows are 3-step now; only the step labels differ.
  const totalSteps = 3;

  const [data, setData] = useState<WizardFormData>({
    inputMode: 'autocomplete',
    googlePlaceId: '',
    googlePlaceAddress: '',
    googleMapsUrl: '',
    businessName: initialValues?.businessName ?? '',
    category: initialValues?.category ?? '',
    website: initialValues?.website ?? '',
    tone: 'professional and friendly',
    productsServices: '',
    staffNames: '',
    highlightFacts: '',
    avoidFacts: '',
    sampleResponses: '',
  });

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
    setSubmitting(true);
    setError('');
    try {
      const payload = demoFlowEnabled
        ? {
            // Post-pay: location was set at /start; never resubmit it here.
            businessName: data.businessName || undefined,
            category: data.category || undefined,
            tone: data.tone || undefined,
            website: data.website || undefined,
            ...(opts.skipVoice
              ? {}
              : {
                  productsServices: data.productsServices || undefined,
                  staffNames: data.staffNames || undefined,
                  highlightFacts: data.highlightFacts || undefined,
                  avoidFacts: data.avoidFacts || undefined,
                  sampleResponses: data.sampleResponses || undefined,
                }),
          }
        : {
            businessName: data.businessName,
            category: data.category || undefined,
            googlePlaceId:
              data.inputMode === 'autocomplete'
                ? data.googlePlaceId || undefined
                : undefined,
            googlePlaceAddress:
              data.inputMode === 'autocomplete'
                ? data.googlePlaceAddress || undefined
                : undefined,
            googleMapsUrl:
              data.inputMode === 'url' ? data.googleMapsUrl || undefined : undefined,
            tone: data.tone || undefined,
            website: data.website || undefined,
            ...(opts.skipVoice
              ? {}
              : {
                  productsServices: data.productsServices || undefined,
                  staffNames: data.staffNames || undefined,
                  highlightFacts: data.highlightFacts || undefined,
                  avoidFacts: data.avoidFacts || undefined,
                  sampleResponses: data.sampleResponses || undefined,
                }),
          };

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
        setError(body.message ?? body.error ?? 'Submission failed');
        return false;
      }

      return true;
    } catch {
      setError('Connection failed');
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  // Legacy flow: Voice submit/skip POSTs and lands on /dashboard.
  async function legacySubmit(opts: { skipVoice?: boolean } = {}) {
    const ok = await saveProfileAndVoice(opts);
    if (ok) router.push('/dashboard');
  }

  // Demo flow: Voice submit/skip stores intent and advances to Connect step
  // (no POST yet — the POST happens at the Connect step's terminal action).
  const [voiceSkipped, setVoiceSkipped] = useState(false);
  function advanceToConnect(opts: { skipVoice?: boolean } = {}) {
    setVoiceSkipped(Boolean(opts.skipVoice));
    setStep(3);
  }

  // Demo flow Step 3: "Connect Google Business Profile" — save then redirect
  // to Zernio OAuth. The user lands on Zernio's consent screen, then comes
  // back through /api/zernio/connect/callback → /dashboard/connect/select-location.
  async function handleConnectZernio() {
    const saved = await saveProfileAndVoice({ skipVoice: voiceSkipped });
    if (!saved) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/zernio/connect/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.authUrl) {
        setError(
          'Could not start the Google connection. You can try again from the dashboard.',
        );
        // Best UX on failure: don't block them — Profile/Voice is already
        // saved, send them to /dashboard so they can retry from there.
        router.push('/dashboard');
        return;
      }
      window.location.href = body.authUrl;
    } catch {
      setError('Network error. Redirecting to dashboard.');
      router.push('/dashboard');
    } finally {
      setSubmitting(false);
    }
  }

  // Demo flow Step 3: "Skip for now" — save then go to /dashboard.
  async function handleSkipConnect() {
    const saved = await saveProfileAndVoice({ skipVoice: voiceSkipped });
    if (saved) router.push('/dashboard');
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {demoFlowEnabled && (
          <p className="text-center text-blue-600 text-sm mb-2">
            You&apos;re in. A few quick steps to make responses sound like you and
            connect your reviews, then we go live.
          </p>
        )}
        <h1 className="text-3xl font-bold text-center mb-2">
          Set up your business
        </h1>
        <p className="text-center text-gray-600 mb-8">
          A few quick details so we can start fetching your reviews.
        </p>

        <ProgressDots current={step} total={totalSteps} demoFlow={demoFlowEnabled} />

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {demoFlowEnabled ? (
          <>
            {step === 1 && (
              <StepProfile
                data={data}
                update={update}
                dirtyRef={dirtyRef}
                onBack={() => { /* no back from first step */ }}
                onNext={() => setStep(2)}
              />
            )}
            {step === 2 && (
              <StepVoice
                data={data}
                update={update}
                onBack={() => setStep(1)}
                onSubmit={() => advanceToConnect()}
                onSkip={() => advanceToConnect({ skipVoice: true })}
                submitting={submitting}
              />
            )}
            {step === 3 && (
              <StepConnect
                onBack={() => setStep(2)}
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
                data={data}
                update={update}
                dirtyRef={dirtyRef}
                onNext={() => setStep(2)}
              />
            )}
            {step === 2 && (
              <StepProfile
                data={data}
                update={update}
                dirtyRef={dirtyRef}
                onBack={() => setStep(1)}
                onNext={() => setStep(3)}
              />
            )}
            {step === 3 && (
              <StepVoice
                data={data}
                update={update}
                onBack={() => setStep(2)}
                onSubmit={() => legacySubmit()}
                onSkip={() => legacySubmit({ skipVoice: true })}
                submitting={submitting}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
