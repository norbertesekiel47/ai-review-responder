# Owner Dashboard Redesign — Smoke Test Runbook

> **Branch:** `feature/owner-dashboard-redesign`
> **PR:** [#27](https://github.com/norbertesekiel47/ai-review-responder/pull/27)
> **Scope:** authenticated owner surface (`/dashboard`, `/dashboard/past-replies`, `/settings`, `/settings/channels`) + layout shell.
> **Out of scope (untouched):** marketing site, admin (`/admin/*`), public approval, onboarding wizard, API routes, worker, DB schema.
>
> Walk this top-to-bottom; flag anything that doesn't match expected behavior. Report in PR #27 with screenshot + console/network capture.

## Contents

- [0. Prereqs](#0-prereqs)
- [1. Layout shell — first impression](#1-layout-shell--first-impression)
- [2. Dashboard active state](#2-dashboard-active-state)
- [3. Subscription state branches](#3-subscription-state-branches)
- [4. Past Replies — `/dashboard/past-replies`](#4-past-replies--dashboardpast-replies)
- [5. Settings — `/settings`](#5-settings--settings)
- [6. Settings — Notifications — `/settings/channels`](#6-settings--notifications--settingschannels)
- [7. Mobile / responsive (<768px)](#7-mobile--responsive-768px)
- [8. DevTools sanity checks](#8-devtools-sanity-checks)
- [9. Type-check + tests + build (sanity)](#9-type-check--tests--build-sanity)
- [10. Sign out](#10-sign-out)
- [What to flag](#what-to-flag)

---

## 0. Prereqs

```bash
git switch feature/owner-dashboard-redesign
git pull origin feature/owner-dashboard-redesign
pnpm install   # picks up new testing-library + jsdom devDeps
```

In a separate terminal:
```bash
pnpm dev    # Next.js on :3000
```

Optional second terminal (only needed for approve flow / channel enrollment to actually post):
```bash
pnpm worker  # Railway worker on :3001
```

`.env.local` flags worth checking before you start:
- `PAST_REPLIES_VIEW_ENABLED=true` (else `/dashboard/past-replies` 404s — that's by design)
- `MOCK_EXTERNAL_APIS=true` (avoids hitting Twilio/Resend/Stripe locally)

---

## 1. Layout shell — first impression

Sign in as an owner who's in the active state (paid + business + zernio connected). Land on `/dashboard`.

**Pass criteria:**
- [x] **Sidebar**: 240px, sticky, on left. Logo dot + "RepWorth" + business name in top-left. Active state ("Dashboard") has a blue rail accent on the left edge.
- [x] **Sidebar nav**: "Dashboard" + "Past Replies" (only if env flag on) + "Settings" below the divider.
- [x] **User chip** at bottom: 2-letter avatar + owner name + email.
- [x] **Sign out** button below user chip — click should sign out and redirect to `/admin/login`.
- [x] **Topbar**: sticky, glassy (subtle blur). "Dashboard" title + welcome subtitle. Right side: green-pulsing "Live · syncs in 60s" pill + "Refresh" button.
- [ ] **Fonts**: headings in Plus Jakarta Sans (warm, geometric), body in DM Sans (neutral). Marketing pages should be unchanged — open `/` in another tab to confirm the marketing site still uses its old fonts.

**Fail signals:**
- Old top horizontal `OwnerNav` still showing → CSS not loading or build cached.
- Console errors about missing icons or `--rw-*` variables.

---

## 2. Dashboard active state

### Live polling
- [x] "syncs in Ns" countdown ticks down each second (60 → 59 → ... → 1 → 60).
- [ ] At 0, the API refetches silently (no toast spam). Watch DevTools Network tab → confirm a `/api/dashboard` request fires every 60s.
- [x] Click "Refresh" — the icon spins for ~800ms, fresh request fires, countdown resets to 60.

### KPI cards (3-4 tiles)
- [ ] On first paint, three values count up from 0 to their target (cubic ease-out, ~900ms).
- [x] "Reviews handled" shows total + sparkline.
- [x] "Time saved" shows hours + green sparkline.
- [x] "Response rate" shows % + colored progress bar (green ≥80, amber 50-79, red <50). Footnote shows baseline if non-null.
- [x] If there are pending approvals, a 4th amber tile appears with count + "Review now ↓↓" button. Click it — page smooth-scrolls to Reviews card.

### Reviews card
- [x] Defaults to "Needs Action" tab. Red badge with pending count if > 0.
- [x] If 0 pending: floating 🎉 emoji + "All caught up!" + sub-copy.
- [x] Click "All Recent" tab — shows posted reviews too. Each posted review has a "Show response" toggle that expands to show the published reply.
- [ ] On a pending review, the AI draft appears in an amber-bordered box with sparkle icon + "Approve & post" / "Edit" / "Regenerate" buttons. **Click Approve** — verify network tab shows the existing approve POST → success → review re-fetches → status changes to "Posted".

### Velocity chart
- [ ] Bars animate in (height + opacity). Dotted average line across. Pulsing dot on the peak bar.
- [ ] Hover any bar — it stays bright while others fade. Crosshair line + dark tooltip showing "Week of {date}" + "{N} reviews".
- [x] Three KPI summaries above the chart: "This week" with ▲/▼ % delta, "Total · last weeks", "Weekly avg".

### Ranking chart
- [ ] Multi-line chart, one color per keyword, dotted gridlines, keyword label at line-end.
- [x] If `ranking` is null/empty in your test data, the entire card should NOT render.

### Intelligence Brief
- [ ] Gradient blue lightbulb icon, "Weekly" or "Monthly" pill, period label, numbered bullets with rotating accent border colors.
- [x] If `latestBrief` is null in your test data, the card should NOT render.

### Connect-Google banner (top of dashboard)
Switch your test business to each `zernio_connection` status to verify each branch:
- [ ] `active` — banner does NOT render.
- [x] `none` — blue banner with Google icon + "Connect Google Business" + "Connect" button → `/dashboard/connect`.
- [ ] `pending` with `pendingFlow` set — blue "Connecting your Google Business…" + "View progress".
- [ ] `pending` (stale) or `disconnected` — orange "Auto-posting is currently disconnected" (or queued count if > 0) + "Reconnect" button.
- [ ] `finalize_unknown` — orange "Connection requires manual review" with no CTA.

---

## 3. Subscription state branches

The dashboard MUST short-circuit before rendering the new visuals when subscription state isn't "active". Verify each by setting the business's state in Supabase or via your existing admin tooling:

- [ ] **`active_pending_business`** → renders `<ActivePendingBusinessScreen>` (legacy state screen, unchanged). Topbar still shows but no live-pill.
- [ ] **`pending_payment_admin_handoff`** → renders `<PendingAdminHandoffScreen>`.
- [ ] **`pending_payment`** → renders `<PendingPaymentScreen>` with the existing payment CTA.
- [ ] **`active`** → renders the full new dashboard (covered above).

If any of these branches now renders the redesigned visuals instead of the dedicated screen, that's a regression.

---

## 4. Past Replies — `/dashboard/past-replies`

### Env-gated 404
- [ ] With `PAST_REPLIES_VIEW_ENABLED=false`, hitting `/dashboard/past-replies` returns the Next.js 404 page. Expected.
- [x] With `PAST_REPLIES_VIEW_ENABLED=true`, the page renders.

### Layout
- [x] Topbar shows "Past Replies" title + subtitle + "Back to dashboard" link on the right.
- [x] Stats row: 4 small cards — Total replies, Active period, Historical, Avg rating (with star ★).
- [x] Sticky toolbar (white card) below stats: search input + 5 rating chips (All, 5★, 4★, 3★, 2★, 1★).
- [x] Below toolbar: section "From your active period" with count, then reply cards.
- [x] If there are historical replies, second section "From before you joined" appears.

### Filtering (current page only)
- [x] Type a word in the search input — cards on the current page filter live; matched text gets a yellow highlight (`<mark>`).
- [x] Click a rating chip (e.g. 5★) — filters by exact rating.
- [x] Section count updates: "X of Y" where Y is total in that bucket and X is filtered.
- [x] Empty filter result shows the dashed-border "No replies match this filter" empty state.

### Pagination (server-side)
- [x] If you have >50 replies total, pagination footer appears: Previous / "Page N of M" / Next.
- [ ] Click Next — URL becomes `?page=2`, page reloads, new rows load. Filters reset (they're page-local).
- [x] On page 1, Previous is disabled (40% opacity, no pointer events). On last page, Next is disabled.

### Premium upgrade banner
- [x] As a non-premium owner with historical replies — gradient amber "Edit replies from before you joined" banner appears above the historical section. "Upgrade →" links to `/onboarding/pay`.
- [ ] As a premium owner — banner does NOT appear.

### Reply card
- [x] Two columns: left is "Customer review" (Google icon eyebrow, stars, name, date, body). Right is "Your reply on Google" (sparkle icon eyebrow, body, provenance badge).
- [x] Provenance badge: amber "Imported" with history icon for `external_reply_ingested_at` non-null, or blue "Posted via RepWorth" with check icon otherwise.
- [x] Mobile (<720px): the two columns stack vertically, review on top, reply below.

---

## 5. Settings — `/settings`

### Layout
- [x] Topbar shows "Settings" + subtitle + "Back to dashboard" link.
- [x] Below topbar: tab strip with **3 tabs** (General / Brand Voice / Notifications) and a blue sliding underline. "General" highlighted by default.
- [x] Click "Brand Voice" tab — page scrolls to the `#brand-voice` anchor. The underline does NOT move (because Brand Voice's URL is the same `/settings`, just with hash). General tab stays highlighted. **This is intentional per OQ-1.**
- [x] Click "Notifications" tab — navigates to `/settings/channels`.

### General panel (top of page)
- [x] Section header: blue home-icon tile + "Business profile" title + "Identity details from your Google listing…" sub.
- [x] Two-column row (stacks on <640px): Business name + Category — both with "Locked" pill, disabled, gray background.
- [x] Place ID input (locked, monospace small) + "📋 Copy" button.
- [ ] Click Copy — clipboard receives the Place ID, button morphs to "✓ Copied" for 1.5s.

### Brand Voice panel (below General, anchored at `#brand-voice`)
- [x] **Response tone** section (violet sparkle icon): chip picker shows 5 presets + "Custom…". Active chip is highlighted blue.
  - [x] Click "Warm + witty" — `tone` field updates to "warm, witty, occasionally cheeky"; sample preview at the bottom shows the witty preset's sample reply.
  - [ ] Click "Custom…" — textarea appears below the chips with the current `tone` value, char counter (X/100). Type a custom phrase — the preview text falls back to a generic line.
- [x] **Products & services** section (sage lightbulb): textarea, max 2000 chars, counter.
- [x] **Things to avoid** section (rose alert icon): list editor — type in any row, click ✕ to remove, click "+ Add another" to append empty row.
- [x] **Sample replies** section (amber edit icon): same list editor pattern.

### Sticky save bar
- [x] On clean page load: NO save bar visible. ⚠️ **FAIL — save bar renders with "0 unsaved changes" on load; should be hidden until a field is edited.**
- [x] Edit any field (change a chip, type in a list editor, edit textarea) — save bar slides up from the bottom showing "N unsaved change(s) · Discard or save below" + Discard + Save buttons.
- [ ] **Click Save** — button shows "Saving…", network tab fires `PUT /api/settings` with patch body containing only changed fields. On 200: bar slides down, green pill toast appears at bottom-center "✓ Settings saved" for ~1.8s.
- [x] Edit a field then **click Discard** — fields revert to last-saved state, save bar hides, no API call. ⚠️ **FAIL — save bar hides and dirtyCount resets to 0, but the tone chip does not revert to the saved value. Fresh page reload shows the correct chip. Bug in Discard form-state reset.**
- [ ] Make changes that result in no actual diff (e.g. delete a list row then re-add the same value) — `dirtyCount` should be 0 and save bar should hide.

### Reload check
- [ ] After saving, hard-refresh (Ctrl+Shift+R). Verify your changes persist (the saved values are returned by `/api/dashboard`).

---

## 6. Settings — Notifications — `/settings/channels`

- [x] Tab strip shows "Notifications" highlighted, sliding underline anchored to it.
- [x] Topbar shows "Settings" + "Notification channels" sub + "Back to dashboard" link.
- [x] **Email row**: design's `.channel-row` layout, ✉️ icon, owner email, green "Always on" badge.
- [x] **"Pick one extra channel" eyebrow** divider.
- [x] **Telegram row** (interactive — existing logic preserved):
  - [x] If not enrolled: "Tap to pick" or similar status; click → starts the existing enrollment flow (QR / deep link).
  - [ ] If enrolled: row has selected styling, status shows enrolled state. Disconnect/Disable button still works.
  - [ ] Watch the network tab during enroll/cancel/disable — endpoints should still hit `/api/dashboard/channels/telegram/{start,cancel,disable,status}`.
- [x] **SMS row**: opacity 0.7, "Coming soon" badge, no click handler.
- [x] **WhatsApp row**: same coming-soon treatment.

**Critical preservation check:** the channel-enrollment state machine should be byte-identical to before. If anything broke, you'll see it here — D7's restyle was visual only, but it's the highest-risk task because of the production logic involved.

---

## 7. Mobile / responsive (<768px)

In DevTools, switch to mobile viewport (e.g. iPhone 14 Pro, 393×852).

- [x] Sidebar disappears entirely.
- [x] Bottom tab bar appears, fixed to bottom: Home / Needs Action / History (only if past-replies enabled) / Settings. Each with icon + label.
- [x] Active route's tab is blue.
- [x] **Needs Action tab**: tap it. URL becomes `/dashboard#needs-action`. Page scrolls to Reviews card and the Needs Action sub-tab inside the card is auto-selected.
- [x] **Pending badge**: if there are pending approvals, the Needs Action tab shows a small red badge with the count.
- [ ] Subsequent dashboard refreshes do NOT re-scroll the user (we fixed this — the hash-effect runs once on mount, not on every poll).
- [x] Topbar padding shrinks on mobile, content padding shrinks too.
- [x] Past Replies stats row collapses from 4 columns to 2.
- [x] Past Replies reply cards stack from side-by-side to vertical.
- [x] Settings save bar: fixed to bottom but not overlapping the mobile tabbar (the tabbar's offset is built into the save bar's bottom padding — verify visually). ⚠️ **Note — save bar buttons/text correctly clear the tabbar (buttons end at y=783, tabbar starts at y=783), but the save bar's opaque background covers the tabbar area visually.**

---

## 8. DevTools sanity checks

### Console (after walking the dashboard + past-replies + settings)
- [x] No red errors.
- [x] No React warnings (key prop missing, hydration mismatch, hook order, setState on unmounted).
- [ ] No CSS variable warnings.
- [x] Possibly a hydration warning during the first 60s polling cycle if you hit a SSR/CSR boundary — flag if persistent.

### Network
- [x] `/api/dashboard` fires once on mount, then every 60s.
- [ ] Approve POST still hits the existing approval endpoint.
- [ ] Settings save still hits `PUT /api/settings`.
- [ ] No new endpoints called by the redesign (the new code is pure UI on top of existing APIs).

---

## 9. Type-check + tests + build (sanity)

```bash
pnpm tsc --noEmit       # 8 pre-existing errors only (e2e + sentry-scrub tests)
pnpm lint               # 15 pre-existing errors only (worker test files, no-explicit-any)
pnpm build              # 57 pages, success
pnpm test               # 1997 pass / 1 skip — first run may have ~5 Windows suite-order flakes; re-run goes clean
```

If `pnpm test` shows new failures (anything outside `OnboardingDemoWorker.test.ts`, `bounced-skip*`, or the e2e/sentry-scrub baselines), STOP and report.

---

## 10. Sign out

- [x] Click "Sign out" in the sidebar (or mobile equivalent: there isn't one — that's a known gap, sign-out is sidebar-only).
- [x] You should land on `/admin/login`.
- [x] Re-attempt to access `/dashboard` → redirects back to `/admin/login`. ⚠️ **Note — actual redirect goes to `/login?from=%2Fdashboard` (owner login with return URL), not `/admin/login`. Functionally correct.**

---

## What to flag

If anything above doesn't match expected, capture:
1. URL + viewport size.
2. Screenshot of the issue.
3. DevTools console output if relevant.
4. Network tab if an API call is involved.

Drop the report in PR [#27](https://github.com/norbertesekiel47/ai-review-responder/pull/27).

### Most likely failure modes
- A CSS class name typo → unstyled element.
- A subscription-state branch not preserved → wrong screen rendering.
- A live-poll bug → network tab shows requests every <60s or never.
- A settings field not patching → check the network tab's `PUT /api/settings` body.
- Channels enrollment regression → highest-risk task (D7); compare against pre-redesign behavior on `main` if uncertain.

---

## Appendix — known non-blocking notes (from code review)

These were flagged during subagent review and intentionally left for follow-up; they are NOT regressions:

1. **B5 ReviewsCard** — `STATUS_BADGE` lookup falls back to "Pending Approval" styling for unknown statuses. Closed status set today, but a future status would silently appear as Pending. Not a runtime bug; cleanup PR opportunity.
2. **D4 SettingsShell** — Save button's blue background is set via inline `style={{ background: 'var(--rw-blue-600)' }}` instead of a CSS class. Visual-only inconsistency.
3. **D5 GeneralPanel** — Place ID copy button uses 📋 emoji instead of an `<Icon>` component for the copy state. Other action buttons use `<Icon>`. Visual-only inconsistency.
4. **A6 TopBar** — `setTimeout(() => setRefreshing(false), 800)` inside `finally` isn't cancelled on unmount. Could log a setState-on-unmounted warning in React strict mode if the user navigates away mid-refresh. Edge case, not observed.
5. **A2 layout** — Plus Jakarta Sans is loaded with weight 800, but `tokens.css` doesn't reference 800 in the app scale (only marketing). One extra ~20–30KB font file downloaded for the authenticated routes. Trivial perf cleanup if you care.

None of these block the PR.
