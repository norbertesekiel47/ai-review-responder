'use client';

import { useReducer, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { PlaceAutocomplete } from '@/components/places/PlaceAutocomplete';
import { LazyMotion, m, domAnimation } from 'motion/react';
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

type InputMode = 'autocomplete' | 'url';

interface StartLocationState {
  inputMode: InputMode;
  googlePlaceId: string;
  googlePlaceAddress: string;
  googleMapsUrl: string;
  businessName: string;
  prefilledCategory: string | null;
  prefilledWebsite: string | null;
  submitting: boolean;
  error: string;
}

const initialStartLocationState: StartLocationState = {
  inputMode: 'autocomplete',
  googlePlaceId: '',
  googlePlaceAddress: '',
  googleMapsUrl: '',
  businessName: '',
  prefilledCategory: null,
  prefilledWebsite: null,
  submitting: false,
  error: '',
};

type StartLocationAction =
  | { type: 'setBusinessName'; businessName: string }
  | { type: 'setGoogleMapsUrl'; googleMapsUrl: string }
  | { type: 'selectPlace'; googlePlaceId: string; googlePlaceAddress: string }
  | { type: 'clearPlace' }
  | { type: 'setPrefill'; prefilledCategory: string | null; prefilledWebsite: string | null }
  | { type: 'clearPrefill' }
  | { type: 'switchToUrl' }
  | { type: 'switchToAutocomplete' }
  | { type: 'submitStart' }
  | { type: 'submitError'; error: string }
  | { type: 'submitEnd' };

function startLocationReducer(
  state: StartLocationState,
  action: StartLocationAction,
): StartLocationState {
  switch (action.type) {
    case 'setBusinessName':
      return { ...state, businessName: action.businessName };
    case 'setGoogleMapsUrl':
      return { ...state, googleMapsUrl: action.googleMapsUrl };
    case 'selectPlace':
      // Drop any prefill from a previously selected place so submit() can't post
      // the new place with stale category/website until the new prefill resolves.
      return {
        ...state,
        googlePlaceId: action.googlePlaceId,
        googlePlaceAddress: action.googlePlaceAddress,
        prefilledCategory: null,
        prefilledWebsite: null,
      };
    case 'clearPlace':
      return {
        ...state,
        googlePlaceId: '',
        googlePlaceAddress: '',
        prefilledCategory: null,
        prefilledWebsite: null,
      };
    case 'setPrefill':
      return {
        ...state,
        prefilledCategory: action.prefilledCategory,
        prefilledWebsite: action.prefilledWebsite,
      };
    case 'clearPrefill':
      return { ...state, prefilledCategory: null, prefilledWebsite: null };
    case 'switchToUrl':
      return { ...state, googlePlaceId: '', googlePlaceAddress: '', inputMode: 'url' };
    case 'switchToAutocomplete':
      return { ...state, googleMapsUrl: '', inputMode: 'autocomplete' };
    case 'submitStart':
      return { ...state, submitting: true, error: '' };
    case 'submitError':
      return { ...state, error: action.error };
    case 'submitEnd':
      return { ...state, submitting: false };
    default:
      return state;
  }
}

export function StartLocationClient() {
  const router = useRouter();
  const [state, dispatch] = useReducer(startLocationReducer, initialStartLocationState);
  const {
    inputMode,
    googlePlaceId,
    googlePlaceAddress,
    googleMapsUrl,
    businessName,
    prefilledCategory,
    prefilledWebsite,
    submitting,
    error,
  } = state;

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
      dispatch({
        type: 'setPrefill',
        prefilledCategory: prefill.category,
        prefilledWebsite: prefill.website,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }

  function cancelPrefill() {
    dispatch({ type: 'clearPrefill' });
    if (prefillAbortRef.current) {
      prefillAbortRef.current.abort();
      prefillAbortRef.current = null;
    }
  }

  async function submit() {
    dispatch({ type: 'submitStart' });

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
        dispatch({ type: 'submitError', error: body.error ?? 'Submission failed' });
        return;
      }

      const redirectTo = body.redirectTo ?? '/onboarding/demo';
      if (redirectTo === '/onboarding/demo') {
        void captureSampleDemoStarted(inputMode);
      }
      router.push(redirectTo);
    } catch {
      dispatch({ type: 'submitError', error: 'Connection failed' });
    } finally {
      dispatch({ type: 'submitEnd' });
    }
  }

  const canSubmit = businessName.trim().length > 0 && (
    inputMode === 'autocomplete' ? Boolean(googlePlaceId) : Boolean(googleMapsUrl.trim())
  );

  return (
    <LazyMotion features={domAnimation}>
    <OnboardingFunnelShell step="find">
      <h1 className="text-3xl md:text-4xl font-medium text-center text-rw-ink mb-2">
        Find your business
      </h1>
      <p className="text-center text-rw-ink-soft mb-8">
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
            onChange={(e) => dispatch({ type: 'setBusinessName', businessName: e.target.value })}
            placeholder="Your business name"
            className={fieldClass}
            maxLength={80}
          />
        </div>

        {inputMode === 'autocomplete' ? (
          <PlaceAutocomplete
            ariaLabel="Business location"
            onPlaceSelect={(sel) => {
              dispatch({
                type: 'selectPlace',
                googlePlaceId: sel.placeId,
                googlePlaceAddress: sel.formattedAddress,
              });
              triggerPrefill(sel.placeId);
            }}
            onClear={() => {
              cancelPrefill();
              dispatch({ type: 'clearPlace' });
            }}
          />
        ) : (
          <input
            aria-label="Google Maps URL"
            type="text"
            value={googleMapsUrl}
            onChange={(e) => dispatch({ type: 'setGoogleMapsUrl', googleMapsUrl: e.target.value })}
            placeholder="https://maps.google.com/..."
            className={fieldClass}
          />
        )}

        <button
          type="button"
          onClick={() => {
            cancelPrefill();
            if (inputMode === 'autocomplete') {
              dispatch({ type: 'switchToUrl' });
            } else {
              dispatch({ type: 'switchToAutocomplete' });
            }
          }}
          className="text-xs text-rw-teal hover:text-[#7e9b96]"
        >
          {inputMode === 'autocomplete'
            ? 'Or paste a Google Maps URL'
            : 'Use search instead'}
        </button>

        <div className="flex justify-end pt-4">
          <m.button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitting}
            {...buttonMotion}
            className={primaryButtonClass}
          >
            {submitting ? 'Generating demo...' : 'Generate my demo'}
          </m.button>
        </div>
      </div>
    </OnboardingFunnelShell>
    </LazyMotion>
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
