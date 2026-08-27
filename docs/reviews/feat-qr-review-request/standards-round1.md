# Standards & Maintainability review — feat-qr-review-request, round 1

- **Reviewer lens:** `thermo-nuclear-code-quality-review` skill, scoped to `git diff 40e79e6a...HEAD` (16 commits, 31 files, +3,293/−23), plus the six repo-specific axes from the dispatch.
- **Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-qr-review-request`
- **Verification run by reviewer:** `pnpm typecheck` clean; ESLint over every changed production file clean; the branch's 7 new/extended unit test files run green (62 tests, live-DB suites excluded via `REPWORTH_DISABLE_LIVE_DB_SUITES=1`).
- **Sanctioned-deviation source honored:** `docs/superpowers/plans/feat-qr-review-request-deviations.md` — nothing ACCEPTed there is re-flagged below.

## Verdict

Clean branch. No structural regression, no spaghetti growth, no file-size problem, no invariant violation, no glossary violation. Four findings survive the ≥80% bar — one Medium (a near-duplicate canonical helper the module header defends but does not dissolve) and three Low. Nothing blocks merge; the Medium is a small behavior-preserving consolidation worth doing before the third caller appears.

---

## Findings

### F1 — MEDIUM — third spelling of the Google write-review URL builder
**File:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-qr-review-request/src/lib/locations/review-qr.ts:24-39`
**Standard:** thermo-nuclear rule 6 ("reuse the existing canonical helper instead of introducing a near-duplicate"); CLAUDE.md Working rules ("no near-duplicate dependencies… default is no new file" posture applied to helpers).

`buildWriteReviewUrl` re-spells `GOOGLE_WRITE_REVIEW_URL_PREFIX` ( `https://search.google.com/local/writereview?placeid=` ) and the exact `trim → isPlaceId → encodeURIComponent` body of `buildReviewLink` in `src/lib/solicitation/dispatch.ts:740,763-775`. The module header (lines 8–13) defends this deliberately: the send lane's variant THROWS (upstream gate guarantees canonicality) while the scanner-facing variant returns `null`. The failure-semantics difference is real — but it argues for **two thin wrappers over ONE canonical builder**, not two copies of the build body plus a third private copy of the prefix (the recognizer in `src/lib/reviews/url-parser.ts:13` is the first). Today a change to Google's write-review URL format or the encoding rule must be found in three files, and nothing but a comment keeps them in sync.

**Remedy (behavior-preserving):** move the null-returning `buildWriteReviewUrl(placeId): string | null` into `src/lib/reviews/url-parser.ts` — the file that already owns `isPlaceId` and the write-review URL *recognition* — and have `dispatch.ts`'s `buildReviewLink` become `const url = buildWriteReviewUrl(placeId); if (url === null) throw …` (its assertion commentary survives intact). `review-qr.ts` then imports the canonical builder and its own test-only export disappears (see A2). One home, two failure-mode wrappers, zero prefix copies outside it. Note this touches `dispatch.ts`, which is outside the feature's declared edit surface — acceptable as a follow-up PR if the surface is being held strictly.

### F2 — LOW — second byte-near-identical copy of the unavailable-page HTML shell
**File:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-qr-review-request/src/app/q/[businessId]/route.ts:33-55`
**Standard:** thermo-nuclear "copy-pasted logic instead of extracted helpers"; CLAUDE.md "no abstractions for a single caller" — the threshold that rule sets is now crossed in the other direction, because there ARE two callers.

`unavailablePage()` duplicates the inline HTML card of `src/app/r/google/[responseId]/route.ts:52-77` — the `body` style string and card `div` style are byte-identical; only title, copy, and the (deliberately absent) dashboard CTA differ. Following the `/r/google` precedent shape was the plan's instruction and the route does it faithfully — but with two public redirect routes the copy is now a maintenance pair: any brand/copy/accessibility fix to the "unavailable" card must be discovered and applied twice, with nothing pointing from one file to the other.

**Remedy:** extract a small shared `unavailableHtmlPage({ title, message, cta? })` (e.g. `src/lib/shared/` or an `app/_shared` module both routes may import) and have both routes call it. The scanner-facing "no CTA" decision stays a call-site argument, which also makes the CONTEXT.md "scanner copy, no dashboard CTA" decision visible as code instead of as an omission.

### F3 — LOW — print page computes N print-resolution QR PNGs to render one
**File:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-qr-review-request/src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx:71-77`
**Standard:** thermo-nuclear rule 7 (avoidable orchestration cost when the cleaner structure is visible); concrete cost below.

The print page calls `getOwnerReviewQrLocations` — which sequentially generates a 2048-px PNG data URL for **every** eligible location of the account (`review-qr.ts:102-114`, sequential by `ci:pool-fanout` design) — and then `.find(…)`s the single location it will render, discarding the other N−1 encodings. The tenant-scope-is-structural rationale in the file header is real and worth keeping (a foreign `businessId` is `notFound()`, never data — the deviations file's test retitle leans on exactly this). But the same structure survives filtering **before** QR generation: the module can accept an optional `businessId` and filter the `getLocationsForAccount` rows (still the caller's account list, so scope is unchanged) before the `QRCode.toDataURL` loop. Today N is small, so this is Low — but multi-location accounts are the product's growth path, and the cost is per-print-page-view server CPU.

**Remedy:** `getOwnerReviewQrLocations(sql, accountId, appUrl, { businessId? })` filtering `rows` before the encode loop, or a sibling `getOwnerReviewQrLocation` that reuses the same row source. Keep the "lookup inside the caller's account list" property either way.

### F4 — LOW — comment justifies the implementation by the task's edit surface, not a code constraint
**File:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-qr-review-request/src/app/(authenticated)/settings/review-qr/ReviewQrClient.tsx:8-9`
**Standard:** house comment rule — comments state what the code cannot show; they do not narrate or justify the diff.

"the few layout styles are inline with var(--rw-*) tokens because this task's file surface does not include the stylesheet" cites a plan-execution constraint (the task's `Files` list) that stops being true or checkable the moment the branch merges. It also justifies something that needs no justification: inline token styles are the settings-surface house practice (`LocationsPanel.tsx` has 26 inline-style sites, `SecurityClient.tsx` 20 — this file has 6). A future reader is left wondering whether these styles are debt owed to `settings.css` when siblings say they are not.

**Remedy:** delete the "because this task's file surface…" clause (keep "layout styles are inline with var(--rw-*) tokens" if anything). If the author does consider these styles debt, the honest form is a `settings.css` follow-up, not a process citation.

---

## What was checked and found clean (per axis)

1. **Repo standards / invariants.**
   - **#1 (Vercel = UI only):** `/q/[businessId]` is one short DB read + best-effort insert + 302; no LLM/external/long-running work. QR PNG generation on the settings pages is local CPU, short, and precedented (`_shared/channels/start.ts` `QRCode.toDataURL`).
   - **#15 (explicit sql parameter):** `review-qr.ts` and `repo.ts` take `sql: Sql`; the only `@/lib/db/server` importers are composition roots (route, two pages). `appUrl` passed in by the root — the module never reads env.
   - **No `any`:** zero in production diff; the only casts are the conventional `as never` template-tag fakes in tests (the `/r/google` route-test pattern).
   - **No string literals for statuses in production code:** the gate is the named predicate `subscriptionAllowsQrRedirect` built on `subscriptionGrantsFullAccess` + `SubscriptionStatus.PAST_DUE`; literal statuses appear only in test fixtures/seeds, which is the established house pattern (`live-db-tenant.ts` itself defaults `'active'`).
   - **Structured logging:** `createWorkerLogger` with one event name + object arg; the malformed-id branch deliberately logs no attacker-controlled value; no review text/tokens/secrets logged; the analytics-failure path uses `reportCaughtError` (Sentry + sanitized context), exactly the handle-and-continue case that helper exists for.
   - **Analytics conventions:** event name typed through `AnalyticsEventName`; server-only (not in `CLIENT_ENQUEUEABLE_EVENT_NAMES`, with a test pinning that); random-per-scan event key correctly defeats `ON CONFLICT` dedupe for a count-every-scan event; ids duplicated into properties with the poller rationale stated. Migration 115 follows the 106 constraint-only pattern, and the 106→115 drift-guard handoff replays the documented 094→097→102→106 convention on both suites.
   - **Tenant scope:** the one unscoped read is statement-granular-allowlisted (`pre-auth-token`), baseline bumped with dated history per the file's own convention; every owner-facing read binds `account_id`; live suite proves cross-tenant exclusion and the authoritative-column JOIN with a genuinely diverging deprecated column.
2. **Deep-module discipline.** `src/lib/locations/review-qr.ts` is a genuinely deep module: two async entry points + one pure builder + two result types; refusal ordering, eligibility, QR parameters, and the accounts-JOIN authority all hidden behind `QrRedirectResolution` / `OwnerReviewQrLocation`. `resolveQrRedirect` is a pure-result seam (route owns 302/page/log/insert) — no pass-throughs, nothing fails the deletion test. `getQrRedirectRow` lives in `repo.ts` per that file's ownership header, correctly. The one interface widen is test-only (`buildWriteReviewUrl` export — see A2, dissolved by F1's remedy).
3. **Glossary.** No renames anywhere in code, comments, tests, or docs. The _Avoid_ terms ("QR landing page", "scan tracker", "QR token", "scan code", "review-link QR", "short link") appear only inside CONTEXT.md's own _Avoid_ lists and the intake's non-goals line. "Review QR" and "QR redirect" are used consistently, with CONTEXT.md citations at every module head.
4. **Comment discipline.** One finding (F4). The codex-round citations (`codex R1 M3/M4`, `codex R3 #1`, …) were examined and NOT flagged: `src/app/r/google/[responseId]/route.ts:9` ("hardened (Codex R2 #5)") shows this is existing house practice on `main`, and in every new instance the substantive constraint is stated alongside the citation.
5. **Consistency with named precedents.** `/q/[businessId]` mirrors the `/r/google` route shape (UUID_RE, force-dynamic, unavailable page, no-store on every response, hardening comment) — and improves on it where the plan said to (constructed-not-stored destination). The settings page matches the channels-page shape (`requireOwnerAccess(sql)` → single loader → `TopBar` with house props → client component). Tests match the ChannelsClient/SettingsSidebar shapes (`@vitest-environment jsdom`, role-based queries). The route test follows the `/r/google` `vi.hoisted` + `vi.mock('@/lib/db/server')` pattern with a call-indexed extension.
6. **Deviations file.** All ACCEPTed entries honored — in particular the dropped PNG endpoint (data-URL download), the `<section>` print root, TopBar house props, the icon reuse, the `ALLOWLIST_BASELINE` bump, and the test retitle were **not** re-flagged. F3 does not collide with the retitle: it preserves the module-query scoping the retitle relies on.
7. **Thermo-nuclear size/spaghetti axes.** No file approaches 1k lines (largest new production file is 130 lines); no conditionals added to unrelated flows; no flags/modes/optionality introduced; the `unavailable` reasons are a closed discriminated union, not branch growth. The one plausible "code judo" move on this branch is F1.

## Appendix — low-confidence observations (not findings)

- **A1.** `process.env.NEXT_PUBLIC_APP_URL ?? ''` appears in both settings pages and feeds the module's deliberate throw when unset (500 via `error.tsx`). Consistent with `/r/google`'s own `?? ''` read and with there being no canonical src-side app-URL accessor (workers use `getWorkerConfig()`). If a src-side accessor ever appears, these two sites should adopt it.
- **A2.** `buildWriteReviewUrl` is exported from `review-qr.ts` solely for its unit tests — a test-only interface widen. Dissolves automatically under F1's remedy (the canonical export lives in `url-parser.ts`).
- **A3.** The module test (`review-qr.test.ts:30-37`) and route test (`route.test.ts:12-25`) each carry their own postgres.js template-tag fake. A shared test helper would remove ~20 lines, but per-suite fakes are the current house shape (the `/r/google` test has its own too); not worth churn inside this branch.
- **A4.** `docs/directory.md`'s new `review-qr.ts` row is the only row in its table without a trailing period and does not name "invariant #15 domain module" as some siblings do. Cosmetic.
- **A5.** The print page's `@media print` `visibility: hidden` on `body *` is the classic print-isolation hack; it works inside the authenticated shell and is confined to this page's scoped class names, but a dedicated print route segment outside the shell would be the cleaner long-term shape if more print views appear.
