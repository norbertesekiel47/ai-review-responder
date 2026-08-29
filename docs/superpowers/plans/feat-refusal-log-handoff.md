# Handoff — feat/refusal-log

A resumed session bootstraps from this file. It never needs the prior
transcript. Read the referenced paths; do not restate them here.

## Where we are

Step 3 (plan) is CLOSED. Step 4 (execute) is in progress: **T0 landed, T1 is
dispatched.** `.feature/state.json` is authoritative for phase and counters.

| Artifact | Path |
|---|---|
| Intake (audit copy) | `docs/superpowers/plans/feat-refusal-log-intake.json` |
| Intake (arming copy, gitignored) | `.feature/intake.json` — kept byte-identical |
| Plan, **rev 4 (locked)** | `docs/superpowers/plans/feat-refusal-log-plan.md` |
| Deviations D1–D7 | `docs/superpowers/plans/feat-refusal-log-deviations.md` |
| Plan reviews r1/r2/r3 + triage | `docs/reviews/feat-refusal-log/plan-review-r{1,2,3}.md` |
| Review transcripts | `.feature/logs/codex-plan-review-r*.log` |

Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-refusal-log`
Base: `75a1f436`, parent `5ab6bfee` (squash merge of #993). Enforcement ARMED.

## Decisions the owner locked — do not reopen

1. Two-axis vocabulary: `RefusalCategory` (7, closed, precedence order) + `RefusalSource`.
2. Routed tab at `/dashboard/analytics/restraint`, following `ReviewsTabs` — not `useState`.
3. Redaction: category plus subject, never reason text, never draft text.
4. `admin_halt`/`platform_halt` in, folded into `autonomy_paused`. `velocity_banked`, owner acts, delivery failures out.
5. `DASHBOARD_WINDOWS` (`7d`/`30d`/`90d`/`12w`), default `30d`.
6. Links only, no writes.
7. `judge_verdicts` dropped — post-publication (D3a).
8. `AutoApprovalBlockReason` gap documented, not captured (D3c).

## Task state

| Task | State | Notes |
|---|---|---|
| T0 eval | **DONE** `508b8a76` | 73 titles, 3 failed / 70 todo / 0 passed. Spot check PASSED. |
| T1 vocabulary | **IN FLIGHT** | `vocabulary.ts`, `CONTEXT.md` 4 terms, D7 title delta, greens `vocabulary.test.ts`. |
| T2 scope rename + S5 arm | blocked on T1 | |
| T3 S1 + S3 arms | blocked on T2 | |
| T4 S4 + S6 + S7 arms | blocked on T3 (same file) | |
| T5 route | blocked on T4 | |
| T6 tab bar + route shell | blocked on T0 only; may run parallel with T3 | Page shell renders the LOADING branch only — it must import neither T5 nor T7, or its T0-only edge is false. Invoke `repworth-brand-design` (Console) first. |
| T7 Restraint screen | blocked on T1, T5, T6 | |
| T8 docs sweep | blocked on T7 | `docs/directory.md` rows + ADR **0023**. |

## Budgets

- **Plan review rounds: 3 of 3 — CLOSED.** Findings converged 24 → 4 → 1. Do not open a fourth.
- **Surface amendments: 1 of 2.** Only D1 (ADR renumber) counted. A second triggers the abort criteria.
- **Branch review rounds: 0 of 3** (step 7 has not started).
- Eval: **74 titles**. The intake is the operative count; plan prose is not.

## Known gate condition — do not "fix" it

`feature-surface` FAILS until every surface entry matches a real file. After T0
six remain: `vocabulary.ts` (T1), `read.ts` (T2), the route (T5), `page.tsx`,
`restraint.css`, `AnalyticsTabs.tsx` (T6). It is a push-time audit and its own
message names the pre-implementation case.

**Do NOT narrow the surface to force it green** — that spends the second
amendment on bookkeeping and trips the abort criteria. Every other check
passes. The local test DB is provisioned to head (`115_qr_scan_analytics_event.sql`).

## Traps a resumed session will otherwise hit

- **There is no vitest project named `unit`** (D6a). Projects are `parallel` and `integration`. Use:
  `REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm vitest run src/lib/refusals src/components/dashboard/restraint src/components/dashboard/analytics/__tests__/AnalyticsTabs.test.tsx src/app/api/dashboard/__tests__/refusals-route.test.ts`
- **Never start the gate while a subagent is in flight.** A subagent returning mid-gate moves HEAD under the evidence and the Stop hook then refuses finished work.
- **S6's anchor is reason-dependent** (D7, plan §2). `rendered_at` for the three `RenderWithholdReason` codes; `COALESCE(run.started_at, updated_at)` for the other five. Neither is correct alone.
- **S4 must not join `businesses`.** An account-wide arm joined through locations multiplies one audit row by the location count.
- **One `UNION ALL` means structural SQL assertions cannot prove per-arm scoping.** Every arm needs its own behavioural negative-row test.
- After each subagent, run the spot check: `git diff --name-only <prev>..HEAD` against `allowed_edit_surface`.
