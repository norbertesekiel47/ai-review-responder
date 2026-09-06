---
name: document-feature
description: Post-feature documentation sweep — updates currents.md, progresstracking.md, the .claude/reference inventories, and CLAUDE.md from the branch diff. Use after finishing or merging a feature, when the user says "document this feature" / "update the docs for what we did", or types /document-feature.
---

# Document Feature

Run after a feature is implemented (or merged) to bring the project's documentation
back in sync. This is the repeatable post-feature ritual — follow it exactly so
every feature is recorded the same way and nothing drifts.

## Source of truth — do NOT document from memory

Establish what changed from the **diff**, not from conversation context (the chat
may be compacted or this may be a fresh session):

```bash
git diff --stat main...HEAD      # the changed-file list — your work-list
git log --oneline main..HEAD     # the narrative
```

Also read the plan/spec doc if one exists (`docs/superpowers/plans/*`,
`docs/superpowers/specs/*`). If `main...HEAD` is empty (already merged), diff against
the merge commit or the previous tag. **List the changed files first**, then write
each doc from that list.

## What to update — and exactly where

Process the files in this order. Each has a **trigger**: if the trigger is false,
skip the file and say so in the final table — do not invent content.

| File | Trigger (skip if false) | Where it goes |
|---|---|---|
| [docs/currents.md](../../../docs/currents.md) | Always (every feature changes current state) | **Prepend a new `## Quick summary — <feature> (date, PR#)` at the TOP**, just under the `Last updated:` line. Plain English + a "the new shape" file map. **Bump the `Last updated:` line.** Live file capped at **12,000 words**: when it goes over, move the OLDEST `## ` sections **verbatim, in order** to a new `docs/progress-archive/currents-history-<range>.md` (header convention: `# currents.md — archived history <range>`, one pointer line back to the live file, blank line, then the sections) and add that file to the live header's archive list. Never trim or summarise an entry. |
| [docs/progresstracking.md](../../../docs/progresstracking.md) | Always | **Append** a detailed entry at the **BOTTOM** under the current sprint/era heading. Versions, file lists, decisions, gotchas. This is the human changelog. Same **12,000-word** cap and archive rule as currents.md: oldest sections verbatim to a new `docs/progress-archive/progresstracking-<range>.md` (header `# progresstracking.md — archived history <range>`, one pointer line back, blank line, sections), added to the header's archive list. `docs/progress-archive/*.md` is frozen history — never edit or summarise it. |
| [.claude/reference/env-vars.md](../../../.claude/reference/env-vars.md) | An env var or feature flag was added/changed | Add/update the var's row + its semantics |
| [.claude/reference/migrations-log.md](../../../.claude/reference/migrations-log.md) | A migration was added | New migration entry + bump the "current head / next number" |
| [.claude/reference/review-ingestion.md](../../../.claude/reference/review-ingestion.md) | A ReviewSource or the ingest path changed | Update the relevant section |
| [.claude/reference/lab-notes/README.md](../../../.claude/reference/lab-notes/README.md) | A non-obvious root cause / named-subsystem gotcha was found | Follow the README's **"How to add a lab note"**: (1) append a dated entry `## YYYY-MM-DD — <title>` with `[DATE] WHAT FAILED → WHY → CORRECT APPROACH` bullets to the **newest** `.claude/reference/lab-notes/history/*.md`; (2) if the finding changes a current rule, ALSO edit the topic page `.claude/reference/lab-notes/<topic>.md` (its Summary bullet or Canonical section — the history entry keeps the story, the topic page keeps the rule); (3) start a new history file past 15,000 words and add its row to the README table. Never write to the redirect stub at the old single-file path — it is historical-citation glue only. |
| `.claude/rules/<area>.md` | A non-obvious trap for ONE area (path-bound, not global) was found | Add it under `## Traps` in the rule whose `paths:` frontmatter covers the files; if none does, add a rule with `paths:` frontmatter naming the globs (`pnpm ci:agent-config` checks every glob matches a tracked file). Rules stay ≤ 800 words; point at a reference page rather than quoting it. A gotcha that applies everywhere goes in CLAUDE.md instead (≤ 60 words). |
| [.claude/CLAUDE.md](../../../.claude/CLAUDE.md) | An architecture invariant, a file location, or a "Where things live" row changed | Edit minimally — invariants list, the routing table, or a global gotcha only. Shape-guarded (`src/__tests__/claude-md-shape.test.ts`): rows ≤ 80 words, gotchas ≤ 60 — the WHY goes to `docs/directory/<page>.md` § folder / the owning `docs/context/<context>.md` / `.claude/reference/lab-notes/<topic>.md`, an area trap to `.claude/rules/<area>.md`, not here |
| [docs/directory.md](../../../docs/directory.md) + `docs/directory/<page>.md` | A production file under `worker/` or `src/lib/` was added, moved, renamed or deleted | Add / move / delete its **row** (first-cell code span under the folder's `###` section) on the **page that inventories its folder** — the index's `## Pages` table maps folders to pages; a new folder gets a Pages-table row too. `pnpm ci:directory-map` must pass — it reads the index plus every `docs/directory/*.md` and fails on a file with no row and on a row with no file. |
| [CONTEXT-MAP.md](../../../CONTEXT-MAP.md) + `docs/context/<context>.md` | A domain term was coined, sharpened, or locked | Add / edit the `- **Term**: …` line in the `docs/context/<context>.md` that owns it AND add the term's name to that context's row in `CONTEXT-MAP.md` (a new context = a new file + a map row). A term defined in two files fails the shape test. The root `CONTEXT.md` is a redirect stub — never add to it. |
| [.claude/reference/arch-review-log.md](../../../.claude/reference/arch-review-log.md) | **Always, on a MERGED feature** (skip only if this sweep is running pre-merge) | **Increment the "Merges since last architecture pass: N" counter**, then add a `- **PR #<n>** — <feature> (<date>, squash \`<sha>\`)` entry at the TOP of the list. Say what it did to the *architecture*: migrations, env vars, flags, dependencies, new single owners, deleted concepts, allowlist baselines moved — and name what the next pass should look at. At **≥ 5**, tell the user a pass is due (their call — never start one automatically). |

### currents.md vs progresstracking.md — the boundary

They are NOT the same doc. Keep them in their lanes:

- **currents.md = state.** "What is true now." Newest at top, plain English, reader-friendly. Capped — see its archive pointer.
- **progresstracking.md = history.** "What we did, when." Newest at bottom, exhaustive detail. Human changelog; agents read currents.md + `.claude/reference/` instead.

### Size caps — every page above is guarded

`src/__tests__/reference-shape.test.ts` enforces the caps (lab-notes topic pages 3,000 words, history files 15,000, `docs/directory/*.md` and `docs/context/*.md` 3,000, `CONTEXT-MAP.md` 1,500, currents.md and progresstracking.md 12,000, `.claude/rules/*.md` 800) and the structure (a rule starts with `paths:` frontmatter, no term in two context files, the map links every context, the Pages table links every directory page, the lab-notes README links every topic page and history file). When a page goes over: split it, archive its oldest sections, or move the WHY to the page the pointer already names — never delete or summarise. Full layout: [docs/agents/context-layout.md](../../../docs/agents/context-layout.md).

## Cross-reference hygiene (project rule — repworth.md)

After editing, grep the feature name and every **new filename** you documented and
fix stale ticks / dangling refs in the same pass:

```bash
rg -l "<feature-name>|<new-file-basename>" docs/ .claude/
```

If you marked a checklist item done or deleted a doc, fix its audit tick too.

## Finish with a verification table

End your run with this table so the user has a review surface:

| File | Changed? | Why / why skipped |
|---|---|---|
| currents.md | ✅ | added trial summary + bumped Last updated |
| migrations-log.md | ⛔ | no migration in this diff |
| arch-review-log.md | ✅ | counter 3 → 4, entry for PR #NNN |
| … | | |

Do **not** claim a file was updated unless you actually edited it.

### Why `arch-review-log.md` is in that table

Because it kept being forgotten when it wasn't. The counter is the only thing
tracking architectural entropy between passes, and a missed increment is
invisible — nothing fails, the number is just quietly wrong, and the pass that
should have been triggered isn't.

It was missed on **#712, #716 and #746**, each time by a session that ran this
sweep and had no reason to think of it. Two architecture passes then prescribed
"add a mandatory row to `document-feature`'s table" as the fix, and both times
the fix itself was never applied — so the class survived two attempts to kill it
and claimed a fourth feature (**#821**, incremented by hand from a handoff
checklist rather than by this skill).

That is the whole argument for the row: an instruction that lives only in a
runbook depends on someone remembering to read the runbook. Keep it in the table.
