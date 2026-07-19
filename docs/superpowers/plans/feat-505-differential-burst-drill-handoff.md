# Handoff — feat-505-differential-burst-drill

A resumed session bootstraps from THIS doc → the referenced files (below) →
nothing else. The prior transcript is not needed. All state is on disk.

## What this is

Ticket-seeded `/feature` run for the two open **#505** remainders on wayfinder
map **#472** (PR #506 already merged the cure). Two deliverables:
(a) a checked-in **health-bundle differential** proving the Promise.all-vs-sequential
pooler wedge; (b) a synthetic-load script + **capacity-burst drill** executed on
staging with recorded numbers. Remainder 2 (24h soak) is **#507**, out of scope.

## Read these (by path — do not restate)

| Need | File |
|---|---|
| Locked scope / drift detector | `.feature/intake.json` |
| Tracer-task plan (T1–T5, blocking edges) | `docs/superpowers/plans/feat-505-differential-burst-drill.md` |
| Env adaptation + spike + codex triage | `docs/superpowers/plans/feat-505-differential-burst-drill-deviations.md` (D0 enforcement, D1 OutboxPoller spike, D2 codex round-1 triage) |
| Shared domain language (use verbatim) | `CONTEXT.md` (Connection wedge, Backlog depth [alert threshold]; T4 coins Health-bundle differential + Capacity-burst drill) |
| Parent obligation | GitHub issue **#505** obligation-status comment |

## Environment / enforcement (CRITICAL — see D0)

- Session cwd can't be pinned to the worktree (sandbox resets it to the parent;
  `$CLAUDE_PROJECT_DIR` = parent). Hooks anchor on the **parent** `.feature/`.
- Bridge in place: parent `.feature/gate-status.json` is a **symlink** →
  worktree `.feature/gate-status.json`. `scripts/verify-gate.sh` runs IN THE
  WORKTREE and populates it; the parent-anchored Stop hook reads it through the
  symlink. ARM CHECK passed + confirmed live (D0).
- **All edits target the worktree** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-505-differential-burst-drill/…`.
  Inspect the parent with `git -C <parent>` / absolute reads; never `cd` away
  expecting it to stick.
- **Teardown ordering:** do NOT remove the worktree until after the final green
  stop (or first delete the parent `.feature/intake.json`) — else the symlink
  dangles and the Stop hook blocks.

## Current step

**Step 3 (PLAN) COMPLETE — plan SIGNED OFF by the user.** Codex ran the full
3-round cap: R1 `REVISE` (D2, `fb33fdc7`), R2 `REVISE` (D3, `aa754354`), R3
`REVISE` — R3 surfaced the ADR-0007 blocker (Supavisor flattens `application_name`)
which the user resolved by choosing the **ephemeral-branch** design (**D5**,
`<branch-redesign commit>`). All substantive findings folded in; only non-gating
polish remains (fold in during the build — see below). User signed off.

### Build status (steps 4–5 DONE)

- **T1** `c49d92b7` — `scripts/staging-guard.ts` (2 modes) + `wedge-repro.ts` rewired; guard tests migrated → `staging-guard.test.ts` (15).
- **T2** `5d45942c` — `scripts/health-bundle-differential.ts` (ephemeral-branch, 4-way detection, terminate-all cleanup, replicated config) + 33 tests.
- **T3** `78ce9eac` — `scripts/burst-drill-load.ts` (inject/release, frozen 4-clause scoped-delete, HARD-FAIL inventory) + 34 tests.
- **T4** `a43ad6bd` — runbooks reconciled (two-arm drill + differential procedure + evidence-based #507 gate + Results stubs), CONTEXT.md glossary, lab-notes pointer.
- **Step 5 VERIFY GATE: GREEN** — lint+typecheck+full test(8895)+all ci:* audits+3 new test files. `gate-status.json passed:true`, read by the parent Stop hook via the symlink.
- **Step 6** (adversarial approach, RISK=high): skipped as redundant (approach got 3 full codex rounds at plan stage); user may still run `/codex:adversarial-review`.

### Immediate next actions (in order)

0. **Step 7 dual review COMPLETE + triaged (D6).** Spec+correctness: faithful, all high-risk areas correct. Standards: clean. 3 findings accepted + fixed in `2b58db10` (config-resolver single-owner export from checks.ts [user-approved surface amendment]; headroom-arm false-fail inventory/hint; D1 overclaim); low-confidence appendix notes rejected with reasons. Gate re-run green after the fix.
1. **Step 8 SHIP (RISK=high lane):** the CODE (T1–T4) is inert tooling → normal PR to `main` (4 CI checks green). The staging EXECUTION (T5) is post-#507-soak: differential on an ephemeral branch (create→run→delete), burst drill on shared staging behind the evidence-based #507-PASS+clean-baseline gate; record numbers in the runbook Results sections + comment on #505. Then #505 remainders 1&3 are closed (remainder 2 = the #507 soak).
2. **Post-merge:** `git pull --ff-only` main; ff `staging` onto main; remove the sibling worktree (see teardown ordering below); `document-feature` sweep; `domain-modeling` fold-in; increment the merge counter in `.claude/reference/arch-review-log.md`.

--- (superseded detail below) ---

1. **Step 4 (EXECUTE) — IN PROGRESS.** `superpowers:subagent-driven-development`:
   fresh per-task subagents in blocking-edge order **T1 → {T2, T3} → T4**. Each
   subagent gets its plan slice (from the plan doc) + the relevant D-notes + the
   CONTEXT.md glossary excerpt + "ALL edits target the worktree root
   `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-505-differential-burst-drill/…`".
   TDD the pure helpers; commit per task. Non-gating polish to fold in: exact
   `40_000`ms constant + documented observer cadence; scrub stale "ingest events"/
   "kill children" wording; correct the "mirror-sync worker never fails" overclaim
   (its own test proves transient DB errors can reject it).
4. **Step 5 VERIFY GATE**: `scripts/verify-gate.sh` (in the worktree) → green
   `.feature/gate-status.json` (read by the Stop hook via the symlink).
5. **Step 6 REVIEW 0 (RISK=high)**: pause, ask the user to run
   `/codex:adversarial-review` on the branch.
6. **Step 7 REVIEW**: two parallel agents (spec+correctness / standards) on the diff.
7. **Step 8 SHIP**: normal PR to `main` for the CODE (T1–T4, inert tooling); the
   staging drill **execution (T5)** happens post-#507-soak (~2026-07-20 07:00 UTC)
   — record numbers, comment on #505.

## Task graph

```
T1 extract staging-guard.ts (positive allowlist) + rewire wedge-repro
 ├── T2 health-bundle-differential.ts (resolution-based detection, force-close cleanup)
 └── T3 burst-drill-load.ts (inject/release, hardened scoped-delete)
        └── T4 docs reconciliation + glossary
               └── T5 EXECUTE on staging (post-soak) + record numbers
```

## Guardrails (from intake — the drift detector)

- `allowed_edit_surface`: `scripts/{health-bundle-differential,burst-drill-load,staging-guard}.ts`,
  `scripts/wedge-repro.ts`, `scripts/ci/__tests__/**`, the two runbooks,
  `CONTEXT.md`, `docs/adr/**`, `.claude/reference/lab-notes.md`,
  `docs/superpowers/plans/**`, `.feature/**`. **`worker/**` is NOT in scope** —
  the differential IMPORTS the exported checks; touching worker runtime = stop +
  re-plan.
- No new dependency; no `package.json`/`pnpm-lock` change; `db_touching=false`.
- Property tests not required (no billing/approval/escalation state machine).
