# Spec & Correctness review — feat-qr-review-request, round 1

Reviewer: spec-correctness agent · 2026-08-26 · Diff: `40e79e6a...HEAD` (16 commits, 31 files, +3,293/−23)
Authority documents: `.feature/intake.json`, `docs/superpowers/plans/feat-qr-review-request-deviations.md`,
`docs/reviews/feat-qr-review-request/blast-radius.md`, `CONTEXT.md` §"Review QR" / §"QR redirect".

## Verdict

**NO FINDINGS at ≥80% confidence.** Every intake field, every locked glossary clause, every
changed-file importer, and every hunted bug class (route, module, repo reader, migration, UI,
tenant scope, refusal matrix, analytics correctness) checked out. Low-confidence observations
are in the appendix — none is a defect I would stake a finding on.

## 1. Intake field-by-field

### goal — MET
Per-location printable QR (`getOwnerReviewQrLocations`, 2048px PNG data URLs) → `/q/<businessId>`
(`src/app/q/[businessId]/route.ts`) → 302 to `https://search.google.com/local/writereview?placeid=<validated>`
→ one `qr_scan_redirected` event per successful redirect. All four legs present and wired.

### non_goals — NONE VIOLATED
Checked each of the 9 against the diff: no contact capture, no interstitial (straight 302 built by
`buildWriteReviewUrl`), no minted tokens (key is `businesses.id`), no PDF dependency (`PrintButton`
→ `window.print`), no admin surface, no short domain (`NEXT_PUBLIC_APP_URL` passed in by the two
composition roots), no per-QR variants, no new flag/env var (`grep` of diff for new `process.env`
reads: only the pre-existing `NEXT_PUBLIC_APP_URL`), no rate limiting added to the route.

### user_visible_behavior — ALL 7 PRESENT, nothing material beyond them
1. Settings section, one card per non-archived location, no flag gate — `page.tsx` +
   `ReviewQrClient.tsx`; sidebar entry added unconditionally (`SettingsSidebar.tsx:32`).
2. Download PNG ~2048px — `QR_PNG_WIDTH = 2048` (`review-qr.ts:29`), `download` anchor on the data URL.
3. Print view (name + "Scan to leave us a review" + QR) — `print/[businessId]/page.tsx:79-86`.
4. Missing / hex-CID place id → explanatory card, no QR, no actions — `ReviewQrClient.tsx:111-126`,
   proven by the "offers download and print only for eligible locations" test.
5. Scan → 302 to the write-review URL — route + `resolveQrRedirect`.
6. Unavailable page for pending_payment/cancelled, archived, missing, non-canonical — all four
   refusal reasons produce the SAME 200 page (`route.test.ts:187-221` proves byte-identical bodies
   across all five refusal legs including pre-DB `bad_id`); scanner copy, **no dashboard CTA**
   (deliberate divergence from the `/r/google` page, which has one — the intake and CONTEXT.md
   require its absence here). Never a redirect in a refusal state.
7. One `qr_scan_redirected` event with `account_id` + `business_id` **in properties** — verified
   against `AnalyticsDispatchPoller.ts:154`, which forwards only `{...properties, $insert_id}`;
   the DB columns are also stamped for querying.

Extra behaviors found in the diff, judged in-scope micro-affordances (not un-named features): the
zero-locations empty state (see appendix L1), the copyable "QR link" text block, and the on-screen
Print button (print-hidden).

### invariants — ALL 8 HOLD IN CODE
| # | Invariant | Evidence |
|---|---|---|
| 1 | Named predicate `subscriptionAllowsQrRedirect` = {active, trialing, past_due} | `subscription-status.ts:84-89` — `subscriptionGrantsFullAccess ∥ PAST_DUE`; membership test passes incl. `'nonsense'` → false; module gates through the named predicate (passthrough-mock test `review-qr.test.ts:136-144` makes a raw re-spell impossible) |
| 2 | Destination CONSTRUCTED from `isPlaceId`-validated id, hex CIDs refused, no open redirect | `buildWriteReviewUrl` (`review-qr.ts:36-40`) — `isPlaceId` (`url-parser.ts:77-79`, `PLACE_ID_RE` ∧ ¬`HEX_CID_RE`) then fixed prefix + `encodeURIComponent`; no stored URL read anywhere; charset admitted by `PLACE_ID_RE` is header-safe |
| 3 | Analytics insert AFTER resolve, best-effort own try/catch | `route.ts:76-91`; "still redirects when the analytics insert fails" + "reports the analytics failure" both pass; failure → `reportCaughtError` (Sentry + structured error log — observability item 3 satisfied) |
| 4 | Owner endpoints account-scoped; public route leaks nothing | Owner side: both pages run `requireOwnerAccess` and read only via `getOwnerReviewQrLocations` → `getLocationsForAccount` (`WHERE account_id = …`), live-proven by the tenant-exclusion integration test; print page resolves the id INSIDE the caller's list → `notFound()` for a foreign id. Public side: UUID_RE pre-gate, one identical page for every refusal, reason only in the log, no error details in any body |
| 5 | Vercel = UI only, no worker changes | Zero `worker/` files in the diff; route is one SELECT + one INSERT + 302 |
| 6 | Registry entry + migration 115 in the same PR | `events.ts:31` + `supabase/migrations/115_qr_scan_analytics_event.sql` (27-name CHECK = 26 from 106 + the new name, order-pinned by the 115 suite); `ci:analytics-events` passes |
| 7 | `Cache-Control: no-store` on every redirect-route response | Both branches (`route.ts:55`, `route.ts:95`); asserted for all refusals + the 302 in tests |
| 8 | Route orchestrates only; logic in `review-qr.ts` with `sql` passed | Route: parse → `resolveQrRedirect(sql, id)` → log/insert/respond. Module takes `Sql` param (invariant #15); `ci:db-imports` strict pass |

### edge_cases — ALL 7 COVERED
Hex CID (owner card + scanner refusal, tested both sides) · archived (`archived_at` check; un-archive
restores the same code structurally — nothing keyed on anything but the UUID) · malformed/unknown id
(UUID_RE pre-gate → no DB touch, proven; unknown → `not_found`) · analytics failure (302 + logged) ·
purged row (`not_found`) · pending_payment owner → `/onboarding/pay` (`require-owner-access.ts:80-82`
gates on `subscriptionAllowsDashboardRead`; matches the codex-R1-corrected intake line) · HEAD-as-scan
noise documented in the module header (`review-qr.ts:15-16`; Next implements HEAD via GET).

### allowed_edit_surface — CLEAN
All 31 changed files map into the surface (including the three amendments recorded in the deviations
file); `pnpm ci:feature-surface` passes ("31 changed file(s) within the declared surface; every surface
entry matches a file"). The four `docs/superpowers/plans/feat-qr-review-request-*` + plan files are the
/feature harness's own process artifacts and are counted by that audit. The two intake copies
(`.feature/intake.json` vs `docs/superpowers/plans/feat-qr-review-request-intake.json`) are byte-identical.

### tests_to_add — 18/18 VERBATIM
Every title located by fixed-string search in the expected file (14 in Task 1's four files, 1 in
`events.test.ts`, 3 UI). Ran the 7 non-live suites: **62/62 pass**. The two live-DB suites' text-shape
halves pass (10/10); their `describeWithDb` halves skip without `TEST_DATABASE_POOL_URL` in this shell
and are gated by CI's `test` job (the live-DB lane).

## 2. Deviations file — nothing re-flagged, nothing contradicted
All 8 step-6 verdicts are ACCEPT (no RE-PLAN). Spot-verified the load-bearing ones: `getQrRedirectRow`
placed in `repo.ts` per its ownership header (codex R3); allowlist baseline 369→370 with a
statement-granular `pre-auth-token` entry whose `sqlSnippet` matches the query (audit passes at 370);
`<section>` print root (the authenticated shell owns `<main>`); TopBar house props; aliased
PrintButton import (gate round 1); the migration-106 suite's drift-guard handoff to 115's suite —
grep confirms no OTHER migration suite still holds a live `ANALYTICS_EVENT_NAMES` guard (089/094/097/102
reference it in comments only), so exactly one live guard exists and it reads migration 115.

## 3. Blast radius — all four watched files additive; no caller depended on old behavior
- `subscription-status.ts` (93 importers): new export only; existing predicates byte-unchanged.
- `events.ts` (17 importers): one appended array member. The two exhaustive consumers were both
  updated in this PR (`events.test.ts` full-list assertion; the 106 suite re-pinned to history).
  `logger.ts` imports only `sanitizeAnalyticsProperties` (unchanged — and it does not block
  `account_id`/`business_id`, so the event properties survive sanitization).
- `repo.ts` (20 importers): new export + interface only; all five existing queries byte-unchanged.
- `SettingsSidebar.tsx` (layout + test): one appended nav item; active-state logic untouched; its
  test extended in-branch.

## 4. Migration 115 vs the events registry — CONSISTENT
File list = TS allowlist = docs row (`ci:analytics-events` green). 115's suite pins prefix-order
against 106 and holds the live subset guard; `lock_timeout` set; DROP-IF-EXISTS/ADD idempotent pair
matches the 106 precedent. Head bump + LOCAL-ONLY marker in `migrations-log.md`. No numbering
collision (fork point 40e79e6a is main HEAD; head there was 114).

## 5. CONTEXT.md locked semantics — code matches every clause
QR encodes the redirect URL, never the Google URL (`qrTargetUrl = base + /q/<id>`; eligibility check
discards the built Google URL) · eligibility = `isPlaceId` ∧ not-archived · explanatory card, never a
dead-end QR · NOT behind `shouldShowLocationsSettings` · `resolveQrRedirect` pure result object, route
owns 302/page/log/insert · refusal order not_found → archived → subscription → bad_place_id · one
reason-coded log line per refusal (reasons: bad_id, not_found, archived, subscription, bad_place_id —
exactly the intake observability set) · best-effort event AFTER resolve · no-store everywhere ·
authoritative status from the `accounts` JOIN, live-proven by the column-divergence integration test.

## 6. Bug hunt — classes checked and found clean
- **Open redirect / header injection**: destination is prefix + `encodeURIComponent(placeId)` where
  the admitted charset is `[A-Za-z0-9_-]` — no CRLF, no scheme swap possible.
- **XSS**: unavailable page interpolates nothing; print/settings pages render names through React.
- **Refusal-matrix information leak**: single byte-identical 200 page across all refusals incl. the
  pre-DB malformed-id leg (test-pinned via `Set(bodies).size === 1`); reasons live only in logs; the
  malformed input itself is deliberately NOT logged (string args log verbatim — correct call).
- **Tenant scope**: public read is the sanctioned `pre-auth-token` shape (one statement, allowlisted,
  returns no tenant data to the caller); every owner read binds `account_id`; live tenant-exclusion +
  archived-exclusion test.
- **Analytics correctness**: key `qr_scan_redirected:<businessId>:<randomUUID()>` — random ON PURPOSE
  (deterministic would dedupe on `ON CONFLICT (event_key) DO NOTHING` and undercount; documented in
  events.md and test-pinned); `$insert_id = event_key` gives the poller retry-dedup at PostHog;
  `distinct_id = accountId` matches house convention (`process-review.ts:277`, `plan-activation.ts:720`);
  not client-enqueueable (test-pinned); ids duplicated into properties because the poller forwards
  only properties JSON (verified at `AnalyticsDispatchPoller.ts:154`).
- **DB-error posture**: no try/catch around the resolve read — identical to the `/r/google` precedent
  (Next's generic 500, no detail leak); intake names the precedent as the pattern to follow.
- **UI**: every CSS class/token used exists (`settings.css`, `tokens.css`, `globals.css`); `IconName`
  includes `location` and `alert`; `qrcode@^1.5.4` already a dependency (dependencies_added: [] holds).
- **Gates re-run in this review**: `ci:analytics-events`, `ci:tenant-scope` (370/370), `ci:db-imports`,
  `ci:live-db-suites`, `ci:directory-map`, `ci:static-policy`, `ci:env-registry`, `ci:pool-fanout`,
  `ci:feature-surface`, `ci:merge-ledger` — all pass at HEAD 89c39348; `tsc --noEmit` clean; ESLint
  clean on every production file in the diff; 62/62 unit tests + 10/10 text-shape migration tests.

## Appendix — low-confidence observations (NOT findings)
- **L1 (empty state → possible 404)**: `ReviewQrClient`'s zero-locations state links to
  `/settings/locations`, which `notFound()`s when `MULTI_LOCATION_ENABLED` is off
  (`settings/locations/page.tsx:26-27`). Reaching it requires an owner with zero non-archived
  locations AND a live gate-passing subscription — onboarding always creates a location and archive
  paths guard the last/primary one, so I could not construct a reachable scenario; the sidebar's own
  unconditional Locations entry has the same pre-existing posture. Worth a glance, not a defect.
- **L2 (QR quiet zone)**: `margin: 1` module instead of the spec's 4. On white paper/preview the
  effective quiet zone is large, so real-world scannability is fine; only placement on a dark
  background could degrade it. Matches the channels-enrollment precedent's spirit; cosmetic risk only.
- **L3 (directory.md repo.ts row)**: the `repo.ts` row was not extended with `getQrRedirectRow`
  (the file's own header was). `ci:directory-map` checks row presence, not export completeness — a
  one-line polish, not a violation.
- **L4 (settings-page env failure mode)**: both owner pages pass `process.env.NEXT_PUBLIC_APP_URL ?? ''`
  and the module throws on empty — a misconfigured environment 500s the settings page rather than
  rendering QRs that encode relative URLs. Deliberate per the "throws when appUrl is empty" test;
  noting only that the failure surfaces as an owner-facing 500.
- **L5 (uppercase-UUID property casing)**: a hand-typed uppercase `/q/<UUID>` redirects (test-pinned)
  and stamps the uppercase string into `properties.business_id` while the DB column normalizes via
  `::uuid`. Printed QRs always encode the lowercase `row.id`, so PostHog casing skew requires a
  hand-edited URL. Noise-level.
- **L6 (per-render QR generation)**: settings + print pages regenerate N 2048px PNGs per request
  (sequential by design — `ci:pool-fanout`). Fine at launch location counts; a cache would be
  premature.
