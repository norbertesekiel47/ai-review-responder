'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { PlaceAutocomplete } from '@/components/PlaceAutocomplete';

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

      router.push(body.redirectTo ?? '/onboarding/demo');
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
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold text-center mb-2">Find your business</h1>
        <p className="text-center text-gray-600 mb-8">
          We&apos;ll generate a live demo of AI responses for your actual reviews.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <label className="block text-sm font-medium text-gray-700">Business name</label>
          <input
            type="text"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Your business name"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            maxLength={80}
          />

          {inputMode === 'autocomplete' ? (
            <PlaceAutocomplete
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
              type="text"
              value={googleMapsUrl}
              onChange={(e) => setGoogleMapsUrl(e.target.value)}
              placeholder="https://maps.google.com/..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            {inputMode === 'autocomplete' ? 'Or paste a Google Maps URL' : 'Use search instead'}
          </button>

          <div className="flex justify-end pt-4">
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit || submitting}
              className="bg-blue-600 text-white font-medium py-2 px-6 rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Generating demo...' : 'Generate my demo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
