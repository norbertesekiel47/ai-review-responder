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

  // The failure surface. `messageForFailure` is the panel's only branching
  // logic, and every branch ends in a sentence an owner reads, so the cases
  // below assert the CONTRACT its doc comment states — "never surfaces a raw
  // code" — rather than re-copying the prose. The maps are deliberately not
  // exported (the panel owns the wording), so a value-equality test here would
  // be a hand-copied literal that drifts silently; a distinctive fragment plus
  // the never-leak invariant survives a rewording that keeps the meaning.
  //
  // Failures announce through role=alert, not role=status: an owner who cannot
  // see the red paragraph still has to learn the write did not land.

  /** Drives one failed PUT and returns the sentence the panel announced. */
  async function announcedFailure(response: {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }): Promise<string> {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(response);
    render(<SolicitationAddressPanel state={postalAddressState({ suggestion: SUGGESTION })} />);
    fireEvent.click(attestationCheckbox());
    fireEvent.click(submitButton());
    const alert = await screen.findByRole('alert');
    return alert.textContent ?? '';
  }

  function failedResponse(status: number, body: unknown) {
    return { ok: false, status, json: async () => body };
  }

  it('a lint rejection is shown as the fix, never as the reason code', async () => {
    const message = await announcedFailure(
      failedResponse(400, { error: 'invalid_address', reason: 'single_line' }),
    );

    // The prose explains what to DO about a service-area string...
    expect(message).toMatch(/service area/i);
    // ...and the wire vocabulary stays on the wire.
    expect(message).not.toContain('single_line');
    expect(message).not.toContain('invalid_address');
  });

  it('a mapped error code is shown as its sentence, never as the code', async () => {
    const message = await announcedFailure(
      failedResponse(409, { error: 'account_offboarding_blocked' }),
    );

    expect(message).toMatch(/read-only/i);
    expect(message).not.toContain('account_offboarding_blocked');
  });

  it('an unrecognized error code falls back to the status sentence rather than leaking the code', async () => {
    const message = await announcedFailure(failedResponse(500, { error: 'kaboom_unmapped' }));

    // The fallback carries the status so a support conversation has a handle.
    expect(message).toContain('(500)');
    expect(message).not.toContain('kaboom_unmapped');
  });

  it('an invalid_address whose reason is unrecognized falls through instead of dead-ending', async () => {
    // Both lookups miss: `invalid_address` is absent from the error map because
    // its sentence is supposed to come from the lint map. A future lint reason
    // that ships server-side before this panel knows it must still say
    // something, not render an empty paragraph.
    const message = await announcedFailure(
      failedResponse(400, { error: 'invalid_address', reason: 'reason_from_a_newer_server' }),
    );

    expect(message).toContain('(400)');
    expect(message).not.toContain('reason_from_a_newer_server');
    expect(message.trim()).not.toBe('');
  });

  it('a body that is not JSON still produces a sentence', async () => {
    // The panel catches the parse and treats the body as `{}`; the status is
    // then the only thing it knows, and it has to be enough.
    const message = await announcedFailure({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    expect(message).toContain('(502)');
  });

  it('a transport failure is reported as a connection problem, not a silent no-op', async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SolicitationAddressPanel state={postalAddressState({ suggestion: SUGGESTION })} />);

    fireEvent.click(attestationCheckbox());
    fireEvent.click(submitButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/connection/i);
    // The button has to come back, or a flaky network strands the owner with a
    // permanently disabled control and an address they cannot save.
    await waitFor(() => expect(submitButton()).toBeEnabled());
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
