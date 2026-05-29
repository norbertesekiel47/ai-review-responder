# Replace remaining amber/orange across Console + Admin — Design

> **Date:** 2026-05-29
> **Status:** Approved (design); pending spec review
> **Source:** `docs/launch-ready-part2.md` → Prioritized fix list → P1 #14
> ("Replace remaining amber/orange in `EditReplyDrawer` + panels, `ConnectGoogleBanner`, onboarding alerts, admin overview")
> **Scope:** Presentational color-only sweep. 19 files. No behavior, data, or layout change. Full-sweep variant (see Scope decision). One new regression-guard test.

## Problem

The `repworth-brand-design` rubric bans `amber`, `orange`, and `stone`. PRs #160/#162/#164/#165/#166 cleared these from the brand **island** surfaces (funnel, approval, MFA, demo, utility pages). What remains is **off the island** — in the owner Console and the Admin tool — where the audit calls it "amber bleed-through" (Console, P1) and "amber is banned" (Admin, P2).

Grep-confirmed remaining usage (excluding tests):

- **Owner Console — brand-teal drawer:** `EditReplyDrawer.tsx` (AI-disclosure box `:145`, regenerate-poll-error panel `:189–191`) and the five `edit-reply/*` panels (`DraftConflictPanel`, `RecoveryPanel`, `PreviewPanel`, `ManualEditor`, `ReviewChangedPanel`) — all `border-amber-200 bg-amber-50 text-amber-900`.
- **Owner Console — `tokens.css`/`console.css` semantic system:** `ConnectGoogleBanner` uses `.banner-orange` (`#FFF7ED`/`#FED7AA`/`#9A3412`/CTA `#EA580C`); the `Awaiting Manual Post` status badge uses `.badge-awaiting` → `--rw-orange-100/800`.
- **Admin (internal tool):** `overview/page.tsx` (Add-Business `bg-amber-600`, watch/awaiting badges, **plus `stone-*` on the All-Businesses button**), `payment-success/page.tsx` (amber spinner + buttons), `businesses/[id]/{page.tsx, PastDueExtensionPanel, ReviewsList, ZernioConnectionPanel}`, `impersonate/ImpersonationStartClient.tsx`, `impersonate/[sessionId]/view/page.tsx`, and the two `components/admin/{Telegram,WhatsApp}EnrollmentWidget.tsx` (`text-orange-600`).

### Key context that shapes the fix

1. **The drawer is already brand-teal.** `EditReplyDrawer` and the `edit-reply` panels already use the island palette inline (`#97B3AE`, `#F0EEEA`, `#2a2a2a`, `#6a6a6a`). `DraftConflictPanel`'s `approved/edited` branch is **already converted** to `border-[#97B3AE]/40 bg-[#F0EEEA]/40`; only its warning branches lag. So the drawer conversion target is established by code already in the file — not invented here.
2. **The Console and Admin are deliberately *not* the sage island.** Per the rubric, dashboard/admin pages are exempt from the island and run their own token systems. So the replacement is **each surface's own palette**, not marketing teal — except the drawer, which already opted into teal.
3. **No test asserts amber/orange in any swept file.** The only matches are a guard test asserting amber is *absent* (`ContactContent.test.tsx`) and an email-template test (out of scope). Nothing breaks silently.

## Decisions (from brainstorming)

- **Scope = full sweep.** All amber/orange/stone above. **Excluded deliberately:** `dashboard/connect/page.tsx` (owned by P0 #10), the three chart **series** colors `#ea580c` (`RankingChart`, `AggregateVelocityCard`, `--rw-chart-5` — categorical data-viz, not chrome), the yellow review stars `text-yellow-500` / `--rw-yellow-500` (P2 #28, not amber/orange), and the engagement-email amber accent (email surface; its own test asserts amber present).
- **Owner-facing "attention/awaiting" = brand blush `#F2C3B9`.** Warm attention hue from the brand palette; reads "needs attention" like amber did; distinct from Console yellow(pending)/blue(info)/green(posted)/red(failed).
- **Admin amber → admin's own blue** (per the audit), with neutral gray for categorical status badges so they don't collide with active-blue.
- **Implementation = token-first.** Where a surface owns a semantic token system, retarget the tokens (one authoritative owner); components on raw Tailwind get inline swaps.

## The fix

### A. Owner Console — brand-teal drawer (6 files)

Convert each amber panel to the pattern **already shipping** in `DraftConflictPanel`'s converted branch:

- Container: `rounded-lg border border-[#97B3AE]/40 bg-[#F0EEEA]/40 p-4` (notes: `rounded-md border border-[#97B3AE]/30 bg-[#F0EEEA]/60 px-3 py-2`).
- Title: `text-[#2a2a2a]`; body/sub: `text-[#6a6a6a]`; eyebrow: `text-[#97B3AE]` (existing convention).
- **Action-needed** panels — `DraftConflictPanel`'s `awaiting_owner_connect` ("Google reconnect required") and `pending_approval` (unsaved-edit), and `EditReplyDrawer`'s `regenerate_poll_error` — additionally carry a blush left accent `border-l-4 border-l-[#F2C3B9]` to preserve the urgency amber signalled. Purely informational notes (AI-disclosure, `PreviewPanel`/`ManualEditor` hints, `RecoveryPanel`, `ReviewChangedPanel`) get the plain teal-on-off-white treatment with no blush accent.
- `EditReplyDrawer:145` AI-disclosure box mirrors PR #162's sage AI-disclosure note: `border border-[#97B3AE]/30 bg-[#F0EEEA]/60 text-[#6a6a6a]`.

Files: `EditReplyDrawer.tsx`, `edit-reply/DraftConflictPanel.tsx`, `edit-reply/RecoveryPanel.tsx`, `edit-reply/PreviewPanel.tsx`, `edit-reply/ManualEditor.tsx`, `edit-reply/ReviewChangedPanel.tsx`.

### B. Owner Console — token system (3 files)

**`tokens.css`** — remove `--rw-orange-100/800`; add the blush attention token set (comment carries the old `/* awaiting_manual_post + connect-reconnect attention */`):

```css
--rw-attn-bg:      #FBEDEA;  /* light blush wash — banner + badge surface */
--rw-attn-border:  #F2C3B9;  /* brand blush */
--rw-attn-fg:      #2a2a2a;  /* primary text (brand heading) */
--rw-attn-fg-soft: #5a5a5a;  /* secondary text — AA-safe on #FBEDEA */
--rw-attn-icon-bg: #F2C3B9;
```

Leave `--rw-chart-5: #ea580c` untouched (chart series, excluded).

**`console.css`**:
- Rename `.banner-orange` → `.banner-attn` and recolor from the tokens: `border-color: var(--rw-attn-border); background: var(--rw-attn-bg);` `.banner-attn .b-title { color: var(--rw-attn-fg); }` `.b-sub { color: var(--rw-attn-fg-soft); }` `.b-icon { background: var(--rw-attn-icon-bg); color: var(--rw-attn-fg); }`.
- `.banner-attn .banner-cta` → brand teal pill: `background: #97B3AE; color: #fff;` hover `#7c9994` (the Console's owner-action language).
- Fix the base `.banner-cta` default (currently `background: var(--rw-orange-100, #FED7AA)` — would resolve to the orange fallback once the token is gone): set it to `background: #97B3AE; color: #fff;`.
- `.badge-awaiting` → `background: var(--rw-attn-bg); color: var(--rw-attn-fg);`.

**`ConnectGoogleBanner.tsx`** — `banner banner-orange` → `banner banner-attn` at both sites (`:25`, `:90`). Class names `.badge-awaiting` / `.banner` / `.b-*` are otherwise preserved, so `ReviewsCard.tsx` / `AggregateReviewsCard.tsx` (which reference `badge-awaiting`) and the blue/active banner branches need **no** edits.

### C. Admin — internal tool (10 files)

Mapping rules (apply consistently; the audit prescribes "admin's own blue"):

| amber/orange/stone role | → replacement |
|---|---|
| Primary button (`bg-amber-600/700`) | `bg-blue-600 text-white hover:bg-blue-700` |
| Spinner ring (`border-amber-600`) | `border-blue-600` |
| Form focus/border (`border-amber-300`, `focus:border-amber-500`, `focus:ring-amber-200`) | `border-gray-300 focus:border-blue-500 focus:ring-blue-200` |
| Notice/caution panel (`border-amber-200 bg-amber-50 text-amber-9xx`) | `border-blue-200 bg-blue-50 text-blue-900` (body `text-blue-800`/`text-gray-700`) |
| Categorical status badge (`bg-amber-100 text-amber-800` — watch / pending / awaiting_owner_connect) | `bg-gray-100 text-gray-700` (distinct from active-blue/ok-green/error-red) |
| Threshold bar (`bg-amber-400`, contribution>5) | `bg-blue-400` (keeps an "elevated" signal vs `bg-green-400`) |
| `text-orange-600` ("Unsubscribed") | `text-gray-600` |
| `stone-300/700/50` (All-Businesses button) | `border-gray-300 text-gray-700 hover:bg-gray-50` |

Files: `overview/page.tsx` (`:110` watch badge, `:183` stone button, `:189` Add-Business, `:316` awaiting badge), `payment-success/page.tsx` (`:63`,`:114` spinners; `:80`,`:98` buttons), `businesses/[id]/page.tsx` (`:19` watch badge, `:200` threshold bar), `businesses/[id]/components/PastDueExtensionPanel.tsx` (panel `:81`/`:84`/`:85`, labels `:92`/`:103`/`:113`, inputs `:100`/`:109`/`:119`, submit `:126`), `businesses/[id]/components/ReviewsList.tsx` (`:21`), `businesses/[id]/components/ZernioConnectionPanel.tsx` (`:31`), `impersonate/ImpersonationStartClient.tsx` (panel `:52–54`, inputs `:66`/`:76`/`:86`/`:96`, submit `:106`), `impersonate/[sessionId]/view/page.tsx` (`:67–73`), `components/admin/TelegramEnrollmentWidget.tsx` (`:61`), `components/admin/WhatsAppEnrollmentWidget.tsx` (`:63`).

### D. Regression guard (new test)

Mirror PR #161's `island-overflow.test.ts` contract test. A Vitest test that reads the swept files (and `console.css` / `tokens.css`) and asserts none contains `amber-`, `orange-` (excluding the allowlisted chart token line `--rw-chart-5`), `stone-`, `banner-orange`, or `--rw-orange`. **Scoped to the cleaned file set — not global** — so it never trips on the deliberately-excluded `dashboard/connect`, chart series colors, or yellow tokens. Locks the broken window shut. Proposed location: `src/__tests__/console-admin-palette.test.ts` (or the nearest contract-test home found during planning).

## Accessibility

- `--rw-attn-fg` `#2a2a2a` on `#FBEDEA` ≈ 12:1 (AAA). `--rw-attn-fg-soft` `#5a5a5a` on `#FBEDEA` clears AA (≥4.5:1). The drawer panels reuse the already-shipping `#6a6a6a`-on-`#F0EEEA/40` pattern unchanged.
- Admin blue/gray pairs are standard Tailwind steps with AA-compliant fg/bg contrast.
- No semantic/`role`/`aria` changes — only color. `role="alert"` on the reconnect banner is preserved.

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` (incl. the new guard test). Pure CSS/TSX, no DB → tenant-scope/RLS audits N/A.
- Per `CLAUDE.md`, do not trust full-suite runs from a nested worktree (module resolution leaks to the parent) — validate on the CI runner after push.
- Visual spot-check on the running app: owner dashboard reconnect banner + `Awaiting Manual Post` badge render blush; the EditReplyDrawer reconnect/conflict/poll-error panels render teal-on-off-white with a blush left accent; admin overview / payment-success / impersonate / past-due render blue+gray with no amber/stone.

## Out of scope (deliberately)

- `dashboard/connect/page.tsx` amber — P0 #10 ("Restyle `dashboard/connect`").
- Chart **series** colors `#ea580c` (`RankingChart`, `AggregateVelocityCard`, `--rw-chart-5`) — categorical data-viz.
- Yellow review stars `text-yellow-500` (`EditReplyDrawer:118`) and `--rw-yellow-500` — P2 #28.
- Engagement-email amber accent — email surface; its test asserts amber present.

## Files touched

| File | Change |
|---|---|
| `src/components/dashboard/EditReplyDrawer.tsx` | AI-disclosure box + poll-error panel → teal/off-white (+ blush accent on poll-error) |
| `src/components/dashboard/edit-reply/DraftConflictPanel.tsx` | reconnect + unsaved-edit branches → teal/off-white + blush accent |
| `src/components/dashboard/edit-reply/RecoveryPanel.tsx` | amber → teal/off-white |
| `src/components/dashboard/edit-reply/PreviewPanel.tsx` | amber note → teal/off-white |
| `src/components/dashboard/edit-reply/ManualEditor.tsx` | amber note → teal/off-white |
| `src/components/dashboard/edit-reply/ReviewChangedPanel.tsx` | amber → teal/off-white |
| `src/app/(authenticated)/_styles/tokens.css` | `--rw-orange-*` → `--rw-attn-*` blush set |
| `src/app/(authenticated)/_styles/console.css` | `.banner-orange`→`.banner-attn`; recolor `.badge-awaiting` + base `.banner-cta` |
| `src/components/dashboard/ConnectGoogleBanner.tsx` | `banner-orange` → `banner-attn` (×2) |
| `src/app/admin/overview/page.tsx` | amber button/badges + stone button → blue/gray |
| `src/app/admin/payment-success/page.tsx` | amber spinner/buttons → blue |
| `src/app/admin/businesses/[id]/page.tsx` | watch badge + threshold bar → gray/blue |
| `src/app/admin/businesses/[id]/components/PastDueExtensionPanel.tsx` | amber panel/inputs/submit → blue/gray |
| `src/app/admin/businesses/[id]/components/ReviewsList.tsx` | awaiting badge → gray |
| `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx` | pending badge → gray |
| `src/app/admin/impersonate/ImpersonationStartClient.tsx` | amber notice/inputs/submit → blue/gray |
| `src/app/admin/impersonate/[sessionId]/view/page.tsx` | amber notice → blue |
| `src/components/admin/TelegramEnrollmentWidget.tsx` | `text-orange-600` → `text-gray-600` |
| `src/components/admin/WhatsAppEnrollmentWidget.tsx` | `text-orange-600` → `text-gray-600` |
| `src/__tests__/console-admin-palette.test.ts` (new) | Assert swept files carry no amber/orange/stone |
