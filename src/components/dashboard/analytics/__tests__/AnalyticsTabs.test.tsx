// @vitest-environment jsdom
//
// The Refusal Log eval — analytics tab bar (T0, red-first).
//
// The title is VERBATIM from the intake's `tests_to_add`; the `promised-tests`
// gate row matches it as a fixed string.
//
// `src/components/dashboard/analytics/AnalyticsTabs.tsx` does not exist at this
// commit — T6 creates it (routed tabs, plain `next/link`, mounted in both
// analytics views with a literal `active` prop), so this case is `it.todo`: a
// static import of a missing component fails the whole FILE at collection.
//
// House style to copy when the body lands:
// `src/components/dashboard/reviews/__tests__/ReviewsTabs.test.tsx` — mock
// `next/link` to a plain anchor, query by role, and assert both the `active`
// class and `aria-current="page"` on the current route (and their absence on
// the others).

import { describe, it } from 'vitest';

describe('AnalyticsTabs', () => {
  it.todo('the analytics tab bar marks the current route');
});
