# PostHog historical `activation_completed` backfill — Design

**Issue:** [#83](https://github.com/RepWorth/ai-review-responder/issues/83) — follow-up to #81.
**Date:** 2026-05-28
**Branch / worktree:** `feat/83-posthog-activation-backfill` at `../RepWorth-issue83` (sibling, not nested — nested worktrees poison lint/test per CLAUDE.md).

## Scope

Issue #83 is tagged "config/ops only" (create PostHog project, set `POSTHOG_API_KEY`
on Railway, redeploy). Those steps are an **external/ops gate the operator owns** and
are **out of scope** for this PR. This PR delivers only the *optional* third
acceptance-criterion: the code to **backfill historical activations** for accounts
that activated before the live capture path started emitting.

Also out of scope (deliberately): the legal/sub-processor declaration (already drafted
uncommitted on `main`; it should land *with* the prod-key flip, not before, so
`/legal/sub-processors` stays truthful), any migration, schema change, env var, or
`NEXT_PUBLIC_*` companion.

## Problem

`activation_completed` is emitted live from `worker/jobs/publisher/activation.ts`
(`maybeCaptureActivationCompleted`) on posted-transition paths. Two reasons historical
activations are missing from PostHog:

1. The live SQL prefilters to accounts created within the last 8 days
   (`a.created_at >= NOW() - INTERVAL '8 days'`), so older accounts that already
   activated never emit.
2. `src/lib/analytics/posthog.ts` is a no-op until `POSTHOG_API_KEY` is set, so even
   recent activations emitted nothing before the key exists in prod.

A backfill must therefore replay activations for accounts the live path never covered.
The hard parts are **not** the query — they are:

- **Correct event time.** Each event must be stamped at the real `posted_at`, or every
  PostHog funnel/cohort/time-series built on `activation_completed` is wrong.
- **Idempotency + no double-count.** Re-running the backfill, or overlapping the live
  path, must not create duplicate activations.
- **One authoritative activation rule.** The 7-day window + event shape must not be
  duplicated between the live path and the backfill (they would drift).

`captureAnalyticsEvent` today forwards only `event`/`distinctId`/`properties` — it
cannot set a historical `timestamp` or a dedup id. That is the gap this design closes.

## Approach (chosen)

**Shared activation-event builder + extended capture wrapper.** Extract the activation
rule into one pure function used by both the live path and the backfill; teach the
capture wrapper to carry an optional `timestamp` and dedup `uuid`; key every activation
event on `uuid = response_id` so re-runs and live/backfill overlap dedupe in PostHog.

Rejected alternatives:
- *Standalone script, no live-code changes* — duplicates the 7-day rule (drift risk)
  and re-runs aren't dedup-safe.
- *Script builds its own posthog-node client* — duplicates client config + the no-op
  key gate; two ways to talk to PostHog.

## Components

### 1. `src/lib/analytics/activation-event.ts` (new) — single owner of the rule

Pure function, no I/O:

```
buildActivationCompletedEvent(input: {
  accountId: string;
  accountCreatedAt: Date | string;
  responseId: string;
  businessId: string;
  reviewId: string;
  postedAt: Date | string;
}): CaptureAnalyticsEventInput | null
```

- Computes `daysToActivation = (postedAt - accountCreatedAt) / MS_PER_DAY`.
- Returns `null` when `daysToActivation` is non-finite, `< 0`, or `> 7` (the activation
  is ineligible — caller skips it).
- Otherwise returns:
  `{ event: 'activation_completed', distinctId: accountId, uuid: responseId,
     properties: { account_id, business_id, response_id, review_id,
                   days_to_activation: Number(daysToActivation.toFixed(4)) } }`.
- `MS_PER_DAY` and the 4-dp rounding move here from `activation.ts`.

It owns the **math + event shape + 7-day window** only. It does **not** decide *which*
response is "first" — that stays in SQL, because the live path is single-row and the
backfill is set-based. Callers guarantee they pass the account's first posted response.

### 2. `src/lib/analytics/posthog.ts` (edit) — carry `timestamp` + `uuid`

- `CaptureAnalyticsEventInput` gains optional `timestamp?: Date` and `uuid?: string`.
- `captureAnalyticsEvent` forwards them to `posthog.capture({ ... })` **only when
  present** (no behavior change for existing callers — `dispatchOnce`, live activation).
- Verify against posthog-node v5 that `capture()` accepts `timestamp: Date` and
  `uuid: string` (Context7) before relying on it.

### 3. `worker/jobs/publisher/activation.ts` (edit) — use the shared builder

- Replace the inline days-calc + property literal (current lines ~91–109) with a call
  to `buildActivationCompletedEvent(...)`; if it returns `null`, return.
- Net behavior change: the live path now also sets `uuid = response_id`.
- **Unchanged:** the `reviewId`-mismatch guard, the `first_response_id === response_id`
  check, the 8-day SQL prefilter, and the never-throws swallow-and-log contract (it must
  never block outbox completion).

### 4. `scripts/posthog-backfill-activations.ts` (new) — the CLI

Follows `scripts/zernio-backfill-external-replies.ts` structure (header comment, `tsx`,
`process.exit`).

- **Flags:**
  - `--execute` — default OFF (dry-run). Only this actually sends events.
  - `--before <iso>` — only activations with `posted_at < cutoff`. Default = now. Keeps
    the backfill from overlapping the going-forward live path.
  - `--limit <n>` — optional cap on candidates processed.
  - `--account <id>` — optional, restrict to one account (targeted re-run / testing).
- **Candidate query:** `DISTINCT ON (account_id)` first posted response per account,
  ordered `posted_at ASC, id ASC` (identical tie-break to the live path's LATERAL),
  joined to `accounts.created_at`, filtered `r.status = 'posted' AND posted_at IS NOT
  NULL AND posted_at < cutoff`. Selects `account_id, account_created_at, response_id,
  business_id, review_id, posted_at`.
- **Per row:** call `buildActivationCompletedEvent(...)`; `null` → counted as skipped
  (outside the 7-day window).
- **Dry-run (default):** tally eligible vs skipped, print a small sample
  (`response_id`, `account_id`, `days_to_activation`) and "would send N". Sends nothing.
- **Execute:** if `POSTHOG_API_KEY` is unset, `captureAnalyticsEvent` returns `false` →
  report "0 sent (no key)" **loudly**; never a silent success. Otherwise capture each
  with `timestamp = posted_at` and `uuid = response_id`; track sent vs no-op counts.
- **Flush:** `await shutdownAnalytics()` before `process.exit` (posthog-node batches in
  memory; skipping the flush drops events).
- **Idempotent:** deterministic `uuid = response_id` → PostHog dedupes re-runs and any
  live/backfill overlap. Safe to re-run after interruption.
- **Audit logging:** counts + `response_id`s only via `createWorkerLogger`/console —
  never review or response text (logging contract).

### 5. Tests

- `src/lib/analytics/__tests__/activation-event.test.ts` (new): 0-day (eligible),
  exactly 7.0 days (eligible), `> 7` (null), negative (null), non-finite (null),
  property + `distinctId` + `uuid` shape, 4-dp rounding of `days_to_activation`. This
  retroactively protects the live path's rule too.
- Extend `src/lib/analytics/__tests__/posthog.test.ts`: assert `timestamp` and `uuid`
  forward through `captureAnalyticsEvent` to `posthog.capture`, and that omitting them
  preserves the current call shape.

## Data flow

- **Live:** posted transition → `maybeCaptureActivationCompleted` → SQL (first post,
  8-day prefilter, mismatch + first-post guards) → `buildActivationCompletedEvent` →
  `captureAnalyticsEvent({ ..., uuid: response_id })` (timestamp defaults to now).
- **Backfill:** CLI → SQL (first post per account, `posted_at < cutoff`) →
  `buildActivationCompletedEvent` → (execute) `captureAnalyticsEvent({ ...,
  uuid: response_id, timestamp: posted_at })` → `shutdownAnalytics()` flush.

## Error handling

- Builder is pure and returns `null` for ineligible rows — never throws.
- Script: top-level `try/catch` → log + `exit 1`. Per-row capture failures are counted
  and do not abort the run (best-effort, consistent with the analytics contract).
  Missing key in `--execute` is reported explicitly, not silently treated as success.
- Live path keeps its existing swallow-and-log contract.

## Cross-cutting / ops notes

- **Tenant-scope audit:** the candidate query reads across all accounts by design (like
  `src/lib/admin/margin-service.ts`). **No allowlist entry is needed** — the audit's
  `SCANNED_ROOTS = ['src', 'worker']` does not include `scripts/`, and it flags *unused*
  allowlist entries, so adding one would actually fail the audit. The script header
  documents the cross-account intent instead. (Corrected during planning: an earlier
  draft assumed an allowlist entry was required.)
- **Running the backfill in prod** is an operator step done *after* `POSTHOG_API_KEY`
  is live on Railway; with no key the script's `--execute` is a reported no-op. Document
  usage in the script header.

## Verification gate (before "done")

`pnpm lint && pnpm typecheck && pnpm test` + `pnpm ci:tenant-scope`, run from the
sibling worktree (never a nested one).

## Acceptance mapping (#83)

- AC1/AC2 (Railway key + redeploy + live event verification) — **operator/ops, not this
  PR.**
- AC3 (optional historical backfill) — **delivered here.**
