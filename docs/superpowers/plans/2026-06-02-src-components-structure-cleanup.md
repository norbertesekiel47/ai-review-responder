# `src/components/` Structure Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/components/` per the approved convention (codified
shared-ness split), add a zero-dependency `cn()` helper, and write the convention
down — all behavior-preserving (file moves + import rewrites only).

**Architecture:** Mechanical refactor. Sequence: (1) write the convention so
structure has an owner, (2) add `cn()`, (3) flatten loose root files, (4)
normalize dashboard imports to absolute then break `components/dashboard/` into
sub-feature folders, (5) relocate stray providers/hooks, (6) standardize admin to
`_components`/`_hooks`, (7) convert convertible `../../` imports to `@/`. Each
task leaves the tree green (`lint`/`typecheck`/`test`/`build`) and is one commit.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), pnpm,
Vitest, `@/*` → `./src/*` path alias.

**Source of truth:** [`docs/superpowers/specs/2026-06-02-src-components-structure-design.md`](../specs/2026-06-02-src-components-structure-design.md). Read it before starting.

---

## Conventions for every task

- **Worktree:** execute in an isolated worktree (this plan lives in
  `.claude/worktrees/src-structure-spec`). Always include the worktree segment in
  file paths so edits don't hit `main`'s checkout.
- **Moves use `git mv`** (preserves history). After each move, rewrite importers,
  then run the **per-task gate** before committing.
- **Per-task gate (run from repo root):**
  ```bash
  pnpm typecheck && pnpm test && pnpm build
  ```
  `typecheck` is the deterministic oracle for missed import rewrites — it names
  the exact module path that no longer resolves. Fix each named specifier, re-run
  until green. `pnpm lint` runs in the final task (Task 14).
- **Import-rewrite recipe** (anchored on the trailing quote to avoid partial
  matches like `RankingChart` vs `RankingChart.helpers`):
  ```bash
  # macOS sed: the '' after -i is the required empty backup-suffix arg
  rg -l "@/components/dashboard/NAME'" src | xargs sed -i '' "s#@/components/dashboard/NAME'#@/components/dashboard/SUB/NAME'#g"
  ```
- **No new dependency, no barrel `index.ts`, no behavior change.** If a diff shows
  anything beyond a moved path or rewritten specifier, stop.

---

## Task 0: Pre-flight — baseline green + recover the convention doc

**Files:**
- Read: `docs/src-structure-preferences.md` (currently **untracked** in the user's
  main checkout at `/Users/norbertesekiel/Developer/startups/RepWorth`)

- [ ] **Step 1: Confirm a clean baseline**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. (If anything fails here, stop — it's pre-existing, not ours.)

- [ ] **Step 2: Bring the untracked convention draft into the branch**

The convention doc exists only in the user's main working tree. Copy it in so
Task 1 can edit it:
```bash
cp /Users/norbertesekiel/Developer/startups/RepWorth/docs/src-structure-preferences.md \
   docs/src-structure-preferences.md
```
Expected: file now present in the worktree. If the source doesn't exist, recreate
it from the spec's §3–§5 in Task 1 instead.

- [ ] **Step 3: Commit the baseline doc**

```bash
git add docs/src-structure-preferences.md
git commit -m "docs(structure): track src-structure-preferences before cleanup"
```

---

## Task 1: Write the convention (sequencing-first)

**Files:**
- Modify: `docs/src-structure-preferences.md` (resolve the "Open decision" checkbox)
- Modify: `docs/directory.md` (one-line pointer)

- [ ] **Step 1: Resolve the open decision in `src-structure-preferences.md`**

Replace the "Open decision" section (the unchecked `- [ ]` for convention A vs B)
with the resolved rule. Add a "Component placement rule" section containing,
verbatim from spec §3:

```markdown
## Component placement rule (decided 2026-06-02)

Placement is decided by **shared-ness**. Unit = a route leaf (a dir owning a `page.tsx`).

- **Page-specific glue for exactly one route leaf** (forms, per-entity panels,
  page-only layouts) → co-locate: `app/<area>/_components/` (+ route-only hooks in
  `app/<area>/_hooks/`).
- **Reusable domain UI** — feature cards, widgets, charts, shell chrome, or
  anything rendered by a shared `layout.tsx` / composed via a shared container →
  `components/<domain>/`, mirroring `lib/<domain>/`.
- **Domain-agnostic primitive** → `components/ui/`.

Co-located folders use the Next.js `_`-prefixed private-folder idiom
(`_components/`, `_hooks/`). A file graduates from `_components/` to
`components/<domain>/` only when a second route leaf consumes it.

**`cn()`:** use `@/lib/ui/cn` (zero-dep className joiner). No `clsx`/`tailwind-merge`.

**react-query:** scoped to `app/admin/**` + the few polling/approve spots. Customer
-facing prefers server-first; existing plain client fetches (e.g. `useDashboardData`)
are fine. react-query is NOT the default data layer.
```

- [ ] **Step 2: Add the pointer to `docs/directory.md`**

Add one line under the components section:
```markdown
- Component placement convention: see `docs/src-structure-preferences.md` → "Component placement rule".
```

- [ ] **Step 3: Commit**

```bash
git add docs/src-structure-preferences.md docs/directory.md
git commit -m "docs(structure): resolve component placement convention (A/B -> shared-ness rule)"
```

---

## Task 2: Add the `cn()` helper

**Files:**
- Create: `src/lib/ui/cn.ts`
- Test: `src/lib/ui/__tests__/cn.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/ui/__tests__/cn.test.ts
import { describe, it, expect } from 'vitest';
import { cn } from '@/lib/ui/cn';

describe('cn', () => {
  it('joins truthy class values with a single space', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });
  it('drops falsy values (false, null, undefined, empty string, 0)', () => {
    expect(cn('a', false, null, undefined, '', 0 as unknown as string, 'b')).toBe('a b');
  });
  it('supports conditional ternary composition', () => {
    const active = true;
    expect(cn('base', active && 'on', !active && 'off')).toBe('base on');
  });
  it('returns empty string when nothing is truthy', () => {
    expect(cn(false, null, undefined)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ui/__tests__/cn.test.ts`
Expected: FAIL — cannot resolve `@/lib/ui/cn`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/lib/ui/cn.ts
type ClassValue = string | number | false | null | undefined;

/** Join truthy class values into a single className string. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ui/__tests__/cn.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/cn.ts src/lib/ui/__tests__/cn.test.ts
git commit -m "feat(ui): add zero-dependency cn() className helper"
```

---

## Task 3: Flatten loose root file — `AdminNav`

**Files:**
- Move: `src/components/AdminNav.tsx` → `src/components/admin/AdminNav.tsx`

- [ ] **Step 1: Move the file**

```bash
git mv src/components/AdminNav.tsx src/components/admin/AdminNav.tsx
```

- [ ] **Step 2: Rewrite the importer** (1 importer, specifier `@/components/AdminNav`)

```bash
rg -l "@/components/AdminNav'" src | xargs sed -i '' "s#@/components/AdminNav'#@/components/admin/AdminNav'#g"
```

- [ ] **Step 3: Run the per-task gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. If typecheck names a leftover `@/components/AdminNav`, fix it and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(components): move AdminNav into components/admin/"
```

---

## Task 4: Flatten loose root file — `PlaceAutocomplete` → `components/places/`

**Files:**
- Move: `src/components/PlaceAutocomplete.tsx` → `src/components/places/PlaceAutocomplete.tsx`
- Move: `src/components/__tests__/PlaceAutocomplete.test.tsx` → `src/components/places/__tests__/PlaceAutocomplete.test.tsx`

Cross-domain shared (spec §6.1): consumed by onboarding, add-location, admin, API
routes, and `lib/`. All via specifier `@/components/PlaceAutocomplete` (10 component
importers + type-only importers of `PlaceSelection`).

- [ ] **Step 1: Move component + its test**

```bash
mkdir -p src/components/places/__tests__
git mv src/components/PlaceAutocomplete.tsx src/components/places/PlaceAutocomplete.tsx
git mv src/components/__tests__/PlaceAutocomplete.test.tsx src/components/places/__tests__/PlaceAutocomplete.test.tsx
```

- [ ] **Step 2: Rewrite all importers** (component AND `PlaceSelection` type)

```bash
rg -l "@/components/PlaceAutocomplete'" src | xargs sed -i '' "s#@/components/PlaceAutocomplete'#@/components/places/PlaceAutocomplete'#g"
```
Then confirm none remain: `rg "@/components/PlaceAutocomplete'" src` → expect no output.

- [ ] **Step 3: Fix the moved test's relative imports if any**

Run: `pnpm typecheck`
Expected: PASS. If the test imported a sibling via `../something`, typecheck names
it — repoint to `@/...`. Re-run until green.

- [ ] **Step 4: Run the rest of the gate**

Run: `pnpm test && pnpm build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(components): move PlaceAutocomplete to shared components/places/"
```

> Note: `PlaceSelection` (exported from the component) is consumed server-side.
> The export is preserved by this move. Hoisting the type to `lib/shared/schemas`
> is an explicit follow-up, **out of scope** for this plan.

---

## Task 5: Flatten loose root file — `DashboardContent`

**Files:**
- Move: `src/components/DashboardContent.tsx` → `src/components/dashboard/DashboardContent.tsx`

- [ ] **Step 1: Move the file**

```bash
git mv src/components/DashboardContent.tsx src/components/dashboard/DashboardContent.tsx
```

- [ ] **Step 2: Rewrite the importer** (1 importer, specifier `@/components/DashboardContent`)

```bash
rg -l "@/components/DashboardContent'" src | xargs sed -i '' "s#@/components/DashboardContent'#@/components/dashboard/DashboardContent'#g"
```

- [ ] **Step 3: Fix `DashboardContent`'s own now-relative imports**

`DashboardContent` previously sat at `components/` root and imported dashboard
units via `@/components/dashboard/...` (absolute) — those still resolve. Run:
`pnpm typecheck` → expect PASS. Fix any named specifier and re-run.

- [ ] **Step 4: Run the rest of the gate**

Run: `pnpm test && pnpm build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(components): move DashboardContent into components/dashboard/"
```

---

## Task 6: Normalize dashboard imports to absolute (breakup prep)

Make every reference to a `components/dashboard/` **root** unit absolute
(`@/components/dashboard/<Name>`) so the cluster moves in Tasks 7–12 are pure
specifier rewrites with zero relative-import breakage.

**Files:**
- Modify: same-dir relative imports inside `src/components/dashboard/*.tsx|*.ts`
- Modify: relative imports inside `src/components/dashboard/__tests__/*`

- [ ] **Step 1: Convert same-dir `./X` imports in root dashboard files to absolute**

```bash
# root-level .tsx/.ts files (not subfolders): './Name' -> '@/components/dashboard/Name'
for f in src/components/dashboard/*.tsx src/components/dashboard/*.ts; do
  sed -i '' -E "s#from '\\./([A-Za-z][A-Za-z0-9.]*)'#from '@/components/dashboard/\\1'#g" "$f"
done
```

- [ ] **Step 2: Convert `__tests__/` parent imports (`../X`) to absolute**

```bash
for f in src/components/dashboard/__tests__/*; do
  sed -i '' -E "s#from '\\.\\./([A-Za-z][A-Za-z0-9.]*)'#from '@/components/dashboard/\\1'#g" "$f"
done
```

- [ ] **Step 3: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS (pure import-form change, same modules). Fix any over-converted
path typecheck names (e.g. a `./subfolder/x` that shouldn't have matched) and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(dashboard): normalize intra-folder imports to @/ before breakup"
```

---

## Task 7: Dashboard cluster — `shell/`

Move app-chrome (layout-mounted reusable UI per spec §3). **`AuthenticatedProviders`
is NOT in this cluster** — it moves in Task 13.

**Files (move into `src/components/dashboard/shell/`):**
`Sidebar.tsx`, `TopBar.tsx`, `MobileTabBar.tsx`, `SettingsTabs.tsx`, `Icon.tsx`

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/components/dashboard/shell
for n in Sidebar TopBar MobileTabBar SettingsTabs Icon; do
  git mv "src/components/dashboard/$n.tsx" "src/components/dashboard/shell/$n.tsx"
done
```

- [ ] **Step 2: Rewrite specifiers repo-wide**

```bash
for n in Sidebar TopBar MobileTabBar SettingsTabs Icon; do
  rg -l "@/components/dashboard/$n'" src | xargs sed -i '' "s#@/components/dashboard/$n'#@/components/dashboard/shell/$n'#g"
done
```

- [ ] **Step 3: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. Fix any named leftover specifier (e.g. an intra-shell `./Icon`
that should now be `./Icon` within shell — already valid; or an external one missed
by the trailing-quote anchor) and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(dashboard): group shell chrome into dashboard/shell/"
```

---

## Task 8: Dashboard cluster — `kpi/` (+ helpers)

**Files (move into `src/components/dashboard/kpi/`):**
`KpiCards.tsx`, `ValueKpiGrid.tsx`, `Sparkline.tsx`, `VelocityCard.tsx`,
`RankingCard.tsx`, `RankingChart.tsx`, `IntelligenceBriefCard.tsx`,
`RankingChart.helpers.ts`, `brief-bullets.ts`

(`RankingChart.helpers` is used by `RankingChart`/`RankingCard`/`aggregate/`;
`brief-bullets` by `IntelligenceBriefCard`/`aggregate/` — both move with the cluster.)

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/components/dashboard/kpi
for n in KpiCards ValueKpiGrid Sparkline VelocityCard RankingCard RankingChart IntelligenceBriefCard; do
  git mv "src/components/dashboard/$n.tsx" "src/components/dashboard/kpi/$n.tsx"
done
git mv src/components/dashboard/RankingChart.helpers.ts src/components/dashboard/kpi/RankingChart.helpers.ts
git mv src/components/dashboard/brief-bullets.ts src/components/dashboard/kpi/brief-bullets.ts
```

- [ ] **Step 2: Rewrite specifiers repo-wide**

```bash
for n in KpiCards ValueKpiGrid Sparkline VelocityCard RankingCard RankingChart IntelligenceBriefCard "RankingChart.helpers" brief-bullets; do
  rg -l "@/components/dashboard/$n'" src | xargs sed -i '' "s#@/components/dashboard/$n'#@/components/dashboard/kpi/$n'#g"
done
```

- [ ] **Step 3: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. Fix any leftover specifier typecheck names and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(dashboard): group KPI cards + chart helpers into dashboard/kpi/"
```

---

## Task 9: Dashboard cluster — `reviews/` (+ `edit-reply/`)

**Files (move into `src/components/dashboard/reviews/`):**
`ReviewsCard.tsx`, `ReviewActions.tsx`, `PastReplyCard.tsx`, `EditReplyDrawer.tsx`,
and the existing `edit-reply/` subfolder → `reviews/edit-reply/`.

- [ ] **Step 1: Move the files + subfolder**

```bash
mkdir -p src/components/dashboard/reviews
for n in ReviewsCard ReviewActions PastReplyCard EditReplyDrawer; do
  git mv "src/components/dashboard/$n.tsx" "src/components/dashboard/reviews/$n.tsx"
done
git mv src/components/dashboard/edit-reply src/components/dashboard/reviews/edit-reply
```

- [ ] **Step 2: Rewrite specifiers repo-wide** (components + the edit-reply/ prefix)

```bash
for n in ReviewsCard ReviewActions PastReplyCard EditReplyDrawer; do
  rg -l "@/components/dashboard/$n'" src | xargs sed -i '' "s#@/components/dashboard/$n'#@/components/dashboard/reviews/$n'#g"
done
# edit-reply/ moved one level deeper — rewrite the folder prefix (note trailing slash, no closing quote)
rg -l "@/components/dashboard/edit-reply/" src | xargs sed -i '' "s#@/components/dashboard/edit-reply/#@/components/dashboard/reviews/edit-reply/#g"
```

- [ ] **Step 3: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. The `edit-reply/` internal files import each other via
`@/components/dashboard/edit-reply/*` (absolute, now rewritten) — verify typecheck
is clean; fix any named leftover and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(dashboard): group reviews UI + edit-reply drawer into dashboard/reviews/"
```

---

## Task 10: Dashboard cluster — `account-state/` (+ `billing-portal`)

**Files (move into `src/components/dashboard/account-state/`):**
`AccountStateScreens.tsx`, `SubscriptionStatusBanner.tsx`, `HistoricalUpgradeBanner.tsx`,
`ConnectGoogleBanner.tsx`, `PastDueModal.tsx`, `PendingPaymentScreen.tsx`,
`PendingAdminHandoffScreen.tsx`, `billing-portal.ts`

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/components/dashboard/account-state
for n in AccountStateScreens SubscriptionStatusBanner HistoricalUpgradeBanner ConnectGoogleBanner PastDueModal PendingPaymentScreen PendingAdminHandoffScreen; do
  git mv "src/components/dashboard/$n.tsx" "src/components/dashboard/account-state/$n.tsx"
done
git mv src/components/dashboard/billing-portal.ts src/components/dashboard/account-state/billing-portal.ts
```

- [ ] **Step 2: Rewrite specifiers repo-wide**

```bash
for n in AccountStateScreens SubscriptionStatusBanner HistoricalUpgradeBanner ConnectGoogleBanner PastDueModal PendingPaymentScreen PendingAdminHandoffScreen billing-portal; do
  rg -l "@/components/dashboard/$n'" src | xargs sed -i '' "s#@/components/dashboard/$n'#@/components/dashboard/account-state/$n'#g"
done
```

- [ ] **Step 3: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. Fix any leftover specifier and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(dashboard): group account-state screens/banners into dashboard/account-state/"
```

---

## Task 11: Dashboard clusters — `channels/` and `location/`

**Files:**
- Into `src/components/dashboard/channels/`: `OwnerTelegramWidget.tsx`,
  `OwnerWhatsAppWidget.tsx`, `ComingSoonChannelRow.tsx`
- Into `src/components/dashboard/location/`: `LocationPicker.tsx`

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/components/dashboard/channels src/components/dashboard/location
for n in OwnerTelegramWidget OwnerWhatsAppWidget ComingSoonChannelRow; do
  git mv "src/components/dashboard/$n.tsx" "src/components/dashboard/channels/$n.tsx"
done
git mv src/components/dashboard/LocationPicker.tsx src/components/dashboard/location/LocationPicker.tsx
```

- [ ] **Step 2: Rewrite specifiers repo-wide**

```bash
for n in OwnerTelegramWidget OwnerWhatsAppWidget ComingSoonChannelRow; do
  rg -l "@/components/dashboard/$n'" src | xargs sed -i '' "s#@/components/dashboard/$n'#@/components/dashboard/channels/$n'#g"
done
rg -l "@/components/dashboard/LocationPicker'" src | xargs sed -i '' "s#@/components/dashboard/LocationPicker'#@/components/dashboard/location/LocationPicker'#g"
```

- [ ] **Step 3: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. Fix any leftover specifier and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(dashboard): group channel widgets + location picker into subfolders"
```

---

## Task 12: Relocate shared dashboard hooks to `src/hooks/`

Per spec §6.2, grep revealed these are shared, not single-component:

- `useCountUp.ts` — used by `ValueKpiGrid` **and** marketing `sections/landing`,
  `sections/features` → genuinely cross-area shared.
- `useNeedsActionHashScroll.ts` — used by `DashboardContent` + `aggregate/` →
  dashboard-shared (matches existing `src/hooks/useDashboardData.ts` placement).

**Files:**
- Move: `src/components/dashboard/useCountUp.ts` → `src/hooks/useCountUp.ts`
- Move: `src/components/dashboard/useNeedsActionHashScroll.ts` → `src/hooks/useNeedsActionHashScroll.ts`

- [ ] **Step 1: Move the hooks**

```bash
git mv src/components/dashboard/useCountUp.ts src/hooks/useCountUp.ts
git mv src/components/dashboard/useNeedsActionHashScroll.ts src/hooks/useNeedsActionHashScroll.ts
```

- [ ] **Step 2: Rewrite specifiers repo-wide** (now under `@/hooks/`)

```bash
rg -l "@/components/dashboard/useCountUp'" src | xargs sed -i '' "s#@/components/dashboard/useCountUp'#@/hooks/useCountUp'#g"
rg -l "@/components/dashboard/useNeedsActionHashScroll'" src | xargs sed -i '' "s#@/components/dashboard/useNeedsActionHashScroll'#@/hooks/useNeedsActionHashScroll'#g"
```

- [ ] **Step 3: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. Fix any leftover specifier and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(hooks): move shared useCountUp + useNeedsActionHashScroll to src/hooks/"
```

---

## Task 13: Relocate the two stray providers

Both are mounted by `app/(authenticated)/layout.tsx` (spec §6.3). Targets are
**decisive** — do NOT use `dashboard/shell/`.

**Files:**
- Move: `src/components/dashboard/PendingCountContext.tsx` → `src/contexts/PendingCountContext.tsx`
- Move: `src/components/dashboard/AuthenticatedProviders.tsx` → `src/app/(authenticated)/_components/AuthenticatedProviders.tsx`

- [ ] **Step 1: Move the files**

```bash
mkdir -p "src/app/(authenticated)/_components"
git mv src/components/dashboard/PendingCountContext.tsx src/contexts/PendingCountContext.tsx
git mv src/components/dashboard/AuthenticatedProviders.tsx "src/app/(authenticated)/_components/AuthenticatedProviders.tsx"
```

- [ ] **Step 2: Rewrite specifiers repo-wide**

```bash
rg -l "@/components/dashboard/PendingCountContext'" src | xargs sed -i '' "s#@/components/dashboard/PendingCountContext'#@/contexts/PendingCountContext'#g"
rg -l "@/components/dashboard/AuthenticatedProviders'" src | xargs sed -i '' "s#@/components/dashboard/AuthenticatedProviders'#@/app/(authenticated)/_components/AuthenticatedProviders'#g"
```

- [ ] **Step 3: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. `AuthenticatedProviders` may import dashboard units via `@/`
(already rewritten by earlier tasks) — verify clean; fix any named leftover and re-run.

- [ ] **Step 4: Verify `components/dashboard/` root is now empty of loose files**

```bash
find src/components/dashboard -maxdepth 1 -type f
```
Expected: no output (only subfolders + `__tests__/` remain). If a stray remains,
it was missed above — place it per spec §3.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: move PendingCountContext to contexts/, AuthenticatedProviders to (authenticated)/_components/"
```

---

## Task 14: Standardize admin to `_components/` / `_hooks/`

Two route dirs have co-located `components/`+`hooks/` imported via relative
`./components/X` / `./hooks/X` (spec §6.5).

**Files:**
- Rename: `src/app/admin/businesses/[id]/components` → `.../[id]/_components`
- Rename: `src/app/admin/businesses/[id]/hooks` → `.../[id]/_hooks`
- Rename: `src/app/admin/businesses/new/components` → `.../new/_components`
- Rename: `src/app/admin/businesses/new/hooks` → `.../new/_hooks`

- [ ] **Step 1: Rename the folders**

```bash
git mv "src/app/admin/businesses/[id]/components" "src/app/admin/businesses/[id]/_components"
git mv "src/app/admin/businesses/[id]/hooks" "src/app/admin/businesses/[id]/_hooks"
git mv "src/app/admin/businesses/new/components" "src/app/admin/businesses/new/_components"
git mv "src/app/admin/businesses/new/hooks" "src/app/admin/businesses/new/_hooks"
```

- [ ] **Step 2: Rewrite the relative importers within each route dir**

```bash
rg -l "from '\./components/|from '\./hooks/" "src/app/admin/businesses/[id]" "src/app/admin/businesses/new" \
  | xargs sed -i '' -E "s#from '\\./components/#from './_components/#g; s#from '\\./hooks/#from './_hooks/#g"
```

- [ ] **Step 3: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. The `_components/__tests__/*` files use `../../types` (depth
unchanged by the rename) — should stay valid. Fix any named leftover and re-run.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(admin): standardize co-located dirs to _components/_hooks"
```

---

## Task 15: Convert convertible `../../` imports to `@/`

Only **within-`src/`** parent-relative imports. The `../../…/worker/…` crossings
stay relative (no alias — `@/*` → `./src/*` only).

**Files (exact convertible set):**
- `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts` — `../../_shared/edit-reply-errors`, `../../_shared/schemas`
- `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts` — `../../_shared/edit-reply-errors`
- `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts` — `../../_shared/edit-reply-errors`
- `src/app/admin/businesses/[id]/_components/__tests__/ZernioConnectionPanel.test.tsx` — `../../types`
- `src/lib/shared/__tests__/migration-046-analytics-events.test.ts` — `../../analytics/events`
- `src/lib/shared/__tests__/email-headers.test.ts` — `../../notifications/email`
- `src/lib/zernio/client/__tests__/locations.test.ts` — `../../types`
- `src/lib/notifications/email/templates/approval.ts` — `../../channels/template-prefix`
- `src/lib/notifications/__tests__/resolve-channels.test.ts` — `../../shared/ids` (×2)

- [ ] **Step 1: Rewrite each convertible specifier to its `@/` form**

Resolve each `../../X` against its file's directory and replace with the absolute
alias. Concretely:
```bash
# lib/* ones map to @/lib/*
sed -i '' "s#from '../../analytics/events'#from '@/lib/analytics/events'#g" src/lib/shared/__tests__/migration-046-analytics-events.test.ts
sed -i '' "s#from '../../notifications/email'#from '@/lib/notifications/email'#g" src/lib/shared/__tests__/email-headers.test.ts
sed -i '' "s#from '../../types'#from '@/lib/zernio/types'#g" src/lib/zernio/client/__tests__/locations.test.ts
sed -i '' "s#from '../../channels/template-prefix'#from '@/lib/notifications/channels/template-prefix'#g" src/lib/notifications/email/templates/approval.ts
sed -i '' "s#from '../../shared/ids'#from '@/lib/shared/ids'#g" src/lib/notifications/__tests__/resolve-channels.test.ts
# app/api _shared ones (resolve ../../_shared relative to the route file)
sed -i '' "s#from '../../_shared/edit-reply-errors'#from '@/app/api/dashboard/past-replies/_shared/edit-reply-errors'#g; s#from '../../_shared/schemas'#from '@/app/api/dashboard/past-replies/_shared/schemas'#g" \
  "src/app/api/dashboard/past-replies/draft/[responseId]/route.ts" \
  "src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts" \
  "src/app/api/dashboard/past-replies/[responseId]/retry/route.ts"
sed -i '' "s#from '../../types'#from '@/app/admin/businesses/[id]/types'#g" "src/app/admin/businesses/[id]/_components/__tests__/ZernioConnectionPanel.test.tsx"
```
> Note: confirm each resolved target before running by checking the file exists
> (e.g. `ls src/lib/zernio/types.ts` vs `src/lib/zernio/client/types.ts`). If a
> path resolves differently, adjust the `@/` target. `typecheck` (Step 2) is the
> backstop.

- [ ] **Step 2: Run the gate**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. If a converted path is wrong, typecheck names it — correct the
target and re-run.

- [ ] **Step 3: Confirm worker-crossings were left alone**

```bash
rg "from '\.\./\.\." src | rg worker
```
Expected: the `worker/` crossings still present (intentionally relative).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor(imports): convert within-src ../../ imports to @/ aliases"
```

---

## Task 16: Final verification + React Doctor regression + PR

- [ ] **Step 1: Full gate including lint**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS.

- [ ] **Step 2: React Doctor regression check**

Run the project's React Doctor scan (via the `react-doctor` skill / `pnpm` script).
Expected: score does **not** drop vs the pre-cleanup baseline (bundle/a11y/arch).
If it dropped, a move introduced a regression — investigate before proceeding.

- [ ] **Step 3: Confirm the change is moves-only**

```bash
git diff --stat origin/main...HEAD | tail -5
git log --oneline origin/main..HEAD
```
Expected: diff is dominated by renames (`R` status) + import-line changes; new
files limited to `src/lib/ui/cn.ts` (+test), `src/components/dashboard/<sub>/`
folders, and doc updates. No new dependency in `package.json`, no `index.ts` barrels.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin worktree-src-structure-spec
gh pr create --base main --title "refactor(components): codify placement convention + targeted src/components cleanup" \
  --body "Implements docs/superpowers/specs/2026-06-02-src-components-structure-design.md. Behavior-preserving: file moves + import rewrites + zero-dep cn() helper. CI must be green."
```
Expected: PR opened with the 4 CI checks (lint/typecheck/test/build) running.
This is **UI/structure only** (no worker/webhook/migration/billing) → straight to
`main` via PR; no staging lane required. After merge, fast-forward `staging` onto
`main` per the runbook.

---

## Self-review notes (coverage of spec §6)

- §6.1 loose files → Tasks 3 (AdminNav), 4 (PlaceAutocomplete→places), 5 (DashboardContent). ✓
- §6.2 dashboard breakup → Tasks 6 (normalize), 7 (shell), 8 (kpi+helpers), 9
  (reviews+edit-reply), 10 (account-state+billing-portal), 11 (channels+location),
  12 (shared hooks). Companions + `__tests__` covered (tests stay in
  `dashboard/__tests__/` with absolute imports auto-rewritten). ✓
- §6.3 stray providers → Task 13. ✓
- §6.4 convertible `../../` → Task 15 (worker-crossings intentionally excluded). ✓
- §6.5 admin `_components`/`_hooks` → Task 14. ✓
- §4 cn() → Task 2. §3/§5 convention written → Task 1. §7 gate → every task + Task 16. ✓
