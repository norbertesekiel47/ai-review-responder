/**
 * Consent attestation text — versioned code constant (#535 contract §4).
 * v2 is an engineering placeholder pending counsel review (#625 Part II
 * flag 7); changing the wording MUST bump CONSENT_ATTESTATION_VERSION. The
 * version string is stored on every upload row: "which attestation covers
 * this person" is a query, not a guess.
 */
export const CONSENT_ATTESTATION_VERSION = 'consent_attestation_v2' as const;

export const CONSENT_ATTESTATION_TEXT =
  'I confirm these are real customers of this business who provided their '
  + 'contact information directly to us, that I am authorized to upload their '
  + "details, and that RepWorth may send review requests to them by email on "
  + "this business's behalf. Recipients may opt out of these emails at any "
  + 'time, and RepWorth will honor those opt-outs.';

/** Attestation versions whose coverage authorizes a SEND. Widened only when a
 *  new attestation text ships; membership is the send-eligibility gate.
 *  Deliberately a code constant, never an env var: staging and prod must agree
 *  on what an attestation authorizes. `consent_attestation_v1` is deliberately
 *  ABSENT — its text disclaimed sending ("No review requests will be sent in
 *  watch-mode"); the owner's remedy is to re-upload under v2, which the consent
 *  ledger makes effective (#625 spec §1.3). */
export const SEND_ELIGIBLE_ATTESTATION_VERSIONS = ['consent_attestation_v2'] as const;

/** True iff `version` is a send-eligible attestation version (allowlist membership). */
export function isSendEligibleAttestation(version: string | null): boolean {
  if (version === null) return false;
  return (SEND_ELIGIBLE_ATTESTATION_VERSIONS as readonly string[]).includes(version);
}
