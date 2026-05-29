# Amber/Orange Sweep (Console + Admin) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every remaining banned `amber`/`orange`/`stone` color in the owner Console and Admin tool (launch-audit P1 #14) with on-brand replacements, and lock it shut with a regression guard.

**Architecture:** Presentational color-only swap, no behavior/layout/data change. Owner-facing "attention/awaiting" states → brand blush `#F2C3B9` via a new `--rw-attn-*` Console token set; the brand-teal edit-reply drawer's amber panels → the `#F0EEEA`/teal pattern already shipping in that file (blush left-accent on action-needed panels); Admin amber → admin's own blue (CTAs/focus/notices) + neutral gray (categorical status badges). A scoped Vitest guard asserts the swept files carry no banned token.

**Tech Stack:** Next.js 16, Tailwind (inline class strings), the Console CSS token system (`_styles/tokens.css` + `console.css`), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-29-amber-orange-sweep-design.md`

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/launch-p1-14-amber-orange-sweep` (branch `fix/launch-p1-14-amber-orange-sweep`, sibling of the repo — *not* nested, so `pnpm lint`/`test` are reliable here; CI on push is the final gate).

**Excluded deliberately (do NOT touch):** `dashboard/connect/page.tsx` (P0 #10), chart **series** colors `#ea580c` (`RankingChart.tsx`, `aggregate/AggregateVelocityCard.tsx`, `tokens.css --rw-chart-5`), yellow review stars `text-yellow-500` (`EditReplyDrawer:118`) + `--rw-yellow-500`, and the engagement-email amber accent.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/app/(authenticated)/_styles/tokens.css` | Owner Console color tokens — replace `--rw-orange-*` with `--rw-attn-*` blush set | 1 |
| `src/app/(authenticated)/_styles/console.css` | `.banner-orange`→`.banner-attn`, recolor `.badge-awaiting` + base `.banner`/`.banner-cta` defaults | 1 |
| `src/components/dashboard/ConnectGoogleBanner.tsx` | Use `banner-attn` class | 1 |
| `src/components/dashboard/EditReplyDrawer.tsx` | AI-disclosure box + poll-error panel → teal/off-white (+blush accent on poll-error) | 2 |
| `src/components/dashboard/edit-reply/DraftConflictPanel.tsx` | reconnect + unsaved-edit branches → teal/off-white + blush accent | 2 |
| `src/components/dashboard/edit-reply/RecoveryPanel.tsx` | amber → teal/off-white (plain) | 2 |
| `src/components/dashboard/edit-reply/PreviewPanel.tsx` | amber note → teal/off-white | 2 |
| `src/components/dashboard/edit-reply/ManualEditor.tsx` | amber note → teal/off-white | 2 |
| `src/components/dashboard/edit-reply/ReviewChangedPanel.tsx` | amber → teal/off-white (plain) | 2 |
| `src/app/admin/overview/page.tsx` | watch/reconnect badges → gray; Add-Business → blue; stone btn → gray | 3 |
| `src/app/admin/payment-success/page.tsx` | amber spinner/buttons → blue | 3 |
| `src/app/admin/businesses/[id]/page.tsx` | watch badge → gray; threshold bar → blue | 3 |
| `src/app/admin/businesses/[id]/components/PastDueExtensionPanel.tsx` | amber panel/inputs/submit → blue/gray | 3 |
| `src/app/admin/businesses/[id]/components/ReviewsList.tsx` | awaiting badge → gray | 3 |
| `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx` | pending badge → gray | 3 |
| `src/app/admin/impersonate/ImpersonationStartClient.tsx` | amber notice/focus/submit → blue/gray | 3 |
| `src/app/admin/impersonate/[sessionId]/view/page.tsx` | amber notice → blue | 3 |
| `src/components/admin/TelegramEnrollmentWidget.tsx` | `text-orange-600` → `text-gray-600` | 4 |
| `src/components/admin/WhatsAppEnrollmentWidget.tsx` | `text-orange-600` → `text-gray-600` | 4 |
| `src/__tests__/console-admin-palette.test.ts` (new) | Regression guard: swept files carry no banned token | 5 |

**TDD shape:** Tasks 1–4 are mechanical sweeps verified by a per-task `grep` (RED before edit = grep finds the banned token; GREEN after = grep returns empty) plus `lint`/`typecheck`, committed per task. Task 5 adds the durable guard test (it passes immediately because everything is already swept), then runs the full suite. The guard test is committed **only** in Task 5 — every intermediate commit stays green. Each task commits **only the files it edits** (exact `git add` paths — never `git add -A`).

---

### Task 1: Owner Console attention tokens (blush) + banner + badge

**Files:**
- Modify: `src/app/(authenticated)/_styles/tokens.css:71-72`
- Modify: `src/app/(authenticated)/_styles/console.css:444-475` and `:707`
- Modify: `src/components/dashboard/ConnectGoogleBanner.tsx:25` and `:90`

- [ ] **Step 1: Confirm the banned tokens are present (RED)**

Run:
```bash
grep -nE "rw-orange|banner-orange|#FED7AA|#FFF7ED|#9A3412|#EA580C|#C2410C" \
  "src/app/(authenticated)/_styles/tokens.css" \
  "src/app/(authenticated)/_styles/console.css" \
  src/components/dashboard/ConnectGoogleBanner.tsx
```
Expected: several matches (token defs, `.banner-orange`, hex values, two `banner banner-orange` class usages).

- [ ] **Step 2: Replace the orange tokens in `tokens.css`**

In `src/app/(authenticated)/_styles/tokens.css`, replace these two lines (71-72):

```css
  --rw-orange-100: #FFEDD5;  /* badge: awaiting_manual_post */
  --rw-orange-800: #9A3412;
```

with:

```css
  /* Attention / awaiting state — brand blush #F2C3B9 (replaces the old banned
     palette). Owner-facing: ConnectGoogleBanner reconnect banner + the
     awaiting_manual_post status badge. */
  --rw-attn-bg:      #FBEDEA;  /* light blush wash — banner + badge surface */
  --rw-attn-border:  #F2C3B9;  /* brand blush */
  --rw-attn-fg:      #2a2a2a;  /* primary text on blush (~12:1, AAA) */
  --rw-attn-fg-soft: #5a5a5a;  /* secondary text on blush (~6:1, AA) */
  --rw-attn-icon-bg: #F2C3B9;
```

Leave `--rw-chart-5: #ea580c` (line 86) untouched — it is an allowlisted chart series color.

- [ ] **Step 3: Recolor the banner + badge blocks in `console.css`**

In `src/app/(authenticated)/_styles/console.css`, replace the block at lines 444-475:

```css
.banner-orange { border-color: #FED7AA; background: #FFF7ED; }
.banner-blue { border-color: #BFDBFE; background: #EFF6FF; }
.banner .b-title { font-weight: 600; color: #9A3412; font-size: 14px; }
.banner-blue .b-title { color: #1E3A8A; }
.banner .b-sub { font-size: 13px; color: #9A3412cc; margin-top: 2px; }
.banner-blue .b-sub { color: #1E40AFcc; }
.banner .b-icon {
  width: 36px; height: 36px;
  border-radius: 8px;
  background: #FED7AA;
  display: grid; place-items: center;
  flex: 0 0 36px;
  color: #9A3412;
}
.banner-blue .b-icon { background: #BFDBFE; color: #1E40AF; }
.banner-cta {
  margin-left: auto;
  background: var(--rw-orange-100, #FED7AA);
  color: #9A3412;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 160ms var(--rw-ease);
  font-family: var(--rw-font-body);
}
.banner-orange .banner-cta { background: #EA580C; color: #fff; }
.banner-orange .banner-cta:hover { background: #C2410C; }
.banner-blue .banner-cta { background: var(--rw-blue-600); color: #fff; }
.banner-blue .banner-cta:hover { background: var(--rw-blue-700); }
```

with (renames `.banner-orange`→`.banner-attn`; base `.banner` defaults + base `.banner-cta` move off orange onto the blush tokens / brand teal — they only apply to the non-blue variant since `.banner-blue` overrides each):

```css
.banner-attn { border-color: var(--rw-attn-border); background: var(--rw-attn-bg); }
.banner-blue { border-color: #BFDBFE; background: #EFF6FF; }
.banner .b-title { font-weight: 600; color: var(--rw-attn-fg); font-size: 14px; }
.banner-blue .b-title { color: #1E3A8A; }
.banner .b-sub { font-size: 13px; color: var(--rw-attn-fg-soft); margin-top: 2px; }
.banner-blue .b-sub { color: #1E40AFcc; }
.banner .b-icon {
  width: 36px; height: 36px;
  border-radius: 8px;
  background: var(--rw-attn-icon-bg);
  display: grid; place-items: center;
  flex: 0 0 36px;
  color: var(--rw-attn-fg);
}
.banner-blue .b-icon { background: #BFDBFE; color: #1E40AF; }
.banner-cta {
  margin-left: auto;
  background: #97B3AE;
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 160ms var(--rw-ease);
  font-family: var(--rw-font-body);
}
.banner-attn .banner-cta { background: #97B3AE; color: #fff; }
.banner-attn .banner-cta:hover { background: #7c9994; }
.banner-blue .banner-cta { background: var(--rw-blue-600); color: #fff; }
.banner-blue .banner-cta:hover { background: var(--rw-blue-700); }
```

Then replace line 707:

```css
.badge-awaiting { background: var(--rw-orange-100); color: var(--rw-orange-800); }
```

with:

```css
.badge-awaiting { background: var(--rw-attn-bg); color: var(--rw-attn-fg); }
```

- [ ] **Step 4: Point the banner component at the new class**

In `src/components/dashboard/ConnectGoogleBanner.tsx`:

- Line 25: `<div className="banner banner-orange" role="alert">` → `<div className="banner banner-attn" role="alert">`
- Line 90: `<div className="banner banner-orange">` → `<div className="banner banner-attn">`

- [ ] **Step 5: Confirm the tokens are gone (GREEN) + lint + typecheck**

Run:
```bash
grep -nE "rw-orange|banner-orange|#FED7AA|#FFF7ED|#9A3412|#EA580C|#C2410C" \
  "src/app/(authenticated)/_styles/tokens.css" \
  "src/app/(authenticated)/_styles/console.css" \
  src/components/dashboard/ConnectGoogleBanner.tsx || echo "CLEAN"
pnpm lint && pnpm typecheck
```
Expected: `CLEAN` (grep finds nothing → exits non-zero → prints CLEAN); lint + typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(authenticated)/_styles/tokens.css" \
        "src/app/(authenticated)/_styles/console.css" \
        src/components/dashboard/ConnectGoogleBanner.tsx
git commit -m "style(console): blush attention tokens replace amber banner + awaiting badge (P1 #14)"
```

---

### Task 2: EditReplyDrawer + edit-reply panels → teal/off-white

The brand-teal drawer already uses `#F0EEEA`/teal; `DraftConflictPanel`'s `approved/edited` branch is the conversion template. **Action-needed** panels (reconnect-required, unsaved-edit conflict, regenerate-poll-error) additionally get a blush left accent `border-l-4 border-l-[#F2C3B9]`. Plain notes (AI-disclosure, recovery, review-changed, preview/manual hints) get no accent.

**Files:**
- Modify: `src/components/dashboard/EditReplyDrawer.tsx:145` and `:189-191`
- Modify: `src/components/dashboard/edit-reply/DraftConflictPanel.tsx:63-65,:71,:100-101,:106`
- Modify: `src/components/dashboard/edit-reply/RecoveryPanel.tsx:13-14`
- Modify: `src/components/dashboard/edit-reply/PreviewPanel.tsx:21`
- Modify: `src/components/dashboard/edit-reply/ManualEditor.tsx:28`
- Modify: `src/components/dashboard/edit-reply/ReviewChangedPanel.tsx:13-14,:20`

- [ ] **Step 1: Confirm amber present (RED)**

Run:
```bash
grep -rnE "amber-" src/components/dashboard/EditReplyDrawer.tsx src/components/dashboard/edit-reply/
```
Expected: matches in all six files.

- [ ] **Step 2: `EditReplyDrawer.tsx`**

Line 145 (AI-disclosure note — plain):
```tsx
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
```
→
```tsx
              <div className="rounded-md border border-[#97B3AE]/30 bg-[#F0EEEA]/60 px-3 py-2 text-xs text-[#6a6a6a]">
```

Lines 189-191 (regenerate-poll-error — action-needed, blush accent):
```tsx
            <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm text-amber-900">{state.message}</p>
              <p className="text-xs text-amber-800">
```
→
```tsx
            <div className="space-y-3 rounded-lg border border-[#97B3AE]/40 border-l-4 border-l-[#F2C3B9] bg-[#F0EEEA]/40 p-4">
              <p className="text-sm text-[#2a2a2a]">{state.message}</p>
              <p className="text-xs text-[#6a6a6a]">
```

- [ ] **Step 3: `edit-reply/DraftConflictPanel.tsx`**

`awaiting_owner_connect` branch (action-needed, blush accent):

- Line 63: `<div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">` → `<div className="space-y-3 rounded-lg border border-[#97B3AE]/40 border-l-4 border-l-[#F2C3B9] bg-[#F0EEEA]/40 p-4">`
- Line 64: `<p className="text-sm font-medium text-amber-900">Google reconnect required</p>` → `<p className="text-sm font-medium text-[#2a2a2a]">Google reconnect required</p>`
- Line 65: `<p className="text-sm text-amber-800">` → `<p className="text-sm text-[#6a6a6a]">`
- Line 71: `<div className="mb-1 text-xs uppercase tracking-wider text-amber-900/70">` → `<div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">`

`pending_approval` branch (action-needed, blush accent):

- Line 100: `<div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">` → `<div className="space-y-3 rounded-lg border border-[#97B3AE]/40 border-l-4 border-l-[#F2C3B9] bg-[#F0EEEA]/40 p-4">`
- Line 101: `<p className="text-sm text-amber-900">` → `<p className="text-sm text-[#6a6a6a]">`
- Line 106: `<div className="mb-1 text-xs uppercase tracking-wider text-amber-900/70">` → `<div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">`

- [ ] **Step 4: `edit-reply/RecoveryPanel.tsx` (plain)**

- Line 13: `<div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">` → `<div className="space-y-3 rounded-lg border border-[#97B3AE]/40 bg-[#F0EEEA]/40 p-4">`
- Line 14: `<p className="text-sm text-amber-900">` → `<p className="text-sm text-[#6a6a6a]">`

- [ ] **Step 5: `edit-reply/PreviewPanel.tsx` (plain note)**

- Line 21: `<div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">` → `<div className="mb-3 rounded-md border border-[#97B3AE]/30 bg-[#F0EEEA]/60 px-3 py-2 text-xs text-[#6a6a6a]">`

- [ ] **Step 6: `edit-reply/ManualEditor.tsx` (plain note)**

- Line 28: `<div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">` → `<div className="rounded-md border border-[#97B3AE]/30 bg-[#F0EEEA]/60 px-3 py-2 text-xs text-[#6a6a6a]">`

- [ ] **Step 7: `edit-reply/ReviewChangedPanel.tsx` (plain)**

- Line 13: `<div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">` → `<div className="space-y-3 rounded-lg border border-[#97B3AE]/40 bg-[#F0EEEA]/40 p-4">`
- Line 14: `<p className="text-sm text-amber-900">` → `<p className="text-sm text-[#6a6a6a]">`
- Line 20: `<div className="mb-1 text-xs uppercase tracking-wider text-amber-900/70">` → `<div className="mb-1 text-xs uppercase tracking-wider text-[#97B3AE]">`

- [ ] **Step 8: Confirm clean (GREEN) + lint + typecheck**

Run:
```bash
grep -rnE "amber-" src/components/dashboard/EditReplyDrawer.tsx src/components/dashboard/edit-reply/ || echo "CLEAN"
pnpm lint && pnpm typecheck
```
Expected: `CLEAN`; lint + typecheck pass.

- [ ] **Step 9: Commit**

```bash
git add src/components/dashboard/EditReplyDrawer.tsx src/components/dashboard/edit-reply/
git commit -m "style(edit-reply): retire amber drawer panels to teal/off-white + blush accent (P1 #14)"
```

---

### Task 3: Admin tool sweep (`src/app/admin/**`) → blue + gray

Mapping: primary buttons `amber-600/700`→`blue-600/700`; spinner ring `amber-600`→`blue-600`; form focus `amber-500/200`→`blue-500/200`; notice panels `amber-200/50/9xx`→`blue-200/50/900` (body `blue-800`, labels `gray-700`); categorical status badges (watch/pending/awaiting)→`gray-100`/`gray-700`; threshold bar `amber-400`→`blue-400`; stone→gray.

**Files (8):** `overview/page.tsx`, `payment-success/page.tsx`, `businesses/[id]/page.tsx`, `businesses/[id]/components/PastDueExtensionPanel.tsx`, `businesses/[id]/components/ReviewsList.tsx`, `businesses/[id]/components/ZernioConnectionPanel.tsx`, `impersonate/ImpersonationStartClient.tsx`, `impersonate/[sessionId]/view/page.tsx`.

- [ ] **Step 1: Confirm present (RED)**

Run:
```bash
grep -rnE "amber-|stone-" src/app/admin/
```
Expected: matches across the eight files.

- [ ] **Step 2: `overview/page.tsx`**

- Line 110: `    watch: 'bg-amber-100 text-amber-800',` → `    watch: 'bg-gray-100 text-gray-700',`
- Line 183: `              className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"` → `              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"`
- Line 189: `              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"` → `              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"`
- Line 316: `                        <span className="inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">` → `                        <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">`

- [ ] **Step 3: `payment-success/page.tsx`**

- Line 63: `          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-amber-600 border-t-transparent" />` → replace `border-amber-600` with `border-blue-600`.
- Line 80: `            className="mt-4 inline-block rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"` → `bg-blue-600 ... hover:bg-blue-700`.
- Line 98: same string as line 80 → `bg-blue-600 ... hover:bg-blue-700`.
- Line 114: `            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-amber-600 border-t-transparent" />` → `border-blue-600`.

(Leave the `bg-yellow-100`/`text-yellow-600` error icon at lines 89-90 — yellow is out of scope.)

- [ ] **Step 4: `businesses/[id]/page.tsx`**

- Line 19: `    watch: 'bg-amber-100 text-amber-800',` → `    watch: 'bg-gray-100 text-gray-700',`
- Lines 199-200:
```tsx
                          item.contribution > 15 ? 'bg-red-400' :
                          item.contribution > 5 ? 'bg-amber-400' : 'bg-green-400'
```
→
```tsx
                          item.contribution > 15 ? 'bg-red-400' :
                          item.contribution > 5 ? 'bg-blue-400' : 'bg-green-400'
```

- [ ] **Step 5: `businesses/[id]/components/PastDueExtensionPanel.tsx`**

- Line 81: `    <section className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">` → `border border-blue-200 bg-blue-50`
- Line 84: `          <h2 className="text-sm font-semibold text-amber-950">Grant past-due extension</h2>` → `text-blue-900`
- Line 85: `          <p className="mt-1 text-sm text-amber-800">` → `text-blue-800`
- Lines 92, 103, 113: `        <label className="grid gap-1 text-sm font-medium text-amber-950">` → `text-gray-700` (all three)
- Lines 100, 109, 119 (all three identical inputs): `            className="rounded-md border border-amber-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200"` → `border border-gray-300 ... focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200`
- Line 126: `          className="rounded-md bg-amber-700 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"` → `bg-blue-600 ... hover:bg-blue-700`

- [ ] **Step 6: `businesses/[id]/components/ReviewsList.tsx`**

- Line 21: `    awaiting_owner_connect: 'bg-amber-100 text-amber-800',` → `    awaiting_owner_connect: 'bg-gray-100 text-gray-700',`

- [ ] **Step 7: `businesses/[id]/components/ZernioConnectionPanel.tsx`**

- Line 31: `    pending: 'bg-amber-100 text-amber-800',` → `    pending: 'bg-gray-100 text-gray-700',`

- [ ] **Step 8: `impersonate/ImpersonationStartClient.tsx`**

- Line 52: `      <div className="rounded-md border border-amber-200 bg-amber-50 p-4">` → `border border-blue-200 bg-blue-50`
- Line 53: `        <h2 className="text-sm font-semibold text-amber-950">Read-only admin view</h2>` → `text-blue-900`
- Line 54: `        <p className="mt-1 text-sm text-amber-800">` → `text-blue-800`
- Lines 66, 76, 86, 96 (four inputs): replace `focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200` with `focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200` (the `border border-gray-300` prefix is unchanged).
- Line 106: `          className="rounded-md bg-amber-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"` → `bg-blue-600 ... hover:bg-blue-700`

- [ ] **Step 9: `impersonate/[sessionId]/view/page.tsx`**

- Line 67: `        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">` → `border border-blue-200 bg-blue-50`
- Line 70: `              <p className="text-sm font-semibold text-amber-950">` → `text-blue-900`
- Line 73: `              <p className="mt-1 text-sm text-amber-800">` → `text-blue-800`

- [ ] **Step 10: Confirm clean (GREEN) + lint + typecheck**

Run:
```bash
grep -rnE "amber-|stone-" src/app/admin/ || echo "CLEAN"
pnpm lint && pnpm typecheck
```
Expected: `CLEAN`; lint + typecheck pass.

- [ ] **Step 11: Commit**

```bash
git add src/app/admin/
git commit -m "style(admin): replace amber/stone with admin blue + neutral gray (P1 #14)"
```

---

### Task 4: Admin enrollment widgets — orange text → gray

**Files:**
- Modify: `src/components/admin/TelegramEnrollmentWidget.tsx:61`
- Modify: `src/components/admin/WhatsAppEnrollmentWidget.tsx:63`

- [ ] **Step 1: Confirm present (RED)**

Run:
```bash
grep -nE "orange-" src/components/admin/TelegramEnrollmentWidget.tsx src/components/admin/WhatsAppEnrollmentWidget.tsx
```
Expected: one match in each (`text-orange-600`).

- [ ] **Step 2: Edit both**

`TelegramEnrollmentWidget.tsx` line 61:
```tsx
          <p className="text-sm text-orange-600">Unsubscribed ({snapshot.unsubscribedReason ?? 'unknown'})</p>
```
→
```tsx
          <p className="text-sm text-gray-600">Unsubscribed ({snapshot.unsubscribedReason ?? 'unknown'})</p>
```

`WhatsAppEnrollmentWidget.tsx` line 63 — identical change (`text-orange-600` → `text-gray-600`).

- [ ] **Step 3: Confirm clean (GREEN) + lint + typecheck**

Run:
```bash
grep -nE "orange-" src/components/admin/TelegramEnrollmentWidget.tsx src/components/admin/WhatsAppEnrollmentWidget.tsx || echo "CLEAN"
pnpm lint && pnpm typecheck
```
Expected: `CLEAN`; lint + typecheck pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/admin/TelegramEnrollmentWidget.tsx src/components/admin/WhatsAppEnrollmentWidget.tsx
git commit -m "style(admin): unsubscribed enrollment status off orange to gray (P1 #14)"
```

---

### Task 5: Regression guard test + full verification

**Files:**
- Create: `src/__tests__/console-admin-palette.test.ts`

- [ ] **Step 1: Write the guard test**

Create `src/__tests__/console-admin-palette.test.ts` (mirrors the `island-overflow.test.ts` pattern):

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// launch-ready-part2 P1 #14 + repworth-brand-design rubric: amber, orange, and
// stone are banned. This guard locks the swept Console + Admin surfaces so the
// off-brand palette cannot silently regress. SCOPED to the cleaned file set —
// NOT global — so it never trips on the deliberately-excluded surfaces:
//   - src/app/(authenticated)/dashboard/connect/page.tsx        (P0 #10)
//   - chart SERIES color #ea580c (RankingChart, AggregateVelocityCard,
//     tokens.css --rw-chart-5)                                  (data-viz)
//   - yellow review stars text-yellow-500 / --rw-yellow-500     (P2 #28)
const SWEPT_FILES = [
  // Owner Console — token system
  'src/app/(authenticated)/_styles/tokens.css',
  'src/app/(authenticated)/_styles/console.css',
  'src/components/dashboard/ConnectGoogleBanner.tsx',
  // Owner Console — edit-reply drawer
  'src/components/dashboard/EditReplyDrawer.tsx',
  'src/components/dashboard/edit-reply/DraftConflictPanel.tsx',
  'src/components/dashboard/edit-reply/RecoveryPanel.tsx',
  'src/components/dashboard/edit-reply/PreviewPanel.tsx',
  'src/components/dashboard/edit-reply/ManualEditor.tsx',
  'src/components/dashboard/edit-reply/ReviewChangedPanel.tsx',
  // Admin tool
  'src/app/admin/overview/page.tsx',
  'src/app/admin/payment-success/page.tsx',
  'src/app/admin/businesses/[id]/page.tsx',
  'src/app/admin/businesses/[id]/components/PastDueExtensionPanel.tsx',
  'src/app/admin/businesses/[id]/components/ReviewsList.tsx',
  'src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx',
  'src/app/admin/impersonate/ImpersonationStartClient.tsx',
  'src/app/admin/impersonate/[sessionId]/view/page.tsx',
  'src/components/admin/TelegramEnrollmentWidget.tsx',
  'src/components/admin/WhatsAppEnrollmentWidget.tsx',
];

// Class-name / token-name patterns only (not raw hexes) — this avoids colliding
// with the allowlisted chart hex #ea580c and mirrors the island-overflow guard's
// approach of asserting on the offending declaration text.
const BANNED = [
  { label: 'amber Tailwind class', re: /\bamber-\d/ },
  { label: 'orange Tailwind class', re: /\borange-\d/ },
  { label: 'stone Tailwind class', re: /\bstone-\d/ },
  { label: 'banner-orange CSS class', re: /banner-orange/ },
  { label: 'legacy --rw-orange token', re: /--rw-orange/ },
];

describe('Console + Admin carry no banned amber/orange/stone palette (P1 #14)', () => {
  it.each(SWEPT_FILES)('%s uses no banned palette tokens', (relPath) => {
    const text = readFileSync(resolve(process.cwd(), relPath), 'utf-8');
    for (const { label, re } of BANNED) {
      expect(text, `${relPath} still contains a ${label}`).not.toMatch(re);
    }
  });
});
```

- [ ] **Step 2: Run the guard test — expect GREEN**

Run: `pnpm vitest run src/__tests__/console-admin-palette.test.ts`
Expected: PASS (19 cases). All swept files are already clean from Tasks 1-4.

- [ ] **Step 3: Prove the guard bites (optional sanity check)**

Run:
```bash
# Temporarily reintroduce one banned token, confirm the guard fails, then revert.
sed -i '' 's/text-gray-600">Unsubscribed/text-orange-600">Unsubscribed/' src/components/admin/TelegramEnrollmentWidget.tsx
pnpm vitest run src/__tests__/console-admin-palette.test.ts || echo "GUARD CORRECTLY FAILED"
git checkout -- src/components/admin/TelegramEnrollmentWidget.tsx
```
Expected: `GUARD CORRECTLY FAILED`, then the file is reverted clean.

- [ ] **Step 4: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all pass (the new guard test runs as part of `pnpm test`; no other test asserts the removed amber classes — verified during planning).

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/console-admin-palette.test.ts
git commit -m "test(palette): guard Console + Admin against amber/orange/stone regression (P1 #14)"
```

---

## After all tasks

Update `docs/launch-ready-part2.md` to mark P1 #14 done (and the matching Section C/E "amber bleed-through" / admin-amber lines), consistent with the prior PR annotation style (✅ + PR number). Then use **superpowers:finishing-a-development-branch** to push `fix/launch-p1-14-amber-orange-sweep` and open a PR into `main`, with the 4 CI checks green.

## Self-Review notes (author)

- **Spec coverage:** every file in the spec's "Files touched" table maps to a task (Task 1 owner tokens; Task 2 drawer; Task 3 admin app; Task 4 enrollment widgets; Task 5 guard test). Exclusions restated in the header + guard-test comment.
- **Type/name consistency:** new tokens `--rw-attn-{bg,border,fg,fg-soft,icon-bg}` defined in Task 1 are the exact names referenced by `console.css` in the same task; `.banner-attn` defined in `console.css` matches the class used in `ConnectGoogleBanner.tsx`; `.badge-awaiting` class name preserved so `ReviewsCard`/`AggregateReviewsCard` need no edit.
- **Green commits:** the guard test (the only artifact that would be red mid-sweep) is committed last; Tasks 1-4 each verify with a scoped grep + lint + typecheck and `git add` only their own files.
