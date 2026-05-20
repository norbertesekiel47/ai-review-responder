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

export function buildBusinessWizardPayload(
  data: BusinessWizardPayloadData,
  opts: { demoFlowEnabled: boolean; skipVoice?: boolean },
): Record<string, unknown> {
  return opts.demoFlowEnabled
    ? {
        // Post-pay: location was set at /start; never resubmit it here.
        businessName: data.businessName || undefined,
        category: data.category || undefined,
        tone: data.tone || undefined,
        website: data.website || undefined,
        ...(opts.skipVoice
          ? {}
          : {
              productsServices: data.productsServices || undefined,
              staffNames: data.staffNames || undefined,
              highlightFacts: data.highlightFacts || undefined,
              avoidFacts: data.avoidFacts || undefined,
              sampleResponses: data.sampleResponses || undefined,
            }),
      }
    : {
        businessName: data.businessName,
        category: data.category || undefined,
        googlePlaceId:
          data.inputMode === 'autocomplete' ? data.googlePlaceId || undefined : undefined,
        googlePlaceAddress:
          data.inputMode === 'autocomplete'
            ? data.googlePlaceAddress || undefined
            : undefined,
        googleMapsUrl:
          data.inputMode === 'url' ? data.googleMapsUrl || undefined : undefined,
        tone: data.tone || undefined,
        website: data.website || undefined,
        ...(opts.skipVoice
          ? {}
          : {
              productsServices: data.productsServices || undefined,
              staffNames: data.staffNames || undefined,
              highlightFacts: data.highlightFacts || undefined,
              avoidFacts: data.avoidFacts || undefined,
              sampleResponses: data.sampleResponses || undefined,
            }),
      };
}
