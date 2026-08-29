# ADR 0023 — The Refusal Log surfaces a category, never a reason

## Status

Accepted — 2026-08-29. Records the decisions locked while building the
**Refusal Log** (`src/lib/refusals/`, `/dashboard/analytics/restraint`).
Terms: `CONTEXT.md` → **Refusal**, **Refusal category**, **Refusal source**,
**Restraint tab**. Plan: `docs/superpowers/plans/feat-refusal-log-plan.md`.

Adds no migration. Migration 116 was reserved and stayed unused: every reason
the log renders was already persisted by the lane that decided it.

## Context

RepWorth's product claim has two halves — "we answer your reviews" and "we
never post something you would regret." The dashboard showed the first. The
second was invisible: reasons existed in six tables and the owner saw almost
none of them. In one case the hiding was active rather than passive — a held
draft is **subtracted** from the owner's pending count
(`src/lib/dashboard/pending-count.ts:18,46`), so a draft we refused to send
simply vanished from a number the owner watches.

Two of those tables are admin-only by design, and their reason columns can
quote unsafe generated text.

## Decisions

### 1. A category crosses the boundary; a reason never does

`flagged_responses` keeps deny-all RLS. No policy is added. The read reaches it
only through the RLS-bypassing `postgres` role, scoped in the application layer
(invariant #8), and `flagged_responses.reason` is **never selected** — not
projected, not filtered on, not logged.

The owner sees the **category** (`unsafe_content`) plus the subject (which
review), and can follow a link to it. They never see the draft text, the review
text, or the moderation reason.

The precedent is `src/components/dashboard/timeline/step-facts.ts`: a per-key
allowlist with a closed `allowed` set, so what may cross is enumerated rather
than what may not.

### 2. A judge verdict is not a refusal

The Judge runs on **already-posted** replies:
`src/lib/responses/judge-policy.ts:9` ("a customer-review reply that has
already been posted"), `judge-store.ts:115` (`WHERE r.status = 'posted'`),
`worker/jobs/judge/context.ts:65`.

A verdict is therefore a post-publication observation, not something RepWorth
chose not to do. Counting one would be false on a screen whose only value is
being trustworthy, and it would double-count: a judge flag triggers an autonomy
suspension, which *is* a refusal and is already counted through S4.

`judge_verdicts` was in the original brief's source table. It was dropped after
the timing was checked. Its deny-all RLS is untouched.

### 3. Two axes, not one flat enum

A flat enum over every source reaches ~40 members and the screen becomes a
lookup table. Instead:

- **Axis A** — `RefusalCategory`, seven members, closed, precedence order, on
  the `WITHHOLD_REASONS` model (`src/lib/solicitation/restraint-policy.ts:45`).
  This is what the owner reads.
- **Axis B** — `RefusalSource`, the lane plus the verbatim code. **Per-lane, not
  global**, because one code means different things in different lanes.

`admin_halt` and `platform_halt` are why the split is per-lane rather than a
convenience. `latchHalt` copies a batch's halt reason through to every cancelled
Outreach row, so those codes appear in two lanes. On `batch_halted` they map to
`autonomy_paused`; on `outreach_withheld` they map to `null`. A global map would
report one halt once at the batch and again per recipient.

### 4. `null` is a decision, never an omission

Every source code maps to a category **or to explicit `null`** with a one-line
reason. 42 codes: 25 to a category, 17 to `null`.

The test uses `Object.hasOwn`, not truthiness, so a member nobody decided about
fails rather than silently reading as "not a refusal". Four vocabularies are
compile-guarded by `satisfies Record<SourceEnum, RefusalCategory | null>`. Two —
the batch halt list and the outreach disposition list — have no TypeScript
owner: their authority is the migration 111 CHECK, so a test parses
`supabase/migrations/111_platform_halt_reason.sql` rather than forking the enum
into TypeScript where it would drift.

`refusalCategoryFor` **throws** on an unrecognised code. A default would file an
unmapped refusal under a plausible-looking heading, and the owner could not tell
the difference.

## Two limits, stated rather than papered over

### The highest-volume refusal cannot be explained

`AutoApprovalBlockReason` — 22 members at
`worker/jobs/response-generation/auto-approval.ts:37` — is the per-review answer
to "we drafted a reply and did not auto-post it, why". It reaches only a
`logger.log` call at `persist.ts:570-576`. The `policy_gate` run-spine step
records `decision: 'held_for_owner'` with no reason.

**So the Refusal Log reports THAT a draft was held for the owner, never WHY.**

This partially falsifies the premise the feature was scoped on — "RepWorth does
not discard refusal reasons". It holds for the seven sources shipped. It does
not hold for this one, which is probably the most common refusal in the system.

Closing it needs a capture change: either a `block_reasons` key on the existing
`policy_gate` step detail (no migration — `agent_run_steps.detail` is JSONB and
`step_key` has no CHECK), or a column. Both were deliberately out of scope; the
owner chose to ship the available sources and record the gap. Whoever closes it
should know it only fills forward from deploy.

### One timestamp can still drift

`solicitation_outreach` has no disposition timestamp, and its withheld arm has
**two writers** with two different correct answers:

| Reason | Writer | Anchor |
|---|---|---|
| `moderation_high`, `render_failed`, `lint_failed` | `ask-generation.ts` inserts the row already withheld | `rendered_at` — `NOT NULL`, never updated |
| the other five | `dispatch.ts` `commitWithhold`, which sets `agent_run_id` atomically | `COALESCE(agent_runs.started_at, updated_at)` |

The partition is exactly `RenderWithholdReason`
(`src/lib/solicitation/outreach.ts:525`), so the split is the shape of the data
rather than a special case. Neither anchor is correct alone: `rendered_at`
predates the dispatch half, and `run.started_at` is the batch parent's start for
the render half.

`updated_at` is a general mutation timestamp a later write can move. It survives
only as the fallback for a dispatch-time withhold whose best-effort lazy-child
attach left `agent_run_id` NULL. **Such a row can still drift between windows.**
Closing that needs a column, which this ADR's no-migration decision excludes.

## Consequences

- The owner gets a durable record of restraint. A competitor copies a feature in
  a weekend; a two-year record of principled refusals is a time series, not a
  function.
- The two admin-only tables stay admin-only. Widening either is a separate
  decision requiring its own ADR.
- The log **under-reports the reply lane** until the capture gap above is
  closed. Any claim made from its counts must be read with that in mind.
- Adding a member to `WithholdReason`, `AutoPolicyDowngradeReason`,
  `AutonomySuspensionTrigger` or `RenderWithholdReason` breaks the build until
  it is mapped. Adding one to the migration 111 CHECK breaks a test. Both are
  intentional: an unmapped refusal is a refusal nobody decided about.

## Alternatives rejected

- **One flat ~40-member enum.** Maximum fidelity, but the owner reads 40 strings
  and the screen becomes a lookup table.
- **Category only, source dropped.** Zero leak surface, but nobody can debug
  which gate fired and admin support loses the drill-down.
- **Widening `flagged_responses` RLS.** Would let the owner read moderation prose
  that can quote unsafe generated text. The whole point of the hold is that the
  text should not be shown.
- **Six independently scoped queries.** Collapsed into one `UNION ALL`: one scan
  plan, one sort, one place the tenant predicates live. The trade is that a
  structural assertion over the combined SQL cannot prove any single arm is
  scoped, so **every arm carries its own behavioural negative-row test**.
