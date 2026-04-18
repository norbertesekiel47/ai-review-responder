'use client';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { PlaceAutocomplete } from '@/components/PlaceAutocomplete';
import { websiteUrlSchema } from '@/lib/shared/schemas';

const FormSchema = z.object({
  name: z.string().min(1, 'Business name is required').max(255),
  category: z.string().max(100).optional(),
  googlePlaceId: z.string().optional(),
  googlePlaceAddress: z.string().optional(),
  googleMapsUrl: z.string().optional(),
  // websiteUrlSchema only permits http:// or https:// — blocks javascript:,
  // data:, ftp:, etc. .or(z.literal('')) keeps empty string valid for the form.
  website: websiteUrlSchema.or(z.literal('')).optional(),
  ownerName: z.string().min(1, 'Owner name is required').max(255),
  ownerEmail: z.string().email('Valid email is required').max(255),
  ownerPhone: z.string().max(20).optional(),
  notificationPreference: z.enum(['email', 'sms', 'both']),
  tone: z.string().max(100),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  subscriptionTier: z.enum(['founding', 'standard']),
});

type FormData = z.infer<typeof FormSchema>;

// ---------------------------------------------------------------------------
// Reusable field wrapper
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  error?: string;
  children: React.ReactNode;
  hint?: string;
}

function Field({ label, error, children, hint }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-gray-700">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-gray-500">{hint}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared input class
// ---------------------------------------------------------------------------

const inputClass =
  'rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';

const textareaClass = `${inputClass} resize-y min-h-[80px]`;

// ---------------------------------------------------------------------------
// Section card wrapper
// ---------------------------------------------------------------------------

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-base font-semibold text-gray-900">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

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
    clearErrors,
    formState,
  } = useForm<FormData>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      notificationPreference: 'email',
      tone: 'professional and friendly',
      subscriptionTier: 'founding',
    },
  });
  const { errors } = formState;

  const [prefilling, setPrefilling] = useState(false);
  // Guards against the stale-response race: user selects Place A, then quickly
  // selects Place B before A's request resolves. Without guards, A's response
  // can overwrite B's empty fields with A's data. We track the latest
  // AbortController so we can cancel in-flight requests, AND the latest
  // selected placeId so we can reject stale responses that somehow still arrive.
  const prefillAbortRef = useRef<AbortController | null>(null);
  const latestPlaceIdRef = useRef<string | null>(null);

  /**
   * Cancels any in-flight prefill and clears the "latest place" guard.
   * Called when the user:
   *   - clears the PlaceAutocomplete selection
   *   - switches from autocomplete mode to URL-paste mode
   * Without this, a Place A request that was launched before the clear/switch
   * can resolve AFTER the user abandoned that place and still auto-fill
   * stale data into empty fields.
   */
  function cancelPrefill() {
    latestPlaceIdRef.current = null;
    if (prefillAbortRef.current) {
      prefillAbortRef.current.abort();
      prefillAbortRef.current = null;
    }
    setPrefilling(false);
  }

  async function triggerPrefill(placeId: string) {
    // Cancel any in-flight request — this is the primary defense.
    if (prefillAbortRef.current) {
      prefillAbortRef.current.abort();
    }
    const controller = new AbortController();
    prefillAbortRef.current = controller;
    latestPlaceIdRef.current = placeId;

    setPrefilling(true);
    try {
      const res = await fetch(
        `/api/admin/businesses/prefill?place_id=${encodeURIComponent(placeId)}`,
        { signal: controller.signal },
      );
      // Secondary defense: if a newer selection happened, discard this response.
      if (latestPlaceIdRef.current !== placeId) return;
      if (!res.ok) return; // Silent failure — fields remain empty for manual entry
      const prefill = (await res.json()) as {
        category: string | null;
        phone: string | null;
        website: string | null;
        hours: string | null;
        fullAddress: string | null;
      };
      // Check AGAIN after awaiting body parse — the user could have selected
      // a different place between headers arriving and body parsing.
      if (latestPlaceIdRef.current !== placeId) return;

      // Only fill fields that are (1) currently empty AND (2) have never been
      // touched by the user. We use `getFieldState(name).isDirty` instead of
      // a destructured `dirtyFields` object because the destructured value is
      // captured at render time — the user could have typed (and cleared) a
      // field WHILE the prefill request was in flight, and a captured
      // `dirtyFields.category === false` snapshot would overwrite their work.
      // `getFieldState` reads the live form state at call time.
      const current = getValues();
      if (
        prefill.category &&
        !current.category &&
        !getFieldState('category').isDirty
      ) {
        setValue('category', prefill.category, { shouldDirty: false });
      }
      if (
        prefill.phone &&
        !current.ownerPhone &&
        !getFieldState('ownerPhone').isDirty
      ) {
        setValue('ownerPhone', prefill.phone, { shouldDirty: false });
      }
      if (
        prefill.website &&
        !current.website &&
        !getFieldState('website').isDirty
      ) {
        setValue('website', prefill.website, { shouldDirty: false });
      }
    } catch (err) {
      // AbortError is expected when the user quickly selects a different place.
      // Any other error (network, parse) silently degrades to manual entry.
      if (err instanceof DOMException && err.name === 'AbortError') return;
    } finally {
      // Only clear the UI spinner if this call is still the latest.
      // If a newer call is in flight, keep showing the spinner for it.
      if (prefillAbortRef.current === controller) {
        setPrefilling(false);
        prefillAbortRef.current = null;
      }
    }
  }

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
          <SectionCard title="Business Info">
            <Field label="Business Name *" error={errors.name?.message}>
              <input
                {...register('name')}
                type="text"
                className={inputClass}
                placeholder="Bella Vista Restaurant"
              />
            </Field>

            <Field
              label="Category"
              error={errors.category?.message}
              hint={prefilling ? 'Fetching suggestions from Google Maps…' : undefined}
            >
              <input
                {...register('category')}
                type="text"
                className={inputClass}
                placeholder="Restaurant, Salon, Dentist..."
              />
            </Field>

            <Field
              label="Website"
              error={errors.website?.message}
              hint={prefilling ? 'Fetching suggestions from Google Maps…' : undefined}
            >
              <input
                {...register('website')}
                type="url"
                className={inputClass}
                placeholder="https://example.com"
              />
            </Field>

            <Field
              label="Business Location *"
              error={errors.googlePlaceId?.message || errors.googleMapsUrl?.message}
              hint={
                inputMode === 'autocomplete'
                  ? 'Search for the business by name'
                  : 'Paste the full Google Maps URL for this business'
              }
            >
              {inputMode === 'autocomplete' ? (
                <PlaceAutocomplete
                  onPlaceSelect={(sel) => {
                    setValue('googlePlaceId', sel.placeId);
                    setValue('googlePlaceAddress', sel.formattedAddress);
                    clearErrors('googlePlaceId');
                    // Auto-trigger prefill. This runs async and fills empty
                    // category/ownerPhone/website fields when the response arrives.
                    triggerPrefill(sel.placeId);
                  }}
                  onClear={() => {
                    // Cancel before clearing so a still-in-flight Place A response
                    // can't auto-fill the form after the user abandoned that place.
                    cancelPrefill();
                    setValue('googlePlaceId', '');
                    setValue('googlePlaceAddress', '');
                  }}
                />
              ) : (
                <input
                  {...register('googleMapsUrl')}
                  type="text"
                  className={inputClass}
                  placeholder="https://maps.google.com/..."
                />
              )}
              <button
                type="button"
                onClick={() => {
                  if (inputMode === 'autocomplete') {
                    // Switching away from autocomplete — cancel any in-flight
                    // prefill so its response can't arrive and populate fields
                    // after the user has moved to URL-paste mode.
                    cancelPrefill();
                    setValue('googlePlaceId', '');
                    setValue('googlePlaceAddress', '');
                    clearErrors('googlePlaceId');
                    setInputMode('url');
                  } else {
                    setValue('googleMapsUrl', '');
                    clearErrors('googleMapsUrl');
                    setInputMode('autocomplete');
                  }
                }}
                className="mt-1 text-xs text-indigo-600 hover:text-indigo-800"
              >
                {inputMode === 'autocomplete'
                  ? 'Or paste a Google Maps URL'
                  : 'Use search instead'}
              </button>
            </Field>
          </SectionCard>

          {/* Section 2 — Owner Info */}
          <SectionCard title="Owner Info">
            <Field label="Owner Name *" error={errors.ownerName?.message}>
              <input
                {...register('ownerName')}
                type="text"
                className={inputClass}
                placeholder="Jane Smith"
              />
            </Field>

            <Field label="Email *" error={errors.ownerEmail?.message}>
              <input
                {...register('ownerEmail')}
                type="email"
                className={inputClass}
                placeholder="jane@example.com"
              />
            </Field>

            <Field
              label="Phone"
              error={errors.ownerPhone?.message}
              hint={prefilling ? 'Fetching suggestions from Google Maps…' : undefined}
            >
              <input
                {...register('ownerPhone')}
                type="tel"
                className={inputClass}
                placeholder="+1 555 000 0000"
              />
            </Field>

            <Field
              label="Notification Preference"
              error={errors.notificationPreference?.message}
            >
              <select {...register('notificationPreference')} className={inputClass}>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="both">Both</option>
              </select>
            </Field>
          </SectionCard>

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
