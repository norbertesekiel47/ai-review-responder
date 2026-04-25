'use client';

import type { RefObject } from 'react';
import type { WizardFormData } from './BusinessWizardClient';

interface StepProfileProps {
  data: WizardFormData;
  update: (patch: Partial<WizardFormData>) => void;
  dirtyRef: RefObject<{ category: boolean; website: boolean }>;
  onBack: () => void;
  onNext: () => void;
}

export function StepProfile({
  data,
  update,
  dirtyRef,
  onBack,
  onNext,
}: StepProfileProps) {
  const inputClass =
    'w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

  const canContinue = data.businessName.trim().length > 0;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <h2 className="text-lg font-medium text-gray-900">Business profile</h2>
      <p className="text-sm text-gray-600">
        We may have pre-filled some of these from Google Maps — feel free to
        edit.
      </p>

      <div>
        <label
          htmlFor="biz-name"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Business name <span className="text-red-500">*</span>
        </label>
        <input
          id="biz-name"
          type="text"
          required
          autoComplete="organization"
          value={data.businessName}
          onChange={(e) => update({ businessName: e.target.value })}
          placeholder="Bella Vista Restaurant"
          className={inputClass}
        />
      </div>

      <div>
        <label
          htmlFor="biz-category"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Category
        </label>
        <input
          id="biz-category"
          type="text"
          value={data.category}
          onChange={(e) => {
            if (dirtyRef.current) dirtyRef.current.category = true;
            update({ category: e.target.value });
          }}
          placeholder="Restaurant, Salon, Dentist…"
          className={inputClass}
        />
      </div>

      <div>
        <label
          htmlFor="biz-website"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Website
        </label>
        <input
          id="biz-website"
          type="url"
          value={data.website}
          onChange={(e) => {
            if (dirtyRef.current) dirtyRef.current.website = true;
            update({ website: e.target.value });
          }}
          placeholder="https://yourbusiness.com"
          className={inputClass}
        />
      </div>

      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className="text-gray-600 font-medium py-2 px-4 hover:text-gray-900"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canContinue}
          className="bg-blue-600 text-white font-medium py-2 px-6 rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
