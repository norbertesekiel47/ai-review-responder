# Round-2 verification — feat-qr-review-request

Scope: confirm each round-1 accepted finding is fixed at HEAD and that the
fixes introduced nothing new. No new fronts against unchanged code.

- **HEAD**: `be5ccb5b` (`docs(qr): round-1 review reports, triage verdicts + handoff` — docs-only:
  `git diff c5a3679c..HEAD --stat -- src/` is empty; the commit touches only
  `docs/reviews/feat-qr-review-request/*` + the handoff plan doc).
- **Fix commit under verification**: `c5a3679c` (`fix(qr): review round 1 — after()-deferred
  analytics, single-location print path`).
- Gates run at HEAD: the three touched vitest suites (34/34 green, one run),
  `pnpm typecheck` (clean), eslint over all seven touched source files (clean).

## A1 — analytics off the redirect's critical path via `after()` — FIXED

`src/app/q/[businessId]/route.ts` at HEAD:

- The 302 (`route.ts:94-97`) is returned WITHOUT awaiting the insert. The
  insert now lives inside `after(async () => { … })` (`route.ts:76-92`) with
  its own `try/catch`; a failed insert calls `reportCaughtError`, never throws.
- `after` is imported from `next/server` (`route.ts:20` — stable in the
  installed Next 16) and the header comment (`route.ts:11-17`) documents the
  new contract.

Defect scrutiny of the `after()` usage (all clear):

- **Not conditional**: `after()` sits unconditionally on the success path;
  both refusal paths (`bad_id` at `route.ts:65-68`, `unavailable` at
  `route.ts:71-74`) `return unavailablePage()` BEFORE the `after()` call, so
  the unavailable path cannot enqueue — proven by the refusal test, which
  flushes the queue and still sees exactly 1 DB call (the resolve SELECT).
- **No stale capture**: the callback closes over `businessId` (const from
  awaited params) and `resolution.accountId`; `resolution` is already
  narrowed to the live variant by the early return, and neither value mutates
  after capture. `randomUUID()` runs inside the callback, so the event key
  stays unique per scan.
- **HEAD semantics**: the route exports only `GET`; Next derives HEAD from it
  unchanged, and `after()` fires post-response for HEAD too — v1's accepted
  "HEAD counts as a scan" behavior is preserved, not altered.
- **Serverless lifetime**: `after()` is the platform-sanctioned post-response
  hook (keeps the Vercel function alive until the callback settles) — no
  fire-and-forget dropped promise.

Tests (`src/app/q/[businessId]/__tests__/route.test.ts`):

- Partial `next/server` mock present (`vi.mock('next/server', …)` spreading
  `importOriginal` and overriding only `after` to push onto a hoisted
  `afterQueue`), with `flushAfter()` draining it; `afterQueue` reset in
  `beforeEach`.
- Stalled-insert regression test present ("returns the 302 before a stalled
  analytics insert resolves"): `stallOnCall = 1` makes the INSERT a
  never-settling promise, NO `flushAfter()`, asserts the 302 + exactly one DB
  call. If the code regressed to awaiting the insert inline, the GET would
  hang on the never-settling promise and the test would time out — the right
  regression trap given vitest has no response lifecycle.
- The rejected-insert test now flushes and asserts the 302 stands; the
  refusal test flushes and proves nothing was deferred; the analytics
  assertions all flush before inspecting call 1.

Evidence: `pnpm vitest run "src/app/q/[businessId]/__tests__/route.test.ts"
src/lib/locations/__tests__/review-qr.test.ts
"src/app/(authenticated)/settings/review-qr/__tests__/ReviewQrClient.test.tsx"`
→ `Test Files 3 passed (3), Tests 34 passed (34)`.

## A2 — enforcing `/q/*` WAF rule as step-8 item 0, no code limiter — FIXED

- `docs/superpowers/plans/2026-08-26-qr-review-request.md` § "Step-8 staging
  smoke" now opens with item **0**: "Publish and VERIFY an ENFORCING GET/HEAD
  rate-limit rule covering `/q/*` per
  `docs/runbooks/vercel-waf-rate-limiting.md` — BEFORE any printed QR is
  exposed; verify on staging with a curl burst (expect 429s past the
  threshold)…" — verify-before-exposure, citing adversarial R1 A2 as an ops
  gate.
- No code limiter appeared:
  `rg "rateLimit|rate-limit|ratelimit|limiter|429" src/app/q/ src/lib/locations/review-qr.ts`
  → no matches. The locked non-goal (WAF owns the edge) is intact.

## A3a / S3 — single-location print loader — FIXED

`src/lib/locations/review-qr.ts` at HEAD:

- `getOwnerReviewQrLocation(sql, accountId, businessId, appUrl)` exists;
  account scope is structural — it calls the account-scoped
  `getLocationsForAccount` (repo query: `WHERE account_id = ${accountId}::uuid
  AND archived_at IS NULL`, `src/lib/locations/repo.ts:64-86`) and `.find`s
  the row, returning `null` for an unknown/foreign businessId. Exactly ONE QR
  is generated (only the found row reaches `toOwnerReviewQrLocation`, the
  single `QRCode.toDataURL` site shared with the list loader). This matches
  the triage's specified fix verbatim ("reusing repo's account-scoped read,
  one QR generated").
- The print page
  (`src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx`)
  now imports and calls `getOwnerReviewQrLocation(sql, access.accountId,
  businessId, …)`; the old all-locations `.find` is gone; `notFound()` on
  null/ineligible unchanged.
- Module tests (`src/lib/locations/__tests__/review-qr.test.ts`,
  `describe('getOwnerReviewQrLocation')`) cover: found row with exactly one
  `toDataURL` call (spy asserts `toHaveBeenCalledTimes(1)` with the right URL
  + options), null for unknown/foreign id, and account-id + archived-filter
  scoping of the single query. Green (part of the 34/34 run above).
- A3b's accepted residue is present as the module-header "Scale ceiling"
  note naming the on-demand QR asset endpoint as the escape — the triage's
  sanctioned no-code resolution.

## S4 — file-surface justification comment deleted — FIXED

`src/app/(authenticated)/settings/review-qr/ReviewQrClient.tsx` header now
ends at "Console system: SettingsShell + .set-section primitives from
settings.css." — the "…because this task's file surface does not include the
stylesheet" justification is gone
(`rg "file surface|does not include the stylesheet"` over the review-qr
directory → no matches), and ONLY the comment changed in that header: the
inline `var(--rw-*)` styles themselves were not touched by S4.

## Empty state — no flag-gated `/settings/locations` link — FIXED

- The zero-locations empty state links `/dashboard`
  (`ReviewQrClient.tsx:29-31`), with an in-place comment explaining why
  `/settings/locations` is forbidden (404s when the multi-location flag is
  off). `rg "settings/locations"` over the review-qr tree finds only that
  comment and the mirrored comment in the test — no `href` remains.
- Test updated: "shows one empty-state sentence pointing at the dashboard…"
  asserts `href="/dashboard"`. Green.

## Commit-scope check — CLEAN

`git show c5a3679c --stat` touches exactly 8 files, all within the accepted
fixes + sanctioned test/doc updates: the plan doc (A2 item 0), ReviewQrClient
+ its test (S4 + empty-state), the print page (A3a), the route + its test
(A1), and the review-qr module + its test (A3a, plus the sanctioned A3b
module-header note; `requireQrBase`/`toOwnerReviewQrLocation` are the shared
extraction that the single-location loader required). Nothing else.

## Defects introduced by the fixes

None found at ≥80% confidence. `pnpm typecheck` clean; eslint clean over all
seven touched source files; 34/34 tests green in one run at HEAD `be5ccb5b`.

## Appendix (untriaged, one line)

- vitest emits a pre-existing environment warning (`vitest.config.ts` ESM
  loaded as CommonJS under `configLoader: 'native'`) unrelated to this branch.

## Verdict

ROUND2: CLEAN
