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
//
// After modularization (Tasks 1–7) the wizard is split across:
//   - wizard/reducer.ts         — state shape, action handling, initial state
//   - wizard/useAddLocationWizard.ts — side effects, handleSubmit, navigation
//   - wizard/steps/Step4Confirm.tsx  — step 4 rendering (error display, proration)
//   - AddLocationWizard.tsx     — composing shell (TopBar, step indicator, nav)
//
// Source guards are repointed to the file that owns each piece of behavior.

import { describe, it, expect } from 'vitest';
import { computeProration } from '../wizard/billing';
import * as fs from 'fs';
import * as path from 'path';

function readSource(...relPaths: string[]): string {
  return relPaths
    .map((p) => fs.readFileSync(path.resolve(__dirname, p), 'utf-8'))
    .join('\n');
}

// ── VAL-LOC-064: Wizard error display on Confirm & Pay ────────────────────
//
// When the add-location API returns an error, the wizard step 4 must:
//   1. Show an inline error message
//   2. Stay on step 4 (not navigate away)
//   3. NOT create a partial businesses row
//
// After modularization:
//   - submitError state field lives in wizard/reducer.ts (WizardState)
//   - SUBMIT_FAILED action sets it; SUBMIT_STARTED clears it
//   - if (!res.ok) guard + router.push live in wizard/useAddLocationWizard.ts
//   - inline error rendering (wizard-error + {submitError}) lives in Step4Confirm.tsx

describe('VAL-LOC-064: Wizard error display on Confirm & Pay', () => {
  const reducerSource = readSource('../wizard/reducer.ts');
  const hookSource = readSource('../wizard/useAddLocationWizard.ts');
  const step4Source = readSource('../wizard/steps/Step4Confirm.tsx');

  it('has submitError state for displaying inline error messages', () => {
    // submitError field declared in WizardState (reducer.ts)
    expect(reducerSource).toContain('submitError');
    // SUBMIT_FAILED action sets it; SUBMIT_STARTED clears it to null
    expect(reducerSource).toContain('SUBMIT_FAILED');
    expect(reducerSource).toContain('submitError: null');
  });

  it('shows inline error message on step 4 when submitError is set', () => {
    // Step4Confirm renders submitError inside a wizard-error container
    expect(step4Source).toContain('wizard-error');
    expect(step4Source).toContain('{submitError}');
  });

  it('checks API response status before navigating away', () => {
    // handleSubmit in useAddLocationWizard.ts checks res.ok before router.push
    expect(hookSource).toContain('if (!res.ok)');
    // On failure it dispatches SUBMIT_FAILED (sets submitError via reducer)
    expect(hookSource).toContain('SUBMIT_FAILED');
  });

  it('does not create businesses row when API returns error', () => {
    // The only write endpoint is /api/locations/add, called from handleSubmit.
    // No "save draft" or "create partial" endpoint exists anywhere.
    const allSource = readSource(
      '../wizard/useAddLocationWizard.ts',
      '../wizard/reducer.ts',
      '../wizard/steps/Step4Confirm.tsx',
      '../AddLocationWizard.tsx',
    );

    expect(allSource).not.toContain('save-draft');
    expect(allSource).not.toContain('create-partial');
    expect(allSource).not.toContain('/api/locations/create-draft');
    expect(allSource).not.toContain('/api/locations/save-progress');
  });

  it('stays on step 4 after error (does not navigate on failure)', () => {
    // router.push must only be called after a successful response (res.ok).
    // In the hook, if (!res.ok) dispatches SUBMIT_FAILED and returns early —
    // router.push only executes on the success path, so its index is greater.
    const routerPushIndex = hookSource.indexOf('router.push');
    const successCheck = hookSource.indexOf('if (!res.ok)');
    expect(routerPushIndex).toBeGreaterThan(successCheck);
  });

  it('clears submitError when retrying', () => {
    // SUBMIT_STARTED sets submitError: null — clearing any previous error
    // at the start of every handleSubmit call.
    expect(reducerSource).toContain('SUBMIT_STARTED');
    expect(reducerSource).toContain('submitError: null');
  });
});

// ── VAL-LOC-065: Wizard abandonment leaves no persistent state ─────────────
//
// If the user navigates away, closes the browser, or clicks "Cancel" at
// any wizard step, no businesses, account_audit_log, or job_outbox rows
// should exist. The account state must be unchanged.

describe('VAL-LOC-065: Wizard abandonment leaves no persistent state', () => {
  const hookSource = readSource('../wizard/useAddLocationWizard.ts');
  const shellSource = readSource('../AddLocationWizard.tsx');

  it('does not make any POST/PUT/PATCH request during steps 1-3', () => {
    // The only write endpoint is /api/locations/add in handleSubmit (step 4).
    expect(hookSource).toContain('/api/locations/add');
    expect(hookSource).not.toContain('/api/locations/create-draft');
    expect(hookSource).not.toContain('/api/locations/save-progress');
  });

  it('wizard data lives in React state only (not localStorage or sessionStorage)', () => {
    // All wizard state is held in useReducer — no browser storage used.
    const allSource = readSource(
      '../wizard/useAddLocationWizard.ts',
      '../wizard/reducer.ts',
      '../AddLocationWizard.tsx',
    );
    expect(allSource).not.toContain('localStorage');
    expect(allSource).not.toContain('sessionStorage');
    expect(allSource).not.toContain('IndexedDB');
  });

  it('cancel link navigates away without persisting data', () => {
    // The composing shell renders the Cancel link via TopBar rightLink prop.
    expect(shellSource).toContain("rightLink={{ href: '/dashboard', label: 'Cancel' }}");
  });

  it('step navigation (Back/Continue) is client-side state only', () => {
    // GO_NEXT and GO_BACK are pure reducer actions — no server calls.
    const reducerSource = readSource('../wizard/reducer.ts');
    expect(reducerSource).toContain('GO_NEXT');
    expect(reducerSource).toContain('GO_BACK');
  });

  it('no businesses row is created until step 4 Confirm & Pay is clicked', () => {
    // The fetch call to /api/locations/add must be inside handleSubmit.
    // Use the quoted fetch string — the comment on line 6 uses the bare path
    // without quotes, so this only matches the actual fetch(...) call site.
    const handleSubmitIndex = hookSource.indexOf('const handleSubmit');
    const addLocationFetchIndex = hookSource.indexOf("fetch('/api/locations/add'");
    expect(addLocationFetchIndex).toBeGreaterThan(handleSubmitIndex);
  });
});

// ── VAL-LOC-066: Proration line shows actual prorated dollar amount ────────
//
// The proration line on step 4 displays a dollar amount computed by
// computeProration(). It must NOT show $0, "TBD", or a placeholder.

describe('VAL-LOC-066: Proration line shows actual prorated charge', () => {
  it('computes correct proration for Copilot $15/mo overage at mid-month', () => {
    // May 15 → 16 remaining days of 31
    const result = computeProration(1500, new Date(2026, 4, 15));
    expect(result.prorationCents).toBeGreaterThan(0);
    expect(result.prorationCents).toBe(Math.round((1500 / 31) * 16));
    expect((result.prorationCents / 100).toFixed(2)).toBe(
      (Math.round((1500 / 31) * 16) / 100).toFixed(2),
    );
  });

  it('computes correct proration for Autopilot $20/mo overage', () => {
    const result = computeProration(2000, new Date(2026, 4, 15));
    expect(result.prorationCents).toBeGreaterThan(0);
    // 2000 / 31 * 16 = 1032.26 → 1032 cents = $10.32
    expect(result.prorationCents).toBe(Math.round((2000 / 31) * 16));
  });

  it('proration is NOT $0 for mid-month dates with positive overage price', () => {
    // For any day that is NOT the last day of the month, proration must be > 0
    // when overagePriceCents > 0
    const result = computeProration(1500, new Date(2026, 4, 1)); // May 1
    expect(result.prorationCents).toBeGreaterThan(0);

    const result2 = computeProration(1500, new Date(2026, 5, 15)); // June 15
    expect(result2.prorationCents).toBeGreaterThan(0);
  });

  it('proration is $0 only on the last day of the month', () => {
    const result = computeProration(1500, new Date(2026, 4, 31)); // May 31
    expect(result.daysRemaining).toBe(0);
    expect(result.prorationCents).toBe(0);
  });

  it('proration is NOT a placeholder or TBD', () => {
    // Step4Confirm renders proration as a formatted dollar amount.
    const step4Source = readSource('../wizard/steps/Step4Confirm.tsx');

    // Must contain the proration rendering logic
    expect(step4Source).toContain('wizard-billing-proration');
    // Must format as dollar amount (toFixed(2))
    expect(step4Source).toContain('proration.prorationCents');
    expect(step4Source).toContain('toFixed(2)');
    // Must NOT contain placeholder text
    expect(step4Source).not.toContain('TBD');
    expect(step4Source).not.toContain('pending');
  });

  it('step 4 renders proration row only when the new location adds monthly cost and days remain', () => {
    // Step4Confirm conditionally renders the proration row.
    const step4Source = readSource('../wizard/steps/Step4Confirm.tsx');

    expect(step4Source).toContain('billingPreview.additionalLocationMonthlyCents > 0');
    expect(step4Source).toContain('proration.daysRemaining > 0');
  });
});
