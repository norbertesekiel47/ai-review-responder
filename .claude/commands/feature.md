---
description: Orchestrate a feature end-to-end — grill, model the domain, plan as tracer bullets, subagent execution, verify gate, dual review, ship via the right lane
argument-hint: <feature description>
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
  This is a pre-launch codebase — delete the old path and update callers.
  A shim needs a named external consumer to justify it.
- **No new file without justification** (slop invents `utils/helpers.ts`).
  Name the existing file that was considered and why it doesn't fit —
  repworth.md's "default is no new file" applies doubly here.
- **No new env var or feature flag without a registry entry** in
  `.claude/reference/env-vars.md`, in the same change.
- **Assert impossible states, don't branch around them.** Defensive
  handling of a state the invariants exclude is noise that hides real
  bugs — throw with context instead.
- **Net-negative bias.** A task adding >150 lines while deleting 0 states
  why in its summary; "new code only" is a claim to justify, not a default.

## 0. CLASSIFY — pick the lane before doing anything

Read the request and the code it touches, then classify:

- **RISK = high** if it touches: worker/, webhook ingress, a migration or
  schema change, billing/Stripe, approval or auto-approval paths, auth.
  Otherwise **normal**.
- **SURFACE = ui** if it touches `src/app/` or `src/components/`;
  **backend** otherwise; **mixed** if both.
- **SIZE = trivial** if ≤ ~30 lines with no schema/API/contract change.
- **SIZE = small** if ≤ ~150 expected diff lines across ≤ ~3 files, one
  seam, no migration, no new dependency.
- **SIZE = epic** if ANY of: the honest `allowed_edit_surface` can't be
  declared tighter than a few top-level directories; it spans multiple
  risk domains (e.g. schema + billing + worker); it would decompose into
  more than ~8 tracer tickets; or there are open investigation questions
  that grilling alone can't resolve (unknowns needing research spikes).

**TRIVIAL FAST PATH**: skip steps 1–4 and 6. Branch, implement directly
in this session, run the step 5 gate, one `/code-review` pass, PR, done.

**SMALL PATH** (the lane between trivial and the full apparatus — a
half-followed full pipeline is worse than a smaller one followed
completely): skip steps 3–4 and 6, and step 1's full grilling. Ask only
what's needed to fill an ABBREVIATED intake — `goal`, `non_goals`,
`allowed_edit_surface`, `tests_to_add`, `estimated_prod_lines` +
`estimated_test_lines` (other fields may be empty arrays) — and get
sign-off. Then: step 2 setup as
normal (enforcement still arms), implement IN THIS SESSION with no
subagent dispatch, step 5 gate, ONE review agent (spec & correctness
only), step 8 by RISK lane. The full pipeline is reserved for normal+
features with a real surface.

**EPIC PATH — decompose, don't implement**: this command's enforcement
loop (tight edit surface, reviewable diffs, one staging ride) only works
at feature scale, so an epic never runs steps 2–8 directly. Instead:
1. Invoke the `wayfinder` skill: build the shared map on the issue
   tracker — investigation tickets for the unknowns, implementation
   tickets for the knowns, each declaring its blocking edges. Do the
   domain-modeling work (CONTEXT.md terms, ADRs) at THIS level, since
   epic-scale decisions are exactly the ones worth an ADR.
2. Each implementation ticket must be sized to a single `/feature` run —
   if a ticket can't declare a tight edit surface, split it again.
3. STOP. Resolve investigation tickets as their own sessions; run each
   implementation ticket through `/feature <ticket-ref>` (ticket-seeded
   path, see step 1). The epic ships as a sequence of small, fully
   disciplined merges — never as one big-bang branch.

State the classification in one line before proceeding — it MUST name the
specific files you expect to touch and estimated diff sizes for BOTH
buckets (recorded as `estimated_prod_lines` / `estimated_test_lines` in
the intake — estimating tests at 1:1 fires the reclassify trigger on
exactly the features whose test rigour is most worth having, the #643
lesson). When uncertain between two lanes,
take the HEAVIER one and say so — under-classification is the systematic
failure mode ("epic" is not a failure state, it's a routing decision), and
step 5's re-classification trigger checks the estimate against reality.

## 1. GRILL — in this session (intent + domain language)

Invoke the `grill-with-docs` skill (mattpocock). If it is not
model-invocable in this session (its frontmatter sets
`disable-model-invocation`), read its SKILL.md from
~/.claude/skills/grill-with-docs/ directly and follow its process
verbatim — the flag only hides it from auto-loading, it doesn't
forbid following it. Either way: a grilling session that
interviews me relentlessly until every branch of the decision tree is
resolved — edge cases, failure modes, what we're explicitly NOT building —
while building the domain model inline: it challenges terms against
`CONTEXT.md`'s glossary, updates it when we coin or sharpen a term, and
captures hard-to-explain or reversed decisions as ADRs in `docs/adr/` as
they happen. Do not proceed on guesses about what I meant. All subsequent
artifacts (intake, plan, tickets, commits) use the shared language
verbatim — no paraphrasing glossary terms.

**TICKET-SEEDED variant**: if this run was invoked as
`/feature <ticket-ref>` for a ticket from a wayfinder map (or the issue
tracker), intent was already locked at the map level. Seed the intake
contract directly from the ticket + its parent map/spec, then run
`grill-with-docs` ONLY on the deltas: unresolved `open_questions`, edge
cases the ticket doesn't cover, and anything that changed since the map
was drawn. Do not re-litigate decisions the map already made — if one
looks wrong now, surface it to me as a map-level question instead.

**Proportionality (RISK = normal)**: grill only until the intake fields
are answerable — batch related questions, lead each with a recommended
answer, and never ask what the code, docs, or design of record already
answer. The relentless full-decision-tree interview is reserved for
RISK = high; for everything else the intake contract IS the deliverable,
not the interview.

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
  "verification_commands": ["gate commands beyond the standard set — NEVER test:db:setup (the gate provisions serially itself and rejects destructive commands)"],
  "estimated_prod_lines": "±N production+migration lines from step 0 — step 5 re-checks 2x per bucket, workflow artifacts excluded",
  "estimated_test_lines": "±N test-file lines, estimated SEPARATELY — a DB-contract feature legitimately runs 3-4x its production lines in tests (#643 lesson)",
  "dependencies_added": [],
  "rollback_plan": "MANDATORY when db_touching: how to back out (down migration / flag flip / revert order)",
  "observability": ["what log line / metric / Sentry signal proves this works in prod — 'how would I know it broke'"],
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
persists. Prefix EVERY Bash command with `cd <worktree-root> && …` and use
absolute worktree paths for all Edit/Write calls. Enforcement itself does
not depend on cwd (the guard anchors on the edited file's repo root; the
stop gate scans registered worktrees). Inspect the parent checkout with
`git -C <path>`, never by relying on a persistent directory change.

Then arm enforcement with ONE command:

```bash
cd <worktree-root> && bash scripts/feature-setup.sh <path-to-locked-intake.json>
```

It installs the intake (committed `docs/superpowers/plans/` audit copy +
ephemeral `.feature/intake.json` arming copy — gitignored by design, #512),
deletes the parent draft, proves the hooks are armed (`scripts/arm-check.sh`
— any DISARMED output means STOP and report, do not implement), and prints
cross-worktree surface overlaps. On overlap, surface it to me BEFORE
planning: agree a merge order (noted in both deviations files) or narrow a
surface. If the surface is amended mid-run (with my sign-off), update BOTH
intake copies — and count the amendment (abort criteria, step 5; only
`allowed_edit_surface` changes count, other intake-field corrections are
deviations-file entries).
`.feature/deps-justification.md` is likewise ephemeral — carry its content
into the PR description so the justification survives.

**NO BASH WRITES**: repo file changes go through Edit/Write only — never
`sed -i`, shell redirects, `tee`, `mv`/`cp`, or heredocs over repo files
(routes around the guard). The common shapes are hook-enforced
(`.claude/hooks/bash-write-guard.sh`, armed like the stop gate); this rule
covers the residue the hook's conservative parser allows. Scratch goes to
the scratchpad or `.feature/`/`docs/` (exempt surfaces).

## 3. PLAN — in this session (tracer bullets, deep modules)

Before writing the plan, consult the `codebase-design` skill: name the
modules/seams this feature touches, and state for each whether we're
deepening an existing module or forced to add a new interface. If the plan
would widen an interface or scatter logic across seams, redesign before
proceeding.

Then invoke `writing-plans`, but structure the tasks per the
`to-tickets` discipline:
- **The FIRST task is the eval task**: author the `tests_to_add` bodies as
  failing tests (slices not yet buildable may use `.todo`/`.fails`
  markers), committed before any implementation task — the spec in
  executable form. Each implementation task then names the failing tests
  it turns green. Prefer code-shaped spec over prose everywhere: a test
  suite, an HTML mockup, or a precedent file `@`-referenced beats a
  paragraph describing the same thing.
- Each task is a **tracer bullet**: a thin vertical slice that runs
  end-to-end, not a horizontal layer.
- Each task declares its **blocking edges** (which tasks must land first).
- Each task uses glossary terms from `CONTEXT.md` verbatim.
- Each task stays within `allowed_edit_surface`. If planning reveals the
  surface was declared too narrowly, amend the intake contract WITH my
  sign-off — the hook enforces the declared surface, so silent widening
  will be blocked anyway.

Write the plan to `docs/superpowers/plans/`. If DB-touching, read
`.claude/reference/migrations-log.md` before writing the migration step.

**If RISK = high, gate the plan before executing:**
1. Before EVERY review dispatch, run `bash scripts/feature-state.sh
   incr-round plan`. The counter lives in `.feature/state.json`, so a
   resumed session CONTINUES the count — uncounted rounds are how #628
   reached a round-5 review under a "max 3" cap.
2. **Round 1 (full, eval-first)**: the primary review target is the
   failable definition of done, not the plan prose. Dispatch the codex
   rescue agent (read-only) to adversarially review the plan + the eval
   task, leading with: **can this eval pass while the feature is still
   wrong?** — every missing failure mode must be named as a missing
   failing test, not as a prose objection. Plan-level findings
   (assumptions, simpler alternatives) are secondary. Require an explicit
   `VERDICT: APPROVED` or `REVISE` with reasons. The brief MUST include the
   **cited-artifact check**: verify every file/section the plan cites
   actually exists on disk (three #643 plan rounds each re-reviewed
   plan-internal consistency and all missed that a cited `CONTEXT.md`
   section had never been written). Dispatch via direct `codex exec` and
   record the codex session id in the handoff doc — the companion wrapper
   has lost task ids across session resumes.
3. **Rounds 2–3 (verification-only)**: after revising, re-submit ONLY the
   findings-and-fixes delta. The reviewer verifies each prior finding is
   addressed and may flag a defect a FIX introduced — it may NOT open new
   fronts against unchanged plan sections. A round that returns new
   unrelated findings is over-reviewing: note them in the plan's review
   appendix and move on.
4. **After round 3**: STOP. Surface the remaining disagreement to me with
   both positions — my call substitutes for APPROVED. Never loop further.
5. Then show me the approved plan and wait for my sign-off.

**CHECKPOINT (step 3→4 boundary)**: after plan sign-off, run
`cd <worktree-root> && bash scripts/feature-state.sh set-phase plan_approved`
(the machine-readable phase record `/feature-resume` reads first — setup
initialized it at `worktree_ready`; the gate records `gate_green` itself),
then invoke the `handoff` skill and write the handoff doc to the worktree
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

Set the phase first (`bash scripts/feature-state.sh set-phase executing`),
then invoke `subagent-driven-development` FROM this session:
dispatch fresh per-task subagents against the worktree. Each subagent's
task prompt MUST include:
- The relevant `CONTEXT.md` glossary excerpt (so it names things in the
  shared language, not its own invented jargon).
- The task's spec slice and its blocking-edge context.
- The precedent file paths from `existing_patterns_to_follow` and the
  failing eval tests this task turns green — code references, not prose
  descriptions of them.

TDD per the `tdd` skill discipline where behavior is specifiable up front:
red-green-refactor, one vertical slice at a time. Commit per completed task
on the branch.

Subagents report back a ≤10-line summary (what changed, files touched,
tests added, anything surprising). Full output stays in the subagent; if a
subagent hits something the plan didn't anticipate, it writes a note to
`docs/superpowers/plans/<branch>-deviations.md` rather than dumping context
on the orchestrator.

**First-task enforcement spot check**: after the FIRST subagent task
completes, diff `git status --porcelain` paths against
`allowed_edit_surface`. An out-of-surface file means enforcement did not
bind for subagent tool calls in this harness — STOP and report; do not
dispatch further tasks.

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
- Changed `*.integration.test.ts` suites: RUN when
  `TEST_DATABASE_POOL_URL` is set (the gate resolves it itself — env
  first, `.env.local` fallback); otherwise a loud `SKIP` row + warning
  (live-DB suites self-skip locally and can go red in CI — the #520
  class). A gate with that warning is NOT review-ready for DB-touching
  work: set the var and re-run.
- If `db_touching`: the gate provisions the test DB (`pnpm test:db:setup`)
  SERIALLY before the parallel rows — provisioning is a precondition it
  owns, never a `verification_commands` entry (destructive commands there
  are rejected as FAIL rows; a schema drop as a parallel peer produced 27
  phantom timeouts on #643).
- `promised-tests` row: every `tests_to_add` title must exist VERBATIM in
  a test file — the edge-case→test mapping is deterministic, not judged.
- `reclassify` WARN row: either bucket of the actual diff (production /
  test, workflow artifacts under `docs/superpowers/plans/**` and
  `docs/reviews/**` excluded) > 2× its intake estimate fires the
  re-classification trigger below.
- Docs-only diffs (every changed path is `docs/`, `.claude/`, or `*.md`)
  auto-detect: the gate runs lint/typecheck/audit rows only and records
  `"mode":"docs_only"` in `gate-status.json` — a valid green for docs
  commits and mid-feature checkpoints, where `promised-tests` is
  structurally unsatisfiable.
- Plus any `verification_commands` declared in the intake.

The LAST gate run before step 7 is `scripts/verify-gate.sh --review`: the
test row runs with coverage and a `diff-coverage` row enforces changed-line
coverage (default min 80%) — "wrote code, wrote no test for it" fails
mechanically instead of hoping a reviewer notices.

Checks run in parallel (wall-clock ≈ slowest check) — re-running the gate
after every fix round is cheap; do it.

On failure, read back only the log tail and failing test/rule names — never
the full log. Report the gate as a one-line-per-check PASS/FAIL table.

**Enforcement is deterministic, not advisory**: the Stop hook refuses to
end the session as "complete" unless `gate-status.json` is green and newer
than HEAD (see `.claude/hooks/` setup). It scans all registered worktrees
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

**Re-classification trigger**: the gate's `reclassify` row compares the
actual diff per bucket (production vs test, workflow artifacts excluded)
against `estimated_prod_lines` / `estimated_test_lines`. If either bucket
exceeds ~2× its estimate, or `allowed_edit_surface` has already been
amended once, STOP and re-run step 0 with the real numbers — the lane was
wrong, and the heavier lane's controls exist for exactly this feature.

**Abort criteria (sunk cost is not a lane)**: after 3 full gate-fail
rounds, or a 2nd amendment of `allowed_edit_surface`, or any deviation
that invalidates a locked intake decision — stop patching. Only surface
amendments count toward that budget: `tests_to_add` retitles and
`verification_commands` corrections are recorded as owner-approved
deviations-file entries, not amendments (#643 nearly hit teardown over
two test-title renames). Write a post-mortem to
`docs/superpowers/plans/<branch>-postmortem.md` (what was learned; what
the intake/plan got wrong), tear the branch down, and restart at step 1
carrying the post-mortem. The genuinely bad merges come from persisting,
not restarting.

## 6. DEVIATIONS READ-BACK — mandatory before review

Read `docs/superpowers/plans/<branch>-deviations.md` end to end. Every
entry is, by definition, something the plan did not anticipate — the
highest-signal bug source on the branch. For each entry, log a one-line
verdict in the file: ACCEPT (the adaptation is sound) or RE-PLAN (it
invalidates a locked decision — abort criteria apply). Review agents
receive the triaged file, never a raw accumulation.

## 7. REVIEW — unified two-axis, confidence-filtered

First run `cd <worktree-root> && bash scripts/blast-radius.sh` — it writes
`docs/reviews/<branch>/blast-radius.md` listing the importers of every
changed file (typecheck catches signature breaks; it cannot catch a
semantic change whose callers relied on the old behavior).

ONE full review round: parallel fresh agents on the branch diff since the
fork point — two axes always, a third when RISK = high — so no axis
pollutes another. All agents receive the triaged deviations file; the spec
agent also receives `blast-radius.md` (check the listed callers against
the changed semantics):

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
- **Adversarial approach agent (RISK = high only)**: invoke
  `/codex:adversarial-review` directly — it is model-invocable, no owner
  pause needed. Use `--background --base <fork-point>` so it runs while
  the other two agents work, and hand it the intake + triaged deviations
  file paths as focus context. If the plugin runtime errors (it has lost
  task ids before), fall back to the codex rescue agent via direct
  `codex exec`. It challenges the chosen approach, design choices, and
  assumptions — not line-level defects (the other two agents own those).
  This replaces the old sequential step 6 pass — running it in parallel
  with the other axes removes a full review phase from the wall clock. A
  valid approach-level finding may mean revisiting the plan (step 3), not
  just patching code.

**Round protocol (counter-enforced)**: before dispatching ANY review wave,
run `bash scripts/feature-state.sh incr-round branch` — the counter lives
in `.feature/state.json` and survives session resumes, so a resumed
session cannot restart at round 1. Round 1 is the full parallel review
above. Rounds 2–3 are **verification-only**: one fresh agent per axis that
had accepted findings, briefed with that axis's findings table + the fix
commits, verifying each fix landed and introduced nothing new — it may NOT
open new fronts against unchanged code; new unrelated findings go in the
report appendix, untriaged. After round 3, STOP and surface any remaining
disagreement to me — never loop further.

**Confidence filter (all agents)**: the findings table contains ONLY
findings the agent would stake ≥80% confidence on, each with file:line and
either a concrete failure scenario or the named standard violated.
Speculative "might be nicer" observations go in a low-confidence appendix
in the on-disk report — never in the table, never triaged by default.

Every agent writes its full report to `docs/reviews/<branch>/` and returns
only a findings table: severity | file:line | one-line finding. This
applies to ALL reviews in this workflow (steps 3 and 7): full report on
disk, findings table in context. Open the full report only for findings
you are actively triaging.

Triage the tables with `receiving-code-review`: fix what is
real, reject the rest with stated reasoning. Log accepted/rejected verdicts
as one-liners in the report file (so a resumed session inherits triage
state). **COMMIT the review reports + triage verdicts on the branch** —
uncommitted reports vanish with the worktree at cleanup (two merged
worktrees were found holding the only copy of their step 7 reports).
Re-run step 5. When triage completes, run
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
- **Worktree cleanup**: run `bash scripts/feature-cleanup.sh` from the main
  checkout (dry run — lists worktrees whose PR merged with clean trees),
  review the plan, then re-run with `--apply`. This also sweeps earlier
  merged worktrees that skipped cleanup; never remove by hand with
  `--force`.
- **Deviations triage (promotion rule)**: read
  `docs/superpowers/plans/<branch>-deviations.md` and promote every durable
  lesson — root cause, test technique, library gotcha, constraint — into
  `.claude/reference/lab-notes.md` or the CLAUDE.md gotchas. The deviations
  file stays as the historical record; the lesson must not live only there.
- Invoke the `document-feature` skill to sweep docs/reference inventories.
- **Domain sweep**: apply `domain-modeling` one final time — fold any terms
  or decisions that emerged during implementation/review back into
  `CONTEXT.md` and ADRs, so the next session inherits the language.
- **Entropy counter**: increment the merge counter in
  `.claude/reference/arch-review-log.md`. If ≥ 5 merges since the last
  architecture pass, remind me to schedule an architecture review session
  (e.g. the `claude-mem:pathfinder` skill or a dedicated review pass — my
  call; never start one automatically).

## Session hygiene

Handoff is proactive, not reactive:

- **Mandatory**: at the step 3→4 boundary (see checkpoint above).
- **Unconditional after step 7**: update the handoff doc with review
  verdicts and current step, then tell me to start a fresh session for
  step 8 (`/feature-resume <branch>`). Reviews are the biggest context
  consumers and everything step 8 needs is on disk — no judgment call.
- **Default fresh at 3→4**: start a fresh session for step 4 unless
  grilling + planning were genuinely short. There is no reliable way to
  measure context usage from inside the session — the only rule is: if
  you think you might be past halfway, take the exit NOW (update handoff,
  `/clear`, resume). One rule followed beats a threshold ladder ignored.
- Prefer `/clear` + handoff-doc resume over `/compact`: state lives on
  disk in this workflow, so a clean session reading files beats a lossy
  summary. Reserve `/compact` for mid-grilling (step 1) where no
  checkpoint exists yet, and pass preservation instructions when you do.

A resumed session bootstraps from: handoff doc → spec → plan → deviations
file → review findings tables. It never needs the prior transcript.
