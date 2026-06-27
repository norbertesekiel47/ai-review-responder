# Tier-3 GA Unblocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the #355 Pass-1 durable delete-reply-400 instrumentation (TDD) plus four execution-ready GA-unblock docs (#290 PostHog dashboards, #289 launch-flag readiness, #291 GBP API filing, #134 WhatsApp runbook + variable-map gate), all on branch `tier3-ga-unblocks`.

**Architecture:** One in-worktree code change (observability-only in `handleDeleteError`) guarded by a new unit test, plus four Markdown runbooks/docs grounded in the real codebase (analytics event names, boot assertions, the WhatsApp renderer). No ops, no deploys, no flag flips, no prod/staging mutations — the docs only *describe* those owner/orchestrator actions.

**Tech Stack:** TypeScript (worker, Postgres.js TransactionSql), Vitest, Markdown. Approved spec: `docs/superpowers/specs/2026-06-26-tier3-ga-unblocks-design.md`.

**Strict scope (do NOT):** run MCP/Railway/Vercel/Supabase tools, deploy, touch prod/staging, set env vars, flip flags, or implement the #355 Pass-2 disposition fix (blocked on a staging-captured 400 `body.code` the orchestrator obtains separately). One logical commit per task (A–E) plus the plan commit. Every commit ends with the two required trailer lines.

---

## File Structure

| Path | Create/Modify | Responsibility |
|---|---|---|
| `worker/jobs/publisher/edit-publish-errors.ts` | Modify (`handleDeleteError`, ZernioPermanentError branch ~L312-331) | Emit ONE durable structured `logger` line for the `http_400` / `delete_reply` case before the existing `UPDATE … failed` write. Behavior otherwise unchanged. |
| `worker/jobs/publisher/__tests__/edit-publish-errors.test.ts` | Create | Unit test for the new instrumentation + unchanged `permanent_failed` outcome. Lives in `__tests__/` per repo convention. |
| `docs/runbooks/posthog-launch-dashboards.md` | Create | #290 — 4 dashboards mapped to real analytics event names with per-insight definitions; explicit gaps where no backing event exists. |
| `docs/runbooks/launch-flag-readiness.md` | Create | #289 — per-flag readiness table for the 7 launch flags (repo-verifiable vs owner-verify-at-flip) + an empty owner/orchestrator live-snapshot section. |
| `docs/runbooks/gbp-api-application.md` | Create | #291 — fire-and-forget GBP API access application checklist. |
| `docs/runbooks/whatsapp-templates.md` | Modify | #134 — dated variable-map validation subsection (PASS/MISMATCH) + SID-record placeholder + 7-env-var Vercel/Railway checklist. |

---

## Task A: #355 Pass-1 — durable delete-reply 400 instrumentation (TDD)

**Files:**
- Modify: `worker/jobs/publisher/edit-publish-errors.ts` (`handleDeleteError`, `ZernioPermanentError` branch, ~L312-331)
- Test: `worker/jobs/publisher/__tests__/edit-publish-errors.test.ts` (create)

**Context (verified in code):**
- `src/lib/zernio/client/error-classifier.ts:94` wraps a non-`select_location` 400 as `new ZernioPermanentError('http_400', { status: 400, body, endpointKind })`.
- `ZernioPermanentError` (`src/lib/zernio/errors.ts:25-33`): `constructor(public readonly kind: string, public readonly meta: Record<string, unknown>)`. So `err.kind === 'http_400'` and `err.meta = { status, body, endpointKind }`.
- `WorkerLogger` (`src/lib/shared/logger.ts:4-8`): `{ log, warn, error }`, each `(...args: unknown[]) => void`. Object args pass through `sanitizeAnalyticsProperties`; string args are logged verbatim. Pass the body as an OBJECT arg so the sanitizer applies.
- Logging invariant: never log raw review/response text, tokens, secrets, MFA codes. Zernio API error metadata (status/code/body) is NOT customer content — safe — but bound it.

- [ ] **Step 1: Write the failing test**

Create `worker/jobs/publisher/__tests__/edit-publish-errors.test.ts`. The only collaborator `handleDeleteError` needs is a `tx` template-tag that returns `{ count: 1 }` for the UPDATE, and a spy logger. Match the `mkLogger` / tagged-result style of `publisher-error-handlers.test.ts`.

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleDeleteError } from '../edit-publish-errors';
import { ZernioPermanentError } from '../../../../src/lib/zernio/errors';
import type { WorkerLogger } from '../../../../src/lib/shared/logger';

// Minimal tx stub: every tagged call resolves to a count-tagged array. The
// handler only inspects `.count` on the UPDATE result, so count:1 = "candidate
// row updated" (the happy disposition path).
function mkTxReturning(count: number) {
  return vi.fn(() => Promise.resolve(Object.assign([], { count }))) as unknown as Parameters<typeof handleDeleteError>[0];
}

const mkLogger = (): WorkerLogger => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

function mkArgs(logger: WorkerLogger) {
  return {
    responseId: 'resp-1',
    businessId: 'biz-1',
    zernioAccountId: 'acct-1',
    zernioLocationId: 'loc-1',
    logger,
  };
}

describe('handleDeleteError — http_400 / delete_reply instrumentation (Pass 1)', () => {
  it('logs the Zernio body.code and still returns permanent_failed', async () => {
    const logger = mkLogger();
    const tx = mkTxReturning(1);
    const err = new ZernioPermanentError('http_400', {
      status: 400,
      body: { code: 'some_test_code' },
      endpointKind: 'delete_reply',
    });

    const outcome = await handleDeleteError(tx, err, mkArgs(logger));

    expect(outcome).toEqual({ kind: 'permanent_failed' });

    // One durable structured line captured the code (object-arg, sanitized).
    const allLogCalls = [
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const serialized = JSON.stringify(allLogCalls);
    expect(serialized).toContain('some_test_code');
    expect(serialized).toContain('delete_reply_400_body');
  });

  it('does not emit the 400 instrumentation for a non-400 permanent error', async () => {
    const logger = mkLogger();
    const tx = mkTxReturning(1);
    const err = new ZernioPermanentError('inbox_addon_required', { endpointKind: 'delete_reply' });

    const outcome = await handleDeleteError(tx, err, mkArgs(logger));

    expect(outcome).toEqual({ kind: 'permanent_failed' });
    const serialized = JSON.stringify([
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    expect(serialized).not.toContain('delete_reply_400_body');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks && pnpm vitest run worker/jobs/publisher/__tests__/edit-publish-errors.test.ts`
Expected: first test FAILS — `delete_reply_400_body` not present (no log emitted yet). Second test PASSES already.

- [ ] **Step 3: Write minimal implementation**

In `handleDeleteError`'s `if (err instanceof ZernioPermanentError)` branch, BEFORE the existing `UPDATE responses … failed` write, add a guarded instrumentation block. Defensively bound the body to `{ status, code, bodyPreview }`.

```typescript
  if (err instanceof ZernioPermanentError) {
    // DELETE permanent failure (incl. inbox_addon_required). Sibling unchanged.
    const kind = err.kind ?? 'unknown';

    // #355 Pass-1 instrumentation: surface the otherwise-lost Zernio 400 body
    // on the delete_reply path. Sentry is off on staging, so this durable
    // structured line is how the orchestrator captures `body.code` to decide
    // the Pass-2 disposition. Zernio API error metadata (status/code/body) is
    // NOT customer content; bound it so a pathological body can't bloat the log.
    if (kind === 'http_400' && (err.meta as { endpointKind?: unknown }).endpointKind === 'delete_reply') {
      const body = (err.meta as { body?: unknown }).body;
      logger.warn('delete_reply_400_body', {
        event: 'delete_reply_400_body',
        status: (err.meta as { status?: unknown }).status,
        code: (body as { code?: unknown } | null | undefined)?.code,
        bodyPreview: JSON.stringify(body ?? null).slice(0, 500),
      });
    }

    const updated = await tx`
      UPDATE responses
      SET status = 'failed',
          posting_error = ${deleteFailedMarker(kind)},
          updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
    if (updated.count !== 1) {
      throw new Error(
        `delete-permanent: candidate UPDATE expected 1 row, got ${updated.count}`,
      );
    }
    return { kind: 'permanent_failed' };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks && pnpm vitest run worker/jobs/publisher/__tests__/edit-publish-errors.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks
git add worker/jobs/publisher/edit-publish-errors.ts worker/jobs/publisher/__tests__/edit-publish-errors.test.ts
git commit -m "feat(publisher): instrument delete_reply 400 body for #355 Pass-1"
```

---

## Task B: #290 — PostHog launch dashboards spec

**Files:**
- Create: `docs/runbooks/posthog-launch-dashboards.md`

**Grounding (real emitted events — `src/lib/analytics/events.ts:4-23` is the authoritative allowlist, synced to the `analytics_events` event_name CHECK constraint):**
- Activation funnel: `signup_started`, `email_verified`, `gbp_connect_started`, `gbp_connected`, `first_review_ingested`, `first_response_drafted`, `activation_completed`. Sources: `SignupForm.tsx:307` / `enqueue/route.ts`; `verify-otp/route.ts:203`; `zernio/connect/start/route.ts:316`; `zernio/connect/_shared/finalize/finalize-tx.ts:157`; `reviews/process-review.ts:169`; `response-generation/analytics.ts:50`; `analytics/activation-event.ts:45`.
- Latency-carrying props: `first_response_drafted.minutes_to_first_draft`, `activation_completed.days_to_activation`.
- Trial lifecycle: `trial_started`/`trial_converted`/`trial_payment_failed`/`trial_cancelled` (`analytics/trial-events.ts`).
- Offboarding: `offboarding_started`/`_reactivated`/`_teardown_completed`/`_purged` (`account-offboarding/analytics.ts`).
- Dispatch: durable rows in `analytics_events` ship to PostHog via `worker/background/pollers/AnalyticsDispatchPoller.ts` (event_name → PostHog event).
- GAPS (state explicitly — do NOT invent events): no approval-loop event (notification→approve→post), no channel-send/deliver event, no cost event in PostHog (cost lives in `api_costs` Postgres / `margin-service`, admin-only).

- [ ] **Step 1: Write the doc**

Write `docs/runbooks/posthog-launch-dashboards.md` with the 4 dashboards. For each insight specify: exact event name, property filters, breakdowns, math/aggregation, chart type, and the source file citation. Where a desired metric has no backing event, write an explicit "GAP" note (what event would be needed, where it would be emitted) rather than inventing one. (Full content authored in execution.)

- [ ] **Step 2: Verify event names are real**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks && rg -n "^  '" src/lib/analytics/events.ts | head -25`
Expected: every event name cited in the doc appears in `ANALYTICS_EVENT_NAMES`.

- [ ] **Step 3: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks
git add docs/runbooks/posthog-launch-dashboards.md
git commit -m "docs(analytics): PostHog launch dashboard spec grounded in real events (#290)"
```

---

## Task C: #289 — launch-flag readiness gate doc

**Files:**
- Create: `docs/runbooks/launch-flag-readiness.md`

**Grounding (verified):**
- Boot assertions wired in `worker/index.ts:315-319`: `assertChannelsTelegramEnv`, `assertChannelsWhatsAppEnv`, `assertSelfServeSignupEnv`, `assertZernioPublishingEnv`, `assertAccountOffboardingEnv` (all in `worker/config/startup-assert.ts`).
- `SELF_SERVE_SIGNUP_ENABLED` → `assertSelfServeSignupEnv` (REDIS_CACHE_URL, NEXT_PUBLIC_APP_URL, STRIPE_PRICE_* vars). Migration 064 IS applied to prod (per spec §1) → migration prereq green. Owner verifies live: SMTP confirmation template (`{{ .Token }}` 6-digit OTP per CLAUDE.md gotcha), Stripe price IDs live.
- `OPENAI_MODERATION_ENABLED` → NO boot assertion; worker-only (`src/lib/moderation/moderate.ts`, fail-open). Owner verifies live: thresholds tuned vs real samples.
- `MFA_ENFORCEMENT_ENABLED` → NO boot assertion; `src/lib/auth/flags.ts` (Wave 2, PR #87). Enrollment UI already live + AAL2 hard-required even when off — flag only gates page-nav redirect. Owner verifies live: owner/admin regression pass.
- `MULTI_LOCATION_ENABLED` → NO boot assertion; `src/lib/locations/flags.ts` + three-gate helpers in `multi-location-mode.ts`. Owner verifies live: per-location overage billing wired.
- `CHANNELS_WHATSAPP_ENABLED` → `assertChannelsWhatsAppEnv` (7 vars + format + URL-base equality). Owner verifies live: Meta verification + WABA + template HX SID approved.
- `CHANNELS_TELEGRAM_ENABLED` → `assertChannelsTelegramEnv` (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET). Owner verifies live: bot registered + setWebhook called.
- `RANKING_TRACKING_ENABLED` → NO boot assertion; `src/lib/ranking/flags.ts`. `RankingTrackingWorker.ts:172-173` caps `rawKeywords.slice(0, 1)` (1 keyword/business — lift on rollout). Owner verifies live: SerpAPI key live.

- [ ] **Step 1: Write the doc**

Write `docs/runbooks/launch-flag-readiness.md` with a 7-row table. Columns: Flag | Prerequisite | Repo-verifiable status | Owner-verify-at-flip (live prod state — "owner verifies live (not in repo)") | Flip action. No "TBD"/"TODO". Add a clearly-labeled empty "Live verification snapshot (owner/orchestrator fills via MCP)" section at the bottom (intentional, not a gap). (Full content authored in execution.)

- [ ] **Step 2: Verify boot-assertion claims**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks && rg -n "assert(SelfServeSignup|ChannelsTelegram|ChannelsWhatsApp)Env\(\)" worker/index.ts`
Expected: the three assertions are called at boot (L315-317).

- [ ] **Step 3: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks
git add docs/runbooks/launch-flag-readiness.md
git commit -m "docs(launch): per-flag readiness gate for the 7 GA launch flags (#289)"
```

---

## Task D: #291 — GBP API filing guide

**Files:**
- Create: `docs/runbooks/gbp-api-application.md`

**Grounding:** flipping `EDIT_REPLIES_ENABLED` unblocks the edit-existing-replies path (the `runEditPublishIfApplicable` DELETE-before-POST flow). The GBP API access application gates that quota. Navigation path stated generically (Google Cloud Console → Business Profile APIs access request) — do NOT invent a precise URL.

- [ ] **Step 1: Write the doc**

Write `docs/runbooks/gbp-api-application.md`: what access is requested (GBP API quota for posting + editing review replies), where to apply (Google Cloud Console → Business Profile APIs → access request form; generic nav, no invented URL), the RepWorth-tailored use-case description to submit (SMB SaaS that drafts and, on owner approval, posts/edits Google review replies on the business's behalf), expected lead time (weeks), and what flipping unblocks on approval (`EDIT_REPLIES_ENABLED`, edit-existing-replies path). Owner files it. (Full content authored in execution.)

- [ ] **Step 2: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks
git add docs/runbooks/gbp-api-application.md
git commit -m "docs(gbp): fire-and-forget GBP API access application checklist (#291)"
```

---

## Task E: #134 — WhatsApp runbook update + variable-map validation gate

**Files:**
- Modify: `docs/runbooks/whatsapp-templates.md`

**Grounding (verified against `src/lib/notifications/channels/whatsapp-body.ts:142-160`):** `formatApprovalWhatsApp` positional map `{{1}}`–`{{9}}`: `1`=businessName, `2`=reviewerName(`||'Reviewer'`), `3`=`String(starRating)`, `4`=reviewDate, `5`=reviewText(`??'(no comment)'`), `6`=responsePreview(draft), `7`=`a:${approvalLinkId}`, `8`=`r:${approvalLinkId}`, `9`=`extractTokenFromApprovalUrl(approvalUrl)`. The runbook's existing §"Variable map validation gate" table (L56-68) documents the same map → expected verdict PASS. The 7-env-var matrix already exists (L106-121); the SID record line exists (L104). Do NOT change the renderer or any wording/button/variable order (restarts the Meta clock).

- [ ] **Step 1: Add the dated validation subsection + reinforce SID-record placeholder**

In `docs/runbooks/whatsapp-templates.md`, under the `repworth_approval_request_v1` template's "Variable map validation gate", add a dated subsection `#### Variable-map validation (2026-06-26)` containing the 9-row index→source-field map and a `**Verdict: PASS**` line (renderer matches the documented body). Add an explicit go-live SID-record line using a placeholder (`HX________ (record at go-live)`) and reference the existing 7-env-var Vercel+Railway checklist (CHANNELS_WHATSAPP_ENABLED, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER, WHATSAPP_APPROVAL_TEMPLATE_SID, WHATSAPP_APPROVAL_URL_BASE = NEXT_PUBLIC_APP_URL + '/approve/', NEXT_PUBLIC_APP_URL, + WORKER_PUBLIC_URL on Railway). (Full content authored in execution.)

- [ ] **Step 2: Verify the renderer map is unchanged**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks && rg -n "'[1-9]':" src/lib/notifications/channels/whatsapp-body.ts | head -9`
Expected: the nine positional keys map exactly as documented (no edit to this file).

- [ ] **Step 3: Commit**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks
git add docs/runbooks/whatsapp-templates.md
git commit -m "docs(whatsapp): dated variable-map validation gate + go-live SID/env checklist (#134)"
```

---

## Verify gate (after all tasks)

Run from the worktree, capture real output:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/tier3-ga-unblocks
pnpm lint && pnpm typecheck && pnpm test
pnpm ci:rls-audit
```

Expected: all green. Any failure is almost certainly the Task-A code/test — fix and re-run until green. Do not claim green without the passing tail output.

---

## Orchestrator follow-ups (intentionally NOT done here)

- #355: staging deploy of Pass-1 + recreate repro + capture `body.code` + Pass-2 disposition fix & regression test.
- #134: set staging env (7 vars on Vercel + Railway), run the 8-point ship gate, record the real `HX…` SID, owner does the prod flag flip.
- #289: owner/orchestrator fills the live verification snapshot via MCP; owner flips each prod flag.
- #290: owner builds the 4 dashboards in the PostHog UI.
- #291: owner files the Google Business Profile API access application.

---

## Self-Review

- **Spec coverage:** #355 Pass-1 (Task A), #290 (Task B), #289 (Task C), #291 (Task D), #134 doc+gate (Task E). Pass-2 (#355) and all ops surfaces are explicitly out-of-scope per the dispatch + spec §6 division of labor. ✅
- **Placeholder scan:** doc tasks defer full prose to execution but pin exact event names, file citations, columns, and verdicts — no "TBD"/"TODO" lands in the committed docs. Task A shows complete test + implementation code. ✅
- **Type consistency:** `handleDeleteError(tx, err, args)` signature, `ZernioPermanentError(kind, meta)` shape, and `{ kind: 'permanent_failed' }` outcome match `edit-publish-errors.ts` / `errors.ts`. ✅
