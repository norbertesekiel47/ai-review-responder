# Plan review round 2 — verification only

Reviewer: `codex exec`, read-only, 124,877 tokens.
Transcript: `.feature/logs/codex-plan-review-r2.log` (4,273 lines).
Under review: plan rev 2 @ `94f93c19`. Pre-dispatch: `PREVALIDATE: PASS`.

**VERDICT: REVISE** — 23 of 24 round-1 findings ADDRESSED, 1 NOT ADDRESSED,
4 new defects introduced by the round-1 fixes.

Round 2's remit is exactly this: verify the fixes and flag what they broke. It
opened no new fronts against unchanged sections, and returned no
`NEW — UNTRIAGED` items.

## Round 1 verification

23 ADDRESSED. One outstanding:

| # | Status | Fix applied in rev 3 |
|---|---|---|
| 21 | NOT ADDRESSED — S6 still cited `091 → 110 → 111`, omitting 108 and 109 | Citation now `091 → 108 → 109 → 110 → 111`, the constraint's full lineage. |

## Job 2 — defects the fixes introduced

| Sev | Defect | Verdict |
|---|---|---|
| P0 | Collapsing six queries into one `UNION ALL` made per-arm tenant isolation unprovable. A structural assertion over the combined SQL passes if predicates exist *anywhere*. Concrete negative-row tests covered S1, S3, S4, S5 — not S6 or S7. | **ACCEPT.** The invariant now states that a structural assertion cannot prove per-arm scoping, and every arm carries its own behavioural negative-row test. Two titles added for S6 and S7. |
| P1 | Migration 111 places `admin_halt` and `platform_halt` on **cancelled** `solicitation_outreach` rows too. `latchHalt` writes a batch's halt reason through to every cancelled row, so counting them would report one batch halt once via S7 and again per outreach row. | **ACCEPT — VERIFIED** against `111:97-100`. S6 is now explicitly the **withheld arm only**; the cancelled-arm copies map to `null`; two titles pin it. |
| P1 | `updated_at` is a general mutation timestamp, not a durable refusal time. A later write can drag an old withheld row into a newer window. | **ACCEPT — VERIFIED, with a better anchor found.** `commitWithhold` sets `agent_run_id` in the same statement (`dispatch.ts:1371-1379`), and `agent_runs.started_at` (071:25) is `DEFAULT NOW()` with no updater. Anchor is now `COALESCE(run.started_at, updated_at)`; `updated_at` survives only as the fallback for the best-effort attach path that leaves `agent_run_id` NULL (`dispatch.ts:1284`). Three titles pin the anchor, the fallback, and immunity to a later mutation. |
| P1 | S4 has no exactly-once test. Account-wide semantics are right and cross-tenant exposure is prevented, but an implementation joining the account-wide arm through every business would multiply one audit row by the location count. | **ACCEPT.** T4 now forbids joining S4 to `businesses`. Two titles pin exactly-once in both scopes. |

The reviewer also confirmed dropping `judge_verdicts` leaves no orphan:
`below_our_bar` stays fed by S6 `render_failed` and `lint_failed`, and all four
removed judge titles are genuinely dead.

## Net effect

Eval: 65 → 73 titles, no duplicates. `allowed_edit_surface` unchanged at 21
entries — **no second amendment**, so the abort budget stays at 1 of 2.
`estimated_test_lines` 1800 → 2000.
