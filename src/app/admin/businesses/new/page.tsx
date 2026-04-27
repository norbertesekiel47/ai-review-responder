'use client';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormSchema, type FormData } from './schema';
import { useBusinessPrefill } from './hooks/useBusinessPrefill';
import { BusinessInfoSection } from './components/BusinessInfoSection';
import { OwnerInfoSection } from './components/OwnerInfoSection';
import { VoiceContextSection } from './components/VoiceContextSection';
import { SubscriptionTierSection } from './components/SubscriptionTierSection';

export default function NewBusinessPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [inputMode, setInputMode] = useState<'autocomplete' | 'url'>('autocomplete');

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    getFieldState,
    resetField,
    clearErrors,
    formState,
  } = useForm<FormData>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      tone: 'professional and friendly',
      subscriptionTier: 'founding',
    },
  });
  const { errors } = formState;

  const { prefilling, triggerPrefill, cancelPrefill } = useBusinessPrefill({
    setValue,
    getValues,
    getFieldState,
  });

  async function onSubmit(data: FormData) {
    setSubmitting(true);
    setServerError(null);

    try {
      // Build payload from inputMode, not hidden field presence
      const { googlePlaceId, googlePlaceAddress, googleMapsUrl, website, ...rest } = data;
      // Normalize empty website string to null (Zod schema accepts either).
      const normalizedWebsite = website && website.trim().length > 0 ? website.trim() : null;
      const payload = inputMode === 'autocomplete'
        ? { ...rest, googlePlaceId, googlePlaceAddress, website: normalizedWebsite }
        : { ...rest, googleMapsUrl, website: normalizedWebsite };

      const res = await fetch('/api/admin/businesses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = (await res.json()) as { id?: string; error?: string };

      if (!res.ok) {
        setServerError(json.error ?? 'Unexpected server error');
        return;
      }

      if (!json.id) {
        setServerError('Server returned no business ID');
        return;
      }

      const { id, paymentUrl } = json as { id: string; paymentUrl?: string | null };
      if (paymentUrl) {
        // Redirect to Stripe Payment Link — after checkout, Stripe redirects
        // back (if success_url is configured) or the admin checks the business detail page.
        // Original clipboard copy commented out:
        // try { await navigator.clipboard.writeText(paymentUrl); } catch { /* ignore */ }
        // alert(`Business created! Payment link copied to clipboard:\n\n${paymentUrl}`);
        window.location.href = paymentUrl;
        return; // Don't push to router — we're leaving the app
      }
      router.push(`/admin/businesses/${id}`);
    } catch {
      setServerError('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 py-10">
      <div className="mx-auto max-w-2xl px-4">
        <h1 className="mb-6 text-2xl font-bold text-gray-900">
          Onboard New Business
        </h1>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-6">
          {/* Section 1 — Business Info */}
          <BusinessInfoSection
            register={register}
            errors={errors}
            setValue={setValue}
            clearErrors={clearErrors}
            resetField={resetField}
            inputMode={inputMode}
            setInputMode={setInputMode}
            prefilling={prefilling}
            triggerPrefill={triggerPrefill}
            cancelPrefill={cancelPrefill}
          />

          {/* Section 2 — Owner Info */}
          <OwnerInfoSection
            register={register}
            errors={errors}
            prefilling={prefilling}
          />

          {/* Section 3 — Voice & Context */}
          <VoiceContextSection register={register} errors={errors} />

          {/* Section 4 — Subscription Tier */}
          <SubscriptionTierSection register={register} errors={errors} />

          {/* Server error banner */}
          {serverError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {serverError}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create Business & Start Initial Sync'}
          </button>
        </form>
      </div>
    </div>
  );
}
