// @vitest-environment jsdom
//
// `AnalyticsTabs` — routed tab bar eval (#1014 T1, RED).
//
// Title 55, VERBATIM from `.feature/intake.json` `tests_to_add`.
//
// `it.todo` at T1: `AnalyticsTabs.tsx` does not exist yet, and a named import
// of an absent module fails the whole file at collection. Task 6 harvests the
// component from `feat/refusal-log` and adds this body.
//
// THE TITLE PINS TWO THINGS AT ONCE, and both are deliberate. `aria-current`
// marks the active route because these are LINKS to two routes, not panels in
// one document — so `role="tab"` would promise arrow-key traversal of content
// that is not there. The precedent is `ReviewsTabs`.

import { describe, it } from 'vitest';

describe('AnalyticsTabs', () => {
  it.todo('AnalyticsTabs marks the active route with aria-current and uses no tab role');
});
