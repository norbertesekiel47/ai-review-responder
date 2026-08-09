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
- [x] 3 Plan written, self-reviewed (16/16 promised titles present verbatim)
- [ ] 3-gate Codex adversarial plan review — **round 1 in flight**
- [ ] 4 Execute · [ ] 5 Verify gate · [ ] 6 Deviations read-back · [ ] 7 Review · [ ] 8 Ship

**Plan review rounds used: 1 of 3** (`.feature/state.json` `planReviewRounds`). Cap is hard; after
round 3, surface the disagreement to the owner rather than looping.

**Codex round 1:** dispatched via direct `codex exec --sandbox read-only` (not the companion
wrapper, which has lost task ids across resumes). Raw output:
`<scratchpad>/codex-plan-review-719-out.txt`; brief: `<scratchpad>/codex-plan-review-719.md`.
Session id: _(fill from the run header on completion)_

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
