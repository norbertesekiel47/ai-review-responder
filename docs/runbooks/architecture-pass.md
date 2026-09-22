# Runbook — an architecture pass

**When to use:** the owner asks for one. Nothing schedules a pass and nothing
reminds anyone to run one — the merge counter that used to was deleted on
2026-09-22 (#1383, #1409) after eight consecutive wrong counts. Never start a
pass automatically.

**What a pass is:** a review of what the merges since the last pass did to the
architecture, which ends in filed issues. The record lives in
`.claude/reference/arch-review-log.md`: pass entries are dated paragraphs at the
top (newest first), per-merge rows are in the table at the bottom.

## The five steps

1. **Window.** Find the newest `**Architecture pass**` entry in the log; its
   window is written `windowed <base>..<end>`. The new window is
   `<end>..origin/main` (`git fetch origin main` first). Read the bottom-table
   rows and `git log --first-parent <end>..origin/main` for that range.
2. **Agenda.** Collect every `**Next pass:**` line written since the last
   pass — in pass entries and in merge rows. Each item gets a verdict: ACT,
   SCHEDULE, or CLOSE AS ANSWERED, with the file and line that decides it.
3. **Output is issues, not prose.** Every ACT or SCHEDULE verdict becomes a
   GitHub issue (`gh issue create`) in the pass itself. A finding without an
   issue number is not written down (`.claude/CLAUDE.md` § Working rules). Do
   not create a `docs/reviews/PATHFINDER-<date>/` findings document: the
   2026-08-18 pass filed seven issues and all seven closed; the four passes
   after it filed none and none of their top-ranked items landed.
4. **Record the window.** Add a dated entry at the top of the log:
   `<date> — **Architecture pass** (windowed <end>..<new-end>; N commits)`,
   the verdict per agenda item with its issue number, and a new
   `**Next pass:**` line.
5. **Score the previous pass.** For each issue the previous pass filed, run
   `gh issue view <n> --json state` and state the result in the new entry as
   `closed X of Y`, listing any still open. That count is the only measure
   that has told a pass that worked from one that did not.
