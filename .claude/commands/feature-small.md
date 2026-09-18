---
description: The trivial and small lanes of /feature on one page — six-field intake, build in this session, the pre-push gate, one review pass, PR
argument-hint: <change description>
---

# Small Feature

Change request: $ARGUMENTS

This is the `trivial` and `small` lane of `/feature`, sized so the whole
pipeline fits one session and one page. Most day-to-day work is this size.
The rule that matters: **a small pipeline followed completely beats a large
one followed halfway.** If any step below does not fit, stop and run
`/feature` instead — never improvise a middle path.

Shared rules still bind. Read `.agents/skills/feature/references/working-rules.md`
§ Context discipline and § Anti-slop before the first edit. Nothing else from
the reference set is needed on this lane.

## 0. Confirm the lane (one line)

State size, risk, and the files you expect to touch. This lane runs only when
ALL of these hold; otherwise say which failed and hand off to `/feature`:

- size is `trivial` (about 30 changed lines) or `small` (about 150 lines,
  a few files, one seam) per `execution-lanes.md` § Classification;
- risk is `normal` — nothing under `worker/`, no webhook ingress, no
  migration or schema change, no billing or Stripe, no approval or
  auto-approval path, no auth;
- no new dependency, no new env var or feature flag.

Open the ladder so the run is measured like every other:

```bash
node .agents/skills/feature/scripts/progress.mjs init --size <trivial|small> --risk normal --surface <ui|backend|mixed>
```

## 1. Intake (six fields, posted once)

Ask only what the code and docs cannot answer. Post the intake in ONE
message and proceed; the owner vetoes asynchronously.

```
goal:                  one sentence
non_goals:             what this change does NOT do
allowed_edit_surface:  the files or directories, listed
tests_to_add:          test titles, verbatim, or "none — <reason>"
estimated_prod_lines:  N
estimated_test_lines:  N
```

For `trivial`, the intake is the one-line classification plus
`allowed_edit_surface`; skip the rest.

```bash
node .agents/skills/feature/scripts/progress.mjs step intake done --note "posted"
```

## 2. Branch here (no worktree by default)

`git status --porcelain` first; report what is dirty and leave it alone.
Then `git checkout -b <branch>` from current `main`.

Use `pnpm worktree:new <branch>` ONLY when another feature is in flight in
this checkout, the checkout is dirty in files you must touch, or you start
from a long-lived branch. A worktree is isolation, not ceremony.

```bash
node .agents/skills/feature/scripts/progress.mjs step armed skipped --note "small lane, no worktree"
node .agents/skills/feature/scripts/progress.mjs step plan skipped --note "small lane"
```

## 3. Build in this session

No subagents, no plan document. Write the `tests_to_add` first as failing
tests when behavior is specifiable up front, then make them green: watch each
test FAIL for the right reason (missing behavior, not a typo or an error)
before writing code, write only the code that passes it, and refactor only
while green. Test real behavior, not a mock's calls. Stay
inside `allowed_edit_surface`; a change that needs a file outside it is the
signal to stop and re-run step 0.

```bash
node .agents/skills/feature/scripts/progress.mjs step execute done
```

## 4. Gate — the pre-push hook itself, then the full suite

```bash
pnpm exec lefthook run pre-push --no-tty && pnpm test && pnpm build
```

The first command RUNS `lefthook.yml` — lint, typecheck, every `ci:*` audit,
the guard tests — so this gate cannot list a different set from the hook and a
green gate here cannot fail at push time. Never re-spell that list on this
page. `pnpm test` is the full run the hook leaves to CI. Drop `pnpm build` only
when every changed path is `docs/`, `.claude/`, or `*.md`. Read back only
failing names and the log tail — never the whole log. The same failure class
twice means stop patching and diagnose.

```bash
node .agents/skills/feature/scripts/progress.mjs step gate done
```

## 5. One review pass

Invoke `/code-review` on the branch: spec and correctness only. Triage the
findings as claims to verify, not orders:

- Read them all first. If any is unclear, clarify it before fixing any.
- Check each against the code: correct for THIS codebase, safe to change,
  no reason for the current code that the reviewer missed. A "build it
  properly" suggestion gets a grep for real callers first — none means
  propose removal.
- Reject with technical reasoning and `file:line` evidence; if you cannot
  verify a finding, say what you would need.
- Fix the real ones one at a time — blocking, then simple, then complex —
  testing each. No performative agreement: state the fix or the reason.

Re-run step 4 after any fix.

```bash
node .agents/skills/feature/scripts/progress.mjs step review done
```

## 6. Ship

```bash
git push -u origin <branch>            # lefthook runs the pre-push subset
gh pr create --draft                   # draft PRs run no CI
gh pr ready                            # CI is the full gate
```

Confirm every check green, merge, then `git pull --ff-only` on `main`.

```bash
node .agents/skills/feature/scripts/progress.mjs step ready done
node .agents/skills/feature/scripts/phase-cost.mjs
rm -rf .feature
```

Read the cost table before deleting it. If a step cost more than the
whole change was worth, say so in one line — that is the measurement the
lane exists to produce. If the change taught a durable lesson, promote it
to the lab notes (`.claude/reference/lab-notes/README.md` § "How to add a lab
note": a dated entry in the newest `lab-notes/history/*.md`, plus the topic
page when a current rule changes), the area's `.claude/rules/<area>.md`, or
the CLAUDE.md gotchas in the same sitting; there is no deviations file on
this lane to carry it.
