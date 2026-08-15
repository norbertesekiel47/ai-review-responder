'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FormSchema, type FormData } from './schema';
import { BusinessInfoSection } from './_components/BusinessInfoSection';
import { OwnerInfoSection } from './_components/OwnerInfoSection';

export function NewBusinessClient() {
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

      router.push(`/admin/businesses/${json.id}`);
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
