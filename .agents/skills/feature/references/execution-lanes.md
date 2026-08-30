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

## Lane behavior

### Trivial

- Use the current safe branch unless repository policy requires isolation.
- Do not create workflow documents.
- Implement in the root context.
- Run the narrowest relevant test plus repository-required verification.
- Perform one compact root review.

### Small

- Resolve at most the material unknowns needed for a compact intake.
- Use a sibling worktree when starting from a long-lived branch or when the
  current checkout is dirty.
- Implement in the root context.
- Perform one fresh spec/correctness review after the verified gate.

### Standard

- Lock the full intake and obtain sign-off.
- Use a sibling worktree and plan tracer bullets.
- Root Codex implements the first tracer to establish precedent.
- Delegate later work only when tasks have disjoint edit leases and concrete
  parallel value.
- Run parallel spec/correctness and maintainability reviews.

### High

- Apply the standard lane plus rollback, observability, and authority-boundary
  requirements.
- Require a read-only plan skeptic before execution.
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

- one vertical observable behavior
- the public test seam
- exact test title or deterministic check
- blocking edges
- repository precedent
- allowed files
- completion evidence

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

## The review wave — one parallel dispatch, red team included

Both lane routers dispatch ONE wave, in ONE message, the moment the review
gate is green. The wave contains every required review axis for the lane
(above) **and the red-team pass**. They all read the same committed SHA, and
none of them may edit, so wall clock is the slowest member, not the sum.

Red team used to run after review triage and its fixes. That put a full
adversarial pass on the critical path twice over: once to find defects, once
because the fixes invalidated its evidence. In the wave it runs against the
pre-fix tree, and only the fix hunks need a second look.

Three rules make the wave safe:

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

Order after the wave: finalize → commit the red-team report → triage every
axis together → fix → gate → the scoped second red-team round → full review
gate → status check → `reviewed`.

The second round is scoped to the fix hunks and their direct callers, and it
is not optional: fixes always land after the wave, so the sidecar is always
stale against HEAD by then. This spends the two-round cap by design. A P0
found in round 2 has no round 3 behind it — take it to the user, the same
answer the cap has always given.

## Conditional verification rounds

A verification-only round (plan rounds 2-3, branch rounds 2-3) exists to
confirm that the fixes for round 1 did not break what round 1 approved. When
the fixes moved nothing the artifact contracts on, the round re-reads
unchanged prose at full cost.

Decide it mechanically, never by judgement:

```bash
bash scripts/feature-state.sh record-contract <plan.md>   # at round start
bash scripts/feature-state.sh contract-changed <plan.md>  # after the fixes
```

The contract is the intake's `allowed_edit_surface`, the intake's
`tests_to_add`, and the plan's heading structure. `CHANGED` owes a round.
`UNCHANGED` skips it — self-verify each fix against the findings table and
record that decision in the artifact's review appendix, so a reader sees a
skipped round and its reason rather than a silent gap. A missing snapshot
reads as `CHANGED`, so the failure direction is always "review it".

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
