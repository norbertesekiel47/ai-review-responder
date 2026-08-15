'use client';

import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import type { FormData } from '../schema';
import { Field, SectionCard, inputClass } from './_shared';

// One field, deliberately still a component: it is the "Business" half of a
// two-card form whose other half (owner identity) is a component too, and the
// pair is what gives NewBusinessClient its orchestrate-only shape. Collapsing
// only this one inline would leave the client half-orchestrating, half-
// rendering — worse than the single-input file.
//
// The Place capture (PlaceAutocomplete + Maps-URL toggle + SerpAPI prefill)
// that used to live here is gone: the invited owner captures their own place
// at /onboarding/start, exactly as a self-serve owner does.
interface BusinessInfoSectionProps {
  register: UseFormRegister<FormData>;
  errors: FieldErrors<FormData>;
}

export function BusinessInfoSection({ register, errors }: BusinessInfoSectionProps) {
  return (
    <SectionCard title="Business Info">
      <Field label="Business Name *" error={errors.name?.message}>
        <input
          {...register('name')}
          type="text"
          className={inputClass}
          placeholder="Bella Vista Restaurant"
        />
      </Field>
    </SectionCard>
  );
}
