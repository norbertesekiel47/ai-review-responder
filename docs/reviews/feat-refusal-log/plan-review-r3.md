# Plan review round 3 — final, narrow verification

Reviewer: `codex exec`, read-only. Transcript:
`.feature/logs/codex-plan-review-r3.log`.
Under review: plan rev 3 @ `5672a959`. Pre-dispatch: `PREVALIDATE: PASS`.
Brief: the five round-2 fixes only, not another full audit.

**VERDICT: REVISE** — 4 of 5 VERIFIED, 1 STILL DEFECTIVE, 1 new P1 (the same
defect stated as its consequence).

**This is round 3 of 3.** The /feature rule after round 3 is to stop looping and
put any remaining disagreement to the owner. There is no disagreement: the
finding is correct, I verified it against the code myself, and the fix is
recorded below. No fourth round.

## Verification

| Fix | Status | Evidence |
|---|---|---|
| 1. S6 citation `091 → 108 → 109 → 110 → 111` | VERIFIED | All five cumulatively replace `solicitation_outreach_status_reason_consistency`. |
| 2. Per-arm tenant proof | VERIFIED | Concrete negative-row titles now cover S1, S3, S4, S5, S6 and S7. No arm uncovered. |
| 3. Cancelled arm excluded | VERIFIED | `latchHalt` copies batch halt reasons through; every other cancelled reason is an already-excluded owner act, delivery outcome or supersession. Excluding the whole arm loses no intended refusal. |
| 4. S6 durable anchor | **STILL DEFECTIVE** | See below. |
| 5. S4 exactly-once | VERIFIED | The suspension writer omits `locationId`, so one account-wide row with `location_id = NULL`. Forbidding the `businesses` join plus both exactly-once tests is sufficient. |

## The surviving defect (P1) — ACCEPTED and fixed

The round-2 anchor fix assumed every withheld row comes from `commitWithhold`.
It does not. **The withheld arm has two writers**, and I confirmed the partition
directly:

- `src/lib/solicitation/ask-generation.ts:403-425,556-562` INSERTs a row
  **already withheld** at render time with `render_failed`, `lint_failed` or
  `moderation_high`. There is no lazy child; `agent_run_id` points at the batch
  parent, whose `started_at` is the batch's start, not this row's decision.
- `src/lib/solicitation/dispatch.ts:250,1371-1379` `commitWithhold` writes the
  other five reasons and sets `agent_run_id` to a lazy child atomically.

The partition is exactly `RenderWithholdReason`
(`src/lib/solicitation/outreach.ts:525`), an already-exported closed union — so
the `IN` list is a constant, not string literals, and the split is the truth of
the data rather than a special case.

**Fix (plan §2):**

```sql
CASE WHEN o.disposition_reason = ANY(${RENDER_WITHHOLD_REASONS})
     THEN o.rendered_at
     ELSE COALESCE(run.started_at, o.updated_at)
END
```

`rendered_at` is `NOT NULL` and never updated, so the render half is durable.
`agent_runs.started_at` (071:25) is `DEFAULT NOW()` with no updater, so the
dispatch half is durable.

**Accepted residual limit:** `updated_at` now survives only for a dispatch-time
withhold whose best-effort lazy child attach left `agent_run_id` NULL. That row
can still drift. Closing it needs a column, which the intake excludes. Recorded
here and in ADR 0023 rather than papered over.

The reviewer also noted the round-2 plan mis-cited `dispatch.ts:1284` as the
best-effort attach path; it is the defer-step recording comment. Corrected.

## Eval delta owed

T0 was dispatched against the 73-title eval before this round returned, so the
delta lands as **D7** after T0 reports:

- ADD `getRefusalLog anchors a render-time outreach refusal on rendered_at`
- RETITLE `getRefusalLog does not move a withheld outreach entry when the row is mutated later`
  → `getRefusalLog does not move a render-time or run-anchored outreach entry when the row is mutated later`

Titles are deviations entries, never surface amendments. The surface is
unchanged at 21 entries, so the amendment budget stays at **1 of 2**.
