// src/app/(authenticated)/dashboard/add-location/wizard/types.ts
//
// Shared types and constants for the Add-location wizard.

import type { PlaceSelection } from '@/components/places/PlaceAutocomplete';
import type { BillingSnapshot } from '@/lib/accounts/quota';

export interface Props {
  accountId: string;
  billingSnapshot: BillingSnapshot;
  activeLocationCount: number;
}

export type WizardStep = 1 | 2 | 3 | 4;
export type LocationInputMode = 'autocomplete' | 'url';

export interface VoiceFormState {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

export interface ExistingLocationVoice {
  locationId: string;
  displayName: string;
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

/** Raw shape of a location item from `GET /api/settings/voice`. Optional/nullable
 * fields are defaulted (`?? ''` / `?? []`) when mapped into ExistingLocationVoice. */
export interface VoiceConfigApiLocation {
  locationId: string;
  displayName: string;
  tone?: string | null;
  productsServices?: string | null;
  avoidFacts?: string[] | null;
  sampleResponses?: string[] | null;
}

export interface Step1LocationInput {
  inputMode: LocationInputMode;
  placeSelection: PlaceSelection | null;
  googleMapsUrl: string;
}

export interface BuildAddLocationPayloadInput extends Step1LocationInput {
  accountId: string;
  displayLabel: string;
  voiceForm: VoiceFormState;
}

export const STEP_INFO: Record<WizardStep, { title: string; subtitle: string }> = {
  1: { title: 'Add location', subtitle: 'Step 1 of 4 — Select location' },
  2: { title: 'Add location', subtitle: 'Step 2 of 4 — Google Business' },
  3: { title: 'Add location', subtitle: 'Step 3 of 4 — Voice config' },
  4: { title: 'Add location', subtitle: 'Step 4 of 4 — Confirm & pay' },
};

export const DEFAULT_VOICE: VoiceFormState = {
  tone: 'professional and friendly',
  productsServices: '',
  avoidFacts: [],
  sampleResponses: [],
};
