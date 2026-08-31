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
| Lane | RISK = high, SURFACE = backend — **rides `staging` before `main`** |
| Phase | **`reviewed`** — steps 0–7.5 complete |
| HEAD | `3ba1103f`, tree clean |
| Gate | **GREEN at that SHA**, 31/31, three live-DB suites genuinely executed |
| Promised tests | **29**, all present verbatim and all active |
| Deviations | **26**, all ACCEPT, rows and sections agree |
| Surface amendments | **2 of 2 — SPENT.** A third triggers the abort criteria |
| Gate-fail rounds | 1 of 3 |
| Reviews | plan ×3, branch ×1 (three axes), red team ×3 |

## What remains — step 8 only

Nothing local. Every remaining action is external and needs owner approval:

1. Push the branch.
2. **Ride `staging` first** — push deploys the full stack. **No migration applies**: 116 is already in staging AND production.
3. Smoke on staging: trigger an autonomy suspension; confirm exactly one `refusal_events` row with `business_id IS NULL`; confirm `occurred_at` equals the `account_audit_log` row's `created_at` when both are read `::text`. Then flip `REFUSAL_LEDGER_ENABLED=false` (invoke `flag-flip`), suspend again, confirm the suspension still lands with no ledger row and one warning. Flip back.
4. Draft PR → `main` (draft PRs run no CI), then `gh pr ready`.
5. CI green, then **PAUSE for owner merge approval**.

## The artifacts, by path

| What | Where |
|---|---|
| Intake (audit copy) | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-intake.json` |
| Intake (arming copy) | `.feature/intake.json` — **must stay byte-identical**; verify with `cmp` |
| Plan | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-plan.md` |
| Deviations (26) | `docs/superpowers/plans/feat-1009-refusal-ledger-write-path-deviations.md` |
| Branch review + triage | `docs/reviews/feat-1009-refusal-ledger-write-path/` |
| Red team (rounds 1–3) | `docs/reviews/red-team/feat-1009-refusal-ledger-write-path-29ea70/` |
| Machine state | `.feature/state.json` |

## THE OPEN ITEM — read this before running the checker

`node .agents/skills/feature/scripts/red-team-status.mjs` **returns FAILED**, on
exactly one ground: `round must be 1 or 2 (hard cap)` (`:253`).

**This is expected and owner-authorized.** Every other check passes — forcing
`round: 2` in memory yields zero shape errors, recomputed counts that match, and
a recomputed status of `CLEAR`. Round 3 was attestation-only, and it was needed
because the owner-authorized RT-8 fix voided round 2's own evidence.

**Do not "fix" it by editing the sidecar's round number.** The attesting agent
declined to, and was right: falsifying a round count is the defect class this
run caught nine times. Full record: deviations **D26** and the
`arch-review-log.md` row.

The tooling gap — an owner-authorized late fix is currently unshippable — is
filed as a workflow issue, NOT this branch's to fix.

## Upstream decisions this run must not re-litigate

All CLOSED. `CONTEXT.md` → "Refusal ledger" holds the four LOCKED terms.

| Decision | Owner |
|---|---|
| Seven lanes, eight categories, sixteen columns, five CHECKs | #1001, #998, #1003 |
| Slice order — helper + kill switch + `autonomy_suspended` is slice 2 | #1004 |
| `occurredAt: Date \| 'transaction_time'`, required | #1006 |
| 180 days from `occurred_at`; retention is a code constant | #996 |
| No backfill, ever | #1002 |
| `all_refusal_codes` never owner-facing | ADR 0023 |
| `feat/refusal-log` is PARKED and never merges | owner, 2026-08-29 |

## What THIS run decided

- **D16 SETTLED: the first Refusal write site lands in #1009.** Plan §0 carries
  the evidence and the full sweep inventory. Ten sites remain across #1010–#1013.
- **The input type is a per-lane union** — reversing the plan's own rejection,
  owner-ratified. Plan §1, deviations D19.
- **RT-1 accepted-risk**, owner-authorized: neither Sentry signal is routed, the
  gap is pre-existing and documented, both tags are on the runbook's pending list.

## Traps a resumed session must not rediscover the hard way

1. **Export BOTH `TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL`** before any
   test run. Without the first, live-DB suites **silently skip and report green
   having executed nothing** (D14). Without the second, `DATABASE_POOL_URL`
   points at the **live Supabase pooler** (D15).
2. **Migration 116 is immutable** — applied to production, guarded.
3. **`NOW()` is `transaction_timestamp()`** — measured, plan §2.2b. The sentinel
   is the sanctioned per-lane exception to 116's own "no `NOW()`" warning.
4. **The ledger INSERT is not caught; the Sentry warning is.** Facts propagate,
   observations swallow.
5. **`captureMessage` returns on queue, not delivery**, and swallows transport
   failures. The log line is the durable signal (D20).
6. **No `.todo`/`.skip`/`.fails`** — the gate greps titles only. Test 26 guards
   it at module scope.
7. **After changing a documented fact, grep it everywhere and RE-GREP after
   fixing.** Nine instances of that class in this run (D23, D25).
