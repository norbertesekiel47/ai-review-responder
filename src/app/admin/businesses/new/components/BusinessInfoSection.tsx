'use client';

import type {
  FieldErrors,
  UseFormClearErrors,
  UseFormRegister,
  UseFormResetField,
  UseFormSetValue,
} from 'react-hook-form';
import { PlaceAutocomplete } from '@/components/PlaceAutocomplete';
import type { FormData } from '../schema';
import { Field, SectionCard, inputClass } from './_shared';

interface BusinessInfoSectionProps {
  register: UseFormRegister<FormData>;
  errors: FieldErrors<FormData>;
  setValue: UseFormSetValue<FormData>;
  clearErrors: UseFormClearErrors<FormData>;
  resetField: UseFormResetField<FormData>;
  inputMode: 'autocomplete' | 'url';
  setInputMode: (mode: 'autocomplete' | 'url') => void;
  prefilling: boolean;
  triggerPrefill: (placeId: string) => void;
  cancelPrefill: () => void;
}

export function BusinessInfoSection({
  register,
  errors,
  setValue,
  clearErrors,
  resetField,
  inputMode,
  setInputMode,
  prefilling,
  triggerPrefill,
  cancelPrefill,
}: BusinessInfoSectionProps) {
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

      <Field
        label="Category"
        error={errors.category?.message}
        hint={prefilling ? 'Fetching suggestions from Google Maps…' : undefined}
      >
        <input
          {...register('category')}
          type="text"
          className={inputClass}
          placeholder="Restaurant, Salon, Dentist..."
        />
      </Field>

      <Field
        label="Website"
        error={errors.website?.message}
        hint={prefilling ? 'Fetching suggestions from Google Maps…' : undefined}
      >
        <input
          {...register('website')}
          type="url"
          className={inputClass}
          placeholder="https://example.com"
        />
      </Field>

      <Field
        label="Business Location *"
        error={errors.googlePlaceId?.message || errors.googleMapsUrl?.message}
        hint={
          inputMode === 'autocomplete'
            ? 'Search for the business by name'
            : 'Paste the full Google Maps URL for this business'
        }
      >
        {inputMode === 'autocomplete' ? (
          <PlaceAutocomplete
            onPlaceSelect={(sel) => {
              setValue('googlePlaceId', sel.placeId);
              setValue('googlePlaceAddress', sel.formattedAddress);
              clearErrors('googlePlaceId');
              // Auto-trigger prefill. This runs async and fills empty
              // category/ownerPhone/website fields when the response arrives.
              triggerPrefill(sel.placeId);
            }}
            onClear={() => {
              // Cancel before clearing so a still-in-flight Place A response
              // can't auto-fill the form after the user abandoned that place.
              cancelPrefill();
              setValue('googlePlaceId', '');
              setValue('googlePlaceAddress', '');
              // Also reset any fields the prefill populated so the form
              // looks fresh. `resetField` clears both value AND dirty
              // state — important because the prefill "only fills empty +
              // undirty" check (see triggerPrefill) would otherwise block
              // the next selection from filling a field that the user
              // didn't manually touch.
              resetField('category');
              resetField('ownerPhone');
              resetField('website');
            }}
          />
        ) : (
          <input
            {...register('googleMapsUrl')}
            type="text"
            className={inputClass}
            placeholder="https://maps.google.com/..."
          />
        )}
        <button
          type="button"
          onClick={() => {
            if (inputMode === 'autocomplete') {
              // Switching away from autocomplete — cancel any in-flight
              // prefill so its response can't arrive and populate fields
              // after the user has moved to URL-paste mode.
              cancelPrefill();
              setValue('googlePlaceId', '');
              setValue('googlePlaceAddress', '');
              clearErrors('googlePlaceId');
              setInputMode('url');
            } else {
              setValue('googleMapsUrl', '');
              clearErrors('googleMapsUrl');
              setInputMode('autocomplete');
            }
          }}
          className="mt-1 text-xs text-indigo-600 hover:text-indigo-800"
        >
          {inputMode === 'autocomplete'
            ? 'Or paste a Google Maps URL'
            : 'Use search instead'}
        </button>
      </Field>
    </SectionCard>
  );
}
