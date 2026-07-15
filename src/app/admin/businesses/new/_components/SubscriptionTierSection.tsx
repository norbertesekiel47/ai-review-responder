'use client';

import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import type { FormData } from '../schema';
import { SectionCard } from './_shared';
import { SubscriptionTier } from '@/lib/accounts/tier-config';

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
            value={SubscriptionTier.COPILOT}
            className="mt-0.5"
          />
          <div>
            <span className="block text-sm font-semibold text-gray-900">
              Copilot
            </span>
            <span className="text-xs text-gray-500">
              Drafts every reply; the owner approves every public action.
            </span>
          </div>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-4 hover:bg-gray-50">
          <input
            {...register('subscriptionTier')}
            type="radio"
            value={SubscriptionTier.AUTOPILOT}
            className="mt-0.5"
          />
          <div>
            <span className="block text-sm font-semibold text-gray-900">
              Autopilot
            </span>
            <span className="text-xs text-gray-500">
              May post eligible replies inside the owner&apos;s safety policy.
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
