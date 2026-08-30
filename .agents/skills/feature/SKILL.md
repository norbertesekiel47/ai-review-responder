---
name: feature
description: Run RepWorth's guarded Codex-native feature workflow from intent through a verified, independently reviewed, PR-ready change. Use when the user explicitly invokes `$feature`, asks for the full guarded feature workflow, or requests end-to-end implementation with intake, isolation, verification, and review. Do not auto-trigger for an ordinary scoped edit.
---

# Feature

Treat the user's current request as the feature input. Act as the accountable
root Codex agent: own intent, planning, implementation integration,
verification, review triage, and the final report. Use fresh subagents only for
bounded independent work or independent judgment. Never treat a subagent as the
source of truth or recreate a hierarchy between implementation and review agents.

## Non-negotiable rules

- Read `AGENTS.md`, `.claude/CLAUDE.md`, `CONTEXT.md`, and the closest relevant
  project references before making architectural assumptions.
- Keep checked-in source, tests, Git, and durable feature artifacts authoritative.
  Conversation and subagent summaries are hints.
- Follow existing modules, seams, tests, and naming before inventing new ones.
- Keep the first implementation concrete unless a declared invariant requires a
  seam. Require a named second use before extracting shared machinery.
- Use version-matched bundled documentation or official primary documentation
  for APIs that may have drifted.
- Never widen scope silently. Amend the intake with the user's approval or stop.
- Never claim completion from memory. Require fresh gate evidence whose
  fingerprint matches the current worktree.
- Never let a reviewer edit. The root agent verifies each finding before fixing
  or rejecting it.
- Do not commit, push, deploy, merge, apply remote migrations, or flip remote
  flags unless the user explicitly authorizes that action. Read
  [shipping-boundaries.md](references/shipping-boundaries.md) before any such
  step.

## Durable state and live coordination

Use the Codex task plan for live progress and the worktree for durable state.
The durable artifacts win after compaction or resume:

- `.feature/intake.json` — machine-readable scope and acceptance contract.
- `.feature/state.json` — phase, branch, hashes, and review counters.
- `.feature/gate-status.json` — underlying repository gate result.
- `.feature/gate-heartbeat.json` — present only while a gate run is alive;
  `verify-gate.sh --status` reads it to answer RUNNING / DEAD / last result.
- `.feature/codex-gate-fingerprint.json` — proof that the gate matches the
  current HEAD, intake, staged/unstaged diff, and untracked files.
- `.feature/progress.json` — the step ladder and tracer bullets.
- `.feature/review-transcript.jsonl` — the Claude/Codex review exchange.
- `docs/superpowers/plans/<branch>-intake.json` — committed audit copy when the
  user has authorized a commit.
- The referenced spec, plan, deviations, and accepted review findings.
- `docs/reviews/finding-checklists/<axis>.md` — committed, cross-feature:
  every ACCEPT triage appends here, and future reviews on that axis receive
  the file as input.

Do not create a handoff merely because context is growing. Create one only when
work is actually pausing, moving to another task, or waiting at an authority
boundary.

## Report progress at every phase boundary

The user must never have to ask where the run stands. Read
[progress-and-live-view.md](references/progress-and-live-view.md) before the
first step, then:

- Advance the step ladder as each workflow section below closes. The write
  commands print the block, so a boundary is one command.
- Log every Claude turn and every triage verdict in the review transcript.
  Point the transcript at each Codex job instead of copying its output.
- Start the live view before the first review round. Publish its snapshot as
  an Artifact once the rounds close.

Both surfaces derive from durable state. Never report a phase from memory.

## Workflow

### 0. Orient and classify

Inspect the request and likely code surface. Classify independent axes:

- `size`: `trivial | small | standard | epic`
- `risk`: `normal | high`
- `surface`: `ui | backend | mixed`

Treat worker, webhook, migration/schema, billing, approval/autonomy, auth,
tenant isolation, destructive data, and production-operation changes as high
risk. Read [execution-lanes.md](references/execution-lanes.md) for lane rules,
question budgets, TDD, and delegation.

Open the ladder as soon as the three axes are fixed:

```bash
node .agents/skills/feature/scripts/progress.mjs init --size <size> --risk <risk> --surface <surface>
```

Mark every step the chosen lane does not run as `skipped`, with the lane as
the note. A `trivial` lane skips `armed` and `plan`.

For an epic, produce a domain model and dependency-ordered investigation and
implementation map, then stop. Each implementation ticket must fit a separate
feature run with a tight edit surface.

### 1. Lock intent into an intake

Resolve only choices that materially change behavior, architecture, risk, or
scope. Make reversible local assumptions explicit instead of interrogating the
user about details that source precedent answers.

Read [intake-contract.md](references/intake-contract.md), write the intake, and
validate it before proceeding:

```bash
node .agents/skills/feature/scripts/validate-intake.mjs <intake-path>
```

Require `open_questions` to be empty and obtain user sign-off for `standard` or
`high` work. For ticket-seeded work, inherit locked decisions and ask only
about unresolved deltas.

```bash
node .agents/skills/feature/scripts/progress.mjs step intake done --note "<revision> · signed off"
```

### 2. Isolate and arm

For `small`, `standard`, and `high` work, create the sibling worktree with
`pnpm worktree:new <branch>`. Do not create or switch branches when unrelated
dirty changes make the target ambiguous.

Setup also writes the worktree-scoped autonomy profile
(`.claude/settings.local.json`: acceptEdits + workflow command allowlist) so
execution runs without permission prompts; the shipping boundary still
prompts. `FEATURE_AUTONOMY_PROFILE=off` opts out.

Run the repository setup from the worktree only after warning that the current
repository script creates an intake commit and removes the parent draft. That
commit/removal requires explicit user authorization:

```bash
cd <worktree-root> && bash scripts/feature-setup.sh <approved-intake-path>
```

Require `scripts/arm-check.sh` to report `ARMED`. Prefix every shell command
with an explicit worktree `cd` and use absolute paths for edits. Do not edit the
parent checkout from a feature worktree.

Steps 0 and 1 ran in the parent checkout, so the ladder is still there.
`feature-setup.sh` carries it into the armed worktree mechanically, and
`arm-check.sh` initializes a stub from the intake when no ladder exists at
all — a run can no longer proceed without `.feature/progress.json`. Verify
the carried ladder (or carry it yourself on an older setup script):

```bash
cd <worktree-root> && node .agents/skills/feature/scripts/progress.mjs render
cd <worktree-root> && node .agents/skills/feature/scripts/progress.mjs carry <parent-repo-root>
```

Every later progress, review-log, and live-view command runs from the
worktree. A lane that uses no worktree skips this step instead.

### 3. Plan the change

Use tracer bullets: each task delivers one vertical behavior slice, names its
test seam, declares blocking edges, cites the precedent it follows, and stays
inside `allowed_edit_surface`. When the surface must widen, count the
amendment mechanically — `bash scripts/feature-state.sh incr-amendment` —
which refuses a second amendment without a recorded owner reason. Consult `codebase-design` before introducing or
widening an interface.

Write a plan only for standard/high work. For high-risk work, dispatch one
fresh read-only plan skeptic using [review-prompts.md](references/review-prompts.md),
triage its evidence, and obtain user sign-off. Maximum three plan-review rounds.

Start the live view before the first plan-review round, then log the round:

```bash
node .agents/skills/feature/scripts/live-view.mjs start
node .agents/skills/feature/scripts/review-log.mjs round-start --axis plan-skeptic
node .agents/skills/feature/scripts/review-log.mjs attach-codex --latest --axis plan-skeptic
```

Register the tracer bullets and transition state through the guarded wrapper:

```bash
node .agents/skills/feature/scripts/progress.mjs tracers set "T1 <title>|T2 <title>|..."
node .agents/skills/feature/scripts/progress.mjs step plan done
node .agents/skills/feature/scripts/transition-state.mjs plan_approved
```

### 4. Execute vertical slices

Keep root ownership. Implement trivial/small changes directly. For standard
work, establish the first tracer bullet and its precedent in the root context;
delegate only disjoint later slices when parallelism has concrete value. For
high-risk work, delegation remains optional and bounded.

Give every implementing subagent the exact worktree, allowed files, spec slice,
test seam, blocking context, relevant glossary excerpt, and verification
command. Prevent overlapping edit leases. Subagents do not commit. The root
reviews all diffs and owns integration.

Apply red-green TDD when behavior is specifiable. Use characterization tests
for behavior-preserving refactors. Do not manufacture tests for prose-only or
mechanical configuration changes; require a deterministic verification command
instead.

Move each tracer to `active` when you start it and to `done` when its
evidence is green:

```bash
node .agents/skills/feature/scripts/progress.mjs tracer T3 active
node .agents/skills/feature/scripts/progress.mjs tracer T3 done
```

Record a deviation only when reality invalidates or changes the approved plan.
Do not use a deviations file as a running diary.

### 5. Verify against the exact worktree

Run the skill-local wrapper, not `scripts/verify-gate.sh` directly:

```bash
bash .agents/skills/feature/scripts/verified-gate.sh
```

Before final review, run review mode:

```bash
bash .agents/skills/feature/scripts/verified-gate.sh --review
```

After a RED gate, loop unattended: `bash scripts/gate-summary.sh` (failing
rows + tails only), fix, `bash scripts/feature-state.sh incr-gate-round`,
re-run. The counter refuses round 4 without an owner reason — the gate-fail
abort criterion enforced mechanically; a green gate resets it.

Check on a possibly-running gate with `bash
.agents/skills/feature/scripts/verified-gate.sh --status` (RUNNING / DEAD /
last result — never blocking-wait blind, never launch a second gate over a
RUNNING one). To prove the tree green without advancing the phase, run
`--baseline`.

The wrapper runs the repository gate and writes a content fingerprint. After
any edit, commit, intake change, or generated review artifact, the fingerprint
is stale. Confirm freshness with:

```bash
node .agents/skills/feature/scripts/gate-fingerprint.mjs check
```

Close the gate step only from a green review gate with a current fingerprint:

```bash
node .agents/skills/feature/scripts/progress.mjs step gate done
```

After the same failure class twice, stop patching and use the
`diagnosing-bugs` feedback-loop discipline. After three full failed gate
rounds, a second surface amendment, or a deviation that invalidates intent,
stop and re-plan with the user. Mark the ladder step `blocked` with the reason
as its note before you stop.

### 6. Review proportionally

Read [review-prompts.md](references/review-prompts.md). Review the diff from a
fixed merge-base only after the review gate is green:

Dispatch every required axis in one parallel wave; route mechanical passes
(logging, checklist sweeps, doc greps) to cheaper subagents.

- trivial: one compact root review
- small: one fresh spec/correctness review
- standard: parallel spec/correctness and maintainability reviews
- high: the standard pair plus only the applicable risk axis

Give each reviewer its axis checklist
(`docs/reviews/finding-checklists/<axis>.md`, when it exists) with the
instruction to check the diff against every line — accepted findings from
past branches are the highest-yield defect classes.

Require findings to include a file and line, evidence, and a concrete failure
scenario or named violated standard. Keep speculative advice outside the
actionable table. The root reproduces or verifies each finding, records
`ACCEPT` or `REJECT` with a reason, applies accepted fixes, and reruns the
verified gate.

Log every round in the transcript, one axis per round. A triage verdict that
only exists in conversation is lost at the next compaction. `round-end`
refuses a round with no logged content, and an ACCEPT triage appends the
finding to the axis checklist automatically:

```bash
node .agents/skills/feature/scripts/review-log.mjs round-start --axis spec-correctness
node .agents/skills/feature/scripts/review-log.mjs finding --id F1 --severity high --title "<claim>" --at "<file:line>"
node .agents/skills/feature/scripts/review-log.mjs triage --id F1 --verdict ACCEPT --reason "<evidence>"
node .agents/skills/feature/scripts/review-log.mjs round-end --verdict REVISE
```

Close the review step only when no finding is untriaged. The `reviewed`
transition does NOT happen here — it belongs to section 6.5:

```bash
node .agents/skills/feature/scripts/review-log.mjs render
node .agents/skills/feature/scripts/gate-fingerprint.mjs check
node .agents/skills/feature/scripts/progress.mjs step review done
```

### 6.5 Red-team the finished change

Section 6 asks whether the change is right. This section tries to prove it is
wrong, and it owns the `reviewed` transition so no run can reach review-ready
without an adversarial pass.

Run the `red-team` skill in a fresh subagent. It is a VERIFIER, not a reviewer:
its mutations of production files are the one narrow exception to "never let a
reviewer edit", because they are journaled, finalizer-guarded, and can never
reach a commit. Read `.agents/skills/red-team/SKILL.md` for the protocol.

Order matters — the report commit moves `HEAD`, so it precedes the final gate:

1. Verify the preconditions: clean tree, no process watching the worktree, no
   stranded dotenv backup.
2. Run the pass on committed `HEAD`.
3. Run the finalizer YOURSELF, from the root context, so a failed subagent
   cannot strand a mutation:

```bash
node .agents/skills/red-team/scripts/mutation-runner.mjs finalize
```

4. **PAUSE for authorization before the report commit.** Listing `commit` in
   `required_approvals` does not grant it — read
   [shipping-boundaries.md](references/shipping-boundaries.md). Obtain a
   separately recorded explicit authorization, then commit only
   `docs/reviews/red-team/<slug>/findings.md` and `findings.json`.
5. Re-run the wrapper gate last, so the fingerprint regenerates over the
   committed report, then transition. The transition re-runs the red-team
   status check AND parses the deviations file — an entry without a resolved
   **Verdict:** ACCEPT, or any RE-PLAN, fails the phase change:

```bash
bash .agents/skills/feature/scripts/verified-gate.sh --review
node .agents/skills/feature/scripts/transition-state.mjs reviewed
```

A `P0` finding blocks and returns to section 4. A high-risk `OPEN_P1` requires
the user's adjudication and is enforced, not advised. Two rounds maximum.

### 7. Stop at review-ready

Report the implemented behavior, material decisions, changed files, exact
verification evidence, review verdicts, deviations, and unresolved risks.
State which external action is available next, but do not take it without
explicit authorization. Read [shipping-boundaries.md](references/shipping-boundaries.md)
if the user asks to continue.

Close the ladder, publish the review record, and stop the server:

```bash
node .agents/skills/feature/scripts/progress.mjs step ready done
node .agents/skills/feature/scripts/live-view.mjs snapshot
node .agents/skills/feature/scripts/live-view.mjs stop
```

Publish the snapshot with the Artifact tool and give the user its link. The
final progress block belongs in the report.

## Resume and recovery

Use `$feature-resume <branch>`. It validates Git and durable state, checks the
gate fingerprint, and dispatches exactly one next phase. Read
[recovery.md](references/recovery.md) only when state is inconsistent, the
worktree is missing, or the normal resume path cannot determine the next step.
