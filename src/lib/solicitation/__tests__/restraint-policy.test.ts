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
