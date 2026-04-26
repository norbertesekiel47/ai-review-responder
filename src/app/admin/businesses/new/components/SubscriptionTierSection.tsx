'use client';

import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import type { FormData } from '../schema';
import { SectionCard } from './_shared';

interface SubscriptionTierSectionProps {
  register: UseFormRegister<FormData>;
  errors: FieldErrors<FormData>;
}

export function SubscriptionTierSection({
  register,
  errors,
}: SubscriptionTierSectionProps) {
  return (
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
  );
}
