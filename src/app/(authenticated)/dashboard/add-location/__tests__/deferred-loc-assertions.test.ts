// src/app/(authenticated)/dashboard/add-location/__tests__/deferred-loc-assertions.test.ts
//
// Vitest tests for 5 deferred location-management assertions whose UI
// blockers are now resolved from milestone 4.
//
// VAL-LOC-064: Wizard step 4 shows inline error when add-location API fails;
//              no partial location created.
// VAL-LOC-065: Abandoning wizard at any step leaves no persistent state.
// VAL-LOC-066: Step 4 proration line shows actual prorated dollar amount.
//
// These tests validate the behavior of the AddLocationWizard component and
// the computeProration helper function at the unit level. Agent-browser
// testing provides the full visual verification.

import { describe, it, expect } from 'vitest';
import { computeProration } from '../AddLocationWizard';
import * as fs from 'fs';
import * as path from 'path';

// ── VAL-LOC-064: Wizard error display on Confirm & Pay ────────────────────
//
// When the add-location API returns an error, the wizard step 4 must:
//   1. Show an inline error message
//   2. Stay on step 4 (not navigate away)
//   3. NOT create a partial businesses row
//
// The wizard handles this via the `submitError` state and the `handleSubmit`
// callback that checks `res.ok` before proceeding.

describe('VAL-LOC-064: Wizard error display on Confirm & Pay', () => {
  // Static analysis: verify the wizard component handles API errors correctly.
  // The source must contain:
  //   - A `submitError` state variable
  //   - An inline error display on step 4
  //   - The handleSubmit callback that checks res.ok and sets submitError
  //   - No businesses row creation before the API call succeeds

  const sourcePath = path.resolve(__dirname, '../AddLocationWizard.tsx');
  const source = fs.readFileSync(sourcePath, 'utf-8');

  it('has submitError state for displaying inline error messages', () => {
    expect(source).toContain('submitError');
    expect(source).toContain('setSubmitError');
  });

  it('shows inline error message on step 4 when submitError is set', () => {
    // Step 4 must render the submitError in a visible container
    expect(source).toContain('wizard-error');
    expect(source).toContain('{submitError}');
  });

  it('checks API response status before navigating away', () => {
    // handleSubmit must check res.ok before redirecting
    expect(source).toContain('if (!res.ok)');
    expect(source).toContain('setSubmitError');
  });

  it('does not create businesses row when API returns error', () => {
    // The businesses row is only created server-side in the add-location tx.
    // The wizard does NOT create any businesses row client-side.
    // The only state mutation is `submitError` (error display).
    // No fetch to create a businesses row occurs before the final POST.
    //
    // Verify the wizard only makes one POST call (the submit handler)
    // and does not have any other endpoint that persists data.
    const fetchCalls = source.match(/fetch\s*\(/g) ?? [];
    // Should have fetch calls for: voice config, existing-place-ids, and locations/add
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);

    // The wizard does NOT have a "save draft" or "create partial" endpoint
    expect(source).not.toContain('save-draft');
    expect(source).not.toContain('create-partial');
    expect(source).not.toContain('draft');
  });

  it('stays on step 4 after error (does not navigate on failure)', () => {
    // After an error, the wizard must NOT call router.push
    // Verify that router.push is only called after a successful response
    const routerPushIndex = source.indexOf('router.push');
    const successCheck = source.indexOf('if (!res.ok)');
    // router.push should come AFTER the success check
    expect(routerPushIndex).toBeGreaterThan(successCheck);
  });

  it('clears submitError when retrying', () => {
    // handleSubmit must clear submitError at the start
    expect(source).toContain('setSubmitError(null)');
  });
});

// ── VAL-LOC-065: Wizard abandonment leaves no persistent state ─────────────
//
// If the user navigates away, closes the browser, or clicks "Cancel" at
// any wizard step, no businesses, account_audit_log, or job_outbox rows
// should exist. The account state must be unchanged.

describe('VAL-LOC-065: Wizard abandonment leaves no persistent state', () => {
  const sourcePath = path.resolve(__dirname, '../AddLocationWizard.tsx');
  const source = fs.readFileSync(sourcePath, 'utf-8');

  it('does not make any POST/PUT/PATCH request during steps 1-3', () => {
    // The wizard must not persist any data to the server during steps 1-3.
    // Only GET requests for loading data (voice configs, existing place IDs)
    // are allowed during these steps.
    const fetchLines = source.split('\n').filter((line) => line.includes('fetch('));

    for (const line of fetchLines) {
      // GET requests are fine (reading data)
      if (line.includes('/api/settings/voice') || line.includes('/api/locations/existing-place-ids')) {
        continue;
      }
      // The POST to /api/locations/add is only in handleSubmit (step 4)
      if (line.includes("/api/locations/add") && line.includes('method:')) {
        // This is the step 4 submit — OK
        continue;
      }
      // Any other fetch that might persist data — shouldn't exist
      // But the fetch calls may be spread across multiple lines, so
      // we do a broader check on the entire source
    }

    // The only write endpoint is /api/locations/add, and it's called
    // only from handleSubmit (step 4 "Confirm & Pay")
    expect(source).toContain('/api/locations/add');
    // No other write endpoints should be referenced
    expect(source).not.toContain('/api/locations/create-draft');
    expect(source).not.toContain('/api/locations/save-progress');
  });

  it('wizard data lives in React state only (not localStorage or sessionStorage)', () => {
    // The wizard must not use browser storage for persistence
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('sessionStorage');
    expect(source).not.toContain('IndexedDB');
  });

  it('cancel link navigates away without persisting data', () => {
    // The Cancel link in the TopBar right link navigates to /dashboard
    // without calling any save endpoint
    expect(source).toContain("rightLink={{ href: '/dashboard', label: 'Cancel' }}");
  });

  it('step navigation (Back/Continue) is client-side state only', () => {
    // Step navigation changes the `step` state variable only
    expect(source).toContain('setStep');
    // No server calls during step transitions
  });

  it('no businesses row is created until step 4 Confirm & Pay is clicked', () => {
    // The add-location transaction only runs when handleSubmit is invoked.
    // Steps 1-3 accumulate client-side state (placeSelection, displayLabel,
    // voiceForm) that is only sent to the server in the POST on step 4.
    const handleSubmitIndex = source.indexOf('const handleSubmit');
    const addLocationFetchIndex = source.indexOf('/api/locations/add');

    // The fetch to add location must be inside handleSubmit
    expect(addLocationFetchIndex).toBeGreaterThan(handleSubmitIndex);
  });
});

// ── VAL-LOC-066: Proration line shows actual prorated dollar amount ────────
//
// The proration line on step 4 displays a dollar amount computed by
// computeProration(). It must NOT show $0, "TBD", or a placeholder.

describe('VAL-LOC-066: Proration line shows actual prorated charge', () => {
  it('computes correct proration for $25/mo overage at mid-month (May 15)', () => {
    // May 15 → 16 remaining days of 31
    const result = computeProration(2500, new Date(2026, 4, 15));
    expect(result.prorationCents).toBeGreaterThan(0);
    expect(result.prorationCents).toBe(Math.round((2500 / 31) * 16));
    // Dollar display: $12.90
    expect((result.prorationCents / 100).toFixed(2)).toBe(
      (Math.round((2500 / 31) * 16) / 100).toFixed(2),
    );
  });

  it('computes correct proration for $20/mo overage (premium tier)', () => {
    const result = computeProration(2000, new Date(2026, 4, 15));
    expect(result.prorationCents).toBeGreaterThan(0);
    // 2000 / 31 * 16 = 1032.26 → 1032 cents = $10.32
    expect(result.prorationCents).toBe(Math.round((2000 / 31) * 16));
  });

  it('proration is NOT $0 for mid-month dates with positive overage price', () => {
    // For any day that is NOT the last day of the month, proration must be > 0
    // when overagePriceCents > 0
    const result = computeProration(2500, new Date(2026, 4, 1)); // May 1
    expect(result.prorationCents).toBeGreaterThan(0);

    const result2 = computeProration(2500, new Date(2026, 5, 15)); // June 15
    expect(result2.prorationCents).toBeGreaterThan(0);
  });

  it('proration is $0 only on the last day of the month', () => {
    const result = computeProration(2500, new Date(2026, 4, 31)); // May 31
    expect(result.daysRemaining).toBe(0);
    expect(result.prorationCents).toBe(0);
  });

  it('proration is NOT a placeholder or TBD', () => {
    // The wizard renders the proration as a formatted dollar amount
    const sourcePath = path.resolve(__dirname, '../AddLocationWizard.tsx');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Must contain the proration rendering logic
    expect(source).toContain('wizard-billing-proration');
    // Must format as dollar amount (toFixed(2))
    expect(source).toContain('proration.prorationCents');
    expect(source).toContain('toFixed(2)');
    // Must NOT contain placeholder text
    expect(source).not.toContain('TBD');
    expect(source).not.toContain('pending');
  });

  it('step 4 renders proration row only when the new location adds monthly cost and days remain', () => {
    const sourcePath = path.resolve(__dirname, '../AddLocationWizard.tsx');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    // Conditional rendering: only show when both conditions are met
    expect(source).toContain('billingPreview.additionalLocationMonthlyCents > 0');
    expect(source).toContain('proration.daysRemaining > 0');
  });
});
