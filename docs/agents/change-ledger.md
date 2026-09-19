# Change ledger

One row per shipped change, added at the ship step of `/feature`,
`/feature-small`, and `$feature`. It exists to answer one question with
evidence: is the workflow getting faster without getting worse? Started
2026-09-18 after the workflow research
(`docs/research/2026-09-17-agentic-coding-workflow-research.md`).

Review it after 10 rows. Ten rows give a direction, not a ranking: use the
median and the worst case, never an average. Change the workflow again only
when the rows show a need. A saving that came from a skipped check, hidden
manual repair, or a defect found later is not a saving — that is what the last
column is for.

| Column | Meaning |
|---|---|
| Date | Merge date |
| PR | Number |
| Lane | `trivial`, `small`, `standard`, `high` |
| Risk | `normal` or `high` |
| Lead | Harness and model tier that owned the change, e.g. `claude/sonnet`, `codex/gpt-5.6-sol` (tiers: `execution-lanes.md` § Model routing) |
| Minutes | Intake posted → PR ready, wall clock, rounded to 5 |
| Repairs | Gate-fail rounds plus review fix rounds |
| Named debt | Compromises named in the review record, or `none` |
| Found later | Defect or security issue traced to this change after merge; fill in at 7 and 30 days, `none` when clean |

| Date | PR | Lane | Risk | Lead | Minutes | Repairs | Named debt | Found later |
|---|---|---|---|---|---|---|---|---|
