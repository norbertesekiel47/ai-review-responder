export interface BusinessWizardPayloadData {
  inputMode: 'autocomplete' | 'url';
  googlePlaceId: string;
  googlePlaceAddress: string;
  googleMapsUrl: string;
  businessName: string;
  category: string;
  website: string;
  tone: string;
  productsServices: string;
  staffNames: string;
  highlightFacts: string;
  avoidFacts: string;
  sampleResponses: string;
}

// Brand-voice fields are submitted on both flows unless the wizard skips the
// voice step. Empty strings collapse to undefined so they're omitted from the
// payload rather than overwriting saved values with blanks.
function voiceFields(
  data: BusinessWizardPayloadData,
  skipVoice: boolean | undefined,
): Record<string, unknown> {
  if (skipVoice) return {};
  return {
    productsServices: data.productsServices || undefined,
    staffNames: data.staffNames || undefined,
    highlightFacts: data.highlightFacts || undefined,
    avoidFacts: data.avoidFacts || undefined,
    sampleResponses: data.sampleResponses || undefined,
  };
}

// Legacy (pre-pay) flow only: the location is captured here. Autocomplete and
// URL modes are mutually exclusive, so only the matching pair is populated.
function legacyLocationFields(
  data: BusinessWizardPayloadData,
): Record<string, unknown> {
  const isAutocomplete = data.inputMode === 'autocomplete';
  const isUrl = data.inputMode === 'url';
  return {
    googlePlaceId: isAutocomplete ? data.googlePlaceId || undefined : undefined,
    googlePlaceAddress: isAutocomplete
      ? data.googlePlaceAddress || undefined
      : undefined,
    googleMapsUrl: isUrl ? data.googleMapsUrl || undefined : undefined,
  };
}

export function buildBusinessWizardPayload(
  data: BusinessWizardPayloadData,
  opts: { demoFlowEnabled: boolean; skipVoice?: boolean },
): Record<string, unknown> {
  if (opts.demoFlowEnabled) {
    // Post-pay: location was set at /start; never resubmit it here.
    return {
      businessName: data.businessName || undefined,
      category: data.category || undefined,
      tone: data.tone || undefined,
      website: data.website || undefined,
      ...voiceFields(data, opts.skipVoice),
    };
  }

  return {
    businessName: data.businessName,
    category: data.category || undefined,
    ...legacyLocationFields(data),
    tone: data.tone || undefined,
    website: data.website || undefined,
    ...voiceFields(data, opts.skipVoice),
  };
}
