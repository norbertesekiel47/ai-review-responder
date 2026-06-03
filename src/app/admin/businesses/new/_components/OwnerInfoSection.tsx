'use client';

import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import type { FormData } from '../schema';
import { Field, SectionCard, inputClass } from './_shared';

interface OwnerInfoSectionProps {
  register: UseFormRegister<FormData>;
  errors: FieldErrors<FormData>;
  prefilling: boolean;
}

export function OwnerInfoSection({ register, errors, prefilling }: OwnerInfoSectionProps) {
  return (
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

    </SectionCard>
  );
}
