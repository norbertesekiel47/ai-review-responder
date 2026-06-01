'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { PlaceAutocomplete } from '@/components/PlaceAutocomplete';
import { motion } from 'motion/react';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
import {
  fieldClass,
  labelClass,
  errorBannerClass,
  primaryButtonClass,
  buttonMotion,
} from '../_shared/field-styles';

interface PrefillResponse {
  category: string | null;
  website: string | null;
}

export function StartLocationClient() {
  const router = useRouter();
  const [inputMode, setInputMode] = useState<'autocomplete' | 'url'>('autocomplete');
  const [googlePlaceId, setGooglePlaceId] = useState('');
  const [googlePlaceAddress, setGooglePlaceAddress] = useState('');
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [prefilledCategory, setPrefilledCategory] = useState<string | null>(null);
  const [prefilledWebsite, setPrefilledWebsite] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const prefillAbortRef = useRef<AbortController | null>(null);

  async function triggerPrefill(placeId: string) {
    if (prefillAbortRef.current) prefillAbortRef.current.abort();
    const controller = new AbortController();
    prefillAbortRef.current = controller;

    try {
      const res = await fetch(
        `/api/signup/place-prefill?place_id=${encodeURIComponent(placeId)}`,
        { signal: controller.signal },
      );
      if (!res.ok) return;
      const prefill = (await res.json()) as PrefillResponse;
      setPrefilledCategory(prefill.category);
      setPrefilledWebsite(prefill.website);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }

  function cancelPrefill() {
    setPrefilledCategory(null);
    setPrefilledWebsite(null);
    if (prefillAbortRef.current) {
      prefillAbortRef.current.abort();
      prefillAbortRef.current = null;
    }
  }

  async function submit() {
    setSubmitting(true);
    setError('');

    const payload = {
      inputMode,
      businessName,
      ...(inputMode === 'autocomplete'
        ? { googlePlaceId, googlePlaceAddress, prefilledCategory, prefilledWebsite }
        : { googleMapsUrl }),
    };

    try {
      const res = await fetch('/api/onboarding/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(body.error ?? 'Submission failed');
        return;
      }

      const redirectTo = body.redirectTo ?? '/onboarding/demo';
      if (redirectTo === '/onboarding/demo') {
        void captureSampleDemoStarted(inputMode);
      }
      router.push(redirectTo);
    } catch {
      setError('Connection failed');
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = businessName.trim().length > 0 && (
    inputMode === 'autocomplete' ? Boolean(googlePlaceId) : Boolean(googleMapsUrl.trim())
  );

  return (
    <OnboardingFunnelShell step="find">
      <h1 className="text-3xl md:text-4xl font-medium text-center text-[#2a2a2a] mb-2">
        Find your business
      </h1>
      <p className="text-center text-[#6a6a6a] mb-8">
        We&apos;ll generate a live demo of AI responses for your actual reviews.
      </p>

      {error && <div className={`${errorBannerClass} mb-4`}>{error}</div>}

      <div className="space-y-4">
        <div>
          <label htmlFor="biz-name-start" className={labelClass}>
            Business name
          </label>
          <input
            id="biz-name-start"
            type="text"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Your business name"
            className={fieldClass}
            maxLength={80}
          />
        </div>

        {inputMode === 'autocomplete' ? (
          <PlaceAutocomplete
            ariaLabel="Business location"
            onPlaceSelect={(sel) => {
              setGooglePlaceId(sel.placeId);
              setGooglePlaceAddress(sel.formattedAddress);
              triggerPrefill(sel.placeId);
            }}
            onClear={() => {
              cancelPrefill();
              setGooglePlaceId('');
              setGooglePlaceAddress('');
            }}
          />
        ) : (
          <input
            aria-label="Google Maps URL"
            type="text"
            value={googleMapsUrl}
            onChange={(e) => setGoogleMapsUrl(e.target.value)}
            placeholder="https://maps.google.com/..."
            className={fieldClass}
          />
        )}

        <button
          type="button"
          onClick={() => {
            cancelPrefill();
            if (inputMode === 'autocomplete') {
              setGooglePlaceId('');
              setGooglePlaceAddress('');
              setInputMode('url');
            } else {
              setGoogleMapsUrl('');
              setInputMode('autocomplete');
            }
          }}
          className="text-xs text-[#97B3AE] hover:text-[#7e9b96]"
        >
          {inputMode === 'autocomplete'
            ? 'Or paste a Google Maps URL'
            : 'Use search instead'}
        </button>

        <div className="flex justify-end pt-4">
          <motion.button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitting}
            {...buttonMotion}
            className={primaryButtonClass}
          >
            {submitting ? 'Generating demo...' : 'Generate my demo'}
          </motion.button>
        </div>
      </div>
    </OnboardingFunnelShell>
  );
}

async function captureSampleDemoStarted(inputMode: 'autocomplete' | 'url') {
  await fetch('/api/analytics/enqueue', {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventName: 'sample_demo_started',
      clientEventId: makeClientEventId(),
      properties: { source: 'onboarding_start', inputMode },
    }),
  }).catch(() => undefined);
}

function makeClientEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
