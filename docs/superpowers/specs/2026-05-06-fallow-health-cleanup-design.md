# Fallow Health Cleanup — PR 1 (A + B + C combined)

**Date:** 2026-05-06
**Author:** norbertesekiel47 (with Claude)
**Status:** Approved for implementation
**Branch:** `codex/dupes-twilio-sentry` (resumed from `origin/codex/dupes-twilio-sentry`)

## Goal

Lift the RepWorth health score from 66.7 (C) toward ~70 by eliminating fallow's three smallest deductions (`unused_deps`, `dead_exports`, `dead_files`) and deduplicating the Sentry scrubber. **Intended zero behavior change, verified by parity test + full suite.**

## Background

`npx fallow health` on 2026-05-06 returned grade C with these penalty lines:

```
hotspots -10.0  unit_size -10.0  duplication -10.0
coupling -1.5   unused_deps -0.9  dead_exports -0.8  dead_files -0.1
```

The first three penalties (hotspots, unit_size, duplication) require structural refactoring of complex worker handlers and are deferred to per-handler PRs. This PR addresses only the four cheap wins (`unused_deps`, `dead_exports`, `dead_files`, plus a small slice of `duplication` from the sentry merge), all of which carry zero behavioral risk.

## Scope

Twelve atomic changes, single commit, organized in four groups.

### Group 1 — Sentry scrubber delegation (Slice C)

The `worker/sentry.ts` Sentry scrubber duplicates an identical helper in `src/lib/shared/sentry-scrub.ts` (uncommitted on the WIP branch). The shared helper is missing array recursion. We add array support, extend its tests, then delete the worker copy via delegation.

1. **`src/lib/shared/sentry-scrub.ts`** — extend `scrubObject` to recurse into arrays of objects. Today it skips arrays (`!Array.isArray(value)`); after the change, arrays of plain objects are walked the same way the worker version walks them.
2. **`src/lib/shared/__tests__/sentry-scrub.test.ts`** — add a test that exercises an array of objects inside `event.extra`, asserting both nested redaction and untouched safe values.
3. **`worker/sentry.ts`** — replace the local 16-line `scrubObject` and the inline `beforeSend` body with a single delegation: `beforeSend(event) { return scrubSentryEvent(event, { scrubRequestData: true }); }`. The Sentry init options (`dsn`, `tracesSampleRate: 0.1`, `environment: process.env.NODE_ENV ?? 'development'`) remain unchanged.

#### Behavior parity

| Behavior | Worker `scrubObject` (before) | Shared `scrubObject` (after) |
|---|---|---|
| Redact sensitive keys at top level | yes | yes |
| Recurse into nested objects | yes | yes |
| Recurse into arrays of objects | yes | yes (added in #1) |
| Scrub `event.extra` | yes | yes |
| Scrub `event.request.headers` | yes | yes |
| Scrub `event.request.data` | unconditionally if present | conditionally via `scrubRequestData: true` flag |

The worker passes `scrubRequestData: true` in #3, preserving the worker's pre-existing unconditional behavior while letting the client-side instrumentation (where `request.data` should remain intact) opt out.

### Group 2 — Dead exports / re-exports (Slice A core)

4. **`src/lib/responses/generator.ts`** — remove the `export { CostLimitExceededError, GlobalCostLimitExceededError, ConcurrencyLimitExceededError, RegenBudgetExceededError } from '@/lib/costs/tracker'` re-export block (lines 27-32). Verified consumers all import from `@/lib/costs/tracker` directly. Keep the `TransientLLMError` re-export at line 33.
5. **`src/lib/shared/constants.ts`** — remove `ResponseStatus` const+type pair, `SubscriptionStatus` const+type pair, and `buildGoogleMapsUrl` function. All three have zero consumers (`loadBusinessSubscriptionStatus` in admin SMS routes is a substring match, not the symbol). Keep `ExceptionType` and `NO_STORE_HEADERS`.
6. **`src/lib/notifications/channels/index.ts`** — drop fallow-flagged barrel re-exports: `EmailChannel`, `SmsChannel`, `TelegramRateLimitError`, `TelegramApiError`, `WhatsAppChannel`, `WhatsAppApiError`, plus type re-exports `SendApprovalParams`, `SendApprovalResult`. **Keep `TelegramChannel` exported as-is** — it is a real barrel export consumed dynamically by `factory.test.ts:53`. No suppression comment is added; the post-edit fallow rerun will determine whether `TelegramChannel` is still flagged, and only then would a suppression be considered.
7. **`src/app/api/dashboard/route.ts`** — drop only `DashboardDataPendingPayment`, `DashboardDataPendingAdminHandoff`, `DashboardDataActivePendingBusiness` from the `export type {…}` block at lines 13-20. Keep `DashboardData`, `DashboardDataActive`, `DashboardSettings` — settings/tests consume those route-level types.

### Group 3 — Redundant `export` keywords (Slice A core)

Each symbol below is used only inside its own file. Dropping the `export` keyword removes the public surface without touching call sites.

8. **`worker/ingress/twilio/twilio-intent.ts`** — remove `export` from `STOP_KEYWORDS` (line 16) and `START_KEYWORDS` (line 21). Internal callers at lines 39-40 unchanged.
9. **`worker/jobs/notification/eligibility.ts:35`** — remove `export` from `isChannelFlagEnabled`. Sole caller at line 70 is in the same file.
10. **`worker/background/pollers/EngagementMonitorPoller.ts:78`** — remove `export` from `runEngagementCheck`. Callers at lines 215, 217 are in the same file.
11. **`worker/jobs/publisher/publisher-error-handlers.ts:41`** — remove `export` from `redactSensitiveError` (keep the function). Callers at lines 128, 256 are in the same file. The private duplicate at `src/lib/zernio/auth-error-fallback.ts:16` is intentionally isolated and is **not** modified by this PR.

### Group 4 — Fallow config (Slice B)

12. **`.fallowrc.json`** (new file) — declare false-positive dependencies and entry-point scripts:

```json
{
  "$schema": "https://raw.githubusercontent.com/fallow-rs/fallow/main/schema.json",
  "ignoreDependencies": [
    "react-dom",
    "postcss-load-config",
    "eslint-config-next"
  ],
  "entry": [
    "scripts/clear-signup-rate-limits.ts",
    "scripts/zernio-backfill-external-replies.ts"
  ],
  "health": {
    "ignore": ["**/dist/**", "**/__generated__/**"]
  }
}
```

Rationale per entry:

- **`react-dom`** — required by Next.js for runtime React rendering. Fallow's static analysis flags it as test-only because production code only references `react`.
- **`postcss-load-config`** — loaded by the PostCSS plugin chain via `postcss.config.mjs`. Not statically resolvable.
- **`eslint-config-next`** — consumed via `.eslintrc.json` `extends` array. Not statically resolvable.
- **`scripts/clear-signup-rate-limits.ts`** — standalone CLI admin script.
- **`scripts/zernio-backfill-external-replies.ts`** — standalone CLI tool, currently in active churn (3 commits in recent hotspot list).
- **`health.ignore` globstars** — exclude generated/build directories from duplication analysis per fallow's documented matcher.

## Verification gates

In order, after edits:

1. `pnpm test` — full Vitest suite must remain green. The new array-recursion test (#2) extends coverage; everything else is removal-only.
2. `pnpm build` — Next.js + worker tsc. Type-checker is the canonical gate against any missed import; if a removed `export` was actually consumed externally, the build fails before commit.
3. `pnpm lint` — ESLint must remain green.
4. `npx fallow health` — confirm score moves up. Expected: `dead_exports`, `unused_deps`, `dead_files` penalty lines drop near zero. Score expected to move from 66.7 toward ~70.

If `npx fallow health` after the edits still flags `TelegramChannel`, add `// fallow-ignore-next-line unused-export` above `src/lib/notifications/channels/index.ts:11` in a follow-up; do not add the suppression preemptively.

## Risk profile

- **Behavioral risk:** intended zero, verified via the parity table (Group 1) and the full Vitest suite. The only internal change is the Sentry scrubber implementation, which the new array test exercises directly.
- **Build risk:** zero — tsc catches any missed import.
- **Test risk:** one additive test case; no mocks or fixtures changed.
- **Rollback:** single commit, `git revert <sha>` is clean.

## Out of scope (deferred)

- 19 `extract_complex_functions` targets — each PR sized to one handler, starting with `parseZernioReviewWebhook` (smallest, purest).
- `src/lib/zernio/client.ts` 439-LOC split — design-first PR.
- `captureRoiBaseline` / `isPermanentSerpApiError` in `process-review.ts` — pending owner decision (delete vs. wire up).
- Other type drops not in the user-approved scope: `MonitorResult`, `PageSection`, `QueueName`, `CallbackAuditContext`, `ZernioConnectionRow` zernio copy. These are slice A.2 candidates.

## Pre-edit setup

```sh
git checkout -b codex/dupes-twilio-sentry origin/codex/dupes-twilio-sentry
git status   # confirm sentry-scrub.ts and approval/http-routes.ts present from WIP commits
```

## Commit shape

Single commit. Suggested message:

```
chore: dead-code cleanup + sentry scrubber delegation

Drops fallow-flagged dead exports, redundant export keywords, and the
duplicated Sentry scrubber in worker/sentry.ts. Adds .fallowrc.json to
ignore false-positive dependencies (react-dom, postcss-load-config,
eslint-config-next) and declare CLI script entry points. Extends shared
Sentry scrubber with array-of-objects recursion to match worker behavior
before delegation.

Intended zero behavior change, verified by:
- new array-recursion test in src/lib/shared/__tests__/sentry-scrub.test.ts
- full pnpm test suite
- pnpm build
- pnpm lint
- post-edit npx fallow health rerun
```
