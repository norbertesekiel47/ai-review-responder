// worker/ingress/stripe/__tests__/import-offer-resume.test.ts
//
// T0 EVAL suite for #677 — titles 20–23 of the intake's 69, authored VERBATIM
// before implementation.
//
// Producer 2 of 4: the Stripe subscription-activation resume
// (`maybeEnqueueBackfillResume`, worker/ingress/stripe/shared.ts:92). This is
// the OTHER junction ordering — the owner connected Google BEFORE checkout, so
// activation is the second half to arrive and finalize already ran. Spec §5.2.
//
// Two structural facts this suite must not lose:
//
//  1. Round-2 F107: this path used to run on root `sql` with NO transaction, so
//     createImportOffer (which takes TransactionSql) had nothing to run in and
//     its dedup check was unserialized. It now opens sql.begin and takes the
//     businesses row lock first. The lock ORDER is pinned by the source tripwire
//     (title 69); this suite pins the behaviour.
//
//  2. Round-1 Medium (F106): offer creation sits BEFORE the
//     zernioPublishingEnabled() early return. The kill switch governs
//     *publishing*; skipping durable offer creation behind it would lose the
//     offer with no replay path.
//
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlCalls, scenario, mockPublishingEnabled } = vi.hoisted(() => {
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const scenario = {
    lockedAccountId: 'acct-1' as string | null,
    target: {
      zernio_account_id: 'zacct-1',
      zernio_location_id: 'zloc-1',
      subscription_tier: 'copilot',
      subscription_activated_at: new Date('2026-05-01T00:00:00.000Z'),
    } as Record<string, unknown> | null,
    importConsent: 'pending' as 'pending' | 'accepted' | 'declined' | 'expired' | null,
    publishingEnabled: true,
  };

  const mockSql: any = vi.fn((s: TemplateStringsArray, ...v: unknown[]) => {
    const text = Array.from(s).join('?');
    sqlCalls.push({ text, values: v });

    if (/import_decision_at AS decided_at/.test(text)) {
      return Promise.resolve(
        scenario.importConsent === null
          ? []
          : [{ state: scenario.importConsent, decided_at: null, expires_at: null }],
      );
    }
    if (/SET import_offer_expires_at/.test(text)) return Promise.resolve([{ id: 'biz-1' }]);
    if (/SELECT account_id[\s\S]*FROM businesses[\s\S]*FOR UPDATE/.test(text)) {
      return Promise.resolve(
        scenario.lockedAccountId ? [{ account_id: scenario.lockedAccountId }] : [],
      );
    }
    // enqueueInitialImport's target resolution (round-1 O3) — matched BEFORE the
    // eligibility SELECT because both read `zernio_connections zc`, and only this
    // one carries the completed-run anti-join.
    if (/LEFT JOIN zernio_backfill_runs/.test(text)) {
      return Promise.resolve(scenario.target ? [scenario.target] : []);
    }
    // maybeEnqueueBackfillResume's own eligibility SELECT: junction + writable
    // subscription status, the one predicate the shared enqueue does not carry.
    if (/FROM zernio_connections zc/.test(text)) {
      return Promise.resolve(
        scenario.target ? [{ subscription_tier: scenario.target.subscription_tier }] : [],
      );
    }
    return Promise.resolve([]);
  });
  mockSql.begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockSql));
  mockSql.json = vi.fn((v: unknown) => v);

  const mockPublishingEnabled = vi.fn(() => scenario.publishingEnabled);
  return { mockSql, sqlCalls, scenario, mockPublishingEnabled };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/publishing/flags', () => ({
  zernioPublishingEnabled: mockPublishingEnabled,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7-resume') }));

import { resumePrimaryBusinessBackfill } from '../shared';

const BUSINESS_ID = '11111111-1111-4111-8111-111111111111';

function importEnqueued(): boolean {
  return sqlCalls.some(
    (c) => c.text.includes('INSERT INTO job_outbox') && c.values.includes('zernio_initial_backfill'),
  );
}

function offerCreateAttempted(): boolean {
  return sqlCalls.some((c) => /SET import_offer_expires_at/.test(c.text));
}

beforeEach(() => {
  sqlCalls.length = 0;
  scenario.lockedAccountId = 'acct-1';
  scenario.importConsent = 'pending';
  scenario.publishingEnabled = true;
  scenario.target = {
    zernio_account_id: 'zacct-1',
    zernio_location_id: 'zloc-1',
    subscription_tier: 'copilot',
    subscription_activated_at: new Date('2026-05-01T00:00:00.000Z'),
  };
});

describe('stripe activation resume — Import offer', () => {
  it('resumePrimaryBusinessBackfill enqueues the import only when import consent is accepted', async () => {
    scenario.importConsent = 'accepted';
    await resumePrimaryBusinessBackfill(BUSINESS_ID);
    expect(importEnqueued()).toBe(true);

    // The whole path runs inside one transaction taking the businesses row lock
    // FIRST (round-2 F107). Before #677 this ran on root sql with no transaction,
    // so createImportOffer had none to run in and the dedup was unserialized.
    expect(mockSql.begin).toHaveBeenCalled();
    const lockIndex = sqlCalls.findIndex((c) => /FROM businesses[\s\S]*FOR UPDATE/.test(c.text));
    const insertIndex = sqlCalls.findIndex(
      (c) => c.text.includes('INSERT INTO job_outbox') && c.values.includes('zernio_initial_backfill'),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(insertIndex);

    sqlCalls.length = 0;
    scenario.importConsent = 'pending';
    await resumePrimaryBusinessBackfill(BUSINESS_ID);
    expect(importEnqueued()).toBe(false);
  });

  // The §5.2 bug itself: a pre-checkout connection meeting a pending offer. The
  // offer must be created (durably, so the banner can show it) while the import
  // stays un-enqueued (consent has not been given).
  it('resumePrimaryBusinessBackfill creates the offer and enqueues nothing when a pre-checkout connection meets a pending offer', async () => {
    scenario.importConsent = 'pending';

    await resumePrimaryBusinessBackfill(BUSINESS_ID);

    expect(offerCreateAttempted()).toBe(true);
    expect(importEnqueued()).toBe(false);
  });

  // past_due → active is a recovery transition, not a new junction. A location
  // that already declined must not be re-imported by a billing state change —
  // this path fires on every reactivation of the subscription, so it is the most
  // likely place for a declined location to be silently overridden.
  it('resumePrimaryBusinessBackfill does not re-enqueue for a declined location on past_due to active recovery', async () => {
    scenario.importConsent = 'declined';

    await resumePrimaryBusinessBackfill(BUSINESS_ID);

    expect(importEnqueued()).toBe(false);
    // createImportOffer is still CALLED, and that is correct: it is idempotent and
    // refuses to touch an answered row, so the declined decision survives. Spec
    // §7 — re-connect after declining stays declined.
    expect(offerCreateAttempted()).toBe(true);
  });

  it('resumePrimaryBusinessBackfill enqueues nothing for a derived-expired offer', async () => {
    scenario.importConsent = 'expired';

    await resumePrimaryBusinessBackfill(BUSINESS_ID);

    expect(importEnqueued()).toBe(false);
  });

  // Round-1 A4/O3. This producer's copy of the completed-run guard was the one
  // the spec review called "pre-existing" — an unscoped `NOT EXISTS`, which let a
  // completed REACTIVATION run permanently suppress the one-time initial import.
  // The guard now lives in `enqueueInitialImport` and is scoped to
  // `run_reason = 'initial'`, matching `readImportOfferView`. The BEHAVIOUR is
  // proven against live Postgres (import-consent.integration.test.ts); what is
  // falsifiable here is that this producer routes through the shared enqueue at
  // all rather than re-growing a copy.
  it('resumePrimaryBusinessBackfill enqueues through the shared guard scoped to initial runs', async () => {
    scenario.importConsent = 'accepted';

    await resumePrimaryBusinessBackfill(BUSINESS_ID);

    const guard = sqlCalls.find((c) => /LEFT JOIN zernio_backfill_runs/.test(c.text));
    expect(guard, 'the shared completed-run guard did not run').toBeDefined();
    expect(guard!.text).toContain("br.run_reason = 'initial'");
    expect(guard!.text).toContain('br.completed_at IS NOT NULL');
    // And no second, locally-spelled copy came back with it.
    expect(sqlCalls.filter((c) => /zernio_backfill_runs/.test(c.text))).toHaveLength(1);
  });

  it('creates the offer even when zernio publishing is disabled', async () => {
    // Round-1 Medium (F106). The kill switch governs PUBLISHING; offer creation is
    // durable state the owner is entitled to see. Skipping it behind the flag
    // would lose the offer with no replay path — the owner would simply never be
    // asked. So creation sits BEFORE the early return and only the enqueue is
    // gated. Not one of the 69 intake titles: it asserts the ORDERING of two
    // steps inside title 21's path, and it is the assertion that fails if someone
    // moves the flag check up.
    scenario.publishingEnabled = false;
    scenario.importConsent = 'accepted';

    await resumePrimaryBusinessBackfill(BUSINESS_ID);

    expect(offerCreateAttempted()).toBe(true);
    expect(importEnqueued()).toBe(false);
  });
});
