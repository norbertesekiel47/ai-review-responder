---
name: feature-resume
description: Resume a RepWorth `$feature` run from its sibling worktree and durable machine state. Use when the user explicitly invokes `$feature-resume`, asks to continue an in-flight guarded feature, or provides a feature branch whose intake, gate, review, or shipping state must be reconciled before continuing.
---

# Feature Resume

Use the branch named in the user's current request. Reconstruct from Git and
durable artifacts, not the prior conversation. Act as the accountable root
Codex agent; do not delegate reconciliation.

## 1. Locate without mutating

Run `git worktree list --porcelain` from the RepWorth repository and find the
unique worktree whose branch matches the request. If it is missing or
ambiguous, stop and ask. Never recreate, switch, merge, rebase, or clean a
worktree while locating it.

Use the absolute worktree path for every edit and prefix every shell command
with an explicit `cd <worktree-root> && ...`.

## 2. Re-arm and validate

From the worktree:

```bash
cd <worktree-root> && bash scripts/arm-check.sh
cd <worktree-root> && node .agents/skills/feature/scripts/validate-intake.mjs .feature/intake.json
```

Require `ARMED` and a valid intake. A missing intake means this is not a
resumable guarded run; stop rather than synthesizing one.

## 3. Reconcile authoritative evidence

Read in this order:

1. Git branch, merge-base, HEAD, status, recent feature commits, and worktree
   registry.
2. `.feature/intake.json` and the matching durable intake copy.
3. `.feature/state.json`.
4. `.feature/gate-status.json` and the Codex gate fingerprint.
5. The spec and plan referenced by the intake/handoff.
6. Deviations and root-triaged review findings.
7. Handoff prose, if present.

Run the fingerprint check whenever its file exists:

```bash
cd <worktree-root> && node .agents/skills/feature/scripts/gate-fingerprint.mjs check
```

A missing, red, or stale fingerprint means verification is incomplete even if
the repository gate file says green. Do not repair that by rewriting state;
rerun the verified gate at the appropriate phase.

Surface before editing:

- unexpected dirty or untracked files
- intake-copy mismatch
- `state.headSha` differing from HEAD
- `state.intakeSha256` differing from the intake
- branch drift from `origin/main`
- review output without root `ACCEPT`/`REJECT` triage
- external actions claimed without verifiable evidence

Read [recovery.md](../feature/references/recovery.md) if any inconsistency
prevents a unique next action.

## 4. Select exactly one next phase

Do not reread every workflow section. Dispatch from reconciled state:

| Current evidence | Next action |
|---|---|
| worktree armed, no approved plan, `small` | transition to `executing` and implement |
| `worktree_ready`, `standard` or `high` | finish or obtain approval for the plan |
| `plan_approved` | transition to `executing` and start the next tracer |
| `executing`, incomplete tracer | continue that tracer only |
| `executing`, implementation complete | run `verified-gate.sh --review` |
| green current fingerprint, reviews incomplete | run the required review axes |
| accepted review fixes pending | transition to `executing`, fix, and reverify |
| green current fingerprint, triage complete | transition to `reviewed` |
| `reviewed` | report review-ready and wait for explicit external authority |
| `shipped` | verify the external outcome before proposing cleanup |

Use the guarded transition wrapper for manual phase changes:

```bash
cd <worktree-root> && node .agents/skills/feature/scripts/transition-state.mjs <phase>
```

If state and evidence imply different rows, evidence wins. State the mismatch
and repair the phase only after the correct next action is established.

## 5. Continue under the relevant feature section

Read `.agents/skills/feature/SKILL.md`, then load only the reference needed by
the selected phase:

- intent/intake: `references/intake-contract.md`
- planning/execution: `references/execution-lanes.md`
- review: `references/review-prompts.md`
- external action: `references/shipping-boundaries.md`
- inconsistent state: `references/recovery.md`

Update the live Codex task plan to reflect the reconstructed phase. Report in
one concise line: current phase, exact next action, and reconciliation flags.
Then continue without asking for prior transcript context.
