# Spec & Correctness Review — fix/verification-remainders

Reviewer: SPEC & CORRECTNESS agent · Date: 2026-07-20
Diff: `git diff main...HEAD` in `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-verification-remainders`
Spec: `.feature/intake.json` (read in full) + `docs/superpowers/plans/fix-verification-remainders-plan.md` (rev 2)

## Verdict

**PASS — no findings at >=80% confidence.** Every intake field is implemented,
every invariant honored, every edge case handled, every listed test present and
meaningful, no scope drift, and the ADR/CONTEXT/code triangle is internally
consistent (cap 9, judge 1, ~10 trigger). `pnpm typecheck` clean; the new
startup-assertion suite passes (88/88).

## 1. Intake field-by-field

### goal / user_visible_behavior

| Item | Evidence | Verdict |
|---|---|---|
| Boot fails fast if summed non-flag-gated LLM slots > 9 | `worker/config/startup-assert.ts:139-152` (`summedSlots > SUMMED_LLM_WORKER_SLOT_CAP` throw) | PASS |
| …or judge_verdict > 1 | `startup-assert.ts:154-164` (per-flag-gated-entry check) | PASS |
| Failover lookups become index-served | `supabase/migrations/082_failover_lookup_indexes.sql` — both partial indexes match the poller queries exactly (see §3) | PASS |

### invariants

| Invariant | Evidence | Verdict |
|---|---|---|
| Sum(5 non-gated queues) <= 9; judge <= 1 | Constants `SUMMED_LLM_WORKER_SLOT_CAP = 9`, `FLAG_GATED_LLM_WORKER_SLOT_CAP = 1` (`startup-assert.ts:115-116`); call-site inventory `worker/index.ts:291-298` lists exactly generate_response(5), generate_demo(1), weekly_summary(1), send_monthly_impact(1), onboarding_demo_response(1) non-gated + judge_verdict flagGated. 5+1+1+1+1 = 9. | PASS |
| Boot with judge flag ON succeeds | judgeVerdictWorker is registered unconditionally (`worker/index.ts:258`) at concurrency 1 (bare `workerOpts`); `flagGated: true` excludes it from the sum and the separate cap is 1 — passes regardless of flag state. | PASS |
| Per-process worker-slot semantics + demo fan-out carve-out documented | Doc comment `startup-assert.ts:118-135` states single-replica scope and the ≤15-review `Promise.allSettled` sanctioned unguarded lane verbatim. | PASS |
| assertSingleConcurrencyWorker semantics unchanged | Not touched; zernioBackfill gets a comment only (`worker/index.ts:200-203`) saying "pacing cap, not a guarded single-consumer invariant — deliberately NOT assertSingleConcurrencyWorker". Matches non_goal exactly. | PASS |
| migrations-log updated in same change | `.claude/reference/migrations-log.md` head 081→082, next 083, full 082 entry with non-atomicity + recovery + staging-first lockstep. | PASS |
| Partial predicate-scoped indexes, 018 style; invalid-index recovery documented | Migration header documents CONCURRENTLY non-transactional apply, non-atomic two statements, 062 `IF NOT EXISTS`-skips-INVALID lesson, and the `indisvalid` check + `DROP INDEX CONCURRENTLY` + re-run recovery. | PASS |

### edge_cases

| Edge case | Evidence | Verdict |
|---|---|---|
| Judge flag ON at boot | Covered above; also pinned by test "passes a flag-gated entry at 1 alongside a non-gated sum of 9". | PASS |
| Effective-opts drift | Call site passes `responseGenWorker.opts` etc. (the EFFECTIVE BullMQ `worker.opts`, same pattern as `assertSingleConcurrencyWorker` at `worker/index.ts:312`), not the literal options objects — replacing an options object still feeds the assert the constructed worker's opts. Drift test present. | PASS |
| CONCURRENTLY vs plain resolved from the log | Plan resolved to CONCURRENTLY per the 065 precedent; migration + log entry both document non-transactional apply. | PASS |
| poller_cursors.cursor .gitignore | `.gitignore:95-97` adds the entry with a why-comment (table is authoritative, migration 081). | PASS |
| Interrupted CONCURRENTLY build | Header recovery procedure + integration test asserts `indisvalid` AND `indisready`. | PASS |

### tests_to_add — bodies read, all meaningful

`worker/config/__tests__/startup-assertion.test.ts:894-954` (new `describe`):

- **Cap-9 boundary**: `nonGatedAtNine` = 5 + four 1s with *mixed* explicit
  (`concurrency: 5`, `concurrency: 1`) and bare `{}` opts — exactly the intake
  shape — `not.toThrow()`. Sum-10 case appends a sixth bare queue and asserts
  the throw message names queues, sum 10, and cap 9
  (`/generate_response.*extra_llm_queue.*10.*9/` — verified against the actual
  message format `...(generate_response=5, ..., extra_llm_queue=1) total 10,
  exceeding the worker-slot cap of 9...`).
- **undefined→1**: nine bare `{}` workers pass; a tenth throws `/10.*9/`. Pins
  the `?? 1` default directly.
- **Judge branches**: flag-gated at 1 passes alongside a full non-gated sum of
  9 (proves exclusion from the sum, not just the separate cap); at 2 throws
  `/judge_verdict.*2.*1/`.
- **Drift**: generate_response edited 5→6 throws `/generate_response.*10.*9/`.

Suite verified green: 88/88 in `startup-assertion.test.ts`.

`src/lib/shared/__tests__/migration-082-failover-indexes.integration.test.ts`:
DB-gated via `describeWithDb` (skip-with-warn without `TEST_DATABASE_POOL_URL`),
localhost-only guard copied from the 079 precedent as the intake's
`existing_patterns_to_follow` requires. Per index it asserts existence,
`indisvalid === true`, `indisready === true` (both required by intake), the
partial predicate (`pg_get_expr(indpred, indrelid)` contains
`topic = 'send_notification'` / `status = 'pending_approval'`), and the column
shape + table from `pg_get_indexdef` (`(aggregate_id, created_at DESC)` on
`public.job_outbox`; `(created_at)` on `public.responses`).

### verification_commands

`pnpm typecheck` run clean by this reviewer. `pnpm build` is the implementer's
gate per plan §Verification (not re-run here; typecheck covers the compile
surface of every changed TS file).

## 2. New-code correctness

**`assertSummedLlmWorkerSlots` (`worker/config/startup-assert.ts:141-171`)**

- Off-by-one: `summedSlots > 9` — exactly 9 passes, 10 throws. Correct per
  "cap 9". Flag-gated: `slots > 1` — 1 passes, 2 throws. Correct.
- `flagGated` handling: filtered out of the sum (`!entry.flagGated`), each
  flag-gated entry checked individually. A flag-gated entry with concurrency 2
  throws even when the runtime flag is OFF — strictly tighter than the
  invariant, and correct: the registration itself is what widens the envelope.
- Error messages: inventory string enumerates `queue=slots` for non-gated
  entries, states the actual sum, the cap, and the ADR ~10 semaphore rule.
  Flag-gated message names queue, slots, and cap 1. Both accurate.
- `effectiveSlots = opts.concurrency ?? 1` matches BullMQ's documented default
  and the five bare-`workerOpts` registrations (`workerOpts` at
  `worker/index.ts:187` sets no `concurrency`).

**Call site (`worker/index.ts:291-298`)**

- The six entries are the correct worker variables: `responseGenWorker` (:220,
  concurrency 5), `demoWorker` (:189, bare), `weeklySummaryWorker` (:268,
  bare), `monthlyImpactWorker` (:272, bare), `onboardingDemoWorker` (:284,
  bare), `judgeVerdictWorker` (:258, bare, `flagGated: true`).
- All six pass `worker.opts` — the EFFECTIVE constructed options, same as the
  existing `assertSingleConcurrencyWorker` call at :312.
- Placement: after the last of the six registrations (onboardingDemoWorker,
  :284) and at module scope, so it runs during boot before the coordinator
  resumes workers (`autorun: false` is irrelevant to `.opts`, as the existing
  comment at :185 already records).
- Inventory completeness cross-checked: `runLlmTask` callers are
  `generator.ts` (→ generate_response, generate_demo via
  `src/lib/demos/generate-responses.ts:47`, onboarding_demo_response),
  `review-summary.ts` (→ weekly_summary, send_monthly_impact), `judge.ts`
  (→ judge_verdict), `triage.ts` (shares generate_response slots per the
  pre-existing comment). No LLM-calling queue is missing from the list. The
  "#490 missed generate_demo" maintenance comment is present at :290.

**Migration 082 vs the actual poller queries
(`worker/background/pollers/NotificationFailoverPoller.ts`)**

- `idx_jo_send_notification_by_aggregate (aggregate_id, created_at DESC)
  WHERE topic = 'send_notification'`: serves the correlation lookup at :119-125
  (`topic = 'send_notification' AND aggregate_id = $1 ORDER BY created_at DESC
  LIMIT 1` — `QUEUE_NAMES.SEND_NOTIFICATION` is the literal
  `'send_notification'`, `src/lib/shared/queue-names.ts:16`) and the three
  topic+aggregate_id EXISTS/idempotency probes at :179, :237, :291. Predicate
  and column order/direction match the query exactly; 018-mirror claim checked
  against `idx_jo_generate_response_by_review` — same shape.
- `idx_responses_pending_approval_created (created_at)
  WHERE status = 'pending_approval'`: serves both sweeps (:165-166 and
  :281-282: `status = 'pending_approval' AND created_at < NOW() - INTERVAL
  '4 hours' ORDER BY created_at ASC`). Partial predicate matches; `created_at`
  serves both the range filter and the ASC sort.
- Index names in the migration, its recovery SQL, the log entry, and the
  integration test are identical (no drift among the four).

## 3. Scope drift

All 14 changed files fall inside `allowed_edit_surface` (checked one-by-one
against the stat list; the migration test filename matches the
`migration-082*.integration.test.ts` glob; `.feature/intake.json` and the two
plan-dir files are covered by `.feature/**` / `docs/superpowers/plans/**`).
The only behavior-bearing changes are the two named user_visible_behavior
items; the zernioBackfill and responseGen comment edits are comment-only, as
the non_goals require. No concurrency VALUE changed; no
`accounts(subscription_status, id)` index; no Redis semaphore; review-doc
bodies untouched under dated banners.

## 4. ADR 0005 amendment vs CONTEXT.md vs code

- ADR amendment (2026-07-20): inventory 5+1+1+1+1 = **9**, enforced by
  `assertSummedLlmWorkerSlots` with cap 9, judge flag-gated at 1, ~10 trigger
  unchanged.
- CONTEXT.md glossary: renamed to "Summed LLM worker-slot cap", ≤9
  boot-enforced, judge capped 1 outside the sum, worker-slots-not-provider-calls
  clarification with the ≤15-review fan-out carve-out, ~10 trigger retained,
  dated correction note naming the #490 miss.
- Code: constants 9 and 1; error messages cite the ~10 rule.
All three agree; the correction banners in the two feat-stripe review docs
match TRIAGE.md's renumber record (081, d93a62e8 drop).

## Findings table

No findings.

## Low-confidence appendix (not findings; <80% confidence, no action required)

1. **Predicate "exact"-ness via `toContain`** — the integration test checks the
   predicate with `toContain("topic = 'send_notification'")` rather than
   strict equality against `pg_get_expr` output (`(topic =
   'send_notification'::text)`). A hypothetical future predicate with an extra
   AND clause would still pass. Same looseness exists in the 079 precedent the
   intake mandates following, and the migration is in the same branch, so the
   practical risk is nil.
2. **Duplicated localhost-guard boilerplate** — `assertLocalMigrationDatabaseUrl`
   / `afterLocalMigrationDatabaseGuard` are copied verbatim from the 079 test.
   Third copy would justify extracting into the shared helpers; standards
   territory, not spec.
3. **Flag-gated cap applies even with the flag OFF** — registering
   judge_verdict at concurrency 2 fails boot regardless of
   `LLM_JUDGE_ENABLED`. This is stricter than the literal invariant wording
   but is the safer reading and consistent with the amendment; noted only for
   completeness.
4. **`indisready` not asserted by the 079 precedent** — the 082 test goes
   beyond its stated precedent (which asserts existence/shape only) to satisfy
   the intake's explicit indisvalid+indisready requirement; intentional, not
   drift.

---
## Triage (orchestrator, 2026-07-20)
- No findings — accepted as clean. Low-confidence appendix reviewed, none promoted.
