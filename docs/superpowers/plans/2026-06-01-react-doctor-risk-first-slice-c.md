# React Doctor Slice C Correctness Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove high-confidence React Doctor correctness warnings without changing product behavior.

**Architecture:** Keep fixes data-derived and local. Add tiny pure helpers only where repeated key derivation would otherwise drift across demo/dashboard surfaces. Defer state-reset and hook-dependency findings where the current code is intentionally mount-only or lacks a proven behavior-preserving rewrite.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Vitest, React Testing Library, React Doctor.

---

## Scope

Fix:

- `react-doctor/no-array-index-as-key` and `react-doctor/no-array-index-key` where a stable unique key is available or can be derived safely.
- `react-doctor/rendering-hydration-mismatch-time` in the onboarding demo and landing footer.
- `react-doctor/no-uncontrolled-input` in `FinishSignupClient`.
- `react-doctor/prefer-use-effect-event` for `PlaceAutocomplete`, where the callback is only read by the Google web component event handler.

Defer:

- `no-adjust-state-on-prop-change`, `no-derived-useState`, and `no-derived-state-effect` unless a focused stale-UI bug is proven during this slice.
- `exhaustive-deps` findings in mount-only flows (`StepLocation`, `LoginForm`, `useLocationVoiceForm`, `FeaturesContent`, `TopBar`) because naive dependency additions would rerun redirects, fetches, or timer setup.
- Static placeholder dots created by `Array.from({ length })`, which React Doctor already mostly treats as positional placeholders.
- `TickerBar`'s static tile key: the key itself is trivial, but touching the file surfaces a pre-existing `no-adjust-state-on-prop-change` error in its visibility hook. Leave that file to a focused state/effect slice instead of mixing it into key cleanup.

## Files

- Create: `src/lib/reviews/stable-key.ts`
- Create: `src/lib/reviews/__tests__/stable-key.test.ts`
- Modify: `src/app/(public)/demo/[slug]/DemoViewerContent.tsx`
- Modify: `src/app/onboarding/demo/PaywallWithDemoClient.tsx`
- Modify: `src/components/dashboard/IntelligenceBriefCard.tsx`
- Modify: `src/components/dashboard/aggregate/AggregateIntelligenceBriefCard.tsx`
- Modify: `src/components/dashboard/PastReplyCard.tsx`
- Modify: `src/components/dashboard/settings/ListEditor.tsx`
- Modify: `src/components/dashboard/settings/__tests__/ListEditor.test.tsx`
- Modify: `src/app/(public)/book-a-demo/BookADemoContent.tsx`
- Modify: `src/app/(public)/pricing/PricingContent.tsx`
- Modify: `src/app/onboarding/_shared/OnboardingFunnelShell.tsx`
- Modify: `src/components/ui/PageShell.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`
- Modify: `src/components/sections/landing/LandingContent.tsx`
- Modify: `src/components/auth/FinishSignupClient.tsx`
- Modify: `src/components/auth/__tests__/FinishSignupClient.test.tsx`
- Modify: `src/components/PlaceAutocomplete.tsx`
- Modify: `src/components/__tests__/PlaceAutocomplete.test.tsx`

## Task 1: Shared Stable Review Keys

- [ ] **Step 1: Add tests for deterministic review keys**

Create `src/lib/reviews/__tests__/stable-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { NormalizedReview } from '../types';
import { getNormalizedReviewKey, getNormalizedReviewRows } from '../stable-key';

const baseReview: NormalizedReview = {
  reviewerName: 'Ari',
  starRating: 5,
  reviewText: 'Great service',
  reviewDate: '2026-05-01T00:00:00.000Z',
  detectedLanguage: 'en',
};

describe('stable review keys', () => {
  it('returns the same key for the same review content', () => {
    expect(getNormalizedReviewKey(baseReview)).toBe(getNormalizedReviewKey({ ...baseReview }));
  });

  it('adds an occurrence suffix so identical sibling reviews remain unique', () => {
    const rows = getNormalizedReviewRows([baseReview, { ...baseReview }]);
    expect(rows.map((row) => row.key)).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `pnpm exec vitest run src/lib/reviews/__tests__/stable-key.test.ts`

Expected: fail because `src/lib/reviews/stable-key.ts` does not exist.

- [ ] **Step 3: Add the pure key helper**

Create `src/lib/reviews/stable-key.ts`:

```ts
import type { NormalizedReview } from './types';

const SEPARATOR = '\u001f';

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function reviewIdentityInput(review: NormalizedReview): string {
  return [
    review.reviewerName,
    review.starRating,
    review.reviewText ?? '',
    review.reviewDate,
    review.detectedLanguage,
  ].join(SEPARATOR);
}

export function getNormalizedReviewKey(review: NormalizedReview, occurrence = 0): string {
  const base = `review-${hashString(reviewIdentityInput(review))}`;
  return occurrence === 0 ? base : `${base}-${occurrence}`;
}

export function getNormalizedReviewRows<T extends NormalizedReview>(
  reviews: T[],
): Array<{ key: string; review: T; index: number }> {
  const seen = new Map<string, number>();
  return reviews.map((review, index) => {
    const base = getNormalizedReviewKey(review);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return {
      key: occurrence === 0 ? base : `${base}-${occurrence}`,
      review,
      index,
    };
  });
}
```

- [ ] **Step 4: Verify the helper**

Run: `pnpm exec vitest run src/lib/reviews/__tests__/stable-key.test.ts`

Expected: pass.

## Task 2: Dynamic Product Keys

- [ ] **Step 1: Replace review index keys**

In `DemoViewerContent.tsx` and `PaywallWithDemoClient.tsx`, import `getNormalizedReviewRows`, derive `const reviewRows = getNormalizedReviewRows(reviews);`, and render `reviewRows.map(({ key, review, index }) => <ReviewCard key={key} ... />)`.

- [ ] **Step 2: Replace brief bullet index keys**

Add a local `getBriefBullets(text: string)` helper in `IntelligenceBriefCard.tsx` that returns `{ key, text }[]` using bullet text plus duplicate occurrence. Use the same helper from `AggregateIntelligenceBriefCard.tsx` by exporting it from the single-location file.

- [ ] **Step 3: Replace highlighted text index keys**

In `PastReplyCard.tsx`, change `highlight()` so it tracks duplicate text parts and uses keys like `mark-<part>-<occurrence>` or `text-<part>-<occurrence>` instead of `i`.

- [ ] **Step 4: Replace `ListEditor` row index keys with row IDs**

In `ListEditor.tsx`, keep the public `items: string[]` API. Add a ref-backed row key list so add/remove operations preserve row identity:

```ts
const nextKeyRef = useRef(0);
const itemKeysRef = useRef<string[]>([]);
```

Build rows as `{ key, value, index }`, splice `itemKeysRef.current` in `remove`, append a new key in `add`, and keep `update` keyed by the row index.

- [ ] **Step 5: Add a ListEditor regression test**

In `ListEditor.test.tsx`, add a test that renders `['first', 'second']`, removes the first row, rerenders with `['second']`, and asserts the remaining input still displays `second`.

- [ ] **Step 6: Verify dynamic key changes**

Run: `pnpm exec vitest run src/lib/reviews/__tests__/stable-key.test.ts src/components/dashboard/settings/__tests__/ListEditor.test.tsx src/app/(public)/demo/[slug]/__tests__/DemoViewerContent.test.tsx`

Expected: pass.

## Task 3: Trivial Static Key Replacements

- [ ] **Step 1: Replace obvious static keys**

Use existing unique strings:

- `BookADemoContent`: `bullet`, `signal`
- `PricingContent`: `section-${row.section}`, `feature-${row.label}`
- `OnboardingFunnelShell`: `card.className`
- `PageShell`: `card.className`
- `FeaturesContent`: use words, metric labels, and add a `loop` marker for duplicated marquee reviews.

- [ ] **Step 2: Run a React Doctor diff spot-check**

Run: `pnpm exec react-doctor --verbose --diff --no-score`

Expected: the touched `no-array-index-*` warnings are gone; unrelated touched-file warnings may remain and must be documented if deferred.

## Task 4: Hydration And Read-Only Input

- [ ] **Step 1: Fix onboarding demo stale age**

Move `Date.now()` out of JSX in `PaywallWithDemoClient.tsx` by setting `nowMs` in `useEffect`. Render the stale banner only when `nowMs !== null`.

- [ ] **Step 2: Suppress intentional footer year divergence**

In `LandingContent.tsx`, add `suppressHydrationWarning` to the footer year span because the current year is intentional time-dependent footer copy.

- [ ] **Step 3: Mark disabled signup email input read-only**

In `FinishSignupClient.tsx`, add `readOnly` to the disabled email input.

- [ ] **Step 4: Add signup input regression coverage**

In `FinishSignupClient.test.tsx`, assert the email input is disabled and read-only.

- [ ] **Step 5: Verify hydration/input changes**

Run: `pnpm exec vitest run src/components/auth/__tests__/FinishSignupClient.test.tsx`

Expected: pass.

## Task 5: PlaceAutocomplete Effect Event

- [ ] **Step 1: Wrap `onPlaceSelect` with `useEffectEvent`**

In `PlaceAutocomplete.tsx`, import `useEffectEvent`, create `const onPlaceSelectEvent = useEffectEvent(onPlaceSelect);`, call that inside the `gmp-select` handler, and remove `onPlaceSelect` from the effect dependency array.

- [ ] **Step 2: Verify existing cleanup/select behavior**

Run: `pnpm exec vitest run src/components/__tests__/PlaceAutocomplete.test.tsx`

Expected: pass.

## Task 6: Full Verification

- [ ] **Step 1: Run focused tests**

Run all focused commands from Tasks 1, 2, 4, and 5.

- [ ] **Step 2: Run project verification**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec react-doctor --verbose --diff --no-score
```

Expected: lint, typecheck, tests, and React Doctor diff pass. If `pnpm build` repeats the known nested-worktree Next/Turbopack hang, stop the process and report build as inconclusive, not passing.

## Self-Review

- Spec coverage: covers Slice C dynamic keys, hydration-time warnings, concrete uncontrolled input, and one concrete hook dependency issue. Defers broad state-reset and mount-only dependency rewrites per the risk-first spec.
- Placeholder scan: no TODO/TBD placeholders.
- Type consistency: `getNormalizedReviewRows()` returns key/review/index rows and is consumed by both review demo clients.
