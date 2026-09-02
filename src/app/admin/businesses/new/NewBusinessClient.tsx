'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormSchema, type FormData } from './schema';
import { BusinessInfoSection } from './_components/BusinessInfoSection';
import { OwnerInfoSection } from './_components/OwnerInfoSection';

/**
 * The one-line Beta comp notice (X10). The operator inviting a founding
 * customer needs to know, before they click, whether the comp coupon will ride
 * on this owner's checkout — `BETA_COMP_COUPON_ID` is a kill switch read at
 * checkout time, and "did I just invite them without the comp?" has no answer
 * on this screen otherwise. The boolean comes from the server page.
 */
export const BETA_COMP_ON_COPY =
  'Beta comp is on: this owner’s checkout carries the beta coupon (admin-invited accounts only).';
export const BETA_COMP_OFF_COPY =
  'Beta comp is off: this owner pays full price at checkout. Set BETA_COMP_COUPON_ID before inviting a founding customer.';

export function NewBusinessClient({ betaCompActive }: { betaCompActive: boolean }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { register, handleSubmit, formState } = useForm<FormData>({
    resolver: zodResolver(FormSchema),
  });
  const { errors } = formState;

  async function onSubmit(data: FormData) {
    setSubmitting(true);
    setServerError(null);

    try {
      // The parsed form IS the payload — three identity fields, no input-mode
      // branch to reconcile. Everything else about the business is captured
      // from the owner later in the self-serve funnel.
      const res = await fetch('/api/admin/businesses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
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

      // `invited=1` makes the detail page flash "Invite email sent to …" (X11);
      // the address itself comes from the detail read, not the URL.
      router.push(`/admin/businesses/${json.id}?invited=1`);
    } catch {
      setServerError('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // `max-w-2xl` is a form-legibility measure, not the deleted page shell:
    // AdminPage owns the page width/padding, but a form stretched across the
    // full console width is unreadable even at three fields.
    <form onSubmit={handleSubmit(onSubmit)} className="flex max-w-2xl flex-col gap-6">
      <p
        data-testid="beta-comp-notice"
        className={`rounded-md border px-4 py-2.5 text-sm ${
          betaCompActive
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-yellow-200 bg-yellow-50 text-yellow-900'
        }`}
      >
        {betaCompActive ? BETA_COMP_ON_COPY : BETA_COMP_OFF_COPY}
      </p>

      {/* Section 1 — Business Info */}
      <BusinessInfoSection register={register} errors={errors} />

      {/* Section 2 — Owner Info */}
      <OwnerInfoSection register={register} errors={errors} />

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
        className="w-full rounded-lg bg-gray-900 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Sending invite...' : 'Create Business & Invite Owner'}
      </button>
    </form>
  );
}
