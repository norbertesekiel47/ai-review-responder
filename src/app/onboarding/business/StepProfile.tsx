'use client';

import type { RefObject } from 'react';
import type { WizardFormData } from './BusinessWizardClient';
import { StepHeading } from './StepHeading';
import {
  BUSINESS_CATEGORY_GROUPS,
  isBusinessSubcategory,
} from '@/lib/shared/business-categories';
import { LazyMotion, m, domAnimation } from 'motion/react';
import {
  fieldClass,
  selectClass,
  labelClass,
  primaryButtonClass,
  ghostButtonClass,
  buttonMotion,
} from '../_shared/field-styles';

interface StepProfileProps {
  stepLabel: string;
  data: WizardFormData;
  update: (patch: Partial<WizardFormData>) => void;
  dirtyRef: RefObject<{ category: boolean; website: boolean }>;
  onBack?: () => void;
  onNext: () => void;
}

export function StepProfile({
  stepLabel,
  data,
  update,
  dirtyRef,
  onBack,
  onNext,
}: StepProfileProps) {
  const canContinue = data.businessName.trim().length > 0;
  // Non-empty, but not one of the 92 — a row written before #1093. Offered back
  // as an option so it survives; `null` for every value the vocabulary covers.
  const legacyCategory =
    data.category.length > 0 && !isBusinessSubcategory(data.category)
      ? data.category
      : null;

  return (
    <LazyMotion features={domAnimation}>
    <div className="space-y-4">
      <StepHeading stepLabel={stepLabel}>Business profile</StepHeading>
      <p className="text-sm text-rw-ink-soft">
        We may have pre-filled some of these from Google Maps. Feel free to
        edit.
      </p>

      <div>
        <label htmlFor="biz-name" className={labelClass}>
          Business name <span className="text-rw-error" aria-hidden="true">*</span>
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
        <select
          id="biz-category"
          value={data.category}
          onChange={(e) => {
            if (dirtyRef.current) dirtyRef.current.category = true;
            update({ category: e.target.value });
          }}
          className={selectClass}
        >
          <option value="">Choose a category…</option>
          {/* A stored value from BEFORE the vocabulary existed (#1085 keeps
              those legal rather than migrating them) is offered back as its own
              option. Without this the select would render blank and the owner's
              existing category would be silently dropped the next time they
              saved the step. */}
          {legacyCategory !== null && (
            <option value={legacyCategory}>{legacyCategory} (current)</option>
          )}
          {BUSINESS_CATEGORY_GROUPS.map((group) => (
            <optgroup key={group.category} label={group.category}>
              {group.subcategories.map((sub) => (
                <option key={sub} value={sub}>
                  {sub}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
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
