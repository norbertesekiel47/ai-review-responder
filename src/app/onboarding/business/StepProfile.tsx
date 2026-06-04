'use client';

import type { RefObject } from 'react';
import type { WizardFormData } from './BusinessWizardClient';
import { LazyMotion, m, domAnimation } from 'motion/react';
import {
  fieldClass,
  labelClass,
  primaryButtonClass,
  ghostButtonClass,
  buttonMotion,
} from '../_shared/field-styles';

interface StepProfileProps {
  data: WizardFormData;
  update: (patch: Partial<WizardFormData>) => void;
  dirtyRef: RefObject<{ category: boolean; website: boolean }>;
  onBack?: () => void;
  onNext: () => void;
}

export function StepProfile({
  data,
  update,
  dirtyRef,
  onBack,
  onNext,
}: StepProfileProps) {
  const canContinue = data.businessName.trim().length > 0;

  return (
    <LazyMotion features={domAnimation}>
    <div className="space-y-4">
      <h2 className="text-xl font-medium text-[#2a2a2a]">Business profile</h2>
      <p className="text-sm text-[#6a6a6a]">
        We may have pre-filled some of these from Google Maps. Feel free to
        edit.
      </p>

      <div>
        <label htmlFor="biz-name" className={labelClass}>
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
          className={fieldClass}
        />
      </div>

      <div>
        <label htmlFor="biz-category" className={labelClass}>
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
          className={fieldClass}
        />
      </div>

      <div>
        <label htmlFor="biz-website" className={labelClass}>
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
          className={fieldClass}
        />
      </div>

      <div
        className={`flex items-center pt-4 ${
          onBack ? 'justify-between' : 'justify-end'
        }`}
      >
        {onBack && (
          <button type="button" onClick={onBack} className={ghostButtonClass}>
            ← Back
          </button>
        )}
        <m.button
          type="button"
          onClick={onNext}
          disabled={!canContinue}
          {...buttonMotion}
          className={primaryButtonClass}
        >
          Continue →
        </m.button>
      </div>
    </div>
    </LazyMotion>
  );
}
