'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProgressDots } from './ProgressDots';
import { StepLocation } from './StepLocation';
import { StepProfile } from './StepProfile';
import { StepVoice } from './StepVoice';

export interface WizardFormData {
  // Step 1 (Location)
  inputMode: 'autocomplete' | 'url';
  googlePlaceId: string;
  googlePlaceAddress: string;
  googleMapsUrl: string;

  // Step 2 (Profile)
  businessName: string;
  category: string;
  website: string;

  // Step 3 (Voice — all optional/skippable)
  tone: string;
  productsServices: string;
  staffNames: string;
  highlightFacts: string;
  avoidFacts: string;
  sampleResponses: string;
}

type Step = 1 | 2 | 3;

export function BusinessWizardClient() {
  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const [data, setData] = useState<WizardFormData>({
    inputMode: 'autocomplete',
    googlePlaceId: '',
    googlePlaceAddress: '',
    googleMapsUrl: '',
    businessName: '',
    category: '',
    website: '',
    tone: 'professional and friendly',
    productsServices: '',
    staffNames: '',
    highlightFacts: '',
    avoidFacts: '',
    sampleResponses: '',
  });

  const update = (patch: Partial<WizardFormData>) =>
    setData((prev) => ({ ...prev, ...patch }));

  // Tracks which Step-2 fields the user has manually edited. Step 1's
  // place-prefill fetch only fills empty + undirty fields so it can never
  // stomp the user's typing — the same defensive pattern the admin
  // /admin/businesses/new page uses for ownerPhone/category/website.
  const dirtyRef = useRef({ category: false, website: false });

  async function submit(opts: { skipVoice?: boolean } = {}) {
    setSubmitting(true);
    setError('');
    try {
      const payload = {
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
        // 409 already_onboarded includes a redirectTo so we honor it before
        // surfacing an error message.
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
        <h1 className="text-3xl font-bold text-center mb-2">
          Set up your business
        </h1>
        <p className="text-center text-gray-600 mb-8">
          A few quick details so we can start fetching your reviews.
        </p>

        <ProgressDots current={step} />

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4 text-sm text-red-700">
            {error}
          </div>
        )}

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
      </div>
    </div>
  );
}
