// @vitest-environment jsdom
//
// The Refusal Log eval — Restraint tab and page (T0, red-first).
//
// Titles are VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches them as fixed strings.
//
// Neither `src/components/dashboard/restraint/` nor
// `src/app/(authenticated)/dashboard/analytics/restraint/page.tsx` exists at
// this commit — T6 lands the route shell (loading branch ONLY, importing
// neither the route nor the screen, or T6's T0-only edge is false) and T7 lands
// the screen. Every case is `it.todo`: a static import of a missing component
// fails the whole FILE at collection and would run none of these.
//
// SHAPE THE BODIES MUST ASSUME (plan §4, §6 T7). The screen is pure
// presentation fed by ONE `RefusalLog` object, the way `BatchReport` is fed one
// `BatchView` — so the stated total and the category breakdown cannot disagree.
// Fetching, the window control and the scope live in the page.
//
// FOUR OF THESE ARE CONTRACT CASES, not cosmetics:
//   - the total/sum case is the reason the screen takes one object rather than
//     a count plus a list;
//   - the held-draft case asserts the ABSENCE of raw reason text — S1 is
//     deny-all RLS and redaction is the whole security story (plan §7 risk 1);
//   - the link cases pin the closed link table: held draft → its review,
//     autonomy_paused → /settings/auto-approval, no_permission → the contacts
//     list, and NO link for wrong_moment, below_our_bar, missing_information;
//   - the empty case is a plain sentence, never an error or an empty grid.

import { describe, it } from 'vitest';

describe('Restraint tab', () => {
  it.todo('the Restraint tab renders one owner sentence per category');

  it.todo('the Restraint tab total equals the sum of its category counts');

  it.todo('the Restraint tab lists entries newest first within each category');

  it.todo('the Restraint tab renders no raw reason text for a held draft');

  it.todo('the Restraint tab links a held-draft entry to its review');

  it.todo('the Restraint tab links an autonomy-paused entry to auto-approval settings');

  it.todo('the Restraint tab links a no-permission entry to the contacts list');

  it.todo('the Restraint tab renders no link for wrong_moment, below_our_bar and missing_information entries');

  it.todo('the Restraint tab offers the 7d 30d 90d and 12w windows');

  it.todo('the Restraint tab states the empty case as a sentence');
});

describe('Restraint page', () => {
  it.todo('the Restraint page requests the active aggregate or location scope');

  it.todo('the Restraint page renders SubscriptionUnavailableCard for a subscription without full access');
});
