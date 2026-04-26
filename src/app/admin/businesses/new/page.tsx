'use client';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormSchema, type FormData } from './schema';
import { useBusinessPrefill } from './hooks/useBusinessPrefill';
import { Field, SectionCard, inputClass, textareaClass } from './components/_shared';
import { BusinessInfoSection } from './components/BusinessInfoSection';
import { OwnerInfoSection } from './components/OwnerInfoSection';

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
          <SectionCard title="Voice &amp; Context">
            <Field label="Tone" error={errors.tone?.message}>
              <select {...register('tone')} className={inputClass}>
                <option value="warm and casual">Warm and casual</option>
                <option value="professional and friendly">Professional and friendly</option>
                <option value="professional and reassuring">Professional and reassuring</option>
                <option value="professional and gracious">Professional and gracious</option>
                <option value="warm and personal">Warm and personal</option>
                <option value="professional and caring">Professional and caring</option>
              </select>
            </Field>

            <Field
              label="Products / Services"
              error={errors.productsServices?.message}
              hint="Brief description of what this business offers"
            >
              <textarea
                {...register('productsServices')}
                className={textareaClass}
                placeholder="We serve authentic Italian cuisine, wood-fired pizza, and craft cocktails..."
              />
            </Field>

            <Field
              label="Staff Names"
              error={errors.staffNames?.message}
              hint="Names the AI can reference in responses"
            >
              <input
                {...register('staffNames')}
                type="text"
                className={inputClass}
                placeholder="Maria, Carlos, Chef Diego"
              />
            </Field>

            <Field
              label="Highlight Facts"
              error={errors.highlightFacts?.message}
              hint="One per line — things the AI should emphasize (awards, specials, etc.)"
            >
              <textarea
                {...register('highlightFacts')}
                className={textareaClass}
                placeholder={'Best of City Award 2024\nHappy hour Mon–Fri 4–6pm'}
              />
            </Field>

            <Field
              label="Avoid Facts"
              error={errors.avoidFacts?.message}
              hint="One per line — topics the AI must never mention"
            >
              <textarea
                {...register('avoidFacts')}
                className={textareaClass}
                placeholder={'parking situation\nprice comparisons'}
              />
            </Field>

            <Field
              label="Sample Responses"
              error={errors.sampleResponses?.message}
              hint="Paste example responses that match the owner's voice"
            >
              <textarea
                {...register('sampleResponses')}
                className={textareaClass}
                placeholder="Thank you so much for visiting us! We love hearing..."
              />
            </Field>
          </SectionCard>

          {/* Section 4 — Subscription Tier */}
          <SectionCard title="Subscription Tier">
            <fieldset className="flex flex-col gap-3">
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-4 hover:bg-gray-50">
                <input
                  {...register('subscriptionTier')}
                  type="radio"
                  value="founding"
                  className="mt-0.5"
                />
                <div>
                  <span className="block text-sm font-semibold text-gray-900">
                    Founding Member — $99/mo
                  </span>
                  <span className="text-xs text-gray-500">
                    Rate locked for life. Limited availability.
                  </span>
                </div>
              </label>

              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-4 hover:bg-gray-50">
                <input
                  {...register('subscriptionTier')}
                  type="radio"
                  value="standard"
                  className="mt-0.5"
                />
                <div>
                  <span className="block text-sm font-semibold text-gray-900">
                    Standard — $149/mo
                  </span>
                  <span className="text-xs text-gray-500">
                    Full feature access at the standard rate.
                  </span>
                </div>
              </label>
            </fieldset>
            {errors.subscriptionTier && (
              <p className="text-xs text-red-600">{errors.subscriptionTier.message}</p>
            )}
          </SectionCard>

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
