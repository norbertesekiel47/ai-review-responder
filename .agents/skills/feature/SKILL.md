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

Read [working-rules.md](references/working-rules.md) § Context discipline,
§ Authority and § Worktree path discipline before the first edit; open
§ Anti-slop at the first edit that adds a file, a dependency, or more than
~150 lines. It owns context discipline, the anti-slop rules, authority,
worktree path discipline, and the no-bash-writes rule for BOTH lanes — this
lane and the Claude lane (`.claude/commands/feature.md`). A rule that appears
to differ between the two routers is a bug in one of them, never a lane
difference.

Load every other reference by section, at the step that cites it — never a
whole file up front. Trivial and small lanes open only the sections named
above.

Read `AGENTS.md` and `.claude/CLAUDE.md`. Use their reference map to read only
the relevant glossary entries (`CONTEXT-MAP.md` → `docs/context/`) and domain references before making
architectural assumptions; do not load the entire glossary.

This lane adds exactly one rule of its own:

- Do not commit, push, deploy, merge, apply remote migrations, or flip remote
  flags unless the user explicitly authorizes that action. Read
  [shipping-boundaries.md](references/shipping-boundaries.md) before any such
  step. The Claude lane ships (its step 8); this one stops at review-ready.
  That is the only intended divergence between them.

## Durable state and live coordination

For guarded runs, use the Codex task plan for live progress and the worktree for durable state.
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

The user must never have to ask where the run stands. For guarded runs, read
[progress-and-live-view.md](references/progress-and-live-view.md) before the
first step, then:

- Advance the step ladder as each workflow section below closes. The write
  commands print the block, so a boundary is one command.
- Log root replies and triage verdicts in the review transcript. Attach native
  Codex reviewer IDs and reports with `attach-review`; companion jobs use exact IDs.
- Start the live view before the first review round. Publish its snapshot as
  a local HTML file in Codex once the rounds close.

Both surfaces derive from durable state. Never report a phase from memory.

## Select the lane before creating workflow state

Classify size and risk using [execution-lanes.md](references/execution-lanes.md)
§ Classification, then run the read-only router:

```bash
node .agents/skills/feature/scripts/progress.mjs route --size <size> --risk <risk>
```

Follow its `lane` result. High risk always selects `guarded`, except an epic,
which remains planning-only. Never run guarded setup for a normal-risk small
change merely because this skill was invoked.

- `epic`: produce the domain model and dependency-ordered tickets; stop before
  implementation or arming.
- `trivial`: use the current safe feature branch, implement, run the relevant
  test plus the router's verification commands, and perform a root review.
  Create no intake, ladder, worktree, or fingerprint. Report and finish here.
- `small`: state the six-field compact intake described in execution-lanes.md
  once in the task, implement directly, run the router's verification commands,
  and obtain one fresh spec/correctness review. Use a sibling worktree only for
  the isolation conditions in that reference. Create no armed `.feature/intake.json`,
  plan, or state-machine transition. Report and finish here.
- `guarded`: follow steps 0–7 below. These steps do not apply to the two
  lightweight lanes. A scope/risk increase returns here before further edits.

For lightweight runs, preserve existing user changes and use a local feature
branch when starting on main/staging. Honor the user's existing authorization;
the shipping boundary applies to every lane.

## Workflow

### 0. Orient and classify

Inspect the request and likely code surface. Classify independent axes:

- `size`: `trivial | small | standard | epic`
- `risk`: `normal | high`
- `surface`: `ui | backend | mixed`

Treat worker, webhook, migration/schema, billing, approval/autonomy, auth,
tenant isolation, destructive data, and production-operation changes as high
risk. Read [execution-lanes.md](references/execution-lanes.md) § Classification
and § Lane behavior now; its other sections are cited by the step that needs
them (TDD at step 3, delegation at step 4, the gate loop at step 5, the wave
at step 6).

Open the ladder as soon as the three axes are fixed:

```bash
node .agents/skills/feature/scripts/progress.mjs init --size <size> --risk <risk> --surface <surface> --runtime codex
```

The guarded lane runs every ladder step. Lightweight and epic runs already
returned from the router above and do not initialize this ladder.

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

For guarded work, create the sibling worktree with
`pnpm worktree:new <branch>`. Do not create or switch branches when unrelated
dirty changes make the target ambiguous.

Codex uses the app's configured sandbox and approval policy. Ensure the task
has scoped write access to the sibling worktree; a Claude permission profile
does not grant Codex access. Setup preserves the input draft and creates an
uncommitted audit copy, so preparation needs no commit authorization:

```bash
cd <worktree-root> && bash scripts/feature-setup.sh <approved-intake-path> --runtime codex
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
cd <worktree-root> && node .agents/skills/feature/scripts/progress.mjs carry <parent-repo-root> --runtime codex
```

Every later progress, review-log, and live-view command runs from the
worktree.

### 3. Plan the change

Use tracer bullets: each task delivers one vertical behavior slice, names its
test seam, declares blocking edges, cites the precedent it follows, and stays
inside `allowed_edit_surface`. The plan is a behavior contract, not an
implementation — [execution-lanes.md](references/execution-lanes.md) § Tracer
bullets and TDD owns the fields, the security contract, and the per-slice
test rule. When the surface must widen, count the
amendment mechanically — `bash scripts/feature-state.sh incr-amendment` —
which refuses a second amendment without a recorded owner reason. Consult `codebase-design` before introducing or
widening an interface.

Write a plan only for standard/high work. For high-risk work, dispatch one
fresh read-only plan skeptic using [review-prompts.md](references/review-prompts.md),
triage its evidence, and obtain user sign-off. Maximum three plan-review rounds.

Read that file's § Dispatching a Codex round before writing the brief. Three
rules bind: put the context IN the brief instead of letting the session
re-derive it; never clone one brief across delegates — differentiate the
question or do not fan out; and RESUME round 1's session for a
verification-only round (`codex exec resume <id> "<delta>"`), never for round 1
and never for an independent axis. Record the session id when round 1 returns.

A plan verification round after the fixes is owed only when the fixes moved
the plan's contract, and always at high risk. A branch verification round is
decided by `branch-round-owed <reviewed-sha>`, never by the plan hash. Snapshot
the contract at round start and re-derive it after — read
[execution-lanes.md](references/execution-lanes.md) § Conditional verification
rounds for what counts and how to record a skip:

```bash
bash scripts/feature-state.sh record-contract <plan.md>
bash scripts/feature-state.sh contract-changed <plan.md>
```

Start the live view before the first plan-review round, then log the round:

```bash
node .agents/skills/feature/scripts/live-view.mjs start
node .agents/skills/feature/scripts/review-log.mjs round-start --axis plan-skeptic
node .agents/skills/feature/scripts/review-log.mjs attach-review --id <reviewer-id> --report <completed-report.md>
```

Register the tracer bullets and transition state through the guarded wrapper:

```bash
node .agents/skills/feature/scripts/progress.mjs tracers set "T1 <title>|T2 <title>|..."
node .agents/skills/feature/scripts/progress.mjs step plan done
node .agents/skills/feature/scripts/transition-state.mjs plan_approved
```

**Model handoff — on `gpt-6-astra`, stop here.** Follow
[execution-lanes.md](references/execution-lanes.md) § Model handoff at plan
approval: write the handoff doc, run
`node .agents/skills/feature/scripts/progress.mjs handoff`, print its output
VERBATIM as the last thing in the reply, and stop. The owner pasting that
prompt into a fresh `gpt-5.6-sol` session IS the sign-off to implement.

### 4. Execute vertical slices

Pick the model by what the slice demands, per
[execution-lanes.md](references/execution-lanes.md) § Model routing:
`gpt-5.6-luna` for searches and mechanical edits, `gpt-5.6-terra` for a tracer
with a complete behavior contract and for the whole light lane, `gpt-5.6-sol`
for integration and hard debugging, `gpt-6-astra` only for a high-risk plan or
an unresolved design decision. Name the model on every `codex exec -m …`
dispatch, and run the root session itself on the tier the lane needs.

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
rows + tails only), fix, `bash scripts/feature-state.sh incr-gate-round`, then
re-run in FAST mode — same rows, three narrowed against the last green SHA
(25 s against 95 s, measured):

```bash
bash .agents/skills/feature/scripts/verified-gate.sh --fast
```

A fast run is never evidence: it writes `.feature/gate-fast.json`, touches no
phase, no budget and no fingerprint. Read
[execution-lanes.md](references/execution-lanes.md) § The gate loop for what it
narrows and why it cannot satisfy the Stop hook. Run the full wrapper at every
boundary and any time HEAD moves. The counter refuses round 4 without an owner
reason — the gate-fail abort criterion enforced mechanically; a full green
resets it.

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
fixed merge-base only after the review gate is green. Append its § Weakened
checks brief to the spec/correctness axis on every lane:

**Take main BEFORE this section, then freeze the fork.** From the moment the
wave dispatches, a rebase voids the gate result, the fingerprint, the blast
radius and the red-team sidecar together, and the `reviewed` transition refuses
on that basis. Measured on feat/1008: 67 of red team's 174 minutes went to one
post-rebase re-run, against 95 s for taking main beforehand. If main must be
taken mid-review the round is VOID — re-run the full gate and open a fresh one.
Read [execution-lanes.md](references/execution-lanes.md) § Pin the fork.

Dispatch every required axis — plus, for high-risk work, the red-team pass —
in ONE parallel wave; route mechanical passes (logging, checklist sweeps, doc
greps) to `gpt-5.6-luna`, and run the axes themselves on `gpt-5.6-sol`
(`gpt-6-astra` at high risk) — tiers and escalation rules in
[execution-lanes.md](references/execution-lanes.md) § Model routing. Read
[execution-lanes.md](references/execution-lanes.md) § The review wave
first — it carries the three rules that keep a live mutation safe beside
concurrent reviewers, and breaking one corrupts the red-team pass.

- trivial: one compact root review
- small: one fresh spec/correctness review
- standard: the spec/correctness review, plus the maintainability review
  only when the measured production diff exceeds the threshold in
  execution-lanes.md § The review wave (`git diff --numstat` from the fork
  point, test files excluded; record the number in the report header)
- high: spec/correctness and maintainability, plus only the applicable risk
  axis

Only a high-risk lane carries the red-team member; a normal-risk run records
a waiver instead (execution-lanes.md § The review wave). The wave's reviewers stage their
reports in `.feature/review-staging/<axis>.md`; the root copies them into
`docs/reviews/<branch>/` after the finalizer returns. The reason is judgement,
not a checker: `red-team-status.mjs` ignores untracked paths on purpose, but
red-team's post-restore assertion is agent-applied at the moment it decides
whether a mutation was restored, and a sibling's report file makes that call
ambiguous. The root edits nothing while the wave is in flight.

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

### 6.5 Close the red-team pass and transition

Section 6 asks whether the change is right, and — for high-risk work — its
wave already ran the pass that tries to prove it wrong. This section owns
everything after that pass, and it owns the `reviewed` transition, so no
high-risk run reaches review-ready without adversarial evidence.

**Normal-risk short path:** when the wave carried no red-team pass, skip
steps 1–6 below. Run the review gate, then transition — the status check
inside the transition derives the waiver from the signed-off intake and
prints WAIVED. If a pass WAS run on a normal-risk branch anyway, its sidecar
exists and the full sequence below applies.

The red-team skill is a VERIFIER, not a reviewer: its mutations of production
files are the one narrow exception to "never let a reviewer edit", because they
are journaled, finalizer-guarded, and can never reach a commit. Read
`.agents/skills/red-team/SKILL.md` for the protocol.

Order matters — the report commit moves `HEAD`, so it precedes the final gate:

1. Confirm the wave's preconditions held: clean tree at a committed SHA, no
   process watching the worktree, no stranded dotenv backup.
2. The pass ran on committed `HEAD` inside the section 6 wave.
3. Run the finalizer YOURSELF, from the root context, so a failed subagent
   cannot strand a mutation:

```bash
node .agents/skills/red-team/scripts/mutation-runner.mjs finalize
```

4. Before the report commit, check existing authorization. Listing `commit`
   in `required_approvals` does not grant it; an earlier explicit scoped
   authorization does. Read [shipping-boundaries.md](references/shipping-boundaries.md)
   and ask only if the action has not been authorized. Commit only
   `docs/reviews/red-team/<slug>/findings.md` and `findings.json`, plus the
   staged review reports copied from `.feature/review-staging/` into
   `docs/reviews/<branch>/`. The staging directory is gitignored, so a report
   left there vanishes with the worktree.
5. Apply the section 6 triage fixes and loop the gate until green.
6. **Round 2, scoped.** The fixes moved `HEAD`, so the sidecar is stale by
   construction. Re-run the pass against the FIX HUNKS and their direct callers
   only. `round-start` refuses a third round outright, so a `P0` here goes to
   the user with no round behind it.
7. Re-run the wrapper gate last, so the fingerprint regenerates over the
   committed report, then transition. The transition re-runs the red-team
   status check AND parses the deviations file — an entry without a resolved
   **Verdict:** ACCEPT, or any RE-PLAN, fails the phase change:

```bash
bash .agents/skills/feature/scripts/verified-gate.sh --review
node .agents/skills/feature/scripts/transition-state.mjs reviewed
```

A `P0` finding blocks and returns to section 4. A high-risk `OPEN_P1` requires
the user's adjudication and is enforced, not advised. Two rounds maximum, and
the wave plus the scoped round spend both by design.

### 7. Stop at review-ready

Report the implemented behavior, material decisions, changed files, exact
verification evidence, review verdicts, deviations, unresolved risks, and
every compromise the change names ([working-rules.md](references/working-rules.md)
§ No unacknowledged debt). Include the change's `docs/agents/change-ledger.md`
row in the report; whoever ships adds it.
State which external action is available next, but do not take it without
explicit authorization. Read [shipping-boundaries.md](references/shipping-boundaries.md)
if the user asks to continue.

Close the ladder, publish the review record, and stop the server:

```bash
node .agents/skills/feature/scripts/progress.mjs step ready done
node .agents/skills/feature/scripts/live-view.mjs snapshot
node .agents/skills/feature/scripts/live-view.mjs stop
```

Open the snapshot with `open_in_codex` when available and provide its absolute
local file link. Do not require an unavailable publishing tool or publish it
externally without authorization. The final progress block belongs in the report.

## Resume and recovery

Use `$feature-resume <branch>`. It validates Git and durable state, checks the
gate fingerprint, and dispatches exactly one next phase. Read
[recovery.md](references/recovery.md) only when state is inconsistent, the
worktree is missing, or the normal resume path cannot determine the next step.
