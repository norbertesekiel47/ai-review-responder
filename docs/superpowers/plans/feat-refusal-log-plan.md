# Refusal Log — implementation plan (rev 2)

Branch: `feat/refusal-log` · Intake: `docs/superpowers/plans/feat-refusal-log-intake.json`
Worktree base: `75a1f436` (parent `5ab6bfee`, the squash merge of #993) · RISK = high · SURFACE = mixed · `db_touching: false`

**rev 2** folds plan-review round 1 (`docs/reviews/feat-refusal-log/plan-review-r1.md`,
VERDICT: REVISE, 24 findings). Changes: `judge_verdicts` dropped, autonomy
suspension re-sourced, S6 timestamp corrected, S7 added, six queries collapsed
to one `UNION ALL`, ADR renumbered 0023, eval grown 32 → 65 titles. Deviations:
`docs/superpowers/plans/feat-refusal-log-deviations.md` D1–D5.

## 1. What this builds

One closed refusal vocabulary over reasons RepWorth **already records**, one
tenant-scoped owner-safe read, and one Restraint tab at
`/dashboard/analytics/restraint`.

No migration. Migration 116 stays unused.

## 2. Verified source inventory

| Source | Table | Account key | Location key | Timestamp | Owner-safe today |
|---|---|---|---|---|---|
| S1 Held draft | `flagged_responses` (051) | `account_id` | `business_id` | `created_at` | No — deny-all RLS |
| S3 Auto-post revoked | `approval_audit_log` (001 → 002 → 034) | `account_id` | `business_id` | `created_at` | Yes (RLS 035 §1f), never rendered |
| S4 Autonomy suspended | `account_audit_log` (034), `event_type='autonomy_suspended'` | `account_id` | none — account-wide | `created_at` | Yes (RLS 035 §1g), never rendered |
| S5 Ask withheld at build | `solicitation_asks` (088) | `account_id` | `business_id` | `decided_at` | Yes, on `/dashboard/requests` |
| S6 Outreach withheld at send | `solicitation_outreach` (091 → 108 → 109 → 110 → 111), **withheld arm only** | `account_id` | `business_id` | reason-dependent — see below | Partly |
| S7 Batch halted by us | `solicitation_batches` (088 → 091 → 111) | `account_id` | `business_id` | `halted_at` | Partly |

Only S1 is deny-all. Everything else already has an owner SELECT policy or an
owner surface — the work there is rendering, not access.

### Three corrections that rev 1 got wrong

**`judge_verdicts` is NOT a source.** The judge runs on already-posted replies:
`src/lib/responses/judge-policy.ts:9`, `src/lib/responses/judge-store.ts:115`
(`WHERE r.status = 'posted'`), `worker/jobs/judge/context.ts:65`. A verdict is
a post-publication observation. Counting it as a refusal would be false and
would double-count the autonomy suspension a flag triggers.

**S4 is `account_audit_log`, not `auto_approval_policies`.**
`unsuspendAccountAutonomy` sets `suspended_at = NULL, suspended_reason = NULL`
(`src/lib/auto-approval/suspension.ts:352-354`), so a lifted suspension leaves
no trace on the policy row. `suspendAccountAutonomy` writes a durable audit row
carrying the `AutonomySuspensionTrigger` in `payload`
(`suspension.ts:309-313`). `suspended_reason` is owner-facing prose the
codebase deliberately does not machine-parse; the trigger enum is the machine
fact.

**S6's anchor is reason-dependent, because the withheld arm has two writers.**
Plan review round 3 found the single-anchor fix wrong. The arm partitions
exactly on `RenderWithholdReason` (`src/lib/solicitation/outreach.ts:525`), an
already-exported closed union — so the split is the truth of the data, not a
special case:

| Reason | Writer | Anchor |
|---|---|---|
| `moderation_high`, `render_failed`, `lint_failed` | `ask-generation.ts` INSERTs the row already withheld at render time | `rendered_at` — it IS the refusal time, `NOT NULL`, never updated |
| `no_consent`, `suppressed`, `unsubscribed`, `no_postal_address`, `postal_address_mismatch` | `dispatch.ts` `commitWithhold` (1371-1379), which sets `agent_run_id` in the same statement | `COALESCE(run.started_at, updated_at)` |

```sql
CASE WHEN o.disposition_reason = ANY(${RENDER_WITHHOLD_REASONS})
     THEN o.rendered_at
     ELSE COALESCE(run.started_at, o.updated_at)
END
```

`agent_runs.started_at` (071:25) is `DEFAULT NOW()` with no updater, so it is
durable. `updated_at` is a general mutation timestamp a later write can move,
and it now survives ONLY for a dispatch-time withhold whose best-effort lazy
child attach left `agent_run_id` NULL. **That residual drift is an accepted
limit** — the alternative is inventing a column, which the intake excludes.

`rendered_at` is wrong for the dispatch half (it predates the refusal) and
`run.started_at` is wrong for the render half (it is the batch parent's start,
not this row's decision). Neither anchor is correct alone. That is the defect
round 3 caught.

**The `agent_runs` join is scoped on both sides.** Migration 091's composite FK
already prevents a cross-tenant match, but the every-join invariant is not
conditioned on a constraint happening to exist.

**S6 reads the WITHHELD arm only.** The cancelled arm is out of scope entirely.
`latchHalt` writes a batch's halt reason through to every cancelled outreach
row, so counting the cancelled arm's `admin_halt`/`platform_halt` copies would
report one batch halt once through S7 and again per outreach row. Those copies
map to `null` explicitly and the eval pins it.

### The gap this feature cannot close

`AutoApprovalBlockReason` — 22 members at
`worker/jobs/response-generation/auto-approval.ts:37` — is the per-review answer
to "we drafted a reply and did not auto-post it, why". `persist.ts:570-576`
emits it through `logger.log` only. The `policy_gate` run-spine step records
`decision: 'held_for_owner'` and no reason.

So the Refusal Log reports **that** a draft was held for the owner, never
**why**. This is likely the highest-volume refusal in the system. Closing it
needs a capture change, which the intake excludes. ADR 0023 and `CONTEXT.md`
own this statement — it must be written down, not left implicit.

## 3. Vocabulary — the whole decision

Two axes.

**Axis A — `RefusalCategory`.** Closed, 7 members, precedence order. Modelled on
`WITHHOLD_REASONS` (`src/lib/solicitation/restraint-policy.ts:45`).

```ts
export const REFUSAL_CATEGORIES = [
  'unsafe_content',        // We would not say that.
  'watchdog_unavailable',  // We could not check it, so we did not post.
  'below_our_bar',         // The reply was not good enough.
  'no_permission',         // They did not agree to be contacted.
  'wrong_moment',          // It was not the right time to ask.
  'autonomy_paused',       // We are not acting on your behalf right now.
  'missing_information',   // We did not have what we needed.
] as const;
```

Feeders after the corrections:

| Category | Source codes |
|---|---|
| `unsafe_content` | S1 (high severity), S6 `moderation_high` |
| `watchdog_unavailable` | S3 `judge_disabled`, `judge_unhealthy`, `notice_undelivered` |
| `below_our_bar` | S6 `render_failed`, `lint_failed` |
| `no_permission` | S5 `no_consent`, `suppressed`; S6 `no_consent`, `suppressed`, `unsubscribed` |
| `wrong_moment` | S5 `already_reviewed`, `stale_visit`, `over_contacted` |
| `autonomy_paused` | S3 `auto_approval_disabled`, `autopilot_entitlement_lost`, `policy_suspended`; S4 all 4 triggers; S7 `admin_halt`, `platform_halt` |
| `missing_information` | S6 `no_postal_address`, `postal_address_mismatch` |

**Axis B — `RefusalSource`.** The lane plus the verbatim source code. For S1 the
code stays server-side.

**Exhaustiveness.** Every source enum maps under
`satisfies Record<SourceEnum, RefusalCategory | null>`. `null` is the explicit
decision "not a refusal", never an omission. That mechanism covers
`WithholdReason`, `AutoPolicyDowngradeReason`, `AutonomySuspensionTrigger` and
the batch halt list. **It does not cover S6**: the authoritative withheld
vocabulary lives only in the migration 111 CHECK (`111:92-96`) and is
fragmented across partial TypeScript unions. S6's map is guarded by a test that
parses that CHECK instead.

Mapped to `null`: `velocity_banked`; the four owner acts; the four delivery
failures; `superseded`; `send_indeterminate`; and the cancelled-arm
`admin_halt`/`platform_halt` outreach copies, which S7 already counts once at
the batch.

## 4. Modules and seams

| Module | Interface | Deep? |
|---|---|---|
| `src/lib/refusals/vocabulary.ts` (NEW) | one enum, one lookup, one label map | Yes — ~30 codes behind one enum |
| `src/lib/refusals/read.ts` (NEW) | `getRefusalLog(sql, scope, window)` | Yes — one `UNION ALL`, 2 scope modes, redaction, exclusions behind 3 params |
| `src/app/api/dashboard/refusals/route.ts` (NEW) | HTTP GET | Orchestration only (#12) |
| `src/components/dashboard/restraint/` (NEW) | one `RefusalLog` prop | Pure presentation, like `BatchReport` |

**One `UNION ALL`, not six queries** (review finding 24). One arm per accepted
source projecting the same safe column set, one final sort, one place the
tenant predicates live. Simpler and safer than six independently scoped reads.

**No interface widens.** One rename: `AgentTeamScope` → `DashboardReadScope`
(`src/lib/agents/read.ts:194,426` — two references, both in that file). Both
owner reads then share one scope vocabulary instead of growing a second.

## 5. Precedents to follow

- `src/lib/agents/read.ts:424-451` `getAgentTeamSummary` — scope discriminant, window handling, aggregate/location branch.
- `src/app/api/dashboard/agent-team/route.ts` — `withDashboardOwnerRead`, `resolveDashboardRequest`, `resolveDashboardLocation`. Copy almost verbatim.
- `src/components/dashboard/timeline/step-facts.ts` — owner-safe projection by per-key allowlist with a closed `allowed` set.
- `src/app/(authenticated)/dashboard/requests/BatchReport.tsx:29-38` — `REASON_META` keyed `Record<ClosedEnum, Meta>`.
- `src/components/dashboard/reviews/ReviewsTabs.tsx` — routed tabs, plain `Link`.
- `src/lib/kpi/types.ts` — `DASHBOARD_WINDOWS`, `dashboardWindowParams`.
- `src/app/(authenticated)/dashboard/requests/requests.css` — colocated route stylesheet.

## 6. Tasks (tracer bullets)

### T0 — Eval task (runs alone, first)
Author all 65 `tests_to_add` titles as **failing** tests. Slices not yet
buildable use `.todo`. No implementation.
Blocks: everything.

### T1 — Vocabulary (runs alone)
`src/lib/refusals/vocabulary.ts`. Add four LOCKED terms to `CONTEXT.md`:
**Refusal**, **Refusal category**, **Refusal source**, **Restraint tab** — and
state the `AutoApprovalBlockReason` limit under **Refusal**.
Green: the 10 vocabulary tests.
Edges: T0. Blocks: T2, T3, T4, T7.

### T2 — Scope rename + first UNION arm
Rename `AgentTeamScope` → `DashboardReadScope`. Add `src/lib/refusals/read.ts`
with the `UNION ALL` skeleton carrying **S5 only**, both scope modes.
Green: the S5 scoping tests, empty result, ordering, the three window-boundary
tests, `velocity_banked` exclusion, the two invariant tests (#12/#15).
Edges: T0, T1.

### T3 — The two hidden and audit sources
Add S1 and S3 arms. S1 selects **no** `reason` column and joins `reviews` with
the tenant predicate repeated on the join, not only on the root row — both
tables carry independent FKs (051:15), so a scoped root can still reach a
foreign review.
Green: the 5 redaction tests, the 2 cross-tenant join tests, per-source tenant
tests, held-draft and downgrade presence, dropped-review, double-downgrade.
Edges: T2.

### T4 — The three account and solicitation sources
Add S4, S6 and S7 arms.

- **S4 is account-wide.** It appears in every location scope. Join nothing to
  `businesses` — an account-wide arm joined through locations multiplies one
  audit row by the location count. The eval pins exactly-once in both scopes.
- **S6 is the withheld arm only**, with the reason-dependent anchor in §2. The
  `LEFT JOIN agent_runs` is scoped on `account_id` and `business_id` like every
  other join, not left to migration 091's composite FK.
- **S7** reads `admin_halt` and `platform_halt` only.
- **Per-arm tenant proof.** One `UNION ALL` means a structural assertion over
  the combined SQL cannot prove any single arm is scoped. Every arm gets its own
  behavioural foreign-account or foreign-location negative-row test.

Green: the 2 S4 exactly-once tests, the 2 S4 scope tests, the lifted-suspension
test, the 3 S6 anchor tests, the S6/S7 foreign-location tests, presence tests
for S4/S6/S7, the 5 exclusion tests, the migration-111 exhaustiveness test.
Edges: T3 (same file).

### T5 — The route
`src/app/api/dashboard/refusals/route.ts`, copied from `agent-team/route.ts`.
Green: the 5 route tests, including the impersonation test.
Edges: T4.

### T6 — Tab bar and route shell *(may run parallel with T3)*
**Invoke the `repworth-brand-design` skill first — Console system.**
`AnalyticsTabs.tsx`, mounted in both analytics views with a literal `active`
prop. New route `…/analytics/restraint/page.tsx`.
**Constraint (review finding 23): the page shell renders the loading branch
only.** It must import neither T5 nor T7, or the T0-only edge is false.
Green: the tab-bar current-route test.
Edges: T0. Disjoint files from T3.

### T7 — The Restraint screen
`src/components/dashboard/restraint/` + `restraint.css`. Fed by one
`RefusalLog` object so the total and the breakdown cannot disagree.
Green: the 12 screen and page tests.
Edges: T1, T5, T6.

### T8 — Docs sweep
`docs/directory.md` rows for both new `src/lib/refusals/` files. ADR
`docs/adr/0023-refusal-log-owner-safe-projection.md` recording: the
do-not-widen-RLS decision, the two-axis vocabulary, why `judge_verdicts` is not
a refusal, and the `AutoApprovalBlockReason` limit.
Edges: T7.

## 7. Risks

1. **Redaction is the whole security story for S1.** It is deny-all RLS, read
   through the RLS-bypassing `postgres` role; application scoping is the only
   guard (#8). The five redaction tests assert the **absence** of the column
   from the SQL, from the response at any depth, from the error path, and from
   the logs — not merely that a label looks right.
2. **Every join is scoped on both sides.** S1 and S3 carry independent FKs, not
   tenant-composite keys.
3. **S4 has no location key.** An account-wide suspension appears in every
   location scope. That is correct, and the eval pins it so a later
   "optimisation" cannot quietly drop it.
4. **The log under-reports the reply lane.** See §2's gap. State it, do not
   paper over it.
5. **Diff-coverage gate.** `--review` enforces 80% on changed lines. The
   category maps are data, not branches; the label test exercises every
   category.
