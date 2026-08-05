'use client';

// src/components/dashboard/settings/SolicitationAddressPanel.tsx
//
// The owner-facing Attested postal address surface (#656; spec
// docs/superpowers/specs/2026-07-28-sender-deliverability-design.md §7.5).
// A SIBLING of ProfilePanel, never an edit to it (deviations D3): its state
// arrives as a prop that the server component already fetched for the
// cookie-resolved active location, so nothing here widens the shared
// /api/settings payload or useSettingsForm for one panel's data.
//
// Three behaviours are load-bearing rather than cosmetic:
//
//  1. google_place_address is offered as an editable SUGGESTION and is never
//     submitted on its own. It is Google's `formattedAddress` — it can be a
//     service-area value, is not owner-attested, and cannot express a
//     USPS-registered PO box. A prefill that saved itself would be Google's
//     string masquerading as an owner attestation.
//
//  2. Submitting requires the attestation checkbox, whose label is
//     POSTAL_ADDRESS_ATTESTATION_TEXT read from the domain module. The wording
//     is versioned and stored on the attested row, so a copy of it living here
//     would let the record and the thing the owner actually agreed to drift
//     apart while both still looked right.
//
//  3. Editing clears the checkbox. An edit IS a re-attestation — the UI half of
//     migration 099's digest CHECK, which binds the attestation to the stored
//     bytes. A tick collected against one address never authorizes another.
//
// The write goes to the dedicated PUT /api/settings/postal-address route, which
// owns auth, the offboarding block and the lint. This panel renders whatever
// lint reason comes back; it never re-derives the rule (there is exactly one
// author of what a valid address is).

import { useState } from 'react';
import { Icon } from '@/components/dashboard/shell/Icon';
import { LiveRegion } from '@/components/ui/LiveRegion';
import {
  POSTAL_ADDRESS_ATTESTATION_TEXT,
  POSTAL_ADDRESS_ATTESTATION_VERSION,
  type PostalAddressLintReason,
  type PostalAddressState,
} from '@/lib/solicitation/postal-address';

const MAX_ADDRESS_LENGTH = 500;

/**
 * Single owner of the lint-reason → owner-facing sentence mapping. The reason
 * codes are the module's; the prose is this surface's, and it explains the fix
 * rather than restating the rule.
 */
const LINT_MESSAGES: Record<PostalAddressLintReason, string> = {
  empty: 'Enter the postal address you want printed in review requests.',
  single_line:
    'Add a second line. A single line such as "Austin, TX, USA" is a service area, not somewhere mail arrives.',
  no_postal_code: 'The last line needs a ZIP code so the address is deliverable.',
};

const ERROR_MESSAGES: Record<string, string> = {
  actor_not_in_account: 'Your account no longer has permission to change this address.',
  business_not_found: 'This location is no longer available. Reload the page and try again.',
  account_offboarding_blocked: 'Settings are read-only while your account is being closed.',
  invalid_request: 'That address could not be submitted. Reload the page and try again.',
};

interface ErrorBody {
  error?: unknown;
  reason?: unknown;
}

/** Maps the route's error body onto one sentence. Never surfaces a raw code. */
function messageForFailure(body: ErrorBody, status: number): string {
  if (body.error === 'invalid_address' && typeof body.reason === 'string') {
    const lintMessage = LINT_MESSAGES[body.reason as PostalAddressLintReason];
    if (lintMessage !== undefined) return lintMessage;
  }
  if (typeof body.error === 'string') {
    const mapped = ERROR_MESSAGES[body.error];
    if (mapped !== undefined) return mapped;
  }
  return `The address could not be saved (${status}). Please try again.`;
}

function formatAttestedOn(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface Props {
  /** Server-fetched for the active location; this panel never fetches it. */
  state: PostalAddressState;
}

export function SolicitationAddressPanel({ state }: Props) {
  // The suggestion seeds the field but is not a saved value: `attestedAt` stays
  // null until a write lands, so the pill and the hint both keep telling the
  // truth about what is stored.
  const [address, setAddress] = useState<string>(state.address ?? state.suggestion ?? '');
  const [attested, setAttested] = useState(false);
  const [attestedAt, setAttestedAt] = useState<string | null>(state.attestedAt);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const isStored = attestedAt !== null;
  const showingSuggestion = !isStored && state.suggestion !== null;
  const canSubmit = attested && address.trim() !== '' && !saving;

  const onAddressChange = (next: string) => {
    setAddress(next);
    // Re-arm the requirement: the tick covered the previous bytes.
    setAttested(false);
    setConfirmation(null);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setFailure(null);
    setConfirmation(null);
    try {
      const res = await fetch('/api/settings/postal-address', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          attestationVersion: POSTAL_ADDRESS_ATTESTATION_VERSION,
          attested: true,
        }),
      });
      const body: ErrorBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFailure(messageForFailure(body, res.status));
        return;
      }
      setAttestedAt(new Date().toISOString());
      setConfirmation('Address attested. Review requests for this location will print it.');
      // The tick is consumed by the write it authorized; the next edit collects
      // a fresh one, and until then there is nothing to submit.
      setAttested(false);
    } catch {
      setFailure('The address could not be saved. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const attestedOn = attestedAt === null ? null : formatAttestedOn(attestedAt);

  return (
    <div className="set-section" id="sender-postal-address">
      <div className="set-section-head">
        <div className="set-section-icon sage" aria-hidden>
          <Icon name="location" size={18} />
        </div>
        <div style={{ flex: 1 }}>
          <div className="set-section-title">Sender postal address</div>
          <div className="set-section-sub">
            Printed at the foot of every review request we send for this location, exactly as you
            write it. Required by law before requests can go out.
          </div>
        </div>
        {attestedOn !== null && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--rw-sage-deep)',
              background: 'var(--rw-sage-soft)',
              padding: '2px 8px',
              borderRadius: 999,
            }}
          >
            Attested {attestedOn}
          </span>
        )}
      </div>

      <div className="field">
        <label className="field-label" htmlFor="solicitation-postal-address">
          Postal address
        </label>
        <textarea
          id="solicitation-postal-address"
          className="textarea"
          value={address}
          maxLength={MAX_ADDRESS_LENGTH}
          disabled={saving}
          aria-describedby="solicitation-postal-address-hint"
          onChange={(e) => onAddressChange(e.target.value)}
        />
        <div className="field-hint" id="solicitation-postal-address-hint">
          {showingSuggestion
            ? 'Prefilled from your Google listing so you can check it. Nothing is saved until you attest below, and a listing address is sometimes a service area rather than a place that receives mail.'
            : 'Street on the first line, then city, state and ZIP. A PO box registered with USPS is fine.'}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          background: 'var(--rw-recess)',
          border: '1px solid var(--rw-hair-2)',
          borderRadius: 'var(--rw-radius-md)',
          padding: '12px 14px',
        }}
      >
        <input
          id="solicitation-postal-attestation"
          type="checkbox"
          checked={attested}
          disabled={saving}
          onChange={(e) => setAttested(e.target.checked)}
          style={{ marginTop: 2, accentColor: 'var(--rw-sage-deep)' }}
        />
        <label
          htmlFor="solicitation-postal-attestation"
          data-testid="postal-address-attestation-label"
          style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--rw-app-text)' }}
        >
          {POSTAL_ADDRESS_ATTESTATION_TEXT}
        </label>
      </div>

      {failure !== null && (
        <p style={{ fontSize: 13, color: 'var(--rw-danger)', margin: '10px 0 0' }}>{failure}</p>
      )}
      {confirmation !== null && (
        <p style={{ fontSize: 13, color: 'var(--rw-sage-deep)', margin: '10px 0 0' }}>
          {confirmation}
        </p>
      )}
      <LiveRegion
        message={failure ?? confirmation ?? ''}
        level={failure !== null ? 'assertive' : 'polite'}
      />

      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 12 }}
        disabled={!canSubmit}
        onClick={submit}
      >
        {saving ? 'Saving…' : isStored ? 'Save and re-attest' : 'Save and attest'}
      </button>
    </div>
  );
}
