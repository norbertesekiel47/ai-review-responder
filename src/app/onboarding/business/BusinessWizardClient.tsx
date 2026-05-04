'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProgressDots } from './ProgressDots';
import { StepLocation } from './StepLocation';
import { StepProfile } from './StepProfile';
import { StepVoice } from './StepVoice';

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
   * When true, the wizard runs as 2-step (Profile, Voice) — location was
   * already captured at /onboarding/start. When false, the wizard runs as
   * 3-step (Location, Profile, Voice) — the legacy single-pass flow.
   */
  demoFlowEnabled?: boolean;
}

type LegacyStep = 1 | 2 | 3;
type PostPayStep = 1 | 2;

export function BusinessWizardClient({
  initialValues,
  demoFlowEnabled = false,
}: BusinessWizardClientProps) {
  const [step, setStep] = useState<LegacyStep | PostPayStep>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const totalSteps = demoFlowEnabled ? 2 : 3;

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

  async function submit(opts: { skipVoice?: boolean } = {}) {
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
          return;
        }
        setError(body.message ?? body.error ?? 'Submission failed');
        return;
      }

      router.push(body.redirectTo ?? '/dashboard');
    } catch {
      setError('Connection failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        {demoFlowEnabled && (
          <p className="text-center text-blue-600 text-sm mb-2">
            You&apos;re in. Two quick questions to make responses sound like you,
            then we go live.
          </p>
        )}
        <h1 className="text-3xl font-bold text-center mb-2">
          Set up your business
        </h1>
        <p className="text-center text-gray-600 mb-8">
          A few quick details so we can start fetching your reviews.
        </p>

        <ProgressDots current={step} total={totalSteps} />

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
                onSubmit={() => submit()}
                onSkip={() => submit({ skipVoice: true })}
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
                onSubmit={() => submit()}
                onSkip={() => submit({ skipVoice: true })}
                submitting={submitting}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
