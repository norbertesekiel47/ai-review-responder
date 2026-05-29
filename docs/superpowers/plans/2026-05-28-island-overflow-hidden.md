# Remove `overflow:hidden` from Island Roots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `overflow:hidden` from the two `.rw-island` CSS roots (marketing + auth) to fix the iOS Safari repaint bug, without letting any full-bleed child corner poke past the rounded island edge.

**Architecture:** Pure CSS change in two files, guarded by one Vitest contract test. The island roots combine `overflow:hidden` + `border-radius:48px` + a retained `transform`, which triggers an iOS Safari repaint bug (lost rounded clip + flickering fixed siblings during momentum scroll). Removing `overflow:hidden` fixes it; the only child that relied on the island to clip its corners — the auth `.rw-showcase` gradient pane — gets a compensating `border-radius` so it self-clips. A grep-style contract test locks in the "no `overflow:hidden` on island roots" rubric rule.

**Tech Stack:** Next.js 16, plain CSS (`globals.css` + a component-scoped `auth-island.css`), Vitest 4 (`fs`-read contract test, matching the existing `migration-NNN-structure.test.ts` pattern).

---

## Context the implementer needs

- **Two parallel island systems exist.** The audit (`docs/launch-ready-part2.md` P0 #7 / M4) targets the **CSS-class** islands, not `PageShell.tsx`:
  - `.rw-island` in `src/app/globals.css` → marketing pages (landing, features, how-it-works, pricing).
  - `.rw-island` in `src/components/auth/auth-island/auth-island.css` → auth pages (login, signup via `AuthIslandClient.tsx`).
  - `src/components/ui/PageShell.tsx` (book-a-demo, legal, security) is a **separate** Tailwind island that **already** omits `overflow-hidden` — do **not** touch it.
- **The fixed elements are siblings, not descendants.** In `LandingContent.tsx` the fixed `.rw-dot-nav` is a sibling of `.rw-island-wrap`; in `AuthIslandClient.tsx` the fixed `.rw-field` parallax is a sibling of `.rw-page`. So `overflow:hidden` never clipped them. What it clips is the island's **own children** to the corner radius — which is why we must preserve corner rounding for full-bleed children.
- **Marketing needs no rounding change** (verified by inspection): bottom corners are colored CTAs that already self-round (`.rw-cta` `border-radius: 0 0 48px 48px` at `globals.css:949`; `.hiw` CTA `0 0 3rem 3rem` at `:1815`; `.pr-cta` `0 0 3rem 3rem` at `:2331`); top corners are the white nav/hero.
- **Auth needs one rounding change**: `.rw-showcase` is a full-bleed left gradient pane on the island's left rounded corners. It must self-round its left corners once the island stops clipping.
- **Running tests from this nested worktree:** the guard test reads CSS as plain text and imports **no** app modules, so it is immune to the `CLAUDE.md` "module-resolution leak" warning and can be run locally. The verified invocation from the worktree root is `../../../node_modules/.bin/vitest run <file>` (no local `node_modules`; resolves to the parent repo's vitest binary). Defer full `lint`/`typecheck`/`test`/`build` to CI on push.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src/__tests__/island-overflow.test.ts` | Contract test: island roots never set `overflow:hidden` | **Create** |
| `src/app/globals.css` | Marketing island root | **Modify** (remove `overflow:hidden`) |
| `src/components/auth/auth-island/auth-island.css` | Auth island root + showcase pane | **Modify** (remove `overflow:hidden` from `.rw-island`; add `border-radius` to `.rw-showcase`) |

---

## Task 1: Guard test + remove `overflow:hidden` from both island roots

**Files:**
- Create: `src/__tests__/island-overflow.test.ts`
- Modify: `src/app/globals.css` (the `.rw-island` rule, ~line 120–128)
- Modify: `src/components/auth/auth-island/auth-island.css` (the `.rw-island` rule, line 67)

- [ ] **Step 1: Write the failing contract test**

Create `src/__tests__/island-overflow.test.ts` with exactly this content:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// P0 #7 / repworth-brand-design rubric: island ROOTS must never set
// `overflow: hidden`. On iOS Safari, `overflow:hidden` + `border-radius` + a
// retained `transform` (both roots have all three) triggers a repaint bug that
// drops the rounded clip and flickers fixed siblings during momentum scroll.
// The canonical PageShell.tsx island already omits it; this guard locks the
// same contract for the two CSS-class island roots.
const ISLAND_ROOTS = [
  {
    label: 'marketing .rw-island (globals.css)',
    path: resolve(process.cwd(), 'src/app/globals.css'),
  },
  {
    label: 'auth .rw-island (auth-island.css)',
    path: resolve(
      process.cwd(),
      'src/components/auth/auth-island/auth-island.css',
    ),
  },
];

// Extract the `.rw-island { ... }` rule block. The negative lookahead keeps
// this from matching `.rw-island-wrap` or the `rw-island-in` keyframe; the
// non-greedy body stops at the first closing brace (these blocks have no
// nested braces).
function extractIslandRule(css: string): string {
  const match = css.match(/\.rw-island(?![\w-])\s*\{([\s\S]*?)\}/);
  if (!match) {
    throw new Error('.rw-island rule block not found');
  }
  return match[1];
}

describe('island roots never set overflow:hidden (P0 #7, iOS Safari)', () => {
  it.each(ISLAND_ROOTS)(
    '$label does not declare overflow: hidden',
    ({ path }) => {
      const islandRule = extractIslandRule(readFileSync(path, 'utf-8'));
      expect(islandRule).not.toMatch(/overflow\s*:\s*hidden/);
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run (from the worktree root):

```bash
../../../node_modules/.bin/vitest run src/__tests__/island-overflow.test.ts
```

Expected: **2 failing assertions** — both `.rw-island` blocks currently contain `overflow: hidden`, so `expect(...).not.toMatch(/overflow\s*:\s*hidden/)` fails for each file.

- [ ] **Step 3: Remove `overflow:hidden` from the marketing island**

In `src/app/globals.css`, the `.rw-island` rule currently reads:

```css
.rw-island {
  width: 100%;
  max-width: 1200px;
  background: white;
  border-radius: 48px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  animation: rw-island-in 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94) both;
}
```

Delete the `  overflow: hidden;` line so it becomes:

```css
.rw-island {
  width: 100%;
  max-width: 1200px;
  background: white;
  border-radius: 48px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  animation: rw-island-in 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94) both;
}
```

- [ ] **Step 4: Remove `overflow:hidden` from the auth island**

In `src/components/auth/auth-island/auth-island.css`, the `.rw-island` rule (line 67) currently reads:

```css
.rw-island { width: 100%; max-width: 1080px; background: #fff; border-radius: 48px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); overflow: hidden; display: grid; grid-template-columns: 1.05fr 1fr; min-height: 680px; opacity: 0; transform: translateY(30px) scale(0.97); animation: rwIntro 0.8s cubic-bezier(0.25,0.46,0.45,0.94) forwards; }
```

Remove the `overflow: hidden;` segment so it becomes:

```css
.rw-island { width: 100%; max-width: 1080px; background: #fff; border-radius: 48px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); display: grid; grid-template-columns: 1.05fr 1fr; min-height: 680px; opacity: 0; transform: translateY(30px) scale(0.97); animation: rwIntro 0.8s cubic-bezier(0.25,0.46,0.45,0.94) forwards; }
```

- [ ] **Step 5: Run the test to verify it PASSES**

Run:

```bash
../../../node_modules/.bin/vitest run src/__tests__/island-overflow.test.ts
```

Expected: **2 passing tests** — `marketing .rw-island (globals.css) does not declare overflow: hidden` and `auth .rw-island (auth-island.css) does not declare overflow: hidden`.

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/island-overflow.test.ts src/app/globals.css src/components/auth/auth-island/auth-island.css
git commit -m "fix(ui): drop overflow:hidden from island roots (iOS Safari) + guard test

P0 #7 from launch-ready-part2 audit. overflow:hidden + border-radius +
retained transform triggers an iOS Safari repaint bug on the marketing and
auth island roots. Remove it (matching the canonical PageShell island) and
add a contract test locking the rubric rule.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Self-round the auth showcase pane (compensating change)

**Files:**
- Modify: `src/components/auth/auth-island/auth-island.css` (the `.rw-showcase` rule, line 72)

> **Why no unit test:** this is a visual corner-clipping detail, not a behavioral contract. Asserting an exact `border-radius` px value would be brittle and would break if the island radius ever changes. It is verified in Task 3's visual spot-check instead. (The Task 1 guard test must stay green — the showcase keeps its own `overflow:hidden`.)

- [ ] **Step 1: Add the left-corner radius to `.rw-showcase`**

In `src/components/auth/auth-island/auth-island.css`, the `.rw-showcase` rule (line 72) currently reads:

```css
.rw-showcase { position: relative; padding: 56px 52px; background: radial-gradient(ellipse at 20% 0%, rgba(242,195,185,0.55) 0%, transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(151,179,174,0.55) 0%, transparent 55%), linear-gradient(160deg, #f0eeea 0%, #ffffff 60%, #f0ddd6 100%); display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
```

Add `border-radius: 48px 0 0 48px;` immediately after `position: relative;` (keep the existing `overflow: hidden;`, which still clips the floating review cards within the pane):

```css
.rw-showcase { position: relative; border-radius: 48px 0 0 48px; padding: 56px 52px; background: radial-gradient(ellipse at 20% 0%, rgba(242,195,185,0.55) 0%, transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(151,179,174,0.55) 0%, transparent 55%), linear-gradient(160deg, #f0eeea 0%, #ffffff 60%, #f0ddd6 100%); display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
```

> The right `.rw-form-pane` is white (= island surface), so its corners are invisible and need no radius. On mobile (`≤900px`) `.rw-showcase` is `display:none` and the white form pane fills the island — corners stay clean.

- [ ] **Step 2: Confirm the guard test is still green**

Run:

```bash
../../../node_modules/.bin/vitest run src/__tests__/island-overflow.test.ts
```

Expected: **2 passing tests** (unchanged — this step touches only `.rw-showcase`, not `.rw-island`).

- [ ] **Step 3: Commit**

```bash
git add src/components/auth/auth-island/auth-island.css
git commit -m "fix(ui): round auth .rw-showcase left corners to island radius

Compensates for removing overflow:hidden from the auth .rw-island: the
full-bleed gradient pane now self-clips the island's left rounded corners.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Push, CI validation, and visual spot-check

**Files:** none (verification only).

- [ ] **Step 1: Push the branch and open a PR**

```bash
git push -u origin worktree-fix-island-overflow-hidden
gh pr create --base main --title "fix(ui): remove overflow:hidden from island roots (P0 #7)" \
  --body "$(cat <<'EOF'
Removes `overflow:hidden` from the marketing (`globals.css`) and auth
(`auth-island.css`) `.rw-island` roots to fix the iOS Safari repaint bug
(`overflow:hidden` + `border-radius` + retained `transform`), per
launch-ready-part2 audit P0 #7 / M4.

- Marketing corners unchanged (bottom CTAs already self-round; top is white).
- Auth `.rw-showcase` gets `border-radius: 48px 0 0 48px` so the gradient pane
  self-clips the left rounded corners it no longer relies on the island for.
- Adds a contract test (`src/__tests__/island-overflow.test.ts`) locking the
  rubric rule that island roots never set `overflow:hidden`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Confirm CI is green**

Wait for the 4 required checks (`lint`, `typecheck`, `test`, `build`) to pass on the PR. The new test runs inside `test`. Fix any failures before proceeding.

- [ ] **Step 3: Visual spot-check on the Vercel preview at an iPhone viewport**

Open the PR's Vercel preview URL in a mobile viewport (e.g. iPhone 12 / 390×844, or real iOS Safari). Confirm:

- **`/login`** — the left showcase pane's top-left and bottom-left corners follow the `48px` radius (no square gradient corners poking out); the fixed parallax field/blobs scroll without flicker; the island intro animation still plays.
- **`/`** (landing) — island top corners are clean white, bottom is the rounded CTA/footer; the fixed right-side dot-nav stays pinned during momentum scroll (the original iOS symptom is gone).
- **Recommended:** also glance at `/pricing`, `/features`, `/how-it-works` island corners — all should be clean (bottom CTAs already self-round).

- [ ] **Step 4: Report results**

Report the CI status (with check output if anything failed) and the visual-check outcome. Only claim the fix complete once CI is green **and** the visual check confirms clean corners + working fixed-element scroll.

---

## Out of scope (do NOT bundle into this PR)

- M9 — auth island `min-height:680px` clipping iPhone SE (separate P1).
- M3 / P0 #8 — pricing matrix horizontal scroll (separate P0).
- Marking P0 #7 done in `docs/launch-ready-part2.md` — optional follow-up; the audit doc has known divergence from `main`, so leave it out to avoid merge noise unless the user asks.
- Any branding / palette / accessibility audit items.

---

## Self-review

- **Spec coverage:** Change 1 (globals overflow) → Task 1 Step 3. Change 2 (auth overflow) → Task 1 Step 4. Change 3 (showcase radius) → Task 2. Change 4 (guard test) → Task 1 Step 1. Verification (CI + visual) → Task 3. All spec items mapped.
- **Placeholder scan:** none — every code block and command is literal.
- **Type/name consistency:** test helper `extractIslandRule`, constant `ISLAND_ROOTS`, and the `{ label, path }` shape are used consistently; `it.each` title uses `$label` matching the object key.
