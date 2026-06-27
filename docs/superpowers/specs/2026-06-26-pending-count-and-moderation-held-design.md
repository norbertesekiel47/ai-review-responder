# Design — Pending-count convergence (#346) + Moderation-HELD live verify (#239)

- **Date:** 2026-06-26
- **Issues:** [#346](https://github.com/RepWorth/ai-review-responder/issues/346) (code), [#239](https://github.com/RepWorth/ai-review-responder/issues/239) (verify)
- **Status:** Approved (brainstorm), pending implementation
- **Structure:** Two independent tracks. Track A is a code PR (full CI + Codex + React Doctor gates). Track B is a live staging verification I drive via MCP/CLI, delivering a runbook + issue closure — NOT routed through the React-Doctor/Codex-diff gates, which do not apply to an ops verification.

---

## Track A — #346: converge pending-count on the authoritative SQL count

### Problem

The pending-approval count has two computation paths that can disagree on busy
(>10 pending) accounts:

1. **Authoritative (correct):** `getPendingApprovalCount`
   (`src/lib/dashboard/pending-count.ts`) — a `COUNT(*)` with no `LIMIT`,
   excluding held/flagged drafts. It seeds the nav badge via the layout and
   drives the dashboard hero strip via `reputationSummary.pendingApprovalCount`.
2. **Client-side (can undercount):** `computePendingCount` in
   `src/components/dashboard/DashboardContent.tsx` and the `pending` derivation
   in `useSyncPendingCount` (`src/hooks/useSyncPendingCount.ts`) recompute by
   filtering `recentReviews`, which the API caps at ~`LIMIT 10`. With >10
   pending drafts these **undercount**.

On the dashboard this means the **strip** (authoritative) and the **mobile-tab
badge** (client-filtered) can disagree. `pending-count.ts` documents a "single
authoritative count … can never disagree or over-count" intent that the client
filter paths technically violate.

### Key finding (why no API change is needed)

The authoritative SQL count is **already in the payload** for every surface:

- **Per-location** (`DashboardDataActive`, and `DashboardDataPastDue` which
  extends it): `reputationSummary.pendingApprovalCount`. The route always
  requests it — `src/app/api/dashboard/route.ts:163` and `:195` both call
  `getActiveDashboardData(locationId, { includeReputationMetrics: true })` — so
  **both** `/dashboard` (`DashboardContent`) and `/dashboard/reviews`
  (`ReviewsContent` → `useSyncPendingCount`) receive it.
- **Aggregate** (`AggregateDashboardData`): each `locationKpis[]` entry carries
  an authoritative per-location `pendingApprovalCount`; the aggregate total is
  their sum. (No top-level aggregate field exists today.)

So convergence is a pure client-side change: derive from the authoritative
fields already present, instead of filtering the capped slice.

### Design

**1. New shared helper** in `src/lib/dashboard/scope.ts` (the natural home — it
already owns `isAggregate`, `perLocationActive`, and the `DashboardPayload`
type; no new file, per the "default is no new file" rule):

```ts
/**
 * The authoritative count of owner drafts awaiting approval, derived from the
 * SQL-backed fields already present in the payload (NOT the capped recentReviews
 * slice, which undercounts past ~10 pending — issue #346).
 *   aggregate            → Σ locationKpis[].pendingApprovalCount
 *   per-loc active/pastdue → reputationSummary.pendingApprovalCount
 *   else / null          → 0
 */
export function authoritativePendingCount(data: DashboardPayload | null): number;
```

- Aggregate branch: `data.locationKpis.reduce((sum, k) => sum + k.pendingApprovalCount, 0)`.
- Per-location branch (`perLocationActive(data)` non-null): return
  `active.reputationSummary?.pendingApprovalCount`. **Defensive fallback only:**
  if `reputationSummary` is somehow absent (an impossible state for the active
  per-location route, which always passes the flag), fall back to the existing
  filtered-`recentReviews` count so behavior never regresses below today's. This
  mirrors the defensive `??` synth already in `DashboardContent.tsx`. The
  fallback is documented as an impossible-state guard, not a real path.
- Everything else (`null`, `pending_payment`, `cancelled`, etc.) → `0`,
  matching today's `computePendingCount`.

**2. `DashboardContent.tsx`** — delete the local `computePendingCount` function;
call `authoritativePendingCount(data)` for the badge push. The strip already
reads the authoritative `reputation.pendingApprovalCount`; the badge now matches
it. (The blocked-offboarding `setPendingCount(0)` path is unchanged.)

**3. `useSyncPendingCount.ts`** — replace the inline `.filter()` derivation with
`authoritativePendingCount(data)` (guarded by `!loading`), preserving its return
value and the `setPendingCount` effect.

**Out of scope (left as-is):** the defensive `reputationSummary ?? { … }` synth
block in `DashboardContent.tsx` (~L266–275). Its `pendingApprovalCount` fallback
also filters `recentReviews`, but it only fires in the same impossible state
(no `reputationSummary`), so it is not the bug and changing it adds risk for no
behavioral gain.

### Tests (TDD, write first)

New unit test for `authoritativePendingCount`:

- **>10 regression (per-location):** active payload with
  `reputationSummary.pendingApprovalCount = 15` but only 10 pending in
  `recentReviews` → returns **15**, not 10.
- **>10 regression (aggregate):** `locationKpis` summing to >10 (e.g. 8 + 9 =
  17) while `recentReviews` is capped at 10 → returns the **sum**.
- **Past-due per-location:** same as active (reputationSummary present) → SQL
  count.
- **Impossible-state guard:** active payload with `reputationSummary` undefined
  → falls back to the filtered count (documents the guard).
- **Non-active / null:** `pending_payment`, `cancelled`, `null` → 0.

Existing `DashboardContent` / `useSyncPendingCount` tests must continue to pass.

### Verification

`pnpm lint && pnpm typecheck && pnpm test`. **Not DB-touching** (pure
client-side TS; no SQL, no schema, no tenant-scoped query) → the tenant-scope /
RLS audits do not apply.

### Review gates

1. Codex review of the diff (correctness) → triage → fix → re-verify.
2. `/thermo-nuclear-code-quality-review` on the branch (maintainability) →
   triage → fix → re-verify.
3. PR with all GitHub CI checks green, including a 100/100 React Doctor.

---

## Track B — #239: live-verify the high-severity moderation HELD veto on staging

### Problem

Invariant #4: after generation, `moderateResponse` runs; a `high`-severity flag
must **hold** the draft — write a `flagged_responses` row (admin-only deny-all
RLS), **skip** the `send_notification` enqueue in the same transaction, and
**never** auto-approve/post. Re-notify only via admin `approved_for_owner_review`
at `/admin/flagged`.

This path is unit-tested, but was **never exercised live** on staging during the
2026-06-06 auto-approval run (the §5 matrix spot-checked rating-threshold and
auto-approval-disabled, but not the moderation HELD case — "the important safety
one"). It is worth a live verification before auto-approval is relied on against
a real Google Business Profile.

The runbook the issue cites (`docs/runbooks/auto-approval-staging-test.md`) no
longer exists; only `auto-approval-provider-moderation-validation.md` does.

### Forcing mechanism (real path)

Moderation runs on the AI's (polite) reply draft, so tripping high-severity
"naturally" is unreliable. But the **local regex filter always runs**
(`src/lib/moderation/output-filter.ts`) and deterministically returns
`severity: 'high'` for `refund`/`discount`/`coupon`/`lawsuit`/profanity, etc.
So the held case trips the instant the **draft** contains such a word — no
OpenAI moderation and no model trickery required; the only variable is whether
the generated draft echoes a flagged word.

Plan (I drive via Supabase/Railway MCP + CLI):

1. **Confirm staging state:** Railway worker healthy; read `AUTO_APPROVAL_ENABLED`
   and `OPENAI_MODERATION_ENABLED`; identify a staging account/business with an
   active subscription + active connection.
2. **Seed** a negative review (staging Supabase) that invites a refund/billing
   reply, ingested as `live_ingest_new` so generation runs on the worker.
3. **Generate;** if the draft does not contain a high-severity term, retry /
   regenerate or tune the review text until the local `output-filter` trips
   `high`.
4. **Capture evidence** from the worker's structured decision log + DB:
   - draft **held** — no `approval_method`, not posted;
   - `flagged_responses` row written (severity `high`, status `open`);
   - **no** `send_notification` enqueued (no notification job/row);
   - admin re-notify path present (`approved_for_owner_review` → `/admin/flagged`).
5. **Clean up** seeded data.

**Risk:** if the polite draft will not echo a banned word after a few attempts,
escalate to prompt-coaxed review text (quote the customer's "refund" demand back)
and report the escalation.

### Deliverable

- Recreate `docs/runbooks/auto-approval-staging-test.md` with the verified steps
  + evidence (own small docs PR, separate from Track A).
- Close #239 with the evidence (decision-log excerpts + DB row facts) pasted in.

---

## Session sequencing

Track A is the spine: spec → plan → TDD execute → verify → Codex → React Doctor
→ PR. Track B's staging checks run alongside (I/O-bound); its runbook + issue
closure land as a separate docs PR.
