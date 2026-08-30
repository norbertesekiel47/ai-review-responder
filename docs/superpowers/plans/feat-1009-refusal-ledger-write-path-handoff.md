# Handoff — feat/1009-refusal-ledger-write-path

**Resume with:** `/feature-resume feat/1009-refusal-ledger-write-path`

This document REFERENCES. It does not restate. Read the files it names.

---

## Where the run is

| | |
|---|---|
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1009-refusal-ledger-write-path` |
| Branch | `feat/1009-refusal-ledger-write-path`, forked from `origin/main` `0494297a` |
| Ticket | #1009 · map #994 · slice 2 of 7 |
| Lane | RISK = high, SURFACE = backend, SIZE = normal — full pipeline |
| Phase | see `.feature/state.json` (authoritative; this file can go stale) |
| Plan review | 3 of 3 rounds used. **LOCKED** by owner call 2026-08-30 (round-3 stop rule) |
| Surface amendments | **1 of 2 used** — `AutonomyGovernorScheduler.ts` (D2) |
| Gate rounds | 0 |
| Promised tests | **28** |

**The plan is locked. Do not reopen it.** Round 1 REVISE (10 findings, 9
accepted). Round 2 REVISE (4 defects the round-1 fixes introduced). Round 3
REVISE (3 defects, 1 `high`). All corrected. One disagreement was carried to the
owner and decided: **the module-scope eval check, not a new `ci:*` audit
script** — plan §5d.

## The artifacts, by path

| What | Where |
|---|---|
| Locked intake (audit copy) | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-intake.json` |
| Locked intake (arming copy) | `.feature/intake.json` — **must stay byte-identical**; verify with `cmp` |
| Plan | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md` |
| Deviations | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-deviations.md` |
| Plan review r1 | `docs/reviews/feat-1009-refusal-ledger-write-path/plan-review-r1.md` |
| Plan review r2 | `docs/reviews/feat-1009-refusal-ledger-write-path/plan-review-r2.md` |
| Machine state | `.feature/state.json` |

**Codex thread ids** (kept here, not in the plan — the plan pre-validator reads
a bare UUID as a commit SHA and reports it stale forever):

- Plan review round 1: `01a05410-c24a-75d3-beb6-dad6cd01b59e`
- Plan review round 2: see `plan-review-r2.md`'s header

## The upstream decisions this run must not re-litigate

All are CLOSED. Read them; do not reopen them.

| Decision | Owner |
|---|---|
| Seven lanes, eight categories, sixteen columns, five CHECKs | #1001, #998, #1003 · `CONTEXT.md` → "Refusal ledger", four LOCKED terms |
| The slice order — helper + kill switch + `autonomy_suspended` is slice 2 | #1004 |
| `occurredAt: Date \| 'transaction_time'`, required | #1006 |
| 180 days from `occurred_at`; retention is a code constant | #996 |
| No backfill, ever | #1002 |
| `all_refusal_codes` is never owner-facing | ADR 0023 |
| `feat/refusal-log` is PARKED and never merges | owner, 2026-08-29 · map #994 |

## What this run DECIDES, and it is the reason the run exists

**Deviation D16 is settled: the first Refusal write site lands in #1009.**
Full reasoning, evidence and the complete sweep inventory: **plan §0**. Ten
sites remain across #1010–#1013.

Do not re-derive this from artifact counts — that is what failed twice on
#1008. The grounds are #1004's locked slice order and #1009's ticket §5.

## Glossary

`CONTEXT.md` → section "Refusal ledger — locked 2026-08-29, map #994". Four
LOCKED terms: **Refusal**, **Refusal source**, **Refusal category**,
**Restraint tab**. Use them verbatim. Both corrections are already in that file
— seven lanes, eight categories.

## Non-obvious traps, each with its owner

Every one of these is stated in full in the plan. This list exists so a resumed
session knows what to go and read, not so it can skip reading.

1. **The `ON CONFLICT` predicate is re-spelled byte-for-byte and may not be
   parameterised.** Plan §2.1.
2. **`NOW()` is `transaction_timestamp()`** — measured, table in plan §2.2b.
   Migration 116 says "no writer may pass `NOW()`"; the sentinel is the
   sanctioned per-lane exception, and that supersession is recorded in
   `migrations-log.md` by T7, never in the migration file.
3. **Migration 116 is immutable.** Applied to production, guarded. Never edit.
4. **No `.todo`, `.skip` or `.fails` anywhere in this run.** The gate's
   `promised-tests` row greps titles only, so an inert eval passes it. Test 26
   is the guard. Plan §4 T1.
5. **`suspendAccountAutonomy` has two callers with different Sentry routes.**
   Plan §4 T4b. This is why the surface was amended.
6. **The ledger error is NOT caught; the Sentry warning IS.** Plan §3.
7. **Live-DB suites are `*.integration.test.ts` and execute no run-time DDL.**
   Seed with `INSERT`. `ci:live-db-suites`.
8. **#1008 already tests the five CHECKs and both idempotency cases.** Do not
   re-write them. Plan §4 T1, "Deliberately NOT re-tested".

## Execution waves

Plan §5. T1 alone first (enforcement spot check), then T2 ‖ T5 ‖ T7, then T3,
then T4, then T4b ‖ T6.

## Ship order

Plan §7. Staging ride BEFORE `main`, and **no migration applies at promotion** —
116 is already in both projects.
