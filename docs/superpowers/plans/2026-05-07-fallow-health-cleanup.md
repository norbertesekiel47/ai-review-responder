# Fallow Health Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the RepWorth health score from 66.7 (C) toward ~70 by eliminating fallow's three smallest deductions (`unused_deps`, `dead_exports`, `dead_files`) and deduplicating the Sentry scrubber, with intended zero behavior change verified by parity test + full suite.

**Architecture:** Twelve atomic changes grouped into four logical clusters (Sentry scrubber delegation, dead exports, redundant `export` keywords, fallow config). All changes either drop dead code with no consumers or delegate to an equivalent helper. Single commit at the end.

**Tech Stack:** TypeScript (strict), Next.js 14, Vitest, ESLint, fallow (Rust-based code health analyzer), pnpm.

**Spec:** `docs/superpowers/specs/2026-05-06-fallow-health-cleanup-design.md`

---

## File Structure

**Modified files (11):**
- `src/lib/shared/sentry-scrub.ts` — extend `scrubObject` for array recursion
- `src/lib/shared/__tests__/sentry-scrub.test.ts` — add array-recursion test
- `worker/sentry.ts` — delegate scrubbing to shared helper
- `src/lib/responses/generator.ts` — drop 4-class re-export block
- `src/lib/shared/constants.ts` — drop unused const+type pairs and unused function
- `src/lib/notifications/channels/index.ts` — drop fallow-flagged barrel re-exports
- `src/app/api/dashboard/route.ts` — drop 3 unused dashboard pending-state type re-exports
- `worker/ingress/twilio/twilio-intent.ts` — drop `export` from `STOP_KEYWORDS`, `START_KEYWORDS`
- `worker/jobs/notification/eligibility.ts` — drop `export` from `isChannelFlagEnabled`
- `worker/background/pollers/EngagementMonitorPoller.ts` — drop `export` from `runEngagementCheck`
- `worker/jobs/publisher/publisher-error-handlers.ts` — drop `export` from `redactSensitiveError`

**Created files (1):**
- `.fallowrc.json` — fallow config with dependency ignores and entry-point declarations

**Single commit at end** containing all changes. No intermediate commits — the changes are uniformly mechanical and bisect granularity adds no value.

---

## Task 0: Resume the WIP branch

**Files:** none yet (workspace prep)

- [ ] **Step 1: Verify origin/codex/dupes-twilio-sentry exists locally**

Run:
```bash
git branch -r | grep codex/dupes-twilio-sentry
```

Expected: `origin/codex/dupes-twilio-sentry` listed.

- [ ] **Step 2: Check the WIP branch has the expected commits**

Run:
```bash
git log origin/codex/dupes-twilio-sentry --oneline -3
```

Expected: top two commits are
```
4de4020 address approval helper review comments
70b1427 refactor duplicate approval and twilio helpers
```

- [ ] **Step 3: Create the local branch from the remote ref**

Run:
```bash
git checkout -b codex/dupes-twilio-sentry origin/codex/dupes-twilio-sentry
```

Expected: branch created, working tree switched.

- [ ] **Step 4: Confirm WIP files are present**

Run:
```bash
ls src/lib/shared/sentry-scrub.ts src/lib/shared/__tests__/sentry-scrub.test.ts src/lib/approval/http-routes.ts
```

Expected: all three files listed without errors. These are the WIP slice 1 files we're building on top of.

- [ ] **Step 5: Run the existing test suite to establish a green baseline**

Run:
```bash
pnpm test
```

Expected: all tests pass. If anything fails on the WIP branch independent of our work, stop and report — do not proceed.

---

## Task 1: Extend shared sentry scrubber with array recursion

**Files:**
- Modify: `src/lib/shared/sentry-scrub.ts:15-24`
- Test: `src/lib/shared/__tests__/sentry-scrub.test.ts`

**Why:** The worker version of `scrubObject` recurses into arrays of objects (e.g. Sentry breadcrumbs). The shared version currently skips arrays. Parity must be added before delegation.

- [ ] **Step 1: Write the failing array-recursion test**

Open `src/lib/shared/__tests__/sentry-scrub.test.ts`. The file currently has two `it()` blocks inside `describe('scrubSentryEvent', ...)`. Insert this third block before the closing `})`:

```ts
  it('scrubs sensitive keys inside arrays of objects', () => {
    const event = {
      extra: {
        batch: [
          { apiToken: 'a', label: 'first' },
          { authorization: 'Bearer x', label: 'second' },
        ],
      },
    };
    scrubSentryEvent(event);
    expect(event.extra.batch[0].apiToken).toBe('[REDACTED]');
    expect(event.extra.batch[0].label).toBe('first');
    expect(event.extra.batch[1].authorization).toBe('[REDACTED]');
    expect(event.extra.batch[1].label).toBe('second');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
pnpm vitest run src/lib/shared/__tests__/sentry-scrub.test.ts
```

Expected: 2 pass, 1 fail. The new test fails because `apiToken` inside `batch[0]` is still `'a'` — `scrubObject` skipped the array.

- [ ] **Step 3: Add array recursion to `scrubObject`**

In `src/lib/shared/sentry-scrub.ts`, replace lines 15-24 (the entire current `scrubObject` function body) with:

```ts
function scrubObject(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (SENSITIVE_KEY_RE.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          scrubObject(item as Record<string, unknown>);
        }
      }
    } else if (value && typeof value === 'object') {
      scrubObject(value as Record<string, unknown>);
    }
  }
}
```

The change: replace `else if (value && typeof value === 'object' && !Array.isArray(value))` with two arms — one for arrays (walks each plain-object item) and one for plain objects.

- [ ] **Step 4: Re-run the test to verify it passes**

Run:
```bash
pnpm vitest run src/lib/shared/__tests__/sentry-scrub.test.ts
```

Expected: 3 pass, 0 fail.

---

## Task 2: Delegate `worker/sentry.ts` to the shared scrubber

**Files:**
- Modify: `worker/sentry.ts` (full replacement)

**Why:** Eliminates the 16-line duplicated `scrubObject` in the worker. Behavior is preserved by passing `scrubRequestData: true` (the worker scrubs `request.data` unconditionally; the client-side instrumentation does not).

- [ ] **Step 1: Replace the entire file contents**

Replace the entire contents of `worker/sentry.ts` with:

```ts
import * as Sentry from '@sentry/node';
import { scrubSentryEvent } from '../src/lib/shared/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV ?? 'development',
  beforeSend(event) {
    return scrubSentryEvent(event, { scrubRequestData: true });
  },
});

export { Sentry };
```

The Sentry init options (`dsn`, `tracesSampleRate: 0.1`, `environment`) are unchanged. The `beforeSend` hook now delegates instead of inlining the scrub logic.

- [ ] **Step 2: Run the worker's existing test suite to confirm nothing breaks**

Run:
```bash
pnpm vitest run worker/
```

Expected: all worker tests still pass. (Sentry init runs as a side-effect import in `worker/index.ts`; no tests assert against its internals directly, but the suite must remain green.)

- [ ] **Step 3: Run the shared scrubber tests once more to confirm parity**

Run:
```bash
pnpm vitest run src/lib/shared/__tests__/sentry-scrub.test.ts
```

Expected: 3 pass.

---

## Task 3: Drop dead error-class re-exports from `src/lib/responses/generator.ts`

**Files:**
- Modify: `src/lib/responses/generator.ts:26-32`

**Why:** Lines 27-32 re-export four error classes from `@/lib/costs/tracker`. Every consumer (worker, all four __tests__ files, security tests) imports from `tracker.ts` directly — no caller uses this re-export path. The aspirational comment "Re-export error classes so callers can import from one place" is unfulfilled.

- [ ] **Step 1: Remove lines 26-32**

Open `src/lib/responses/generator.ts`. Delete these lines exactly:

```ts
// Re-export error classes so callers can import from one place
export {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
} from '@/lib/costs/tracker';
```

The next line in the file (currently line 33) is `export { TransientLLMError } from './llm-error-classifier';`. **Keep that one** — fallow did not flag it and consumers may use it.

- [ ] **Step 2: Verify the type-checker still passes**

Run:
```bash
pnpm build
```

Expected: build succeeds. If any consumer was actually relying on the re-export path (none should be — verified by grep), tsc will report an unresolved import here. If that happens, restore the four re-exports plus a `// fallow-ignore-next-line unused-export` comment above the block, and stop.

---

## Task 4: Drop dead exports from `src/lib/shared/constants.ts`

**Files:**
- Modify: `src/lib/shared/constants.ts` (full replacement)

**Why:** `ResponseStatus` const+type pair, `SubscriptionStatus` const+type pair, and `buildGoogleMapsUrl` have zero consumers across `src/` and `worker/` (verified by grep — `loadBusinessSubscriptionStatus` is a substring match, not the symbol). `ExceptionType` and `NO_STORE_HEADERS` are widely consumed and stay.

- [ ] **Step 1: Replace the entire file contents**

Replace the entire contents of `src/lib/shared/constants.ts` with:

```ts
// ── Review exception types ──────────────────────────────────────────

export const ExceptionType = {
  REVIEW_EDITED_AFTER_POST: 'review_edited_after_post',
  IDENTITY_COLLISION: 'identity_collision',
  PLACE_ID_RESOLUTION_REQUIRED: 'place_id_resolution_required',
  PLACE_ID_RESOLUTION_FAILED: 'place_id_resolution_failed',
} as const;

// ── HTTP headers ────────────────────────────────────────────────────

export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, private' } as const;
```

- [ ] **Step 2: Verify the type-checker still passes**

Run:
```bash
pnpm build
```

Expected: build succeeds. If any consumer imports `ResponseStatus`, `SubscriptionStatus`, or `buildGoogleMapsUrl` from this file, tsc will report it. If that happens, restore the missing symbol(s) and stop.

---

## Task 5: Surgical channel barrel cleanup

**Files:**
- Modify: `src/lib/notifications/channels/index.ts:9-28`

**Why:** Fallow flagged 6 value re-exports and 2 type re-exports in this barrel that have no external consumers. The sole external barrel consumer is `worker/jobs/notification/__tests__/NotificationWorker.whatsapp.test.ts:137-143` (5 WhatsApp errors, all preserved) and `factory.test.ts:53` (which dynamically imports `getChannel` and `TelegramChannel`). `TelegramChannel` stays exported as-is — no preemptive suppression.

- [ ] **Step 1: Apply the surgical edits**

Open `src/lib/notifications/channels/index.ts`. Replace lines 9-28 (the entire export block, ending with the type re-export line) with:

```ts
export { SmsRecipientUnsubscribedError } from './sms-channel';
export { TelegramChannel } from './telegram-channel';
export {
  TelegramRecipientBlockedError,
  TelegramChatNotFoundError,
} from './telegram-client';
export {
  WhatsAppRecipientBlockedError,
  WhatsAppInvalidRecipientError,
  WhatsAppTemplateConfigError,
  WhatsAppSessionWindowError,
  WhatsAppRateLimitError,
  WhatsAppTimeoutError,
} from './whatsapp-client';
export type { NotificationChannel, ChannelId } from './types';
```

What was removed:
- `EmailChannel` (line 9)
- `SmsChannel` (line 10, kept `SmsRecipientUnsubscribedError`)
- `TelegramRateLimitError`, `TelegramApiError` (lines 15-16, kept `TelegramRecipientBlockedError`, `TelegramChatNotFoundError`)
- `WhatsAppChannel` (line 18)
- `WhatsAppApiError` (line 26)
- `SendApprovalParams`, `SendApprovalResult` from the type re-export (line 28)

What stayed:
- `TelegramChannel` (line 11) — consumed by `factory.test.ts:53`
- The 5 WhatsApp errors consumed by `NotificationWorker.whatsapp.test.ts`
- `NotificationChannel`, `ChannelId` type re-exports — they're not flagged but the type re-export line still exists

- [ ] **Step 2: Verify the type-checker still passes**

Run:
```bash
pnpm build
```

Expected: build succeeds. If any consumer imports a removed symbol from `@/lib/notifications/channels`, tsc will report it. If that happens, restore the missing symbol(s) and stop.

- [ ] **Step 3: Run the channel tests**

Run:
```bash
pnpm vitest run src/lib/notifications/channels/__tests__/ worker/jobs/notification/__tests__/
```

Expected: all pass. Specifically `factory.test.ts` (uses `TelegramChannel` via dynamic import) and `NotificationWorker.whatsapp.test.ts` (uses 5 WhatsApp errors via the barrel) must remain green.

---

## Task 6: Drop 3 unused dashboard type re-exports

**Files:**
- Modify: `src/app/api/dashboard/route.ts:13-20`

**Why:** Three of the six pending-state type re-exports are unused. The other three (`DashboardData`, `DashboardDataActive`, `DashboardSettings`) are consumed by settings/tests and stay.

- [ ] **Step 1: Apply the edit**

Open `src/app/api/dashboard/route.ts`. Replace lines 13-20 with:

```ts
export type {
  DashboardData,
  DashboardDataActive,
  DashboardSettings,
} from '@/lib/dashboard/types';
```

What was removed:
- `DashboardDataPendingPayment`
- `DashboardDataPendingAdminHandoff`
- `DashboardDataActivePendingBusiness`

- [ ] **Step 2: Verify the type-checker still passes**

Run:
```bash
pnpm build
```

Expected: build succeeds.

---

## Task 7: Drop redundant `export` keyword on `STOP_KEYWORDS` and `START_KEYWORDS`

**Files:**
- Modify: `worker/ingress/twilio/twilio-intent.ts:16`, `:21`

**Why:** Used only inside this file (lines 39-40). No external consumers.

- [ ] **Step 1: Remove `export` from both constants**

Open `worker/ingress/twilio/twilio-intent.ts`.

Change line 16 from:
```ts
export const STOP_KEYWORDS = new Set([
```
to:
```ts
const STOP_KEYWORDS = new Set([
```

Change line 21 from:
```ts
export const START_KEYWORDS = new Set(['START', 'UNSTOP', 'YES', 'ARRANCAR']);
```
to:
```ts
const START_KEYWORDS = new Set(['START', 'UNSTOP', 'YES', 'ARRANCAR']);
```

- [ ] **Step 2: Verify the type-checker still passes**

Run:
```bash
pnpm build
```

Expected: build succeeds.

---

## Task 8: Drop redundant `export` keyword on `isChannelFlagEnabled`

**Files:**
- Modify: `worker/jobs/notification/eligibility.ts:35`

**Why:** Used only inside this file at line 70. No external consumers.

- [ ] **Step 1: Remove `export` keyword**

Open `worker/jobs/notification/eligibility.ts`.

Change line 35 from:
```ts
export function isChannelFlagEnabled(channelId: ChannelId): boolean {
```
to:
```ts
function isChannelFlagEnabled(channelId: ChannelId): boolean {
```

- [ ] **Step 2: Verify the type-checker still passes**

Run:
```bash
pnpm build
```

Expected: build succeeds.

---

## Task 9: Drop redundant `export` keyword on `runEngagementCheck`

**Files:**
- Modify: `worker/background/pollers/EngagementMonitorPoller.ts:78`

**Why:** Used only inside this file at lines 215, 217. No external consumers.

- [ ] **Step 1: Remove `export` keyword**

Open `worker/background/pollers/EngagementMonitorPoller.ts`.

Change line 78 from:
```ts
export async function runEngagementCheck(): Promise<void> {
```
to:
```ts
async function runEngagementCheck(): Promise<void> {
```

- [ ] **Step 2: Verify the type-checker still passes**

Run:
```bash
pnpm build
```

Expected: build succeeds.

---

## Task 10: Drop redundant `export` keyword on `redactSensitiveError`

**Files:**
- Modify: `worker/jobs/publisher/publisher-error-handlers.ts:41`

**Why:** Used only inside this file at lines 128 and 256. The function stays — only the `export` keyword is removed (per spec). The private duplicate at `src/lib/zernio/auth-error-fallback.ts:16` is intentionally isolated and is not modified by this PR.

- [ ] **Step 1: Remove `export` keyword**

Open `worker/jobs/publisher/publisher-error-handlers.ts`.

Change line 41 from:
```ts
export function redactSensitiveError(body: string): string {
```
to:
```ts
function redactSensitiveError(body: string): string {
```

- [ ] **Step 2: Verify the type-checker still passes**

Run:
```bash
pnpm build
```

Expected: build succeeds.

---

## Task 11: Add `.fallowrc.json` config

**Files:**
- Create: `.fallowrc.json` (project root)

**Why:** Declares the three false-positive dependencies fallow can't statically resolve and the two CLI script entry points. Also adds `health.ignore` globstars for build/generated directories.

- [ ] **Step 1: Create the config file**

Create `.fallowrc.json` at the project root with these exact contents:

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

- [ ] **Step 2: Verify the config is valid**

Run:
```bash
npx fallow config
```

Expected: fallow prints the resolved config and the file path it loaded (`.fallowrc.json`). If fallow rejects the schema, fix the JSON and retry.

---

## Task 12: Final verification gates

**Files:** none (gate task)

- [ ] **Step 1: Run the full Vitest suite**

Run:
```bash
pnpm test
```

Expected: all tests pass. The new array-recursion test is the only addition; everything else is removal-only and should not change any test outcome.

- [ ] **Step 2: Run the production build**

Run:
```bash
pnpm build
```

Expected: build succeeds (Next.js + worker tsc). Type-checker is the canonical gate against missed-import breakage.

- [ ] **Step 3: Run the linter**

Run:
```bash
pnpm lint
```

Expected: ESLint passes with no errors.

- [ ] **Step 4: Re-run fallow health and confirm score lift**

Run:
```bash
npx fallow health 2>&1 | head -30
```

Expected: score moves up from 66.7. Specifically `dead_exports`, `unused_deps`, `dead_files` penalty lines should drop near zero. If the score regressed, stop and report. If `TelegramChannel` is still flagged in the unused-exports list, note it for a follow-up — do NOT add a suppression in this PR (per spec).

- [ ] **Step 5: Inspect the diff before committing**

Run:
```bash
git status
git diff --stat
```

Expected: 11 files modified, 1 file created (`.fallowrc.json`). Total LOC change should be approximately −70 +25 (rough estimate).

- [ ] **Step 6: Commit all changes**

Run:
```bash
git add .fallowrc.json src/lib/shared/sentry-scrub.ts src/lib/shared/__tests__/sentry-scrub.test.ts worker/sentry.ts src/lib/responses/generator.ts src/lib/shared/constants.ts src/lib/notifications/channels/index.ts src/app/api/dashboard/route.ts worker/ingress/twilio/twilio-intent.ts worker/jobs/notification/eligibility.ts worker/background/pollers/EngagementMonitorPoller.ts worker/jobs/publisher/publisher-error-handlers.ts
```

Then:
```bash
git commit -m "$(cat <<'EOF'
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

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Confirm the commit**

Run:
```bash
git log -1 --stat
```

Expected: a single commit with all 12 files modified/created.

---

## Out of scope (deferred to future PRs)

These are explicitly NOT in this plan:

- 19 `extract_complex_functions` targets — each PR sized to one handler, starting with `parseZernioReviewWebhook` (smallest, purest)
- `src/lib/zernio/client.ts` 439-LOC split — design-first PR
- `captureRoiBaseline` / `isPermanentSerpApiError` in `process-review.ts` — pending owner decision (delete vs. wire up)
- Other type drops not in the user-approved scope: `MonitorResult`, `PageSection`, `QueueName`, `CallbackAuditContext`, `ZernioConnectionRow` zernio copy

If `npx fallow health` after the edits still flags `TelegramChannel` in `src/lib/notifications/channels/index.ts:11`, add `// fallow-ignore-next-line unused-export` above that line in a follow-up PR. Do NOT add the suppression preemptively.
