// Property tests for the `policy_gate_held` precedence resolver — #1013 T1.
//
// Titles 10 and 11, VERBATIM from `.feature/intake.json` `tests_to_add`. The
// verify gate's `promised-tests` row matches on exact text, so a reworded title
// reads as an unwritten test.
//
// WHY PROPERTIES AND NOT MORE EXAMPLES. `.claude/commands/feature.md` requires
// at least one `fast-check` property per declared invariant for a feature
// touching approval / auto-approval logic, and this resolver is exactly that:
// its input is any SUBSET of 22 members in any ORDER, which is 22! orderings
// over 2^22 subsets. Examples cannot cover that space, and the two invariants
// below are precisely the ones an example set would under-sample — #1003's veto
// rule is a claim about EVERY position, and C5's membership rule is a claim
// about EVERY input.
//
// House style: `src/lib/reviews/__tests__/sentiment.test.ts`'s `invariants`
// describe block.
//
// NAMESPACE ACCESS for the exports T4 adds, on `vocabulary.test.ts`'s reasoning:
// a named import of an export that does not exist yet fails the FILE at
// collection, and a collection error reads as a broken suite rather than as two
// failing tests naming what is missing.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as vocabulary from '../../../../src/lib/refusals/vocabulary';

interface ResolvedRefusal {
  refusalCode: string;
  refusalCategory: string;
  allRefusalCodes: readonly string[];
}

function policyGateMap(): Readonly<Record<string, string | null>> {
  const map = (vocabulary as Record<string, unknown>).POLICY_GATE_HELD_REFUSAL_CATEGORIES;
  if (map === undefined) {
    throw new Error('POLICY_GATE_HELD_REFUSAL_CATEGORIES is not exported yet (#1013 T4)');
  }
  return map as Readonly<Record<string, string | null>>;
}

function blockPrecedence(): readonly string[] {
  const order = (vocabulary as Record<string, unknown>).AUTO_APPROVAL_BLOCK_PRECEDENCE;
  if (order === undefined) {
    throw new Error('AUTO_APPROVAL_BLOCK_PRECEDENCE is not exported yet (#1013 T4)');
  }
  return order as readonly string[];
}

function resolve(codes: readonly string[]): ResolvedRefusal | null {
  const fn = (vocabulary as Record<string, unknown>).resolvePolicyGateRefusal;
  if (typeof fn !== 'function') {
    throw new Error('resolvePolicyGateRefusal is not exported yet (#1013 T4)');
  }
  return (fn as (c: readonly string[]) => ResolvedRefusal | null)(codes);
}

/** DERIVED, never restated — a `null` value in the map IS the veto set. */
function vetoMembers(): readonly string[] {
  const map = policyGateMap();
  return Object.keys(map).filter((member) => map[member] === null);
}

/**
 * A non-empty subset of `pool`, in an ARBITRARY order.
 *
 * `fc.shuffledSubarray` rather than `fc.subarray`: `subarray` preserves the
 * source order, which would leave both properties tested only against inputs
 * already sorted by precedence — the one ordering a position-dependent bug
 * survives. Order is the whole point of both invariants.
 */
function nonEmptyShuffledSubset(pool: readonly string[]): fc.Arbitrary<string[]> {
  return fc.shuffledSubarray([...pool], { minLength: 1 });
}

describe('policy_gate_held precedence resolver', () => {
  it('invariants: any block reason set containing a veto member resolves to no Refusal', () => {
    const veto = vetoMembers();
    const precedence = blockPrecedence();

    // #1003: "null never competes in precedence. It removes the draft from the
    // ledger." The property is over POSITION as much as presence — a resolver
    // that ranked null members instead of vetoing would pass every example
    // whose veto member happened to sort first, and fail here.
    fc.assert(
      fc.property(
        fc.constantFrom(...veto),
        fc.shuffledSubarray([...precedence]),
        fc.nat(),
        (vetoMember, others, position) => {
          const codes = [...others];
          codes.splice(position % (codes.length + 1), 0, vetoMember);
          return resolve(codes) === null;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('invariants: a resolved winner is always a member of its own co-occurring set', () => {
    const precedence = blockPrecedence();
    const map = policyGateMap();

    // C5 enforces this in the DATABASE (`refusal_code = ANY(all_refusal_codes)`),
    // and a violation aborts the deciding transaction — the ledger breaking the
    // very decision it records. Proving it one layer up means a row can never be
    // rejected at INSERT for a resolver bug.
    //
    // The input is drawn from the precedence members ONLY, because a veto member
    // would make the expected result `null` and the property vacuous; the veto
    // case is the property above.
    fc.assert(
      fc.property(nonEmptyShuffledSubset(precedence), (codes) => {
        const resolved = resolve(codes);
        if (resolved === null) return false;
        return (
          resolved.allRefusalCodes.includes(resolved.refusalCode)
          // The set is the input VERBATIM, in its own order.
          && resolved.allRefusalCodes.length === codes.length
          && resolved.allRefusalCodes.every((code, index) => code === codes[index])
          // And the winner's category is the one the map assigns it, never a
          // category derived from the array's position.
          && resolved.refusalCategory === map[resolved.refusalCode]
        );
      }),
      { numRuns: 500 },
    );
  });
});
