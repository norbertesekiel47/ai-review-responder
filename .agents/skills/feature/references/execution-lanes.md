# Execution lanes

## Classification

### Size

- `trivial`: roughly 30 changed lines, no interface/schema/contract change.
- `small`: roughly 150 changed lines across a few files and one seam, no new
  dependency or migration.
- `standard`: a reviewable feature with a tight surface and no more than about
  eight tracer bullets.
- `epic`: multiple risk domains, broad top-level surfaces, more than about
  eight tracer bullets, or unresolved investigation questions.

### Risk

Use `high` when failure can affect money, authorization, tenant isolation,
public posting, durable data, webhooks, workers, migrations, production
operations, or recovery. Otherwise use `normal`. When uncertain, select high
and name the uncertainty.

Risk also decides the red-team requirement (2026-08-31 risk-gate change):
`high` requires the adversarial pass and `red-team-status.mjs` fails its
absence; `normal` may omit it, and the checker records a WAIVED pass derived
from the signed-off intake. The failure direction stays safe: an uncertain
classification selects `high`, and a missing or unreadable intake fails
closed, never waives.

## Lane behavior

### Trivial

- Use the current safe branch unless repository policy requires isolation.
- Do not create workflow documents.
- Implement in the root context.
- Run the narrowest relevant test plus repository-required verification.
- Perform one compact root review.
- Claude lane: `/feature-small` owns this lane end to end.

### Small

- Resolve at most the material unknowns needed for a compact intake — six
  fields, posted once, no sign-off at normal risk.
  The fields are goal, non-goals, observable behavior, allowed files, verification,
  and reversible assumptions. This brief stays in the task; it is not the
  guarded JSON schema or an armed `.feature/intake.json`.
- Branch in the current checkout. Use a sibling worktree only when another
  feature is in flight there, when the checkout is dirty in files the change
  must touch, or when starting from a long-lived branch. Isolation is a tool,
  not a ceremony; the arming scripts are not run on this lane at normal risk.
- Implement in the root context. No plan document or implementation delegation.
- Gate by RUNNING the pre-push hook, then the full suite and the build:
  `pnpm exec lefthook run pre-push --force --no-tty && pnpm test && pnpm build`.
  `--force` is load-bearing: without it lefthook SKIPS every check when no
  commit is waiting to be pushed, and the gate goes green in 0.3 s having run
  nothing. `lefthook.yml` owns the audit list; never re-spell it. Skip the build only
  for a docs-only change.
- Perform one fresh spec/correctness review after the gate.
- Claude lane: `/feature-small` owns this lane end to end at normal risk;
  small work at high risk stays in the full router with an abbreviated intake.

### Standard

- Lock the full intake and obtain sign-off.
- Use a sibling worktree and plan tracer bullets.
- The first tracer establishes precedent, and who writes it differs by
  harness: root Codex implements it in the root context; the Claude lane hands
  off at plan approval and implements nothing in the planning session (the
  mechanism is § Model handoff at plan approval).
- Delegate later work only when tasks have disjoint edit leases and concrete
  parallel value.
- Run the spec/correctness review; add the maintainability review only when
  risk is high or the production diff crosses the threshold in § The review
  wave.

### High

- Apply the standard lane plus rollback, observability, and authority-boundary
  requirements.
- When a `risk_reason` names a trust boundary (authorization, tenancy, billing,
  public posting, a webhook, a token, LLM input or output, personal data), read
  the `security-and-hardening` skill BEFORE writing the plan. Its output is the
  security contract on each tracer and the negative test titles in
  `tests_to_add` — security shapes the design; it is not a final-review step.
- Require a read-only plan skeptic before execution. It is this lane's doubt
  step; do not stack `doubt-driven-development` on top.
- Add only the relevant risk review: security/authorization, database/tenancy,
  billing, async/operations, or UI accessibility.
- Stop review-ready. Never infer staging or production authority.

### Epic

- Do not implement.
- Sharpen the domain model and record hard-to-reverse decisions.
- Separate investigation tickets from implementation tickets.
- Declare blocking edges and make every implementation ticket fit a standard
  or high feature run with a tight surface.

## Tracer bullets and TDD

Each tracer bullet must include:

- one vertical observable behavior, with its negative cases
- the owning module and the repository precedent it follows
- the security contract, when the slice crosses a trust boundary: actor,
  tenant boundary, authorization, untrusted input, side effects, failure and
  recovery — with at least one negative test title (wrong tenant, missing
  authorization, replayed or stale input)
- the invariants it must not break
- the public test seam
- exact test title or deterministic check
- blocking edges
- allowed files
- completion evidence

**The plan is a behavior contract, not an implementation.** It carries enough
to prevent architectural improvisation and no more. A plan of complete code
steps is a plan failure: code written before a test has run is a first draft
that execution then writes again, and the plan and the code must then both be
maintained. Show code only where a sentence would stay ambiguous — a tricky
interface signature, a SQL shape an invariant depends on, a type another
tracer consumes.

**Validate the test strategy first; write tests per slice.** The plan maps
every promised test title to its tracer and seam. Each tracer authors its own
failing tests at its start. Do not author every test body before the first
tracer: those bodies encode guesses about seams the first slice corrects.

For new behavior or a bug fix, run red → minimal green one tracer at a time.
For a behavior-preserving refactor, establish characterization coverage and
keep it green. Do not test private helpers or duplicate implementation logic in
assertions. Property-test billing, approval/autonomy, escalation, or other
state-machine invariants when examples cannot cover the state space.

## Delegation contract

Delegate only a concrete bounded task that can progress independently.
Provide:

- absolute worktree path
- allowed files (the edit lease)
- forbidden overlapping files
- spec slice and glossary excerpt
- test seam and exact expected evidence
- blocking-task context
- instruction not to commit, push, deploy, or widen scope
- a concise return format

Never dispatch two editing agents with overlapping leases. Prefer a read-only
subagent when the task is diagnosis, research, design comparison, or review.
The root agent inspects every resulting diff and owns integration.

## Model routing — the cheapest tier that meets the same acceptance bar

A frontier model on a grep is waste; a cheap model inventing a transaction
design is a defect. Route by what the task DEMANDS, never by habit. Every
dispatch names its model explicitly — an unnamed Claude subagent falls to the
project default (`CLAUDE_CODE_SUBAGENT_MODEL` in `.claude/settings.json`,
`sonnet`), and without that default it would inherit the lead's model, which is
how one Fable session once made every helper a Fable call.

| Tier | Claude (`Agent(model: …)`) | Codex (`-m …`) | Use for |
|---|---|---|---|
| 1 mechanical | `haiku` | `gpt-5.6-luna` | file and symbol search, greps, log and checklist sweeps, blast-radius reading, fixtures, renames, doc cross-reference fixes |
| 2 standard | `sonnet` | `gpt-5.6-terra` | a tracer whose behavior contract is complete; the whole `trivial`/`small` lane at normal risk; routine test writing |
| 3 strong | `opus` | `gpt-5.6-sol` | multi-module integration, difficult debugging, writing a standard-lane plan, EVERY review axis, fix verification rounds |
| 4 frontier | `fable` | `gpt-6-astra` | the high-risk plan and its security contract, the plan skeptic, red-team adjudication, an architecture or concurrency decision, a review disagreement nobody has resolved |

Rules that keep the savings honest:

- **The lead session follows the same table.** Run `small` work on tier 2 and
  standard work on tier 3; switch the session up (`/model`, `codex -m`) for a
  tier-4 step and back down after it. A command's `model:` frontmatter lasts
  one turn, so the session default is the real lever.
- **A reviewer is never weaker than the author, and never below tier 3.**
  Green tests from a cheap author reviewed by a cheap reviewer prove nothing.
- **Escalate, do not grind.** A failed check or `NEEDS_CONTEXT` gets more
  context on the same tier ONCE. A reasoning failure moves up one tier. Two
  failures at tier 3 go to tier 4 or to the owner.
- **Never decided below tier 3:** authorization, tenant scope, transaction or
  outbox shape, migration design, idempotency keys, concurrency, anything in
  `risk_reasons`. A lower tier may IMPLEMENT such a decision from a complete
  contract; it stops and escalates before inventing one.
- **Cost never changes the gate.** Every tier's output meets the same tests,
  the same audits, and the same review. A saving bought with a skipped check,
  hidden repair, or a later defect is not a saving (`docs/agents/change-ledger.md`
  records the `Lead` tier so the 10-change review can see which routes held).
- Model IDs drift. Verify Codex IDs against `~/.codex/sessions` or the model
  picker before editing this table; aliases on the Claude side track the
  current generation.

### Model handoff at plan approval

Planning is tier-4 work; implementing an approved plan is tier-3 work. A
session cannot change its own model, and `/clear` keeps it, so the switch is a
NEW session. At the step 3→4 checkpoint of a guarded run, a planning session
that runs on tier 4 (`fable`, `gpt-6-astra`) does this and nothing else:

1. Record the phase and write the handoff doc, as the checkpoint already requires.
2. Run `node .agents/skills/feature/scripts/progress.mjs handoff`.
3. Print its output VERBATIM as the last thing in the reply, and stop.

The command prints the launch line on the tier-3 model (`claude --model opus`,
or `codex -m gpt-5.6-sol`) and the prompt to paste (`/feature-resume <branch>`,
or `$feature-resume <branch>`). It refuses unless the phase is `plan_approved`
and the handoff doc exists, because a fresh session has only the disk. **The
owner pasting that prompt IS the sign-off to implement** — the fresh session
reconciles and goes straight to step 4 with no second approval pause.

Do not compose the block by hand, and do not implement "just the first tracer"
in the planning session. Skip the handoff only when the planning session
already runs on tier 3 or below, or when it is a `/feature-swarm` subagent
(already dispatched on a named model, with nobody to paste anything). The light
lanes have no plan and no handoff: run them on tier 2 from the start.

## The review wave — one parallel dispatch, red team when risk is high

Both lane routers dispatch ONE wave, in ONE message, the moment the review
gate is green. The wave contains every required review axis for the lane
(above) **and, when `risk` is `high`, the red-team pass**. They all read the
same committed SHA, and none of them may edit, so wall clock is the slowest
member, not the sum.

A `normal`-risk wave carries no red-team member: the deterministic gate, the
promised-tests row, and the review axes are that lane's safety layer, and the
adversarial pass's cost (174 minutes measured on feat/1008) must scale with
failure impact. `red-team-status.mjs` records the waiver mechanically from
the signed-off intake — never from a claim made at transition time. The owner
may still request the pass on a normal-risk branch; a sidecar that exists is
always validated in full.

**The standards axis is conditional the same way.** On `normal` risk the
wave carries the spec/correctness axis alone unless the production diff —
added plus deleted lines outside `__tests__/`, `*.test.*` and `*.spec.*`,
measured from the fork point with `git diff --numstat` — exceeds **300
lines**. Above that, or on `high` risk, the maintainability axis joins the
wave. The threshold is a measurement, never an estimate from the intake:
a 120-line normal-risk change reviewed by two strong-model agents plus
Haiku helpers was the wave's common case, and its second axis found little
the first had not. The measured number and the decision go in the review
report header so a resumed session does not re-decide it.

Red team used to run after review triage and its fixes. That put a full
adversarial pass on the critical path twice over: once to find defects, once
because the fixes invalidated its evidence. In the wave it runs against the
pre-fix tree, and only the fix hunks need a second look.

Four rules make the wave safe:

1. **Review agents stage their reports outside git.** Each axis writes to
   `.feature/review-staging/<axis>.md` while the wave runs. The root copies
   them into `docs/reviews/<branch>/` after the finalizer returns.

   Be precise about why. This is not a mechanical failure being avoided:
   `red-team-status.mjs` reads `git status --porcelain --untracked-files=no`
   on purpose, and red-team precondition 1 speaks of *tracked* modifications,
   so a sibling's untracked report fails neither. What it does break is the
   AGENT's post-restore assertion in `red-team/SKILL.md` — "porcelain must be
   empty on every path except this run's two report artifacts" — which is
   judgement, applied at the exact moment the agent decides whether a mutation
   was restored. Staging removes that ambiguity instead of asking an agent to
   adjudicate it mid-pass. A report written into red-team's own report
   directory would additionally trip the finalizer's refusal to overwrite
   content it did not write.
2. **The root edits nothing while the wave is in flight.** Triage fixes wait
   for the red-team finalizer, exactly as the gate waits for subagents.
3. **The finalizer still belongs to the root**, never the subagent, so a dead
   agent cannot strand a mutation.
4. **Every read-only axis reads a COMMITTED SHA, never the working tree.**
   Name the SHA in the axis prompt and say to read with `git show <sha>:<path>`.

   Rules 1-3 protect the TREE: the journal and the finalizer guarantee the
   mutation is restored. None of them protects a concurrent READER, and when
   the wave carries the red-team pass one member is mutating source files in
   the shared worktree while the others read it. On feat/1013 the
   spec-correctness axis found the tree dirty throughout its review and
   observed three live mutations — including the exact `threshold !== null`
   deletion its own first finding predicts. Its conclusions stand only because
   it noticed and fell back to `git show HEAD:` unprompted. An axis that had
   trusted the working tree would have reviewed a MUTANT: reporting defects
   that do not exist at HEAD, or missing ones that do.

   Serialising the wave would also fix it, and would spend the wall clock the
   wave exists to save. Giving red team its own worktree is the other answer;
   this rule is the cheap one, and it holds whether or not the pass is present.

Order after a wave that carried the pass: finalize → commit the red-team
report → triage every axis together → fix → gate → the scoped second red-team
round → full review gate → status check → `reviewed`. A normal-risk wave with
no pass collapses to: triage → fix → gate → full review gate → status check
(it prints WAIVED) → `reviewed`.

When the pass ran, the second round is scoped to the fix hunks and their
direct callers, and it is not optional: fixes always land after the wave, so
the sidecar is always stale against HEAD by then. This spends the two-round
cap by design. A P0 found in round 2 has no round 3 behind it — take it to
the user, the same answer the cap has always given.

## Pin the fork — do not take main after the wave opens

The single most expensive event measured in a `/feature` run was not a slow
reviewer. It was a rebase. On feat/1008, **67 of red team's 174 minutes** went
to one post-rebase re-run (23:51 → 00:58, commit "post-rebase red-team"),
re-proving work that had already been proven.

The rule, and it is mechanical:

- **Take main BEFORE step 7.** The moment to rebase or merge `origin/main` is
  the step 3→4 checkpoint, or immediately before the review gate that opens
  the wave. Never between.
- **From the moment the wave dispatches, the fork point is FROZEN.**
  `blast-radius.sh`, the review axes and the red-team pass all pin
  fork/merge-base/head once; every later command uses those recorded SHAs, not
  a ref that can move.
- **If main genuinely must be taken mid-review, the round is void — say so and
  restart it.** Do not patch around it. Every piece of evidence behind the wave
  (gate result, fingerprint, red-team sidecar, blast radius) was derived from a
  tree that no longer exists, and `red-team-status.mjs` will refuse the
  `reviewed` transition on exactly that basis. Take main, re-run the full gate,
  then open a fresh round under the same caps.

Cost asymmetry is the whole argument: taking main before the wave costs one
gate run (95 s). Taking it during the wave costs a full adversarial pass.

A branch far behind main still rots, so the pre-wave check stays — it just has
a deadline. `/feature-resume` reports main drift on resume for this reason; act
on it while the phase is `plan_approved`, `executing` or `gate_green`, never
once the wave is open.

## Conditional verification rounds

A verification-only round (plan rounds 2-3, branch rounds 2-3) exists to
confirm that the fixes for round 1 did not break what round 1 approved. When
the fixes moved nothing, the round re-reads unchanged material at full cost.

Decide it mechanically, never by judgement. The two artifacts need two
different questions.

**Plan rounds** — did the reviewed plan's contract move?

```bash
bash scripts/feature-state.sh record-contract <plan.md>   # at round start
bash scripts/feature-state.sh contract-changed <plan.md>  # after the fixes
```

The contract is the intake's `allowed_edit_surface`, the intake's
`tests_to_add`, and the plan's heading structure. `CHANGED` owes a round.
`UNCHANGED` skips it — self-verify each fix against the findings table and
record that decision in the plan's review appendix, so a reader sees a
skipped round and its reason rather than a silent gap. A missing snapshot
reads as `CHANGED`. Intake `risk=high` always reads `CHANGED`: a prose-only fix
can rewrite an invariant under an unchanged heading.

**Branch rounds** — did the tree move since the SHA round 1 reviewed?

```bash
bash scripts/feature-state.sh branch-round-owed <reviewed-sha>
```

`OWED` when any tracked file differs from that SHA, committed or not
(`docs/reviews/` excluded — a staged report is not a fix). Scope the round to
the fix hunks and their callers. `NOT_OWED` only when nothing was fixed. Never
answer a branch round with `contract-changed`: a code fix touches neither the
intake nor the plan headings, so that hash reads `UNCHANGED` after every fix
and would skip the one round that verifies it. An unknown SHA reads `OWED`.

This changes WHEN a round is owed. It never raises the caps: three plan
rounds, three branch rounds, two red-team rounds.

## The gate loop — fast inside, full at the boundary

After a RED gate, loop unattended. Read `bash scripts/gate-summary.sh`
(failing rows and log tails only), fix, count the round, re-run:

```bash
bash scripts/feature-state.sh incr-gate-round
bash scripts/verify-gate.sh --fast
```

`--fast` runs the same rows and narrows exactly three of them against the
last green SHA: the test row becomes `--changed`, `pnpm build` is skipped
when nothing it compiles moved, and the test DB is re-provisioned only when a
migration moved. Measured on a real DB-touching branch: **25 s against 95 s**.

A fast run is never evidence. It writes `.feature/gate-fast.json`, leaves
`.feature/gate-status.json` alone, advances no phase, and resets no budget —
the Stop hook reads only `gate-status.json` and ignores `mode`, so routing a
fast result there would silently authorize finishing a session. Run the full
gate at every boundary that matters:

- before the review wave: `verified-gate.sh --review`
- after the fixes: `verified-gate.sh --review`
- any time HEAD moves for any reason

The budget is unchanged: the 4th fail round refuses without an owner reason,
and a full green resets it.

## Reclassification and anti-thrash

Stop and reclassify when production or test churn exceeds twice its estimate,
the edit surface needs a second amendment, or a deviation invalidates a locked
decision. After the same failure class twice, switch from patching to a fresh
diagnosis loop. After three full red gate rounds, stop and take the evidence to
the user.
