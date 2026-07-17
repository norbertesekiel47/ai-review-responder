// src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts
//
// Tests for the AddLocationWizard utility functions and validation logic.
//
// Validation contract: VAL-LOC-066 (proration), VAL-LOC-073 (Step 2 optional,
// no OAuth redirect — informational only), VAL-SETTINGS-043 (display_label
// validation), VAL-SETTINGS-044 (duplicate Place ID).

import { describe, it, expect } from 'vitest';
import { computeNextLocationBillingPreview, computeProration } from '../wizard/billing';
import { buildAddLocationPayload, hasStep1LocationDetails } from '../wizard/payload';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readWizardSource(...relPaths: string[]): string {
  return relPaths
    .map((p) => readFileSync(resolve(__dirname, p), 'utf-8'))
    .join('\n');
}

// ── computeNextLocationBillingPreview ────────────────────────────────────

describe('computeNextLocationBillingPreview', () => {
  it('does not add Autopilot overage while inside the included location', () => {
    const result = computeNextLocationBillingPreview({
      activeLocationCount: 0,
      billingSnapshot: {
        basePriceCents: 6900,
        includedLocations: 1,
        overagePriceCents: 2000,
        overageUnits: 0,
        totalCents: 6900,
      },
    });

    expect(result.nextOverageUnits).toBe(0);
    expect(result.additionalLocationMonthlyCents).toBe(0);
    expect(result.newMonthlyTotalCents).toBe(6900);
  });

  it('adds one Copilot overage when adding a second location', () => {
    const result = computeNextLocationBillingPreview({
      activeLocationCount: 1,
      billingSnapshot: {
        basePriceCents: 2900,
        includedLocations: 1,
        overagePriceCents: 1500,
        overageUnits: 0,
        totalCents: 2900,
      },
    });

    expect(result.nextOverageUnits).toBe(1);
    expect(result.additionalLocationMonthlyCents).toBe(1500);
    expect(result.newMonthlyTotalCents).toBe(4400);
  });
});

// ── computeProration ─────────────────────────────────────────────────────

describe('computeProration', () => {
  it('computes proration for mid-month date', () => {
    // May 15, 2026 — 16 days remaining (31 - 15)
    const now = new Date(2026, 4, 15); // month is 0-indexed

    // Copilot overage = $15/mo.
    const result = computeProration(1500, now);

    expect(result.daysInMonth).toBe(31);
    expect(result.daysRemaining).toBe(16);
    expect(result.prorationCents).toBe(Math.round((1500 / 31) * 16));
  });

  it('computes proration for first of month (full month charge)', () => {
    const now = new Date(2026, 5, 1); // June 1
    const result = computeProration(1500, now);

    expect(result.daysInMonth).toBe(30);
    expect(result.daysRemaining).toBe(29); // 30 - 1
    expect(result.prorationCents).toBe(Math.round((1500 / 30) * 29));
  });

  it('computes proration for last day of month (0 remaining)', () => {
    const now = new Date(2026, 4, 31); // May 31
    const result = computeProration(1500, now);

    expect(result.daysInMonth).toBe(31);
    expect(result.daysRemaining).toBe(0);
    expect(result.prorationCents).toBe(0);
  });

  it('computes proration for February (28 days)', () => {
    const now = new Date(2027, 1, 14); // Feb 14
    const result = computeProration(1500, now);

    expect(result.daysInMonth).toBe(28);
    expect(result.daysRemaining).toBe(14); // 28 - 14
    expect(result.prorationCents).toBe(750);
  });

  it('returns zero proration when overagePriceCents is 0', () => {
    const now = new Date(2026, 4, 15);
    const result = computeProration(0, now);

    expect(result.prorationCents).toBe(0);
    expect(result.daysRemaining).toBe(16);
  });

  it('handles the Autopilot overage rate correctly', () => {
    const now = new Date(2026, 4, 15); // May 15
    const result = computeProration(2000, now);

    // 2000 / 31 * 16 = 1032.26 → 1032
    expect(result.prorationCents).toBe(Math.round((2000 / 31) * 16));
  });

  it('keeps founding Copilot on the Copilot overage rate', () => {
    const now = new Date(2026, 4, 20); // May 20
    const result = computeProration(1500, now);

    expect(result.daysInMonth).toBe(31);
    expect(result.daysRemaining).toBe(11);
    expect(result.prorationCents).toBe(Math.round((1500 / 31) * 11));
  });
});

// ── Step 2 Zernio informational-only check ───────────────────────────────
//
// VAL-LOC-073: Step 2 is optional and skippable. It must NOT contain any
// OAuth redirect — it shows informational text about connecting Google
// Business later, with a link to /dashboard/connect. After modularization
// the Step-2 UI lives in wizard/steps/Step2GoogleBusiness.tsx and the submit
// navigation lives in wizard/useAddLocationWizard.ts; we guard both.

describe('Step 2 Zernio informational-only (no OAuth redirect)', () => {
  const step2AndHook = () =>
    readWizardSource(
      '../wizard/steps/Step2GoogleBusiness.tsx',
      '../wizard/useAddLocationWizard.ts',
    );

  it('has no handleZernioConnect or window.location redirect', () => {
    const source = step2AndHook();

    // No handleZernioConnect function
    expect(source).not.toContain('handleZernioConnect');

    // No window.location.href assignment (the OAuth redirect pattern)
    expect(source).not.toContain('window.location.href');

    // No /api/zernio/connect/start fetch call (the OAuth initiation)
    expect(source).not.toContain('/api/zernio/connect/start');

    // Step 2 shows the connect-later message and a link to the connect flow
    const step2 = readWizardSource('../wizard/steps/Step2GoogleBusiness.tsx');
    expect(step2).toContain('Connect later from Settings');
    expect(step2).toContain('/dashboard/connect');
  });

  it('has no zernioConnecting or zernioConnected state variables', () => {
    const source = step2AndHook();

    // These state variables were removed — they tracked the OAuth flow
    expect(source).not.toContain('zernioConnecting');
    expect(source).not.toContain('zernioConnected');
    expect(source).not.toContain('zernioError');
  });
});

// Submit payload shape
//
// The API schema treats googleMapsUrl as optional, not nullable. When the
// wizard uses Place Autocomplete, it must omit googleMapsUrl entirely. The
// payload builder lives in wizard/payload.ts and the submit navigation in
// wizard/useAddLocationWizard.ts.
describe('submit payload shape', () => {
  it('does not send googleMapsUrl:null for Place Autocomplete submissions', () => {
    const source = readWizardSource('../wizard/payload.ts');
    expect(source).not.toContain('googleMapsUrl: null');
  });

  it('routes the newly added location directly to its Google connect flow', () => {
    const source = readWizardSource('../wizard/useAddLocationWizard.ts');
    expect(source).toContain('/dashboard/connect?locationId=');
    expect(source).toContain('encodeURIComponent(result.businessId)');
    expect(source).not.toContain("router.push('/dashboard');");
  });
});

// Manual Google Maps URL fallback
//
// TC-3: The add-location wizard must remain usable when Google Places
// autocomplete cannot be selected in the browser.
describe('manual Google Maps URL fallback', () => {
  it('allows step 1 to continue with a Maps URL and no Place selection', () => {
    expect(hasStep1LocationDetails({
      inputMode: 'url',
      placeSelection: null,
      googleMapsUrl: ' https://maps.app.goo.gl/example ',
    })).toBe(true);
  });

  it('does not allow step 1 URL mode to continue with a blank URL', () => {
    expect(hasStep1LocationDetails({
      inputMode: 'url',
      placeSelection: null,
      googleMapsUrl: '   ',
    })).toBe(false);
  });

  it('sends googleMapsUrl and omits googlePlaceId for manual URL submissions', () => {
    const payload = buildAddLocationPayload({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Tanicia',
      inputMode: 'url',
      placeSelection: null,
      googleMapsUrl: ' https://maps.google.com/?cid=123 ',
      voiceForm: {
        tone: 'professional and friendly',
        productsServices: '',
        avoidFacts: [''],
        sampleResponses: ['Thanks for visiting'],
      },
    });

    expect(payload).toMatchObject({
      accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      displayLabel: 'Tanicia',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
      placeIdVerified: false,
    });
    expect(payload).not.toHaveProperty('googlePlaceId');
    expect(payload.voiceConfig.avoidFacts).toEqual([]);
    expect(payload.voiceConfig.sampleResponses).toEqual(['Thanks for visiting']);
  });
});

// ── Step-1 validation (VAL-SETTINGS-043 / VAL-SETTINGS-044) ───────────────
//
// display_label non-empty + ≤ 255 chars (VAL-SETTINGS-043) and duplicate
// Place-ID rejection (VAL-SETTINGS-044) are enforced by the reducer's
// GO_NEXT step-1 validation. They are unit-tested directly against reducer()
// in reducer.test.ts ("GO_NEXT — step 1 validation"). The previous
// string/Set assertions here exercised JS built-ins rather than wizard
// logic, so they were removed as redundant when the logic moved to the
// reducer.
