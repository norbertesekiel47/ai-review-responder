import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BATCH_CAP,
  evaluateAsk,
  evaluateBatch,
  FRESHNESS_WINDOW_DAYS,
  MIN_GAP_DAYS,
  RESTRAINT_POLICY_VERSION,
  resolveVertical,
  VERTICALS,
  WITHHOLD_REASONS,
  type AskCandidate,
  type BatchContext,
} from '../restraint-policy';

/** Candidate that passes every per-candidate gate under the default context. */
function eligibleCandidate(overrides: Partial<AskCandidate> = {}): AskCandidate {
  return {
    contactId: '01980000-0000-7000-8000-000000000001',
    lastVisitDate: '2026-07-20',
    consent: { attested: true, uploadId: 'upload-1' },
    suppression: null,
    matchedReview: null,
    priorBatch: null,
    ...overrides,
  };
}

const context: BatchContext = {
  decidedAt: '2026-07-23T12:00:00.000Z',
  businessCategory: 'Coffee shop',
};

describe('withhold-reason enum (contract)', () => {
  it('is exactly the closed six-reason set, in precedence order', () => {
    expect(WITHHOLD_REASONS).toEqual([
      'no_consent',
      'suppressed',
      'already_reviewed',
      'stale_visit',
      'over_contacted',
      'velocity_banked',
    ]);
  });

  it('exposes the closed eight-vertical enum', () => {
    expect(VERTICALS).toEqual([
      'food_and_drink',
      'retail',
      'personal_care',
      'fitness',
      'medical_dental',
      'automotive',
      'home_services',
      'other',
    ]);
  });

  it('locks the day-one freshness windows to the spec table', () => {
    expect(FRESHNESS_WINDOW_DAYS).toEqual({
      food_and_drink: 14,
      retail: 14,
      personal_care: 21,
      fitness: 21,
      medical_dental: 30,
      automotive: 30,
      home_services: 45,
      other: 30,
    });
  });

  it('locks the day-one batch cap and contact gap', () => {
    expect(BATCH_CAP).toBe(25);
    expect(MIN_GAP_DAYS).toBe(30);
  });
});

describe('resolveVertical', () => {
  it.each([
    ['Joe\'s Pizza & Grill', 'food_and_drink', 'pizza'],
    ['Downtown Boutique', 'retail', 'boutique'],
    ['Shear Bliss Hair Salon', 'personal_care', 'salon'],
    ['Iron Temple Gym', 'fitness', 'gym'],
    ['Bright Smile Dental', 'medical_dental', 'dental'],
    ['Precision Auto Repair', 'automotive', 'auto'],
    ['Rapid Plumbing Co', 'home_services', 'plumb'],
  ] as const)('%s → %s (keyword %s)', (category, vertical, keyword) => {
    expect(resolveVertical(category)).toEqual({ vertical, matchedKeyword: keyword });
  });

  it('falls back to other with no matched keyword', () => {
    expect(resolveVertical('Quantum Flux Consulting')).toEqual({ vertical: 'other', matchedKeyword: null });
    expect(resolveVertical('')).toEqual({ vertical: 'other', matchedKeyword: null });
    expect(resolveVertical(null)).toEqual({ vertical: 'other', matchedKeyword: null });
  });

  it('resolves barber to personal_care, not food_and_drink via "bar"', () => {
    expect(resolveVertical('Fadeaway Barber Shop').vertical).toBe('personal_care');
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (category) => {
        expect(resolveVertical(category)).toEqual(resolveVertical(category));
      }),
    );
  });
});

describe('evaluateAsk — per-reason contracts', () => {
  it('send: eligible candidate gets the bare envelope, no evidence payload', () => {
    expect(evaluateAsk(eligibleCandidate(), context)).toEqual({
      decision: 'send',
      contact_id: '01980000-0000-7000-8000-000000000001',
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: '2026-07-23T12:00:00.000Z',
    });
  });

  it('no_consent: unattested candidate withheld with upload_id evidence (cannot fire in v-watch — #535 attestation is blocking; contract-tested for enum stability)', () => {
    const decision = evaluateAsk(
      eligibleCandidate({ consent: { attested: false, uploadId: 'upload-9' } }),
      context,
    );
    expect(decision).toMatchObject({
      decision: 'withhold',
      reason: 'no_consent',
      upload_id: 'upload-9',
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: context.decidedAt,
    });
  });

  it('suppressed: suppression source + timestamp in evidence (no v-watch source; contract-tested for enum stability)', () => {
    const decision = evaluateAsk(
      eligibleCandidate({ suppression: { source: 'owner_manual', suppressedAt: '2026-07-01T00:00:00.000Z' } }),
      context,
    );
    expect(decision).toMatchObject({
      decision: 'withhold',
      reason: 'suppressed',
      suppression_source: 'owner_manual',
      suppressed_at: '2026-07-01T00:00:00.000Z',
    });
  });

  it('already_reviewed: review_id + review_date, fires on existence of a review — the input type carries no rating (ADR 0012)', () => {
    const decision = evaluateAsk(
      eligibleCandidate({ matchedReview: { reviewId: 'rev-1', reviewDate: '2026-06-15' } }),
      context,
    );
    expect(decision).toMatchObject({
      decision: 'withhold',
      reason: 'already_reviewed',
      review_id: 'rev-1',
      review_date: '2026-06-15',
    });
    expect(JSON.stringify(decision)).not.toMatch(/rating|star|sentiment/i);
  });

  it('stale_visit: fires strictly beyond the vertical window, with full arithmetic evidence', () => {
    // Coffee shop → food_and_drink, window 14. decidedAt is 2026-07-23.
    const boundary = evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-07-09' }), context); // exactly 14 days
    expect(boundary.decision).toBe('send');

    const stale = evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-07-08' }), context); // 15 days
    expect(stale).toMatchObject({
      decision: 'withhold',
      reason: 'stale_visit',
      last_visit_date: '2026-07-08',
      days_since_visit: 15,
      vertical: 'food_and_drink',
      matched_keyword: 'coffee',
      freshness_window_days: 14,
    });
  });

  it('stale_visit: unmapped category uses the other window (30) and records matched_keyword null', () => {
    const ctx: BatchContext = { ...context, businessCategory: 'Quantum Flux Consulting' };
    expect(evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-06-23' }), ctx).decision).toBe('send'); // exactly 30
    const stale = evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-06-22' }), ctx); // 31
    expect(stale).toMatchObject({
      reason: 'stale_visit',
      vertical: 'other',
      matched_keyword: null,
      freshness_window_days: 30,
    });
  });

  it('over_contacted: prior would-have-sent inclusion within MIN_GAP_DAYS withholds with gap evidence', () => {
    const recent = evaluateAsk(
      eligibleCandidate({ priorBatch: { batchId: 'batch-7', decidedAt: '2026-07-10T09:00:00.000Z' } }),
      context,
    );
    expect(recent).toMatchObject({
      decision: 'withhold',
      reason: 'over_contacted',
      prior_batch_id: 'batch-7',
      prior_decision_at: '2026-07-10T09:00:00.000Z',
      min_gap_days: 30,
    });
  });

  it('over_contacted boundary: a gap of exactly MIN_GAP_DAYS is allowed', () => {
    const decision = evaluateAsk(
      eligibleCandidate({ priorBatch: { batchId: 'batch-6', decidedAt: '2026-06-23T09:00:00.000Z' } }),
      context,
    );
    expect(decision.decision).toBe('send');
  });
});

describe('evaluateAsk — first-match precedence', () => {
  /** Fails every per-candidate gate at once. */
  function failsEverything(): AskCandidate {
    return {
      contactId: '01980000-0000-7000-8000-00000000000f',
      lastVisitDate: '2020-01-01',
      consent: { attested: false, uploadId: 'upload-x' },
      suppression: { source: 'owner_manual', suppressedAt: '2026-07-01T00:00:00.000Z' },
      matchedReview: { reviewId: 'rev-x', reviewDate: '2026-06-01' },
      priorBatch: { batchId: 'batch-x', decidedAt: '2026-07-20T00:00:00.000Z' },
    };
  }

  it('reports exactly the first failing gate in precedence order', () => {
    const all = failsEverything();
    expect(evaluateAsk(all, context)).toMatchObject({ reason: 'no_consent' });
    expect(evaluateAsk({ ...all, consent: { attested: true, uploadId: 'u' } }, context)).toMatchObject({ reason: 'suppressed' });
    expect(evaluateAsk({ ...all, consent: { attested: true, uploadId: 'u' }, suppression: null }, context)).toMatchObject({ reason: 'already_reviewed' });
    expect(evaluateAsk({ ...all, consent: { attested: true, uploadId: 'u' }, suppression: null, matchedReview: null }, context)).toMatchObject({ reason: 'stale_visit' });
    expect(
      evaluateAsk(
        { ...all, consent: { attested: true, uploadId: 'u' }, suppression: null, matchedReview: null, lastVisitDate: '2026-07-20' },
        context,
      ),
    ).toMatchObject({ reason: 'over_contacted' });
  });
});

describe('evaluateBatch — velocity banking', () => {
  /** n eligible candidates with sequential UUIDv7-ish ids and distinct recent visit dates. */
  function eligiblePool(n: number): AskCandidate[] {
    return Array.from({ length: n }, (_, i) =>
      eligibleCandidate({
        contactId: `01980000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        // decidedAt is 2026-07-23; keep all within the 14-day food_and_drink window.
        lastVisitDate: `2026-07-${String(10 + (i % 13)).padStart(2, '0')}`,
      }),
    );
  }

  it('returns an empty list for an empty batch', () => {
    expect(evaluateBatch([], context)).toEqual([]);
  });

  it('banks nothing at or under the cap', () => {
    const atCap = evaluateBatch(eligiblePool(BATCH_CAP), context);
    expect(atCap.every((d) => d.decision === 'send')).toBe(true);
    const underCap = evaluateBatch(eligiblePool(3), context);
    expect(underCap.every((d) => d.decision === 'send')).toBe(true);
  });

  it('banks overflow with full evidence, keeping most-recent-visit-first', () => {
    const pool = eligiblePool(BATCH_CAP + 5);
    const decisions = evaluateBatch(pool, context);
    const sends = decisions.filter((d) => d.decision === 'send');
    const banked = decisions.filter((d) => d.decision === 'withhold');
    expect(sends).toHaveLength(BATCH_CAP);
    expect(banked).toHaveLength(5);
    for (const decision of banked) {
      expect(decision).toMatchObject({
        reason: 'velocity_banked',
        batch_cap: BATCH_CAP,
        eligible_count: BATCH_CAP + 5,
      });
    }
    // Every banked candidate's visit is no fresher than every kept candidate's.
    const visitOf = new Map(pool.map((c) => [c.contactId, c.lastVisitDate]));
    const oldestKept = sends.map((d) => visitOf.get(d.contact_id) as string).sort()[0] as string;
    for (const decision of banked) {
      expect((visitOf.get(decision.contact_id) as string) <= oldestKept).toBe(true);
    }
  });

  it('breaks same-date ties on contact row ID ascending (lower ID kept)', () => {
    const pool = Array.from({ length: BATCH_CAP + 1 }, (_, i) =>
      eligibleCandidate({
        contactId: `01980000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        lastVisitDate: '2026-07-20',
      }),
    );
    const decisions = evaluateBatch(pool, context);
    const bankedIds = decisions.filter((d) => d.decision === 'withhold').map((d) => d.contact_id);
    expect(bankedIds).toEqual([`01980000-0000-7000-8000-${String(BATCH_CAP).padStart(12, '0')}`]);
  });

  it('preserves input order and mixes per-candidate withholds untouched', () => {
    const suppressed = eligibleCandidate({
      contactId: '01980000-0000-7000-8000-00000000ffff',
      suppression: { source: 'owner_manual', suppressedAt: '2026-07-01T00:00:00.000Z' },
    });
    const pool = [suppressed, ...eligiblePool(2)];
    const decisions = evaluateBatch(pool, context);
    expect(decisions.map((d) => d.contact_id)).toEqual(pool.map((c) => c.contactId));
    expect(decisions[0]).toMatchObject({ reason: 'suppressed' });
  });
});

// Property tests (fast-check): the house style for invariant-level coverage
// (see src/lib/reviews/__tests__/sentiment.test.ts).
describe('restraint policy invariants', () => {
  const hex12 = fc.integer({ min: 0, max: 0xffffff }).map((n) => n.toString(16).padStart(12, '0'));
  const isoDate = fc
    .integer({ min: 0, max: 400 })
    .map((daysAgo) => new Date(Date.UTC(2026, 6, 23) - daysAgo * 86_400_000).toISOString().slice(0, 10));

  const arbCandidate: fc.Arbitrary<AskCandidate> = fc.record({
    contactId: hex12.map((h) => `01980000-0000-7000-8000-${h}`),
    lastVisitDate: isoDate,
    consent: fc.record({ attested: fc.boolean(), uploadId: fc.constant('upload-1') }),
    suppression: fc.option(
      fc.record({ source: fc.constant('owner_manual'), suppressedAt: fc.constant('2026-07-01T00:00:00.000Z') }),
      { nil: null },
    ),
    matchedReview: fc.option(
      fc.record({ reviewId: fc.constant('rev-1'), reviewDate: fc.constant('2026-06-15') }),
      { nil: null },
    ),
    priorBatch: fc.option(
      fc.record({ batchId: fc.constant('batch-1'), decidedAt: isoDate.map((d) => `${d}T00:00:00.000Z`) }),
      { nil: null },
    ),
  });
  const arbBatch = fc.array(arbCandidate, { maxLength: 60 });

  it('is deterministic: same batch + context twice → identical decisions', () => {
    fc.assert(
      fc.property(arbBatch, (candidates) => {
        expect(evaluateBatch(candidates, context)).toEqual(evaluateBatch(candidates, context));
      }),
    );
  });

  it('every decision carries the envelope; every withhold exactly one closed-enum reason', () => {
    fc.assert(
      fc.property(arbBatch, (candidates) => {
        for (const decision of evaluateBatch(candidates, context)) {
          expect(decision.policy_version).toBe(RESTRAINT_POLICY_VERSION);
          expect(decision.decided_at).toBe(context.decidedAt);
          if (decision.decision === 'withhold') {
            expect(WITHHOLD_REASONS).toContain(decision.reason);
          }
        }
      }),
    );
  });

  it('sends never exceed the cap, and velocity banking only fires when eligible_count > cap', () => {
    fc.assert(
      fc.property(arbBatch, (candidates) => {
        const decisions = evaluateBatch(candidates, context);
        const sends = decisions.filter((d) => d.decision === 'send').length;
        const banked = decisions.filter((d) => d.decision === 'withhold' && d.reason === 'velocity_banked').length;
        expect(sends).toBeLessThanOrEqual(BATCH_CAP);
        if (banked > 0) {
          expect(sends).toBe(BATCH_CAP);
          expect(sends + banked).toBeGreaterThan(BATCH_CAP);
        }
      }),
    );
  });

  it('evidence never contains PII or sentiment: no name/email/phone/rating/star keys in any serialized decision', () => {
    fc.assert(
      fc.property(arbBatch, (candidates) => {
        const serialized = JSON.stringify(evaluateBatch(candidates, context));
        expect(serialized).not.toMatch(/"(name|email|phone|rating|stars?|sentiment)"/i);
      }),
    );
  });
});
