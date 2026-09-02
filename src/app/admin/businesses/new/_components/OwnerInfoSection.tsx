'use client';

import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import type { FormData } from '../schema';
import { Field, SectionCard, inputClass } from './_shared';

// Name + email only. The phone field went with the SerpAPI prefill it was
// mostly populated by; nothing in the invite flow reads owner_phone, and the
// owner can supply it later from settings.
interface OwnerInfoSectionProps {
  register: UseFormRegister<FormData>;
  errors: FieldErrors<FormData>;
}

export function OwnerInfoSection({ register, errors }: OwnerInfoSectionProps) {
  return (
    <SectionCard title="Owner Info">
      <Field label="Owner Name *" error={errors.ownerName?.message}>
        {({ id, describedBy, invalid }) => (
          <input
            {...register('ownerName')}
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            type="text"
            className={inputClass}
            placeholder="Jane Smith"
          />
        )}
      </Field>

      <Field label="Email *" error={errors.ownerEmail?.message}>
        {({ id, describedBy, invalid }) => (
          <input
            {...register('ownerEmail')}
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            type="email"
            className={inputClass}
            placeholder="jane@example.com"
          />
        )}
      </Field>
    </SectionCard>
  );
}
