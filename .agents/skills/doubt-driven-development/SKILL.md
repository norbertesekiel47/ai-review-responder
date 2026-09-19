---
name: doubt-driven-development
description: Puts one non-trivial decision in front of a fresh-context reviewer whose job is to disprove it, while changing course is still cheap. Use OUTSIDE a guarded /feature run — on the small lane in unfamiliar code, for an ad-hoc architectural or concurrency claim ("this is safe", "this is idempotent", "this matches the spec"), and before an irreversible operation such as applying a migration, flipping a flag, or resetting a branch. Skip for mechanical edits, one-line changes, clear instructions, or when the owner asked for speed. Inside a guarded run the plan skeptic and the review wave already are the doubt step — do not stack this on top.
---

# Doubt-Driven Development

A confident answer is not a correct one. Long sessions quietly turn
assumptions into "facts". This skill materializes a reviewer with none of that
context, biased to DISPROVE, before a non-trivial decision stands.

It is not `/code-review`. That is a verdict on a finished diff. This is an
in-flight posture: one decision, one small artifact, a bounded loop.

## When a decision is non-trivial

At least one is true:

- it adds or changes branching logic across a module or service boundary;
- it asserts a property no compiler checks — idempotence, ordering, atomicity,
  tenant isolation, "the lock spans this work";
- its correctness depends on context a future reader cannot see;
- it cannot be undone with `git revert` — a migration applied, a flag flipped
  in production, a provider call, a force-push.

If you doubt every keystroke you ship nothing. One-line changes, renames,
formatting, reading code, and running tools are out of scope.

## Where it fits in RepWorth

| Situation | Doubt step |
|---|---|
| Guarded `/feature` run, high risk | Already built in: plan skeptic, review wave, red team. Do not add this. |
| `/feature-small` in code you do not understand | One doubt cycle on the key decision, before the code |
| Ad-hoc claim in a session ("FOR UPDATE protects this") | One doubt cycle |
| About to apply a migration, flip a flag, reset `staging` | One doubt cycle on the exact command and its preconditions, plus the owning skill (`new-migration`, `flag-flip`) |

A failing test written first is doubt made concrete: for a behavioral claim,
TDD's RED step IS the doubt step.

## The cycle

```
- [ ] 1 CLAIM     — the claim and why it matters, in two or three lines
- [ ] 2 EXTRACT   — the artifact and its contract; reasoning stripped
- [ ] 3 DOUBT     — fresh-context reviewer, adversarial prompt
- [ ] 4 RECONCILE — every finding classified against the artifact text
- [ ] 5 STOP      — trivial findings, 3 cycles, or the owner says ship
```

**1 CLAIM.** If you cannot write it this compactly you have a vibe, not a
decision:

```
CLAIM: the publisher re-checks subscription state inside the same
       transaction that marks the response posted.
WHY:   a cancelled account could otherwise post publicly once.
```

**2 EXTRACT.** The reviewer needs the ARTIFACT (the diff, the function, or the
proposal in 3–5 sentences) and the CONTRACT (the invariants and acceptance
cases it must satisfy) — not the journey. Small enough to hold in one read; a
500-line change is decomposed first.

**3 DOUBT.** Spawn a fresh subagent. Framing decides the answer:

```
Adversarial review. Find what is wrong with this artifact. Assume the
author is overconfident. Look for: unstated assumptions, unhandled edge
cases, hidden coupling or shared state, ways the contract can be violated,
repository conventions this breaks, failure modes under unexpected input.
You may read the surrounding source to check the contract.
Do NOT validate. Do NOT summarize. Find issues, or state explicitly that
you found none after thorough examination.

ARTIFACT: <paste>
CONTRACT: <paste>
```

Pass ARTIFACT + CONTRACT only. **Never pass the CLAIM or your reasoning** —
hand over a conclusion and you get it back validated.

**Cross-model.** A same-model reviewer shares the author's blind spots. When
the decision touches authorization, tenancy, billing, public posting, a
migration, or concurrency, offer the owner a Codex pass
(`/codex:adversarial-review`, or a read-only `codex exec`) and say which was
run. For other decisions, state "single-model review" in the output and move
on. Never invoke an external CLI without the owner's authorization, always
read-only, and never interpolate the artifact into a shell argument — write the
prompt to a scratch file and pipe it on stdin. If the tool fails, say so; do
not fall back silently.

**4 RECONCILE.** The reviewer's output is data, not a verdict. Re-read the
artifact against each finding, then classify — first match wins:

1. **Contract misread** — the contract you wrote was unclear. Fix it, re-run.
2. **Valid and actionable** — change the artifact, re-run.
3. **Valid trade-off** — real, but fixing costs more than accepting. NAME it in
   the record (`working-rules.md` § No unacknowledged debt).
4. **Noise** — correct under context the reviewer lacked. Note it, and ask
   whether the contract should have carried that context.

A fresh reviewer can be wrong because it lacks context. Disagreement is
information, not a verdict.

**5 STOP.** Stop when a cycle returns only trivial or already-considered
findings, after 3 cycles, or when the owner says ship. Three cycles with
substantive findings still open is information about the artifact: surface it,
do not grind a fourth. If 3 cycles is "obviously too few", the artifact is too
big — return to step 2.

## Red flags

- A reviewer spawned for a rename or a one-line change.
- "Is this good?" instead of "find issues".
- The CLAIM or the reasoning passed to the reviewer.
- Reviewer output accepted without re-reading the artifact.
- **Doubt theater:** two cycles with substantive findings and none classified
  actionable. You are validating. Stop and escalate.
- Re-running on an unchanged artifact.
- Used from inside a subagent, where a fresh reviewer cannot be spawned —
  hand the decision back to the main session instead.
- Stacked on top of a guarded run's plan skeptic.

Adapted for RepWorth from `doubt-driven-development` in
addyosmani/agent-skills @ `c004a74` (MIT). Notice:
`docs/agents/third-party-skills.md`.
