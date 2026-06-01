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
- `ListEditor` primitive row keys. A ref-backed local key array is fragile for same-length wholesale replacement; the correct fix is lifting identity into the parent-owned voice-list data model. That is too broad for this slice, so leave the existing index key and defer.
- SSR demo review feeds. They are non-reordered server-provided arrays, and a client-side review-key hash would fork the existing review-identity concept from `src/lib/reviews/types.ts`.
- Decorative hero-word and duplicated-marquee animation lists, where positional keys are correct because the arrays are static and never reorder.

## Files

- Create: `src/lib/shared/unique-sibling-key.ts`
- Create: `src/lib/shared/__tests__/unique-sibling-key.test.ts`
- Create: `src/components/dashboard/__tests__/brief-bullets.test.ts`
- Create: `src/components/dashboard/brief-bullets.ts`
- Modify: `src/components/dashboard/IntelligenceBriefCard.tsx`
- Modify: `src/components/dashboard/aggregate/AggregateIntelligenceBriefCard.tsx`
- Modify: `src/components/dashboard/PastReplyCard.tsx`
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

## Task 1: Shared Duplicate-Sibling Key Helper

- [ ] **Step 1: Add the helper and tests**

Create `src/lib/shared/unique-sibling-key.ts` and `src/lib/shared/__tests__/unique-sibling-key.test.ts`. The helper owns duplicate occurrence counting for all content-derived sibling keys in this slice.

- [ ] **Step 2: Verify the helper**

Run: `pnpm exec vitest run src/lib/shared/__tests__/unique-sibling-key.test.ts`

Expected: pass.

## Task 2: Dynamic Product Keys

- [ ] **Step 1: Replace brief bullet index keys**

Create `src/components/dashboard/brief-bullets.ts`, import `uniqueSiblingKey`, and use it from `IntelligenceBriefCard.tsx` and `AggregateIntelligenceBriefCard.tsx`.

- [ ] **Step 2: Add direct brief-bullet tests**

Create `src/components/dashboard/__tests__/brief-bullets.test.ts` covering markdown bullet stripping, numbered-line stripping, and duplicate key uniqueness.

- [ ] **Step 3: Replace highlighted text index keys**

In `PastReplyCard.tsx`, change `highlight()` so it uses `uniqueSiblingKey()` for mark/text parts instead of `i`. Keep the case-insensitive equality match, which avoids global-regex `lastIndex` state.

- [ ] **Step 4: Verify dynamic key changes**

Run: `pnpm exec vitest run src/lib/shared/__tests__/unique-sibling-key.test.ts src/components/dashboard/__tests__/brief-bullets.test.ts`

Expected: pass.

## Task 3: Trivial Static Key Replacements

- [ ] **Step 1: Replace obvious static keys**

Use existing unique strings:

- `BookADemoContent`: `bullet`, `signal`
- `PricingContent`: `section-${row.section}`, `feature-${row.label}`
- `OnboardingFunnelShell`: `card.className`
- `PageShell`: `card.className`
- `FeaturesContent`: metric labels only. Leave hero words and duplicated marquee rows on positional keys because those animation arrays are static and never reorder.

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
- Type consistency: `uniqueSiblingKey()` is the only duplicate-occurrence key helper; review demo feeds and primitive voice-list identity are deferred rather than solved with local identity forks.
