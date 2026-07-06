---
description: Orchestrate a feature end-to-end — brainstorm, plan, subagent execution, verify gate, dual review, ship via the right lane
argument-hint: <feature description>
---

# Feature Workflow

Feature request: $ARGUMENTS

You are the orchestrator. Brainstorming, planning, and review triage happen in
THIS session (they need me in the loop). Only implementation is delegated to
subagents. Never delegate intent-locking to an agent that cannot talk to me.

## 0. CLASSIFY — pick the lane before doing anything

Read the request and the code it touches, then classify:

- **RISK = high** if it touches: worker/, webhook ingress, a migration or
  schema change, billing/Stripe, approval or auto-approval paths, auth.
  Otherwise **normal**.
- **SURFACE = ui** if it touches `src/app/` or `src/components/`;
  **backend** otherwise; **mixed** if both.
- **SIZE = trivial** if ≤ ~30 lines with no schema/API/contract change.

**TRIVIAL FAST PATH**: skip steps 1–4, 6, and 8. Branch, implement directly
in this session, run the step 5 gate, one `/code-review` pass, PR, done.

State the classification in one line before proceeding.

## 1. BRAINSTORM — in this session

Invoke `superpowers:brainstorming`. Interview me until intent is locked into a
spec. Do not proceed on guesses about what I meant.

## 2. SETUP — sibling worktree

`pnpm worktree:new <branch>` with a branch name derived from the locked spec.
Every subsequent edit targets that worktree root — never the parent checkout.

## 3. PLAN — in this session

Invoke `superpowers:writing-plans`; write the plan to
`docs/superpowers/plans/`. If DB-touching, read
`.claude/reference/migrations-log.md` before writing the migration step.

**If RISK = high, gate the plan before executing:**
1. Dispatch the codex rescue agent (read-only) to adversarially review the
   plan document: challenge assumptions, missing failure modes, and simpler
   alternatives; require an explicit `VERDICT: APPROVED` or `REVISE` with
   reasons. Revise and re-submit until APPROVED (max 3 rounds — after that,
   surface the disagreement to me instead of looping).
2. Then show me the approved plan and wait for my sign-off.

## 4. EXECUTE — delegated

Invoke `superpowers:subagent-driven-development` FROM this session: dispatch
fresh per-task subagents against the worktree, TDD where the behavior is
specifiable up front. Commit per completed task on the branch.

## 5. VERIFY GATE — cheap, before any review

Must be fully green before any review starts, and re-run after every fix round:

- Always: `pnpm lint && pnpm typecheck && pnpm test`
- Always (CI runs them; catching here saves a wasted review):
  `pnpm ci:static-policy && pnpm ci:analytics-events`
- If DB-touching: `pnpm ci:tenant-scope && pnpm ci:rls-audit`
- If SURFACE includes ui: `pnpm build`

Use `superpowers:verification-before-completion` discipline: evidence before
claims.

## 6. REVIEW 0 — ADVERSARIAL (approach challenge)

PAUSE and ask me to run `/codex:adversarial-review` on the branch (it is
user-invocable only). This challenges the chosen approach, design choices,
and assumptions — not implementation defects. Triage its findings with
`superpowers:receiving-code-review`: a valid approach-level finding may mean
revisiting the plan (step 3), not just patching code. Re-run step 5 after any
change.

## 7. REVIEW 1 — CORRECTNESS

Spawn a fresh agent (codex rescue agent) to review the branch diff for bugs.
Triage findings with `superpowers:receiving-code-review`: fix what is real,
reject the rest with stated reasoning. Re-run step 5.

## 8. REVIEW 2 — MAINTAINABILITY

PAUSE and ask me to run `/thermo-nuclear-code-quality-review` on the branch
(it is user-invocable only). If I decline or it is unavailable, run
`/code-review` at high effort as the substitute. Triage + fix the same way.
Re-run step 5.

## 9. SHIP — lane-dependent

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
- Remove the sibling worktree and delete the merged branch.
- Invoke the `document-feature` skill to sweep docs/reference inventories.
