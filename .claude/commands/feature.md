---
description: Orchestrate a feature end-to-end — grill, model the domain, plan as tracer bullets, subagent execution, verify gate, one parallel review wave, ship via the right lane
argument-hint: <feature description>
---

# Feature Workflow

Feature request: $ARGUMENTS

You are the orchestrator. Grilling, domain modeling, planning and review triage
happen in THIS session — they need the owner in the loop. Only implementation
and review are delegated. Never delegate intent-locking to an agent that cannot
talk to the owner.

## Shared rules — read these, do not restate them

This command is the Claude lane's router. The rules it shares with the Codex
lane (`.agents/skills/feature/SKILL.md`) live in one place each:

| Rule set | File |
|---|---|
| Context discipline, anti-slop, authority, worktree path discipline, no bash writes | `.agents/skills/feature/references/working-rules.md` |
| Lane behavior, the review wave, conditional rounds, the gate loop, TDD, delegation | `.agents/skills/feature/references/execution-lanes.md` |
| Intake field contract | `.agents/skills/feature/references/intake-contract.md` |
| Review axis prompts, checklists, triage | `.agents/skills/feature/references/review-prompts.md` |
| Step ladder and live view | `.agents/skills/feature/references/progress-and-live-view.md` |

**Load references by section, at the step that needs them — never whole
files up front.** Instruction load is context spent before the first file
opens; the two references together are ~4,000 words, and a trivial or small
run needs almost none of it. The binding schedule:

| Before… | Read |
|---|---|
| the first edit | `working-rules.md` § Context discipline, § Authority, § Worktree path discipline |
| step 0 | `execution-lanes.md` § Classification |
| step 3 | `execution-lanes.md` § Tracer bullets and TDD; `intake-contract.md` only if a field is unclear |
| step 4 | `execution-lanes.md` § Delegation contract |
| step 5's loop | `execution-lanes.md` § The gate loop, § Reclassification and anti-thrash |
| step 7 | `execution-lanes.md` § The review wave, § Pin the fork, § Conditional verification rounds; `review-prompts.md` for the axis being dispatched |

The trivial and small lanes run `/feature-small` and open none of these
except the first row. The two lanes differ in exactly two things: this lane
ships to `main` (step 8), and it calls Claude subagents and slash commands.
Everything else that disagrees between them is a bug in one of them.

**Report every phase boundary.** Advance the ladder as each step closes — one
command, and it prints the block:

```bash
node .agents/skills/feature/scripts/progress.mjs step <id> done
```

The ladder's timestamps are the run's only per-phase record. Advance it when
the boundary happens, never in one backfilled pass at the end.

## 0. CLASSIFY — pick the lane before doing anything

Read the request and the code it touches. Fix three axes per
`execution-lanes.md` § Classification: `size`, `risk`, `surface`.

- **RISK = high** if it touches worker/, webhook ingress, a migration or schema
  change, billing/Stripe, approval or auto-approval paths, or auth.
- **SIZE = epic** if the honest `allowed_edit_surface` cannot be declared
  tighter than a few top-level directories, it spans multiple risk domains, it
  decomposes into more than ~8 tracer tickets, or open investigation questions
  remain that grilling cannot resolve.

Open the ladder as soon as the axes are fixed:

```bash
node .agents/skills/feature/scripts/progress.mjs init --size <size> --risk <risk> --surface <surface>
```

**TRIVIAL and SMALL, RISK = normal → `/feature-small`.** That command is the
whole lane on one page: six-field intake posted once, branch in this checkout
(a worktree only when isolation is actually needed), build in this session,
the pre-push gate, one spec-and-correctness review, PR. Hand off to it now
and do not continue here. A half-followed full pipeline is worse than a
smaller one followed completely — that is why the small lane has its own
file instead of a list of steps to skip.

**SMALL, RISK = high** stays in this command: abbreviated intake (`goal`,
`non_goals`, `allowed_edit_surface`, `tests_to_add`, `estimated_prod_lines`,
`estimated_test_lines`) with sign-off, step 2 setup as normal, implement IN
THIS SESSION with no subagent dispatch, step 5 gate, the step 7 wave, step 8
by the high-risk lane.

**EPIC PATH — decompose, do not implement.** This command's enforcement only
works at feature scale, so an epic never runs steps 2–8:

1. Invoke the `wayfinder` skill: investigation tickets for the unknowns,
   implementation tickets for the knowns, each declaring its blocking edges. Do
   the domain-modeling work — glossary terms (`CONTEXT-MAP.md` → the owning
   `docs/context/<context>.md`), ADRs — at THIS level.
2. Size every implementation ticket to a single `/feature` run. A ticket that
   cannot declare a tight surface splits again.
3. STOP. Each ticket ships through its own `/feature <ticket-ref>` run.

State the classification in one line. It MUST name the files you expect to
touch and the estimated diff for BOTH buckets separately
(`estimated_prod_lines` / `estimated_test_lines`) — estimating tests at 1:1
fires the step 5 reclassify trigger on exactly the features whose test rigour
is most worth having. When uncertain between two lanes, take the HEAVIER one
and say so. Under-classification is the systematic failure mode; "epic" is a
routing decision, not a failure state.

## 1. GRILL — in this session (intent + domain language)

Invoke the `grill-with-docs` skill. If it is not model-invocable here, read its
`SKILL.md` from `~/.claude/skills/grill-with-docs/` and follow it verbatim —
`disable-model-invocation` hides it from auto-loading, it does not forbid
following it.

Grill until every branch of the decision tree is resolved: edge cases, failure
modes, what we are explicitly NOT building. Build the domain model inline —
challenge terms against the glossary (`CONTEXT-MAP.md` → the owning
`docs/context/<context>.md`), update that context file — and the term's name
in the map — when we coin or sharpen a term, and capture reversed or
hard-to-explain decisions as ADRs in
`docs/adr/` as they happen. Every later artifact uses the shared language
verbatim. Never paraphrase a glossary term.

**Proportionality (RISK = normal)**: grill only until the intake fields are
answerable. Batch related questions, lead each with a recommended answer, and
never ask what the code, docs, or design of record already answer. The
relentless full interview is reserved for RISK = high; elsewhere the intake
contract IS the deliverable.

**TICKET-SEEDED variant**: for `/feature <ticket-ref>` from a wayfinder map,
intent was locked at map level. Seed the intake from the ticket and its parent
map, then grill ONLY the deltas — unresolved `open_questions`, uncovered edge
cases, anything that changed since. Do not re-litigate a decision the map made;
if one looks wrong now, raise it as a map-level question.

**Prototype escape hatch**: a design question discussion cannot resolve
(state-machine behavior, UI feel, library fit) goes to the `prototype` skill
before the intake locks. Prototypes never graduate to production code.

Write the intake to `docs/superpowers/plans/<branch>-intake.json` per
`intake-contract.md`, then validate it:

```bash
node .agents/skills/feature/scripts/validate-intake.mjs <intake-path>
```

`open_questions` must be empty before proceeding. Then, by lane: **RISK = high**
— present the intake section by section and wait for sign-off. **RISK = normal**
— post the rendered intake in ONE message and proceed; the owner vetoes
asynchronously, and the drift detector plus the step 5 gate catch mechanically
what a reading would have caught.

The intake is the **drift detector** for everything downstream. Implementation
touching paths outside `allowed_edit_surface`, behavior not named in
`user_visible_behavior`, or a skipped `tests_to_add` entry is an objective
violation. Pause and re-plan; never improvise around it.

## 2. SETUP — sibling worktree

`pnpm worktree:new <branch>`, with the branch name derived from the locked
intake. Apply `working-rules.md` § Worktree path discipline to every command
and edit from here on.

Then arm enforcement with ONE command:

```bash
cd <worktree-root> && bash scripts/feature-setup.sh <path-to-locked-intake.json> --runtime claude
```

It installs both intake copies (uncommitted audit copy + ephemeral
`.feature/intake.json` arming copy), preserves the parent draft, proves the hooks
are armed via `scripts/arm-check.sh` (any DISARMED output means STOP and
report), writes the worktree-scoped autonomy profile so steps 4–7 run without
permission prompts (the shipping boundary still prompts;
`FEATURE_AUTONOMY_PROFILE=off` opts out), carries the ladder in, and prints
cross-worktree surface overlaps. Commit the audit copy at the normal authorized
commit boundary; preparation itself creates no commit or deletion.

On overlap, surface it BEFORE planning: agree a merge order, noted in both
deviations files, or narrow a surface.

**Surface amendments**: an amendment that only NARROWS the surface, or adds ≤2
files inside a tree the surface already covers, is auto-approved — apply it and
record it in the deviations file. Anything broader needs owner sign-off. Either
way, update BOTH intake copies and count it mechanically:

```bash
bash scripts/feature-state.sh incr-amendment
```

The 1st auto-approves; the 2nd and later REFUSE without `--reason`. Only
`allowed_edit_surface` changes count — other intake corrections are
deviations-file entries.

## 3. PLAN — in this session (tracer bullets, deep modules)

Consult the `codebase-design` skill first: name the modules and seams this
feature touches, and state for each whether we deepen an existing module or are
forced to add a new interface. A plan that would widen an interface or scatter
logic across seams gets redesigned before proceeding.

Then write the plan, structuring tasks as tickets. Write it for an engineer
who is skilled but knows nothing of this codebase or domain:

- **Map the files first.** Before any task, list every file to create or
  modify and its one responsibility. Split by responsibility, not by layer;
  files that change together live together. Follow the existing patterns —
  plan a split only for a file this feature already has to touch and that has
  become unwieldy.
- **Every task names its files exactly**: `Create:`, `Modify: path`, `Test:`.
- **Every task is a behavior contract, not an implementation** — the fields,
  the security contract, and the two rules that follow are owned by
  `execution-lanes.md` § Tracer bullets and TDD; read it before writing the
  first task. In short: state behavior, negative cases, owner, precedent,
  invariants, seam and test titles; show code only where a sentence would stay
  ambiguous; map every `tests_to_add` title to its task, and let each slice
  author its own failing tests.
- **No placeholders.** These are plan failures: "TBD", "TODO", "add
  appropriate error handling", "handle edge cases", "write tests for the
  above" without the test titles, "similar to Task N" (repeat the content —
  tasks get read out of order), or a type or function that no task defines.
- Each task is a **tracer bullet** — a thin vertical slice that runs end to
  end, never a horizontal layer.
- Each task declares its **blocking edges**, uses the glossary's terms
  (`docs/context/*.md`) verbatim,
  and stays inside `allowed_edit_surface`.
- Mark the mutually independent tasks (no blocking edges AND disjoint file
  sets). Step 4 uses this for parallel dispatch.

Write the plan to `docs/superpowers/plans/`. If DB-touching, read
`.claude/reference/migrations-log.md` before writing the migration step.

**Self-review the plan before registering it** — a checklist you run, not a
dispatch. Fix what it finds inline; no re-review is needed:

1. **Intake coverage** — every `user_visible_behavior` entry, edge case and
   `tests_to_add` title maps to a task. Add a task for any gap.
2. **Placeholder scan** — search the plan for the patterns above.
3. **Security coverage** — every task that crosses a trust boundary states
   its security contract and owns at least one negative test title
   (wrong tenant, missing authorization, replayed or stale input).
4. **Name consistency** — a type or signature one task defines and another
   consumes is spelled identically in both.

Register the tracers:

```bash
node .agents/skills/feature/scripts/progress.mjs tracers set "T1 <title>|T2 <title>|..."
```

**If RISK = high, gate the plan before executing:**

1. Count the round and snapshot the contract, then PRE-VALIDATE mechanically —
   a ~300 s round must never be spent on a defect a shell command finds in
   under a second:

   ```bash
   bash scripts/feature-state.sh incr-round plan
   bash scripts/feature-state.sh record-contract <plan.md>
   python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py \
     <plan.md> --repo "$(git rev-parse --show-toplevel)"
   ```

   It resolves every `path:line` citation against current HEAD, tests every
   referenced test-shaped path with `git check-ignore`, and resolves every
   cited commit SHA including a stale `HEAD is <sha>` handoff claim. Dispatch
   only on `PREVALIDATE: PASS`.

2. **Round 1 (full, eval-first)**: dispatch the codex rescue agent (read-only)
   with the plan-skeptic prompt from `review-prompts.md`. The primary target is
   the failable definition of done, not the plan prose — lead with **can this
   eval pass while the feature is still wrong?** Every missing failure mode
   must be named as a missing failing test, not a prose objection. The brief
   MUST include the cited-artifact check: verify every file and section the
   plan cites exists on disk. Require `VERDICT: APPROVED` or `REVISE` with
   reasons. Dispatch via direct `codex exec -m gpt-6-astra` (tier 4: this round
   runs only at high risk) and record the session id in the
   handoff doc — the companion wrapper has lost task ids across resumes, and
   the verification round below resumes from that id.

   Apply `review-prompts.md` § Dispatching a Codex round when you write the
   brief. Two rules bind here: write the context INTO the brief rather than
   letting the session re-derive it with a dozen `exec` calls, and if the round
   fans out, give each delegate a DIFFERENT question (failability / cited
   artifacts / invariants) — never the same brief cloned. Measured on
   feat/1008: three identical clones per wave, 7.27 M input tokens for 56 K of
   output.

3. **After the fixes, ask whether a verification round is owed:**

   ```bash
   bash scripts/feature-state.sh contract-changed <plan.md>
   ```

   `UNCHANGED` — the fixes moved no contract surface (RISK = high never reads
   UNCHANGED; its round is always owed). Skip the round.
   Self-verify each fix against the findings table and record the skip and its
   reason in the plan's review appendix. `CHANGED` — dispatch one
   verification-only round (`incr-round plan` first) by RESUMING round 1's
   session, never cold:

   ```bash
   codex exec resume <round-1-session-id> "<the findings-and-fixes delta>"
   ```

   A verification round checks whether ITS OWN findings were addressed, so
   round 1's context is exactly what it needs and a cold start pays ~1 M input
   tokens to rebuild it. Resume ONLY here — never for round 1, never for an
   independent axis, because a resumed session is anchored on its earlier
   conclusions and that destroys the independence an axis exists to provide.

   The round confirms each prior finding is addressed and may flag a defect a
   FIX introduced. It may NOT open new fronts against unchanged sections; a
   round returning new unrelated findings is over-reviewing — note them in the
   appendix and move on.

4. **After round 3**: STOP. Surface the remaining disagreement with both
   positions. The owner's call substitutes for APPROVED. Never loop further.

5. On `APPROVED`, post the plan summary and go to the checkpoint below.

**CHECKPOINT (step 3→4)**: once the plan is locked, record the phase and write
the handoff:

```bash
cd <worktree-root> && bash scripts/feature-state.sh set-phase plan_approved
node .agents/skills/feature/scripts/progress.mjs step plan done
```

The handoff doc (`docs/superpowers/plans/<branch>-handoff.md`) references the
spec, plan, ticket files and glossary excerpt BY PATH — it never restates them.
From here on, never re-read the grilling conversation; consult the files.

**MODEL HANDOFF — when this session runs on `fable`, stop here.** Planning is
tier-4 work and implementation is tier-3 work (`execution-lanes.md` § Model
handoff at plan approval, which owns the rule). Commit the handoff doc, then:

```bash
node .agents/skills/feature/scripts/progress.mjs handoff
```

Print its output VERBATIM as the last thing in your reply and end the turn. It
gives the owner the launch line (`claude --model opus`) and the prompt to paste
(`/feature-resume <branch>`); pasting it IS the sign-off to implement. Never
compose the block by hand, and never start step 4 in this session. A session
already on `opus` or below, and a `/feature-swarm` subagent, skip this and
continue to step 4.

## 4. EXECUTE — delegated

```bash
bash scripts/feature-state.sh set-phase executing
```

Dispatch a FRESH subagent per task, from this session, against the worktree.
Run every task without pausing to check in; stop only on a BLOCKED you cannot
resolve, an ambiguity that prevents progress, or a finished plan.

**The task prompt.** The subagent never inherits this session and never reads
the plan file — paste what it needs: the task's full text from the plan, where
it fits (blocking-edge context), the glossary excerpt (the relevant
`docs/context/*.md` terms), the precedent paths from
`existing_patterns_to_follow`, and the test titles and seam this task must
turn green — it writes those failing tests first, then the code. The full
delegation contract is in `execution-lanes.md` § Delegation contract. The
prompt also tells the subagent to:

- ask before starting if requirements, approach or assumptions are unclear,
  and ask again mid-task instead of guessing;
- build exactly the task — no extras (YAGNI), no restructuring outside it,
  and follow the plan's file structure; a file growing past the plan's intent
  is a concern to report, not a split to make;
- stop and escalate rather than hand back work it is unsure of — an
  architectural choice the plan did not make, code it cannot understand from
  what it was given, or reading file after file without progress;
- self-review before reporting: everything in the task done, edge cases,
  names that say what things do, tests that check real behavior and not
  mocks;
- report `Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`, the
  files changed and the test results, inside the ≤10-line summary below.

**Model per task — name it on EVERY dispatch** (`Agent(model: "…")`), per
`execution-lanes.md` § Model routing, which owns the tiers and the escalation
rules. In short: `haiku` for searches and mechanical edits; `sonnet` for a
tracer with a complete behavior contract; `opus` for multi-module integration,
hard debugging and every review axis; `fable` only for a high-risk plan, its
skeptic, red-team adjudication, or an unresolved design decision. An unnamed
dispatch falls to the project default (`sonnet`), never to this session's model.

**Handle the status.** DONE → spec check below. DONE_WITH_CONCERNS → read the
concerns; resolve correctness or scope concerns before the check, note mere
observations. NEEDS_CONTEXT → supply it and re-dispatch. BLOCKED → a context
gap gets more context on the same model; a reasoning gap gets a stronger
model; a task too large gets split; a wrong plan goes to the owner. Never
re-dispatch unchanged after an escalation, and never fix the task by hand in
this session — dispatch a fix subagent with specific instructions.

**Spec check per task — do not trust the report.** Read the diff, not the
summary. Compare it to the task text line by line: anything missing, anything
extra that was not requested, anything misread. Confirm its promised tests
exist, failed first, and are now green. A gap goes back to a subagent and is checked again; never move
to the next task with a gap open. Code-quality review of the whole branch is
step 7's wave, not a per-task stage.

**Parallel dispatch**: the first task always runs alone, because its
enforcement spot check proves the guard binds for subagent tool calls in this
harness. After it passes, tasks the plan marked mutually independent may run as
concurrent subagents — one agent per independent task, all launched in ONE
message. Each prompt is focused (one task), self-contained (all its context
pasted in), and names its constraints (its edit lease; touch nothing else)
and its return format. Tasks sharing files, edges or state stay serial. When
the fan-out returns: read every summary, check that no two agents touched the
same code, spot-check the diffs (agents make systematic errors), and run the
suite before the next task. Any surface violation by a parallel task stops the
whole fan-out.

**TDD** where behavior is specifiable up front, one vertical slice at a time:

1. RED — one minimal test for one behavior, clearly named, on real code
   (mock only what cannot run in a test).
2. Watch it fail, every time. It must FAIL, not error, and fail because the
   behavior is missing, not because of a typo. A test that passes on the first
   run tests existing behavior — fix the test.
3. GREEN — the simplest code that passes. No extra options or features.
4. Watch it pass, with the other tests still green and the output clean. A
   failure means fixing the code, not the test.
5. REFACTOR only while green; add no behavior.

Production code written before its test is deleted and rewritten from the
test — not kept as a reference. A bug fix starts with a failing test that
reproduces the bug. Never assert on a mock's own existence or calls in place
of the behavior, never add a production method that only tests use, and
understand a dependency's side effects before mocking it. A test that is hard
to write means the design is hard to use — simplify the interface.

Commit per completed task. Move each tracer as it starts and finishes:

```bash
node .agents/skills/feature/scripts/progress.mjs tracer T3 active
node .agents/skills/feature/scripts/progress.mjs tracer T3 done
```

Subagents report a ≤10-line summary. A subagent that hits something the plan
did not anticipate writes to `docs/superpowers/plans/<branch>-deviations.md`
rather than dumping context on the orchestrator.

**First-task enforcement spot check**: after the FIRST subagent task completes,
diff `git status --porcelain` paths against `allowed_edit_surface`. An
out-of-surface file means enforcement did not bind — STOP and report. Do not
dispatch further tasks.

## 5. VERIFY GATE — cheap, before any review

Run `scripts/verify-gate.sh`. It reads `.feature/intake.json` for surface and
DB flags, runs the applicable checks in parallel, writes per-check logs to
`.feature/logs/`, and writes machine-readable `.feature/gate-status.json`:

- Always: `pnpm lint`, `pnpm typecheck`, `pnpm test`
- Always: every `ci:*` audit in package.json except `ci:fallow*`, enumerated
  dynamically — the same set CI's lint job and the lefthook pre-push gate run,
  so a gate-green branch can never fail push-time audits.
- Every surface except a docs-only change: `pnpm build` (AGENTS.md requires it;
  `src/lib` is shared with the app, so "backend" is not a build boundary)
- Changed `*.integration.test.ts` suites: RUN when `TEST_DATABASE_POOL_URL`
  resolves (the gate resolves it itself). Otherwise a loud `SKIP` row. A gate
  carrying that warning is NOT review-ready for DB-touching work.
- `db_touching`: the gate provisions the test DB SERIALLY before the parallel
  rows. Provisioning is a precondition it owns, never a `verification_commands`
  entry — destructive commands there are rejected as FAIL rows.
- `promised-tests`: every `tests_to_add` title must exist VERBATIM in a test
  file. The edge-case→test mapping is deterministic, not judged.
- `reclassify` WARN: either diff bucket over 2× its estimate fires the
  re-classification trigger below.
- Docs-only diffs auto-detect and run lint/typecheck/audit rows only.
- Plus any `verification_commands` from the intake.

The LAST gate run before step 7 is `scripts/verify-gate.sh --review`: the test
row runs with coverage and a `diff-coverage` row enforces changed-line coverage
(default 80%), so "wrote code, wrote no test for it" fails mechanically.

**GATE LOOP — unattended and budget-enforced.** After a RED gate, do not hand
back per round. Read `bash scripts/gate-summary.sh` (failing rows and log tails
only), fix, then:

```bash
bash scripts/feature-state.sh incr-gate-round
bash scripts/verify-gate.sh --fast
```

`--fast` is the loop's gate: same rows, three narrowed against the last green
SHA (25 s against 95 s, measured). It is never evidence — see
`execution-lanes.md` § The gate loop for what it skips and why it cannot
satisfy the Stop hook. Run the FULL gate at every boundary and any time HEAD
moves. The counter REFUSES round 4 without an owner reason; a full green resets
the budget. The anti-thrash rule applies inside the loop.

**Never blocking-wait on a gate blind.** `bash scripts/verify-gate.sh --status`
answers RUNNING (rows done, elapsed), DEAD (crashed mid-run, exit 3), or the
last completed result. Check it before waiting, before re-launching, and on
resume. To prove a tree green WITHOUT advancing the phase, run `--baseline`.

**SUBAGENT BARRIER — the gate is the LAST serialized step.** Never start a gate
while any step-4 subagent is in flight. A subagent returning mid-gate moves
HEAD under the evidence, `gate-status.json` ends up older than HEAD, and the
Stop hook then refuses a feature that was actually finished. The order is
fixed: every subagent has returned → commit → `git rev-parse HEAD` → run the
gate → record that SHA. If HEAD moves afterwards for any reason, the previous
gate result is VOID. Re-derive it; never reuse it.

Report the gate as a one-line-per-check PASS/FAIL table. On failure read back
only the log tail and the failing names.

**Enforcement is deterministic.** The Stop hook refuses to end the session as
complete unless `gate-status.json` is green and newer than HEAD. It scans
registered worktrees but enforces only the ones THIS session engaged with. To
park red work mid-feature in the same session, rename `.feature/intake.json` —
parking should be a conscious act.

**Property-test requirement**: a feature touching billing, approval /
auto-approval, or escalation logic MUST include at least one `fast-check`
property test per declared invariant. Example tests are too weak for
state-machine and money logic. House style:
`src/lib/reviews/__tests__/sentiment.test.ts` ("invariants" describe block).

**Anti-thrash**: the same failure class twice means STOP patching. Dispatch a
fresh subagent to run the `diagnosing-bugs` loop against the failing check,
with the log path and the relevant spec slice as inputs. It returns the
diagnosis and fix summary; the instrumentation noise stays out of this session.

**Re-classification trigger**: a bucket over ~2× its estimate, or a surface
already amended once, means STOP and re-run step 0 with the real numbers.

**Abort criteria (sunk cost is not a lane)**: after 3 full gate-fail rounds, a
2nd surface amendment, or any deviation that invalidates a locked intake
decision — stop patching. Only surface amendments count toward that budget;
`tests_to_add` retitles and `verification_commands` corrections are
deviations-file entries. Write
`docs/superpowers/plans/<branch>-postmortem.md`, tear the branch down, and
restart at step 1 carrying it. The genuinely bad merges come from persisting,
not restarting.

Close the step from a green review gate with a current fingerprint:

```bash
node .agents/skills/feature/scripts/gate-fingerprint.mjs check
node .agents/skills/feature/scripts/progress.mjs step gate done
```

## 6. DEVIATIONS READ-BACK — mandatory before review

Read `docs/superpowers/plans/<branch>-deviations.md` end to end. Every entry is
by definition something the plan did not anticipate — the highest-signal bug
source on the branch. Log a one-line verdict per entry in the file: ACCEPT (the
adaptation is sound) or RE-PLAN (it invalidates a locked decision; abort
criteria apply). Review agents receive the triaged file, never a raw
accumulation.

This is ENFORCED: the `reviewed` transition parses the file and refuses when
any entry lacks a resolved **Verdict:** ACCEPT. A RE-PLAN verdict also refuses.

## 7. REVIEW WAVE — every axis, plus the red team when RISK = high, in one dispatch

**Take main BEFORE this step, then freeze the fork.** Check drift now
(`git rev-list --count HEAD..origin/main`) and rebase or merge if it is
material. From the moment the wave dispatches, the fork point is FROZEN: a
rebase during steps 7–7.5 voids the gate result, the fingerprint, the blast
radius and the red-team sidecar all at once, and `red-team-status.mjs` will
refuse the `reviewed` transition on exactly that basis. On feat/1008 that cost
**67 of red team's 174 minutes** for one post-rebase re-run. Taking main before
the wave costs one 95 s gate. If main truly must be taken mid-review, the round
is VOID — say so, re-run the full gate, and open a fresh round under the same
caps. Never patch around it. See `execution-lanes.md` § Pin the fork.

First:

```bash
cd <worktree-root> && bash scripts/blast-radius.sh
```

It writes `docs/reviews/<branch>/blast-radius.md`, listing the importers of
every changed file. Typecheck catches signature breaks; it cannot catch a
semantic change whose callers relied on the old behavior.

Count the round, then launch the WHOLE wave in ONE message — parallel tool
calls, the moment the review gate is green. Never serially, never "spec first,
then standards":

```bash
bash scripts/feature-state.sh incr-round branch
```

The wave, per `execution-lanes.md` § The review wave (read it — it carries the
three rules that make the wave safe):

- **Spec & correctness agent** — the diff against the intake contract, field by
  field, plus `blast-radius.md`. Prompt in `review-prompts.md`, with its
  § Weakened checks brief appended on every lane.
- **Standards & maintainability agent (RISK = high, or a large diff)** —
  invoke `/thermo-nuclear-code-quality-review` on the branch directly. If
  unavailable or it errors, fall back to `/code-review` at high effort. On
  RISK = normal this axis runs only when the production diff exceeds the
  threshold in `execution-lanes.md` § The review wave; measure it, do not
  estimate it:

  ```bash
  git diff --numstat "$(git merge-base HEAD origin/main)"..HEAD \
    | awk '$3 !~ /(__tests__\/|\.test\.|\.spec\.)/ { n += $1 + $2 } END { print n+0 }'
  ```

  Record the number and the decision in the review report header either way.
- **Adversarial approach agent (RISK = high only)** — invoke
  `/codex:adversarial-review` with `--background --base <fork-point>`, handed
  the intake and triaged deviations paths. `--background` is not optional: the
  command otherwise stops on an `AskUserQuestion`, which parks the whole wave
  on an owner pause. If the plugin runtime errors, fall back to the codex
  rescue agent via direct `codex exec -m gpt-5.6-sol` (tier 3; `gpt-6-astra`
  at RISK = high). It challenges the approach and its assumptions, not
  line-level defects.

  Write the brief per `review-prompts.md` § Dispatching a Codex round — context
  in the brief, no cloned delegates. Record its session id; a branch
  verification round in rounds 2–3 resumes it rather than starting cold.
- **Red-team pass (RISK = high only)** — the `red-team` skill in a FRESH
  subagent (`Agent(model: "opus")`; adjudication of a contested finding goes
  to `fable`), on committed HEAD. It receives the locked intake, the pinned
  fork/merge-base/head SHAs and the claimed evidence — never your reasoning
  or the implementer's. Read `.claude/skills/red-team/SKILL.md` for the
  protocol. A RISK = normal wave carries no red-team member:
  `red-team-status.mjs` records the waiver from the signed-off intake
  (execution-lanes.md § The review wave). The owner may still request the
  pass; a sidecar that exists is always validated in full.

All agents receive the triaged deviations file and their axis's accepted-
findings checklist (`docs/reviews/finding-checklists/<axis>.md`, when it
exists) with the instruction "check the diff against every line". These are
defect classes real reviews accepted on real branches; a review starting from
zero re-buys them.

Route the mechanical passes — transcript logging, checklist sweeps, doc-claim
greps, blast-radius reading — to Haiku subagents (`Agent(model: "haiku")`).
The axes themselves run on `Agent(model: "opus")`, named explicitly — the
project default is `sonnet`, and a reviewer is never weaker than the author.
RISK = high raises the red-team pass and any contested finding to `fable`.

**Three wave rules, from the reference, restated because breaking one corrupts
a red-team pass:**

1. Review agents stage reports in `.feature/review-staging/<axis>.md`. The
   root copies them into `docs/reviews/<branch>/` after the finalizer returns.
   Not because a checker rejects them — `red-team-status.mjs` ignores
   untracked paths deliberately — but because red-team's post-restore
   assertion ("porcelain empty except this run's two report artifacts") is
   AGENT judgement, made exactly when it decides whether a mutation was
   restored. Staging removes the ambiguity rather than asking an agent to
   adjudicate it mid-pass.
2. The root edits NOTHING while the wave is in flight.
3. The FINALIZER belongs to the root, not the subagent.

**Confidence filter (all agents)**: the findings table contains ONLY findings
the agent would stake ≥80% confidence on, each with file:line and either a
concrete failure scenario or the named standard violated. Speculative "might be
nicer" observations go to a low-confidence appendix in the on-disk report —
never in the table, never triaged by default.

Every agent writes its full report to disk and returns only a findings table:
severity | file:line | one-line finding. Open a full report only for a finding
you are actively triaging.

**Round protocol**: round 1 is the full wave above. Rounds 2–3 are
**verification-only** — one agent per axis that had accepted findings, briefed
with that axis's findings table and the fix commits, verifying each fix landed
and introduced nothing new. A Codex axis RESUMES its round-1 session here
(`codex exec resume <id> "<delta>"`); a Claude axis gets a fresh agent, since
only the Codex side pays a seven-figure token cost to rebuild context. It may
NOT open new fronts; new unrelated findings go to the report appendix,
untriaged. Ask `bash scripts/feature-state.sh branch-round-owed <reviewed-sha>`
whether a round is owed at all — never `contract-changed`, which hashes the
plan and reads UNCHANGED after every code fix. After round 3, stop looping:
RISK = high surfaces the disagreement to the owner; RISK = normal makes the
call and records both positions in the review report AND the PR description.

**Triage the tables — a finding is a claim to verify, not an order.** For
each finding:

1. Read the whole table before acting; related findings change each other.
   If any finding is unclear, clarify it before fixing ANY of them.
2. Restate the finding in your own words, then check it against the code: is
   it correct for THIS codebase, would the fix break something, is there a
   reason for the current code, does the reviewer have the full context?
3. A suggestion to build something "properly": grep for real callers first.
   No callers means propose removal (YAGNI), not a fuller build.
4. A finding that conflicts with a locked intake or plan decision is the
   owner's call, not a fix.
5. Reject with technical reasoning and `file:line` evidence. If you cannot
   verify a finding, say what you would need rather than guessing.
6. Fix the real ones one at a time, in order — blocking (breakage, security),
   then simple, then complex — and test each fix before the next.

No performative agreement or thanks in verdicts: state the fix, or state the
reason for rejecting. A reply to an inline GitHub review comment goes in its
thread (`gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies`),
never as a top-level PR comment. Log verdicts as one-liners in the report file
so a resumed session inherits triage state. **COMMIT the review reports and triage
verdicts** — uncommitted reports vanish with the worktree at cleanup.

Re-run step 5, then go to step 7.5. **The phase does NOT move to `reviewed`
here.**

## 7.5 RED TEAM — finalize, prove, then set the phase

For RISK = high, the pass itself ran in step 7's wave. This step owns
everything that must happen after it, and it owns the `reviewed` transition,
so a high-risk phase can never claim reviewed without adversarial evidence.

**RISK = normal short path:** when the wave carried no red-team pass, skip
items 1–4 below. Run the final gate (item 5), run the checker (item 6 — it
prints WAIVED from the signed-off intake), then set the phase (item 7). If a
pass WAS run on a normal-risk branch, its sidecar exists and the full
sequence applies.

**Order is load-bearing — the report commit moves HEAD, so it happens BEFORE
the final gate, not after:**

1. **Finalizer, always** — the ORCHESTRATOR runs it, so a dead subagent cannot
   strand a mutation:

   ```bash
   node .agents/skills/red-team/scripts/mutation-runner.mjs finalize
   ```

2. Write and COMMIT `docs/reviews/red-team/<slug>/findings.{md,json}`, touching
   nothing else. Copy the staged review reports into `docs/reviews/<branch>/`
   in the same commit.
3. Apply the step 7 triage fixes. Re-run the gate loop until green.
4. **Round 2, scoped**: the fixes moved HEAD, so the sidecar is stale by
   construction. Re-run the red-team pass against the FIX HUNKS and their
   direct callers only. `round-start` refuses a third round outright — a P0
   here goes to the owner, with no round behind it.
5. Re-run the final gate LAST: `bash scripts/verify-gate.sh --review`.
6. Verify the evidence recomputes:

   ```bash
   node .agents/skills/feature/scripts/red-team-status.mjs
   ```

   It recomputes status from the inventory rather than trusting it, and fails
   on stale evidence, an amended intake, an unrestored mutation, or a high-risk
   open P1 with no recorded authorization.
7. Only now:

   ```bash
   bash scripts/feature-state.sh set-phase reviewed
   node .agents/skills/feature/scripts/progress.mjs step review done
   ```

**Findings bind this session.** A P0 blocks the PR and goes to the owner. A P1
on RISK = normal is yours to adjudicate; a P1 on RISK = high is the owner's.

**A rejected finding is never a silent skip**: a one-line verdict plus
`file:line` evidence in `findings.md`, mirrored in the JSON disposition, and
listed in a "Red-team findings rejected" section of the PR description.

## 8. SHIP — lane-dependent

**Before any external action, in both lanes**, re-run
`node .agents/skills/feature/scripts/red-team-status.mjs` (on RISK = normal it
passes by recording the waiver). It is the same cheap
command step 7.5 ran, and the commits between then and now — a staging ride, a
fix, a rebase — are exactly what makes that evidence stale. Open the PR with
`gh pr create --draft` (draft PRs run no CI), then run the checker once more
before `gh pr ready`: the PR body is the first place the rejected-findings
section becomes visible.

**If RISK = high** (worker / webhook / migration / billing / auth):

1. Ride staging first: land the branch on `staging` (push → full stack
   auto-deploys). Migrations apply to the staging Supabase project FIRST.
2. Verify on staging — smoke the touched path, using the matching runbook in
   `docs/runbooks/` when one exists.
3. Open the PR to `main`, confirm all CI checks green, then PAUSE for explicit
   merge approval. Apply the migration to prod Supabase in lockstep at
   promotion.

**If RISK = normal**: push, open the PR to `main`, confirm all CI checks green
(including fallow; React Doctor 100/100 only when SURFACE = ui), merge.

**After merge (both lanes)**:

- `git pull --ff-only` on local `main` (squash-merge lag).
- Realign `staging` per `deployment-guide.md` § "Re-sync staging".
  `git merge --ff-only main` succeeds only if staging was merely BEHIND; after
  a squash merge the branches diverged and ff aborts — the runbook's answer is
  `git reset --hard origin/main` + `--force-with-lease`. Do NOT substitute a
  sync merge: it leaves staging permanently ahead, which is the drift this step
  exists to prevent.
- **Worktree cleanup**: `bash scripts/feature-cleanup.sh` from the main
  checkout (dry run), review the plan, re-run with `--apply`. Never remove by
  hand with `--force`.
- **Deviations promotion**: read the deviations file and promote every durable
  lesson — root cause, test technique, library gotcha, constraint — into the
  lab notes (`.claude/reference/lab-notes/README.md` § "How to add a lab
  note": a dated entry in the newest `lab-notes/history/*.md`, plus the topic
  page when a current rule changes), the area's `.claude/rules/<area>.md`
  § Traps, or the CLAUDE.md gotchas. The deviations
  file stays as the historical record; the lesson must not live only there.
- Invoke `document-feature` to sweep docs and reference inventories.
- **Domain sweep**: apply `domain-modeling` once more — fold terms and
  decisions that emerged during implementation back into the owning
  `docs/context/<context>.md` (+ its `CONTEXT-MAP.md` row) and ADRs.
- **Change ledger**: add this change's row to `docs/agents/change-ledger.md`
  (the file defines the columns). `Named debt` comes from the review record.

```bash
node .agents/skills/feature/scripts/progress.mjs step ready done
node .agents/skills/feature/scripts/phase-cost.mjs
```

- **Cost read-back**: the second command prints the token bill per step
  (joined from the ladder's timestamps and the harness transcripts; see
  `progress-and-live-view.md` § Phase cost). Paste the table into the handoff
  doc's final section and name the most expensive step in one line. After
  five runs the pattern is the thing to trim next; a run that spent more on
  review than on execution says so here, not in a feeling.

## Session hygiene

State lives on disk; sessions are disposable. A fresh session reading files
beats a summarized one — auto-summarization is the safety net, not the plan.

- Update the handoff doc at the step 3→4 boundary and after step 7 — always,
  whether or not a restart follows.
- The step 3→4 checkpoint is a MODEL HANDOFF to a fresh tier-3 session whenever
  this session runs on `fable` (step 3, above) — always, not only when heavy.
- **Take the exit when the session is heavy.** After step 7 — and at step 3→4
  in a session that did not hand off — if this
  session has accumulated substantial non-disk context (long grilling, review
  tables, log digging), say in ONE line: `/clear`, then
  `/feature-resume <branch>`. That single keystroke is the entire cost; it is
  not an approval pause. After step 7 this is the default — reviews are the
  biggest context consumers and everything step 8 needs is on disk.
- If the harness summarizes anyway, do not trust the summary for state.
  Re-read `.feature/state.json`, the handoff doc and the plan.
- `/feature-resume <branch>` equally covers interruption recovery.

A resumed session bootstraps from: handoff doc → spec → plan → deviations file
→ review findings tables. It never needs the prior transcript.
