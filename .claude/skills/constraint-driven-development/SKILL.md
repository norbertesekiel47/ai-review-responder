---
name: constraint-driven-development
description: Guards RepWorth's quality bar against being quietly lowered, and governs how the bar itself changes. Use when a change goes green by weakening a check (a skipped or deleted test, stripped assertions, a new suppression, a widened allowlist, a lowered threshold, a stub left in place), when reviewing REVIEW rows from `pnpm ci:weakened-checks`, when adding, moving or removing a quality gate or deciding where a new check runs, or when choosing a threshold. Never creates a CONSTRAINTS.md — the bar already has owners here.
---

# Constraint-Driven Development

An agent writes more in an afternoon than the owner reads in a week, so the
judgement has to live in checks that run around the loop. Agents do not craft
clever loopholes: they hit a red check and take the cheapest road to green.
This skill is about that road.

## The bar already exists — do not write a second one

Upstream, this skill interviews the user and writes `CONSTRAINTS.md`. RepWorth
does not need that and must not get it: one owner per fact.

| What | Owner |
|---|---|
| The list of audits | the `ci:*` scripts in `package.json` — never copied elsewhere |
| That CI, the push hook, and the gate run the same list | `src/__tests__/ci-audit-wiring.test.ts` |
| Architecture invariants | `.claude/CLAUDE.md` § Architecture invariants, ESLint boundaries |
| Dead code, duplication, complexity (new findings only) | fallow, `.fallowrc.jsonc` |
| Changed-line coverage floor (80%) | `scripts/diff-coverage.ts`, `verify-gate.sh --review` |
| Assertion quality on high-risk work | the `red-team` skill (hand-mutation) |
| The bar not being lowered | `pnpm ci:weakened-checks` + this skill |

## Guard the bar — five moves to look for in the diff

1. **The threshold moved.** A floor lowered, a severity dropped, a check taken
   out of a stage.
2. **A test got easier.** `.skip` or `.todo` added, a test file deleted,
   assertions pulled out of a test that stayed.
3. **A checker got silenced.** A new `eslint-disable`, `@ts-expect-error`,
   `@ts-ignore`, `fallow-ignore`, `outbox-seam-ignore`, or a coverage-ignore
   comment. The last kind deserves most suspicion: it removes code from the
   measurement instead of testing it.
4. **Work is unfinished.** A stub that throws, an empty `catch`, a `TODO`
   where the implementation should be.
5. **An exception appeared.** A new allowlist entry nobody discussed.

`pnpm ci:weakened-checks` finds these mechanically. It FAILS the ones that are
never legitimate (a focused test, a disabled test, a lowered coverage floor)
and PRINTS the rest as REVIEW rows.

**A REVIEW row is a question, not a verdict.** An assertion moves into a shared
helper; three unit tests become one stronger integration test; an allowlist
entry is correct. For each row, answer: was protection lost, and if not, where
does it live now? Cite the file. "Assertions decreased, therefore reject" is
the wrong rule — it is answered with meaningless assertions.

**Tightening is silent; loosening is loud.** A change that loosens the bar
says so in the PR description and in the review record
(`working-rules.md` § No unacknowledged debt). A quality-config change in the
same commit as the feature that was failing is the strongest red flag there is.

## How circular is a check?

Ask: can the agent make this pass by writing code that does not work?

- **External** — a vulnerability database, a real browser, WCAG rules. The
  agent cannot argue with these.
- **Project** — lint rules, layer boundaries, the `ci:*` audits. A human owns
  the file.
- **Suite** — the project's own tests. Most useful, and the only genuinely
  circular kind: tests written by the model that wrote the code can encode the
  same mistake. This is why review asks "can these tests pass while the
  promised behavior is wrong?", and why high-risk work gets mutation.

## Changing the bar

- **Add a check only for a missing detection or a repeated failure**, not
  because a tool was recommended. Prefer the de facto tool over a hand-rolled
  checker when one exists.
- **Cost decides placement.** Seconds → the edit loop and the fast gate. Under
  ~90 s → the full gate and the push hook. Slower → CI only. A check that
  stalls the loop gets bypassed with `--no-verify`, and a bypassed gate is
  worse than none because the bar still looks like it exists.
- **Scope to the diff.** Coverage of changed lines is a number this change can
  move; project coverage is one it inherited. Same for mutation and fallow
  (`--gate new-only`).
- **No number? Ratchet.** Record today's value and refuse to get worse. A
  target the codebase fails today produces a red build people learn to ignore.
- **Every threshold carries its reason** beside it. A number with no rationale
  is deleted by the next person who hits it.
- **Every exception has a reason on the line** (`-- outbox-seam-ignore: <why>`,
  `// weakened-check-ok: <why>`). An exception with no reason is a finding.
- A new `ci:*` script ships wired into `ci.yml`'s lint job and `lefthook.yml`
  in the same PR; the wiring test fails otherwise.

## Red flags

- The agent proposed relaxing a threshold instead of fixing the code.
- Quality configuration changed in the commit that needed it to change.
- A REVIEW row answered with "fine" and no file cited.
- Every new check is judged by the project's own tests.
- A slow check landed in the edit loop.
- A second copy of the audit list appeared anywhere.

Adapted for RepWorth from `constraint-driven-development` in
addyosmani/agent-skills @ `c004a74` (MIT). Notice:
`docs/agents/third-party-skills.md`.
