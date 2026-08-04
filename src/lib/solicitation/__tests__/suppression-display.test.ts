import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  SUPPRESSION_DISPLAY_COPY,
  SUPPRESSION_SCOPES,
  SUPPRESSION_SOURCES,
  toSuppressionDisplay,
} from '../suppression';

// The §7.4 display seam of the Suppression ledger (#645; locked spec
// docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §7.4).
//
// `toSuppressionDisplay` and `SUPPRESSION_DISPLAY_COPY` do not exist until
// Task 3, so this whole file is red at import time — that is the intended
// state of the eval task, not a defect.
//
// What the seam owes the owner surface, and what these tests pin:
//
//  1. HONEST COPY. A suppressed contact is reported as opted out, never as
//     "skipped" — a scheduling accident is not what happened, a person made a
//     decision (#622 §6.3).
//  2. OUTPUT CLOSURE. The returned object carries exactly four keys, so the
//     `account_id` provenance of a global row and its `source` cannot reach an
//     owner through this seam (§7.4's cross-tenant prohibition + FU-3,
//     invariant #8). Plan P-8: it is the OUTPUT shape that forbids leaking —
//     the narrow `{ scope }` input documents intent but TypeScript structural
//     typing still accepts a wider object in that position.
//  3. REVERSIBILITY. Only the owner's own account-scoped row is theirs to
//     clear (§7.6). A global row is the recipient's word, and removing one is
//     the admin-only audited Correction path.

describe('suppression display seam (§7.4)', () => {
  it('reports a suppressed contact as opted out of RepWorth review requests, never as skipped', () => {
    const display = toSuppressionDisplay({ scope: 'global' });
    expect(display?.label).toBe('Opted out of RepWorth review requests');
    expect(JSON.stringify(display).toLowerCase()).not.toContain('skipped');
  });

  it('never exposes the account_id provenance of a global row to an owner', () => {
    // The input type has no account_id field; this asserts the runtime shape
    // too, so a later widening of the parameter cannot leak through the mapper.
    const display = toSuppressionDisplay({ scope: 'global' });
    expect(Object.keys(display ?? {}).sort()).toEqual(
      ['clearableByOwner', 'detail', 'label', 'state'],
    );
  });

  it("distinguishes the owner's own account row from a global one, because only the former is reversible", () => {
    expect(toSuppressionDisplay({ scope: 'account' })?.clearableByOwner).toBe(true);
    expect(toSuppressionDisplay({ scope: 'global' })?.clearableByOwner).toBe(false);
    expect(toSuppressionDisplay({ scope: 'account' })?.label)
      .not.toBe(toSuppressionDisplay({ scope: 'global' })?.label);
  });

  it('global wins the display state when both a global and an account row match', () => {
    // G3 is enforced in SQL by suppressionMatchSql's ORDER BY, which returns at
    // most one row; the mapper's contract is that it faithfully renders
    // whichever row the fragment picked. This asserts the seam does not
    // second-guess it, and the live-DB proof of the ORDER BY itself lives in
    // suppression.integration.test.ts.
    expect(toSuppressionDisplay({ scope: 'global' })?.state).toBe('global');
  });

  it('returns null for a contact with no match', () => {
    expect(toSuppressionDisplay(null)).toBeNull();
    expect(toSuppressionDisplay(undefined)).toBeNull();
  });

  it('throws on a scope outside the closed enum rather than defaulting', () => {
    expect(() => toSuppressionDisplay({ scope: 'everyone' })).toThrow(/everyone/);
  });
});

describe('invariants', () => {
  it('invariant: every scope and source pair maps to exactly one display state and never carries account_id', () => {
    // What this proves is OUTPUT CLOSURE, not input impossibility (P-8): a
    // caller CAN hand this mapper a whole ledger row — TypeScript accepts a
    // wider object where `{ scope: string }` is expected — so the guarantee
    // that matters is that nothing beyond the four display keys survives the
    // mapping. Generate only LEGAL (Suppression scope, source) pairs: the G11
    // DB CHECK makes the illegal ones unreachable, and asserting behaviour on
    // rows the database cannot hold tests nothing.
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPRESSION_SCOPES),
        fc.constantFrom(...SUPPRESSION_SOURCES),
        fc.uuid(),
        (scope, candidateSource, accountId) => {
          // `owner_manual` is the one account-scoped source, and it is the one
          // source a global row may not carry — the one-directional pairing
          // CHECK 096 ships.
          const source = scope === 'account'
            ? 'owner_manual'
            : candidateSource === 'owner_manual' ? 'complaint' : candidateSource;
          // Deliberately NOT narrowed to `{ scope }` on the way in: passing a
          // whole ledger row is exactly what the output closure has to survive.
          const wholeRow = { scope, source, accountId, note: 'internal note' };

          const display = toSuppressionDisplay(wholeRow);

          expect(display).not.toBeNull();
          expect(Object.keys(display!).sort())
            .toEqual(['clearableByOwner', 'detail', 'label', 'state']);
          expect(display?.state).toBe(scope);
          expect(display?.clearableByOwner).toBe(scope === 'account');
          const serialized = JSON.stringify(display);
          expect(serialized).not.toContain(accountId);
          expect(serialized).not.toContain(source);
          expect(serialized).not.toContain('internal note');
          expect(display?.label).toBe(SUPPRESSION_DISPLAY_COPY[scope].label);
        },
      ),
    );
  });
});
