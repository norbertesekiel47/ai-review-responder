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
- `.feature/codex-gate-fingerprint.json` — proof that the gate matches the
  current HEAD, intake, staged/unstaged diff, and untracked files.
- `docs/superpowers/plans/<branch>-intake.json` — committed audit copy when the
  user has authorized a commit.
- The referenced spec, plan, deviations, and accepted review findings.

Do not create a handoff merely because context is growing. Create one only when
work is actually pausing, moving to another task, or waiting at an authority
boundary.

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

### 2. Isolate and arm

For `small`, `standard`, and `high` work, create the sibling worktree with
`pnpm worktree:new <branch>`. Do not create or switch branches when unrelated
dirty changes make the target ambiguous.

Run the repository setup from the worktree only after warning that the current
repository script creates an intake commit and removes the parent draft. That
commit/removal requires explicit user authorization:

```bash
cd <worktree-root> && bash scripts/feature-setup.sh <approved-intake-path>
```

Require `scripts/arm-check.sh` to report `ARMED`. Prefix every shell command
with an explicit worktree `cd` and use absolute paths for edits. Do not edit the
parent checkout from a feature worktree.

### 3. Plan the change

Use tracer bullets: each task delivers one vertical behavior slice, names its
test seam, declares blocking edges, cites the precedent it follows, and stays
inside `allowed_edit_surface`. Consult `codebase-design` before introducing or
widening an interface.

Write a plan only for standard/high work. For high-risk work, dispatch one
fresh read-only plan skeptic using [review-prompts.md](references/review-prompts.md),
triage its evidence, and obtain user sign-off. Maximum three plan-review rounds.

Transition state through the guarded wrapper:

```bash
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

The wrapper runs the repository gate and writes a content fingerprint. After
any edit, commit, intake change, or generated review artifact, the fingerprint
is stale. Confirm freshness with:

```bash
node .agents/skills/feature/scripts/gate-fingerprint.mjs check
```

After the same failure class twice, stop patching and use the
`diagnosing-bugs` feedback-loop discipline. After three full failed gate
rounds, a second surface amendment, or a deviation that invalidates intent,
stop and re-plan with the user.

### 6. Review proportionally

Read [review-prompts.md](references/review-prompts.md). Review the diff from a
fixed merge-base only after the review gate is green:

- trivial: one compact root review
- small: one fresh spec/correctness review
- standard: parallel spec/correctness and maintainability reviews
- high: the standard pair plus only the applicable risk axis

Require findings to include a file and line, evidence, and a concrete failure
scenario or named violated standard. Keep speculative advice outside the
actionable table. The root reproduces or verifies each finding, records
`ACCEPT` or `REJECT` with a reason, applies accepted fixes, and reruns the
verified gate.

Transition to `reviewed` only while the fingerprint is current:

```bash
node .agents/skills/feature/scripts/gate-fingerprint.mjs check
node .agents/skills/feature/scripts/transition-state.mjs reviewed
```

### 7. Stop at review-ready

Report the implemented behavior, material decisions, changed files, exact
verification evidence, review verdicts, deviations, and unresolved risks.
State which external action is available next, but do not take it without
explicit authorization. Read [shipping-boundaries.md](references/shipping-boundaries.md)
if the user asks to continue.

## Resume and recovery

Use `$feature-resume <branch>`. It validates Git and durable state, checks the
gate fingerprint, and dispatches exactly one next phase. Read
[recovery.md](references/recovery.md) only when state is inconsistent, the
worktree is missing, or the normal resume path cannot determine the next step.
