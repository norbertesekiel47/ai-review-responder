import { describe, expect, it } from 'vitest';

import {
  CONSENT_ATTESTATION_TEXT,
  CONSENT_ATTESTATION_VERSION,
  SEND_ELIGIBLE_ATTESTATION_VERSIONS,
} from '../attestation';

describe('consent attestation v2 (#625 spec §2)', () => {
  it('pins CONSENT_ATTESTATION_VERSION to consent_attestation_v2', () => {
    expect(CONSENT_ATTESTATION_VERSION).toBe('consent_attestation_v2');
  });

  it('names email, the opt-out promise, and RepWorth sending on the business\'s behalf — and drops the watch-mode disclaimer', () => {
    expect(CONSENT_ATTESTATION_TEXT).toContain('by email');
    expect(CONSENT_ATTESTATION_TEXT).toContain(
      'Recipients may opt out of these emails at any time, and RepWorth will honor those opt-outs',
    );
    expect(CONSENT_ATTESTATION_TEXT).toContain(
      "RepWorth may send review requests to them by email on this business's behalf",
    );
    expect(CONSENT_ATTESTATION_TEXT).not.toContain('watch-mode');
  });

  it('allowlists only v2 as a send-eligible attestation version — v1 is deliberately absent', () => {
    // Exact membership, not just containment: the allowlist IS the
    // send-eligibility gate (the batch builder inlines it in SQL), so an
    // accidental extra member would silently widen eligibility.
    expect([...SEND_ELIGIBLE_ATTESTATION_VERSIONS]).toEqual(['consent_attestation_v2']);
    expect(SEND_ELIGIBLE_ATTESTATION_VERSIONS).not.toContain('consent_attestation_v1');
  });
});
