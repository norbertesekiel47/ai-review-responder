# Deviations — feat/owner-operator-run-a

Entries are things the plan or the workflow did not anticipate. Each entry
gets a one-line **Verdict:** (ACCEPT or RE-PLAN) at the step-6 read-back.

## 2026-09-11 — `grill-with-docs` skill absent from this machine

The `/feature` command's step 1 names the `grill-with-docs` skill and says to
read `~/.claude/skills/grill-with-docs/SKILL.md` if it is not model-invocable.
Neither the directory nor the file exists (`~/.claude/skills/` holds
`grill-me-codex` and `grilling` only). The run is the TICKET-SEEDED variant, so
the grill covered only the three deltas the owner named plus one map-level
constraint the code surfaced (the LLM worker-slot cap), all four resolved by
`AskUserQuestion` and recorded in the intake. The glossary context file was
written in the plan phase instead of during the interview.

**Verdict:** ACCEPT — the ticket-seeded delta grill needs no interview script; the decisions and the glossary are on disk.

## 2026-09-11 — baseline gate RED on `feature-surface` before T0

A `verify-gate.sh --baseline` run at the plan phase (HEAD f747cb7b6, docs-only
mode) passed every row except `feature-surface`: 13 `allowed_edit_surface`
entries name files that T0–T6 create and that do not exist yet
(`ci:feature-surface` fails on an entry that matches nothing). This is the
documented pre-implementation state (#867), not a defect. The row clears once
T0 lands the scaffold files.

**Verdict:** ACCEPT — expected before implementation; re-verified at the first post-T0 gate.

## 2026-09-11 — Codex round-3 appendix: flag-off helper ordering (T5 instruction)

The plan-skeptic's final round APPROVED the plan and left one untriaged note:
`failTurnAndCompleteOutbox` (plan T5 Step 10) fails the turn BEFORE the outbox
ownership CAS and ignores a false CAS result. T5's implementer applies the
opposite order inside the same transaction: `markOutboxCompletedIfOwned(tx, …)`
first; only when it returns true call `failTurnIfNonTerminal(tx, …)`; when it
returns false, write nothing (a newer dispatch owns the row). The flag-off unit
test (title 22) asserts the CAS runs first and that a false CAS leaves the turn
untouched.

**Verdict:** ACCEPT — an ordering fix inside one transaction; no contract change.
