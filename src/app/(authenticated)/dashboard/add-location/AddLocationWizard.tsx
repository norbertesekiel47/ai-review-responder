'use client';

// src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx
//
// 4-step Add-location wizard client component.
//
// Steps:
//   1. Place autocomplete + display_label input
//   2. Google Business info (informational only, connect later from Settings)
//   3. Voice config (ToneChipPicker + ListEditor + copy-from-existing shortcut)
//   4. Confirm-and-pay with proration preview
//
// Validation contract: VAL-LOC-073 (wizard completes when Zernio skipped),
// VAL-SETTINGS-043 (display_label validation), VAL-SETTINGS-044 (duplicate
// Place ID rejected).

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

// NOTE: Step 2 (Zernio) is now informational only — the OAuth redirect
// that previously caused wizard state loss has been removed. Users connect
// Google Business post-creation from /dashboard/connect or Settings.
import { PlaceAutocomplete, type PlaceSelection } from '@/components/PlaceAutocomplete';
import { ToneChipPicker } from '@/components/dashboard/settings/ToneChipPicker';
import { ListEditor } from '@/components/dashboard/settings/ListEditor';
import { Icon } from '@/components/dashboard/Icon';
import { TopBar } from '@/components/dashboard/TopBar';
import type { BillingSnapshot } from '@/lib/accounts/quota';
import { useLocationScope } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';
import {
  computeNextLocationBillingPreview,
  computeProration,
} from './wizard/billing';
import { buildAddLocationPayload, hasStep1LocationDetails } from './wizard/payload';

// ── Types ──────────────────────────────────────────────────────────────────

interface Props {
  accountId: string;
  billingSnapshot: BillingSnapshot;
  activeLocationCount: number;
}

type WizardStep = 1 | 2 | 3 | 4;
type LocationInputMode = 'autocomplete' | 'url';

interface VoiceFormState {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

interface ExistingLocationVoice {
  locationId: string;
  displayName: string;
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

const STEP_INFO: Record<WizardStep, { title: string; subtitle: string }> = {
  1: { title: 'Add location', subtitle: 'Step 1 of 4 — Select location' },
  2: { title: 'Add location', subtitle: 'Step 2 of 4 — Google Business' },
  3: { title: 'Add location', subtitle: 'Step 3 of 4 — Voice config' },
  4: { title: 'Add location', subtitle: 'Step 4 of 4 — Confirm & pay' },
};

// ── Default voice config ──────────────────────────────────────────────────

const DEFAULT_VOICE: VoiceFormState = {
  tone: 'professional and friendly',
  productsServices: '',
  avoidFacts: [],
  sampleResponses: [],
};

// ── Component ──────────────────────────────────────────────────────────────

export function AddLocationWizard({
  accountId,
  billingSnapshot,
  activeLocationCount,
}: Props) {
  const router = useRouter();
  const { setLocationScope } = useLocationScope();

  // ── Step state ──────────────────────────────────────────────────────
  const [step, setStep] = useState<WizardStep>(1);

  // ── Step 1 state: Place selection + display_label ───────────────────
  const [inputMode, setInputMode] = useState<LocationInputMode>('autocomplete');
  const [placeSelection, setPlaceSelection] = useState<PlaceSelection | null>(null);
  const [googleMapsUrl, setGoogleMapsUrl] = useState('');
  const [displayLabel, setDisplayLabel] = useState('');
  const [displayLabelError, setDisplayLabelError] = useState<string | null>(null);
  const [placeIdDuplicateError, setPlaceIdDuplicateError] = useState<string | null>(null);

  // ── Step 2 state: Zernio (informational only, no OAuth redirect) ───

  // ── Step 3 state: Voice config ──────────────────────────────────────
  const [voiceForm, setVoiceForm] = useState<VoiceFormState>({ ...DEFAULT_VOICE });
  const [existingLocations, setExistingLocations] = useState<ExistingLocationVoice[]>([]);
  const [copyFromLocationId, setCopyFromLocationId] = useState<string>('');
  const [voiceLoading, setVoiceLoading] = useState(true);

  // ── Step 4 state: Submit ─────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Existing Place IDs for duplicate check ─────────────────────────
  const [existingPlaceIds, setExistingPlaceIds] = useState<Set<string>>(new Set());

  // ── Fetch existing location voice configs for "copy from" dropdown ──
  useEffect(() => {
    let cancelled = false;

    async function fetchVoiceConfigs() {
      try {
        const res = await fetch('/api/settings/voice');
        if (!res.ok) {
          setVoiceLoading(false);
          return;
        }
        const json = await res.json();
        if (cancelled) return;

        const locs: ExistingLocationVoice[] = (json.locations ?? []).map(
          (loc: any) => ({
            locationId: loc.locationId,
            displayName: loc.displayName,
            tone: loc.tone ?? '',
            productsServices: loc.productsServices ?? '',
            avoidFacts: loc.avoidFacts ?? [],
            sampleResponses: loc.sampleResponses ?? [],
          }),
        );
        setExistingLocations(locs);
      } catch {
        // Non-critical — "copy from" dropdown just won't populate
      } finally {
        if (!cancelled) setVoiceLoading(false);
      }
    }

    fetchVoiceConfigs();
    return () => { cancelled = true; };
  }, []);

  // ── Fetch existing Place IDs for duplicate check ───────────────────
  useEffect(() => {
    let cancelled = false;

    async function fetchExisting() {
      try {
        const res = await fetch('/api/locations/existing-place-ids');
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        if (json.placeIds) {
          setExistingPlaceIds(new Set(json.placeIds));
        }
      } catch {
        // Non-critical — duplicate check just won't be client-side
      }
    }
    fetchExisting();
    return () => { cancelled = true; };
  }, []);

  // ── Step 1 validation ───────────────────────────────────────────────

  const validateStep1 = useCallback((): boolean => {
    // VAL-SETTINGS-043: display_label must be non-empty and ≤ 255 chars
    if (!displayLabel.trim()) {
      setDisplayLabelError('Location name is required');
      return false;
    }
    if (displayLabel.trim().length > 255) {
      setDisplayLabelError('Location name must be 255 characters or less');
      return false;
    }
    setDisplayLabelError(null);

    // Location details are required
    if (!hasStep1LocationDetails({ inputMode, placeSelection, googleMapsUrl })) {
      return false; // No explicit error — the autocomplete UI makes this clear
    }

    // VAL-SETTINGS-044: Check for duplicate Place ID
    if (inputMode === 'autocomplete' && placeSelection?.placeId && existingPlaceIds.has(placeSelection.placeId)) {
      setPlaceIdDuplicateError('This location is already added');
      return false;
    }
    setPlaceIdDuplicateError(null);

    return true;
  }, [displayLabel, inputMode, placeSelection, googleMapsUrl, existingPlaceIds]);

  // ── Step navigation ──────────────────────────────────────────────────

  const goNext = useCallback(() => {
    if (step === 1 && !validateStep1()) return;
    setStep((s) => Math.min(s + 1, 4) as WizardStep);
  }, [step, validateStep1]);

  const goBack = useCallback(() => {
    setStep((s) => Math.max(s - 1, 1) as WizardStep);
  }, []);

  // ── Copy from existing location ─────────────────────────────────────

  const handleCopyFromExisting = useCallback(
    (locationId: string) => {
      setCopyFromLocationId(locationId);
      if (!locationId) return; // "None" selected

      const source = existingLocations.find((l) => l.locationId === locationId);
      if (!source) return;

      setVoiceForm({
        tone: source.tone,
        productsServices: source.productsServices,
        avoidFacts: source.avoidFacts.slice(),
        sampleResponses: source.sampleResponses.slice(),
      });
    },
    [existingLocations],
  );

  // ── Voice form setter ───────────────────────────────────────────────

  const setVoiceField = useCallback(
    <K extends keyof VoiceFormState>(key: K, value: VoiceFormState[K]) => {
      setVoiceForm((prev) => ({ ...prev, [key]: value }));
      // Clear the copy-from indicator since user is manually editing
      setCopyFromLocationId('');
    },
    [],
  );

  // ── Step 2: Zernio is informational only (no in-wizard OAuth) ───────
  // Connection is deferred to post-creation via /dashboard/connect

  // ── Step 4: Submit ──────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch('/api/locations/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAddLocationPayload({
          accountId,
          displayLabel,
          inputMode,
          placeSelection,
          // Helper omits unused optional fields so the API receives either
          // a verified Place ID or a manual Google Maps URL.
          googleMapsUrl,
          voiceForm,
        })),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // VAL-LOC-064: Show inline error, stay on step 4
        setSubmitError(body.error ?? body.detail ?? `Failed to add location (${res.status})`);
        setSubmitting(false);
        return;
      }

      const result = await res.json();

      // Set the newly created location as the active scope
      // VAL-SETTINGS-047: Cookie set with SameSite=Lax, path=/
      if (result.businessId) {
        setLocationScope(result.businessId as LocationId);
      }

      // Navigate straight to the scoped connect flow for the new location.
      const connectHref = result.businessId
        ? `/dashboard/connect?locationId=${encodeURIComponent(result.businessId)}`
        : '/dashboard/connect';
      router.push(connectHref);
      router.refresh();
    } catch {
      setSubmitError('Network error — please try again.');
      setSubmitting(false);
    }
  }, [accountId, displayLabel, inputMode, placeSelection, googleMapsUrl, voiceForm, router, setLocationScope]);

  // ── Computed billing for step 4 ────────────────────────────────────

  const billingPreview = computeNextLocationBillingPreview({
    activeLocationCount,
    billingSnapshot,
  });
  const proration = computeProration(
    billingPreview.additionalLocationMonthlyCents,
  );
  const newMonthlyTotalCents = billingPreview.newMonthlyTotalCents;
  const step1HasLocationDetails = hasStep1LocationDetails({
    inputMode,
    placeSelection,
    googleMapsUrl,
  });

  // ── TopBar info for current step ────────────────────────────────────
  const stepInfo = STEP_INFO[step];

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <>
      <TopBar
        title={stepInfo.title}
        subtitle={stepInfo.subtitle}
        rightLink={{ href: '/dashboard', label: 'Cancel' }}
      />
      <div className="wizard-container">
        {/* Step indicator */}
        <div className="wizard-steps">
          {([1, 2, 3, 4] as WizardStep[]).map((s) => (
            <div
              key={s}
              className={`wizard-step-dot ${s === step ? 'active' : ''} ${s < step ? 'done' : ''}`}
            >
              <span className="wizard-step-num">{s}</span>
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {/* ── Step 1: Place Autocomplete ─────────────────────────────── */}
          {step === 1 && (
            <div className="wizard-panel">
              <h2 className="wizard-title">Select your business location</h2>
              <p className="wizard-desc">
                Search for your business on Google. We&apos;ll use this to connect
                your Google Business Profile and import reviews.
              </p>

              <div className="field" style={{ marginTop: 20 }}>
                <label className="field-label" htmlFor="display-label">
                  Location name
                </label>
                <input
                  id="display-label"
                  className={`input ${displayLabelError ? 'input-error' : ''}`}
                  value={displayLabel}
                  onChange={(e) => {
                    setDisplayLabel(e.target.value);
                    setDisplayLabelError(null);
                  }}
                  placeholder="e.g. Downtown Cafe"
                  maxLength={255}
                  autoFocus
                />
                {displayLabelError && (
                  <p className="field-error">{displayLabelError}</p>
                )}
                <div className="field-counter">{displayLabel.length}/255</div>
              </div>

              <div className="field" style={{ marginTop: 16 }}>
                <label className="field-label">Business address</label>
                {inputMode === 'autocomplete' ? (
                  <PlaceAutocomplete
                    onPlaceSelect={(selection) => {
                      setPlaceSelection(selection);
                      setGoogleMapsUrl('');
                      setPlaceIdDuplicateError(null);
                      // Auto-fill display label from address if empty
                      if (!displayLabel.trim()) {
                        const shortName = selection.formattedAddress.split(',')[0]?.trim() ?? '';
                        setDisplayLabel(shortName);
                      }
                    }}
                    onClear={() => setPlaceSelection(null)}
                    placeholder="Search for your business..."
                  />
                ) : (
                  <input
                    className="input"
                    type="url"
                    value={googleMapsUrl}
                    onChange={(e) => setGoogleMapsUrl(e.target.value)}
                    placeholder="https://maps.google.com/..."
                    autoComplete="url"
                  />
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setPlaceIdDuplicateError(null);
                    if (inputMode === 'autocomplete') {
                      setPlaceSelection(null);
                      setInputMode('url');
                    } else {
                      setGoogleMapsUrl('');
                      setInputMode('autocomplete');
                    }
                  }}
                  style={{ marginTop: 8, fontSize: 12, padding: '6px 10px' }}
                >
                  {inputMode === 'autocomplete' ? 'Paste Google Maps URL' : 'Use Google search'}
                </button>
                {placeIdDuplicateError && (
                  <p className="field-error" style={{ marginTop: 4 }}>
                    {placeIdDuplicateError}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ── Step 2: Zernio (informational only) ────────────────────── */}
          {step === 2 && (
            <div className="wizard-panel">
              <h2 className="wizard-title">Google Business Profile</h2>
              <p className="wizard-desc">
                After adding your location, you can connect your Google Business
                Profile to automatically publish approved responses and import
                reviews. This can be done at any time from Settings.
              </p>

              <div className="wizard-info-box" style={{ marginTop: 20 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <Icon name="google" size={20} />
                  <div>
                    <p style={{ fontWeight: 500, marginBottom: 4 }}>
                      Connect later from Settings
                    </p>
                    <p style={{ color: '#6B7280', fontSize: 14 }}>
                      After creating your location, go to{' '}
                      <Link
                        href="/dashboard/connect"
                        style={{ color: 'var(--color-teal-500, #0D9488)', textDecoration: 'underline' }}
                      >
                        Connect
                      </Link>{' '}
                      or Settings → Locations to link your Google Business
                      Profile and start importing reviews.
                    </p>
                  </div>
                </div>
              </div>

              {/* Continue to Step 3 */}
              <button
                type="button"
                className="btn btn-primary"
                onClick={goNext}
                style={{ marginTop: 20, width: '100%' }}
              >
                Continue <Icon name="chevron-down" size={14} style={{ transform: 'rotate(-90deg)' }} />
              </button>
            </div>
          )}

          {/* ── Step 3: Voice Config ───────────────────────────────────── */}
          {step === 3 && (
            <div className="wizard-panel">
              <h2 className="wizard-title">Configure your voice</h2>
              <p className="wizard-desc">
                Set how RepWorth writes replies for this location. You can copy
                settings from an existing location or customize from scratch.
              </p>

              {/* Copy from existing location dropdown */}
              {existingLocations.length > 0 && (
                <div className="field" style={{ marginTop: 16, marginBottom: 20 }}>
                  <label className="field-label" htmlFor="copy-from">
                    Copy from existing location
                  </label>
                  <select
                    id="copy-from"
                    className="select"
                    value={copyFromLocationId}
                    onChange={(e) => handleCopyFromExisting(e.target.value)}
                  >
                    <option value="">Customize manually</option>
                    {existingLocations.map((loc) => (
                      <option key={loc.locationId} value={loc.locationId}>
                        {loc.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {voiceLoading ? (
                <p style={{ color: '#6B7280' }}>Loading voice settings…</p>
              ) : (
                <>
                  {/* Tone chip picker */}
                  <div className="set-section" style={{ marginBottom: 20 }}>
                    <ToneChipPicker
                      tone={voiceForm.tone}
                      onChange={(v) => setVoiceField('tone', v)}
                    />
                  </div>

                  {/* Products & services */}
                  <div className="set-section" style={{ marginBottom: 20 }}>
                    <div className="set-section-head">
                      <div className="set-section-icon sage">
                        <Icon name="lightbulb" size={18} />
                      </div>
                      <div>
                        <div className="set-section-title">Products &amp; services</div>
                        <div className="set-section-sub">
                          A short description so we know what to highlight.
                        </div>
                      </div>
                    </div>
                    <div className="field">
                      <textarea
                        className="textarea textarea-tall"
                        maxLength={2000}
                        value={voiceForm.productsServices}
                        onChange={(e) => setVoiceField('productsServices', e.target.value)}
                      />
                      <div className="field-counter">
                        {voiceForm.productsServices.length}/2000
                      </div>
                    </div>
                  </div>

                  {/* Things to avoid */}
                  <div className="set-section" style={{ marginBottom: 20 }}>
                    <div className="set-section-head">
                      <div className="set-section-icon rose">
                        <Icon name="alert" size={18} />
                      </div>
                      <div>
                        <div className="set-section-title">Things to avoid</div>
                        <div className="set-section-sub">
                          Topics or claims we shouldn&apos;t mention in replies.
                        </div>
                      </div>
                    </div>
                    <ListEditor
                      items={voiceForm.avoidFacts}
                      onChange={(v) => setVoiceField('avoidFacts', v)}
                      placeholder="e.g. We never discount on weekends"
                      addLabel="Add another"
                      maxItems={20}
                      maxLength={500}
                    />
                  </div>

                  {/* Sample replies */}
                  <div className="set-section">
                    <div className="set-section-head">
                      <div className="set-section-icon amber">
                        <Icon name="edit" size={18} />
                      </div>
                      <div>
                        <div className="set-section-title">Sample replies</div>
                        <div className="set-section-sub">
                          Your own past replies — the more we have, the more
                          &quot;you&quot; we sound.
                        </div>
                      </div>
                    </div>
                    <ListEditor
                      items={voiceForm.sampleResponses}
                      onChange={(v) => setVoiceField('sampleResponses', v)}
                      placeholder="Paste a reply you're proud of"
                      addLabel="Add another"
                      maxItems={10}
                      maxLength={2000}
                    />
                  </div>
                </>
              )}

              {/* Step 3 is optional — can skip with defaults */}
              <button
                type="button"
                className="btn btn-secondary wizard-skip-btn"
                onClick={goNext}
                style={{ marginTop: 20, width: '100%' }}
              >
                Use defaults and continue
              </button>
            </div>
          )}

          {/* ── Step 4: Confirm & Pay ──────────────────────────────────── */}
          {step === 4 && (
            <div className="wizard-panel">
              <h2 className="wizard-title">Confirm &amp; pay</h2>
              <p className="wizard-desc">
                Review your new location details. Adding a location will update
                your monthly bill.
              </p>

              {submitError && (
                <div className="wizard-error">{submitError}</div>
              )}

              {/* Summary */}
              <div className="wizard-summary">
                <div className="wizard-summary-row">
                  <span className="wizard-summary-label">Location name</span>
                  <span className="wizard-summary-value">{displayLabel.trim()}</span>
                </div>
                {placeSelection && (
                  <div className="wizard-summary-row">
                    <span className="wizard-summary-label">Address</span>
                    <span className="wizard-summary-value">
                      {placeSelection.formattedAddress}
                    </span>
                  </div>
                )}
                {!placeSelection && inputMode === 'url' && googleMapsUrl.trim() && (
                  <div className="wizard-summary-row">
                    <span className="wizard-summary-label">Google Maps URL</span>
                    <span className="wizard-summary-value">
                      {googleMapsUrl.trim()}
                    </span>
                  </div>
                )}
                <div className="wizard-summary-row">
                  <span className="wizard-summary-label">Google Business</span>
                  <span className="wizard-summary-value">
                    Connect later from Settings
                  </span>
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

              {/* Billing breakdown */}
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

                {/* Proration line — VAL-LOC-066 */}
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
                onClick={handleSubmit}
                disabled={submitting}
                style={{ marginTop: 24, width: '100%' }}
              >
                {submitting ? (
                  <>
                    <span className="spinner" /> Adding location…
                  </>
                ) : (
                  <>
                    <Icon name="check" size={14} /> Confirm &amp; add location
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Step navigation */}
        <div className="wizard-nav">
          {step > 1 && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={goBack}
            >
              <Icon name="chevron-down" size={14} style={{ transform: 'rotate(90deg)' }} /> Back
            </button>
          )}
          <div className="wizard-nav-spacer" />
          {step < 4 && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={goNext}
              disabled={step === 1 && !step1HasLocationDetails}
            >
              Continue <Icon name="chevron-down" size={14} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
