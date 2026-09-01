// @vitest-environment jsdom
//
// `RestraintReport` — presentation eval (#1014 T1, RED).
//
// Titles 37-47 and 49-54, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// All `it.todo` at T1: `RestraintReport.tsx` does not exist yet, and a named
// import of an absent module fails the whole file at collection. Task 8 adds
// the component, the import and these bodies.
//
// THIS COMPONENT OWNS EVERY OWNER-FACING SENTENCE, which is why seventeen
// titles land on one file. Three groups carry a trap each:
//
//   * LINKS. The tab links exactly three things and drops the link — never the
//     row — when a subject no longer resolves. The `policy_gate_held` title came
//     from plan round 1: `held_draft` and `policy_gate_held`'s
//     `moderation_flagged` BOTH map to `unsafe_content` and BOTH carry a
//     response subject, so link authority keyed on the Refusal category hands a
//     policy-gate row a held draft's review link. Authority is the server-
//     resolved `linkKind` (I14). The Refusal source never crosses the wire.
//
//   * CLAIMS. The empty window is window-scoped and makes no claim about all
//     time — #1000 retired the parked branch's absolute sentence permanently.
//     A populated window makes no such claim either, which is a separate test
//     because the two sentences have different authors in the component.
//
//   * RECONCILIATION. An account-wide suspension appears under every location
//     once each and once in the account total, so a per-location sum may
//     legitimately exceed the account total. CONTEXT.md requires the tab to
//     state WHICH number it shows (deviation D3).

import { describe, it } from 'vitest';

describe('RestraintReport', () => {
  // --- Grouping and ordering ---
  it.todo('RestraintReport groups rows under one owner sentence per category across categories with several rows each');
  it.todo('RestraintReport orders rows newest first within a category given an unsorted input');

  // --- The three links, and the two ways a row carries none ---
  it.todo('RestraintReport links a held draft to its review');
  it.todo('RestraintReport links an autonomy_paused row to the auto-approval settings');
  it.todo('RestraintReport links a no_permission row to the contacts list');
  it.todo('RestraintReport renders no link for a category that carries none');
  it.todo('RestraintReport keeps the row and drops only the link when the subject no longer resolves');
  it.todo("RestraintReport does not link a policy_gate_held response that shares held_draft's unsafe_content category");

  // --- Redaction (ADR 0023) ---
  it.todo('RestraintReport shows no draft text, review text or moderation reason for a held draft');

  // --- What the window does and does not claim ---
  it.todo('RestraintReport renders the window-scoped empty sentence and makes no claim about all time');
  it.todo('RestraintReport makes no claim about all time in a populated window');

  // --- The policy-gate disclosure, which is flag-driven (Coverage start) ---
  it.todo('RestraintReport renders the policy-gate disclosure line while auto-approval is disabled');
  it.todo('RestraintReport omits the policy-gate disclosure line while auto-approval is enabled');

  // --- Archived locations and archived periods ---
  it.todo('RestraintReport renders the archived-location footnote with no link and no instruction');
  it.todo('RestraintReport omits the archived-location footnote when the count is zero');
  it.todo('RestraintReport renders one archived-period line per intersecting period in a location view');

  // --- Which number this view shows (D3) ---
  it.todo('RestraintReport states which number it shows when an account-wide suspension is in the window');
});
