/**
 * Consent attestation text — versioned code constant (#535 contract §4).
 * Engineering placeholder until counsel reviews; changing the wording MUST
 * bump CONSENT_ATTESTATION_VERSION. The version string is stored on every
 * upload row: "which attestation covers this person" is a query, not a guess.
 */
export const CONSENT_ATTESTATION_VERSION = 'consent_attestation_v1' as const;

export const CONSENT_ATTESTATION_TEXT =
  'I confirm these are real customers of this business who provided their '
  + 'contact information directly to us, and that I am authorized to upload '
  + 'their details for review-request evaluation. No review requests will be '
  + 'sent in watch-mode.';
