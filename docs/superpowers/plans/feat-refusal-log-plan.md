# Refusal Log — implementation plan

Branch: `feat/refusal-log` · Intake: `docs/superpowers/plans/feat-refusal-log-intake.json`
Base: `main` @ `75a1f436` · RISK = high · SURFACE = mixed · `db_touching: false`

## 1. What this builds

One closed refusal vocabulary over reasons RepWorth **already records**, one
tenant-scoped owner-safe read, and one Restraint tab at
`/dashboard/analytics/restraint`.

No migration. Migration 116 stays unused. Every reason below is already
persisted with `account_id` and a location key.

## 2. Verified source inventory (HEAD `2f4497a9`)

| Source | Table | Location key | Timestamp | Owner-safe today |
|---|---|---|---|---|
| S1 Held draft | `flagged_responses` (051) | `business_id` | `created_at` | No — deny-all RLS |
| S2 Judge verdict | `judge_verdicts` (076) | `business_id` | `created_at` | No — deny-all RLS |
| S3 Auto-post revoked | `approval_audit_log` (001/034) | `business_id` | `created_at` | Yes (RLS 035 §1f), never rendered |
| S4 Autonomy suspended | `auto_approval_policies` (055/074) | `location_id` (NULL = account default) | `suspended_at` | Yes, on `/settings/auto-approval` |
| S5 Ask withheld at build | `solicitation_asks` (088) | `business_id` | `decided_at` | Yes, on `/dashboard/requests` |
| S6 Outreach withheld at send | `solicitation_outreach` (091/110/111) | `business_id` | `rendered_at` | Partly |

S6 has **no disposition timestamp**. A withheld row was rendered and then
withheld, so `rendered_at` is the anchor. Pin this; do not invent a column.

`solicitation_batches.halt_reason` contributes only `admin_halt` and
`platform_halt` (S4's category). The four owner/expiry reasons are excluded.

## 3. Vocabulary — the whole decision

Two axes, per the locked design review.

**Axis A — `RefusalCategory`.** Closed, 7 members, precedence order. This is
what the owner reads. Modelled on `WITHHOLD_REASONS`
(`src/lib/solicitation/restraint-policy.ts:45`).

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

**Axis B — `RefusalSource`.** The lane plus the verbatim source code. For S1
and S2 the code stays server-side and never enters a returned object.

**Exhaustiveness is the enforcement.** Every existing enum maps in under
`satisfies Record<SourceEnum, RefusalCategory | null>`, so adding a member to
`WITHHOLD_REASONS`, `AutoPolicyDowngradeReason`, `JUDGE_REASON_CATEGORIES`,
`AutonomySuspensionTrigger`, or the outreach disposition list breaks the build
until it is mapped. `null` is the explicit "not a refusal" value — it is a
mapping decision, not an omission.

Excluded, each mapped to `null` with a one-line reason:
`velocity_banked` (volume shaping — `BatchReport.tsx:27`), the four owner acts,
the four delivery failures, judge verdict `error`.

## 4. Modules and seams

| Module | Interface | Deep? |
|---|---|---|
| `src/lib/refusals/vocabulary.ts` (NEW) | one enum, one lookup, one label map | Yes — ~30 source codes behind one enum |
| `src/lib/refusals/read.ts` (NEW) | `getRefusalLog(sql, scope, window)` | Yes — 6 queries, 2 scope modes, redaction, exclusions behind 3 params |
| `src/app/api/dashboard/refusals/route.ts` (NEW) | HTTP GET | Orchestration only (#12) |
| `src/components/dashboard/restraint/` (NEW) | one `RefusalLog` prop | Pure presentation, like `BatchReport` |

**No interface widens.** One rename: `AgentTeamScope` → `DashboardReadScope`
(`src/lib/agents/read.ts:194,426` — two references, both in that file, no
external caller). Both owner reads then share one scope vocabulary instead of
growing a second. `getRefusalLog` takes the same `(sql, scope, window)` shape
as `getAgentTeamSummary`, so a caller who knows one knows the other.

**Deletion test.** Delete `vocabulary.ts` and the mapping reappears in the read
module, the screen, and every test. It earns its keep.

## 5. Precedents to follow

- `src/lib/agents/read.ts:424-451` `getAgentTeamSummary` — scope discriminant, window handling, aggregate/location branch. Copy this shape.
- `src/app/api/dashboard/agent-team/route.ts` — `withDashboardOwnerRead`, `resolveDashboardRequest`, `resolveDashboardLocation`. Copy this route almost verbatim.
- `src/components/dashboard/timeline/step-facts.ts` — owner-safe projection by per-key allowlist with a closed `allowed` set. This is the redaction pattern.
- `src/app/(authenticated)/dashboard/requests/BatchReport.tsx:29-38` — `REASON_META` keyed `Record<ClosedEnum, Meta>`. This is the label pattern.
- `src/components/dashboard/reviews/ReviewsTabs.tsx` — routed tabs, plain `Link`, each route owns its data.
- `src/lib/kpi/types.ts` — `DASHBOARD_WINDOWS`, `dashboardWindowParams`.
- `src/app/(authenticated)/dashboard/requests/requests.css` — colocated route stylesheet.

## 6. Tasks (tracer bullets)

Each task is a vertical slice. Each names the failing tests it turns green.
Blocking edges are listed; unlisted tasks are independent.

### T0 — Eval task (runs alone, first)
Author all 32 `tests_to_add` titles from the intake as **failing** tests.
Slices not yet buildable use `.todo`. No implementation.
Files: `src/lib/refusals/__tests__/`, `src/app/api/dashboard/__tests__/`,
`src/components/dashboard/restraint/__tests__/`,
`src/components/dashboard/analytics/__tests__/`.
Blocks: everything.

### T1 — Vocabulary (runs alone)
Build `src/lib/refusals/vocabulary.ts`. Add the four LOCKED terms to
`CONTEXT.md`: **Refusal**, **Refusal category**, **Refusal source**,
**Restraint tab**.
Green: the 8 vocabulary tests (5 exhaustiveness, exclusions absent, precedence
order, label + link coverage).
Blocks: T2, T3, T4, T7. Edges: T0.

### T2 — Scope rename + first source, end to end
Rename `AgentTeamScope` → `DashboardReadScope` (2 edits in
`src/lib/agents/read.ts`). Add `src/lib/refusals/read.ts` with `getRefusalLog`
covering **S5 only** (`solicitation_asks`) in both scope modes.
Green: the 4 tenant-scoping tests, the empty-result test, the window-boundary
test, the `velocity_banked` exclusion test.
Edges: T0, T1.

### T3 — The four hidden sources
Add S1, S2, S3, S4 to `getRefusalLog`. S1/S2 select **no** reason text column.
S4 in location scope must include the account-default row (`location_id IS
NULL`) as well as the location override — a suspended account default applies
to every location.
Green: the 2 redaction tests, the judge-`error` exclusion, the owner-halt and
delivery-failure exclusions, the dropped-review test, the JSONB-string parse
test, the double-downgrade test.
Edges: T2.

### T4 — Outreach dispositions
Add S6, anchored on `rendered_at`, withheld arm only.
Green: the `missing_information` mapping test.
Edges: T3 (same file).

### T5 — The route
`src/app/api/dashboard/refusals/route.ts`, copied from `agent-team/route.ts`.
Green: the 3 route tests (unauthenticated, foreign location, window clamp).
Edges: T4.

### T6 — Tab bar and route shell *(may run parallel with T3)*
**Invoke the `repworth-brand-design` skill first — Console system.**
`src/components/dashboard/analytics/AnalyticsTabs.tsx`, mounted in
`AnalyticsAggregateView` and `AnalyticsPerLocationView` with a literal `active`
prop. New route `src/app/(authenticated)/dashboard/analytics/restraint/page.tsx`.
Green: the tab-bar current-route test.
Edges: T0. Disjoint files from T3.

### T7 — The Restraint screen
`src/components/dashboard/restraint/` + `restraint.css`. Fed by one
`RefusalLog` object so the total and the breakdown cannot disagree. Links only,
no writes: held draft → the review; autonomy paused → `/settings/auto-approval`;
no permission → contacts. No link for the other four categories.
Green: the 6 screen tests.
Edges: T1, T5, T6.

### T8 — Docs sweep
`docs/directory.md` rows for the two new `src/lib/refusals/` files
(`ci:directory-map` fails without them). ADR
`docs/adr/0022-refusal-log-owner-safe-projection.md` recording the
do-not-widen-RLS decision and the two-axis vocabulary.
Edges: T7.

## 7. Risks

1. **Redaction is the whole security story.** S1 and S2 are deny-all RLS and are
   read through the RLS-bypassing `postgres` role. Application scoping is the
   only guard (#8). T3's two redaction tests must assert the **absence** of the
   columns in the returned object, not merely that a label looks right.
2. **S4 has no history.** `suspended_at` is one mutable column. The screen must
   not imply an event log. State the limit in the ADR.
3. **Six queries per request.** `ci:pool-fanout` fails a `Promise` combinator
   over ≥2 DB-issuing elements in `src/lib/{admin,dashboard,locations}`.
   `src/lib/refusals/` is not in that list, but issue the six queries
   **sequentially** anyway — the rule's reason (pool admission, #773) applies
   regardless of the path it audits.
4. **Diff-coverage gate.** `--review` enforces 80% on changed lines. The
   category-to-label maps are data, not branches; keep them out of the
   uncovered-line count by exercising every category in the label test.
