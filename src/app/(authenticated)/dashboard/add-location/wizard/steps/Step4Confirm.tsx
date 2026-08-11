'use client';

// Step 4 — Confirm & pay with proration preview.

import { Icon } from '@/components/dashboard/shell/Icon';
import type { PlaceSelection } from '@/components/places/PlaceAutocomplete';
import type { BillingSnapshot } from '@/lib/accounts/quota';
import type { NextLocationBillingPreview, ProrationResult } from '../billing';
import type { ExistingLocationVoice, LocationInputMode } from '../types';

interface Step4ConfirmProps {
  displayLabel: string;
  placeSelection: PlaceSelection | null;
  inputMode: LocationInputMode;
  googleMapsUrl: string;
  copyFromLocationId: string;
  existingLocations: ExistingLocationVoice[];
  billingSnapshot: BillingSnapshot;
  billingPreview: NextLocationBillingPreview;
  proration: ProrationResult;
  newMonthlyTotalCents: number;
  submitting: boolean;
  /** Terminal success — the location exists and the redirect has been issued. */
  submitted: boolean;
  /** Connect-flow route for the created location; the manual escape hatch if
   * the redirect never lands (#781). */
  connectHref: string | null;
  submitError: string | null;
  onSubmit: () => void;
}

/**
 * Terminal success notice (#781). Rendered from the API result, not from a
 * completed navigation — so a redirect that never lands leaves the owner with a
 * confirmation and a working link rather than a spinner. Kept a separate
 * component so its branch stays out of Step4Confirm's complexity budget.
 */
function LocationAddedNotice({ connectHref }: { connectHref: string | null }) {
  return (
    <div className="wizard-success" role="status">
      <Icon name="check" size={14} />
      <span>
        Location added — taking you to setup.{' '}
        {connectHref && (
          <a className="wizard-inline-link" href={connectHref}>
            Continue now
          </a>
        )}
      </span>
    </div>
  );
}

export function Step4Confirm({
  displayLabel,
  placeSelection,
  inputMode,
  googleMapsUrl,
  copyFromLocationId,
  existingLocations,
  billingSnapshot,
  billingPreview,
  proration,
  newMonthlyTotalCents,
  submitting,
  submitted,
  connectHref,
  submitError,
  onSubmit,
}: Step4ConfirmProps) {
  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Confirm &amp; pay</h2>
      <p className="wizard-desc">
        Review your new location details. Adding a location will update
        your monthly bill.
      </p>

      {submitError && <div className="wizard-error">{submitError}</div>}

      {submitted && <LocationAddedNotice connectHref={connectHref} />}

      <div className="wizard-summary">
        <div className="wizard-summary-row">
          <span className="wizard-summary-label">Location name</span>
          <span className="wizard-summary-value">{displayLabel.trim()}</span>
        </div>
        {placeSelection && (
          <div className="wizard-summary-row">
            <span className="wizard-summary-label">Address</span>
            <span className="wizard-summary-value">{placeSelection.formattedAddress}</span>
          </div>
        )}
        {!placeSelection && inputMode === 'url' && googleMapsUrl.trim() && (
          <div className="wizard-summary-row">
            <span className="wizard-summary-label">Google Maps URL</span>
            <span className="wizard-summary-value">{googleMapsUrl.trim()}</span>
          </div>
        )}
        <div className="wizard-summary-row">
          <span className="wizard-summary-label">Google Business</span>
          <span className="wizard-summary-value">Connect later from Settings</span>
        </div>
        <div className="wizard-summary-row">
          <span className="wizard-summary-label">Voice config</span>
          <span className="wizard-summary-value">
            {copyFromLocationId
              ? `Copied from ${existingLocations.find((l) => l.locationId === copyFromLocationId)?.displayName ?? 'existing location'}`
              : 'Customized'}
          </span>
        </div>
      </div>

      <div className="wizard-billing">
        <h3 className="wizard-billing-title">Billing summary</h3>

        <div className="wizard-billing-row">
          <span>Current monthly total</span>
          <span>${(billingSnapshot.totalCents / 100).toFixed(2)}/mo</span>
        </div>

        <div className="wizard-billing-row">
          <span>
            + Additional location
            {billingPreview.additionalLocationMonthlyCents > 0 && (
              <span className="wizard-billing-note">
                {' '}(${(billingPreview.additionalLocationMonthlyCents / 100).toFixed(2)}/mo)
              </span>
            )}
          </span>
          <span>
            {billingPreview.additionalLocationMonthlyCents > 0
              ? `$${(billingPreview.additionalLocationMonthlyCents / 100).toFixed(2)}/mo`
              : 'Included'}
          </span>
        </div>

        {billingPreview.additionalLocationMonthlyCents > 0 && proration.daysRemaining > 0 && (
          <div className="wizard-billing-row wizard-billing-proration">
            <span>
              Prorated charge today
              <span className="wizard-billing-note">
                {' '}({proration.daysRemaining} of {proration.daysInMonth} days remaining)
              </span>
            </span>
            <span>${(proration.prorationCents / 100).toFixed(2)}</span>
          </div>
        )}

        <div className="wizard-billing-divider" />

        <div className="wizard-billing-row wizard-billing-total">
          <span>New monthly total</span>
          <span>${(newMonthlyTotalCents / 100).toFixed(2)}/mo</span>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary wizard-submit-btn"
        onClick={onSubmit}
        // Stays disabled after success too: the location already exists, so a
        // second click would only add a duplicate.
        disabled={submitting || submitted}
        style={{ marginTop: 24, width: '100%' }}
      >
        {submitting ? (
          <>
            <span className="spinner" /> Adding location…
          </>
        ) : submitted ? (
          'Location added'
        ) : (
          <>
            <Icon name="check" size={14} /> Confirm &amp; add location
          </>
        )}
      </button>
    </div>
  );
}
