# Launch-Ready Part 2 — Remaining Yellow (🟡) Polish

> **Date:** 2026-05-29
> **Branch / worktree:** `worktree-launch-yellow-polish` (`.claude/worktrees/launch-yellow-polish`)
> **Source audit:** `docs/launch-ready-part2.md`
> **Scope decision:** "Frontend polish bundle" — the 5 actionable 🟡 items + 3 stale-marker doc-ticks. Canonical domain = **repworth.net**. Excludes #23b (Zernio reconnect-queue backend feature).

## Goal

Close the remaining yellow (partial / pending) items from the Part-2 UI audit. Every change is presentational, copy, or accessibility — **no behavioral / data logic is altered**. Each item ships with a test (TDD). Validation runs via PR CI (the project forbids validating from a nested worktree).

## Non-goals (explicitly out of scope)

- **#23b Zernio reconnect-queue actions** — needs a new admin route + `awaiting_owner_connect` status transitions via `job_outbox` + admin audit logging. Its own backend PR. The `TODO(zernio)` pointer stays in `ZernioConnectionPanel.tsx`.
- **Full auth-forms rebrand** (audit line 78, an unmarked **P0**): Login / ForgotPassword / ResetPassword / CheckEmail / FinishSignup share `auth-island.css` and are still gray/blue. FinishSignup here gets **labels only**, not an island rebrand.
- **App-wide aria-live sweep**: only the two files already edited in this bundle gain a `<LiveRegion>`. The remaining low-traffic surfaces (login/forgot/reset, add-location wizard, etc.) stay an honest "still pending" in the doc.
- **Resend sending-domain migration**: the operative send address is the `RESEND_FROM_EMAIL` env var, which must point at a **Resend-domain-verified** mailbox. Moving live sends to `.net` is an ops/DNS task (verify the `.net` domain in Resend + ensure `support@`, `billing@`, `security@`, `noreply@` mailboxes receive). This spec only changes code/brand strings and flags the ops dependency.

---

## Item 1 — Domain unification → `repworth.net`

**Why:** Audit lines 75 & 126 — user-facing emails/URLs are split across `.com` and `.net`. Collapse to one canonical apex (`.net`, per legal "Website: repworth.net").

**Changes (user-facing display strings, `.com` → `.net`):**

| File | Current |
|---|---|
| `src/app/(authenticated)/error.tsx` | `mailto:support@repworth.com` |
| `src/app/(public)/login/error.tsx` | `mailto:support@repworth.com` |
| `src/app/(public)/signup/error.tsx` | `mailto:support@repworth.com` |
| `src/app/global-error.tsx` | `mailto:support@repworth.com` |
| `src/app/mfa/challenge/page.tsx` | `SUPPORT_EMAIL = 'support@repworth.com'` |
| `src/app/onboarding/error.tsx` | `mailto:support@repworth.com` |
| `src/app/onboarding/payment-success/PaymentSuccessClient.tsx` | `mailto:support@repworth.com` |
| `src/components/sections/how-it-works/HowItWorksContent.tsx` | illustrative `<drafts@repworth.com>` |

**Brand fallback default (code default, not the live sender):**
- `src/lib/notifications/contact-notify.ts` — `COMPANY_NOREPLY = 'noreply@repworth.com'` → `.net`.
- `.claude/reference/env-vars.md` — the `noreply@repworth.com` mention in the `CONTACT_NOTIFY_TO` row → `.net` (keep the doc and code in sync).

**Left intentionally unchanged:**
- `RESEND_FROM_EMAIL` (env-driven live sender; ops concern — flagged above).
- `unsubscribe@repworth.example.com` in `email/headers.ts` (deliberate non-functional misconfig placeholder).
- Test fixtures using `app.repworth.com` / `app.repworth.net` (example URLs, not brand-facing).

**Test:** new guard test asserting no **user-facing** source file (the `src/app/**` + the listed components) emits `@repworth.com`. Scope the glob to avoid the intentional infra/test exceptions above.

**Acceptance:** no `@repworth.com` in any user-clickable mailto or displayed string; guard test green; one-line note added to the spec/PR about the `RESEND_FROM_EMAIL` ops dependency.

---

## Item 2 — Past-replies first-run empty state (`PastRepliesClient.tsx`, TODO P2 #28)

**Why:** Audit line 165. A brand-new account with zero replies sees the filter-specific copy "No replies match this filter" — wrong for a first run.

**Current:** `Empty()` (line ~286) is a no-prop component rendered at two sites:
- **Gap** section (`visibleGap.length === 0`, ~line 167) — the first-run candidate.
- **Historical** section (`visibleHist.length === 0`, ~line 195) — only rendered inside `{hasHistoricalSection && …}`, so historical replies exist → never first-run.

Available state at the call sites: `hasActiveFilter` (line 65), `totalReplies` (line 63).

**Change:** `Empty({ firstRun }: { firstRun: boolean })`.
- Gap call site → `firstRun={!hasActiveFilter && totalReplies === 0}`.
- Historical call site → `firstRun={false}`.
- `firstRun === true` copy (brand voice, concrete, no AI-slop): title **"No replies yet"**, sub **"Approved replies will appear here as you respond to your reviews."**
- `firstRun === false` keeps the existing filter copy ("No replies match this filter" / "Try clearing your search, or pick a different rating chip.").
- Remove the `TODO(P2 #28)` comment.
- No color/icon changes (icon already teal via `--rw-star` sweep); no new CSS.

**Test:** extend `PastRepliesClient.test.tsx` — (a) zero replies + no filter → "No replies yet"; (b) active filter + zero matches → "No replies match this filter".

**Acceptance:** first-run copy shown only when `!hasActiveFilter && totalReplies === 0`; filter copy otherwise; TODO removed.

---

## Item 3 — Admin flagged-queue pagination total (`api/admin/flagged/route.ts` + `app/admin/flagged/page.tsx`)

**Why:** Audit line 107. `flagged/page.tsx:157` renders `Showing 1–50` with no total; the API returns no count.

**API change (`route.ts` GET):** alongside the existing OPEN-queue read, add
`SELECT COUNT(*)::int AS total FROM flagged_responses WHERE status = 'open'`
(separate cheap query — correct even when the page is empty; mirrors the queue's `status = 'open'` semantics). Return `total` in the JSON: `{ flagged, limit, offset, total }`. Auth / AAL2 / CSRF path unchanged.

**Frontend change (`page.tsx`):** add `total: number` to the query result type; render `Showing {offset + 1}–{offset + data.flagged.length} of {data.total}`. Pagination button enable/disable logic unchanged (still keyed off `PAGE_SIZE`).

**Tests:** extend `api/admin/flagged/__tests__/route.test.ts` to assert `total` is present and correct; extend/adjust the flagged page test for the "of Z" string if one asserts the span.

**Acceptance:** GET returns an accurate `total`; UI shows "Showing X–Y of Z"; existing auth/disposition tests still green.

---

## Item 4 — FinishSignup visible labels (`FinishSignupClient.tsx`)

**Why:** Audit line 115. Inputs are already screen-reader-accessible (associated `sr-only` `<label htmlFor>`), so the gap is **visible** labels, not a11y.

**Change:** convert the three `sr-only` labels (email / name / phone) to **visible** labels, styled minimally to match the *current* form (neutral text label above each input). Do **not** island-rebrand the form (that's the out-of-scope P0). Placeholders may be dropped where the visible label makes them redundant. Keep `htmlFor`/`id` associations intact.

**Test:** extend/add a label test asserting each input has an associated, visible (`:not(.sr-only)`) label.

**Acceptance:** all three labels visible and associated; form still submits via the unchanged `handleSubmit`.

---

## Item 5 — Bounded aria-live pass (only the two files this bundle already edits)

**Why:** Audit line 112. Async feedback on these surfaces is silent to screen readers.

**Change:** wire the existing `src/components/ui/LiveRegion.tsx` into:
- **`FinishSignupClient.tsx`** — render `<LiveRegion level="assertive" message={error} />` (the `error` `<p>` is currently silent). Touched anyway for Item 4.
- **`app/admin/flagged/page.tsx`** — announce disposition result: `<LiveRegion>` polite for success, assertive for `actionError`. Touched anyway for Item 3.

**Explicitly NOT touched:** login/forgot/reset, add-location wizard, edit-reply drawer save — stay "still pending" in the doc (no false "done" claim).

**Test:** component tests assert the live region announces on error (FinishSignup) and on disposition success/error (flagged).

**Acceptance:** both surfaces announce; doc note remains honest about the un-swept surfaces.

---

## Doc-ticks (stale 🟡 — verified already done; flip marker to ✅ with a one-line note)

- **Legal `generateMetadata`** (line 82): all 5 `legal/*` pages already export static `metadata` (static pages don't need `generateMetadata`). Mark resolved.
- **Payment-success timeout support link** (line 96): done in #20 (`PaymentSuccessClient.tsx:186`). Mark resolved.
- **Auth-page `noindex`** (#3, line 136): done in #19/PR #180 via the shared `noindexRobots` fragment. Mark resolved.

Also update the audit lines for Items 1–5 to their new state once shipped (line 75 domain → resolved; lines 107, 112, 115, 165 → resolved/partial as appropriate).

---

## Process & verification

- TDD per item; tests live beside the code they cover.
- **Validation = PR CI** (lint / typecheck / test / build). Per CLAUDE.md, do **not** run `pnpm` from this nested worktree (resolves into the parent `node_modules` and poisons lint/test). Push the branch and read the runner.
- Land via PR (main is protected). Conventional-commit title.
- For DB-touching changes (Item 3 adds a read-only `COUNT`), the change is a plain admin cross-tenant SELECT already allowlisted in tenant-scope; re-run `ci:tenant-scope` / `ci:rls-audit` in CI to confirm no new violation.

## File inventory (touched)

- `src/app/(authenticated)/error.tsx`, `src/app/(public)/login/error.tsx`, `src/app/(public)/signup/error.tsx`, `src/app/global-error.tsx`, `src/app/mfa/challenge/page.tsx`, `src/app/onboarding/error.tsx`, `src/app/onboarding/payment-success/PaymentSuccessClient.tsx`, `src/components/sections/how-it-works/HowItWorksContent.tsx`, `src/lib/notifications/contact-notify.ts`, `.claude/reference/env-vars.md` — Item 1
- `src/app/(authenticated)/dashboard/past-replies/PastRepliesClient.tsx` (+ test) — Item 2
- `src/app/api/admin/flagged/route.ts` (+ test), `src/app/admin/flagged/page.tsx` (+ test) — Item 3
- `src/components/auth/FinishSignupClient.tsx` (+ test) — Items 4 & 5
- (new) domain guard test — Item 1
- `docs/launch-ready-part2.md` — doc-ticks
