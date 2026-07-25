# Handoff — #546 rival picker (step 3 → step 4)

**Resume with:** `/feature-resume feat/546-rival-picker` from
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-546-rival-picker`.
Do not re-read the grilling or plan-review conversation — everything below is on disk.

## State

| | |
|---|---|
| Branch | `feat/546-rival-picker` (worktree above, sibling — not nested) |
| Phase | `plan_approved` (`.feature/state.json`, head `4221e5b7`) |
| Enforcement | ARMED (`scripts/arm-check.sh` re-verified after the amendment) |
| Next step | **4 — EXECUTE** via `superpowers:subagent-driven-development` |
| Amendments used | **1 of 1** — a second triggers abort criteria |
| Review rounds used | **3 of 3** — the adversarial plan gate is closed, do not reopen it |

## Artifacts (read these, not this file)

- Plan: `docs/superpowers/plans/feat-546-rival-picker.md` — 5 tracer tasks, full code, blocking edges
- Intake contract: `.feature/intake.json` (arming) / `docs/superpowers/plans/feat-546-rival-picker-intake.json` (audit) — identical, both carry the amendment + `surface_amendments`
- Ticket: `gh issue view 546`; map `#528`; locked semantics on closed `#532` (read its two comments)
- Glossary: `CONTEXT.md` § "Competitor Delta" — Named rival / Auto-default rival / Competitor pack, use verbatim

## What was decided in grilling (do not re-litigate)

Recorded in full in the intake. The seven locked forks: full vertical slice incl. digest honoring · pick stored as three columns on `businesses` · dropout derived from the two-snapshot window, never stored · new `/settings/competitors` page · pack-order dropdown retaining an absent pick · source-discriminated copy with the live pack title winning · server-validated writes with a server-derived title snapshot · durable `competitor_rival_picked` analytics event.

## What the 3 adversarial rounds changed (the expensive knowledge)

These are the things a fresh agent would otherwise get wrong. All are already written into the plan — this list exists so you don't "simplify" them back out:

1. **`analytics_events.event_name` is a DB CHECK allowlist** (046, last extended by 069), not just a TS array. Migration 089 must DROP/re-ADD it or every pick transaction rolls back. `ci:analytics-events` does NOT catch this — it only compares the TS array to `docs/analytics/events.md`.
2. **`migration-069-trial-subscription.test.ts:44-49` breaks the moment any event name is added** — it asserts its own (immutable) CHECK list equals the current `ANALYTICS_EVENT_NAMES`. Task 1 narrows it to its historical list and moves the live check to 089's test. This is a repo-wide landmine → promote to `.claude/reference/lab-notes.md` at step 8.
3. **`db.begin()` does not give snapshot isolation** — Postgres defaults to READ COMMITTED, one snapshot per *statement*. The digest read is therefore ONE CTE query (exact shape in Task 2), not three statements in a transaction.
4. **The pick write must resolve keyword, search location AND the latest snapshot date INSIDE the `UPDATE … FROM`.** Passing any of them in from an earlier read reopens the race: the worker can commit a new-date pack in between, and we store a rival absent from the now-latest pack. Locking is the wrong tool — the worker's row lock is keyed per snapshot_date, so it cannot serialize a new-date insert, and making it serialize would mean editing `RankingTrackingWorker.ts` (out of surface).
5. **The dropout guard is `currentRows.length === 0`, not `!self`.** A non-empty pack lacking our `is_self` row is real data and a real dropout must still fire; guarding on `self` trades a false positive for a false negative.
6. **Retry idempotency needs both**: `rival_picked_at` bumped only on `IS DISTINCT FROM`, and the clear carrying `AND rival_place_id IS NOT NULL`. Both event-key timestamps come from `RETURNING`, never JS `new Date()`.
7. **`businessId` goes in the analytics properties blob, not just the column** — `AnalyticsDispatchPoller`'s `RETURNING` never selects `business_id`, so the column never reaches PostHog.
8. **Rejected finding, do not "fix" it:** excluding blank-title rows from the picker is deliberate — the shipped `selectAutoDefaultRival` already refuses them, so a blank-title rival is one the digest could never name.

## Step 4 instructions

`bash scripts/feature-state.sh set-phase executing`, then dispatch one fresh subagent per task in plan order. Tasks 1 and 2 have no blocking edges and may run in parallel; 3 → 4 → 5 are strictly sequential.

Every task prompt must carry the `CONTEXT.md` glossary excerpt and the task's blocking-edge context. **After the FIRST subagent completes, diff `git status --porcelain` against `allowed_edit_surface`** — an out-of-surface path means enforcement did not bind for subagent tool calls; STOP and report.

Deviations go to `docs/superpowers/plans/feat-546-rival-picker-deviations.md`, never into a widened scope.

## Gate notes for step 5

- `TEST_DATABASE_POOL_URL` **must** be set — this work is DB-touching and the plan adds an integration suite. A SKIP row makes the gate non-review-ready (the #520 class).
- Final gate run before review is `scripts/verify-gate.sh --review`.
- `promised-tests` checks all 19 intake titles verbatim; the plan's test titles were written to match.
- No `fast-check` property test is mandated — this touches neither billing, approval/auto-approval, nor escalation.

## Suggested skills

`superpowers:subagent-driven-development` (step 4 driver) · `new-migration` (Task 1, before any SQL) · `repworth-brand-design` (Task 5, before any JSX) · `tdd` (per-task red-green) · `superpowers:receiving-code-review` (step 7 triage) · `flag-flip` **not** needed (no flag) · `outbox-pattern` **not** needed (no async work added).

## Ship lane (step 8)

RISK=high → **staging ride first**. Migration 089 applies to staging Supabase before the PR, prod in lockstep at promotion. Then PR to `main`, all CI green, pause for explicit merge approval.
