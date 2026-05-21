# Owner Dashboard Redesign — Design Spec

_Date: 2026-05-07_
_Branch: `feature/multi-location` (will likely be re-cut to a dedicated `feature/owner-dashboard-redesign` branch before implementation)_
_Source: `claude.ai/design` handoff bundle "RepWorth (Dashboard)" — 3 pages (Dashboard, Past Replies, Settings)_

## 1. Goal

Replace the current visual treatment of the owner-facing authenticated surface with the design captured in the handoff bundle, while preserving every behavior, API contract, and system invariant currently in production.

In scope:
- `/dashboard` (`src/app/(authenticated)/dashboard/page.tsx` + `DashboardContent.tsx`)
- `/dashboard/past-replies` (`src/app/(authenticated)/dashboard/past-replies/page.tsx`)
- `/settings` (`src/app/(authenticated)/settings/page.tsx`)
- `/settings/channels` (re-skinned tab content; URL preserved)
- Authenticated layout shell (`src/app/(authenticated)/layout.tsx` and `src/components/OwnerNav.tsx`)

Not in scope:
- Marketing site (`/`, `/features`, `/pricing`, `/how-it-works`, `/login`, `/signup`, `/feedback`, `/privacy`, `/terms`, `/book-a-demo`, `/demo/...`) — completely untouched.
- Admin surface (`/admin/*`) — untouched.
- Public approval UI (`/approve/[token]`) — untouched.
- Onboarding wizard (`/onboarding/*`) — untouched.
- API routes, worker code, database schema — no changes.

## 2. Behavior preservation contract (NEVER violate)

### 2.1 Architecture invariants (from `.claude/CLAUDE.md`)
- Vercel = UI only. No new LLM or external API calls in Next.js routes.
- Transactional outbox unaffected — no changes to `job_outbox` writers.
- No auto-posting path. Approve → Post still requires explicit owner click → `ReviewActions` POST → existing approval flow.
- Approval token handling unchanged.
- Subscription guard preserved on every customer-facing data fetch (the existing `useDashboardData` already encodes this).
- Auth scope still app-enforced via `requireOwnerAccess` server-side.

### 2.2 Dashboard runtime states (from `DashboardContent.tsx`)
The four subscription-status branches MUST continue to render their dedicated screens:
- `active_pending_business` → `<ActivePendingBusinessScreen />`
- `pending_payment_admin_handoff` → `<PendingAdminHandoffScreen />`
- `pending_payment` → `<PendingPaymentScreen data={data} />`
- active (default) → new redesigned dashboard

`error`, `!data` (loading) early returns also preserved.

### 2.3 API surfaces (untouched)
- `GET /api/dashboard` — existing payload shape (`DashboardData` union) consumed unchanged.
- `PUT /api/settings` — existing patch shape consumed unchanged. Tone/products/avoidFacts/sampleResponses/ownerPhone/weekly/monthly fields all preserved as-is.
- `POST /api/reviews/[id]/approve` (and edit/regenerate) — `<ReviewActions>` component reused unchanged.
- Past Replies server-side pagination via `?page=` URL param preserved.
- `PAST_REPLIES_VIEW_ENABLED` env-gated 404 preserved.
- `/settings/channels` route preserved (tab strip just reflects active tab).

### 2.4 Data invariants
- `DashboardSettings` shape (`@/lib/dashboard/types`) consumed as-is. Existing API expects `avoidFacts: string[]` and `sampleResponses: string[]`.
- `recentReviews` payload consumed as-is, including `responseStatus ?? status` resolution.
- Past Replies row shape (`PastReplyCard.row`) consumed unchanged for the redesigned card.

## 3. Visual / UX changes

### 3.1 Layout shell (replaces `<OwnerNav>`)
- 240px sticky left sidebar with: brand mark + RepWorth + business name; nav items (Dashboard, Past Replies, divider, Settings); user chip (initials avatar + owner name + email); Sign out button at bottom.
- Sticky topbar (page title + sub) with right-side: live-pill (`Live · syncs in Ns` with pulsing green dot) + manual refresh button. On Past Replies and Settings, the right-side instead contains a "Back to dashboard" link (matches design).
- Mobile (<768px): sidebar hidden; bottom 4-tab tabbar (Home, Needs Action, History, Settings) with red badge on Needs Action when pending count > 0.
- The `Past Replies` nav item is gated by `PAST_REPLIES_VIEW_ENABLED` (matches today's behavior).

### 3.2 Fonts
- Add Plus Jakarta Sans (display) and DM Sans (body) via `next/font/google` in the authenticated layout. Expose as CSS variables `--rw-font-display` and `--rw-font-body`.
- Marketing/admin/public surfaces are NOT changed — they keep their existing fonts. Scope is the authenticated `<body>` only.

### 3.3 Dashboard sections (active state, in this order — re-ordered from today)
1. Connect-Google banner (only when `zernioConnection.status` warrants it; reuses existing decision logic from `<ConnectGoogleBanner>`).
2. KPI cards row (3 cards always, optional 4th amber "Pending approvals" card when `pending > 0`):
   - Reviews handled (count-up animation, sparkline mini-chart).
   - Time saved (count-up, sparkline).
   - Response rate (count-up + colored progress bar; baseline footnote).
   - Pending approvals (amber gradient, "Review now" jump link to Reviews card).
3. Reviews card (Needs Action / All Recent tabs, red badge count, AI draft inline with Approve/Edit/Regenerate, posted-response collapsible, "All caught up" empty state with floating emoji).
4. Review Velocity card (gradient bars + smoothed trend curve + average dotted line + peak marker + hover tooltip + 3 micro-KPIs above the chart).
5. Search Ranking card (existing line chart visual).
6. Intelligence Brief card (gradient lightbulb icon, weekly badge, period label, parsed bullets with rotating accent borders).

### 3.4 Past Replies redesign
- Stats row (4 small cards): total replies, active period count, historical count, avg rating (numbers come from existing server-side counts; we'll add `avgRating` to the server query — it's a single SQL `AVG(star_rating)`).
- Sticky toolbar (search input + 5 rating chips: All / 5 / 4 / 3 / 2 / 1).
  - **Search & rating filters operate on the current page only** (50 rows). Subtitle text makes this explicit ("Searching this page"). Pagination stays server-side. Justification: existing query uses `LIMIT/OFFSET` with no full-text index; doing real server-side search in this PR is out of scope and would need either DB changes or a denormalized search column.
- Section "From your active period" (count: gapTotal).
- Section "From before you joined" (count: histTotal) — wrapped by historical upgrade banner for non-premium owners (existing component, restyled).
- Reply card: side-by-side two-column layout (Customer review on left, Your reply on right) with provenance badge (Imported vs Posted via RepWorth) — driven by the same `external_reply_ingested_at !== null` flag the existing card uses.
- Pagination unchanged (Previous / Page N of M / Next).

### 3.5 Settings redesign
- Tab strip with sliding underline animation across **3 tabs**:
  - **General** — `/settings` — locked Business name + Category + Place ID (with copy-to-clipboard button).
  - **Brand Voice** — `/settings` (sub-rendered alongside General — see §3.5.1) — tone chip picker + textarea fallback ("Custom..."), products & services textarea, avoid-facts list editor, sample-replies list editor, animated tone preview snippet.
  - **Notifications** — `/settings/channels` — Email always-on row, "pick one extra" channel cards (Telegram active, SMS/WhatsApp coming-soon — matches `<ComingSoonChannelRow>` semantics), weekly + monthly report switches, contact details (phone editable; email locked).
- Sticky save bar slides up from the bottom when there are unsaved changes, showing "N unsaved change(s) · Discard | Save changes". Wired to existing `PUT /api/settings`.
- Saved-success toast (the existing green banner, styled as a centered pill toast).
- Drop tabs from the design: **Billing** and **Danger Zone**. Reasoning: no existing API or wired flow for billing self-service or account deletion in the codebase. Adding visual-only "coming soon" tabs would be misleading. Out of scope for this redesign.
- Drop the mascot easter egg, Tweaks panel, accent toggle, density toggle, demo mode — all dev-only frills.

#### 3.5.1 Settings tab routing
Two URL routes drive the three visual tabs:
- `/settings` renders General + Brand Voice as a single scrollable page (one `SettingsTabs` highlight: "General"). Both panels share a single dirty-state save bar.
  - Rationale: General contains 3 locked fields (3 inputs); Brand Voice contains the bulk of editable fields. Splitting them across two URLs would force two save buttons and split a coherent profile-editing flow. The design's tab strip serves as a visual anchor; routing follows existing reality.
  - Alternative considered: a third URL `/settings/voice`. Rejected — adds a route for one panel that's logically the same form payload as General.
- `/settings/channels` renders Notifications (existing `<ChannelsClient>`, restyled).

The `SettingsTabs` component shows three tabs but two of them (General, Brand Voice) link to the same `/settings` URL; clicking either is a no-op when already on `/settings` and the underline anchors to whichever section the user has scrolled to (or simply stays on "General" — see open question OQ-1 below).

### 3.6 Animations kept (production-suitable)
- Count-up KPI numbers (cubic ease-out, ~900ms).
- Sparklines drawn with stroke-offset on mount.
- Section fade-up stagger on initial load (~50ms staggered delays, 6 sections).
- Live-pill pulsing dot.
- Refresh button spin on click.
- "All caught up" floating emoji.
- Chart bar height tween + trend-line stroke-dash draw.
- Review card fade-in.
- Tab sliding underline (Settings).
- Sticky save bar slide-up.
- Hover micro-interactions (KPI translateY, card box-shadow lift).

### 3.7 Animations dropped
- Coffee mascot easter egg.
- "Demo mode" stream of fake reviews.
- Tone-preview retype animation (kept as a single fade-in instead of per-tone retype, simpler implementation).
- Toast confetti pulse — replaced with the existing inline success banner styled as a corner toast.

## 4. Implementation approach

### 4.1 Styling: plain CSS files, scoped to authenticated layout
- Port `tokens.css`, `styles.css` (shell), `past-replies.css`, `settings.css` from the design package into `src/app/(authenticated)/_styles/`.
- Imported once from `src/app/(authenticated)/layout.tsx` — Next.js automatically scopes those styles to the authenticated route segment, so marketing/admin pages remain untouched.
- All design class names preserved (`.kpi-grid`, `.review`, `.pr-card`, `.settings-tabs`, etc.) for 1:1 visual match. Components consume them via `className=`.
- Tailwind classes in non-redesigned components (admin, marketing, onboarding) remain untouched.

Alternative considered: re-author every class as Tailwind utilities. Rejected — high re-translation risk, throws away the verified visual output, and Tailwind would clash with the design's `--rw-*` token system.

### 4.2 Refresh + live polling
- `useDashboardData` (verified: `src/hooks/useDashboardData.ts`) currently fires `refresh()` once on mount and never polls.
- The new `<TopBar>` adds a 60s `setInterval` that calls `refresh()`, with a visible "syncs in Ns" countdown. Manual refresh button calls the same `refresh()` and resets the countdown.

### 4.3 Reviews tabs: Needs Action / All Recent
- The existing `recentReviews` array is a single list. New visual filters by `responseStatus ?? status === 'pending_approval'` for Needs Action.
- Pending count = badge count = "N awaiting your approval" subtitle, all derived from the same filter.

### 4.4 Past Replies stats row
- `gapTotal` and `histTotal` already computed server-side. Add `avgStarRating` from the same server component (one extra `AVG(star_rating)` SQL — single round trip with the existing count queries).

### 4.5 Tone chip picker
- Free-text `tone` field stays as the single source of truth. Tone chips set the field's value; "Custom..." reveals the existing textarea bound to `tone`.
- Mapping: choosing a chip writes a canonical phrase to `tone` (e.g., "warm, friendly" / "warm, witty, occasionally cheeky" / "professional" / "casual" / "concise"). On load, we infer the active chip by substring-match against `tone`; falls back to "Custom..." if no preset matches.

### 4.6 List editors (avoidFacts, sampleResponses)
- Replace existing `\n`-joined textareas with array-of-inputs editors.
- Patch payload shape unchanged (`string[]`).

## 5. File-by-file impact

### New files
- `src/app/(authenticated)/_styles/tokens.css` — ported from design.
- `src/app/(authenticated)/_styles/console.css` — ported from `styles.css`.
- `src/app/(authenticated)/_styles/past-replies.css` — ported from design.
- `src/app/(authenticated)/_styles/settings.css` — ported from design.
- `src/components/dashboard/Sidebar.tsx` — sidebar shell (replaces `OwnerNav`).
- `src/components/dashboard/TopBar.tsx` — sticky topbar with live-pill + refresh.
- `src/components/dashboard/MobileTabBar.tsx`.
- `src/components/dashboard/Sparkline.tsx`.
- `src/components/dashboard/Icon.tsx` — small inline SVG icon set used across the new shell.
- `src/components/dashboard/KpiCards.tsx` — replaces `ValueSummary` rendering for the active state.
- `src/components/dashboard/ReviewsCard.tsx` — replaces `ReviewsList` rendering (still uses `<ReviewActions>` internally).
- `src/components/dashboard/VelocityCard.tsx` — replaces velocity chart from `Charts.tsx`.
- `src/components/dashboard/RankingCard.tsx` — replaces ranking chart from `Charts.tsx`.
- `src/components/dashboard/IntelligenceBriefCard.tsx`.
- `src/components/dashboard/LiveRefreshIndicator.tsx` (60s timer + countdown display + auto-refresh hook).
- `src/app/(authenticated)/dashboard/past-replies/PastRepliesClient.tsx` — client wrapper for search/chip filtering of the current page.
- `src/components/dashboard/settings/SettingsShell.tsx` — sticky save bar + saved-toast + dirty-state plumbing.
- `src/components/dashboard/settings/GeneralPanel.tsx`.
- `src/components/dashboard/settings/BrandVoicePanel.tsx`.
- `src/components/dashboard/settings/ListEditor.tsx`.
- `src/components/dashboard/settings/ToneChipPicker.tsx`.

### Rewritten files
- `src/app/(authenticated)/layout.tsx` — sidebar shell, font import, CSS import, mobile tabbar render.
- `src/components/DashboardContent.tsx` — wires new components, preserves 4-state branching, hooks live-refresh into `useDashboardData`.
- `src/app/(authenticated)/dashboard/past-replies/page.tsx` — keeps server-side fetch + pagination, delegates render to `PastRepliesClient`. Adds `avgStarRating` query.
- `src/app/(authenticated)/settings/page.tsx` — renders General + Brand Voice panels + sticky save bar.
- `src/app/(authenticated)/settings/SettingsGeneralForm.tsx` — split: data-fetching + dirty-state hook stays here, UI moves to General/BrandVoice panels.
- `src/components/dashboard/SettingsTabs.tsx` — sliding underline, 3 tabs.
- `src/components/dashboard/PastReplyCard.tsx` — new side-by-side layout.
- `src/components/dashboard/ConnectGoogleBanner.tsx` — restyled to match new banner spec (orange/blue variants).
- `src/components/dashboard/HistoricalUpgradeBanner.tsx` — restyled to match new gradient design.
- `src/app/(authenticated)/settings/channels/ChannelsClient.tsx` — restyled to match new "channel rows" + "pick extra" design; existing logic preserved.

### Removed files
- `src/components/OwnerNav.tsx` — replaced by `Sidebar` + `TopBar` + `MobileTabBar`. Confirmed: no other consumers (admin uses its own nav).
- `src/components/dashboard/ValueSummary.tsx` — replaced by `KpiCards`.
- `src/components/dashboard/ReviewsList.tsx` — replaced by `ReviewsCard`.
- `src/components/dashboard/Charts.tsx` — split into `VelocityCard.tsx` + `RankingCard.tsx`.

## 6. Testing strategy
- Existing unit/integration tests under `src/__tests__` and `__tests__` continue to pass. Any tests that asserted on old class names (e.g., `bg-gradient-to-r from-blue-600 to-blue-700`) get updated to match the new class names.
- Add a smoke test for the new `<Sidebar>` component (renders nav items, active state, sign-out wires to Supabase).
- Manual smoke check via `pnpm dev`: verify all four subscription states render; approve flow still posts; settings save still PUTs `/api/settings`; past-replies pagination still works; mobile tabbar appears below 768px.
- Type-check, lint, build all clean before merge.

## 7. Open questions / followups
- **OQ-1**: When the user is on `/settings`, which of the two visual tabs (General / Brand Voice) is highlighted in the tab strip? Recommendation: highlight General (matches the URL path `/settings` and the existing tab semantics from `SettingsTabs`); Brand Voice is a section anchor on the same page. If the user wants distinct routing, we add `/settings#voice` anchor + scroll-spy. Default: "General" stays highlighted regardless of scroll position. Decision needed before implementation.
- ~~**OQ-2**~~: Resolved — `useDashboardData` does not auto-poll today, so `<TopBar>` will own the 60s interval (verified §4.2).
- **OQ-3**: Mobile bottom tab bar shows "Needs Action" as a separate destination. Today, "Needs Action" is just the Reviews card on the dashboard with the Needs Action filter. Recommendation: tapping "Needs Action" routes to `/dashboard#needs-action` and the dashboard's Reviews card auto-selects the Needs Action tab + scrolls into view. Alternative: drop the Needs Action tab and keep just Home / History / Settings (3 tabs). Decision needed.

## 8. Out of scope for this redesign (explicit drops)
| Design feature | Why dropped |
|---|---|
| Tweaks panel (accent / density / sidebar variant / demo mode) | Dev-only preview tooling; no place in production. |
| Coffee mascot easter egg | Cute but tonally off for a paid SMB product. |
| Demo-stream toggle | Dev-only preview. |
| Billing tab | No existing billing self-service; would be a misleading visual-only stub. |
| Danger Zone tab | No existing pause/delete endpoints. |
| Per-tone retype animation | Replaced with simpler fade-in. |
| Saved confetti pulse | Reduced to a corner toast. |

## 9. Rollout
- One PR (large but focused). No feature flag — the redesign is a pure-visual swap of an authenticated surface; users see the new look on next refresh.
- `feature/multi-location` branch state: clean (head matches main). Recommend cutting `feature/owner-dashboard-redesign` from current main to keep history clear; multi-location work resumes on its own branch later.
- No DB migration needed.
- No env changes needed (all gates — `PAST_REPLIES_VIEW_ENABLED`, `EXTERNAL_REPLY_IMPORT_ENABLED` — are unchanged).
