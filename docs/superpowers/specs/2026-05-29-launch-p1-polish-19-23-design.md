# Design — Launch P1 Polish (#19–22, #23a)

> **Date:** 2026-05-29
> **Source:** `docs/launch-ready-part2.md` → "Prioritized fix list" → "P1 — Noticeable, fix before/at launch", items 19–23.
> **Branch/worktree:** `worktree-launch-p1-polish-19-23` (branched fresh from `origin/main`).
> **Status of audit doc vs. code:** verified item-by-item against the actual tree on 2026-05-29; several items were already partly resolved (noted below).

## Scope

Five small, presentational / copy / CSS / correctness fixes that follow already-established RepWorth patterns:

| # | Item | Size |
|---|------|------|
| 19 | Per-page metadata (titles + auth/legal `noindex`) | medium-mechanical |
| 20 | Payment-success 5-min timeout support link | trivial |
| 21 | Remove fabricated Book-a-demo testimonial | trivial |
| 22 | Auth-island mobile CSS (min-height + signup grid) | trivial |
| 23a | Admin payment-success polling cleanup | small |

**Explicitly deferred:** **#23b — Zernio reconnect-queue force-drain/dismiss actions.** This has no backend today (verified: no drain/dismiss routes exist; `awaiting_owner_connect` status is set only by `src/lib/publishing/zernio-publisher.ts`). It needs new admin-only route(s), `awaiting_owner_connect` status-transition semantics through the transactional outbox, admin audit logging, tenant-scope handling, and tests — and it touches architecture invariants #2 (outbox), #3 (no auto-post), and the audit-write rule. It gets its own brainstorm → spec → PR. The existing `TODO(zernio)` comment in `ZernioConnectionPanel.tsx:235` stays in place and is the pointer for that follow-up.

## Non-goals

- No restyle of the admin payment-success page (internal tool, "judged on function not polish" per the audit). #23a is a correctness fix only.
- No admin-page `noindex` (the audit scopes #19 to public + auth + legal). Noted as a separate follow-up below.
- No behavioral change to any polling/redirect/auth logic. All five items are additive or presentational.

---

## Item designs

### #19 — Per-page metadata

Today only 5 routes export `metadata` (`approve/[token]`, `demo/[slug]`, `feedback/thanks`, `help/contact`, root `layout`). Everything else inherits the root `title: 'RepWorth'` and is implicitly indexable.

**One authoritative owner for the `noindex` fragment.** New file `src/lib/seo.ts`:

```ts
import type { Metadata } from 'next';
/** Robots directive for pages that must never be crawled or cached
 *  (sensitive forms / auth surfaces). Single owner — see launch audit #19. */
export const noindexRobots: NonNullable<Metadata['robots']> = { index: false, follow: false };
```

This mirrors the value the `approve/[token]` page already inlines; consolidating it here keeps the 7 new auth surfaces from copy-pasting the same object.

**Auth surfaces — title + `noindexRobots` (server pages, direct `export const metadata`):**
- `src/app/(public)/login/page.tsx`
- `src/app/(public)/signup/page.tsx`
- `src/app/(public)/signup/check-email/page.tsx`
- `src/app/(public)/signup/finish/page.tsx`
- `src/app/(public)/forgot-password/page.tsx`
- `src/app/(public)/reset-password/page.tsx`

**MFA — client page → new `src/app/mfa/layout.tsx`** (server component) carrying `title` + `noindexRobots`. (Client components cannot export `metadata`; a segment layout is the standard Next.js fix and covers the whole `/mfa` subtree.)

**Public marketing — title + description, stay indexable:**
- `src/app/(public)/page.tsx` (landing)
- `src/app/(public)/features/page.tsx`
- `src/app/(public)/how-it-works/page.tsx`
- `src/app/(public)/pricing/page.tsx`
- `src/app/(public)/book-a-demo/page.tsx`
- `src/app/(public)/security/page.tsx`

**Legal — title + description, stay indexable** (legal docs should be crawlable):
- `src/app/(public)/legal/{aup,cookies,privacy,sub-processors,terms}/page.tsx`

The `/terms` and `/privacy` redirect stubs need nothing (they `permanentRedirect` to `/legal/*`).

Titles follow a `'<Page> · RepWorth'` convention (e.g. `'Pricing · RepWorth'`, `'Log in · RepWorth'`). Each page exports its own `metadata` object; per-page values merge over the root layout.

**Test:** a contract test (`src/__tests__/page-metadata.test.ts`) that scans the auth surface files + `mfa/layout.tsx` and asserts each references `noindexRobots` (or an inline `index: false`), and that the public/legal page files export a `metadata` with a non-default `title`. File-content scan (not import) — mirrors the existing `island-overflow.test.ts` / `console-admin-palette.test.ts` guard-test precedent and avoids pulling server-only deps into vitest.

### #20 — Payment-success timeout support link

`src/app/onboarding/payment-success/PaymentSuccessClient.tsx`, timeout branch (currently ~L184): the copy already says "Please contact support if it persists" but as **plain text**. Make "contact support" a real `mailto:support@repworth.com` link, styled with the brand teal `#97B3AE` (underlined link), matching the MFA no-factor recovery-link pattern shipped in PR #160. Polling/timeout logic untouched.

**Test:** extend `PaymentSuccessClient.test.tsx` — assert the timeout state (`elapsed > MAX_POLL_DURATION_MS`) renders an `<a href="mailto:support@repworth.com">`.

### #21 — Remove fabricated Book-a-demo testimonial

`src/app/(public)/book-a-demo/BookADemoContent.tsx` (~L67–78): delete the testimonial `motion.div` — the fabricated quote ("…12% to 100% in the first week.") and the "- Local restaurant owner (placeholder)" attribution. RepWorth is pre-launch (waitlist); shipping a fabricated customer claim is dishonest. Removing the block is clean (standalone element, no layout/animation dependents).

**Test:** update `BookADemoContent.test.tsx:22` — it currently asserts the placeholder string is **present**; flip it to assert the placeholder attribution and the fabricated-stat quote are **absent**.

### #22 — Auth-island mobile CSS

`src/components/auth/auth-island/auth-island.css`:
- **M9 (island min-height):** `.rw-island` has `min-height: 680px` with no mobile override → taller than iPhone SE (667px). At the existing `@media (max-width: 900px)` rule (where the island already collapses to one column and the showcase pane is hidden), add `min-height: auto;` to `.rw-island`. The 680px floor only exists to balance the two-pane desktop layout; once single-column it's unnecessary.
- **M5 (signup name+phone grid):** add `@media (max-width: 480px) { .rw-field-row .row { grid-template-columns: 1fr; } }` so the name/phone pair stacks on narrow phones instead of two ~150px inputs.

**Test:** add a CSS-contract test (`src/__tests__/auth-island-mobile.test.ts`) asserting (a) a `max-width` media rule sets `.rw-island { min-height: auto }`, and (b) a `max-width` media rule sets `.rw-field-row .row { grid-template-columns: 1fr }`. Matches the `island-overflow.test.ts` file-scan pattern.

### #23a — Admin payment-success polling cleanup

`src/app/admin/payment-success/page.tsx`: the `useEffect` schedules `setTimeout(checkBusiness, 2000)` and `setTimeout(() => router.push(...), 3000)` but returns **no cleanup**. On unmount mid-poll, a pending timer fires → `setState`/navigation on an unmounted component (React warning + stray redirect).

Fix: introduce a `cancelled` flag and track both timer ids; guard every `setState`/`router.push` behind `!cancelled`; clear both timers in the effect's cleanup return. This mirrors the already-clean cancellation pattern in the onboarding `PaymentSuccessClient` (`cancelled` + `timerId` + cleanup). No visual or copy change.

**Test:** add `src/app/admin/payment-success/__tests__/page.test.tsx` — with fake timers + a mocked fetch, render, unmount before the poll resolves/redirect fires, advance timers, and assert no post-unmount `router.push` and no state-update warning.

---

## Verification strategy

Per CLAUDE.md's worktree lab note ("Never validate CI from a git worktree nested inside the repo — module resolution leaks … Push and read the runner"), **the GitHub CI runner is the source of truth** for `lint`, `typecheck`, `test`, `build`. Local vitest runs inside the worktree are unreliable here (no isolated `node_modules`; resolution leaks to the parent). Workflow: implement → push branch → read the 4 CI checks → iterate.

No DB / schema / migration / tenant-scoped query changes, so `ci:tenant-scope` and `ci:rls-audit` are not implicated.

## File inventory (new / modified)

**New:**
- `src/lib/seo.ts`
- `src/app/mfa/layout.tsx`
- `src/__tests__/page-metadata.test.ts`
- `src/__tests__/auth-island-mobile.test.ts`
- `src/app/admin/payment-success/__tests__/page.test.tsx`

**Modified:**
- 6 auth pages + 6 public marketing pages + 5 legal pages (metadata)
- `src/app/onboarding/payment-success/PaymentSuccessClient.tsx`
- `src/app/(public)/book-a-demo/BookADemoContent.tsx` + its test
- `src/components/auth/auth-island/auth-island.css`
- `src/app/admin/payment-success/page.tsx`
- `docs/launch-ready-part2.md` (tick #19–22, #23a; mark #23b deferred)

## Risks & mitigations

- **Server pages importing server-only deps if a test imports them.** Mitigated by using file-content scan contract tests for metadata, not module imports.
- **A public/legal `page.tsx` is unexpectedly a client component.** Verified none of the public/auth/legal pages are `'use client'` (only `mfa/challenge`, `dashboard/connect`, and admin pages are). If any turns out client at implementation time, fall back to a segment `layout.tsx` for that route.
- **Brand link treatment for #20.** Consult the `repworth-brand-design` skill at implementation for the exact teal link styling so it matches the MFA #160 pattern.

## Follow-ups (out of scope, recorded here)

- **#23b** — Zernio reconnect-queue force-drain/dismiss admin actions (its own backend brainstorm/spec/PR).
- **Admin-page `noindex`** — admin routes (login/overview/etc.) are auth-gated but not `noindex`; a belt-and-suspenders `noindex` via the admin layout is a sensible separate hardening task.
