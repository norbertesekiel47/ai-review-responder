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
| 2026-09-19 | 1322 | small | normal | claude/opus | 25 | 1 | Title-guard residual: the removed assertion was file-wide, its replacement is title-scoped, so a stray brand suffix outside a title is now unguarded. Pre-existing rename class in `reclassify_bucket` (a leading `{` defeats the prefix match) left as found. | pending — check 2026-09-26 and 2026-10-19 |
| 2026-09-19 | 1325 | small | normal | claude/opus | 45 | 2 | THREE wrapped handlers annotate themselves `: Promise<Response>`, which pins `TRes` and opts them out of the fix — documented in the wrapper, not fixed (editing them is a call-site change the intake forbade); filed as #1327. The ledger first said ten, from a grep that counted seven unwrapped route exports. `responseBearing` closes the type-PARAMETER case only, not intersections or unresolved conditionals (pre-existing). The two return-type guards are invisible to `pnpm test` — `pnpm typecheck` is their only gate. | not yet due |
| 2026-09-19 | 1330 | trivial | normal | claude/opus | 20 | 2 | `ScopeOutcome` is the fourth copy of the `{ok}|{response}` guard shape (`EditReplyGuard`, `RoleAuthResult`, `OwnerAccountResult` are the others); one shared `Guard<T>` would make the guard-type opt-out unrepeatable, and this branch patched one copy. Nothing mechanical stops a NEW wrapped handler from self-annotating — the type guard pins three named routes, a fourth would be caught by nothing across the 71 wrapping files. | none |
| 2026-09-19 | 1335 | small | normal | claude/opus | 35 | 2 | The guard predicate stays suffix-only by owner decision, so a brand PREFIX on a future page is caught by nothing — stated in the docstring and cited to #1102, not fixed. `regionTitles` scans the raw metadata region including comments, so a comment spelling `title: '… · RepWorth'` inside a metadata object would read as an offender (pre-existing; this change's own comment escapes it only because it writes `title.template`). `docs/reviews/fix-1078-title-suffix-and-demo-retry/review.md` still quotes the old landing copy, left as the historical record. | pending — check 2026-09-26 and 2026-10-19 |
| 2026-09-19 | 1337 | small | high | claude/opus | 210 | 6 | The candidate window is not generally starvation-free: these arms exclude ACCOUNT-level refusals only, so a mid-drip `auto_policy` batch held by a failed auto condition keeps its slot until P2 terminalizes it at 72h (pre-existing, `release.ts:1854`, named in the scan docstring and filed separately). `release.ts` is 2121 lines and `selectReleaseCandidates` its most complex function; the extraction to `release-candidates.ts` is justified and deferred because the tenant-scope allowlist is FILE-keyed, so it would re-key all seven release entries in the same PR that `refactor/616` is already touching. B6's gate precedence is encoded twice — the scan's `FILTER (… AND NOT account_capped)` and the per-account gate order — covered by the overlapping-refusal case. One red-team P2 open by choice: the duplicate-row `throw` guards a state migration 074's unique index makes impossible and has no dedicated alert rule. The local `pnpm test` row shipped RED on one unrelated pre-existing case (#1334, CI-green); CI was the authority for that row. | pending — check 2026-09-26 and 2026-10-19 |
| 2026-09-19 | 1340 | small | high | claude/opus | 415 | 4 | The `reviewed` transition shipped WAIVED, by owner decision recorded as deviation D11 — not a code compromise but a workflow one, and the first on this ledger. Two red-team findings (RT-010 P0, RT-011 P1) are `accepted-risk`: both are fixed in `cceef6ff` and hand-verified, but neither has journaled proof, because the round that RAISED them was the last one the runner allows. The two structural causes are filed — #1342 (the round cap collides with `RUN_C_FOURTH_TEXT`, so a round-3 finding's own fix can never be verified) and #1343 (an `oracle`-class inconclusive row makes `CLEAR` unreachable, so a type-only annotation blocks step 7.5). Carried debt from the branch itself: D7 keeps a one-caller `leavesNoWorkToDo` predicate against project preference, to hold cyclomatic at 8 so the fallow check passes with no coverage file present; D9 records that `finalizeOnboardingDemoSpend` duplicates `reservation.ts`'s shape and was rejected for this branch. The local `pnpm test` row shipped RED on the same unrelated pre-existing case as #1337 (#1334, CI-green); CI was the authority for that row. | pending — check 2026-09-26 and 2026-10-19 |
| 2026-09-19 | 1341 | small | normal | claude/opus | 65 | 3 | The Codex guard gained `WORKTREE_EDIT_GUARD_DISABLE`, which it never honoured — on the legacy `…-worktrees/` path its containment was previously unbypassable and now is not. Taken deliberately so its refusal message stops naming a variable it ignores; `ci:weakened-checks` cannot see a shell escape hatch, so it is recorded here and in the arch log. `is_linked_worktree` adds two git invocations per Edit/Write before the cheap emptiness test — latency only, not measured. | pending — check 2026-09-26 and 2026-10-19 |
