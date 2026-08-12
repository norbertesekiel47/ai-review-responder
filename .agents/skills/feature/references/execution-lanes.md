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

## Reclassification and anti-thrash

Stop and reclassify when production or test churn exceeds twice its estimate,
the edit surface needs a second amendment, or a deviation invalidates a locked
decision. After the same failure class twice, switch from patching to a fresh
diagnosis loop. After three full red gate rounds, stop and take the evidence to
the user.
