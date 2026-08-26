---
name: preflight
description: Run every local gate before pushing a branch, in the one order that avoids rework — rebase, re-derive the migration number, leave the merge-ledger line, run the pre-push audit subset, run the real fallow coverage gate, then re-verify against current HEAD and print a three-line summary. Use before `git push`, when a push was rejected by the pre-push hook, when asked to "get this ready to push", or before opening or readying a PR.
---

# preflight — the pre-push ritual, in order

Five gates block this repo's pushes: the lefthook pre-push subset, the
merge-ledger audit, the migration counter, the `fallow` coverage gate, and
(during a `/feature` run) the Stop gate on gate-status freshness. Each one
alone is cheap. What costs time is running them in the wrong order, because
every result is evidence about a specific tree — and a rebase replaces the
tree.

So: **rebase first, derive numbers second, run gates last.**

**STOP at the first failure.** Report the exact failing command and its
deciding output lines. Do not continue to the next step, and do not report a
later step as passed.

---

### Step 1 — Rebase onto current main

```bash
git fetch origin && git rebase origin/main
```

Everything after this step is evidence about the tree that will actually land.
A gate run before the rebase describes a tree that no longer exists.

On conflict: resolve, stage **by explicit path** (`git add path/to/file`), then
`git rebase --continue`. Never use the hard reset or the whole-tree add — a
PreToolUse guard blocks both, and an uncommitted file belonging to an earlier
session is exactly what that class of command destroys.

Report: how many commits replayed, and whether anything conflicted.

### Step 2 — Re-derive the migration number

Skip this step when `git diff --name-only origin/main...HEAD -- supabase/migrations/`
is empty. Say that you skipped it and why.

1. Read the head line in `.claude/reference/migrations-log.md`:
   `Current head: **NNN** — next migration is **NNN+1**`.
2. Your migration file must be `head+1`, zero-padded to three digits.
3. If main took your number while you worked, **rename your file** to the new
   `head+1` and bump the head line. Do not settle the conflict by keeping
   whichever number git happened to leave in the file. Three consecutive
   sessions lost a cycle to that.
4. `migration-immutability-guard.sh` reads that head line, so a stale head
   silently un-protects the newest applied migration.

Report: old number → new number, or "no migration in this diff".

### Step 3 — Leave the merge-ledger line

`pnpm ci:merge-ledger` requires one added line in
`.claude/reference/arch-review-log.md` when either trigger fires:

- **production** — the diff changes a non-test file under `src/`, `worker/`
  or `supabase/`;
- **governance** — the diff touches skills, hooks, `scripts/ci/`, the
  workflows, `lefthook.yml`, or `package.json`.

The audit runs on the **merging PR, not on a post-merge sweep** — "the sweep
did not run" is the exact failure it exists to catch, so there is no later
chance to add the line.

Append a row to the table at the end of the file:
`| <date> | <trigger> | <scope reviewed> | <outcome> |`. No shape is enforced
beyond leaving a trace, so write what a reader would need.

The audit never reads or writes the **entropy counter** at the top of that
file. That number is a judgement about which merges count; bump it by hand
during an architecture pass only.

Verify: `pnpm ci:merge-ledger`

### Step 4 — Run the pre-push audit subset

This is what `lefthook.yml` runs on push, so running it here turns a push
rejection into a local failure:

```bash
pnpm lint && pnpm typecheck && pnpm test:changed && pnpm vitest run src/__tests__
```

Then every `ci:*` audit except the fallow pair. Derive the list from
package.json rather than keeping a second copy of it:

```bash
for s in $(jq -r '.scripts|keys[]|select(startswith("ci:"))|select(startswith("ci:fallow")|not)' package.json); do
  echo "== $s"; pnpm "$s" || { echo "FAILED: $s"; break; }
done
```

`pnpm vitest run src/__tests__` runs unconditionally on purpose: the guard
tests read files instead of importing them, so they sit in no import graph and
`vitest --changed` silently skips them. A config-only change can break a guard
and still push green without this row.

### Step 5 — Run the real fallow gate

A bare `fallow audit` does **not** predict the PR gate in either direction —
it estimates CRAP from export references, and has been green locally while CI
reported CRAP 420. The gate is fed by coverage:

```bash
pnpm test:coverage && pnpm ci:fallow:coverage
```

Export `TEST_DATABASE_POOL_URL` **and** `DATABASE_POOL_URL` first. Without
them the live-DB suites skip silently, and the coverage input is then not the
one CI will use.

### Step 6 — Re-verify against HEAD, then summarize

1. `git rev-parse HEAD` — record the SHA.
2. If HEAD moved at any point after step 1, every result above is **void**.
   Return to step 1. Do not reuse the earlier output.
3. If any subagent work was dispatched, it must have returned **before** step 4
   started. Evidence gathered beside a moving HEAD is stale evidence, and that
   is the single most common reason a finished branch stalls at the Stop gate.
4. Print exactly three lines, then the detail below them:

```
Changed:   <one line — what this branch does>
Verified:  <the commands that passed, and the SHA they ran at>
Blocking:  <what still fails, or "nothing">
```

Then push: `git push -u origin <branch>`. For genuine work in progress,
`git push --no-verify` skips the local hook; CI still enforces everything.

---

## What preflight does not do

- It does not open the PR, and it does not merge.
- It does not run the full `pnpm test` suite — CI is that gate. Step 4 runs
  the changed set plus the guard suite.
- It does not apply migrations to any database.
- Draft PRs run **no CI**, so until `gh pr ready` this ritual is the only
  signal that exists. Treat a skipped step as an unknown, not as a pass.
