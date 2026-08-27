// src/lib/locations/__tests__/review-qr.test.ts
//
// Task 1 eval suite for the review-qr module (CONTEXT.md "Review QR" /
// "QR redirect") — authored FAILING before the module exists; Task 4 turns
// it green.

import { describe, it, expect, vi } from 'vitest';
import QRCode from 'qrcode';
import {
  buildWriteReviewUrl,
  getOwnerReviewQrLocation,
  getOwnerReviewQrLocations,
  resolveQrRedirect,
} from '../review-qr';
import { subscriptionAllowsQrRedirect } from '@/lib/shared/subscription-status';

// PASSTHROUGH mock (codex R2 on M9): the real predicate runs, wrapped in a
// vi.fn so the "gates through subscriptionAllowsQrRedirect" test can assert
// the module calls the NAMED predicate rather than re-spelling the membership.
vi.mock('@/lib/shared/subscription-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/subscription-status')>();
  return { ...actual, subscriptionAllowsQrRedirect: vi.fn(actual.subscriptionAllowsQrRedirect) };
});

const CANONICAL_PLACE_ID = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
const HEX_CID = '0x89c259af336b3341:0x66df8e2a5b7cdb51';
const ACCOUNT_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec604';
const BUSINESS_UUID = '019db8c1-c3f4-7668-b353-2b8b718ec603';

// postgres.js template-tag fake: records each call, returns queued rows.
function fakeSql(rowsPerCall: unknown[][]) {
  const calls: { text: string; values: unknown[] }[] = [];
  const fn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return rowsPerCall.shift() ?? [];
  };
  return { sql: Object.assign(fn, { json: (v: unknown) => v }) as never, calls };
}

describe('buildWriteReviewUrl', () => {
  it('refuses to build a review link for a non-canonical place id', () => {
    expect(buildWriteReviewUrl(HEX_CID)).toBeNull();
    expect(buildWriteReviewUrl(null)).toBeNull();
    expect(buildWriteReviewUrl('   ')).toBeNull();
    expect(buildWriteReviewUrl('short')).toBeNull();
  });

  it('builds the Google write-review URL for a canonical place id', () => {
    expect(buildWriteReviewUrl(CANONICAL_PLACE_ID)).toBe(
      `https://search.google.com/local/writereview?placeid=${CANONICAL_PLACE_ID}`,
    );
  });
});

function resolveRow(overrides: Record<string, unknown> = {}) {
  return {
    google_place_id: CANONICAL_PLACE_ID,
    archived_at: null,
    account_id: ACCOUNT_UUID,
    subscription_status: 'active',
    ...overrides,
  };
}

describe('resolveQrRedirect', () => {
  it('resolves a live location to a redirect carrying the account id', async () => {
    const { sql } = fakeSql([[resolveRow()]]);
    const result = await resolveQrRedirect(sql, BUSINESS_UUID);
    expect(result).toEqual({
      kind: 'redirect',
      url: `https://search.google.com/local/writereview?placeid=${CANONICAL_PLACE_ID}`,
      accountId: ACCOUNT_UUID,
    });
  });

  it('returns not_found for an unknown business id', async () => {
    const { sql } = fakeSql([[]]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'not_found',
    });
  });

  it('returns archived before consulting the subscription', async () => {
    const { sql } = fakeSql([
      [resolveRow({ archived_at: new Date('2026-08-01T00:00:00Z'), subscription_status: 'cancelled' })],
    ]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'archived',
    });
  });

  it('returns subscription for a status outside the QR gate', async () => {
    const { sql } = fakeSql([[resolveRow({ subscription_status: 'pending_payment' })]]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'subscription',
    });
  });

  it('returns bad_place_id for a legacy hex CID', async () => {
    const { sql } = fakeSql([[resolveRow({ google_place_id: HEX_CID })]]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'bad_place_id',
    });
  });

  it('returns bad_place_id for a missing google_place_id', async () => {
    const { sql } = fakeSql([[resolveRow({ google_place_id: null })]]);
    expect(await resolveQrRedirect(sql, BUSINESS_UUID)).toEqual({
      kind: 'unavailable',
      reason: 'bad_place_id',
    });
  });

  it('admits trialing and past_due through the named predicate', async () => {
    for (const status of ['trialing', 'past_due']) {
      const { sql } = fakeSql([[resolveRow({ subscription_status: status })]]);
      const result = await resolveQrRedirect(sql, BUSINESS_UUID);
      expect(result.kind).toBe('redirect');
    }
  });

  it('reads the subscription from the accounts JOIN, not the deprecated businesses column', async () => {
    // Text-level guard (codex R1 M5); the LIVE proof is in
    // review-qr.integration.test.ts, where the two columns diverge.
    const { sql, calls } = fakeSql([[resolveRow()]]);
    await resolveQrRedirect(sql, BUSINESS_UUID);
    // Optional chaining throughout: index access stays possibly-undefined
    // under noUncheckedIndexedAccess (codex R3 #1).
    expect(calls[0]?.text).toContain('a.subscription_status');
    expect(calls[0]?.text).toContain('JOIN accounts a');
  });

  it('gates through subscriptionAllowsQrRedirect, never a raw comparison', async () => {
    // Invariant #11 made mechanical (codex R2 on M9): a re-spelled
    // status === 'active' || … would pass every membership test above.
    // Relies on the PASSTHROUGH mock at the top of this test file.
    const { sql } = fakeSql([[resolveRow()]]);
    vi.mocked(subscriptionAllowsQrRedirect).mockClear();
    await resolveQrRedirect(sql, BUSINESS_UUID);
    expect(subscriptionAllowsQrRedirect).toHaveBeenCalledWith('active');
  });
});

describe('getOwnerReviewQrLocations', () => {
  it("returns only the caller's account locations from getOwnerReviewQrLocations", async () => {
    const { sql, calls } = fakeSql([
      [
        { id: BUSINESS_UUID, name: 'Acme', display_label: null, google_place_id: CANONICAL_PLACE_ID },
        { id: ACCOUNT_UUID, name: 'Acme Two', display_label: 'Downtown', google_place_id: HEX_CID },
      ],
    ]);
    const locations = await getOwnerReviewQrLocations(sql, ACCOUNT_UUID, 'https://app.example.com/');

    // Tenant scope: the one query binds the caller's account id.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('account_id');
    expect(calls[0]?.values).toContain(ACCOUNT_UUID);
    expect(calls[0]?.text).toContain('archived_at IS NULL');

    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({
      businessId: BUSINESS_UUID,
      displayName: 'Acme',
      qrTargetUrl: `https://app.example.com/q/${BUSINESS_UUID}`,
      ineligibleReason: null,
    });
    expect(locations[0]?.qrDataUrl).toMatch(/^data:image\/png/);
    expect(locations[1]).toMatchObject({
      displayName: 'Downtown',
      qrDataUrl: null,
      ineligibleReason: 'bad_place_id',
    });
  });

  it('throws when appUrl is empty — a QR encoding a relative URL is a config defect', async () => {
    const { sql } = fakeSql([[]]);
    await expect(getOwnerReviewQrLocations(sql, ACCOUNT_UUID, '')).rejects.toThrow(/appUrl/);
  });
});

describe('getOwnerReviewQrLocation', () => {
  // The print view's single-location loader (adversarial R1 A3a): one row
  // mapped, ONE QR generated — never one per account location.
  const ACME_ROW = {
    id: BUSINESS_UUID,
    name: 'Acme',
    display_label: null,
    google_place_id: CANONICAL_PLACE_ID,
  };
  const DOWNTOWN_ROW = {
    id: ACCOUNT_UUID,
    name: 'Acme Two',
    display_label: 'Downtown',
    google_place_id: HEX_CID,
  };

  it('returns the one mapped location and generates exactly one QR', async () => {
    const toDataURL = vi.spyOn(QRCode, 'toDataURL');
    try {
      const { sql } = fakeSql([[ACME_ROW, DOWNTOWN_ROW]]);
      const location = await getOwnerReviewQrLocation(
        sql,
        ACCOUNT_UUID,
        BUSINESS_UUID,
        'https://app.example.com/',
      );
      expect(location).toMatchObject({
        businessId: BUSINESS_UUID,
        displayName: 'Acme',
        qrTargetUrl: `https://app.example.com/q/${BUSINESS_UUID}`,
        ineligibleReason: null,
      });
      expect(location?.qrDataUrl).toMatch(/^data:image\/png/);
      expect(toDataURL).toHaveBeenCalledTimes(1);
      // objectContaining: qrcode normalizes the options object IN PLACE
      // (adds color:{}), so the spy's recorded args gain keys post-call.
      expect(toDataURL).toHaveBeenCalledWith(
        `https://app.example.com/q/${BUSINESS_UUID}`,
        expect.objectContaining({ margin: 1, width: 2048 }),
      );
    } finally {
      toDataURL.mockRestore();
    }
  });

  it('returns null for an unknown or foreign businessId', async () => {
    // Account scope is structural: a foreign businessId is simply absent
    // from the caller's account-scoped list.
    const { sql } = fakeSql([[ACME_ROW]]);
    expect(
      await getOwnerReviewQrLocation(
        sql,
        ACCOUNT_UUID,
        '019db8c1-c3f4-7668-b353-2b8b718ec605',
        'https://app.example.com',
      ),
    ).toBeNull();
  });

  it('scopes the one query by the caller account id', async () => {
    const { sql, calls } = fakeSql([[ACME_ROW]]);
    await getOwnerReviewQrLocation(sql, ACCOUNT_UUID, BUSINESS_UUID, 'https://app.example.com');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('account_id');
    expect(calls[0]?.values).toContain(ACCOUNT_UUID);
    expect(calls[0]?.text).toContain('archived_at IS NULL');
  });
});

// Codex R1 M16 / R2 fix: prove the ENCODED PAYLOAD and print size with NO
// mock at all — QR encoding and PNG serialization are deterministic for a
// fixed input + options, so generate the EXPECTED data URL independently
// with the same library and compare byte-for-byte. (The R1 passthrough mock
// failed typecheck: `typeof import('qrcode')` has no `default` under
// @types/qrcode — codex R2 ran tsc and proved it.)

describe('QR encoding parameters', () => {
  it('encodes the /q/<businessId> URL at print width', async () => {
    const { sql } = fakeSql([
      [{ id: BUSINESS_UUID, name: 'Acme', display_label: null, google_place_id: CANONICAL_PLACE_ID }],
    ]);
    const locations = await getOwnerReviewQrLocations(sql, ACCOUNT_UUID, 'https://app.example.com');
    const expected = await QRCode.toDataURL(`https://app.example.com/q/${BUSINESS_UUID}`, {
      margin: 1,
      width: 2048,
    });
    // Index access stays possibly-undefined under noUncheckedIndexedAccess
    // (codex R3 #1) — optional chaining keeps the assertion type-clean.
    expect(locations[0]?.qrDataUrl).toBe(expected);
  });
});
