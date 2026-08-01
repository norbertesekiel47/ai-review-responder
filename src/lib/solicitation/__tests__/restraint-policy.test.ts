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
  RestraintPolicyDateError,
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
    consent: { attested: true, uploadId: 'upload-1', attestationVersion: 'consent_attestation_v2' },
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

  it('names the .3 ruleset: ledger-derived consent + widened no_consent evidence (#620 §6.2)', () => {
    expect(RESTRAINT_POLICY_VERSION).toBe('restraint_v_watch_2026-07-23.3');
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

  it('no_consent case (a): no consent ledger row — evidence carries null upload_id and null attestation_version', () => {
    const decision = evaluateAsk(
      eligibleCandidate({ consent: { attested: false, uploadId: null, attestationVersion: null } }),
      context,
    );
    expect(decision).toMatchObject({
      decision: 'withhold',
      reason: 'no_consent',
      upload_id: null,
      attestation_version: null,
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: context.decidedAt,
    });
  });

  it('no_consent case (b): ledger row exists but the version is not send-eligible — evidence carries both fields populated', () => {
    const decision = evaluateAsk(
      eligibleCandidate({
        consent: { attested: false, uploadId: 'upload-9', attestationVersion: 'consent_attestation_v1' },
      }),
      context,
    );
    expect(decision).toMatchObject({
      decision: 'withhold',
      reason: 'no_consent',
      upload_id: 'upload-9',
      attestation_version: 'consent_attestation_v1',
      policy_version: RESTRAINT_POLICY_VERSION,
      decided_at: context.decidedAt,
    });
  });

  it('suppression outranks a fresh attestation: an attested candidate with a suppression present still withholds as suppressed', () => {
    // Spec #620 §5.2: precedence is reporting order, not override — a v2
    // re-attestation never un-suppresses a handle.
    const decision = evaluateAsk(
      eligibleCandidate({
        consent: { attested: true, uploadId: 'u1', attestationVersion: 'consent_attestation_v2' },
        suppression: { source: 'unsubscribe', suppressedAt: '2026-07-01T00:00:00.000Z' },
      }),
      context,
    );
    expect(decision).toMatchObject({
      decision: 'withhold',
      reason: 'suppressed',
      suppression_source: 'unsubscribe',
      suppressed_at: '2026-07-01T00:00:00.000Z',
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

  it('stale_visit arithmetic is offset-aware: "today" is the UTC date of the decidedAt instant, not its lexical date part', () => {
    // 2026-07-23T22:00:00.000-07:00 IS 2026-07-24T05:00:00.000Z → today is 2026-07-24 UTC.
    // Visit 2026-07-09 is exactly 14 days before 2026-07-23 (send at the food_and_drink
    // boundary) but 15 days before 2026-07-24 — the extra UTC day flips the decision.
    const offsetContext: BatchContext = { ...context, decidedAt: '2026-07-23T22:00:00.000-07:00' };
    const equivalentZContext: BatchContext = { ...context, decidedAt: '2026-07-24T05:00:00.000Z' };
    for (const ctx of [offsetContext, equivalentZContext]) {
      expect(evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-07-09' }), ctx)).toMatchObject({
        decision: 'withhold',
        reason: 'stale_visit',
        days_since_visit: 15,
        freshness_window_days: 14,
      });
    }
    // Same visit under the default context (UTC date 2026-07-23) stays a send.
    expect(evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-07-09' }), context).decision).toBe('send');
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
      consent: { attested: false, uploadId: null, attestationVersion: null },
      suppression: { source: 'owner_manual', suppressedAt: '2026-07-01T00:00:00.000Z' },
      matchedReview: { reviewId: 'rev-x', reviewDate: '2026-06-01' },
      priorBatch: { batchId: 'batch-x', decidedAt: '2026-07-20T00:00:00.000Z' },
    };
  }

  it('reports exactly the first failing gate in precedence order', () => {
    const all = failsEverything();
    const attestedConsent = { attested: true, uploadId: 'u', attestationVersion: 'consent_attestation_v2' };
    expect(evaluateAsk(all, context)).toMatchObject({ reason: 'no_consent' });
    expect(evaluateAsk({ ...all, consent: attestedConsent }, context)).toMatchObject({ reason: 'suppressed' });
    expect(evaluateAsk({ ...all, consent: attestedConsent, suppression: null }, context)).toMatchObject({ reason: 'already_reviewed' });
    expect(evaluateAsk({ ...all, consent: attestedConsent, suppression: null, matchedReview: null }, context)).toMatchObject({ reason: 'stale_visit' });
    expect(
      evaluateAsk(
        { ...all, consent: attestedConsent, suppression: null, matchedReview: null, lastVisitDate: '2026-07-20' },
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

  it('over_contacted precedes velocity_banked: a prior-inclusion candidate in an over-cap batch is never banked or sent', () => {
    const overContacted = eligibleCandidate({
      contactId: '01980000-0000-7000-8000-0000000000aa',
      priorBatch: { batchId: 'batch-7', decidedAt: '2026-07-10T09:00:00.000Z' },
    });
    const pool = [overContacted, ...eligiblePool(BATCH_CAP + 2)];
    const decisions = evaluateBatch(pool, context);
    expect(decisions.find((d) => d.contact_id === overContacted.contactId)).toMatchObject({
      decision: 'withhold',
      reason: 'over_contacted',
    });
    expect(decisions.filter((d) => d.decision === 'send')).toHaveLength(BATCH_CAP);
    expect(
      decisions.filter((d) => d.decision === 'withhold' && d.reason === 'velocity_banked'),
    ).toHaveLength(2);
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
    consent: fc.record({
      attested: fc.boolean(),
      uploadId: fc.option(fc.constant('upload-1'), { nil: null }),
      attestationVersion: fc.option(fc.constant('consent_attestation_v1'), { nil: null }),
    }),
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

  // Contact row ids are unique by construction (UUIDv7 PKs); the partition
  // property is stated over sets of ids, so this batch generator enforces it.
  const arbUniqueBatch = fc.uniqueArray(arbCandidate, { maxLength: 60, selector: (c) => c.contactId });

  it('partitions the surviving pool exactly: {send} ∪ {velocity_banked} = evaluateAsk-send ids, disjoint, |send| ≤ cap', () => {
    fc.assert(
      fc.property(arbUniqueBatch, (candidates) => {
        const surviving = new Set(
          candidates.filter((c) => evaluateAsk(c, context).decision === 'send').map((c) => c.contactId),
        );
        const decisions = evaluateBatch(candidates, context);
        const sendIds = new Set(decisions.filter((d) => d.decision === 'send').map((d) => d.contact_id));
        const bankedIds = new Set(
          decisions
            .filter((d) => d.decision === 'withhold' && d.reason === 'velocity_banked')
            .map((d) => d.contact_id),
        );
        expect(sendIds.size).toBeLessThanOrEqual(BATCH_CAP);
        for (const id of sendIds) {
          expect(bankedIds.has(id)).toBe(false);
        }
        expect(new Set([...sendIds, ...bankedIds])).toEqual(surviving);
        if (bankedIds.size > 0) {
          expect(sendIds.size).toBe(BATCH_CAP);
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

// ---------------------------------------------------------------------------
// #555 item 1 — date handling must fail CLOSED.
//
// The pre-fix utcDayNumber returned NaN for anything unparseable. NaN makes
// every comparison false, so stale_visit and over_contacted both passed and the
// policy decided `send`: the one component whose whole job is restraint failed
// in the direction of contacting people. It also parsed offset-less datetimes
// in the HOST's local zone, making decisions machine-dependent.
// ---------------------------------------------------------------------------

describe('date handling is fail-closed (#555)', () => {
  it('rejects an offset-less datetime, which JS would parse in the host local zone', () => {
    expect(() => evaluateAsk(eligibleCandidate(), { ...context, decidedAt: '2026-07-23T12:00:00' }))
      .toThrow(RestraintPolicyDateError);
  });

  it('throws on an unparseable last_visit_date instead of deciding send', () => {
    expect(() => evaluateAsk(eligibleCandidate({ lastVisitDate: 'not-a-real-date' }), context))
      .toThrow(RestraintPolicyDateError);
  });

  it('throws on an unparseable prior_batch.decided_at instead of skipping over_contacted', () => {
    const candidate = eligibleCandidate({ priorBatch: { batchId: 'b1', decidedAt: 'sometime last week' } });
    expect(() => evaluateAsk(candidate, context)).toThrow(RestraintPolicyDateError);
  });

  it('throws on a well-formed but non-existent date rather than rolling it over', () => {
    // Date.UTC(2026, 1, 30) silently yields March 2 — a real date, wrong answer.
    expect(() => evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-02-30' }), context))
      .toThrow(RestraintPolicyDateError);
  });

  it('names the offending field so the failure is actionable', () => {
    expect(() => evaluateAsk(eligibleCandidate({ lastVisitDate: 'nope' }), context))
      .toThrow(/last_visit_date/);
  });

  it.each([
    ['plain date', '2026-07-23'],
    ['UTC Z', '2026-07-23T12:00:00.000Z'],
    ['positive offset', '2026-07-23T12:00:00+05:30'],
    ['negative offset', '2026-07-23T12:00:00-08:00'],
    ['offset without colon', '2026-07-23T12:00:00+0530'],
    // What Postgres actually hands back for a timestamptz read out of a stored
    // ask: space separator, two-digit offset. Caught by the live-DB suite.
    ['postgres timestamptz text', '2026-07-23 12:00:00.109+00'],
    ['postgres timestamptz, no fraction', '2026-07-23 12:00:00+00'],
    ['two-digit non-UTC offset', '2026-07-23 12:00:00-08'],
  ] as const)('still accepts a trusted %s', (_label, decidedAt) => {
    expect(evaluateAsk(eligibleCandidate(), { ...context, decidedAt }).decision).toBe('send');
  });

  it('is host-timezone independent: the same inputs decide identically under any TZ', () => {
    // The offset-less path was the only TZ-sensitive one; with it rejected, the
    // accepted forms must be pure. Asserting the property directly is cheaper
    // and more honest than re-running the suite under a second TZ.
    const decisions = ['2026-07-23', '2026-07-23T00:30:00+05:30', '2026-07-23T23:30:00-08:00'].map(
      (decidedAt) => evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-07-20' }), { ...context, decidedAt }),
    );
    expect(new Set(decisions.map((d) => d.decision))).toEqual(new Set(['send']));
  });
});

// ---------------------------------------------------------------------------
// #555 item 2 — vertical stem collisions. A wrong vertical is a wrong freshness
// window, so these are wrong send/withhold decisions, not cosmetic mislabels.
// ---------------------------------------------------------------------------

describe('resolveVertical — stem collisions (#555)', () => {
  it('maps a barre studio to fitness (21d), not food_and_drink via the "bar" stem', () => {
    expect(resolveVertical('Barre Studio')).toEqual({ vertical: 'fitness', matchedKeyword: 'barre' });
    expect(FRESHNESS_WINDOW_DAYS[resolveVertical('Barre Studio').vertical]).toBe(21);
  });

  it('maps a pesto kitchen to food_and_drink (14d), not home_services via the "pest" stem', () => {
    expect(resolveVertical('Pesto Kitchen').vertical).toBe('food_and_drink');
    expect(FRESHNESS_WINDOW_DAYS[resolveVertical('Pesto Kitchen').vertical]).toBe(14);
  });

  it.each([
    ['Sparkle Space Storage', 'spa'],
    ['Brown Sugar Diner', 'brow'],
    ['Public Storage Depot', 'pub'],
    ['Delivery Logistics Inc', 'deli'],
    ['Marketing Agency', 'market'],
    ['Bargain Barn', 'bar'],
  ] as const)('%s no longer matches the "%s" stem', (category, keyword) => {
    expect(resolveVertical(category).matchedKeyword).not.toBe(keyword);
  });

  it.each([
    ['Corner Sports Bar', 'food_and_drink', 'bar'],
    ['Wine Bars of Napa', 'food_and_drink', 'bar'],
    ['Reliable Pest Control', 'home_services', 'pest'],
    ['Serenity Day Spa', 'personal_care', 'spa'],
    ['Arched Brow Studio', 'personal_care', 'brow'],
    ['The Corner Pub', 'food_and_drink', 'pub'],
    ['Katz Deli', 'food_and_drink', 'deli'],
    ['Farmers Market', 'retail', 'market'],
    ['Fadeaway Barber Shop', 'personal_care', 'barber'],
    ['Kitchen Remodel Pros', 'home_services', 'remodel'],
  ] as const)('%s still resolves to %s via "%s"', (category, vertical, keyword) => {
    expect(resolveVertical(category)).toEqual({ vertical, matchedKeyword: keyword });
  });
});

// ---------------------------------------------------------------------------
// #555 item 3 — the three gaps the post-merge review of #551 named.
// ---------------------------------------------------------------------------

describe('gaps closed (#555 item 3)', () => {
  it('asserts velocity_banked.ordering_basis exactly, not just its presence', () => {
    // home_services (45d) so every generated visit stays inside the window and
    // the ONLY withhold is the velocity gate.
    const roomyContext = { ...context, businessCategory: 'Reliable Pest Control' };
    const daysBeforeDecision = (days: number): string =>
      new Date(Date.UTC(2026, 6, 23) - days * 86_400_000).toISOString().slice(0, 10);

    const candidates = Array.from({ length: BATCH_CAP + 1 }, (_unused, index) =>
      eligibleCandidate({
        contactId: `01980000-0000-7000-8000-${String(index).padStart(12, '0')}`,
        // index 0 is the OLDEST visit, so it is the one banked.
        lastVisitDate: daysBeforeDecision(BATCH_CAP - index),
      }),
    );
    const banked = evaluateBatch(candidates, roomyContext).filter(
      (decision) => decision.decision === 'withhold' && decision.reason === 'velocity_banked',
    );

    expect(banked).toHaveLength(1);
    expect(banked[0]).toMatchObject({
      reason: 'velocity_banked',
      batch_cap: BATCH_CAP,
      eligible_count: BATCH_CAP + 1,
      ordering_basis: {
        last_visit_date: daysBeforeDecision(BATCH_CAP),
        contact_id: '01980000-0000-7000-8000-000000000000',
      },
    });
    expect(Object.keys((banked[0] as { ordering_basis: object }).ordering_basis).sort())
      .toEqual(['contact_id', 'last_visit_date']);
  });

  // The runtime property test above can only inspect values that exist; it
  // cannot notice a rating field being ADDED to the input type later. This
  // fails `pnpm typecheck` if one ever is (ADR 0012).
  it('is sentiment-blind at the TYPE level, not only in serialized output', () => {
    type SentimentBearingKey =
      | 'rating' | 'starRating' | 'star_rating' | 'stars'
      | 'sentiment' | 'sentimentLabel' | 'sentiment_label' | 'sentimentScore'
      | 'reviewText' | 'review_text' | 'reviewContent' | 'comment';
    type AssertSentimentBlind<T> = Extract<keyof T, SentimentBearingKey> extends never ? true : never;

    const candidateIsBlind: AssertSentimentBlind<AskCandidate> = true;
    const matchedReviewIsBlind: AssertSentimentBlind<NonNullable<AskCandidate['matchedReview']>> = true;
    const contextIsBlind: AssertSentimentBlind<BatchContext> = true;

    expect([candidateIsBlind, matchedReviewIsBlind, contextIsBlind]).toEqual([true, true, true]);
  });

  it('sends when the last visit is today (days_since_visit 0, the lower boundary)', () => {
    const decision = evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-07-23' }), context);
    expect(decision.decision).toBe('send');
  });

  it('sends when the last visit is exactly the freshness window away (upper boundary)', () => {
    // 'Coffee shop' → food_and_drink, 14d. 2026-07-09 is exactly 14 days before.
    const decision = evaluateAsk(eligibleCandidate({ lastVisitDate: '2026-07-09' }), context);
    expect(decision.decision).toBe('send');
  });
});
