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
