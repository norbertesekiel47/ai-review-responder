// @vitest-environment jsdom
import { describe, it } from 'vitest';

// SolicitationAddressPanel — the owner-facing attestation surface on
// settings/profile (#656 T5). Written as pending placeholders by T1 (the eval
// task); T5 fills them in.
//
// The panel is a SIBLING of ProfilePanel, not an edit to it, and reads its
// state from a prop the server component fetched (deviations D3) — no widening
// of the shared /api/settings payload or useSettingsForm.
//
// What each case has to actually prove:
//
//  - "prefills from google_place_address as an editable suggestion" — the
//    suggestion is offered ONLY when no attested address exists, and it is a
//    suggestion precisely because google_place_address can be a service-area
//    value like "Austin, TX, USA" (spec §7.5). Editable, never authoritative.
//
//  - "never persisted before explicit attestation" — render with
//    `address: null, suggestion: '…'`, assert the textarea shows the
//    suggestion AND that no fetch/PUT fires on mount or on blur. A prefill that
//    saves itself is Google's string masquerading as an owner attestation.
//
//  - "requires a fresh attestation after a saved address is edited" — editing
//    clears the checkbox and re-arms the requirement. This is the UI half of
//    the schema's digest CHECK: an edit IS a re-attestation, and the previously
//    checked state never authorizes edited bytes.
//
//  - "uses POSTAL_ADDRESS_ATTESTATION_TEXT verbatim" means
//    `toBe(POSTAL_ADDRESS_ATTESTATION_TEXT)` against the IMPORTED constant,
//    never a hand-copied string. The constant is the compliance record of what
//    the owner agreed to, and its wording is versioned; a copy in the test
//    would let the two drift and still pass.

describe('SolicitationAddressPanel', () => {
  it.todo('the profile settings surface prefills the postal address from google_place_address as an editable suggestion');
  it.todo('google_place_address prefill is never persisted before explicit attestation');
  it.todo('the profile settings surface refuses to submit until the attestation is checked');
  it.todo('the profile settings surface requires a fresh attestation after a saved address is edited');
  it.todo('the profile settings checkbox uses POSTAL_ADDRESS_ATTESTATION_TEXT verbatim');
});
