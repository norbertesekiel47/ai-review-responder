// src/app/(authenticated)/dashboard/add-location/wizard/payload.ts
//
// Pure helpers for Step-1 location input and the /api/locations/add payload.

import type { BuildAddLocationPayloadInput, Step1LocationInput } from './types';

export function hasStep1LocationDetails({
  inputMode,
  placeSelection,
  googleMapsUrl,
}: Step1LocationInput): boolean {
  if (inputMode === 'url') return googleMapsUrl.trim().length > 0;
  return placeSelection !== null;
}

export function buildAddLocationPayload({
  accountId,
  displayLabel,
  inputMode,
  placeSelection,
  googleMapsUrl,
  voiceForm,
}: BuildAddLocationPayloadInput) {
  const trimmedMapsUrl = googleMapsUrl.trim();

  return {
    accountId,
    displayLabel: displayLabel.trim(),
    ...(inputMode === 'autocomplete' && placeSelection?.placeId
      ? { googlePlaceId: placeSelection.placeId }
      : {}),
    ...(inputMode === 'url' && trimmedMapsUrl
      ? { googleMapsUrl: trimmedMapsUrl }
      : {}),
    placeIdVerified: inputMode === 'autocomplete' && !!placeSelection,
    voiceConfig: {
      tone: voiceForm.tone,
      productsServices: voiceForm.productsServices || null,
      avoidFacts: voiceForm.avoidFacts.filter(Boolean),
      sampleResponses: voiceForm.sampleResponses.filter(Boolean),
    },
  };
}
