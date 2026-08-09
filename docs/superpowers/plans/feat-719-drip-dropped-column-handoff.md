# feat-719-drip-dropped-column — handoff

**Resume with:** `/feature-resume feat-719-drip-dropped-column`
A fresh session bootstraps from this file → plan → deviations → review tables. It never needs the
prior transcript.

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-719-drip-dropped-column`
**Branch:** `feat-719-drip-dropped-column`, based on `39c94ed1` (#720)
**Ticket:** https://github.com/RepWorth/ai-review-responder/issues/719
**Lane:** RISK = high · SURFACE = backend · db_touching = false · SIZE = normal

## Artifacts (read these, don't restate them)

| What | Path |
|---|---|
| Intake contract (locked) | `docs/superpowers/plans/feat-719-drip-dropped-column-intake.json` (+ arming copy `.feature/intake.json`) |
| Plan (tracer bullets, 7 tasks) | `docs/superpowers/plans/2026-08-08-719-drip-dropped-column.md` |
| Deviations (2 entries, untriaged) | `docs/superpowers/plans/feat-719-drip-dropped-column-deviations.md` |
| Glossary | `CONTEXT.md` — **Outbox job**, **Watchdog**, **Full access**, **Account**/**Business**. Two terms coined by this work land in Task 7: **Drip staleness cap**, **Job-failure sink**. |
| Machine state | `.feature/state.json` |

## The diagnosis in four sentences

Migration 034 dropped `users.business_id` on 2026-05-10. Three live query sites still read it and
throw Postgres `42703` on every run — `OnboardingDripWorker.ts:146` and `:419`, and
`summary-report-helpers.ts:221` (`ownerHasDashboardAuth`, latent in `WeeklySummaryWorker`/
`MonthlyImpactWorker`, which have not yet run in staging). The drip handler throws *after* claiming
its `onboarding_drip_log` row and *before* sending, so no email has ever left — the issue's
double-send hypothesis is ruled out by 0 `notification_deliveries` and 0 `sent_at`. Two defects
compound it: the scheduler re-mints a failed row every cycle (93 rows), and `worker/index.ts:486`
only added a Sentry *breadcrumb* on job failure, so a hard deterministic crash raised no issue and
`last_error` showed only the Watchdog's generic reclaim text.

## Locked decisions (owner-signed, do not re-litigate)

1. Scope is **A + B + C** — queries, churn cap, and failure visibility, all in this feature.
2. Recurrence guard is a **live-DB integration suite**, scoped to this feature's queries. The
   repo-wide `ci:*` column audit was weighed and **declined** as its own epic-sized ticket.
3. **Drip staleness cap** of 3 days, enforced at the **producer only**.
4. Churn cap is a **rolling 24h window, max 3** — not a lifetime cap. Chosen partly because a
   lifetime cap would have blocked the staging ride against the existing 93 rows.
5. The **93 staging failed rows stay** — they are terminal, inert, and the before/after evidence.
6. The **Watchdog keeps sole ownership of the `job_outbox` status machine.** The sink writes
   `last_error` only, guarded on `status = 'dispatched'`. Marking rows failed on BullMQ exhaustion
   would delete the watchdog's outer retry loop for every worker.
7. The day_30 business-scoped-admin branch is **deleted, not ported** — admins carry
   `account_id IS NULL`, so no rewrite could match.

## Progress

- [x] 0 Classify · [x] 1 Grill + intake locked (owner sign-off) · [x] 2 Worktree + hooks ARMED
- [x] 3 Plan v1 written and self-reviewed
- [x] 3-gate round 1 — Codex `VERDICT: REVISE` (11 HIGH / 4 MEDIUM). Triaged: 16 ACCEPT, 1 REJECT.
      Report + verdicts: `docs/reviews/feat-719-drip-dropped-column/plan-round-1.md`
- [x] Plan **v2** written; intake updated (25 titles, surface narrowed); deviations D3–D5 recorded
- [ ] 3-gate round 2 (verification-only) — **in flight**
- [ ] 4 Execute · [ ] 5 Verify gate · [ ] 6 Deviations read-back · [ ] 7 Review · [ ] 8 Ship

**Plan review rounds used: 2 of 3** (`.feature/state.json` `planReviewRounds`). Cap is hard; after
round 3, surface the remaining disagreement to the owner rather than looping.

**Codex dispatch:** direct `codex exec --sandbox read-only --cd <worktree>` (not the companion
wrapper, which has lost task ids across resumes). codex-cli 0.145.0.
Round 1: brief `<scratchpad>/codex-plan-review-719.md`, raw `…-out.txt` (9,241 lines).
Round 2: brief `<scratchpad>/codex-plan-review-719-r2.md`, raw `…-r2-out.txt`.
Raw transcripts are scratchpad-only and die with the session — the committed round report is the
durable copy.

## What round 1 changed (do not re-introduce)

Four findings reshaped the design; plan v2's opening section is the authoritative account.

1. **The sink writes nothing to `job_outbox` — Sentry only.** `OutboxPoller.ts:140-143` overwrites
   `last_error` unconditionally when the watchdog terminalizes, so the sink's text was destroyed by
   the exact generic message it existed to replace. Preserving it needed an `OutboxPoller.ts` edit
   (out of surface → 2nd amendment → abort). Two more reasons independently condemn it: csv-ingest's
   PII contract (`failed-hook.ts:34`, bounded error CLASS only) and generate-asks deliberately
   leaving rows `dispatched` with its own message. **This write was my scope creep, never signed
   off** — see D3.
2. **`recordOutboxTransientError` and `isTerminalAttempt` already exist** (`outbox.ts:183`, `:210`).
   Both were about to be reinvented. `src/lib/shared/outbox.ts` is now read-only for this feature.
3. **The scheduler gets `runOnboardingDripCycle(exec, asOf)`** — it throws where `checkAndSchedule`
   swallowed, and returns skip counts. Without it every negative scheduler test was vacuous: a
   swallowed `42703` looks exactly like a correct skip.
4. **The eval is 25 tests, not 16.** Four of the original 16 passed *before* any fix, day_7 had no
   live coverage at all, and `describeWithDb` silently SKIPS without `TEST_DATABASE_POOL_URL` — so
   vitest could exit green with zero live coverage. Title 1 is now an execution sentinel.

## Execution shape (step 4)

Task 1 runs **alone** — its completion is the first-task enforcement spot check
(`git status --porcelain` paths vs `allowed_edit_surface`; an out-of-surface file means the guard
did not bind for subagent tool calls, so STOP and report). After it passes, **T2, T5 and T6 are
mutually independent** (no blocking edges, disjoint file sets) and may fan out concurrently.
T3 blocks on T2; T4 blocks on T3 and is droppable; T7 blocks on T2+T5+T6.

## Pre-verified facts (don't re-derive)

- The local test DB is reachable; `TEST_DATABASE_POOL_URL` resolves from `.env.local`.
- `businesses` NOT NULL columns with no default are exactly `id, name, owner_name, owner_email,
  account_id` — the plan's `seedLocation` covers all five, so it will not fail on insert.
- All 16 `tests_to_add` titles appear verbatim in the plan (checked programmatically).
- `pnpm ci:live-db-suites` since #720 audits helper files too, so the `live-db-tenant.ts` additions
  are in scope for it — Task 1 Step 6 runs it explicitly.

## Gate command

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-719-drip-dropped-column
export TEST_DATABASE_POOL_URL=...   # live-DB suites must RUN, not SKIP — DB-touching work
bash scripts/verify-gate.sh --review
```

## Ship lane (RISK = high)

Staging first (push to `staging`, both Railway worker and Vercel staging auto-deploy), verify the
three terminal facts, then PR to `main` and **pause for explicit merge approval**. No migration, so
nothing to apply in lockstep. Full ride steps and the day_1-window timing caveat are in the plan's
"Staging ride" section.
