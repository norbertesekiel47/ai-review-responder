# Deviations — feat/refusal-log

Every entry is something the plan or intake did not anticipate. Each carries a
verdict: ACCEPT (the adaptation is sound) or RE-PLAN (it invalidates a locked
decision).

## D1 — Surface amendment 1 of 2: ADR renumber

`docs/adr/0022-refusal-log-owner-safe-projection.md` →
`docs/adr/0023-refusal-log-owner-safe-projection.md`.

Plan review finding 20. `0022-solicitation-rate-cap-not-yield.md` already
exists at this HEAD; 0023 is the next free number. Same directory, same file
count — a corrected path, not a widening. Both intake copies updated.

**Counts as amendment 1 of 2.** One remains before the abort criteria bite.

Verdict: **ACCEPT**.

## D2 — Test retitles and additions (not an amendment)

`tests_to_add` went from 32 titles to 65. Retitles and additions are recorded
here as owner-approved deviations, never as surface amendments — the /feature
abort budget counts only `allowed_edit_surface` changes.

Four titles were **removed** because `judge_verdicts` left scope (see D3):
- `every JUDGE_REASON_CATEGORIES member maps to a RefusalCategory`
- `getRefusalLog omits judge_verdicts.rationale from every returned entry`
- `getRefusalLog excludes a judge verdict with verdict error`
- `getRefusalLog parses judge reasons delivered as a JSON string`

One was **retitled** to resolve plan-review finding 10, where the plan said
excluded codes map to `null` and the eval said they are absent from the map:
- was: `excluded source codes are absent from the mapping`
- now: `every excluded source code maps explicitly to null`

The remaining 37 additions come from plan-review findings 1–9 and 14–19. Every
one closes a case where all prior tests pass and the shipped feature is still
wrong.

Verdict: **ACCEPT**.

## D3 — Source inventory changed after the plan review

The owner approved a six-source mapping table before the review. Four sources
moved. Each change was verified against the code independently, not accepted on
the reviewer's word. The owner re-approved D3a and D3c on 2026-08-29.

**D3a — `judge_verdicts` DROPPED.** The judge runs on already-posted replies:
`judge-policy.ts:9` ("a customer-review reply that has already been posted"),
`judge-store.ts:115` (`WHERE r.status = 'posted'`), `judge/context.ts:65`
(gates on `status === 'posted' && approval_method === 'auto_policy'`). A verdict
is a post-publication observation, not a refusal. Counting it would be false and
would double-count the autonomy suspension a flag triggers.

**D3b — autonomy suspension RE-SOURCED** from
`auto_approval_policies.suspended_at/.suspended_reason` to `account_audit_log`
(`event_type = 'autonomy_suspended'`, `suspension.ts:309-313`). `unsuspend`
sets both policy columns to NULL (`suspension.ts:352-354`), so the approved
behaviour "a lifted suspension still appears" is impossible from the policy
row. `account_audit_log` is durable, carries the trigger in `payload`, and has
an owner SELECT policy (migration 035 §1g). It is `account_id`-keyed with a
nullable `location_id`; the suspension writer sets no location, so a suspension
is account-wide and appears in every location scope. That is correct — a
suspended account default applies to every location.

**D3c — `AutoApprovalBlockReason` is UNAVAILABLE, and it is the highest-volume
refusal.** 22 members at `worker/jobs/response-generation/auto-approval.ts:37`.
`persist.ts:570-576` emits them through `logger.log` only. The `policy_gate`
run-spine step records `decision: 'held_for_owner'` with no reason. So the
Refusal Log can report THAT a draft was held for the owner, never WHY. The
owner chose to ship the seven available sources and record the limit rather
than add a capture layer. ADR 0023 and CONTEXT.md own that statement.

This partially falsifies the brief's key finding, "RepWorth does NOT discard
refusal reasons". It holds for seven sources. It does not hold for this one.

**D3d — `solicitation_batches` ADDED as S7.** Plan §2 promised `admin_halt`
and `platform_halt` and gave them no source row, no query, no task and no test.

Verdict: **ACCEPT** for all four. None invalidates a locked decision — D3a and
D3c were put to the owner and re-approved; D3b and D3d are corrections that
make an already-approved behaviour reachable.

## D4 — Six queries became one `UNION ALL`

Plan review finding 24. One arm per accepted source, safe columns only, one
sort, one place the tenant predicates live. Simpler than six independently
scoped reads and it moots the pool-fanout concern the plan raised in §7.3.

Verdict: **ACCEPT**.

## D5 — Stale HEAD citation in the plan

Plan §2 cited HEAD `2f4497a9`. That was the pre-squash tip of
`feat/console-dashboard-density`; it is neither current nor ancestral to the
worktree base `75a1f436` (parent `5ab6bfee`, the squash merge of #993).
Pre-validation passed because it resolves the SHA, and `2f4497a9` still exists
in the object store. Corrected to `5ab6bfee`.

Verdict: **ACCEPT**.

## D6 — Four things T0 found that the plan did not anticipate

All four are paperwork or task-brief errors. None touches
`allowed_edit_surface`, so none counts against the amendment budget, and none
changes a locked decision.

**D6a — there is no vitest project named `unit`.** The T0 brief's definition of
done says
`pnpm vitest run src/lib/refusals src/components/dashboard/restraint --project unit`.
`vitest.config.ts` defines exactly two projects, `parallel` and `integration`;
`--project unit` matches nothing and the run reports zero test files, which
reads as "no tests written". The command actually run, and the one later tasks
should use, drops the flag (both projects then run, which is what is wanted —
`read.integration.test.ts` lives under the same path and is in the
`integration` project):

```
REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm vitest run \
  src/lib/refusals src/components/dashboard/restraint \
  src/components/dashboard/analytics/__tests__/AnalyticsTabs.test.tsx \
  src/app/api/dashboard/__tests__/refusals-route.test.ts
```

Result at T0: **73 tests — 3 failed, 70 todo, 0 passed.** Nothing green, so
nothing vacuous.

**D6b — the eval is 73 titles, and plan §6 still says 65.** The intake's
`tests_to_add` array holds 73 entries (`jq '.tests_to_add | length'`). Plan §6
T0 and the rev-2 header both say 65, and D2 above says "32 titles to 65". The
gate reads the intake, not the plan, so 73 is the operative number; the plan's
prose is stale. The plan's rev-3 commit (`5672a959`) also left its own H1
reading "rev 2". Doc-only drift, recorded rather than fixed here because T0
does not own `feat-refusal-log-plan.md`.

**D6c — plan §6 T3 cannot turn "the 5 redaction tests" green.** Three of the
five are ROUTE cases — `the refusals route serializes no flagged reason at any
depth`, `… returns no flagged reason on an error path`, `… logs no flagged
reason` — and the route is T5's file. T3 can green only the two read-layer
redaction cases. The dependency edge is right (T3 → T4 → T5); only the green
list is misattributed. Corrected allocation: T3 greens 2 redaction cases, T5
greens 3.

**D6d — the T0 brief's per-file title counts are each off by one.** It asks for
"the 10 vocabulary/mapping titles + the 2 cancelled-arm null titles" in
`vocabulary.test.ts`, but the eval contains exactly ONE cancelled-arm mapping
title (`the cancelled-arm admin_halt and platform_halt outreach copies map
explicitly to null`); the other cancelled-arm title (`getRefusalLog excludes the
cancelled arm of solicitation_outreach entirely`) is a `getRefusalLog`
behavioural case and was filed with the live-DB suite. It also asks for "the 13
tab/page titles" in `RestraintContent.test.tsx` plus "the tab-bar title"
separately; there are 12 tab/page titles and 1 tab-bar title — 13 in total
across the two component files. Placement is cosmetic (the `promised-tests` row
greps `src`, `worker` and `scripts` as a whole), so the split was made on
subject: pure mapping in `vocabulary.test.ts`, anything calling `getRefusalLog`
in the live-DB suite.

Verdict: **ACCEPT** — all four are corrections to prose, not to the build.

## D7 — Round-3 anchor delta to the eval (not an amendment)

Plan review round 3 landed after T0 was already dispatched against the 73-title
eval, so this delta is owed. Titles are deviations entries, never surface
amendments; the surface stays at 21 entries and the budget at 1 of 2.

- **ADD** `getRefusalLog anchors a render-time outreach refusal on rendered_at`
- **RETITLE** `getRefusalLog does not move a withheld outreach entry when the row is mutated later`
  → `getRefusalLog does not move a render-time or run-anchored outreach entry when the row is mutated later`

Reason: the withheld arm has TWO writers. `ask-generation.ts` INSERTs a row
already withheld at render time (`render_failed`, `lint_failed`,
`moderation_high`) where `rendered_at` IS the refusal time; `dispatch.ts`
`commitWithhold` writes the other five and sets `agent_run_id` atomically. The
single anchor from D-round-2 was wrong for the render half. Full record:
`docs/reviews/feat-refusal-log/plan-review-r3.md`.

Eval is now **74 titles**. T1 adds these two to
`src/lib/refusals/__tests__/read.integration.test.ts` as `.todo`.

Verdict: **ACCEPT**.

## D6 verdicts (orchestrator triage)

- **D6a** (`--project unit` does not exist) — **ACCEPT.** My T0 brief was wrong;
  `vitest.config.ts` defines `parallel` and `integration`. Later task briefs use
  the corrected command. Verified independently: 73 tests, 3 failed, 70 todo,
  0 passed.
- **D6b** (plan §6 said 65) — **ACCEPT, fixed in rev 4.** Plan prose now says 74
  and states that the intake is the operative count.
- **D6c** (T3's green list claimed 3 route redaction tests) — **ACCEPT, fixed in
  rev 4.** T3 greens 2 read-layer cases; T5 greens the 3 route cases. The
  dependency edges were already right.
- **D6d** (per-file counts off by one) — **ACCEPT, no action.** A brief-writing
  slip, not a plan defect. T0's filing decision was correct: `getRefusalLog
  excludes the cancelled arm of solicitation_outreach entirely` is behavioural
  and belongs in the live-DB suite.
