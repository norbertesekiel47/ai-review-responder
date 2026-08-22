// The pure half of the Dispatch gate (#899 Task 0 — the eval task).
//
// `applyDispatchGate` is the SINGLE owner of amendment B6's seven-item ORDER
// and of the withheld-reason mapping. Both facts are pinned here and nowhere
// else: a second copy of the order is how a later item starts reporting before
// an earlier one, which is exactly the failure the property test below rules
// out across the whole evidence space rather than at one hand-picked point.
//
// NO DATABASE, no adapter, no clock. Every input is a plain evidence record —
// the fast items are gathered inside tx1 under the batch row lock, the slow
// items before tx1 opens (decision 3), and neither of those journeys is this
// module's business.
//
// This file is written BEFORE `../dispatch` exists. It fails with a module
// resolution error until Task 1 lands the pure gate; that failure is the point.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SEND_ELIGIBLE_ATTESTATION_VERSIONS } from '../attestation';
import {
  applyDispatchGate,
  type DispatchGateItem,
  type FastGateEvidence,
  type SlowGateEvidence,
} from '../dispatch';

/** B6's order, restated here as the ORACLE the gate is checked against. */
const GATE_ORDER: readonly DispatchGateItem[] = [
  'batch_open',
  'send_flag',
  'suppression',
  'consent',
  'postal_address',
  'lint',
  'moderation',
];

/** The one send-eligible attestation version today (`consent_attestation_v2`). */
const ELIGIBLE_VERSION: string = SEND_ELIGIBLE_ATTESTATION_VERSIONS[0];
/** Superseded — a consent row carrying it is NOT send-eligible (#620 §6.1). */
const INELIGIBLE_VERSION = 'consent_attestation_v1';
/** 093's only permitted `basis` value. */
const CONSENT_BASIS = 'owner_attested';
const CONSENT_ROW_ID = '2f7b6a1c-0000-4000-8000-0000000000c0';

const eligibleVersions: readonly string[] = [...SEND_ELIGIBLE_ATTESTATION_VERSIONS];

/**
 * Independent restatement of each item's pass predicate — deliberately NOT
 * imported from the module under test, or the property would compare the
 * implementation against itself.
 *
 * The last arm is unguarded rather than a `default: assertNever`: this oracle is
 * checked against `GATE_ORDER` above, which is typed `readonly
 * DispatchGateItem[]`, so an eighth item reaches this function only by way of a
 * list that a reader has to edit anyway.
 */
function itemPasses(
  item: DispatchGateItem,
  slow: SlowGateEvidence,
  fast: FastGateEvidence,
): boolean {
  if (item === 'batch_open') return fast.batchOpen;
  if (item === 'send_flag') return fast.sendFlagOn;
  if (item === 'suppression') return !fast.suppressed;
  if (item === 'consent') {
    return fast.consent !== null && eligibleVersions.includes(fast.consent.attestationVersion);
  }
  // ONE item, TWO reasons — absent and present-but-mismatched are different
  // facts, and only the reason mapping tells them apart.
  if (item === 'postal_address') return fast.postalAddressPresent && fast.postalAddressMatches;
  if (item === 'lint') return slow.lintPassed;
  return slow.moderationClean;
}

function firstFailingItem(
  slow: SlowGateEvidence,
  fast: FastGateEvidence,
): DispatchGateItem | null {
  return GATE_ORDER.find((item) => !itemPasses(item, slow, fast)) ?? null;
}

describe('applyDispatchGate', () => {
  it('evaluates the seven Dispatch gate items in B6 order and reports the first failure', () => {
    // Every item fails at once. Repairing them one at a time walks the gate
    // through its whole order: a single verdict cannot prove ordering, because
    // "reports batch_open" is also what a gate that only checks batch_open does.
    const slow: SlowGateEvidence = { lintPassed: false, moderationClean: false };
    const fast: FastGateEvidence = {
      batchOpen: false,
      sendFlagOn: false,
      suppressed: true,
      consent: null,
      postalAddressMatches: false,
      postalAddressPresent: false,
    };

    const reported: DispatchGateItem[] = [];
    const observe = (): void => {
      const verdict = applyDispatchGate(slow, fast);
      if (verdict.pass) throw new Error('expected the Dispatch gate to report a failure');
      reported.push(verdict.item);
    };

    // 1. batch_open — DEFER, never withhold: the halt sweep already cancelled
    //    the row, so there is nothing left for this child to decide.
    expect(applyDispatchGate(slow, fast)).toEqual({
      pass: false,
      item: 'batch_open',
      outcome: 'defer',
    });
    observe();
    fast.batchOpen = true;

    // 2. send_flag — DEFER (decision 5). 091/110 have no `flag_off` reason, and
    //    inventing one would terminalize a row the owner never withdrew.
    expect(applyDispatchGate(slow, fast)).toEqual({
      pass: false,
      item: 'send_flag',
      outcome: 'defer',
    });
    observe();
    fast.sendFlagOn = true;

    // 3. suppression — the first WITHHOLD.
    expect(applyDispatchGate(slow, fast)).toEqual({
      pass: false,
      item: 'suppression',
      outcome: 'withhold',
      reason: 'suppressed',
    });
    observe();
    fast.suppressed = false;

    // 4. consent — a missing row and a superseded attestation version are the
    //    SAME withheld reason; the gate does not distinguish them.
    expect(applyDispatchGate(slow, fast)).toEqual({
      pass: false,
      item: 'consent',
      outcome: 'withhold',
      reason: 'no_consent',
    });
    observe();
    fast.consent = {
      rowId: CONSENT_ROW_ID,
      basis: CONSENT_BASIS,
      attestationVersion: INELIGIBLE_VERSION,
    };
    expect(applyDispatchGate(slow, fast)).toEqual({
      pass: false,
      item: 'consent',
      outcome: 'withhold',
      reason: 'no_consent',
    });
    fast.consent = {
      rowId: CONSENT_ROW_ID,
      basis: CONSENT_BASIS,
      attestationVersion: ELIGIBLE_VERSION,
    };

    // 5. postal_address — ONE item, TWO reasons. Absent is a different fact
    //    from present-but-mismatched, and the owner-facing text differs.
    expect(applyDispatchGate(slow, fast)).toEqual({
      pass: false,
      item: 'postal_address',
      outcome: 'withhold',
      reason: 'no_postal_address',
    });
    observe();
    fast.postalAddressPresent = true;
    expect(applyDispatchGate(slow, fast)).toEqual({
      pass: false,
      item: 'postal_address',
      outcome: 'withhold',
      reason: 'postal_address_mismatch',
    });
    fast.postalAddressMatches = true;

    // 6. lint — re-lint of the stored bytes at the current ASK_LINT_VERSION.
    expect(applyDispatchGate(slow, fast)).toEqual({
      pass: false,
      item: 'lint',
      outcome: 'withhold',
      reason: 'lint_failed',
    });
    observe();
    slow.lintPassed = true;

    // 7. moderation — last, and never overwrites the render's moderation_status
    //    (decision 6); that is the orchestrator's obligation, not the gate's.
    expect(applyDispatchGate(slow, fast)).toEqual({
      pass: false,
      item: 'moderation',
      outcome: 'withhold',
      reason: 'moderation_high',
    });
    observe();
    slow.moderationClean = true;

    expect(applyDispatchGate(slow, fast)).toEqual({ pass: true });
    expect(reported).toEqual(GATE_ORDER);
  });
});

// Property tests (fast-check): the house style for invariant-level coverage —
// see `classifySentiment invariants` in src/lib/reviews/__tests__/sentiment.test.ts.
describe('Dispatch gate invariants', () => {
  const arbSlow: fc.Arbitrary<SlowGateEvidence> = fc.record({
    lintPassed: fc.boolean(),
    moderationClean: fc.boolean(),
  });

  const arbConsent = fc.option(
    fc.record({
      rowId: fc.uuid(),
      basis: fc.constant(CONSENT_BASIS),
      // Both send-eligible and superseded versions, plus a version nobody has
      // shipped: the allowlist is a membership test, not a "not v1" test.
      attestationVersion: fc.constantFrom(
        ELIGIBLE_VERSION,
        INELIGIBLE_VERSION,
        'consent_attestation_v3',
      ),
    }),
    { nil: null },
  );

  const arbFast: fc.Arbitrary<FastGateEvidence> = fc.record({
    batchOpen: fc.boolean(),
    sendFlagOn: fc.boolean(),
    suppressed: fc.boolean(),
    consent: arbConsent,
    postalAddressMatches: fc.boolean(),
    postalAddressPresent: fc.boolean(),
  });

  it('property: the Dispatch gate never reports a later item before an earlier one has passed', () => {
    fc.assert(
      fc.property(arbSlow, arbFast, (slow, fast) => {
        const verdict = applyDispatchGate(slow, fast);
        const expectedItem = firstFailingItem(slow, fast);

        if (expectedItem === null) {
          expect(verdict).toEqual({ pass: true });
          return;
        }

        expect(verdict.pass).toBe(false);
        if (verdict.pass) return;
        expect(verdict.item).toBe(expectedItem);

        // The ordering claim itself: everything ahead of the reported item in
        // B6's order has ALREADY passed. A gate that short-circuits on the
        // wrong item fails here even when its reason mapping is right.
        for (const earlier of GATE_ORDER.slice(0, GATE_ORDER.indexOf(verdict.item))) {
          expect(itemPasses(earlier, slow, fast)).toBe(true);
        }

        // The two defer items are the FIRST two, and no withhold item ever
        // returns `defer`: a deferred row stays `queued` and is retried, a
        // withheld row is terminal. Confusing them either strands a row or
        // terminalizes one the owner still owns.
        expect(verdict.outcome).toBe(
          verdict.item === 'batch_open' || verdict.item === 'send_flag' ? 'defer' : 'withhold',
        );
      }),
    );
  });
});
