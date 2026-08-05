// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SolicitationAddressPanel } from '../SolicitationAddressPanel';
import {
  POSTAL_ADDRESS_ATTESTATION_TEXT,
  POSTAL_ADDRESS_ATTESTATION_VERSION,
  type PostalAddressState,
} from '@/lib/solicitation/postal-address';

// SolicitationAddressPanel — the owner-facing attestation surface on
// settings/profile (#656 T5).
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

const SUGGESTION = '500 Congress Ave, Austin, TX 78701, USA';
const SAVED_ADDRESS = '123 Main St\nAustin, TX 78701';
const PANEL_SOURCE_PATH = 'src/components/dashboard/settings/SolicitationAddressPanel.tsx';

function postalAddressState(overrides: Partial<PostalAddressState> = {}): PostalAddressState {
  return {
    address: null,
    attestedAt: null,
    attestationVersion: null,
    suggestion: null,
    ...overrides,
  };
}

/** A stored, already-attested location — the "edit is a re-attestation" case. */
function attestedState(): PostalAddressState {
  return postalAddressState({
    address: SAVED_ADDRESS,
    attestedAt: '2026-08-01T12:00:00.000Z',
    attestationVersion: POSTAL_ADDRESS_ATTESTATION_VERSION,
  });
}

const fetchMock = vi.fn();

function addressField(): HTMLTextAreaElement {
  return screen.getByLabelText('Postal address') as HTMLTextAreaElement;
}

function attestationCheckbox(): HTMLInputElement {
  return screen.getByLabelText(POSTAL_ADDRESS_ATTESTATION_TEXT) as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /attest/i }) as HTMLButtonElement;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: 'attested' }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SolicitationAddressPanel', () => {
  it('the profile settings surface prefills the postal address from google_place_address as an editable suggestion', () => {
    render(<SolicitationAddressPanel state={postalAddressState({ suggestion: SUGGESTION })} />);

    const field = addressField();
    expect(field.value).toBe(SUGGESTION);
    // A suggestion, not a record: nothing claims this address is attested.
    expect(field).not.toBeDisabled();
    expect(field).not.toHaveAttribute('readonly');
    expect(screen.queryByText(/^Attested /)).not.toBeInTheDocument();

    // Editable: the owner's correction replaces Google's service-area string.
    fireEvent.change(field, { target: { value: SAVED_ADDRESS } });
    expect(addressField().value).toBe(SAVED_ADDRESS);
  });

  it('google_place_address prefill is never persisted before explicit attestation', () => {
    render(<SolicitationAddressPanel state={postalAddressState({ suggestion: SUGGESTION })} />);

    const field = addressField();
    expect(field.value).toBe(SUGGESTION);

    // Mount alone must not write. Neither may the two events a "helpful"
    // autosave would hang itself on — blur, and a change followed by blur.
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: SAVED_ADDRESS } });
    fireEvent.blur(field);
    expect(fetchMock).not.toHaveBeenCalled();

    // And there is no path to a write that skips the attestation: the only
    // control that submits is inert until the box is ticked.
    expect(attestationCheckbox()).not.toBeChecked();
    expect(submitButton()).toBeDisabled();
  });

  it('the profile settings surface refuses to submit until the attestation is checked', async () => {
    render(<SolicitationAddressPanel state={postalAddressState({ suggestion: SUGGESTION })} />);

    const button = submitButton();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(attestationCheckbox());
    expect(button).toBeEnabled();
    fireEvent.click(button);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings/postal-address');
    expect(init.method).toBe('PUT');
    // The version the owner assented to travels with the address, so the route
    // can refuse a body that assents to some other text.
    expect(JSON.parse(String(init.body))).toEqual({
      address: SUGGESTION,
      attestationVersion: POSTAL_ADDRESS_ATTESTATION_VERSION,
      attested: true,
    });
  });

  it('the profile settings surface requires a fresh attestation after a saved address is edited', () => {
    render(<SolicitationAddressPanel state={attestedState()} />);

    const field = addressField();
    expect(field.value).toBe(SAVED_ADDRESS);
    // A stored attestation is not a ticked box: attesting is an act.
    expect(attestationCheckbox()).not.toBeChecked();

    fireEvent.click(attestationCheckbox());
    expect(submitButton()).toBeEnabled();

    // The tick covered THOSE bytes. Editing re-arms the requirement, mirroring
    // migration 099's digest CHECK server-side.
    fireEvent.change(field, { target: { value: `${SAVED_ADDRESS}\nSuite 4` } });
    expect(attestationCheckbox()).not.toBeChecked();
    expect(submitButton()).toBeDisabled();

    fireEvent.click(submitButton());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the profile settings checkbox uses POSTAL_ADDRESS_ATTESTATION_TEXT verbatim', () => {
    render(<SolicitationAddressPanel state={attestedState()} />);

    // (a) Value: the rendered label equals the IMPORTED constant, so a wording
    // change that bumps the version fails here unless the panel follows it.
    const label = screen.getByTestId('postal-address-attestation-label');
    expect(label.textContent).toBe(POSTAL_ADDRESS_ATTESTATION_TEXT);

    // (b) Provenance: value equality alone cannot tell an import from a
    // hand-copied literal that happens to match today. The panel's source must
    // READ the constant and must not carry a copy of the sentence — the exact
    // drift (a) would sail past.
    const source = readFileSync(resolve(process.cwd(), PANEL_SOURCE_PATH), 'utf-8');
    expect(source).toContain("from '@/lib/solicitation/postal-address'");
    expect(source).toContain('POSTAL_ADDRESS_ATTESTATION_TEXT');
    expect(source).not.toContain(POSTAL_ADDRESS_ATTESTATION_TEXT);
  });
});
