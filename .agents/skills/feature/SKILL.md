---
name: feature
description: Orchestrate a feature end-to-end — grill, model the domain, plan as tracer bullets, subagent execution, verify gate, dual review, ship via the right lane
---

# Feature Workflow

Feature request: $ARGUMENTS

You are the orchestrator. Grilling, domain modeling, planning, and review
triage happen in THIS session (they need me in the loop). Only implementation
is delegated to subagents. Never delegate intent-locking to an agent that
cannot talk to me.

## CONTEXT DISCIPLINE — applies to every step

The orchestrator's context is the scarcest resource in this workflow. Rules:

- **Disk is the source of truth, conversation is disposable.** Every locked
  decision must land in a file (spec, plan, tickets, CONTEXT.md, ADR) the
  moment it is locked. Never rely on chat history to carry state forward.
- **Never pull raw logs into context.** Command output goes to a file;
  read back only a pass/fail summary and the relevant tail.
- **Subagents and review agents return summaries, not transcripts.** Full
  reports go to disk; the orchestrator reads findings tables only.
- **Checkpoint handoffs are mandatory at the step 3→4 boundary and after
  step 7** (see Session hygiene). Do not wait until compaction is imminent.

## ANTI-SLOP RULES — apply to all code, every step

- **Precedent over invention.** Follow the nearest existing module, test,
  and API pattern before creating anything new. Name the precedent you're
  following in the task summary.
- **No abstraction before the second use.** Keep the first version concrete
  unless a declared invariant or seam demands otherwise.
- **No new dependency without justification.** Adding or updating a package
  requires `.feature/deps-justification.md` (reason, alternatives
  considered, blast radius). A pre-edit hook blocks manifest edits without
  it.
- **Small-diff bias.** If a task's diff sprawls beyond its ticket, stop and
  re-plan — don't push through.
- **No success claims without evidence.** Green gate output or it didn't
  happen (enforced by the Stop hook).
- **Look up, don't guess.** Version-specific API usage goes through Context7
  or official docs; repo/issue/CI state goes through `gh`. Memory is not a
  source for anything that can drift.
- **No backwards-compatibility shims for code with no external consumers.**
  This is a pre-launch codebase — delete the old path and update callers. A
  shim needs a named external consumer to justify it.
- **No new file without justification.** Name the existing file that was
  considered and why it does not fit; the default is no new file.
- **No new env var or feature flag without a registry entry** in
  `.claude/reference/env-vars.md`, in the same change.
- **Assert impossible states, don't branch around them.** Defensive handling
  of a state excluded by the invariants hides real bugs.
- **Net-negative bias.** A task adding more than 150 lines while deleting
  nothing states why in its summary.

## 0. CLASSIFY — pick the lane before doing anything

Read the request and the code it touches, then classify:

- **RISK = high** if it touches: worker/, webhook ingress, a migration or
  schema change, billing/Stripe, approval or auto-approval paths, auth.
  Otherwise **normal**.
- **SURFACE = ui** if it touches `src/app/` or `src/components/`;
  **backend** otherwise; **mixed** if both.
- **SIZE = trivial** if ≤ ~30 lines with no schema/API/contract change.
- **SIZE = small** if ≤ ~150 expected diff lines across ≤ ~3 files, one seam,
  no migration, and no new dependency.
- **SIZE = epic** if ANY of: the honest `allowed_edit_surface` can't be
  declared tighter than a few top-level directories; it spans multiple
  risk domains (e.g. schema + billing + worker); it would decompose into
  more than ~8 tracer tickets; or there are open investigation questions
  that grilling alone can't resolve (unknowns needing research spikes).

**TRIVIAL FAST PATH**: skip steps 1–4 and 6. Branch, implement directly
in this session, run the step 5 gate, one `/code-review` pass, PR, done.

**SMALL PATH**: skip steps 3–4 and 6, and the full grilling apparatus. Ask
only what is needed to fill an abbreviated intake (`goal`, `non_goals`,
`allowed_edit_surface`, `tests_to_add`, and `estimated_diff_size`), get
sign-off, arm enforcement, implement in this session, run the step 5 gate,
perform one spec/correctness review, and ship through the applicable risk
lane. The full pipeline is reserved for normal-sized features with a real
surface.

**EPIC PATH — decompose, don't implement**: this command's enforcement
loop (tight edit surface, reviewable diffs, one staging ride) only works
at feature scale, so an epic never runs steps 2–8 directly. Instead:
1. If an issue-tracker or project map exists, use it to separate
   investigation tickets (unknowns) from implementation tickets (knowns),
   each declaring blocking edges. If no map exists, record that decomposition
   in the feature plan instead. Do the domain-modeling work (`CONTEXT.md`
   terms, ADRs) at THIS level, since epic-scale decisions are exactly the ones
   worth an ADR.
2. Each implementation ticket must be sized to a single `/feature` run —
   if a ticket can't declare a tight edit surface, split it again.
3. STOP. Resolve investigation tickets as their own sessions; run each
   implementation ticket through `/feature <ticket-ref>` (ticket-seeded
   path, see step 1). The epic ships as a sequence of small, fully
   disciplined merges — never as one big-bang branch.

State the classification in one line before proceeding. It must name the
specific files or directories expected to change and the estimated diff size;
record that estimate in the intake. When uncertain between two lanes, take
the heavier one and say so.

## 1. GRILL — in this session (intent + domain language)

Invoke the `grill-with-docs-codex` skill. If it is not
automatically selected in this session, read its SKILL.md from
`/Users/norbertesekiel/.agents/skills/grill-with-docs-codex/SKILL.md` directly and follow its process
verbatim. Either way: a grilling session that
interviews me relentlessly until every branch of the decision tree is
resolved — edge cases, failure modes, what we're explicitly NOT building —
while building the domain model inline: it challenges terms against
`CONTEXT.md`'s glossary, updates it when we coin or sharpen a term, and
captures hard-to-explain or reversed decisions as ADRs in `docs/adr/` as
they happen. Do not proceed on guesses about what I meant. All subsequent
artifacts (intake, plan, tickets, commits) use the shared language
verbatim — no paraphrasing glossary terms.

**TICKET-SEEDED variant**: if this run was invoked as
`/feature <ticket-ref>` for a ticket from a project map (or the issue
tracker), intent was already locked at the map level. Seed the intake
contract directly from the ticket + its parent map/spec, then run
`grill-with-docs-codex` ONLY on the deltas: unresolved `open_questions`, edge
cases the ticket doesn't cover, and anything that changed since the map
was drawn. Do not re-litigate decisions the map already made — if one
looks wrong now, surface it to me as a map-level question instead.

**Prototype escape hatch**: if grilling surfaces a design question that
discussion cannot resolve (state-machine behavior, UI feel, library fit),
invoke the `prototype` skill to build a throwaway answer before locking the
intake. Prototypes never graduate to production code.

Lock the outcome into an **intake contract** — not free-form prose. Write it
to `docs/superpowers/plans/<branch>-intake.json` (parent checkout, temporary —
step 2 moves it into the worktree and arms the hooks from an ephemeral
`.feature/` copy) with exactly these fields:

```json
{
  "classification": "trivial | normal | high",
  "surface": "ui | backend | mixed",
  "db_touching": false,
  "goal": "one sentence, glossary terms verbatim",
  "non_goals": ["what we are explicitly NOT building"],
  "user_visible_behavior": ["observable behavior changes"],
  "invariants": ["things that must remain true, e.g. tenant isolation"],
  "edge_cases": ["from the grilling session"],
  "existing_patterns_to_follow": ["file/module precedents"],
  "allowed_edit_surface": ["glob list of paths implementation may touch"],
  "tests_to_add": ["VERBATIM test titles — each names the invariant/edge case it covers"],
  "verification_commands": ["gate commands beyond the standard set"],
  "estimated_diff_size": "±lines from classification — step 5 re-checks the real diff",
  "dependencies_added": [],
  "rollback_plan": "mandatory for db_touching: down migration / flag flip / revert order",
  "observability": ["log, metric, or Sentry signal proving this works in production"],
  "open_questions": []
}
```

Present it to me section by section for sign-off (prose rendering is fine;
the JSON is the artifact). `open_questions` must be empty before proceeding.

The intake contract is the **drift detector** for everything downstream:
implementation touching paths outside `allowed_edit_surface`, adding
behavior not named in `user_visible_behavior`, or skipping a promised test
in `tests_to_add` is an objective violation — pause and re-plan, never
improvise around it.

Note: if the feature will add or update a dependency,
`allowed_edit_surface` must include `package.json` and `pnpm-lock.yaml` —
the guard hook requires BOTH surface coverage and
`.feature/deps-justification.md` for manifest edits.

## 2. SETUP — sibling worktree

`pnpm worktree:new <branch>` with a branch name derived from the locked
intake. Every subsequent edit targets that worktree root — never the parent
checkout.

**WORKTREE PATH DISCIPLINE (mandatory)**: some harnesses reset the shell
cwd between Bash calls (the VSCode extension does), so never assume a `cd`
persists. Prefix EVERY Bash command with `cd <worktree-root> && …` (one
compound command, explicit path) and use absolute worktree paths for all
Edit/Write calls. Enforcement itself does not depend on cwd: the
edit-surface guard anchors on the edited file's own repo root, and the
stop gate scans every registered git worktree for an armed
`.feature/intake.json`. Inspect the parent checkout with `git -C <path>`
or absolute-path reads, never by relying on a persistent directory change.

Then arm enforcement with ONE command from the parent checkout:

```bash
cd <worktree-root> && bash scripts/feature-setup.sh <path-to-locked-intake.json>
```

This installs the intake (committed `docs/superpowers/plans/` audit copy plus
the ephemeral `.feature/intake.json` arming copy), runs `scripts/arm-check.sh`,
and prints cross-worktree surface overlaps. Any `DISARMED` result is a hard
stop. On overlap, surface it before planning and agree a merge order or narrow
the surface. The script is the supported move-and-arm path; the resulting
copies must remain synchronized if the surface is amended.

**INTAKE COPIES**: the step 1 draft is moved to the
WORKTREE's `docs/superpowers/plans/<branch>-intake.json` (committed with
the branch — the durable audit trail of the agreed scope; delete the
parent copy) and COPY it to `.feature/intake.json` at the worktree root.
The hooks key off the `.feature/` copy — its presence puts the tree in
"feature mode". `.feature/` is gitignored BY DESIGN (#512): a committed
intake would follow the merge onto `main` and arm every future main
session. If the surface is amended mid-run (with my sign-off), update
BOTH copies. `.feature/deps-justification.md` is likewise ephemeral —
carry its content into the PR description so the justification survives.

**NO BASH WRITES (hook scoping)**: once `scripts/feature-setup.sh` has
armed the run, do not modify source files via Bash (`sed -i`, `>` redirects,
`mv`, heredocs). Codex's PreToolUse hooks cover both Bash and
`apply_patch`/Edit/Write calls, but shell-based writes remain harder to audit
and are blocked for the declared edit surface. Scratch notes go to the
scratchpad or `.feature/`/`docs/` (exempt surfaces), never into shell
redirects over repo files.

ARM CHECK (mandatory): before proceeding to implementation, prove the
hooks are actually armed by executing them the way Codex registers them
(`bash <script>`, matching `.codex/hooks.json`). With
`.feature/intake.json` present, feed the edit-surface guard an
out-of-surface probe payload (pick a path NOT covered by the declared
`allowed_edit_surface` — `__arm_check__/probe.ts` at the worktree root is
outside any sane surface) and expect exit 2; with no
`.feature/gate-status.json` present, feed the stop gate an empty payload
and expect exit 2:

```bash
cd <worktree-root> && echo '{"tool_input":{"file_path":"'"$PWD"'/__arm_check__/probe.ts"}}' | bash ./.codex/hooks/edit-surface-guard.sh; echo "guard exit: $?"
cd <worktree-root> && echo '{}' | bash ./.codex/hooks/stop-gate.sh; echo "stop-gate exit: $?"
```

(The stop gate scans registered worktrees, so its probe returns 2 from any
cwd inside the repo family once the worktree is armed — but run it with the
explicit `cd` anyway so the probe is deterministic.)

Any other exit code (126, 127, 0) means enforcement is DISARMED (missing
file, missing jq, or broken registration) — STOP and report to the user
instead of continuing.

## 3. PLAN — in this session (tracer bullets, deep modules)

Before writing the plan, consult the `codebase-design` skill: name the
modules/seams this feature touches, and state for each whether we're
deepening an existing module or forced to add a new interface. If the plan
would widen an interface or scatter logic across seams, redesign before
proceeding.

Then use the Codex planning workflow, but structure the tasks per the
`to-tickets` discipline:
- Each task is a **tracer bullet**: a thin vertical slice that runs
  end-to-end, not a horizontal layer.
- Each task declares its **blocking edges** (which tasks must land first).
- Each task uses glossary terms from `CONTEXT.md` verbatim.
- Each task stays within `allowed_edit_surface`. If planning reveals the
  surface was declared too narrowly, amend the intake contract WITH my
  sign-off — the hook enforces the declared surface, so silent widening
  will be blocked anyway.

Write the plan to `docs/superpowers/plans/`. If DB-touching, read the
authoritative `.claude/reference/migrations-log.md` before writing the
migration step.

**If RISK = high, gate the plan before executing:**
1. Dispatch the codex rescue agent (read-only) to adversarially review the
   plan document: challenge assumptions, missing failure modes, and simpler
   alternatives; require an explicit `VERDICT: APPROVED` or `REVISE` with
   reasons. Revise and re-submit until APPROVED (max 3 rounds — after that,
   surface the disagreement to me instead of looping).
2. Then show me the approved plan and wait for my sign-off.

**CHECKPOINT (step 3→4 boundary)**: after plan sign-off, run
`cd <worktree-root> && bash scripts/feature-state.sh set-phase plan_approved`
and write the handoff doc directly to the worktree
(`docs/superpowers/plans/<branch>-handoff.md`). It must reference the spec,
plan, ticket files, and glossary excerpt by path — not restate them. Then:
- If context usage is already high (grilling ran long), tell me to start a
  fresh session **in the worktree** and resume with `/feature-resume
  <branch>` — it re-enters the worktree, re-runs the ARM CHECK, and
  bootstraps from the handoff doc + referenced files, continuing from
  step 4. The grilling transcript is no longer needed once the spec is
  locked.
- Otherwise continue in this session — but from here on, NEVER re-read the
  full grilling conversation; consult the spec/plan files instead.

## 4. EXECUTE — delegated

Run `cd <worktree-root> && bash scripts/feature-state.sh set-phase executing`,
then use Codex subagents FROM this session: dispatch
fresh per-task subagents against the worktree. Each subagent's task prompt
MUST include:
- The relevant `CONTEXT.md` glossary excerpt (so it names things in the
  shared language, not its own invented jargon).
- The task's spec slice and its blocking-edge context.

TDD per the `tdd` skill discipline where behavior is specifiable up front:
red-green-refactor, one vertical slice at a time. Commit per completed task
on the branch.

Subagents report back a ≤10-line summary (what changed, files touched,
tests added, anything surprising). Full output stays in the subagent; if a
subagent hits something the plan didn't anticipate, it writes a note to
`docs/superpowers/plans/<branch>-deviations.md` rather than dumping context
on the orchestrator.

**First-task enforcement spot check**: after the first subagent task,
compare `git status --porcelain` paths with `allowed_edit_surface`. An
out-of-surface file means enforcement did not bind for subagent calls — stop
and report; do not dispatch further tasks.

## 5. VERIFY GATE — cheap, before any review

Must be fully green before any review starts, and re-run after every fix
round. Run `scripts/verify-gate.sh` — it reads `.feature/intake.json` for
surface/db flags, runs the applicable checks, writes per-check logs to
`.feature/logs/`, and writes machine-readable `.feature/gate-status.json`:

- Always: `pnpm lint && pnpm typecheck && pnpm test`
- Always: every `ci:*` audit script in package.json except `ci:fallow*`,
  enumerated dynamically — the same set CI's lint job and the lefthook
  pre-push gate run, so gate-green can never fail push-time audits.
  (fallow runs in its own CI workflow with its own baseline.)
- If surface includes ui: `pnpm build`
- Changed `*.integration.test.ts` suites: run when
  `TEST_DATABASE_POOL_URL` is set. Without it, record a loud `SKIP` warning;
  a DB-touching gate with that warning is not review-ready.
- `promised-tests`: every `tests_to_add` title must exist verbatim in a test
  file.
- `reclassify`: actual diff beyond roughly twice `estimated_diff_size` warns
  that the lane must be reconsidered.
- Plus any `verification_commands` declared in the intake.

The final gate before step 7 is `scripts/verify-gate.sh --review`: its test
row includes coverage and `diff-coverage` enforces changed-line coverage.
Checks run in parallel; re-run the gate after every fix round.

On failure, read back only the log tail and failing test/rule names — never
the full log. Report the gate as a one-line-per-check PASS/FAIL table.

**Enforcement is deterministic, not advisory**: the Stop hook refuses to
end the session as "complete" unless `gate-status.json` is green and newer
than HEAD (see `.codex/hooks/` setup). It scans all registered worktrees
but enforces only the ones THIS session engaged with (launched in, or
edited — the guard records session ids in `.feature/sessions`), so parked
worktrees never block unrelated sessions. To deliberately park red work
mid-feature in the SAME session, rename `.feature/intake.json` — parking
red work should be a conscious act. `verification-before-completion`
discipline still applies to how you talk about progress: evidence before
claims.

**Property-test requirement**: if the feature touches billing, approval /
auto-approval, or escalation logic, `tests_to_add` MUST include at least one
`fast-check` property test per declared invariant — example tests are too
weak for state-machine and money logic. `fast-check` is installed; the
house style lives in `src/lib/reviews/__tests__/sentiment.test.ts`
("invariants" describe block). (Mutation testing via Stryker is planned as
a nightly CI lane, not part of this gate; when it lands, tests it flags as
weak come back as bug tickets.)

**Anti-thrash rule**: if the gate fails on the same failure class twice,
STOP patching. Dispatch a fresh subagent to run the `diagnosing-bugs` skill
loop (reproduce → minimise → hypothesise → instrument → fix →
regression-test) against the failing check, with the log file path and the
relevant spec slice as its inputs. It returns the diagnosis and fix summary;
the instrumentation noise stays out of this session.

**Re-classification trigger**: compare the actual branch diff against the
intake's `estimated_diff_size`. If it exceeds roughly 2× the estimate, or the
edit surface has been amended once, stop and re-run classification with the
real numbers.

**Abort criteria**: after three full gate-fail rounds, a second surface
amendment, or any deviation that invalidates a locked intake decision, stop
patching. Write `docs/superpowers/plans/<branch>-postmortem.md` and restart
from step 1 carrying that postmortem.

## 6. REVIEW 0 — ADVERSARIAL (RISK = high only)

Runs ONLY when RISK = high; skip entirely for normal-risk features (the
plan already got adversarial review at step 3 for high-risk work — this
pass challenges what was actually built).

PAUSE and ask me to run an available Codex-compatible adversarial review on
the branch (this is user-invocable only). If none is available, perform the
review as a user-approved read-only pass before continuing. This challenges
the chosen approach, design choices, and assumptions — not implementation
defects. Triage its findings with
the Codex receiving-review workflow: a valid approach-level finding may mean
revisiting the plan (step 3), not just patching code. Re-run step 5 after any
change.

## 6.5 DEVIATIONS READ-BACK — mandatory before review

Read `docs/superpowers/plans/<branch>-deviations.md` end to end. For each
entry, record a one-line verdict in that file: `ACCEPT` when the adaptation is
sound, or `RE-PLAN` when it invalidates a locked decision. Review agents
receive the triaged file, not a raw accumulation.

## 7. REVIEW — unified two-axis, confidence-filtered

First run `cd <worktree-root> && bash scripts/blast-radius.sh`. It writes
`docs/reviews/<branch>/blast-radius.md` listing importers of changed files;
typecheck catches signature breaks but not semantic changes callers relied on.

One review round, two parallel fresh agents on the branch diff since the
fork point, so neither axis pollutes the other:

- **Spec & correctness agent**: does the diff faithfully implement the
  intake contract and tickets? Flag bugs, drift outside
  `allowed_edit_surface`, behavior not named in `user_visible_behavior`,
  missing `tests_to_add`, and unhandled `edge_cases` — checked field by
  field against `.feature/intake.json`, not from memory.
- **Standards & maintainability agent**: invoke
  `/thermo-nuclear-code-quality-review` on the branch directly (it is
  agent-invocable); if unavailable or it errors, fall back to
  `/code-review` at high effort. Covers repo standards, the
  `codebase-design` deep-module discipline, a Fowler smell baseline, and
  glossary violations (code that renames a `CONTEXT.md` concept).

**Confidence filter (both agents)**: the findings table contains ONLY
findings the agent would stake ≥80% confidence on, each with file:line and
either a concrete failure scenario or the named standard violated.
Speculative "might be nicer" observations go in a low-confidence appendix
in the on-disk report — never in the table, never triaged by default.

Both agents write full reports to `docs/reviews/<branch>/` and return only
a findings table: severity | file:line | one-line finding. This applies to
ALL reviews in this workflow (steps 6 and 7): full report on disk, findings
table in context. Open the full report only for findings you are actively
triaging.

Triage both tables with the Codex receiving-review workflow: fix what is
real, reject the rest with stated reasoning. Log accepted/rejected verdicts
as one-liners in the report file (so a resumed session inherits triage
state). Commit the review reports and triage verdicts on the branch so they
survive worktree cleanup. Re-run step 5, then set the phase with
`bash scripts/feature-state.sh set-phase reviewed`.

## 8. SHIP — lane-dependent

**If RISK = high** (worker / webhook / migration / billing / auth):
1. Ride staging first: land the branch on `staging` (push → full stack
   auto-deploys). Migrations apply to the staging Supabase project FIRST.
2. Verify on staging (smoke the touched path; use the matching runbook in
   `docs/runbooks/` if one exists).
3. Open the PR to `main`, confirm all GitHub CI checks green, then PAUSE for
   my explicit merge approval. Apply the migration to prod Supabase in
   lockstep at promotion.

**If RISK = normal**:
1. Push, open PR to `main`.
2. Confirm all GitHub CI checks green (including fallow; React Doctor 100/100
   applies only when SURFACE = ui).
3. Merge.

**After merge (both lanes)**:
- `git pull --ff-only` on local `main` (squash-merge lag).
- Fast-forward `staging` onto `main` (`git merge --ff-only main`) so it never
  drifts.
- Run `bash scripts/feature-cleanup.sh` from the main checkout in dry-run
  mode, review the list, then use `--apply` for merged, clean worktrees.
  Never remove a worktree by hand with `--force`.
- Read `docs/superpowers/plans/<branch>-deviations.md` and promote durable
  lessons into `.claude/reference/lab-notes.md` or the project gotchas; keep
  the deviations file as historical evidence.
- Invoke the `document-feature` skill to sweep docs/reference inventories.
- **Domain sweep**: apply `domain-modeling` one final time — fold any terms
  or decisions that emerged during implementation/review back into
  `CONTEXT.md` and ADRs, so the next session inherits the language.
- **Entropy counter**: increment the merge counter in the authoritative
  `.claude/reference/arch-review-log.md`. If ≥ 5 merges since the last
  architecture pass, remind me to schedule an architecture review session
  (e.g. a pathfinder or dedicated review pass — my
  call; never start one automatically).

## Session hygiene

Handoff is mandatory at the step 3→4 boundary and after step 7 triage. The
latter records review verdicts and current step, then asks the user to start a
fresh session with `/feature-resume <branch>` before ship.

Check context usage at each step boundary: at ≥50%, update the handoff and
recommend a fresh session; at ≥60%, finish only the current step and hand off;
at ≥70%, hand off immediately.
- Prefer `/clear` + handoff-doc resume over `/compact`: state lives on
  disk in this workflow, so a clean session reading files beats a lossy
  summary. Reserve `/compact` for mid-grilling (step 1) where no
  checkpoint exists yet, and pass preservation instructions when you do.

A resumed session bootstraps from: handoff doc → spec → plan → deviations
file → review findings tables. It never needs the prior transcript.
